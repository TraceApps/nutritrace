import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { sharingEnabled, canRead as _canRead } from '../lib/sharing.js';
import { localizeImage, isExternalUrl } from '../lib/image-localizer.js';

const router = Router();
router.use(requireAuth);

/** Current user's id, or null in single-user mode */
const uid = req => userMgmtActive() ? req.user.id : null;

const canRead = (food, u) => _canRead(food, u, 'food_shares', 'food_id');

// ── GET / — own foods + shared foods from others ──────────────────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  if (u == null) {
    // Single-user mode — no sharing concept
    return res.json(db.prepare('SELECT * FROM foods WHERE deleted_at IS NULL ORDER BY name ASC').all().map(parse));
  }

  const sharing = sharingEnabled();
  // Always return own foods
  let rows = db.prepare('SELECT * FROM foods WHERE user_id = ? AND deleted_at IS NULL ORDER BY name ASC').all(u);

  if (sharing && req.query.group === '1') {
    // Group catalogue: other users' foods visible to this user
    const others = db.prepare('SELECT * FROM foods WHERE user_id != ? AND deleted_at IS NULL ORDER BY name ASC').all(u);
    const shared = others.filter(f => canRead(f, u));
    // Attach owner display name
    const userCache = {};
    for (const f of shared) {
      if (f.user_id && !userCache[f.user_id]) {
        const usr = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(f.user_id);
        userCache[f.user_id] = usr?.full_name || usr?.username || 'Unknown';
      }
      f._shared_by = userCache[f.user_id] || null;
    }
    return res.json(shared.map(parse));
  }

  res.json(rows.map(parse));
}));

// ── GET /:id ──────────────────────────────────────────────────────────────
router.get('/:id', wrap((req, res) => {
  const u = uid(req);
  const row = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (u != null && !canRead(row, u)) return res.status(403).json({ error: 'Forbidden' });
  // Attach share list if owner
  if (u != null && row.user_id === u && row.visibility === 'specific') {
    row._specific_users = db.prepare('SELECT user_id FROM food_shares WHERE food_id = ?').all(row.id).map(r => r.user_id);
  }
  res.json(parse(row));
}));

