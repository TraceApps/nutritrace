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
import { resolveNewItemVisibility } from '../lib/default-visibility.js';
import { isServerOnlyKey } from '../lib/server-only-keys.js';
import { localizeImage, isExternalUrl } from '../lib/image-localizer.js';
import { mirrorWeightToBodyStats } from '../lib/wellness-mirror.js';

// #199 (@tellis82): the POST /api/foods and POST /api/meals routes
// localize incoming data URLs to /uploads/ (via image-localizer). This
// sync-push handler wrote img_url verbatim, so an offline-created food
// with a camera photo (a data URL under isNative) landed in the img_url
// column raw. That fed the freshenItemImages 50 MB payload amplifier
// on the diary side. Same rule as the direct routes: if the caller
// sent an external URL (http/https or data:), route it through
// localizeImage; if it's already a local /uploads/ path, keep as-is.
async function _localizeIfNeeded(url) {
  if (!url) return null;
  return isExternalUrl(url) ? await localizeImage(url) : url;
}

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user?.id : null;

// Load prior tombstone uuids for a user+date+kind (item or water). Used by
// the diary merge in both /push (below) and /pull (to inline tombstones on
// the response). Duplicated intentionally from routes/diary.js — moving to
// a shared helper is a follow-up cleanup, not worth the churn today.
function _loadTombstoneUuids(u, date, kind) {
  const where = u == null ? 'user_id IS NULL' : 'user_id = ?';
  const stmt = db.prepare(`SELECT uuid FROM diary_tombstones WHERE ${where} AND date = ? AND kind = ?`);
  const rows = u == null ? stmt.all(date, kind) : stmt.all(u, date, kind);
  return rows.map(r => r.uuid);
}
function _loadTombstonesSince(u, sinceSql) {
  const where = u == null ? 'user_id IS NULL' : 'user_id = ?';
  const stmt = db.prepare(`SELECT date, kind, uuid, deleted_at FROM diary_tombstones WHERE ${where} AND deleted_at >= ? ORDER BY deleted_at`);
  return u == null ? stmt.all(sinceSql) : stmt.all(u, sinceSql);
}

import { freshenItemImages, hydrateItems } from '../lib/diary-helpers.js';
import { mergeEntries, ensureUuids } from '../lib/diary-merge.js';

// Issues #69 + #70: normalize alt_units before storing. Accepts null /
// already-serialized string / array of {abbr, grams}. Filters malformed
// entries so a junk row from a misbehaving client can't break the column.
function _serializeAltUnitsForServer(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const clean = v
    .filter(r => r && typeof r === 'object')
    .map(r => ({
      abbr: String(r.abbr || '').trim(),
      grams: Number(r.grams),
    }))
    .filter(r => r.abbr && Number.isFinite(r.grams) && r.grams > 0);
  return clean.length ? JSON.stringify(clean) : null;
}

function parse(row) {
  if (!row) return null;
  for (const key of ['nutrition', 'items', 'body_stats', 'water', 'metadata', 'alt_units']) {
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
    parsed.items = freshenItemImages(hydrateItems(parsed.items));
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

  // Per-item deletion tombstones since the same `since` boundary. Clients
  // apply these to their local mirror so an item deleted on device A stops
  // showing on device B on the next pull. See lib/diary-merge.js for the
  // shape (kind='item'|'water', uuid, date, deleted_at).
  const diary_tombstones = _loadTombstonesSince(u, sinceSql);

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

  logger.debug(`[sync] pull since=${sinceSql}: foods=${foods.length} meals=${meals.length} diary=${diary.length} activity=${activity.length} fasts=${fasts.length} settings=${settings.length} wellness=${wellness.length} workouts=${workouts.length} chat=${chat_history.length} diary_tombstones=${diary_tombstones.length}`);

  res.json({ foods, meals, diary, diary_tombstones, activity, fasts, settings, wellness, workouts, chat_history, server_time: serverTime });
}));

