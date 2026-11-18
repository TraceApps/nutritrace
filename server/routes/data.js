import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { ensureUuids } from '../lib/diary-merge.js';
import { categoriesFromSave } from '../lib/categories.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

// Clear all app data (scoped to current user). Rows phones mirror go by
// deleted_at, or for wellness and workouts through sync_deletions (db.js),
// so a phone's next sync drops them too.
router.delete('/', wrap((req, res) => {
  const u = uid(req);
  if (u == null) {
    db.prepare(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`UPDATE diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`UPDATE fasts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    db.prepare(`DELETE FROM wellness_data`).run();
    db.prepare(`DELETE FROM workouts`).run();
    db.prepare(`DELETE FROM ai_chat_history`).run();
  } else {
    db.prepare(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    db.prepare(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    db.prepare(`UPDATE diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    db.prepare(`UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    db.prepare(`UPDATE fasts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
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
    `INSERT OR IGNORE INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, categories, barcode,
                                  visibility, source_id, favorite, usage_count, last_used_at,
                                  nutrition_basis, alt_units, density_g_ml,
                                  source_app, source_external_id, source_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  const insMeal = db.prepare(
    `INSERT OR IGNORE INTO meals (user_id, name, nutrition, items, img_url, notes, categories, is_recipe, portion, unit, servings,
                                  visibility, source_id, favorite, usage_count, last_used_at,
                                  source_app, source_external_id, source_url, import_warnings, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  // updated_at must be set explicitly on every insert: differential sync
  // filters with `updated_at >= ?` and NULL never matches. Even tables that
  // have a column-level DEFAULT (datetime('now')) lose it through
  // INSERT OR REPLACE (the row is dropped and re-inserted; the default only
  // applies when the column is omitted from the column list).
  const insDiary = db.prepare(
    `INSERT OR REPLACE INTO diary (user_id, date, items, body_stats, water, notes, notes_updated_at,
                                   completed_at, completed_meals, completion_marked_at, meal_marks_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  // A day's completion marks (#207) and when its note was written: the
  // export's, or the day's own when the export has none (one from before
  // the marks), so importing a day doesn't take them away.
  // With user management off a day has no account, and SQLite's unique
  // (date, user_id) never matches two NULLs: INSERT OR REPLACE added a
  // second row for a date already here. The day here is replaced instead,
  // the row the app reads and saves (routes/diary.js), as the account's is.
  // Its field times stay: the trigger stamps the measurements that changed
  // (db.js fs_diary_stats), so an older phone edit doesn't win over them.
  const soloDay = db.prepare(`SELECT id FROM diary WHERE date = ? AND user_id IS NULL`);
  const replaceSoloDay = db.prepare(
    `UPDATE diary SET items=?, body_stats=?, water=?, notes=?, notes_updated_at=?,
                      completed_at=?, completed_meals=?, completion_marked_at=?, meal_marks_at=?,
                      deleted_at=NULL, updated_at=datetime('now')
      WHERE id=?`
  );
  const prevDay = db.prepare(
    `SELECT completed_at, completed_meals, completion_marked_at, meal_marks_at FROM diary WHERE date = ? AND user_id IS ? AND deleted_at IS NULL`
  );
  const _slots = v => {
    let a = v;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    if (!Array.isArray(a)) return null;
    const ok = [...new Set(a.filter(n => Number.isInteger(n) && n >= 0 && n <= 31))].sort((x, y) => x - y);
    return ok.length ? JSON.stringify(ok) : null;
  };
  const _text = v => (typeof v === 'string' && v ? v : (v != null && typeof v === 'object' ? JSON.stringify(v) : null));
  // A food or meal's source (source_app, source_external_id, source_url),
  // as the editors and the CookTrace pull keep them.
  const _source = r => (r?.source_app && r?.source_external_id)
    ? [String(r.source_app).slice(0, 40), String(r.source_external_id).slice(0, 128), r.source_url ? String(r.source_url).slice(0, 2048) : null]
    : [null, null, null];
  const insActivity = db.prepare(
    `INSERT INTO activity_log (user_id, date, name, kcal, duration_min, distance, source, met, is_template, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  const insFast = db.prepare(
    `INSERT INTO fasts (user_id, start_at, end_at, goal_hours, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );

  // Fasts already here, by start (single-user: all of them, as routes/fasts.js).
  const sameFast = db.prepare(`SELECT id, end_at FROM fasts WHERE user_id IS ? AND start_at = ? AND deleted_at IS NULL`);
  const activeFast = db.prepare(`SELECT id FROM fasts WHERE user_id IS ? AND end_at IS NULL AND deleted_at IS NULL`);
  const endFast = db.prepare(`UPDATE fasts SET end_at = ?, notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?`);

  const run = db.transaction(() => {
    // A deleted copy from the same source still holds its place in the
    // unique source index: it lets go, or the import skipped the food (as
    // routes/foods.js does for one deleted and added again).
    const releaseFood = db.prepare(`UPDATE foods SET source_app = NULL, source_external_id = NULL WHERE user_id IS ? AND source_app = ? AND source_external_id = ? AND deleted_at IS NOT NULL`);
    const releaseMeal = db.prepare(`UPDATE meals SET source_app = NULL, source_external_id = NULL WHERE user_id IS ? AND source_app = ? AND source_external_id = ? AND deleted_at IS NOT NULL`);
    for (const f of foodList) {
      { const [app, ext] = _source(f); if (app) releaseFood.run(u ?? null, app, ext); }
      insFood.run(
        u, f.name || '', f.brand || null,
        JSON.stringify(f.nutrition || {}),
        f.portion ?? 100, f.unit || 'g',
        f.imgUrl || f.img_url || null,
        f.notes || null,
        // The export's list (or an older export's single category), #332.
        ...(c => [c?.category ?? null, c?.categories ?? null])(categoriesFromSave(Array.isArray(f.categories) ? { categories: f.categories } : { category: f.category }, null)),
        f.barcode || null,
        f.visibility || 'private',
        f.source_id ?? null,
        f.favorite ? 1 : 0,
        Math.max(0, parseInt(f.usage_count) || 0),
        f.last_used_at || null,
        f.nutrition_basis || null,
        f.alt_units ? (typeof f.alt_units === 'string' ? f.alt_units : JSON.stringify(f.alt_units)) : null,
        f.density_g_ml != null ? Number(f.density_g_ml) : null,
        // Where it came from (the CookTrace pantry): its "From CookTrace" badge and link.
        ..._source(f)
      );
    }
    for (const m of [...meals, ...recipes]) {
      { const [app, ext] = _source(m); if (app) releaseMeal.run(u ?? null, app, ext); }
      insMeal.run(
        u, m.name || '', JSON.stringify(m.nutrition || {}),
        JSON.stringify(m.items || []),
        m.imgUrl || m.img_url || null,
        m.notes || null,
        categoriesFromSave({ categories: m.categories }, null)?.categories ?? null,
        recipes.includes(m) ? 1 : 0,
        m.portion ?? 100, m.unit || 'g',
        m.servings != null ? Math.max(1, parseInt(m.servings) || 1) : null,
        m.visibility || 'private',
        m.source_id ?? null,
        m.favorite ? 1 : 0,
        Math.max(0, parseInt(m.usage_count) || 0),
        m.last_used_at || null,
        ..._source(m),
        Array.isArray(m.import_warnings) && m.import_warnings.length
          ? JSON.stringify(m.import_warnings.map(w => String(w || '').slice(0, 400)).filter(Boolean).slice(0, 20))
          : (typeof m.import_warnings === 'string' && m.import_warnings ? m.import_warnings : null)
      );
    }
    for (const e of diary) {
      if (!e.date) continue;
      const prev = prevDay.get(e.date, u ?? null);
      const notes = (typeof e.notes === 'string' && e.notes.trim()) ? e.notes : null;
      // The marks go as one: the export's when it has them (even "not
      // closed"), the day's own when it's from before the marks.
      const hasMarks = ['completed_at', 'completed_meals', 'completion_marked_at', 'meal_marks_at'].some(k => k in e);
      const marks = hasMarks ? e : (prev || {});
      const solo = u == null ? soloDay.get(e.date) : null;
      (solo ? (...v) => replaceSoloDay.run(...v.slice(2), solo.id) : (...v) => insDiary.run(...v))(
        u, e.date,
        // #239: exports from before per-item uuids carry none; give them one
        // on the way in, or the app's first save of each day doubles it.
        JSON.stringify(ensureUuids(e.items || [])),
        JSON.stringify(e.bodyStats || e.body_stats || {}),
        JSON.stringify(ensureUuids(e.water || [])),
        notes,
        // A note without its time counts from now (the insert trigger).
        notes ? _text(e.notes_updated_at) : null,
        _text(marks.completed_at),
        _slots(marks.completed_meals),
        _text(marks.completion_marked_at),
        _text(marks.meal_marks_at)
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
      // Already here (an export imported again): kept, not added twice. One
      // running here and finished in the export ends as it did there.
      const here = sameFast.get(u ?? null, f.start_at);
      if (here) {
        if (!here.end_at && f.end_at) endFast.run(String(f.end_at), f.notes != null ? String(f.notes).slice(0, 500) : null, here.id);
        continue;
      }
      // One fast runs at a time (routes/fasts.js).
      if (!f.end_at && activeFast.get(u ?? null)) continue;
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