// ── POST / ────────────────────────────────────────────────────────────────
router.post('/', wrap(async (req, res) => {
  const { name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const u = uid(req);
  const vis = visibility || 'private';
  // Dedup by barcode within the user's library. The client-side scan handler
  // also looks up local matches before POSTing, but a fast second scan can
  // race the foods-list refresh and reach this endpoint with a barcode that
  // already exists. Return the existing row so the editor opens that food
  // instead of inserting a duplicate.
  if (barcode) {
    const userClause = u != null ? 'user_id = ?' : 'user_id IS NULL';
    const args = u != null ? [barcode, u] : [barcode];
    const existing = db.prepare(
      `SELECT * FROM foods WHERE barcode = ? AND ${userClause} AND deleted_at IS NULL LIMIT 1`
    ).get(...args);
    if (existing) return res.status(200).json(parse(existing));
  }
  // Download external images to /uploads/ for self-hosting
  const localImg = isExternalUrl(img_url) ? await localizeImage(img_url) : (img_url || null);
  const result = db.prepare(
    `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(u, name, brand || null, JSON.stringify(nutrition || {}), portion ?? 100, unit || 'g',
    localImg, notes || null, category || null, barcode || null, vis, source_id || null);
  res.status(201).json(parse(db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid)));
}));

// ── PUT /:id ──────────────────────────────────────────────────────────────
router.put('/:id', wrap(async (req, res) => {
  const u = uid(req);
  const existing = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (u != null && existing.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  const { name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, favorite } = req.body;
  const localImg = (img_url && isExternalUrl(img_url)) ? await localizeImage(img_url) : (img_url ?? existing.img_url);
  const fav = favorite != null ? (favorite ? 1 : 0) : existing.favorite;
  db.prepare(
    `UPDATE foods SET name=?, brand=?, nutrition=?, portion=?, unit=?, img_url=?, notes=?, category=?, barcode=?, visibility=?, favorite=?, updated_at=datetime('now') WHERE id=?`
  ).run(name ?? existing.name, brand ?? existing.brand,
    JSON.stringify(nutrition ?? JSON.parse(existing.nutrition || '{}')),
    portion ?? existing.portion, unit ?? existing.unit, localImg,
    notes ?? existing.notes, category ?? existing.category, barcode ?? existing.barcode,
    visibility ?? existing.visibility, fav, req.params.id);
  res.json(parse(db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id)));
}));

// ── POST /:id/used — bump usage_count + last_used_at ──────────────────────
// Called by the client whenever a food is added to a diary entry. Cheap,
// idempotent, increments by 1 each call. last_used_at uses the diary date
// from the request body (or today if missing) so historical add-to-diary
// flows backfill correctly.
router.post('/:id/used', wrap((req, res) => {
  const u = uid(req);
  const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!food) return res.status(404).json({ error: 'Not found' });
  if (u != null && !canRead(food, u)) return res.status(403).json({ error: 'Forbidden' });
  const date = (req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date))
    ? req.body.date
    : new Date().toISOString().slice(0, 10);
  db.prepare(`UPDATE foods SET usage_count = usage_count + 1, last_used_at = MAX(COALESCE(last_used_at, ''), ?), updated_at = datetime('now') WHERE id = ?`)
    .run(date, req.params.id);
  res.json({ ok: true });
}));

// ── DELETE /:id ───────────────────────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const existing = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (u != null && existing.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
}));

// ── PATCH /:id/share — set visibility + specific user list ───────────────
router.patch('/:id/share', wrap((req, res) => {
  const u = uid(req);
  if (!sharingEnabled()) return res.status(403).json({ error: 'Sharing is not enabled on this instance.' });
  const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!food) return res.status(404).json({ error: 'Not found' });
  if (u != null && food.user_id !== u) return res.status(403).json({ error: 'Forbidden' });

  const { visibility, user_ids } = req.body; // user_ids: number[] for 'specific' mode
  if (!['private', 'group', 'specific'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility must be private, group, or specific' });
  }

  db.prepare(`UPDATE foods SET visibility = ?, updated_at = datetime('now') WHERE id = ?`).run(visibility, food.id);

  // Sync specific-user grants
  db.prepare('DELETE FROM food_shares WHERE food_id = ?').run(food.id);
  if (visibility === 'specific' && Array.isArray(user_ids)) {
    const ins = db.prepare('INSERT OR IGNORE INTO food_shares (food_id, user_id) VALUES (?, ?)');
    db.transaction(() => { for (const uid_ of user_ids) ins.run(food.id, uid_); })();
  }

  res.json({ ok: true, visibility });
}));

// ── POST /:id/copy — clone a shared food into caller's catalogue ──────────
router.post('/:id/copy', wrap((req, res) => {
  const u = uid(req);
  if (!sharingEnabled()) return res.status(403).json({ error: 'Sharing is not enabled on this instance.' });
  const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!food) return res.status(404).json({ error: 'Not found' });
  if (u != null && food.user_id === u) return res.status(400).json({ error: 'Already yours' });
  if (u != null && !canRead(food, u)) return res.status(403).json({ error: 'Forbidden' });

  // Check not already copied
  if (u != null) {
    const existing = db.prepare('SELECT id FROM foods WHERE user_id = ? AND source_id = ?').get(u, food.id);
    if (existing) return res.json(parse(db.prepare('SELECT * FROM foods WHERE id = ?').get(existing.id)));
  }

  const result = db.prepare(
    `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, datetime('now'))`
  ).run(u, food.name, food.brand, food.nutrition, food.portion, food.unit,
    food.img_url, food.notes, food.category, food.barcode, food.id);
  res.status(201).json(parse(db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid)));
}));

// ── POST /bulk-share — set visibility on all owned foods/meals/recipes at once ─
router.post('/bulk-share', wrap((req, res) => {
  const u = uid(req);
  if (!sharingEnabled()) return res.status(403).json({ error: 'Sharing is not enabled.' });
  const { visibility, targets, user_ids = [] } = req.body;
  if (!['private','group','specific'].includes(visibility)) return res.status(400).json({ error: 'Invalid visibility' });

  const t = Array.isArray(targets) ? targets : ['foods','meals','recipes'];
  const doFoods = t.includes('foods');
  const doMeals = t.includes('meals');
  const doRecipes = t.includes('recipes');

  // Foods
  if (doFoods) {
    if (u != null) db.prepare(`UPDATE foods SET visibility = ?, updated_at = datetime('now') WHERE user_id = ?`).run(visibility, u);
    else           db.prepare(`UPDATE foods SET visibility = ?, updated_at = datetime('now')`).run(visibility);
    if (u != null) db.prepare(`DELETE FROM food_shares WHERE food_id IN (SELECT id FROM foods WHERE user_id = ?)`).run(u);
    else           db.prepare(`DELETE FROM food_shares`).run();
    if (visibility === 'specific' && user_ids.length) {
      const foodIds = u != null
        ? db.prepare(`SELECT id FROM foods WHERE user_id = ?`).all(u).map(r => r.id)
        : db.prepare(`SELECT id FROM foods`).all().map(r => r.id);
      const ins = db.prepare(`INSERT OR IGNORE INTO food_shares (food_id, user_id) VALUES (?, ?)`);
      const tx = db.transaction(() => { for (const fid of foodIds) for (const uid2 of user_ids) ins.run(fid, uid2); });
      tx();
    }
  }

  // Meals
  const mealFilter = doMeals && !doRecipes ? 'AND is_recipe = 0' : !doMeals && doRecipes ? 'AND is_recipe = 1' : '';
  if (doMeals || doRecipes) {
    if (u != null) db.prepare(`UPDATE meals SET visibility = ?, updated_at = datetime('now') WHERE user_id = ? ${mealFilter}`).run(visibility, u);
    else           db.prepare(`UPDATE meals SET visibility = ?, updated_at = datetime('now') ${mealFilter}`).run(visibility);
    if (u != null) db.prepare(`DELETE FROM meal_shares WHERE meal_id IN (SELECT id FROM meals WHERE user_id = ? ${mealFilter})`).run(u);
    else           db.prepare(`DELETE FROM meal_shares`).run();
    if (visibility === 'specific' && user_ids.length) {
      const mealIds = u != null
        ? db.prepare(`SELECT id FROM meals WHERE user_id = ? ${mealFilter}`).all(u).map(r => r.id)
        : db.prepare(`SELECT id FROM meals ${mealFilter ? 'WHERE ' + mealFilter.slice(4) : ''}`).all().map(r => r.id);
      const ins = db.prepare(`INSERT OR IGNORE INTO meal_shares (meal_id, user_id) VALUES (?, ?)`);
      const tx = db.transaction(() => { for (const mid of mealIds) for (const uid2 of user_ids) ins.run(mid, uid2); });
      tx();
    }
  }

  res.json({ ok: true });
}));

function parse(row) {
  return {
    ...row,
    nutrition: JSON.parse(row.nutrition || '{}'),
    _specific_users: row._specific_users || undefined,
  };
}

export default router;