// ── POST /push ───────────────────────────────────────────────────────────────
// Receives batch of changed records from the client.
// Each record has: client_id, server_id (if previously synced), and the data fields.
// Returns a mapping of client_id → server_id for newly created records.
router.post('/push', wrap(async (req, res) => {
  const u = uid(req);
  const { foods = [], meals = [], diary = [], activity = [], fasts = [], wellness = [], settings = [], workouts = [] } = req.body;
  const result = { foods: [], meals: [], diary: [], activity: [], fasts: [], wellness: [], settings: [], workouts: [] };

  // #199 (@tellis82): localize any inbound img_url data URLs to
  // /uploads/ files before the sync transaction. Direct POST /api/foods
  // and /api/meals already do this via image-localizer; the sync path
  // was writing them verbatim, so a native user's camera-photo food
  // landed in the img_url column as a base64 blob and was then
  // amplified across every referencing diary row by freshenItemImages.
  // Runs outside the transaction because localizeImage does file IO
  // and db.transaction() is sync-only.
  for (const f of foods) {
    if (f.img_url) f.img_url = await _localizeIfNeeded(f.img_url);
  }
  for (const m of meals) {
    if (m.img_url) m.img_url = await _localizeIfNeeded(m.img_url);
  }

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
              `UPDATE foods SET name=?, brand=?, nutrition=?, portion=?, unit=?, img_url=?, notes=?, category=?, barcode=?, favorite=?, usage_count=MAX(usage_count, ?), last_used_at=MAX(COALESCE(last_used_at, ''), COALESCE(?, '')), nutrition_basis=?, alt_units=?, density_g_ml=?, updated_at=datetime('now') WHERE id=?`
            ).run(f.name, f.brand, JSON.stringify(f.nutrition || {}), f.portion ?? 100, f.unit || 'g',
              f.img_url || null, f.notes || null, f.category || null, f.barcode || null,
              f.favorite ? 1 : 0, f.usage_count || 0, f.last_used_at || null,
              // Issues #69 + #70: OFF unit metadata. Clients that don't send
              // these keys yet get null, which preserves existing behavior.
              f.nutrition_basis || null,
              _serializeAltUnitsForServer(f.alt_units),
              f.density_g_ml != null && Number.isFinite(Number(f.density_g_ml))
                ? Number(f.density_g_ml)
                : null,
              f.server_id);
          }
        }
        result.foods.push({ client_id: f.client_id, server_id: f.server_id });
      } else if (!f.deleted_at) {
        // New record (no server_id, OR server_id refs missing row → re-create).
        // #183 — honor caller's defaultShareVisibility on new inserts,
        // matching POST /api/foods. The sync path had been relying on
        // the SQLite column default ('private'), which silently made
        // the toggle a no-op for anything created offline first.
        const vis = resolveNewItemVisibility(u);
        const r = db.prepare(
          `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, favorite, usage_count, last_used_at, nutrition_basis, alt_units, density_g_ml, visibility, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(u, f.name, f.brand || null, JSON.stringify(f.nutrition || {}), f.portion ?? 100, f.unit || 'g',
          f.img_url || null, f.notes || null, f.category || null, f.barcode || null,
          f.favorite ? 1 : 0, f.usage_count || 0, f.last_used_at || null,
          f.nutrition_basis || null,
          _serializeAltUnitsForServer(f.alt_units),
          f.density_g_ml != null && Number.isFinite(Number(f.density_g_ml))
            ? Number(f.density_g_ml)
            : null,
          vis);
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
        // #183 — same default-visibility handling as the foods branch.
        // Applies to both meals and recipes (is_recipe distinguishes them
        // but shares the same default).
        const vis = resolveNewItemVisibility(u);
        const r = db.prepare(
          `INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, is_recipe, portion, unit, servings, favorite, usage_count, last_used_at, visibility, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(u, m.name, JSON.stringify(m.nutrition || {}), JSON.stringify(m.items || []),
          m.img_url || null, m.notes || null, m.is_recipe ? 1 : 0, m.portion ?? 100, m.unit || 'g',
          Math.max(1, parseInt(m.servings) || 1),
          m.favorite ? 1 : 0, m.usage_count || 0, m.last_used_at || null,
          vis);
        result.meals.push({ client_id: m.client_id, server_id: r.lastInsertRowid });
      }
    }

    // ── Diary (keyed by date, not ID) ────────────────────────────────────
    //
    // Merge semantics (Option C, 2026-08-11): items and water use per-uuid
    // merge via lib/diary-merge. Prior implementation replaced items/water
    // wholesale, letting a stale mobile client wipe the day on push. See
    // project_nutritrace_diary_persist_gap for the 2026-07-23 and 2026-08-11
    // incidents. body_stats keeps its ad-hoc empty-guard (issue #81);
    // day-level soft delete still uses whole-row deleted_at.
    for (const d of diary) {
      if (!d.date) continue;
      if (d.deleted_at) {
        db.prepare(`UPDATE diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE date = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
          .run(d.date, ...(u != null ? [u] : []));
      } else {
        const dNotes = (typeof d.notes === 'string' && d.notes.trim()) ? d.notes : null;
        const existingRow = u == null
          ? db.prepare(`SELECT * FROM diary WHERE date = ? AND user_id IS NULL`).get(d.date)
          : db.prepare(`SELECT * FROM diary WHERE date = ? AND user_id = ?`).get(d.date, u);

        // Parse client-sent deletions in either shape (per-kind object or
        // legacy flat array = items).
        const deletedRaw = d.deleted_uuids;
        const deletedItemUuids = Array.isArray(deletedRaw?.items) ? deletedRaw.items
          : Array.isArray(deletedRaw) ? deletedRaw
          : [];
        const deletedWaterUuids = Array.isArray(deletedRaw?.water) ? deletedRaw.water : [];

        // Prior tombstones for this date/user.
        const priorItemTombstones = _loadTombstoneUuids(u, d.date, 'item');
        const priorWaterTombstones = _loadTombstoneUuids(u, d.date, 'water');

        // Server state → merge with client state.
        const serverItems = existingRow ? JSON.parse(existingRow.items || '[]') : [];
        const serverWater = existingRow ? JSON.parse(existingRow.water || '[]') : [];
        const { merged: mergedItems, newTombstoneUuids: newItemTombstones } =
          mergeEntries(serverItems, ensureUuids(d.items || []), deletedItemUuids, priorItemTombstones);
        const { merged: mergedWater, newTombstoneUuids: newWaterTombstones } =
          mergeEntries(serverWater, ensureUuids(d.water || []), deletedWaterUuids, priorWaterTombstones);

        // body_stats: last-writer-wins with the issue-#81 empty guard.
        const incomingBsEmpty = !d.body_stats || (typeof d.body_stats === 'object' && Object.keys(d.body_stats).length === 0);
        let existingBsHasKeys = false;
        if (existingRow && existingRow.body_stats) {
          try { existingBsHasKeys = Object.keys(JSON.parse(existingRow.body_stats) || {}).length > 0; } catch {}
        }
        const bsJson = (incomingBsEmpty && existingBsHasKeys)
          ? existingRow.body_stats
          : JSON.stringify(d.body_stats || {});

        const itemsJson = JSON.stringify(mergedItems);
        const waterJson = JSON.stringify(mergedWater);

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

        // Persist new tombstones idempotently.
        const insertTombstone = db.prepare(
          `INSERT OR IGNORE INTO diary_tombstones (user_id, date, kind, uuid, deleted_at)
           VALUES (?, ?, ?, ?, datetime('now'))`
        );
        for (const uuid of newItemTombstones) insertTombstone.run(u, d.date, 'item', uuid);
        for (const uuid of newWaterTombstones) insertTombstone.run(u, d.date, 'water', uuid);
      }
      const row = db.prepare(`SELECT id FROM diary WHERE date = ? AND user_id ${u != null ? '= ?' : 'IS NULL'}`)
        .get(d.date, ...(u != null ? [u] : []));
      result.diary.push({ client_id: d.client_id, server_id: row?.id, date: d.date });
    }

    // ── Activity (keyed by id, mirrors foods/meals upsert pattern) ───────
    // met + is_template threaded through so compendium picks and saved
    // templates round-trip across devices without loss. #77.
    for (const a of activity) {
      const metVal = (a.met != null && Number.isFinite(Number(a.met)))
        ? Math.max(0, Math.min(25, Number(a.met))) : null;
      const isTplVal = a.is_template ? 1 : 0;
      const existing = a.server_id
        ? db.prepare('SELECT updated_at FROM activity_log WHERE id = ?').get(a.server_id)
        : null;
      if (a.server_id && existing) {
        if (norm(a.updated_at) >= norm(existing.updated_at)) {
          if (a.deleted_at) {
            db.prepare(`UPDATE activity_log SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(a.server_id);
          } else {
            db.prepare(
              `UPDATE activity_log SET name=?, kcal=?, duration_min=?, distance=?, source=?, met=?, is_template=?, date=?, updated_at=datetime('now') WHERE id=?`
            ).run(a.name, Math.max(0, Math.round(Number(a.kcal) || 0)),
              a.duration_min != null ? Math.max(0, Math.round(Number(a.duration_min))) : null,
              a.distance != null ? String(a.distance).slice(0, 40) : null,
              a.source || 'manual_form', metVal, isTplVal, a.date, a.server_id);
          }
        }
        result.activity.push({ client_id: a.client_id, server_id: a.server_id });
      } else if (!a.deleted_at) {
        const r = db.prepare(
          `INSERT INTO activity_log (user_id, date, name, kcal, duration_min, distance, source, met, is_template, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(u, a.date, String(a.name || '').slice(0, 80),
          Math.max(0, Math.round(Number(a.kcal) || 0)),
          a.duration_min != null ? Math.max(0, Math.round(Number(a.duration_min))) : null,
          a.distance != null ? String(a.distance).slice(0, 40) : null,
          a.source || 'manual_form', metVal, isTplVal);
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
      // #200: mirror weight readings into diary body_stats when the
      // per-user toggle is on. Pass the resolved diary uid (u), not the
      // wellness sentinel (wellnessUid=0 for anonymous) — the mirror
      // helper is a no-op for single-user mode anyway, but keeping the
      // two identifiers separate here matches the diary route's own
      // "IS NULL vs = uid" convention.
      if (w.metric_type === 'weight_kg' && w.value != null) {
        mirrorWeightToBodyStats(u, w.date, Number(w.value));
      }
    }

    // ── Workouts (client-authored, e.g. Health Connect ExerciseSession) ──
    // Keyed by (user_id, source, source_id). Client-authored workouts come
    // from the Android app's Health Connect integration (source='health_connect').
    // Fitbit / Garmin / Google Health workouts land here too if a future client
    // ever pushes them, but today those live entirely server-side via the
    // OAuth-driven sync path in fitbit.js / google-health.js.
    //
    // Handles both new inserts (no server_id) and upserts against an existing
    // (user_id, source, source_id) key. Fitbit's dedup pass at
    // server/routes/fitbit.js:842-869 keys on date+start_time+activity_name so
    // it won't touch health_connect-source rows — Fitbit users who also grant
    // HC exercise permission will see one workout per source, which matches
    // how Fitbit+Google-Health already behave today. Cross-source dedup is a
    // separate follow-up (issue #91 audit calls it out).
    const workoutUid = u ?? 0;
    for (const w of workouts) {
      if (!w.source || !w.source_id || !w.date) continue;
      const r = db.prepare(
        `INSERT INTO workouts (user_id, source, source_id, date, activity_type, activity_name, start_time, duration_ms, distance_km, calories, avg_hr, max_hr, steps, has_gps, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, source, source_id) DO UPDATE SET
           date          = excluded.date,
           activity_type = excluded.activity_type,
           activity_name = excluded.activity_name,
           start_time    = excluded.start_time,
           duration_ms   = excluded.duration_ms,
           distance_km   = excluded.distance_km,
           calories      = excluded.calories,
           avg_hr        = excluded.avg_hr,
           max_hr        = excluded.max_hr,
           steps         = excluded.steps,
           has_gps       = MAX(has_gps, excluded.has_gps),
           updated_at    = datetime('now')`
      ).run(workoutUid, w.source, String(w.source_id), w.date,
        w.activity_type || null, w.activity_name || null, w.start_time || null,
        w.duration_ms != null ? Math.round(Number(w.duration_ms)) : null,
        w.distance_km != null ? Number(w.distance_km) : null,
        w.calories != null ? Math.round(Number(w.calories)) : null,
        w.avg_hr != null ? Math.round(Number(w.avg_hr)) : null,
        w.max_hr != null ? Math.round(Number(w.max_hr)) : null,
        w.steps != null ? Math.round(Number(w.steps)) : null,
        w.has_gps ? 1 : 0);
      // Resolve the server-side row id whether we inserted or upserted.
      const existing = db.prepare(
        `SELECT id FROM workouts WHERE user_id = ? AND source = ? AND source_id = ?`
      ).get(workoutUid, w.source, String(w.source_id));
      result.workouts.push({ client_id: w.client_id, server_id: existing?.id ?? r.lastInsertRowid });
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

  logger.debug(`[sync] push: foods=${foods.length} meals=${meals.length} diary=${diary.length} activity=${activity.length} fasts=${fasts.length} wellness=${wellness.length} settings=${settings.length} workouts=${workouts.length}`);
  res.json({ ok: true, ...result });
}));

export default router;
