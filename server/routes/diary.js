import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { freshenItemImages, hydrateItems } from '../lib/diary-helpers.js';
import { mergeEntries, ensureUuids } from '../lib/diary-merge.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import { getGoalsCore } from '../lib/mcp/tools/goals.js';
import { dailyTotalsCore } from '../lib/mcp/tools/daily-totals.js';
import { checkNutritionGoalCrossing, checkWaterGoalCrossing } from '../lib/goal-webhook.js';
import { Nutrition } from '../../src/lib/nutrition.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

// ── Tombstone helpers ─────────────────────────────────────────────────────
// diary_tombstones records per-uuid deletions for items and water. Clients
// pulling a date get the tombstone list so they can drop entries locally
// even if their local copy still holds them. Server keeps tombstones as
// the authoritative "do not resurrect" marker on future merges.
function _tombstoneWhereClause(u) {
  return u == null ? 'user_id IS NULL' : 'user_id = ?';
}
function _loadTombstones(u, date) {
  const where = _tombstoneWhereClause(u);
  const stmt = db.prepare(`SELECT kind, uuid, deleted_at FROM diary_tombstones WHERE ${where} AND date = ?`);
  return u == null ? stmt.all(date) : stmt.all(u, date);
}
function _loadTombstoneUuids(u, date, kind) {
  const where = _tombstoneWhereClause(u);
  const stmt = db.prepare(`SELECT uuid FROM diary_tombstones WHERE ${where} AND date = ? AND kind = ?`);
  const rows = u == null ? stmt.all(date, kind) : stmt.all(u, date, kind);
  return rows.map(r => r.uuid);
}

// Get all diary dates (for statistics)
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const rows = u == null
    ? db.prepare('SELECT * FROM diary WHERE deleted_at IS NULL ORDER BY date ASC').all()
    : db.prepare('SELECT * FROM diary WHERE user_id = ? AND deleted_at IS NULL ORDER BY date ASC').all(u);
  res.json(rows.map(parse));
}));

// Get single date. Response includes tombstones so pulling clients can
// drop the same items/water entries from their local mirror. Legacy clients
// that don't read tombstones ignore the field.
router.get('/:date', wrap((req, res) => {
  const u = uid(req);
  const row = u == null
    ? db.prepare('SELECT * FROM diary WHERE date = ? AND deleted_at IS NULL').get(req.params.date)
    : db.prepare('SELECT * FROM diary WHERE date = ? AND user_id = ? AND deleted_at IS NULL').get(req.params.date, u);
  const tombstones = _loadTombstones(u, req.params.date);
  if (!row) return res.json({ date: req.params.date, items: [], body_stats: {}, water: [], notes: '', completed_at: null, completed_meals: [], tombstones });
  res.json({ ...parse(row), tombstones });
}));

// Save/replace entire diary entry for a date
// Scrub inline base64 data URLs from diary items before storage. Foods
// route accepts data URLs and converts them to /uploads/ via localizeImage,
// but diary items receive a copy of the food via the addDiaryItem spread in
// stores/diary.js. That copy carries whatever imgUrl was on the food at
// pick time — historically a data URL (200-800 KB of base64) when a user
// took a phone photo for a food. The same data URL then gets replicated
// onto every diary item that references that food, and PUT /api/diary
// hits PayloadTooLargeError after just a few logged items. Reported by
// user 2026-06-10.
//
// freshenItemImages in lib/diary-helpers.js always overrides items[].imgUrl
// at read time with the food/meal's current image, so the stored snapshot
// is effectively unused for display. Dropping the data URL on store is
// pure waste-reduction with no behavior change.
function _stripDataUrlImages(items) {
  if (!Array.isArray(items)) return items;
  let changed = false;
  const out = items.map(it => {
    if (it && typeof it.imgUrl === 'string' && it.imgUrl.startsWith('data:')) {
      changed = true;
      return { ...it, imgUrl: '' };
    }
    return it;
  });
  return changed ? out : items;
}

