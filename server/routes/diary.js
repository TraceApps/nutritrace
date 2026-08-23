import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { freshenItemImages, hydrateItems } from '../lib/diary-helpers.js';
import { mergeEntries, ensureUuids } from '../lib/diary-merge.js';

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
  if (!row) return res.json({ date: req.params.date, items: [], body_stats: {}, water: [], notes: '', tombstones });
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
  return {
    ...row,
    items:      freshenItemImages(hydrateItems(fixCachedPaths(items))),
    body_stats: JSON.parse(row.body_stats || '{}'),
    water:      JSON.parse(row.water      || '[]'),
    notes:      row.notes || '',
  };
}

// (Boot-time diary cleanup removed deliberately. The imgUrl field is now
// live-resolved at read time by freshenItemImages in lib/diary-helpers.js,
// which builds a fresh lookup against the current foods+meals tables on
// every diary GET. The snapshot value is ignored, so there's nothing for a
// boot-time pass to "fix". See lib/diary-helpers.js for the full reasoning.)

export default router;
