/**
 * The day's calorie goal as the Diary shows it: Fixed reads the goal (by
 * weekday if it varies), Dynamic uses the day before's calories out from a
 * wearable times the goal factor, Adaptive the learned TDEE times the factor
 * (each falls back to the fixed goal while it has no number yet).
 */
import db from '../db.js';
import { computeAdaptiveTdee } from './adaptive-tdee.js';
import { dayTargets } from '../../src/lib/goal-resolver.js';

function _setting(userId, key, fallback) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL').get(userId, key);
  if (!row || row.value == null) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

/** Calories out from a wearable (or LiftTrace) for the day before `date`. */
export function caloriesOutFor(userId, date) {
  const base = date ? new Date(date + 'T12:00:00Z') : new Date();
  base.setUTCDate(base.getUTCDate() - 1);
  const yesterday = base.toISOString().slice(0, 10);
  // Wearables provide true daily TDEE (BMR + activity). LiftTrace is a
  // per-workout slice, so it's the lowest priority unless the person said
  // otherwise (lifttraceOverlapFill off: LiftTrace wins).
  const overlapFill = _setting(userId, 'lifttraceOverlapFill', true) !== false;
  const PRIORITY = overlapFill
    ? ['garmin', 'health_connect', 'fitbit', 'lifttrace']
    : ['lifttrace', 'garmin', 'health_connect', 'fitbit'];
  const rows = db.prepare(`SELECT source, value FROM wellness_data WHERE user_id = ? AND date = ? AND metric_type = 'calories_out'`).all(userId, yesterday);
  for (const src of PRIORITY) {
    const row = rows.find(r => r.source === src);
    if (row) return { calories_out: row.value, source: src, date: yesterday };
  }
  return { calories_out: null, source: null, date: yesterday };
}

/** { calories, mode } for that day; calories null when there is no goal. */
export function effectiveCalorieGoal(userId, date, goals) {
  const mode = _setting(userId, 'calorieGoalMode', 'fixed') || 'fixed';
  const factor = Number(_setting(userId, 'calorieGoalFactor', 1)) || 1;
  if (mode === 'dynamic') {
    const co = caloriesOutFor(userId, date).calories_out;
    if (co != null) return { calories: Math.round(co * factor), mode };
  } else if (mode === 'adaptive') {
    try {
      const a = computeAdaptiveTdee(userId);
      if (a?.ready && a.tdee) return { calories: Math.round(a.tdee * factor), mode };
    } catch { /* not enough data */ }
  }
  return { calories: dayTargets(goals, date).calories, mode };
}