// Merge-based upsert. Prior implementation replaced items/water wholesale,
// which let a stale client (mobile SQLite reset, cache truncated) silently
// wipe the day when it pushed its empty local copy. See
// project_nutritrace_diary_persist_gap for the 2026-07-23 and 2026-08-11
// incidents. New behavior:
//
//   items/water:   per-uuid merge via server/lib/diary-merge. Server state
//                  is preserved by default; entries only leave via explicit
//                  tombstone (client-sent deleted_uuids or existing
//                  diary_tombstones row).
//   body_stats:    still last-writer-wins with the empty-guard (was in
//                  place for issue #81; body_stats is a single object per
//                  day so per-key merge is unnecessary).
//   notes:         last-writer-wins.
//
// The whole write runs inside a single db.transaction so a crash mid-merge
// leaves the row untouched.
router.put('/:date', wrap((req, res) => {
  const { body_stats, water, notes } = req.body;
  const items = _stripDataUrlImages(req.body.items);
  const notesVal = (typeof notes === 'string' && notes.trim()) ? notes : null;
  const u = uid(req);
  const date = req.params.date;

  // Parse deleted_uuids in either shape:
  //   { items: [...], water: [...] }   — new client, per-kind
  //   [...]                            — very-old fallback, treated as items
  //   undefined / null                 — legacy client, no explicit deletes
  const deletedRaw = req.body.deleted_uuids;
  const deletedItemUuids = Array.isArray(deletedRaw?.items) ? deletedRaw.items
    : Array.isArray(deletedRaw) ? deletedRaw
    : [];
  const deletedWaterUuids = Array.isArray(deletedRaw?.water) ? deletedRaw.water : [];

  // Load current server state (may not exist yet — new day).
  const existingRow = u == null
    ? db.prepare('SELECT * FROM diary WHERE date = ? AND user_id IS NULL').get(date)
    : db.prepare('SELECT * FROM diary WHERE date = ? AND user_id = ?').get(date, u);
  const serverItems = existingRow ? JSON.parse(existingRow.items || '[]') : [];
  const serverWater = existingRow ? JSON.parse(existingRow.water || '[]') : [];

  // Load existing tombstones for this user/date. The merge treats those
  // as authoritative "do not resurrect" markers.
  const priorItemTombstones = _loadTombstoneUuids(u, date, 'item');
  const priorWaterTombstones = _loadTombstoneUuids(u, date, 'water');

  // Merge. Any client entry with a uuid we've already tombstoned is
  // dropped; any server entry not mentioned by the client is preserved.
  const { merged: mergedItems, newTombstoneUuids: newItemTombstones } =
    mergeEntries(serverItems, ensureUuids(items || []), deletedItemUuids, priorItemTombstones);
  const { merged: mergedWater, newTombstoneUuids: newWaterTombstones } =
    mergeEntries(serverWater, ensureUuids(water || []), deletedWaterUuids, priorWaterTombstones);

  // body_stats: same empty-guard as before (issue #81).
  const incomingBsEmpty = !body_stats || (typeof body_stats === 'object' && Object.keys(body_stats).length === 0);
  let existingBsHasKeys = false;
  if (existingRow && existingRow.body_stats) {
    try { existingBsHasKeys = Object.keys(JSON.parse(existingRow.body_stats) || {}).length > 0; } catch {}
  }
  const bsJson = (incomingBsEmpty && existingBsHasKeys)
    ? existingRow.body_stats
    : JSON.stringify(body_stats || {});

  const itemsJson = JSON.stringify(mergedItems);
  const waterJson = JSON.stringify(mergedWater);

  const insertTombstone = db.prepare(
    `INSERT OR IGNORE INTO diary_tombstones (user_id, date, kind, uuid, deleted_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  );

  db.transaction(() => {
    if (u == null) {
      // Single-user mode: SQLite UNIQUE(date, user_id) treats NULL user_id
      // as distinct per row, so the standard UPSERT never collides (issue
      // #37, "only the first food item added each day saves"). Manual upsert:
      const existing = db.prepare(`SELECT id FROM diary WHERE date = ? AND user_id IS NULL`).get(date);
      if (existing) {
        db.prepare(`UPDATE diary SET items=?, body_stats=?, water=?, notes=?, updated_at=datetime('now'), deleted_at=NULL WHERE id=?`)
          .run(itemsJson, bsJson, waterJson, notesVal, existing.id);
      } else {
        db.prepare(`INSERT INTO diary (date, items, body_stats, water, notes, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`)
          .run(date, itemsJson, bsJson, waterJson, notesVal);
      }
    } else {
      db.prepare(
        `INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(date, user_id) DO UPDATE SET
           items=excluded.items, body_stats=excluded.body_stats,
           water=excluded.water, notes=excluded.notes,
           updated_at=excluded.updated_at,
           deleted_at=NULL`
      ).run(u, date, itemsJson, bsJson, waterJson, notesVal);
    }
    for (const uuid of newItemTombstones) insertTombstone.run(u, date, 'item', uuid);
    for (const uuid of newWaterTombstones) insertTombstone.run(u, date, 'water', uuid);
  })();

  const row = u == null
    ? db.prepare('SELECT * FROM diary WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL').get(date)
    : db.prepare('SELECT * FROM diary WHERE date = ? AND user_id = ? AND deleted_at IS NULL').get(date, u);

  // Outgoing webhooks. Webhooks require a real account (webhooks.user_id
  // is NOT NULL), so this is naturally a no-op in single-user mode where
  // u is null. Every dispatch is wrapped so a webhook failure can never
  // block or delay the save above, which has already committed.
  if (u != null) {
    try {
      const newItems = mergedItems.filter(it => it.uuid && !serverItems.some(s => s.uuid === it.uuid));
      if (newItems.length) dispatchWebhookEvent(u, 'meal.logged', { date, items: newItems });
    } catch (e) { /* never let a webhook failure block the save */ }

    try {
      const newWaterEntries = mergedWater.filter(w => w.uuid && !serverWater.some(s => s.uuid === w.uuid));
      if (newWaterEntries.length) {
        const water_ml = mergedWater.reduce((s, l) => s + (Number(l.amount) || 0), 0);
        dispatchWebhookEvent(u, 'water.logged', { date, water_ml, added: newWaterEntries });
      }
    } catch (e) { /* never let a webhook failure block the save */ }

    try {
      if (bsJson !== (existingRow?.body_stats ?? null)) {
        dispatchWebhookEvent(u, 'body_stat.logged', { date, stats: JSON.parse(bsJson) });
      }
    } catch (e) { /* never let a webhook failure block the save */ }

    // goal.achieved: per-metric, fires once when a metric crosses from
    // under-target to at-or-above-target THIS save. Pre-save totals come
    // from the items/water this handler already loaded before the merge;
    // post-save totals are read back via dailyTotalsCore so the webhook's
    // notion of "today's totals" matches GET /api/v1/diary/:date/totals
    // exactly. If the existing row was soft-deleted, treat the "before"
    // state as empty rather than the erased day's stale contents, a
    // fresh log into a previously-deleted day should not compare against
    // phantom pre-deletion totals.
    try {
      const { goals, water_goal_ml } = getGoalsCore(u);
      const priorItems = (existingRow && !existingRow.deleted_at) ? serverItems : [];
      const priorWater = (existingRow && !existingRow.deleted_at) ? serverWater : [];
      const beforeTotals = Nutrition.sum(priorItems.map(i => Nutrition.calculate(i)));
      const beforeWaterMl = priorWater.reduce((s, l) => s + (Number(l.amount) || 0), 0);
      const after = dailyTotalsCore(u, { date });

      checkNutritionGoalCrossing(u, date, goals, beforeTotals, after.totals);
      checkWaterGoalCrossing(u, date, water_goal_ml, beforeWaterMl, after.water_ml);
    } catch (e) { /* never let a webhook failure block the save */ }
  }

  res.json({ ...parse(row), tombstones: _loadTombstones(u, date) });
}));

router.delete('/:date', wrap((req, res) => {
  const u = uid(req);
  if (u == null) {
    db.prepare("UPDATE diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE date = ? AND deleted_at IS NULL").run(req.params.date);
  } else {
    db.prepare("UPDATE diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE date = ? AND user_id = ? AND deleted_at IS NULL").run(req.params.date, u);
  }
  res.json({ ok: true });
}));

/**
 * PUT /api/diary/:date/completion
 * Body: { completed: boolean }
 *
 * #207: mark the day as "fully logged" (or clear the mark). Purely a
 * user-facing visual affordance; no diary math depends on completed_at.
 *
 * Creates the diary row if the user marks a day complete without having
 * logged anything (still valid: someone might close an intentionally
 * empty day, e.g. a fast). Idempotent: PUT-true twice is the same as
 * once, and the completed_at stamp is preserved on the first mark so a
 * subsequent PUT-true does not shift the timestamp.
 */
router.put('/:date/completion', wrap((req, res) => {
  const u = uid(req);
  const date = String(req.params.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid date' });
  }
  const completed = req.body?.completed !== false;

  const existing = u == null
    ? db.prepare('SELECT id, completed_at FROM diary WHERE date = ? AND user_id IS NULL').get(date)
    : db.prepare('SELECT id, completed_at FROM diary WHERE date = ? AND user_id = ?').get(date, u);

  if (completed) {
    if (existing) {
      // Preserve first-mark timestamp so a repeat PUT does not overwrite it.
      if (!existing.completed_at) {
        db.prepare("UPDATE diary SET completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
          .run(existing.id);
      }
    } else {
      db.prepare(
        `INSERT INTO diary (user_id, date, completed_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))`
      ).run(u, date);
    }
  } else if (existing) {
    db.prepare("UPDATE diary SET completed_at = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(existing.id);
  }

  const row = u == null
    ? db.prepare('SELECT date, completed_at FROM diary WHERE date = ? AND user_id IS NULL').get(date)
    : db.prepare('SELECT date, completed_at FROM diary WHERE date = ? AND user_id = ?').get(date, u);
  res.json({ ok: true, date, completed_at: row?.completed_at || null });
}));

/**
 * PUT /api/diary/:date/meal-completion
 * Body: { slot: number, completed: boolean }
 *
 * #207 companion: per-meal completion mark. Stored as a JSON array of
 * slot indexes on diary.completed_meals. Adding or removing a slot
 * respects the same "create row if missing" pattern as the day-level
 * endpoint above, so a user can close individual meals on an
 * intentionally empty day. Purely visual, gated on the client behind
 * the diaryShowMealCompletion setting.
 */
router.put('/:date/meal-completion', wrap((req, res) => {
  const u = uid(req);
  const date = String(req.params.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid date' });
  }
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 31) {
    return res.status(400).json({ error: 'slot must be an integer in [0, 31]' });
  }
  const completed = req.body?.completed !== false;

  const existing = u == null
    ? db.prepare('SELECT id, completed_meals FROM diary WHERE date = ? AND user_id IS NULL').get(date)
    : db.prepare('SELECT id, completed_meals FROM diary WHERE date = ? AND user_id = ?').get(date, u);

  const current = _parseSlotArray(existing?.completed_meals);
  const set = new Set(current);
  if (completed) set.add(slot); else set.delete(slot);
  const next = Array.from(set).sort((a, b) => a - b);
  const nextJson = next.length ? JSON.stringify(next) : null;

  if (existing) {
    db.prepare("UPDATE diary SET completed_meals = ?, updated_at = datetime('now') WHERE id = ?")
      .run(nextJson, existing.id);
  } else {
    db.prepare(
      `INSERT INTO diary (user_id, date, completed_meals, updated_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run(u, date, nextJson);
  }

  res.json({ ok: true, date, completed_meals: next });
}));

function _parseSlotArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(n => Number.isInteger(n) && n >= 0 && n <= 31);
  } catch { return []; }
}

