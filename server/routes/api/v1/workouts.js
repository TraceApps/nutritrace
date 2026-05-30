/**
 * POST /api/v1/workouts — log a completed workout from a sister TraceApp
 * (currently: LiftTrace) into the user's workout history.
 *
 * Storage: workouts table, source='lifttrace'. Sits alongside Fitbit /
 * Garmin pushed workouts and renders in the same Workout History view in
 * Settings → Wellness. UNIQUE(user_id, source, source_id) handles
 * idempotency — re-posting the same external_id updates that row in
 * place instead of duplicating, so amending a LiftTrace workout
 * propagates here cleanly.
 *
 * TDEE contribution + wearable-overlap rule (per the in-app description
 * in Settings → Wellness → Prefer Wearable Data Over LiftTrace):
 *
 *   After upserting the workouts row, we also roll the day's LiftTrace
 *   calories up into wellness_data as source='lifttrace',
 *   metric_type='calories_out' so the dynamic-TDEE calorie goal lookup
 *   ( /api/wellness/calories-out ) can find it. LT is the lowest
 *   priority in that lookup — wearables win whenever they have data,
 *   and LT only contributes when no wearable does (the natural fill-in
 *   semantic). Users who'd rather have LiftTrace always count, even
 *   when a wearable is present, can flip lifttraceOverlapFill OFF;
 *   that's handled when the cross-source lookup picks which source's
 *   number to return.
 *
 * Wire contract:
 *   {
 *     date:             "YYYY-MM-DD",       // required
 *     name:             "Push day",         // optional, free text
 *     duration_min:     58,                 // optional
 *     calories_burned:  340,                // required, kcal
 *     start_time:       "2026-05-25T17:32:14Z",  // optional ISO 8601
 *     external_id:      "lt:workout:12345"  // required, idempotency key
 *   }
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';

const router = Router();

router.post('/', requireScope('write:workouts'), wrap((req, res) => {
  const { date, name, duration_min, calories_burned, start_time, external_id } = req.body || {};

  // ── Validate ──────────────────────────────────────────────────────────
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD', code: 'bad_date' });
  }
  const kcal = Number(calories_burned);
  if (!Number.isFinite(kcal) || kcal < 0 || kcal > 10000) {
    return res.status(400).json({ error: 'calories_burned must be a number 0..10000', code: 'bad_calories' });
  }
  let durMs = null;
  if (duration_min != null) {
    const d = Number(duration_min);
    if (!Number.isFinite(d) || d < 0 || d > 1440) {
      return res.status(400).json({ error: 'duration_min must be 0..1440', code: 'bad_duration' });
    }
    durMs = Math.round(d * 60_000);
  }
  const extId = String(external_id || '').slice(0, 128);
  if (!extId) {
    return res.status(400).json({ error: 'external_id required for idempotency', code: 'bad_external_id' });
  }
  // start_time is informational — accept any ISO-ish string or leave null.
  const startTime = start_time ? String(start_time).slice(0, 64) : null;

  const userId = req.apiUser.id;
  const activityName = String(name || 'Workout').slice(0, 128);

  // ── Upsert into workouts table ────────────────────────────────────────
  // UNIQUE(user_id, source, source_id) means re-posting the same
  // external_id updates the row instead of duplicating — the natural
  // amend-a-LiftTrace-workout path.
  db.prepare(`
    INSERT INTO workouts (
      user_id, source, source_id, date,
      activity_type, activity_name, start_time, duration_ms, calories,
      has_gps, updated_at
    )
    VALUES (?, 'lifttrace', ?, ?,
            'strength_training', ?, ?, ?, ?,
            0, datetime('now'))
    ON CONFLICT(user_id, source, source_id)
    DO UPDATE SET date          = excluded.date,
                  activity_name = excluded.activity_name,
                  start_time    = excluded.start_time,
                  duration_ms   = excluded.duration_ms,
                  calories      = excluded.calories,
                  updated_at    = excluded.updated_at
  `).run(userId, extId, date, activityName, startTime, durMs, Math.round(kcal));

  const row = db.prepare(`
    SELECT id FROM workouts WHERE user_id = ? AND source = 'lifttrace' AND source_id = ?
  `).get(userId, extId);

  // ── Roll up into wellness_data for the dynamic-TDEE lookup ────────────
  // Sum every LiftTrace workout for this date and upsert as
  // source='lifttrace' / metric_type='calories_out'. The cross-source
  // /api/wellness/calories-out lookup picks LT only when no wearable
  // source has data for the date (or when lifttraceOverlapFill is OFF),
  // so storing the rollup unconditionally is safe — the lookup is what
  // enforces the overlap rule, not the writer.
  const sumRow = db.prepare(`
    SELECT COALESCE(SUM(calories), 0) AS total
      FROM workouts WHERE user_id = ? AND source = 'lifttrace' AND date = ?
  `).get(userId, date);
  const dailyTotal = Math.round(sumRow?.total ?? 0);
  db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, metadata, synced_at)
    VALUES (?, ?, 'lifttrace', 'calories_out', ?, '{}', datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type)
    DO UPDATE SET value = excluded.value, synced_at = excluded.synced_at
  `).run(userId, date, dailyTotal);

  res.json({
    ok: true,
    workout_id: row?.id ?? null,
    date,
    calories_burned: Math.round(kcal),
    daily_total_calories_burned: dailyTotal,
  });
}));

export default router;
