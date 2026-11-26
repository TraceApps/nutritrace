import { Router } from 'express';
import { goneBody } from '../lib/rest-merge.js';
import { createMeal, updateMeal, deleteMeal } from '../lib/meal-save.js';
import { linkBase } from '../lib/public-url.js';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { sharingEnabled, canRead as _canRead } from '../lib/sharing.js';
import { localizeImage, isExternalUrl } from '../lib/image-localizer.js';
import { sendMealShared, isEmailConfigured } from '../email.js';
import { logger } from '../logger.js';
import { ownerOrOptIn } from '../lib/outbound-policy.js';
import { cleanCreateKey, findByCreateKey } from '../lib/create-keys.js';
import { categoriesOut } from '../lib/categories.js';

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
  const { name, img_url, source_app } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const u = uid(req);
  // Sent again (a retry, or the answer was lost): the meal made the first
  // time, before fetching any image.
  const made = findByCreateKey('meals', u, cleanCreateKey(req.body.client_key));
  if (made) return res.status(200).json(parse(made));
  const cleanSourceApp = source_app ? String(source_app).slice(0, 40) : null;
  // For federation imports, trust the user's own saved integration base
  // URL for image fetches so a LAN CT/Mealie origin does not get blocked
  // by the SSRF guard (and the "From CookTrace" recipe silently ends up
  // with no thumbnail).
  const _trustedImgOrigins = (() => {
    if (!cleanSourceApp) return [];
    const key = cleanSourceApp === 'cooktrace' ? 'cooktraceBaseUrl'
              : cleanSourceApp === 'mealie'    ? 'mealieBaseUrl'
              : null;
    if (!key) return [];
    const row = u == null
      ? db.prepare(`SELECT value FROM user_settings WHERE key = ? AND deleted_at IS NULL LIMIT 1`).get(key)
      : db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL`).get(u, key);
    const v = (row?.value || '').replace(/^"|"$/g, '');
    return v ? [v] : [];
  })();
  // isExternalUrl treats any URL containing "/uploads/" as already-local;
  // for federation-sourced meals the CT origin's own /uploads/ path would
  // pass through unlocalized. Override that for source-stamped imports.
  const _shouldLocalizeImg = img_url && (cleanSourceApp
    ? (img_url.startsWith('http') || img_url.startsWith('data:'))
    : isExternalUrl(img_url));
  const localImg = _shouldLocalizeImg ? await localizeImage(img_url, { trustedOrigins: _trustedImgOrigins, allowPrivate: ownerOrOptIn(req, 'ALLOW_PRIVATE_IMAGE_URLS') }) : (img_url || null);
  // The save itself is shared with MCP's create_meal (lib/meal-save.js).
  const { status, row } = createMeal(u, req.body, localImg);
  res.status(status).json(parse(row));
}));

// ── PUT /:id ──────────────────────────────────────────────────────────────
router.put('/:id', wrap(async (req, res) => {
  const u = uid(req);
  const existing = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (u != null && existing.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  const { img_url } = req.body;
  // Same idiom for img_url: undefined → keep existing, null/'' → clear.
  // The old inline `img_url ?? existing.img_url` treated null as nullish and
  // preserved the existing image, so the MealEditor X-remove-photo button
  // silently failed to clear the photo on save. Parallel to the foods.js
  // PUT fix for kilkalabs's report on #74 follow-up. Localize supplied
  // images just as POST does, so the diary can resolve edited recipe photos.
  const img = 'img_url' in req.body
    ? ((img_url && isExternalUrl(img_url)) ? await localizeImage(img_url, { allowPrivate: ownerOrOptIn(req, 'ALLOW_PRIVATE_IMAGE_URLS') }) : (img_url || null))
    : existing.img_url;
  // The save itself is shared with MCP's update_meal (lib/meal-save.js).
  const row = updateMeal(existing, req.body, img);
  if (!row) return res.status(410).json(goneBody);
  res.json(parse(row));
}));

// ── POST /:id/used — bump usage_count + last_used_at on a saved meal ─────
router.post('/:id/used', wrap((req, res) => {
  const u = uid(req);
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.status(404).json({ error: 'Not found' });
  // The same rule as reading it (GET /:id): 'specific' meals only for the
  // people they're shared with (an access audit, after cooktrace#110).
  if (u != null && !canRead(meal, u)) return res.status(403).json({ error: 'Forbidden' });
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
  deleteMeal(existing.id);
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

  // Capture the previous grant set so we can email only the newly-added
  // grantees below (not people who already had access).
  const priorGrantees = new Set(
    db.prepare('SELECT user_id FROM meal_shares WHERE meal_id = ?').all(meal.id).map(r => r.user_id)
  );

  db.prepare(`UPDATE meals SET visibility = ?, updated_at = datetime('now') WHERE id = ?`).run(visibility, meal.id);
  db.prepare('DELETE FROM meal_shares WHERE meal_id = ?').run(meal.id);
  const newGrantees = [];
  if (visibility === 'specific' && Array.isArray(user_ids)) {
    const ins = db.prepare('INSERT OR IGNORE INTO meal_shares (meal_id, user_id) VALUES (?, ?)');
    db.transaction(() => {
      for (const uid_ of user_ids) {
        const n = Number(uid_);
        if (!Number.isFinite(n)) continue;
        ins.run(meal.id, n);
        if (!priorGrantees.has(n) && n !== meal.user_id) newGrantees.push(n);
      }
    })();
  }

  // Best-effort email each brand-new grantee. Silent no-op if SMTP is
  // unconfigured or any individual send throws. Never blocks the response.
  if (newGrantees.length > 0 && isEmailConfigured()) {
    const sharer = u != null
      ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(u)
      : null;
    const sharerName = sharer?.full_name || sharer?.username || null;
    // Recipes and non-recipe meals share the same client route family.
    const base = linkBase(req);
    const viewUrl = `${base}/#/foods`;
    const rows = db.prepare(
      `SELECT id, email FROM users WHERE id IN (${newGrantees.map(() => '?').join(',')})`
    ).all(...newGrantees);
    for (const row of rows) {
      if (!row.email || !base) continue;
      sendMealShared(row.email, meal.name, sharerName, viewUrl)
        .catch(e => logger.debug?.(`[share] meal email to ${row.email} failed: ${e.message}`));
    }
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
  // Already copied? A copy deleted since isn't one: this makes a new one.
  if (u != null) {
    const existing = db.prepare('SELECT id FROM meals WHERE user_id = ? AND source_id = ? AND deleted_at IS NULL').get(u, meal.id);
    if (existing) return res.json(parse(db.prepare('SELECT * FROM meals WHERE id = ?').get(existing.id)));
  }
  // Deleted by its owner: nothing left to copy (said after who may read it,
  // so a deleted private one doesn't tell anyone else it was there, and after
  // the copy already made, so asking again after a lost answer finds it).
  if (meal.deleted_at) return res.status(404).json({ error: 'Not found' });

  const result = db.prepare(
    `INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, categories, is_recipe, portion, unit, visibility, source_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, datetime('now'))`
  ).run(u, meal.name, meal.nutrition, meal.items, meal.img_url, meal.notes, meal.categories,
    meal.is_recipe, meal.portion, meal.unit, meal.id);
  res.status(201).json(parse(db.prepare('SELECT * FROM meals WHERE id = ?').get(result.lastInsertRowid)));
}));

function parse(row) {
  // import_warnings is a JSON string on disk (set by the CookTrace pull
  // flow when NT imports a CT recipe missing per-ingredient nutrition on
  // some rows), array on the wire. Parse defensively so a malformed value
  // does not 500 the whole meals GET.
  let warnings;
  if (row.import_warnings) {
    try { warnings = JSON.parse(row.import_warnings); } catch { warnings = null; }
  }
  return {
    ...row,
    // When each field changed (sync's bookkeeping) stays on the server.
    field_times: undefined,
    nutrition: JSON.parse(row.nutrition || '{}'),
    items: JSON.parse(row.items || '[]'),
    categories: categoriesOut(row),
    is_recipe: row.is_recipe === 1,
    import_warnings: Array.isArray(warnings) ? warnings : undefined,
    _specific_users: row._specific_users || undefined,
  };
}

export default router;
