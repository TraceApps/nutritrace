import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { freshenItemImages } from '../lib/diary-helpers.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

// Get all diary dates (for statistics)
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const rows = u == null
    ? db.prepare('SELECT * FROM diary WHERE deleted_at IS NULL ORDER BY date ASC').all()
    : db.prepare('SELECT * FROM diary WHERE user_id = ? AND deleted_at IS NULL ORDER BY date ASC').all(u);
  res.json(rows.map(parse));
}));

// Get single date
router.get('/:date', wrap((req, res) => {
  const u = uid(req);
  const row = u == null
    ? db.prepare('SELECT * FROM diary WHERE date = ? AND deleted_at IS NULL').get(req.params.date)
    : db.prepare('SELECT * FROM diary WHERE date = ? AND user_id = ? AND deleted_at IS NULL').get(req.params.date, u);
  if (!row) return res.json({ date: req.params.date, items: [], body_stats: {}, water: [], notes: '' });
  res.json(parse(row));
}));

// Save/replace entire diary entry for a date
router.put('/:date', wrap((req, res) => {
  const { items, body_stats, water, notes } = req.body;
  const notesVal = (typeof notes === 'string' && notes.trim()) ? notes : null;
  const u = uid(req);
  const itemsJson = JSON.stringify(items || []);
  const bsJson = JSON.stringify(body_stats || {});
  const waterJson = JSON.stringify(water || []);
  if (u == null) {
    // Single-user mode: SQLite UNIQUE(date, user_id) treats NULL user_id as
    // distinct per row, so the standard UPSERT never collides — each PUT
    // would insert a new row and GET would return the oldest (issue #37,
    // "only the first food item added each day saves"). Manual upsert:
    const existing = db.prepare(`SELECT id FROM diary WHERE date = ? AND user_id IS NULL`).get(req.params.date);
    if (existing) {
      db.prepare(`UPDATE diary SET items=?, body_stats=?, water=?, notes=?, updated_at=datetime('now'), deleted_at=NULL WHERE id=?`)
        .run(itemsJson, bsJson, waterJson, notesVal, existing.id);
    } else {
      db.prepare(`INSERT INTO diary (date, items, body_stats, water, notes, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`)
        .run(req.params.date, itemsJson, bsJson, waterJson, notesVal);
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
    ).run(u, req.params.date, itemsJson, bsJson, waterJson, notesVal);
  }
  const row = u == null
    ? db.prepare('SELECT * FROM diary WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL').get(req.params.date)
    : db.prepare('SELECT * FROM diary WHERE date = ? AND user_id = ? AND deleted_at IS NULL').get(req.params.date, u);
  res.json(parse(row));
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
    items:      freshenItemImages(fixCachedPaths(items)),
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
