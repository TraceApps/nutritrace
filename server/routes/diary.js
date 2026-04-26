import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

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
  if (u == null) {
    db.prepare(
      `INSERT INTO diary (date, items, body_stats, water, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(date, user_id) DO UPDATE SET
         items=excluded.items, body_stats=excluded.body_stats,
         water=excluded.water, notes=excluded.notes,
         updated_at=excluded.updated_at,
         deleted_at=NULL`
    ).run(req.params.date, JSON.stringify(items || []), JSON.stringify(body_stats || {}), JSON.stringify(water || []), notesVal);
  } else {
    db.prepare(
      `INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(date, user_id) DO UPDATE SET
         items=excluded.items, body_stats=excluded.body_stats,
         water=excluded.water, notes=excluded.notes,
         updated_at=excluded.updated_at,
         deleted_at=NULL`
    ).run(u, req.params.date, JSON.stringify(items || []), JSON.stringify(body_stats || {}), JSON.stringify(water || []), notesVal);
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
    // Fix Capacitor cached paths
    if (i.imgUrl.includes('_capacitor_file_') || i.imgUrl.includes('/image_cache/')) {
      const filename = i.imgUrl.split('/').pop();
      changed = true;
      if (filename && /\.\w{2,5}$/.test(filename)) {
        return { ...i, imgUrl: '/uploads/' + filename };
      }
      return { ...i, imgUrl: '' }; // Can't determine original
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

function parse(row) {
  const items = JSON.parse(row.items || '[]');
  return {
    ...row,
    items:      fixCachedPaths(items),
    body_stats: JSON.parse(row.body_stats || '{}'),
    water:      JSON.parse(row.water      || '[]'),
    notes:      row.notes || '',
  };
}

// One-time migration: fix any Capacitor cached paths in existing diary items
try {
  const rows = db.prepare(`SELECT id, items FROM diary WHERE items LIKE '%_capacitor_file_%' OR items LIKE '%/image_cache/%' OR items LIKE '%/uploads/proxy%'`).all();
  if (rows.length > 0) {
    const update = db.prepare(`UPDATE diary SET items = ? WHERE id = ?`);
    db.transaction(() => {
      for (const row of rows) {
        const items = fixCachedPaths(JSON.parse(row.items || '[]'));
        update.run(JSON.stringify(items), row.id);
      }
    })();
    console.log(`[diary] Fixed ${rows.length} diary entries with cached image paths`);
  }
} catch {}

export default router;
