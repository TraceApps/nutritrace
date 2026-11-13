/**
 * The day's calorie goal as the Diary shows it: Fixed reads the goal (by
 * weekday if it varies), Dynamic uses the day before's calories out from a
 * wearable times the goal factor, Adaptive the learned TDEE times the factor
 * (each falls back to the fixed goal while it has no number yet).
 *
 * A goal snapshot (lib/goal-history.js) states the settings as they were on
 * a past day, and the TDEE is learned from the observations up to that day:
 * a report on an old week gets the target that was in effect then, not one
 * recomputed with today's settings or today's weight trend.
 */
import db from '../db.js';
import { computeAdaptiveTdee } from './adaptive-tdee.js';
import { dayTargets } from '../../src/lib/goal-resolver.js';

function _setting(userId, key, fallback) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL').get(userId, key);
  if (!row || row.value == null) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

/**
 * Calories out from a wearable (or LiftTrace) for the day before `date`.
 * `overlapFill` states which source wins when a snapshot is read; without
 * it the person's setting decides, as the Diary does today.
 */
export function caloriesOutFor(userId, date, { overlapFill = null } = {}) {
  const base = date ? new Date(date + 'T12:00:00Z') : new Date();
  base.setUTCDate(base.getUTCDate() - 1);
  const yesterday = base.toISOString().slice(0, 10);
  // Wearables provide true daily TDEE (BMR + activity). LiftTrace is a
  // per-workout slice, so it's the lowest priority unless the person said
  // otherwise (lifttraceOverlapFill off: LiftTrace wins).
  const fill = overlapFill == null ? _setting(userId, 'lifttraceOverlapFill', true) !== false : overlapFill !== false;
  const PRIORITY = fill
    ? ['garmin', 'health_connect', 'fitbit', 'lifttrace']
    : ['lifttrace', 'garmin', 'health_connect', 'fitbit'];
  const rows = db.prepare(`SELECT source, value FROM wellness_data WHERE user_id = ? AND date = ? AND metric_type = 'calories_out'`).all(userId, yesterday);
  for (const src of PRIORITY) {
    const row = rows.find(r => r.source === src);
    if (row) return { calories_out: row.value, source: src, date: yesterday };
  }
  return { calories_out: null, source: null, date: yesterday };
}

/**
 * { calories, mode, basis } for that day; calories null when there is no
 * goal at all. `basis` says where a Dynamic or Adaptive number came from,
 * or that it fell back to the fixed goal.
 */
export function effectiveCalorieGoal(userId, date, goals, snapshot = null) {
  const mode = (snapshot ? snapshot.calorie_goal_mode : _setting(userId, 'calorieGoalMode', 'fixed')) || 'fixed';
  const factor = Number(snapshot ? snapshot.calorie_goal_factor : _setting(userId, 'calorieGoalFactor', 1)) || 1;
  const fixed = () => dayTargets(goals, date).calories;
  if (mode === 'dynamic') {
    const co = caloriesOutFor(userId, date, snapshot ? { overlapFill: snapshot.lifttrace_overlap_fill } : {});
    if (co.calories_out != null) {
      return {
        calories: Math.round(co.calories_out * factor),
        mode,
        basis: {
          mode,
          calories_out: co.calories_out,
          calories_out_date: co.date,
          calories_out_source: co.source,
          factor,
        },
      };
    }
    return { calories: fixed(), mode, basis: { mode, fallback: 'fixed', factor } };
  }
  if (mode === 'adaptive') {
    try {
      const a = computeAdaptiveTdee(userId, snapshot ? { endDate: date } : {});
      if (a?.ready && a.tdee) {
        return {
          calories: Math.round(a.tdee * factor),
          mode,
          basis: { mode, tdee: a.tdee, factor, days_available: a.daysAvailable, confidence: a.confidence },
        };
      }
      return {
        calories: fixed(),
        mode,
        basis: { mode, fallback: 'fixed', factor, days_available: a?.daysAvailable, days_required: a?.daysRequired },
      };
    } catch { /* not enough data */ }
  }
  return {
    calories: fixed(),
    mode,
    basis: mode === 'fixed' ? { mode } : { mode, fallback: 'fixed', factor },
  };
}
