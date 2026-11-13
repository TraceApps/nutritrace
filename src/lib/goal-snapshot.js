/**
 * goal-snapshot.js — the shape of a stored nutrition-goal configuration,
 * shared by the server (server/lib/goal-history.js) and the app's local
 * SQLite copy (src/lib/db-native.js, src/stores/settings.js).
 *
 * The Goals page keeps one live configuration, not a history. A snapshot is
 * the complete configuration that was in effect from one local calendar day
 * on, so an old diary day can be compared with the target it actually had
 * rather than with today's.
 */

/** The user settings a goal snapshot holds. */
export const GOAL_HISTORY_KEYS = [
  'goals',
  'waterGoalMl',
  'calorieGoalMode',
  'calorieGoalFactor',
  'calorieAdjustFromActivity',
  'diaryShowActivity',
  'manualActivityPolicy',
  'lifttraceOverlapFill',
];
export const GOAL_HISTORY_SETTING_KEYS = new Set(GOAL_HISTORY_KEYS);

/**
 * The snapshot field each goal setting fills (goal-snapshot.js's own
 * snake_case names). Settings merge one key at a time on the server, so a
 * day's snapshot follows the same model: each field is decided by when it
 * was last edited, not by the whole configuration's one time.
 */
export const GOAL_HISTORY_FIELD_OF_SETTING = {
  goals: 'goals',
  waterGoalMl: 'water_goal_ml',
  calorieGoalMode: 'calorie_goal_mode',
  calorieGoalFactor: 'calorie_goal_factor',
  calorieAdjustFromActivity: 'calorie_adjust_from_activity',
  diaryShowActivity: 'diary_show_activity',
  manualActivityPolicy: 'manual_activity_policy',
  lifttraceOverlapFill: 'lifttrace_overlap_fill',
};
/** Every snapshot field, in the order a snapshot is written. */
export const GOAL_HISTORY_FIELDS = Object.values(GOAL_HISTORY_FIELD_OF_SETTING);

/** Per-field times ({ field: time }) from times keyed by setting name. */
export function goalHistoryFieldTimes(settingTimes) {
  const out = {};
  for (const [setting, field] of Object.entries(GOAL_HISTORY_FIELD_OF_SETTING)) {
    const t = settingTimes?.[setting];
    if (t) out[field] = t;
  }
  return out;
}

/**
 * The calendar date at `at` in the account's time zone (its `timezone`
 * setting). Goal history is dated by the account's day on every surface —
 * the server dates its own captures and a phone's fallback the same way — so
 * one edit resolves to the same day whether it is recorded on the phone, in
 * the browser or on the server.
 *
 * With no valid zone it is UTC, the same fixed fallback the server uses
 * (server/lib/goal-history-baseline.js userDate). The app sets its zone on
 * first launch and syncs it, so the two agree even before that arrives.
 */
export function goalDateInZone(timeZone, at = new Date()) {
  let zone = 'UTC';
  if (typeof timeZone === 'string' && timeZone) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone });
      zone = timeZone;
    } catch { /* not a zone this browser knows: UTC, as the server */ }
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = ['fixed', 'dynamic', 'adaptive'];
const POLICIES = ['wearable_wins', 'manual_wins', 'additive'];

/** A real calendar date, not just the right shape (2026-02-31 is no date). */
export function isGoalHistoryDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/**
 * A complete configuration from the values of the goal settings: an object
 * or a Map keyed by setting name, each value as stored (not JSON text).
 * Missing or unreadable values take the same defaults the app reads, so a
 * reader never has to guess one that has changed since.
 */
export function goalSnapshot(values) {
  const at = (key, fallback) => {
    const v = values instanceof Map ? values.get(key) : values?.[key];
    return v == null ? fallback : v;
  };
  return normalizeGoalSnapshot({
    goals: at('goals', null),
    water_goal_ml: at('waterGoalMl', 2000),
    calorie_goal_mode: at('calorieGoalMode', 'fixed'),
    calorie_goal_factor: at('calorieGoalFactor', 1),
    calorie_adjust_from_activity: at('calorieAdjustFromActivity', false),
    diary_show_activity: at('diaryShowActivity', false),
    manual_activity_policy: at('manualActivityPolicy', 'wearable_wins'),
    lifttrace_overlap_fill: at('lifttraceOverlapFill', true),
  });
}

/**
 * A stored snapshot as the configuration it holds and nothing else: a
 * client's copy can't add fields to the response or override the day it
 * describes. Missing values take the app's defaults.
 */
export function normalizeGoalSnapshot(input) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const goals = s.goals;
  const water = s.water_goal_ml;
  const factor = Number(s.calorie_goal_factor);
  return {
    goals: goals && typeof goals === 'object' && !Array.isArray(goals) ? goals : {},
    water_goal_ml: typeof water === 'number' && Number.isFinite(water) ? water : 2000,
    calorie_goal_mode: MODES.includes(s.calorie_goal_mode) ? s.calorie_goal_mode : 'fixed',
    calorie_goal_factor: Number.isFinite(factor) && factor > 0 ? factor : 1,
    calorie_adjust_from_activity: s.calorie_adjust_from_activity === true,
    diary_show_activity: s.diary_show_activity === true,
    manual_activity_policy: POLICIES.includes(s.manual_activity_policy) ? s.manual_activity_policy : 'wearable_wins',
    lifttrace_overlap_fill: s.lifttrace_overlap_fill !== false,
  };
}
