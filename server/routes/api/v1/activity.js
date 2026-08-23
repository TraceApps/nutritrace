/**
 * POST /api/v1/activity — log a manual activity entry into the diary
 * from an external integration (self-hosted trackers, Dropbox → TCX
 * pipelines, Node-RED, Gadgetbridge, etc.).
 *
 * Storage: activity_log table (same table the in-app "Add Activity"
 * sheet writes to). Renders in the diary's Activity section and
 * contributes to the day's kcal-burned tally the same way a manually
 * added activity does.
 *
 * Not to be confused with `POST /api/v1/workouts`, which is a
 * federation endpoint for LiftTrace strength workouts. That path
 * writes to the `workouts` table + rolls into `wellness_data`
 * calories_out for the dynamic-TDEE lookup, and renders under
 * Settings → Wellness → Workout History — NOT the diary. See issue
 * #154 for the difference. Use `/api/v1/workouts` for anything that
 * should feed the dynamic-TDEE calorie goal; use `/api/v1/activity`
 * for anything that should appear as a diary Activity row.
 *
 * Wire contract:
 *   {
 *     date:          "YYYY-MM-DD",        // required
 *     name:          "Bicycle",           // required, free text, <=80 chars
 *     kcal:          270,                 // required, kilocalories burned
 *     duration_min:  40,                  // optional
 *     distance:      "12.4 km",           // optional, free text, <=40 chars
 *     external_id:   "external:workout:<uuid>"  // optional idempotency key
 *   }
 *
 * When `external_id` is present, re-posting the same id updates the
 * existing row in place instead of duplicating. The id is namespaced
 * per user so different integrations can pick their own conventions
 * without collision.
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';

const router = Router();

router.post('/', requireScope('write:activity'), wrap((req, res) => {
  const { date, name, kcal, duration_min, distance, external_id } = req.body || {};

  // ── Validate ─────────────────────────────────────────────────────────
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD', code: 'bad_date' });
  }
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) {
    return res.status(400).json({ error: 'name required', code: 'bad_name' });
  }
  const kcalNum = Number(kcal);
  if (!Number.isFinite(kcalNum) || kcalNum < 0 || kcalNum > 10000) {
    return res.status(400).json({ error: 'kcal must be a number 0..10000', code: 'bad_kcal' });
  }
  let dur = null;
  if (duration_min != null) {
    const d = Number(duration_min);
    if (!Number.isFinite(d) || d < 0 || d > 1440) {
      return res.status(400).json({ error: 'duration_min must be 0..1440', code: 'bad_duration' });
    }
    dur = Math.round(d);
  }
  const cleanDistance = distance != null ? String(distance).trim().slice(0, 40) || null : null;
  const extId = external_id ? String(external_id).slice(0, 128) : null;

  const userId = req.apiUser.id;
  const u = (userId === 0 || userId == null) ? null : userId;
  const roundedKcal = Math.max(0, Math.round(kcalNum));

  // ── Insert or upsert on external_id ──────────────────────────────────
  // Without external_id: plain insert (integration doesn't need
  // idempotency, or callers just want to append). With external_id:
  // look up existing row with the same (user, external_id) namespace
  // and update in place. The namespace key lives in activity_log's
  // `source` column encoded as `external:<id>` — activity_log
  // doesn't have a dedicated external_id column, and adding one for a
  // single caller isn't worth the schema churn.
  const sourceValue = extId ? `external:${extId}` : 'external';

  let existingId = null;
  if (extId) {
    const stmt = u == null
      ? db.prepare(`SELECT id FROM activity_log WHERE user_id IS NULL AND source = ? AND deleted_at IS NULL`)
      : db.prepare(`SELECT id FROM activity_log WHERE user_id = ? AND source = ? AND deleted_at IS NULL`);
    const row = u == null ? stmt.get(sourceValue) : stmt.get(u, sourceValue);
    existingId = row?.id ?? null;
  }

  if (existingId) {
    db.prepare(`
      UPDATE activity_log
         SET date = ?, name = ?, kcal = ?, duration_min = ?, distance = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(date, cleanName, roundedKcal, dur, cleanDistance, existingId);
  } else {
    db.prepare(`
      INSERT INTO activity_log (
        user_id, date, name, kcal, duration_min, distance,
        source, met, is_template, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, datetime('now'), datetime('now'))
    `).run(u, date, cleanName, roundedKcal, dur, cleanDistance, sourceValue);
  }

  const stored = u == null
    ? db.prepare(`SELECT * FROM activity_log WHERE user_id IS NULL AND source = ? AND date = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`).get(sourceValue, date)
    : db.prepare(`SELECT * FROM activity_log WHERE user_id = ? AND source = ? AND date = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`).get(u, sourceValue, date);

  // Report the day's cumulative manual activity kcal so callers can
  // sanity-check their pipeline. Matches the shape of the /workouts
  // response (which reports daily_total_calories_burned for the
  // wellness_data rollup).
  const dailyTotalRow = u == null
    ? db.prepare(`SELECT COALESCE(SUM(kcal), 0) AS total FROM activity_log WHERE user_id IS NULL AND date = ? AND deleted_at IS NULL`).get(date)
    : db.prepare(`SELECT COALESCE(SUM(kcal), 0) AS total FROM activity_log WHERE user_id = ? AND date = ? AND deleted_at IS NULL`).get(u, date);

  res.status(existingId ? 200 : 201).json({
    ok: true,
    activity_id: stored?.id ?? null,
    date,
    kcal: roundedKcal,
    daily_total_kcal: Math.round(dailyTotalRow?.total ?? 0),
    updated: !!existingId,
  });
}));

export default router;
