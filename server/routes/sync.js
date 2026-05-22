/**
 * sync.js — Differential sync endpoints for the Android app.
 *
 * GET  /api/sync/pull?since=<ISO_timestamp> — returns all records modified after that timestamp
 * POST /api/sync/push — receives batch of changed records from the client
 *
 * Conflict strategy: last-write-wins by updated_at.
 * Soft-deleted records (deleted_at IS NOT NULL) are included in pull responses
 * so the client can remove them locally.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { isServerOnlyKey } from '../lib/server-only-keys.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user?.id : null;

import { freshenItemImages } from '../lib/diary-helpers.js';

function parse(row) {
  if (!row) return null;
  for (const key of ['nutrition', 'items', 'body_stats', 'water', 'metadata']) {
    if (typeof row[key] === 'string') {
      try { row[key] = JSON.parse(row[key]); } catch {}
    }
  }
  return row;
}

// Freshen diary item images at sync time so native clients get current images
// for items logged before their food had an image. Mirrors the behavior of
// /api/diary/* GET endpoints (see routes/diary.js).
function parseDiary(row) {
  const parsed = parse(row);
  if (parsed && Array.isArray(parsed.items)) {
    parsed.items = freshenItemImages(parsed.items);
  }
  return parsed;
}

// ── GET /pull?since=<timestamp> ──────────────────────────────────────────────
// Returns all records modified after `since` for the current user.
// Includes soft-deleted records so client can propagate deletions.
router.get('/pull', wrap((req, res) => {
  const u = uid(req);
  const since = req.query.since || '1970-01-01T00:00:00.000Z';
  const serverTime = new Date().toISOString();

  // Convert ISO timestamp to SQLite format for comparison (YYYY-MM-DD HH:MM:SS)
  const sinceSql = since.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '');

  const userFilter = u != null ? 'AND user_id = ?' : '';
  const params = u != null ? [sinceSql, u] : [sinceSql];

  // Boundary inclusive (>= not >): SQLite's datetime('now') has 1-second
  // precision, so a row inserted in the same second as the previous pull's
  // serverTime can fall through the cracks of an exclusive boundary check.
  // Re-pulling the boundary second every time costs trivial bandwidth and
  // the client's ON CONFLICT DO UPDATE upserts handle the duplicates
  // idempotently. Eliminates the race that caused withings body-comp rows
  // to silently drop on partial pulls (issue diagnosed 2026-05-02).
  const foods = db.prepare(
    `SELECT * FROM foods WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(...params).map(parse);

  const meals = db.prepare(
    `SELECT * FROM meals WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(...params).map(parse);

  const diary = db.prepare(
    `SELECT * FROM diary WHERE updated_at >= ? ${userFilter} ORDER BY updated_at`
  ).all(...params).map(parseDiary);

  const settings = u != null
    ? db.prepare('SELECT * FROM user_settings WHERE updated_at >= ? AND user_id = ? ORDER BY updated_at').all(sinceSql, u)
        .filter(s => !isServerOnlyKey(s.key)) // SECURITY: never push admin keys to clients
    : [];

  // Wellness data — pull only (server-generated from Fitbit/Withings/Garmin syncs)
  const wellnessParams = u != null ? [sinceSql, u] : [sinceSql];
  const wellness = db.prepare(
    `SELECT * FROM wellness_data WHERE synced_at >= ? ${u != null ? 'AND user_id = ?' : ''} ORDER BY synced_at`
  ).all(...wellnessParams).map(parse);

  // Workouts — pull only (server-generated from Fitbit activity log syncs)
  const workoutsParams = u != null ? [sinceSql, u] : [sinceSql];
  const workouts = db.prepare(
    `SELECT * FROM workouts WHERE updated_at >= ? ${u != null ? 'AND user_id = ?' : ''} ORDER BY updated_at`
  ).all(...workoutsParams).map(parse);

  // AI chat history — pull only (client posts via /api/ai/history directly)
  const chatParams = u != null ? [sinceSql, u] : [sinceSql];
  const chat_history = db.prepare(
    `SELECT id, role, content, created_at FROM ai_chat_history WHERE created_at >= ? ${u != null ? 'AND user_id = ?' : 'AND user_id IS NULL'} ORDER BY created_at`
  ).all(...chatParams);

  // Activity log — server-side updates pulled to clients
  const activityParams = u != null ? [sinceSql, u] : [sinceSql];
  const activity = db.prepare(
    `SELECT * FROM activity_log WHERE updated_at >= ? ${u != null ? 'AND user_id = ?' : 'AND user_id IS NULL'} ORDER BY updated_at`
  ).all(...activityParams);

  // Intermittent-fasting log — same shape as activity. Soft-deleted rows
  // come through so the client can mirror the deletion locally.
  const fasts = db.prepare(
    `SELECT * FROM fasts WHERE updated_at >= ? ${u != null ? 'AND user_id = ?' : 'AND user_id IS NULL'} ORDER BY updated_at`
  ).all(...activityParams);

  logger.debug(`[sync] pull since=${sinceSql}: foods=${foods.length} meals=${meals.length} diary=${diary.length} activity=${activity.length} fasts=${fasts.length} settings=${settings.length} wellness=${wellness.length} workouts=${workouts.length} chat=${chat_history.length}`);

  res.json({ foods, meals, diary, activity, fasts, settings, wellness, workouts, chat_history, server_time: serverTime });
}));

// ── POST /push ───────────────────────────────────────────────────────────────
// Receives batch of changed records from the client.
// Each record has: client_id, server_id (if previously synced), and the data fields.
// Returns a mapping of client_id → server_id for newly created records.
router.post('/push', wrap((req, res) => {
  const u = uid(req);
  const { foods = [], meals = [], diary = [], activity = [], fasts = [], wellness = [], settings = [] } = req.body;
  const result = { foods: [], meals: [], diary: [], activity: [], fasts: [], wellness: [], settings: [] };

  // Normalize timestamp for comparison (strip T, Z, milliseconds)
  const norm = ts => ts ? ts.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '') : '';

  const run = db.transaction(() => {
    // ── Foods ────────────────────────────────────────────────────────────
    for (const f of foods) {
      // Defensive: if client has a server_id but server has no matching row
      // (e.g. after a disaster-recovery push from a device whose cached IDs
      // are now stale), fall through to INSERT instead of silently no-op-ing.
      const existing = f.server_id
        ? db.prepare('SELECT updated_at FROM foods WHERE id = ?').get(f.server_id)
        : null;
      if (f.server_id && existing) {
        if (norm(f.updated_at) >= norm(existing.updated_at)) {
          if (f.deleted_at) {
            db.prepare(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(f.server_id);
          } else {
            db.prepare(
              `UPDATE foods SET name=?, brand=?, nutrition=?, portion=?, unit=?, img_url=?, notes=?, category=?, barcode=?, favorite=?, usage_count=MAX(usage_count, ?), last_used_at=MAX(COALESCE(last_used_at, ''), COALESCE(?, '')), updated_at=datetime('now') WHERE id=?`
            ).run(f.name, f.brand, JSON.stringify(f.nutrition || {}), f.portion ?? 100, f.unit || 'g',
              f.img_url || null, f.notes || null, f.category || null, f.barcode || null,
              f.favorite ? 1 : 0, f.usage_count || 0, f.last_used_at || null, f.server_id);
          }
        }
        result.foods.push({ client_id: f.client_id, server_id: f.server_id });
      } else if (!f.deleted_at) {
        // New record (no server_id, OR server_id refs missing row → re-create)
        const r = db.prepare(
          `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, favorite, usage_count, last_used_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(u, f.name, f.brand || null, JSON.stringify(f.nutrition || {}), f.portion ?? 100, f.unit || 'g',
          f.img_url || null, f.notes || null, f.category || null, f.barcode || null,
          f.favorite ? 1 : 0, f.usage_count || 0, f.last_used_at || null);
        result.foods.push({ client_id: f.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── Meals ────────────────────────────────────────────────────────────
    for (const m of meals) {
      const existing = m.server_id
        ? db.prepare('SELECT updated_at FROM meals WHERE id = ?').get(m.server_id)
        : null;
      if (m.server_id && existing) {
        if (norm(m.updated_at) >= norm(existing.updated_at)) {
          if (m.deleted_at) {
            db.prepare(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(m.server_id);
          } else {
            db.prepare(
              `UPDATE meals SET name=?, nutrition=?, items=?, img_url=?, notes=?, is_recipe=?, portion=?, unit=?, servings=?, favorite=?, usage_count=MAX(usage_count, ?), last_used_at=MAX(COALESCE(last_used_at, ''), COALESCE(?, '')), updated_at=datetime('now') WHERE id=?`
            ).run(m.name, JSON.stringify(m.nutrition || {}), JSON.stringify(m.items || []),
              m.img_url || null, m.notes || null, m.is_recipe ? 1 : 0, m.portion ?? 100, m.unit || 'g',
              m.servings != null ? Math.max(1, parseInt(m.servings) || 1) : null,
              m.favorite ? 1 : 0, m.usage_count || 0, m.last_used_at || null, m.server_id);
          }
        }
        result.meals.push({ client_id: m.client_id, server_id: m.server_id });
      } else if (!m.deleted_at) {
        const r = db.prepare(
          `INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, favorite, usage_count, last_used_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(u, m.name, JSON.stringify(m.nutrition || {}), JSON.stringify(m.items || []),
          m.img_url || null, m.notes || null, m.is_recipe ? 1 : 0, m.portion ?? 100, m.unit || 'g',
          Math.max(1, parseInt(m.servings) || 1),
          m.favorite ? 1 : 0, m.usage_count || 0, m.last_used_at || null);
        result.meals.push({ client_id: m.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── Diary (keyed by date, not ID) — only update if client is newer ──
    for (const d of diary) {
      if (!d.date) continue;
      // Check if server has a newer version
      const existingDiary = db.prepare(`SELECT updated_at FROM diary WHERE date = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
        .get(d.date, ...(u != null ? [u] : []));
      if (existingDiary && norm(d.updated_at) < norm(existingDiary.updated_at)) {
        // Server is newer — skip this push (server wins)
        const row = db.prepare(`SELECT id FROM diary WHERE date = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
          .get(d.date, ...(u != null ? [u] : []));
        result.diary.push({ client_id: d.client_id, server_id: row?.id, date: d.date });
        continue;
      }
      if (d.deleted_at) {
        db.prepare(`UPDATE diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE date = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
          .run(d.date, ...(u != null ? [u] : []));
      } else {
        const dNotes = (typeof d.notes === 'string' && d.notes.trim()) ? d.notes : null;
        const itemsJson = JSON.stringify(d.items || []);
        const bsJson = JSON.stringify(d.body_stats || {});
        const waterJson = JSON.stringify(d.water || []);
        if (u == null) {
          // Single-user mode: NULL user_id never collides under SQLite UNIQUE
          // (see diary.js PUT for the same workaround, issue #37).
          const existing = db.prepare(`SELECT id FROM diary WHERE date = ? AND user_id IS NULL`).get(d.date);
          if (existing) {
            db.prepare(`UPDATE diary SET items=?, body_stats=?, water=?, notes=?, updated_at=datetime('now'), deleted_at=NULL WHERE id=?`)
              .run(itemsJson, bsJson, waterJson, dNotes, existing.id);
          } else {
            db.prepare(`INSERT INTO diary (date, items, body_stats, water, notes, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`)
              .run(d.date, itemsJson, bsJson, waterJson, dNotes);
          }
        } else {
          db.prepare(
            `INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(date, user_id) DO UPDATE SET
               items = excluded.items, body_stats = excluded.body_stats, water = excluded.water,
               notes = excluded.notes,
               updated_at = datetime('now'), deleted_at = NULL`
          ).run(u, d.date, itemsJson, bsJson, waterJson, dNotes);
        }
      }
      const row = db.prepare(`SELECT id FROM diary WHERE date = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
        .get(d.date, ...(u != null ? [u] : []));
      result.diary.push({ client_id: d.client_id, server_id: row?.id, date: d.date });
    }

    // ── Activity (keyed by id, mirrors foods/meals upsert pattern) ───────
    for (const a of activity) {
      const existing = a.server_id
        ? db.prepare('SELECT updated_at FROM activity_log WHERE id = ?').get(a.server_id)
        : null;
      if (a.server_id && existing) {
        if (norm(a.updated_at) >= norm(existing.updated_at)) {
          if (a.deleted_at) {
            db.prepare(`UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(a.server_id);
          } else {
            db.prepare(
              `UPDATE activity_log SET name=?, kcal=?, duration_min=?, distance=?, source=?, date=?, updated_at=datetime('now') WHERE id=?`
            ).run(a.name, Math.max(0, Math.round(Number(a.kcal) || 0)),
              a.duration_min != null ? Math.max(0, Math.round(Number(a.duration_min))) : null,
              a.distance != null ? String(a.distance).slice(0, 40) : null,
              a.source || 'manual_form', a.date, a.server_id);
          }
        }
        result.activity.push({ client_id: a.client_id, server_id: a.server_id });
      } else if (!a.deleted_at) {
        const r = db.prepare(
          `INSERT INTO activity_log (user_id, date, name, kcal, duration_min, distance, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(u, a.date, String(a.name || '').slice(0, 80),
          Math.max(0, Math.round(Number(a.kcal) || 0)),
          a.duration_min != null ? Math.max(0, Math.round(Number(a.duration_min))) : null,
          a.distance != null ? String(a.distance).slice(0, 40) : null,
          a.source || 'manual_form');
        result.activity.push({ client_id: a.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── Fasts (intermittent fasting tracker) ─────────────────────────────
    for (const f of fasts) {
      const existing = f.server_id
        ? db.prepare('SELECT updated_at FROM fasts WHERE id = ?').get(f.server_id)
        : null;
      if (f.server_id && existing) {
        if (norm(f.updated_at) >= norm(existing.updated_at)) {
          if (f.deleted_at) {
            db.prepare(`UPDATE fasts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(f.server_id);
          } else {
            db.prepare(
              `UPDATE fasts SET start_at=?, end_at=?, goal_hours=?, notes=?, updated_at=datetime('now') WHERE id=?`
            ).run(f.start_at, f.end_at || null, Number(f.goal_hours) || 16,
              f.notes != null ? String(f.notes).slice(0, 500) : null, f.server_id);
          }
        }
        result.fasts.push({ client_id: f.client_id, server_id: f.server_id });
      } else if (!f.deleted_at) {
        const r = db.prepare(
          `INSERT INTO fasts (user_id, start_at, end_at, goal_hours, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(u, f.start_at, f.end_at || null, Number(f.goal_hours) || 16,
          f.notes != null ? String(f.notes).slice(0, 500) : null);
        result.fasts.push({ client_id: f.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── Wellness (Health Connect, etc — keyed by date+source+metric_type) ─
    // Native-only wellness sources (Health Connect on Android) need to flow
    // up to the server so the web app + other devices can render them.
    // Server-side OAuth sources (Fitbit/Garmin/Withings/Google Health) write
    // their own rows; an incoming row with source='fitbit' from a client is
    // accepted but would just get overwritten by the next server sync, so
    // it's harmless. Keyed by (user_id, date, source, metric_type).
    const wellnessUid = u ?? 0;
    for (const w of wellness) {
      if (!w.date || !w.source || !w.metric_type) continue;
      db.prepare(
        `INSERT INTO wellness_data (user_id, date, source, metric_type, value, metadata, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
           value = excluded.value, metadata = excluded.metadata, synced_at = datetime('now')`
      ).run(wellnessUid, w.date, w.source, w.metric_type,
        w.value == null ? null : Number(w.value),
        typeof w.metadata === 'string' ? w.metadata : JSON.stringify(w.metadata || {}));
      result.wellness.push({ date: w.date, source: w.source, metric_type: w.metric_type });
    }

    // ── Settings (keyed by key, not ID) ──────────────────────────────────
    // SECURITY: server-only keys are rejected — clients can't overwrite admin config.
    if (u != null) {
      for (const s of settings) {
        if (isServerOnlyKey(s.key)) continue; // silently skip; don't tell client what's protected
        if (s.deleted_at) {
          db.prepare(`UPDATE user_settings SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND key = ?`)
            .run(u, s.key);
        } else {
          db.prepare(
            `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), deleted_at = NULL`
          ).run(u, s.key, JSON.stringify(s.value));
        }
        result.settings.push({ key: s.key });
      }
    }
  });

  run();

  logger.debug(`[sync] push: foods=${foods.length} meals=${meals.length} diary=${diary.length} activity=${activity.length} fasts=${fasts.length} wellness=${wellness.length} settings=${settings.length}`);
  res.json({ ok: true, ...result });
}));

export default router;