// Fix any Capacitor cached paths that leaked into diary items
function fixCachedPaths(items) {
  if (!Array.isArray(items)) return items;
  let changed = false;
  const fixed = items.map(i => {
    if (!i.imgUrl) return i;
    // Fix Capacitor cached paths — only restore to /uploads/ when the basename
    // matches the server's localized image-naming pattern (timestamp-md5.ext,
    // see server/lib/image-localizer.js). Cached externally-proxied images use
    // the source URL basename (e.g. 'front.en.6.400.jpg' from OFF), which does
    // not correspond to any /uploads/ file. Prepending /uploads/ would point
    // every OFF-imported item at the same (or missing) /uploads/<basename>.
    if (i.imgUrl.includes('_capacitor_file_') || i.imgUrl.includes('/image_cache/')) {
      const filename = i.imgUrl.split('/').pop();
      changed = true;
      if (filename && /^\d{10,}-[0-9a-f]{8,16}\.\w+$/i.test(filename)) {
        return { ...i, imgUrl: '/uploads/' + filename };
      }
      return { ...i, imgUrl: '' }; // basename doesn't match server format
    }
    // Fix mangled proxy URLs (e.g., /uploads/proxy)
    if (i.imgUrl === '/uploads/proxy' || i.imgUrl === '/uploads/proxy?url=') {
      changed = true;
      return { ...i, imgUrl: '' };
    }
    return i;
  });
  return changed ? fixed : items;
}

