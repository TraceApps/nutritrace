/**
 * goal-history.js — the nutrition goals that were in effect on a past day.
 *
 * The Goals page stores one live configuration (user_settings.goals plus the
 * water, calorie-mode and activity-adjustment settings). A report on a past
 * week needs the target that was in effect back then, not today's: an
 * effective-dated snapshot is saved whenever one of those settings changes,
 * and a date resolves to the newest snapshot on or before it.
 *
 * One snapshot per person per local calendar date: several changes in a day
 * collapse to the last complete configuration of that day. Dates before the
 * first snapshot are unknown on purpose; NutriTrace does not invent history
 * from today's settings.
 *
 * Resolution follows the app's own rules (src/lib/goal-resolver.js and
 * lib/effective-goal.js): per-weekday goals, percent macros, Dynamic and
 * Adaptive calorie modes, and the activity adjustment, read from the
 * snapshot's settings but from the observations available at that date.
 */
import db from '../db.js';
import { dayTargets, describeGoals, percentGoalToGrams, resolveGoalFor } from '../../src/lib/goal-resolver.js';
import {
  GOAL_HISTORY_FIELDS,
  GOAL_HISTORY_FIELD_OF_SETTING,
  GOAL_HISTORY_KEYS,
  GOAL_HISTORY_SETTING_KEYS,
  isGoalHistoryDate,
  normalizeGoalSnapshot,
} from '../../src/lib/goal-snapshot.js';
import { instantMs, isoTime, laterThan, readTimes } from './field-sync.js';
import { currentGoalState, currentUserDate, userDate } from './goal-history-baseline.js';
import { effectiveCalorieGoal } from './effective-goal.js';
import { effectiveActiveCalories } from './active-calories.js';

export { GOAL_HISTORY_FIELDS, GOAL_HISTORY_FIELD_OF_SETTING, GOAL_HISTORY_KEYS, GOAL_HISTORY_SETTING_KEYS, isGoalHistoryDate };

const MACRO_DENSITY = { proteins: 4, carbohydrates: 4, fat: 9 };

function _json(value, fallback) {
  if (value == null) return fallback;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}

/**
 * The calendar date it is for `userId` at `at`, in the time zone they chose
 * in Settings, else the server's. Goal history is dated by the day the
 * person made the change, which is the day their diary shows.
 */
export function userToday(userId, at = Date.now()) {
  return userDate(db, userId, at);
}

/** The day the current (no-argument) goals answer uses: the account's zone,
 *  else the server's own — as that answer always did. The dated forms use
 *  userToday's UTC fallback instead, so a phone and the server agree. */
export function currentUserToday(userId, at = Date.now()) {
  return currentUserDate(db, userId, at);
}

const _dayMs = value => Date.UTC(
  Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))
);

/**
 * The day a goal change is filed under: the client's `supplied` date when it
 * is within about a day of the corrected edit time, else the edit's own day.
 * A wrong phone clock can then neither file a change under another day nor
 * push the newest history date far ahead (which would suppress later days).
 * An absent or malformed date is the edit's own day.
 */
export function boundGoalDate(userId, supplied, at = Date.now()) {
  const byEdit = userToday(userId, at);
  if (supplied == null || !isGoalHistoryDate(supplied)) return byEdit;
  return Math.abs(_dayMs(supplied) - _dayMs(byEdit)) > 86400000 ? byEdit : supplied;
}

/** The goal settings as they stand now. */
export function currentGoalSnapshot(userId) {
  return currentGoalState(db, userId).snapshot;
}

const _iso = value => {
  const ms = instantMs(value);
  return Number.isFinite(ms) ? isoTime(ms) : null;
};

/** Whether an edit made at `incoming` is the newer one over `here`, by the
 *  same whole-second rule the app's settings merge uses (lib/field-sync.js
 *  laterThan): a tie in the same second goes to the incoming edit. A missing
 *  `here` has nothing to lose to. */
function _editBeats(incoming, here) {
  const a = instantMs(incoming), b = instantMs(here);
  if (!Number.isFinite(b)) return true;
  if (!Number.isFinite(a)) return false;
  return !laterThan(b, a);
}

/** Two edits made in the same whole second (the app's setting times count in
 *  whole seconds: field-sync.js laterThan). */
