/**
 * Shared diary-day mutation helper for MCP write tools.
 *
 * Every write tool eventually appends/merges into a diary row's items,
 * water, or body_stats JSON columns. Centralising the load/mutate/save
 * loop here keeps the tools tight and ensures every write:
 *  - runs inside a single transaction (safe against concurrent writes),
 *  - respects the (user_id, date) unique-key upsert pattern the rest of
 *    the server uses (nutrition-import, data.js, full-backup),
 *  - REFUSES to overwrite a tombstoned row (throws DiaryTombstonedError
 *    so the calling tool returns a clean isError instead of silently
 *    resurrecting an erased day and wiping its prior contents),
 *  - stamps `updated_at` so differential sync picks up the change.
 *
 * The mutator callback receives the parsed { items, water, bodyStats,
 * notes } shape and returns the same (mutated in-place or replaced).
 * The mutator must always return a value; returning null is not
 * supported.
 */
import db from '../../db.js';
import { safeJson } from './_util.js';

/**
 * Sentinel error thrown when the target day is tombstoned. The tools
 * catch this and translate it into a clean tool `isError` result so
 * the agent gets an actionable message instead of a JSON-RPC crash.
 */
export class DiaryTombstonedError extends Error {
  constructor(date) {
    super(`Diary day ${date} was erased in the app. Restore it in the app before logging into it.`);
    this.name = 'DiaryTombstonedError';
    this.code = 'diary_tombstoned';
  }
}

/**
 * Load a diary day, hand its parsed contents to `mutator`, and save
 * the result back. Runs inside a transaction so concurrent MCP write
 * calls on the same day serialise cleanly.
 *
 * Behaviour on a tombstoned row: throws `DiaryTombstonedError`. The
 * SELECT-then-UPSERT pattern otherwise silently resurrects the row
 * AND wipes the erased contents, because ON CONFLICT DO UPDATE takes
 * `excluded.*` (the new empty base). We refuse rather than surprise.
 * If the caller genuinely wants to overwrite, they should undelete the
 * day in the app first.
 *
 * @param {number}   userId
 * @param {string}   date       YYYY-MM-DD (server-local)
 * @param {function} mutator    ({items, water, bodyStats, notes}) => same shape
 * @returns {object} the final shape actually written
 */
export function mutateDiaryDay(userId, date, mutator) {
  const tx = db.transaction(() => {
    // Look up any row (tombstoned or not) so we can distinguish
    // "row doesn't exist yet" from "row exists but was erased".
    const raw = db.prepare(
      `SELECT items, water, body_stats, notes, deleted_at
         FROM diary
        WHERE user_id = ? AND date = ?`
    ).get(userId, date);

    if (raw && raw.deleted_at) throw new DiaryTombstonedError(date);

    const current = {
      items:     raw?.items      ? safeJson(raw.items,      []) : [],
      water:     raw?.water      ? safeJson(raw.water,      []) : [],
      bodyStats: raw?.body_stats ? safeJson(raw.body_stats, {}) : {},
      notes:     raw?.notes ?? null,
    };
    const next = mutator(current);

    const itemsJson     = JSON.stringify(next.items ?? []);
    const waterJson     = JSON.stringify(next.water ?? []);
    const bodyStatsJson = JSON.stringify(next.bodyStats ?? {});
    const notes         = next.notes ?? null;

    db.prepare(
      `INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(date, user_id) DO UPDATE SET
         items=excluded.items,
         body_stats=excluded.body_stats,
         water=excluded.water,
         notes=excluded.notes,
         updated_at=excluded.updated_at`
    ).run(userId, date, itemsJson, bodyStatsJson, waterJson, notes);

    return next;
  });
  return tx();
}