// Fill missing/empty imgUrl values from current foods table state.
// Reasoning: diary items snapshot all fields at log time including imgUrl. If a
// food was logged before it had an image (and got an image later), the snapshot
// stays at '' forever. For cosmetic fields like images this is the wrong default
// (unlike name/macros, where snapshot semantics protect history). Look up by the
// food id captured in the diary item and override empty imgUrl with the food's
// current image. Items that already carry their own non-empty imgUrl are left
// untouched. Single batch query, scales fine for typical diary days.
function parse(row) {
  const items = JSON.parse(row.items || '[]');
  // #207 (per-meal): completed_meals is a JSON string on disk, array on
  // the wire. Parse defensively so a malformed value renders as no
  // marked meals instead of crashing the whole GET.
  let completedMeals = [];
  if (row.completed_meals) {
    try {
      const arr = JSON.parse(row.completed_meals);
      if (Array.isArray(arr)) {
        completedMeals = arr.filter(n => Number.isInteger(n) && n >= 0 && n <= 31);
      }
    } catch { completedMeals = []; }
  }
  return {
    ...row,
    items:            freshenItemImages(hydrateItems(fixCachedPaths(items))),
    body_stats:       JSON.parse(row.body_stats || '{}'),
    water:            JSON.parse(row.water      || '[]'),
    notes:            row.notes || '',
    completed_meals:  completedMeals,
  };
}

// (Boot-time diary cleanup removed deliberately. The imgUrl field is now
// live-resolved at read time by freshenItemImages in lib/diary-helpers.js,
// which builds a fresh lookup against the current foods+meals tables on
// every diary GET. The snapshot value is ignored, so there's nothing for a
// boot-time pass to "fix". See lib/diary-helpers.js for the full reasoning.)

export default router;
