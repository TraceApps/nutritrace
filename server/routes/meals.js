import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { sharingEnabled, canRead as _canRead } from '../lib/sharing.js';
import { localizeImage, isExternalUrl } from '../lib/image-localizer.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

const canRead = (meal, u) => _canRead(meal, u, 'meal_shares', 'meal_id');

// ── GET / ─────────────────────────────────────────────────────────────────
router.get('/', wrap((req, res) => {
  const isRecipe = req.query.recipes === '1' ? 1 : 0;
  const u = uid(req);

  if (u == null) {
    return res.json(db.prepare('SELECT * FROM meals WHERE is_recipe = ? AND deleted_at IS NULL ORDER BY name ASC').all(isRecipe).map(parse));
  }

  if (req.query.group === '1' && sharingEnabled()) {
    // Group catalogue: other users' meals/recipes visible to this user
    const others = db.prepare('SELECT * FROM meals WHERE is_recipe = ? AND user_id != ? AND deleted_at IS NULL ORDER BY name ASC').all(isRecipe, u);
    const shared = others.filter(m => canRead(m, u));
    const userCache = {};
    for (const m of shared) {
      if (m.user_id && !userCache[m.user_id]) {
        const usr = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(m.user_id);
        userCache[m.user_id] = usr?.full_name || usr?.username || 'Unknown';
      }
      m._shared_by = userCache[m.user_id] || null;
    }
    return res.json(shared.map(parse));
  }

  const rows = db.prepare('SELECT * FROM meals WHERE is_recipe = ? AND user_id = ? AND deleted_at IS NULL ORDER BY name ASC').all(isRecipe, u);
  res.json(rows.map(parse));
}));

// ── GET /:id ──────────────────────────────────────────────────────────────
router.get('/:id', wrap((req, res) => {
  const u = uid(req);
  const row = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (u != null && !canRead(row, u)) return res.status(403).json({ error: 'Forbidden' });
  if (u != null && row.user_id === u && row.visibility === 'specific') {
    row._specific_users = db.prepare('SELECT user_id FROM meal_shares WHERE meal_id = ?').all(row.id).map(r => r.user_id);
  }
  res.json(parse(row));
}));

