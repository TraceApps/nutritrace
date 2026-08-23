/**
 * MCP tool: get_recent_foods
 *
 * Return the user's most-recently-used foods from their local catalog,
 * ordered by last diary appearance. Useful for agents that want to
 * surface "log the same thing again" suggestions without re-searching.
 *
 * Cheap implementation: walks the last 14 days of diary rows and
 * counts distinct food ids. Not indexed on the server; if that becomes
 * a hot path we can materialize a `foods.last_used_at` column.
 *
 * Filters out tombstoned diary rows so agents don't get "recent" foods
 * seeded from days the user has erased.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { daysAgoLocal, safeJson, toolResult } from '../_util.js';

const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 10;
const LOOKBACK_DAYS = 14;

export function registerRecentFoods(server, { userId }) {
  server.registerTool(
    'get_recent_foods',
    {
      title: 'Get Recent Foods',
      description:
        "Return the user's most-recently-used foods from their local catalog, ordered " +
        `by last diary appearance in the past ${LOOKBACK_DAYS} days. Default limit 10, max ${MAX_LIMIT}.`,
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ limit }) => {
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      const since = daysAgoLocal(LOOKBACK_DAYS);
      const rows = db.prepare(
        `SELECT items, date FROM diary
          WHERE user_id = ? AND date >= ? AND deleted_at IS NULL
          ORDER BY date DESC`
      ).all(userId, since);
      const lastSeen = new Map();
      for (const r of rows) {
        const items = safeJson(r.items, []);
        for (const it of items) {
          // Recipes live in the `meals` table, not `foods` — skip.
          if (!it || it.is_recipe) continue;
          // Android clients store the local autoincrement id in `id`
          // and the real foods.id in `food_server_id`. Server-side
          // hydration prefers the server id when present. Use a positive-
          // number check (not `??`) so a legacy row with food_server_id=0
          // doesn't collide with foods.id=0 or waste a dedup slot.
          const srv = it.food_server_id;
          const id  = (typeof srv === 'number' && srv > 0) ? srv : it.id;
          if (typeof id !== 'number' || id <= 0) continue;
          if (!lastSeen.has(id)) lastSeen.set(id, r.date);
        }
        // No early exit on collected-id count. A user who prunes their
        // catalog aggressively could have most of their recent ids
        // pointing to deleted foods; without scanning further, the
        // returned list would be shorter than `cap` even when older
        // rows in the same window would yield valid results. 14 days
        // of diary items is a few thousand rows at most, cheap enough
        // to walk in full.
      }
      // Fetch food rows for the FULL id superset (cap*3 headroom),
      // then filter deleted, THEN slice — otherwise a user who has
      // pruned their catalog could see fewer than `cap` results just
      // because the pre-slice included deleted rows.
      const allIds = Array.from(lastSeen.keys());
      if (!allIds.length) return toolResult({ count: 0, items: [] });
      // Chunk the IN(...) list at 500 params to stay well below the
      // SQLite bound-parameter limit (default 32,766 on modern builds
      // but as low as 999 on older ones). Heavy meal-preppers can log
      // thousands of distinct foods in a 14-day window.
      const CHUNK = 500;
      const foods = [];
      for (let i = 0; i < allIds.length; i += CHUNK) {
        const slice = allIds.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        foods.push(...db.prepare(
          `SELECT id, name, brand, barcode, portion, unit, nutrition, category
             FROM foods
            WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
        ).all(userId, ...slice));
      }
      const byId = new Map(foods.map(f => [f.id, f]));
      const items = allIds
        .map(id => byId.get(id))
        .filter(Boolean)
        .slice(0, cap)
        .map(f => ({
          id: f.id,
          name: f.name,
          brand: f.brand || null,
          barcode: f.barcode || null,
          portion: Number.isFinite(Number(f.portion)) ? Number(f.portion) : null,
          unit: f.unit || null,
          category: f.category || null,
          nutrition: safeJson(f.nutrition, {}),
          last_logged_on: lastSeen.get(f.id),
        }));
      return toolResult({ count: items.length, items });
    }
  );
}