function _sameSecond(a, b) {
  const x = instantMs(a), y = instantMs(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.floor(x / 1000) === Math.floor(y / 1000);
}

const SETTING_OF_FIELD = Object.fromEntries(
  Object.entries(GOAL_HISTORY_FIELD_OF_SETTING).map(([setting, field]) => [field, setting])
);

/**
 * When each goal setting is currently deleted, by snapshot field. A claim a
 * client sends at exactly that instant does not bring the setting back
 * (settingEditRevives is strictly later), so the day's value must not be
 * brought back either.
 */
function _goalTombstones(userId) {
  const out = new Map();
  const rows = db.prepare(
    `SELECT key, deleted_at, field_times FROM user_settings
      WHERE user_id = ? AND deleted_at IS NOT NULL
        AND key IN (${GOAL_HISTORY_KEYS.map(() => '?').join(',')})`
  ).all(userId, ...GOAL_HISTORY_KEYS);
  for (const row of rows) {
    const field = GOAL_HISTORY_FIELD_OF_SETTING[row.key];
    if (!field) continue;
    const own = instantMs(readTimes(row.field_times).deleted_at);
    const ms = Number.isFinite(own) ? own : instantMs(row.deleted_at);
    if (Number.isFinite(ms)) out.set(field, ms);
  }
  return out;
}

/**
 * Save the configuration in effect from `effectiveDate` on. Called after a
 * goal setting is written, in the same transaction, so the snapshot matches
 * what the settings say.
 *
 * Fields merge one at a time, as settings do (routes/sync.js mergeEdit): a
 * day's snapshot follows each field's own last edit, not the client's whole
 * configuration at one time. Two devices changing different settings on the
 * same day therefore both keep their change, and the day reflects the
 * configuration the server ended up with.
 *
 * Each field carries the time it became effective (field_times), so a new
 * day inherits the day before's values *and* their times: a claim a phone
 * carried from the previous day loses to a newer edit already in the
 * inherited configuration.
 *
 * `snapshot` lets a client hand up the configuration it saved with no
 * connection; `fieldTimes` names the fields that call changed and when, so
 * the fields it only carried (an older copy of another device's setting)
 * are left to the day's own history. Without `fieldTimes` the snapshot
 * counts as every field changed at `changedAt`, for an app sending a whole
 * configuration. Without `snapshot` the current settings are read, each
 * field with the time it was last edited.
 *
 * A change to a day already behind later ones is carried forward: every
 * later day that inherited the field (no edit of its own since) takes the
 * corrected value, up to the first day that set the field itself later.
 */
export function captureGoalSnapshot(userId, {
  effectiveDate,
  changedAt = new Date().toISOString(),
  source = 'settings',
  snapshot = null,
  fieldTimes = null,
} = {}) {
  if (!isGoalHistoryDate(effectiveDate)) {
    throw new Error(`Invalid effective date '${effectiveDate}'; expected YYYY-MM-DD.`);
  }
  const at = _iso(changedAt) || new Date().toISOString();
  // Only the configuration itself is stored: a client's snapshot can't add
  // fields to the response or claim another day.
  const built = snapshot == null ? currentGoalState(db, userId, { at: Date.parse(at) }) : null;
  const value = built ? built.snapshot : normalizeGoalSnapshot(snapshot);

  // The fields this call changes, each with when. A client that names none
  // (an app before per-field times) sends a whole configuration, changed at
  // its one time.
  const claimed = new Map();
  if (!built && fieldTimes && typeof fieldTimes === 'object' && !Array.isArray(fieldTimes)) {
    for (const field of GOAL_HISTORY_FIELDS) {
      const t = _iso(fieldTimes[field]);
      if (t) claimed.set(field, t);
    }
  }
  if (!claimed.size) {
    for (const field of GOAL_HISTORY_FIELDS) {
      claimed.set(field, (built && _iso(built.field_times[field])) || at);
    }
  }

  // What the day already holds: its own row, else the day before (a new
  // date starts from the configuration in effect then, values and times). A
  // row from before per-field times counts from its own changed_at.
  const existing = db.prepare(
    'SELECT snapshot, field_times, changed_at, source FROM goal_history WHERE user_id = ? AND effective_date = ?'
  ).get(userId, effectiveDate) || null;
  const previous = existing ? null : db.prepare(
    `SELECT snapshot, field_times, changed_at FROM goal_history
      WHERE user_id = ? AND effective_date < ? ORDER BY effective_date DESC LIMIT 1`
  ).get(userId, effectiveDate) || null;
  const baseRow = existing || previous;
  const base = normalizeGoalSnapshot(baseRow ? _json(baseRow.snapshot, {}) : {});
  const baseTimes = readTimes(baseRow?.field_times);
  // The fields no day has supplied yet (field_times._unknown): a day before
  // the first complete configuration starts from the defaults but marks the
  // rest unknown, so a reader is never handed a default as that day's target.
  // With nothing before it, every field the capture doesn't set is unknown.
  const unknown = new Set(baseRow ? (baseTimes._unknown || []) : GOAL_HISTORY_FIELDS);
  const baseAt = _iso(baseRow?.changed_at);
  // A field the day (or the day it inherits from) never got has no time: a
  // claim for it is the first one. A known field with no own time counts
  // from the base row's own time.
  const baseTimeOf = field => {
    if (unknown.has(field)) return null;
    return _iso(baseTimes[field]) || (baseRow ? baseAt : null);
  };

  // A client's claims meet the moments its settings are deleted at: a claim
  // at that exact instant loses, the same rule settings follow. A reset's own
  // capture states the day's defaults at that instant and is not a claim
  // that could lose to itself.
  const tombstones = built || source === 'settings_reset' ? null : _goalTombstones(userId);

  const out = { ...base };
  const times = {};
  const applied = [];
  let latest = existing && baseAt ? Date.parse(baseAt) : NaN;
  for (const field of GOAL_HISTORY_FIELDS) {
    // A field's time here is its own last edit, or the one inherited from
    // the configuration in effect. A claim older than that loses, whichever
    // row it came with.
    const here = baseTimeOf(field);
    const incoming = claimed.get(field);
    // The newer edit wins, by the same rule the settings merge uses; a claim
    // on a setting that is deleted must be later than the delete, in whole
    // seconds, or the delete keeps it (editRevives).
    const tombstone = tombstones?.get(field);
    // A claim in the same second as the delete loses (a setting is only
    // brought back later than its delete); a claim for an earlier day is
    // the configuration of that day and is left to it.
    const bringsBack = !Number.isFinite(tombstone) || !incoming || !_sameSecond(incoming, tombstone);
    if (incoming && bringsBack && _editBeats(incoming, here)) {
      out[field] = value[field];
      times[field] = incoming;
      unknown.delete(field);
      applied.push({ field, time: incoming, value: value[field] });
      if (!Number.isFinite(latest) || Date.parse(incoming) > latest) latest = Date.parse(incoming);
    } else if (here) {
      times[field] = here;
      unknown.delete(field);
    }
  }
  if (unknown.size) times._unknown = [...unknown];
  if (!applied.length) {
    // A retried or stale push: the day keeps what it had, and its time.
    return { effective_date: effectiveDate, changed_at: baseAt, snapshot: base, source: existing?.source ?? source, applied: false };
  }
  const finalAt = Number.isFinite(latest) ? isoTime(latest) : at;
  db.prepare(
    `INSERT INTO goal_history (user_id, effective_date, snapshot, field_times, changed_at, updated_at, source)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, effective_date) DO UPDATE SET
       snapshot = excluded.snapshot,
       field_times = excluded.field_times,
       changed_at = excluded.changed_at,
       updated_at = datetime('now'),
       source = excluded.source`
  ).run(userId, effectiveDate, JSON.stringify(out), JSON.stringify(times), finalAt, source);
  _carryForward(userId, effectiveDate, applied);
  return { effective_date: effectiveDate, changed_at: finalAt, snapshot: out, source, applied: true };
}

/**
 * A field corrected on `fromDate` reaches the days after it that inherited
 * it: their value and effective time move to the correction, so a late
 * offline edit of Monday's calories isn't stuck behind Tuesday's water
 * change. A day that edited the field itself at a later time keeps its own:
 * it made a newer decision, and is where the walk stops.
 */
function _carryForward(userId, fromDate, corrections) {
  if (!corrections.length) return;
  const pending = new Map(corrections.map(c => [c.field, c]));
  const later = db.prepare(
    `SELECT effective_date, snapshot, field_times FROM goal_history
      WHERE user_id = ? AND effective_date > ? ORDER BY effective_date ASC`
  ).all(userId, fromDate);
  const update = db.prepare(
    `UPDATE goal_history SET snapshot = ?, field_times = ?, updated_at = datetime('now')
      WHERE user_id = ? AND effective_date = ?`
  );
  for (const row of later) {
    if (!pending.size) break;
    const rowTimes = readTimes(row.field_times);
    const unknown = Array.isArray(rowTimes._unknown) ? new Set(rowTimes._unknown) : null;
    let snapshot = null;
    for (const [field, correction] of pending) {
      // A correction reaches only a day whose value is older than it, in
      // whole seconds (the app's settings rule). A day that decided the
      // field later, or in the same second, keeps its own and stops the
      // walk for that field. A baseline's older field times are the same
      // comparison: the correction wins over them only when it is newer.
      const here = _iso(rowTimes[field]);
      if (here && !laterThan(correction.time, here)) { pending.delete(field); continue; }
      if (!snapshot) snapshot = { ...(_json(row.snapshot, {}) || {}) };
      snapshot[field] = correction.value;
      rowTimes[field] = correction.time;
      if (unknown) unknown.delete(field);
    }
    if (snapshot) {
      if (unknown) {
        if (unknown.size) rowTimes._unknown = [...unknown];
        else delete rowTimes._unknown;
      }
      update.run(JSON.stringify(snapshot), JSON.stringify(rowTimes), userId, row.effective_date);
    }
  }
}

export function firstGoalHistoryDate(userId) {
  return db.prepare(
    `SELECT MIN(effective_date) AS d FROM goal_history WHERE user_id = ?`
  ).get(userId)?.d || null;
}

/** The newest snapshot on or before `date`, or null when there is none. */
export function readGoalSnapshotForDate(userId, date) {
  if (!isGoalHistoryDate(date)) throw new Error(`Invalid date '${date}'; expected YYYY-MM-DD.`);
  const row = db.prepare(
    `SELECT effective_date, snapshot, field_times, changed_at, source
       FROM goal_history
      WHERE user_id = ? AND effective_date <= ?
      ORDER BY effective_date DESC
      LIMIT 1`
  ).get(userId, date);
  if (!row) return null;
  return {
    effective_from: row.effective_date,
    snapshot: _json(row.snapshot, {}),
    field_times: readTimes(row.field_times),
    changed_at: row.changed_at,
    source: row.source || 'unknown',
  };
}

/** Every goal's value for `date`: weekday-aware, with percent macros in grams. */
function _resolvedGoals(goals, date, { baseCalories, calories }) {
  const out = {};
  for (const [key, goal] of Object.entries(goals)) {
    let value = typeof goal === 'number' ? goal : resolveGoalFor(goal, date);
    if (key === 'calories') value = calories;
    else if (value != null && goal && typeof goal === 'object' && goal.isPercent && MACRO_DENSITY[key]) {
      // Percent macros follow the day's calorie target before activity, as
      // the Diary shows them: logging a workout changes the budget, not the
      // protein, carb and fat targets.
      value = percentGoalToGrams(value, baseCalories, MACRO_DENSITY[key]);
    }
    if (value != null && Number.isFinite(Number(value))) out[key] = Number(value);
  }
  out.calories = calories;
  return out;
}

/**
 * A stored configuration, resolved the way the Diary reads it on `date`.
 * Dynamic and Adaptive calories use the observations available up to that
 * day, and the activity adjustment that day's logged or wearable burn.
 */
export function resolveGoalSnapshot(userId, date, snapshot) {
  const goals = snapshot?.goals && typeof snapshot.goals === 'object' ? snapshot.goals : {};
  // The fixed goal the day falls back on: its weekday's target, else 2000.
  const fixed = dayTargets(goals, date).calories;
  const fixedCalories = Number.isFinite(fixed) && fixed > 0 ? fixed : 2000;

  const modeGoal = effectiveCalorieGoal(userId, date, goals, snapshot);
  const baseCalories = Number.isFinite(modeGoal.calories) && modeGoal.calories > 0
    ? modeGoal.calories
    : fixedCalories;
  const basis = modeGoal.mode === 'fixed' || modeGoal.basis?.fallback
    ? { ...(modeGoal.basis || { mode: modeGoal.mode }), base_kcal: baseCalories }
    : modeGoal.basis;

  let activityAdjustment = 0;
  if (snapshot?.diary_show_activity === true && snapshot?.calorie_adjust_from_activity === true) {
    activityAdjustment = effectiveActiveCalories(
      userId,
      date,
      snapshot?.manual_activity_policy || 'wearable_wins'
    );
  }
  const calories = baseCalories + activityAdjustment;

  return {
    resolved_goals: _resolvedGoals(goals, date, { baseCalories, calories }),
    water_goal_ml: Number.isFinite(Number(snapshot?.water_goal_ml)) ? Number(snapshot.water_goal_ml) : 2000,
    calorie_target_kcal: calories,
    calorie_base_target_kcal: baseCalories,
    calorie_basis: basis,
    activity_adjustment_kcal: activityAdjustment,
  };
}

/**
 * The goals in effect on one local calendar date. A date before the first
 * snapshot is `known: false`, never today's goals: a caller comparing intake
 * against a target must be able to say the target isn't known.
 */
export function effectiveGoalsForDate(userId, date) {
  if (!isGoalHistoryDate(date)) throw new Error(`Invalid date '${date}'; expected YYYY-MM-DD.`);
  const history = readGoalSnapshotForDate(userId, date);
  const available = firstGoalHistoryDate(userId);
  if (!history) {
    return {
      date,
      known: false,
      effective_from: null,
      reason: 'before_first_recorded_snapshot',
      history_available_from: available,
    };
  }
  const resolved = resolveGoalSnapshot(userId, date, history.snapshot);
  // #285: weekday goals by named day, and that date's targets, so a reader
  // doesn't have to know the `days` order or resolve a percent macro.
  const described = describeGoals(history.snapshot.goals || {}, date, {
    calories: resolved.calorie_base_target_kcal,
  });
  const out = {
    date,
    known: true,
    effective_from: history.effective_from,
    history_available_from: available,
    changed_at: history.changed_at,
    source: history.source,
    ...history.snapshot,
    ...resolved,
    weekday_order: described.weekday_order,
    goals_by_weekday: described.goals_by_weekday,
    targets: described.today?.targets || null,
  };
  // A field the day never received is unknown, not its default: the values
  // computed from it go too, and the answer says the day is incomplete.
  const unknown = (history.field_times?._unknown || []).filter(f => GOAL_HISTORY_FIELDS.includes(f));
  for (const field of unknown) _dropUnknown(out, field);
  out.unknown_fields = unknown;
  out.history_complete = unknown.length === 0;
  return out;
}

function _dates(start, end) {
  const out = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const finish = new Date(`${end}T12:00:00Z`);
  while (cursor <= finish) {
    out.push(cursor.toISOString().slice(0, 10));
    if (out.length > 366) throw new Error('Goal history range may not exceed 366 days.');
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

// The outputs a reader must not be given when the field they are computed
// from is unknown: a default is not that day's target. The goals are the
// one field the calorie and macro numbers are derived from; the other
// settings' own keys go, and the app's stable defaults stay for anything
// computed from them.
const _GOAL_OUTPUTS = [
  'goals', 'resolved_goals', 'targets', 'weekday_order', 'goals_by_weekday',
  'calorie_target_kcal', 'calorie_base_target_kcal', 'calorie_basis', 'activity_adjustment_kcal',
];

function _dropUnknown(out, field) {
  delete out[field];
  if (field === 'goals') for (const key of _GOAL_OUTPUTS) delete out[key];
}

/** Every date of an inclusive range, plus whether all of them are known. */
export function effectiveGoalsForRange(userId, start, end) {
  if (!isGoalHistoryDate(start)) throw new Error(`Invalid start date '${start}'; expected YYYY-MM-DD.`);
  if (!isGoalHistoryDate(end)) throw new Error(`Invalid end date '${end}'; expected YYYY-MM-DD.`);
  if (start > end) throw new Error('start must be on or before end.');
  const days = _dates(start, end).map(date => effectiveGoalsForDate(userId, date));
  return {
    start,
    end,
    history_available_from: firstGoalHistoryDate(userId),
    history_complete: days.every(day => day.known && day.history_complete === true),
    days,
  };
}
