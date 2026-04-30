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

  const foods = db.prepare(
    `SELECT * FROM foods WHERE updated_at > ? ${userFilter} ORDER BY updated_at`
  ).all(...params).map(parse);

  const meals = db.prepare(
    `SELECT * FROM meals WHERE updated_at > ? ${userFilter} ORDER BY updated_at`
  ).all(...params).map(parse);

  const diary = db.prepare(
    `SELECT * FROM diary WHERE updated_at > ? ${userFilter} ORDER BY updated_at`
  ).all(...params).map(parseDiary);

  const settings = u != null
    ? db.prepare('SELECT * FROM user_settings WHERE updated_at > ? AND user_id = ? ORDER BY updated_at').all(sinceSql, u)
        .filter(s => !isServerOnlyKey(s.key)) // SECURITY: never push admin keys to clients
    : [];

  // Wellness data — pull only (server-generated from Fitbit/Withings/Garmin syncs)
  const wellnessParams = u != null ? [sinceSql, u] : [sinceSql];
  const wellness = db.prepare(
    `SELECT * FROM wellness_data WHERE synced_at > ? ${u != null ? 'AND user_id = ?' : ''} ORDER BY synced_at`
  ).all(...wellnessParams).map(parse);

  // Workouts — pull only (server-generated from Fitbit activity log syncs)
  const workoutsParams = u != null ? [sinceSql, u] : [sinceSql];
  const workouts = db.prepare(
    `SELECT * FROM workouts WHERE updated_at > ? ${u != null ? 'AND user_id = ?' : ''} ORDER BY updated_at`
  ).all(...workoutsParams).map(parse);

  // AI chat history — pull only (client posts via /api/ai/history directly)
  const chatParams = u != null ? [sinceSql, u] : [sinceSql];
  const chat_history = db.prepare(
    `SELECT id, role, content, created_at FROM ai_chat_history WHERE created_at > ? ${u != null ? 'AND user_id = ?' : 'AND user_id IS NULL'} ORDER BY created_at`
  ).all(...chatParams);

  // Activity log — server-side updates pulled to clients
  const activityParams = u != null ? [sinceSql, u] : [sinceSql];
  const activity = db.prepare(
    `SELECT * FROM activity_log WHERE updated_at > ? ${u != null ? 'AND user_id = ?' : 'AND user_id IS NULL'} ORDER BY updated_at`
  ).all(...activityParams);

  logger.debug(`[sync] pull since=${sinceSql}: foods=${foods.length} meals=${meals.length} diary=${diary.length} activity=${activity.length} settings=${settings.length} wellness=${wellness.length} workouts=${workouts.length} chat=${chat_history.length}`);

  res.json({ foods, meals, diary, activity, settings, wellness, workouts, chat_history, server_time: serverTime });
}));

// ── POST /push ───────────────────────────────────────────────────────────────
// Receives batch of changed records from the client.
// Each record has: client_id, server_id (if previously synced), and the data fields.
// Returns a mapping of client_id → server_id for newly created records.
router.post('/push', wrap((req, res) => {
  const u = uid(req);
  const { foods = [], meals = [], diary = [], activity = [], settings = [] } = req.body;
  const result = { foods: [], meals: [], diary: [], activity: [], settings: [] };

  // Normalize timestamp for comparison (strip T, Z, milliseconds)
  const norm = ts => ts ? ts.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '') : '';

  const run = db.transaction(() => {
    // ── Foods ────────────────────────────────────────────────────────────
    for (const f of foods) {
      if (f.server_id) {
        // Update existing — last-write-wins
        const existing = db.prepare('SELECT updated_at FROM foods WHERE id = ?').get(f.server_id);
        if (existing && norm(f.updated_at) >= norm(existing.updated_at)) {
          if (f.deleted_at) {
            db.prepare(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(f.server_id);
          } else {
            db.prepare(
              `UPDATE foods SET name=?, brand=?, nutrition=?, portion=?, unit=?, img_url=?, notes=?, category=?, barcode=?, updated_at=datetime('now') WHERE id=?`
            ).run(f.name, f.brand, JSON.stringify(f.nutrition || {}), f.portion ?? 100, f.unit || 'g',
              f.img_url || null, f.notes || null, f.category || null, f.barcode || null, f.server_id);
          }
        }
        result.foods.push({ client_id: f.client_id, server_id: f.server_id });
      } else if (!f.deleted_at) {
        // New record
        const r = db.prepare(
          `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(u, f.name, f.brand || null, JSON.stringify(f.nutrition || {}), f.portion ?? 100, f.unit || 'g',
          f.img_url || null, f.notes || null, f.category || null, f.barcode || null);
        result.foods.push({ client_id: f.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── Meals ────────────────────────────────────────────────────────────
    for (const m of meals) {
      if (m.server_id) {
        const existing = db.prepare('SELECT updated_at FROM meals WHERE id = ?').get(m.server_id);
        if (existing && norm(m.updated_at) >= norm(existing.updated_at)) {
          if (m.deleted_at) {
            db.prepare(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(m.server_id);
          } else {
            db.prepare(
              `UPDATE meals SET name=?, nutrition=?, items=?, img_url=?, notes=?, is_recipe=?, portion=?, unit=?, updated_at=datetime('now') WHERE id=?`
            ).run(m.name, JSON.stringify(m.nutrition || {}), JSON.stringify(m.items || []),
              m.img_url || null, m.notes || null, m.is_recipe ? 1 : 0, m.portion ?? 100, m.unit || 'g', m.server_id);
          }
        }
        result.meals.push({ client_id: m.client_id, server_id: m.server_id });
      } else if (!m.deleted_at) {
        const r = db.prepare(
          `INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(u, m.name, JSON.stringify(m.nutrition || {}), JSON.stringify(m.items || []),
          m.img_url || null, m.notes || null, m.is_recipe ? 1 : 0, m.portion ?? 100, m.unit || 'g');
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
        db.prepare(
          `INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(date, user_id) DO UPDATE SET
             items = excluded.items, body_stats = excluded.body_stats, water = excluded.water,
             notes = excluded.notes,
             updated_at = datetime('now'), deleted_at = NULL`
        ).run(u, d.date, JSON.stringify(d.items || []), JSON.stringify(d.body_stats || {}), JSON.stringify(d.water || []), dNotes);
      }
      const row = db.prepare(`SELECT id FROM diary WHERE date = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
        .get(d.date, ...(u != null ? [u] : []));
      result.diary.push({ client_id: d.client_id, server_id: row?.id, date: d.date });
    }

    // ── Activity (keyed by id, mirrors foods/meals upsert pattern) ───────
    for (const a of activity) {
      if (a.server_id) {
        const existing = db.prepare('SELECT updated_at FROM activity_log WHERE id = ?').get(a.server_id);
        if (existing && norm(a.updated_at) >= norm(existing.updated_at)) {
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

  logger.debug(`[sync] push: foods=${foods.length} meals=${meals.length} diary=${diary.length} activity=${activity.length} settings=${settings.length}`);
  res.json({ ok: true, ...result });
}));

export default router;
