import db from '../db.js';
import { computeAdaptiveTdee } from './adaptive-tdee.js';
import { effectiveActiveCalories } from './active-calories.js';

export const GOAL_HISTORY_SETTING_KEYS = new Set([
  'goals',
  'waterGoalMl',
  'calorieGoalMode',
  'calorieGoalFactor',
  'calorieAdjustFromActivity',
  'diaryShowActivity',
  'manualActivityPolicy',
  'lifttraceOverlapFill',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MACRO_DENSITY = { proteins: 4, carbohydrates: 4, fat: 9 };

function _safeJson(value, fallback) {
  if (value == null) return fallback;
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { return fallback; }
}

export function isGoalHistoryDate(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function currentGoalSnapshot(userId) {
  const rows = db.prepare(
    `SELECT key, value FROM user_settings
      WHERE user_id = ? AND deleted_at IS NULL
        AND key IN ('goals','waterGoalMl','calorieGoalMode','calorieGoalFactor',
                    'calorieAdjustFromActivity','diaryShowActivity','manualActivityPolicy','lifttraceOverlapFill')`
  ).all(userId);
  const values = new Map(rows.map(r => [r.key, _safeJson(r.value, null)]));
  const waterRaw = values.get('waterGoalMl');
  const factorRaw = Number(values.get('calorieGoalFactor'));
  return {
    goals: values.get('goals') && typeof values.get('goals') === 'object' ? values.get('goals') : {},
    water_goal_ml: typeof waterRaw === 'number' && Number.isFinite(waterRaw) ? waterRaw : 2000,
    calorie_goal_mode: ['fixed', 'dynamic', 'adaptive'].includes(values.get('calorieGoalMode'))
      ? values.get('calorieGoalMode') : 'fixed',
    calorie_goal_factor: Number.isFinite(factorRaw) && factorRaw > 0 ? factorRaw : 1,
    calorie_adjust_from_activity: values.get('calorieAdjustFromActivity') === true,
    diary_show_activity: values.get('diaryShowActivity') === true,
    manual_activity_policy: ['wearable_wins', 'manual_wins', 'additive'].includes(values.get('manualActivityPolicy'))
      ? values.get('manualActivityPolicy') : 'wearable_wins',
    lifttrace_overlap_fill: values.get('lifttraceOverlapFill') !== false,
  };
}

export function captureGoalSnapshot(userId, {
  effectiveDate,
  changedAt = new Date().toISOString(),
  source = 'server',
  snapshot = null,
} = {}) {
  if (!isGoalHistoryDate(effectiveDate)) {
    throw new Error(`Invalid effective date '${effectiveDate}'; expected YYYY-MM-DD.`);
  }
  const changed = Number.isFinite(Date.parse(changedAt)) ? new Date(changedAt).toISOString() : new Date().toISOString();
  const value = snapshot || currentGoalSnapshot(userId);
  db.prepare(
    `INSERT INTO goal_history (user_id, effective_date, snapshot, changed_at, updated_at, source)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, effective_date) DO UPDATE SET
       snapshot = excluded.snapshot,
       changed_at = excluded.changed_at,
       updated_at = datetime('now'),
       source = excluded.source
     WHERE excluded.changed_at >= goal_history.changed_at`
  ).run(userId, effectiveDate, JSON.stringify(value), changed, source);
  return { effective_date: effectiveDate, changed_at: changed, snapshot: value, source };
}

export function firstGoalHistoryDate(userId) {
  return db.prepare(
    `SELECT MIN(effective_date) AS d FROM goal_history WHERE user_id = ?`
  ).get(userId)?.d || null;
}

export function readGoalSnapshotForDate(userId, date) {
  if (!isGoalHistoryDate(date)) throw new Error(`Invalid date '${date}'; expected YYYY-MM-DD.`);
  const row = db.prepare(
    `SELECT effective_date, snapshot, changed_at, source
       FROM goal_history
      WHERE user_id = ? AND effective_date <= ?
      ORDER BY effective_date DESC
      LIMIT 1`
  ).get(userId, date);
  if (!row) return null;
  return {
    effective_from: row.effective_date,
    snapshot: _safeJson(row.snapshot, {}),
    changed_at: row.changed_at,
    source: row.source || 'unknown',
  };
}

function _resolveGoalValue(goal, date) {
  if (!goal || typeof goal !== 'object') return null;
  if (goal.sharedGoal !== false) return goal.max ?? goal.min ?? null;
  if (Array.isArray(goal.days) && goal.days.length >= 7) {
    const day = new Date(date + 'T12:00:00Z').getUTCDay();
    const value = goal.days[day];
    if (value != null && Number.isFinite(Number(value))) return Number(value);
  }
  return goal.max ?? goal.min ?? null;
}

function _previousDate(date) {
  const dt = new Date(date + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function _dynamicCaloriesOut(userId, date, overlapFill) {
  const burnDate = _previousDate(date);
  const priority = overlapFill
    ? ['garmin', 'health_connect', 'fitbit', 'lifttrace']
    : ['lifttrace', 'garmin', 'health_connect', 'fitbit'];
  const rows = db.prepare(
    `SELECT source, value FROM wellness_data
      WHERE user_id = ? AND date = ? AND metric_type = 'calories_out'`
  ).all(userId, burnDate);
  for (const source of priority) {
    const row = rows.find(r => r.source === source);
    if (row && Number.isFinite(Number(row.value))) {
      return { calories_out: Number(row.value), source, date: burnDate };
    }
  }
  return { calories_out: null, source: null, date: burnDate };
}

export function resolveGoalSnapshot(userId, date, snapshot) {
  const goals = snapshot?.goals && typeof snapshot.goals === 'object' ? snapshot.goals : {};
  const fixed = Number(_resolveGoalValue(goals.calories, date));
  const fixedCalories = Number.isFinite(fixed) && fixed > 0 ? fixed : 2000;
  const mode = snapshot?.calorie_goal_mode || 'fixed';
  const factor = Number(snapshot?.calorie_goal_factor);
  const goalFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;

  let calories = fixedCalories;
  let basis = { mode: 'fixed', base_kcal: fixedCalories };

  if (mode === 'dynamic') {
    const burn = _dynamicCaloriesOut(userId, date, snapshot?.lifttrace_overlap_fill !== false);
    if (burn.calories_out != null) {
      calories = Math.round(burn.calories_out * goalFactor);
      basis = {
        mode: 'dynamic',
        calories_out: burn.calories_out,
        calories_out_date: burn.date,
        calories_out_source: burn.source,
        factor: goalFactor,
      };
    } else {
      basis = { mode: 'dynamic', fallback: 'fixed', base_kcal: fixedCalories, factor: goalFactor };
    }
  } else if (mode === 'adaptive') {
    const adaptive = computeAdaptiveTdee(userId, { endDate: date });
    if (adaptive.ready && adaptive.tdee != null) {
      calories = Math.round(Number(adaptive.tdee) * goalFactor);
      basis = {
        mode: 'adaptive',
        tdee: adaptive.tdee,
        factor: goalFactor,
        days_available: adaptive.daysAvailable,
        confidence: adaptive.confidence,
      };
    } else {
      basis = {
        mode: 'adaptive',
        fallback: 'fixed',
        base_kcal: fixedCalories,
        factor: goalFactor,
        days_available: adaptive.daysAvailable,
        days_required: adaptive.daysRequired,
      };
    }
  }

  const baseCalories = calories;
  let activityAdjustment = 0;
  if (snapshot?.diary_show_activity === true && snapshot?.calorie_adjust_from_activity === true) {
    activityAdjustment = effectiveActiveCalories(
      userId,
      date,
      snapshot?.manual_activity_policy || 'wearable_wins'
    );
    calories += activityAdjustment;
  }

  const resolvedGoals = {};
  for (const [key, goal] of Object.entries(goals)) {
    let value = _resolveGoalValue(goal, date);
    if (key === 'calories') {
      value = calories;
    } else if (MACRO_DENSITY[key] && goal?.isPercent && value != null) {
      // Diary intentionally keeps percent macros anchored to the base calorie
      // target so a logged workout changes the calorie budget, not protein /
      // carbs / fat gram targets.
      value = Math.round(baseCalories * Number(value) / 100 / MACRO_DENSITY[key]);
    }
    if (value != null && Number.isFinite(Number(value))) resolvedGoals[key] = Number(value);
  }
  if (!Object.prototype.hasOwnProperty.call(resolvedGoals, 'calories')) resolvedGoals.calories = calories;

  return {
    resolved_goals: resolvedGoals,
    water_goal_ml: Number.isFinite(Number(snapshot?.water_goal_ml)) ? Number(snapshot.water_goal_ml) : 2000,
    calorie_target_kcal: calories,
    calorie_base_target_kcal: baseCalories,
    calorie_basis: basis,
    activity_adjustment_kcal: activityAdjustment,
  };
}

export function effectiveGoalsForDate(userId, date) {
  if (!isGoalHistoryDate(date)) throw new Error(`Invalid date '${date}'; expected YYYY-MM-DD.`);
  const history = readGoalSnapshotForDate(userId, date);
  if (!history) {
    return {
      date,
      known: false,
      effective_from: null,
      reason: 'before_first_recorded_snapshot',
      history_available_from: firstGoalHistoryDate(userId),
    };
  }
  const resolved = resolveGoalSnapshot(userId, date, history.snapshot);
  return {
    date,
    known: true,
    effective_from: history.effective_from,
    history_available_from: firstGoalHistoryDate(userId),
    changed_at: history.changed_at,
    source: history.source,
    ...history.snapshot,
    ...resolved,
  };
}

function _dateRange(start, end) {
  const out = [];
  const cursor = new Date(start + 'T12:00:00Z');
  const finish = new Date(end + 'T12:00:00Z');
  while (cursor <= finish) {
    out.push(cursor.toISOString().slice(0, 10));
    if (out.length > 366) throw new Error('Goal history range may not exceed 366 days.');
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export function effectiveGoalsForRange(userId, start, end) {
  if (!isGoalHistoryDate(start)) throw new Error(`Invalid start date '${start}'; expected YYYY-MM-DD.`);
  if (!isGoalHistoryDate(end)) throw new Error(`Invalid end date '${end}'; expected YYYY-MM-DD.`);
  if (start > end) throw new Error('start must be on or before end.');
  const days = _dateRange(start, end).map(date => effectiveGoalsForDate(userId, date));
  return {
    start,
    end,
    history_available_from: firstGoalHistoryDate(userId),
    history_complete: days.every(d => d.known),
    days,
  };
}
