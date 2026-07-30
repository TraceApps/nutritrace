import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { sharingEnabled, canRead as _canRead } from '../lib/sharing.js';
import { localizeImageForStorage } from '../lib/image-localizer.js';

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

// Issues #69 + #70: normalize alt_units for storage. Same shape as the sync
// route helper; duplicated here so foods.js is self-contained.
function _serializeAltUnitsForFood(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const clean = v
    .filter(r => r && typeof r === 'object')
    .map(r => ({ abbr: String(r.abbr || '').trim(), grams: Number(r.grams) }))
    .filter(r => r.abbr && Number.isFinite(r.grams) && r.grams > 0);
  return clean.length ? JSON.stringify(clean) : null;
}
function _normalizeDensity(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── POST / ────────────────────────────────────────────────────────────────
router.post('/', wrap(async (req, res) => {
  const { name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id,
    nutrition_basis, alt_units, density_g_ml } = req.body;
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
  // Inline data URLs must become /uploads/ paths or the request fails with
  // 422; they must never be persisted directly in SQLite.
  const localImg = img_url ? await localizeImageForStorage(img_url, 'food image') : null;
  const result = db.prepare(
    `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id, nutrition_basis, alt_units, density_g_ml, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(u, name, brand || null, JSON.stringify(nutrition || {}), portion ?? 100, unit || 'g',
    localImg, notes || null, category || null, barcode || null, vis, source_id || null,
    nutrition_basis || null,
    _serializeAltUnitsForFood(alt_units),
    _normalizeDensity(density_g_ml));
  res.status(201).json(parse(db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid)));
}));

// ── PUT /:id ──────────────────────────────────────────────────────────────
router.put('/:id', wrap(async (req, res) => {
  const u = uid(req);
  const existing = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (u != null && existing.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  const { name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, favorite,
    nutrition_basis, alt_units, density_g_ml } = req.body;
  // For img_url: undefined → keep existing, null/'' → explicit clear,
  // any other value → localize-if-external-or-data-URL-then-store. Without
  // this distinction, the X-remove-photo button in FoodEditor doesn't
  // actually clear the photo on save: the client maps food.imgUrl='' to
  // img_url=null in _foodToApi, the old `img_url ?? existing.img_url`
  // line treated null as nullish and preserved the existing image.
  // Reported by kilkalabs on #74 follow-up. Matches the same idiom already
  // used below for nutrition_basis / alt_units / density_g_ml.
  const localImg = img_url === undefined
    ? existing.img_url
    : (img_url ? await localizeImageForStorage(img_url, 'food image') : null);
  const fav = favorite != null ? (favorite ? 1 : 0) : existing.favorite;
  // For the OFF metadata: undefined → keep existing, null → explicit clear,
  // any other value → normalize-and-store. Lets the client patch one field
  // without resetting the others.
  const nb = nutrition_basis === undefined ? existing.nutrition_basis : (nutrition_basis || null);
  const au = alt_units === undefined ? existing.alt_units : _serializeAltUnitsForFood(alt_units);
  const dg = density_g_ml === undefined ? existing.density_g_ml : _normalizeDensity(density_g_ml);
  db.prepare(
    `UPDATE foods SET name=?, brand=?, nutrition=?, portion=?, unit=?, img_url=?, notes=?, category=?, barcode=?, visibility=?, favorite=?, nutrition_basis=?, alt_units=?, density_g_ml=?, updated_at=datetime('now') WHERE id=?`
  ).run(name ?? existing.name, brand ?? existing.brand,
    JSON.stringify(nutrition ?? JSON.parse(existing.nutrition || '{}')),
    portion ?? existing.portion, unit ?? existing.unit, localImg,
    notes ?? existing.notes, category ?? existing.category, barcode ?? existing.barcode,
    visibility ?? existing.visibility, fav, nb, au, dg, req.params.id);
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
router.post('/:id/copy', wrap(async (req, res) => {
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

  // Normally the source is already localized. Keep the copy path strict as
  // well so a legacy inline row cannot be duplicated if startup maintenance
  // could not repair it.
  const localImg = food.img_url
    ? await localizeImageForStorage(food.img_url, 'copied food image')
    : null;
  const result = db.prepare(
    `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility, source_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, datetime('now'))`
  ).run(u, food.name, food.brand, food.nutrition, food.portion, food.unit,
    localImg, food.notes, food.category, food.barcode, food.id);
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
  // alt_units is stored as a JSON string; parse to array on read so the
  // client gets a useable shape. Issues #69 + #70.
  let altUnits = null;
  if (typeof row.alt_units === 'string' && row.alt_units) {
    try { altUnits = JSON.parse(row.alt_units); } catch { altUnits = null; }
  } else if (Array.isArray(row.alt_units)) {
    altUnits = row.alt_units;
  }
  return {
    ...row,
    nutrition: JSON.parse(row.nutrition || '{}'),
    alt_units: altUnits,
    _specific_users: row._specific_users || undefined,
  };
}

export default router;