// ── POST / ────────────────────────────────────────────────────────────────
router.post('/', wrap(async (req, res) => {
  const { name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, visibility, source_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const u = uid(req);
  const vis = visibility || 'private';
  const localImg = isExternalUrl(img_url) ? await localizeImage(img_url) : (img_url || null);
  const result = db.prepare(
    `INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, visibility, source_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(u, name, JSON.stringify(nutrition || {}), JSON.stringify(items || []),
    localImg, notes || null, is_recipe ? 1 : 0, portion ?? 100, unit || 'g',
    servings != null ? Math.max(1, parseInt(servings) || 1) : null,
    vis, source_id || null);
  res.status(201).json(parse(db.prepare('SELECT * FROM meals WHERE id = ?').get(result.lastInsertRowid)));
}));

// ── PUT /:id ──────────────────────────────────────────────────────────────
router.put('/:id', wrap((req, res) => {
  const u = uid(req);
  const existing = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (u != null && existing.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  const { name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, visibility, favorite } = req.body;
  const fav = favorite != null ? (favorite ? 1 : 0) : existing.favorite;
  // Body explicitly set servings → take it (null clears, number clamps to >=1).
  // Body omitted servings entirely → preserve the existing row value (null stays null).
  const srv = 'servings' in req.body
    ? (servings != null ? Math.max(1, parseInt(servings) || 1) : null)
    : existing.servings;
  db.prepare(
    `UPDATE meals SET name=?, nutrition=?, items=?, img_url=?, notes=?, is_recipe=?, portion=?, unit=?, servings=?, visibility=?, favorite=?, updated_at=datetime('now') WHERE id=?`
  ).run(name ?? existing.name, JSON.stringify(nutrition ?? JSON.parse(existing.nutrition || '{}')),
    JSON.stringify(items ?? JSON.parse(existing.items || '[]')), img_url ?? existing.img_url,
    notes ?? existing.notes, is_recipe != null ? (is_recipe ? 1 : 0) : existing.is_recipe,
    portion ?? existing.portion, unit ?? existing.unit, srv,
    visibility ?? existing.visibility, fav, req.params.id);
  res.json(parse(db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id)));
}));

// ── POST /:id/used — bump usage_count + last_used_at on a saved meal ─────
router.post('/:id/used', wrap((req, res) => {
  const u = uid(req);
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.status(404).json({ error: 'Not found' });
  if (u != null && meal.user_id !== u && meal.visibility === 'private') return res.status(403).json({ error: 'Forbidden' });
  const date = (req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date))
    ? req.body.date
    : new Date().toISOString().slice(0, 10);
  db.prepare(`UPDATE meals SET usage_count = usage_count + 1, last_used_at = MAX(COALESCE(last_used_at, ''), ?), updated_at = datetime('now') WHERE id = ?`)
    .run(date, req.params.id);
  res.json({ ok: true });
}));

// ── DELETE /:id ───────────────────────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const existing = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (u != null && existing.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
}));

// ── PATCH /:id/share ──────────────────────────────────────────────────────
router.patch('/:id/share', wrap((req, res) => {
  const u = uid(req);
  if (!sharingEnabled()) return res.status(403).json({ error: 'Sharing is not enabled on this instance.' });
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.status(404).json({ error: 'Not found' });
  if (u != null && meal.user_id !== u) return res.status(403).json({ error: 'Forbidden' });

  const { visibility, user_ids } = req.body;
  if (!['private', 'group', 'specific'].includes(visibility)) {
    return res.status(400).json({ error: 'visibility must be private, group, or specific' });
  }

  db.prepare(`UPDATE meals SET visibility = ?, updated_at = datetime('now') WHERE id = ?`).run(visibility, meal.id);
  db.prepare('DELETE FROM meal_shares WHERE meal_id = ?').run(meal.id);
  if (visibility === 'specific' && Array.isArray(user_ids)) {
    const ins = db.prepare('INSERT OR IGNORE INTO meal_shares (meal_id, user_id) VALUES (?, ?)');
    db.transaction(() => { for (const uid_ of user_ids) ins.run(meal.id, uid_); })();
  }

  res.json({ ok: true, visibility });
}));

// ── POST /:id/copy — clone shared meal/recipe into caller's catalogue ─────
// Food items within the meal are handled client-side (foods have their own /copy endpoint).
// We store items as embedded nutrition snapshots so the copy always works regardless of
// whether the original food items are accessible to the new owner.
router.post('/:id/copy', wrap((req, res) => {
  const u = uid(req);
  if (!sharingEnabled()) return res.status(403).json({ error: 'Sharing is not enabled on this instance.' });
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.status(404).json({ error: 'Not found' });
  if (u != null && meal.user_id === u) return res.status(400).json({ error: 'Already yours' });
  if (u != null && !canRead(meal, u)) return res.status(403).json({ error: 'Forbidden' });

  // Already copied?
  if (u != null) {
    const existing = db.prepare('SELECT id FROM meals WHERE user_id = ? AND source_id = ?').get(u, meal.id);
    if (existing) return res.json(parse(db.prepare('SELECT * FROM meals WHERE id = ?').get(existing.id)));
  }

  const result = db.prepare(
    `INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, visibility, source_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, datetime('now'))`
  ).run(u, meal.name, meal.nutrition, meal.items, meal.img_url, meal.notes,
    meal.is_recipe, meal.portion, meal.unit, meal.id);
  res.status(201).json(parse(db.prepare('SELECT * FROM meals WHERE id = ?').get(result.lastInsertRowid)));
}));

function parse(row) {
  return {
    ...row,
    nutrition: JSON.parse(row.nutrition || '{}'),
    items: JSON.parse(row.items || '[]'),
    is_recipe: row.is_recipe === 1,
    _specific_users: row._specific_users || undefined,
  };
}

export default router;
