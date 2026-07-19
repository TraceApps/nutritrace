import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

// Clear all app data (scoped to current user)
router.delete('/', wrap((req, res) => {
  const u = uid(req);
  if (u == null) {
    db.prepare(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`UPDATE diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`DELETE FROM wellness_data`).run();
    db.prepare(`DELETE FROM workouts`).run();
    db.prepare(`DELETE FROM ai_chat_history`).run();
  } else {
    db.prepare(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    db.prepare(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    db.prepare(`UPDATE diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    db.prepare(`UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    db.prepare(`DELETE FROM wellness_data WHERE user_id = ?`).run(u);
    db.prepare(`DELETE FROM workouts WHERE user_id = ?`).run(u);
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id = ?`).run(u);
  }
  res.json({ ok: true });
}));

// Bulk import — accepts NutriTrace backup format (foodList/meals/recipes/diary)
router.post('/import', wrap((req, res) => {
  const { foodList = [], meals = [], recipes = [], diary = [], activity = [], fasts = [] } = req.body;
  const u = uid(req);

  // updated_at must be set explicitly: the differential sync engine filters
  // foods/meals by `updated_at >= since`, and rows inserted without it would
  // never appear in the Android delta pull (#39 — reported by nomad64).
  //
  // Extra columns beyond the original diary/foods trio are included so a
  // JSON round-trip (export -> import) preserves per-food favorites, "recently
  // used" ordering, sharing visibility, and the rc.50 OFF unit metadata
  // (nutrition_basis, alt_units, density_g_ml). Missing fields default to
  // safe values so partial or older exports still import cleanly.
  const insFood = db.prepare(
    `INSERT OR IGNORE INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode,
                                  visibility, source_id, favorite, usage_count, last_used_at,
                                  nutrition_basis, alt_units, density_g_ml, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  const insMeal = db.prepare(
    `INSERT OR IGNORE INTO meals (user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings,
                                  visibility, source_id, favorite, usage_count, last_used_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  // updated_at must be set explicitly on every insert: differential sync
  // filters with `updated_at >= ?` and NULL never matches. Even tables that
  // have a column-level DEFAULT (datetime('now')) lose it through
  // INSERT OR REPLACE (the row is dropped and re-inserted; the default only
  // applies when the column is omitted from the column list).
  const insDiary = db.prepare(
    `INSERT OR REPLACE INTO diary (user_id, date, items, body_stats, water, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  const insActivity = db.prepare(
    `INSERT INTO activity_log (user_id, date, name, kcal, duration_min, distance, source, met, is_template, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  const insFast = db.prepare(
    `INSERT INTO fasts (user_id, start_at, end_at, goal_hours, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );

  const run = db.transaction(() => {
    for (const f of foodList) {
      insFood.run(
        u, f.name || '', f.brand || null,
        JSON.stringify(f.nutrition || {}),
        f.portion ?? 100, f.unit || 'g',
        f.imgUrl || f.img_url || null,
        f.notes || null,
        (f.categories && f.categories[0]) || f.category || null,
        f.barcode || null,
        f.visibility || 'private',
        f.source_id ?? null,
        f.favorite ? 1 : 0,
        Math.max(0, parseInt(f.usage_count) || 0),
        f.last_used_at || null,
        f.nutrition_basis || null,
        f.alt_units ? (typeof f.alt_units === 'string' ? f.alt_units : JSON.stringify(f.alt_units)) : null,
        f.density_g_ml != null ? Number(f.density_g_ml) : null
      );
    }
    for (const m of [...meals, ...recipes]) {
      insMeal.run(
        u, m.name || '', JSON.stringify(m.nutrition || {}),
        JSON.stringify(m.items || []),
        m.imgUrl || m.img_url || null,
        m.notes || null,
        recipes.includes(m) ? 1 : 0,
        m.portion ?? 100, m.unit || 'g',
        m.servings != null ? Math.max(1, parseInt(m.servings) || 1) : null,
        m.visibility || 'private',
        m.source_id ?? null,
        m.favorite ? 1 : 0,
        Math.max(0, parseInt(m.usage_count) || 0),
        m.last_used_at || null
      );
    }
    for (const e of diary) {
      if (!e.date) continue;
      insDiary.run(
        u, e.date,
        JSON.stringify(e.items || []),
        JSON.stringify(e.bodyStats || e.body_stats || {}),
        JSON.stringify(e.water || []),
        (typeof e.notes === 'string' && e.notes.trim()) ? e.notes : null
      );
    }
    for (const a of activity) {
      if (!a.date || !a.name) continue;
      insActivity.run(
        u, a.date, String(a.name).slice(0, 80),
        Math.max(0, Math.round(Number(a.kcal) || 0)),
        a.duration_min != null ? Math.max(0, Math.round(Number(a.duration_min))) : null,
        a.distance != null ? String(a.distance).slice(0, 40) : null,
        a.source || 'manual_form',
        (a.met != null && Number.isFinite(Number(a.met))) ? Math.max(0, Math.min(25, Number(a.met))) : null,
        a.is_template ? 1 : 0
      );
    }
    for (const f of fasts) {
      if (!f.start_at) continue;
      insFast.run(
        u, f.start_at, f.end_at || null,
        Number(f.goal_hours) || 16,
        f.notes != null ? String(f.notes).slice(0, 500) : null
      );
    }
  });

  run();
  res.json({ ok: true });
}));

export default router;
