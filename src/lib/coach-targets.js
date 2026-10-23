/**
 * coach-targets.js: a coach's recommended targets, in the Goals format.
 *
 * Shared by the server (it checks what a coach sends) and the app (it shows
 * the comparison, applies an accepted recommendation and undoes it). No
 * imports: the server's Docker image copies this one file.
 *
 * A recommendation's payload:
 *   { goals: { calories?, proteins?, carbohydrates?, fat? }, mode? }
 * Each goal entry has the Goals page's shape: sharedGoal, isMin, isPercent
 * (macros only), days[7], and max or min. `mode` ('fixed' | 'dynamic' |
 * 'adaptive') recommends a calorie goal mode, with or without a number.
 *
 * Accepting saves the person's goals as they are as a template first
 * ("Before coach change, <date>", with the calorie mode), then writes only
 * the recommended values; Undo applies that template, so every goal comes
 * back exactly. What a goal shows (Diary, Statistics) and every other
 * nutrient stay as they were.
 */

export const TARGET_KEYS = ['calories', 'proteins', 'carbohydrates', 'fat'];
export const CALORIE_MODES = ['fixed', 'dynamic', 'adaptive'];
const DENSITY = { proteins: 4, carbohydrates: 4, fat: 9 };
const LIMIT = { calories: 20000, grams: 2000, percent: 100 };
// The fields a recommendation decides; everything else on an entry stays.
const VALUE_FIELDS = ['sharedGoal', 'isMin', 'isPercent', 'days', 'max', 'min'];

// A number, or a plain decimal string; anything else (true, '0x10', [1500]) is no number.
const num = (v) => (v === null || v === undefined || v === '' ? null
  : typeof v === 'number' ? v
  : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
const okNum = (v, max) => v === null || (Number.isFinite(v) && v > 0 && v <= max);

/**
 * Check and tidy a payload from a coach. Returns { payload } or { error }.
 */
export function cleanTargetsPayload(input) {
  const src = input && typeof input === 'object' ? input : {};
  const goalsIn = src.goals && typeof src.goals === 'object' ? src.goals : {};
  const out = { goals: {} };
  for (const key of Object.keys(goalsIn)) {
    if (!TARGET_KEYS.includes(key)) return { error: `Only calories, protein, carbs and fat can be recommended.`, code: 'targets_only_four' };
    const e = goalsIn[key];
    if (!e || typeof e !== 'object') return { error: 'A target is missing its value.', code: 'target_missing' };
    const isPercent = key !== 'calories' && !!e.isPercent;
    const max = isPercent ? LIMIT.percent : key === 'calories' ? LIMIT.calories : LIMIT.grams;
    const shared = e.sharedGoal !== false;
    const isMin = !!e.isMin;
    let days;
    if (shared) {
      const v = num(e.isMin ? e.min : e.max) ?? num(e.max ?? e.min);
      if (v === null || !okNum(v, max)) return { error: 'A target needs a number in range.', code: 'target_range' };
      days = Array(7).fill(v);
    } else {
      if (!Array.isArray(e.days) || e.days.length !== 7) return { error: 'A target by weekday needs seven days.', code: 'target_weekdays' };
      days = e.days.map(num);
      if (!days.every(v => okNum(v, max)) || !days.some(v => v !== null)) return { error: 'A target needs a number in range.', code: 'target_range' };
    }
    const valid = days.filter(v => v !== null);
    const value = shared ? days[0] : Math.max(...valid);
    const entry = { sharedGoal: shared, isMin, isPercent, days };
    if (isMin) entry.min = value; else entry.max = value;
    out.goals[key] = entry;
  }
  // Percent macros can't add up to more than all the calories.
  for (let d = 0; d < 7; d++) {
    const pct = ['proteins', 'carbohydrates', 'fat'].reduce((n, k) => n + (out.goals[k]?.isPercent ? (out.goals[k].days[d] || 0) : 0), 0);
    if (pct > 100) return { error: 'Protein, carbs and fat in percent add up to more than 100%.', code: 'percent_over' };
  }
  if (src.mode != null && src.mode !== '') {
    if (!CALORIE_MODES.includes(src.mode)) return { error: 'Unknown calorie goal mode.', code: 'mode_unknown' };
    out.mode = src.mode;
  }
  if (!Object.keys(out.goals).length && !out.mode) return { error: 'Recommend at least one target or a calorie goal mode.', code: 'targets_nothing' };
  return { payload: out };
}

/**
 * The goals and calorie mode after accepting. A number for calories while
 * the person uses Dynamic or Adaptive switches them to Fixed (the card says
 * so first); a recommended mode is used as it is.
 */
export function applyTargets(currentGoals, currentMode, payload) {
  const goals = { ...(currentGoals || {}) };
  for (const key of TARGET_KEYS) {
    const rec = payload?.goals?.[key];
    if (!rec) continue;
    const keep = { ...(goals[key] || { showInDiary: true, showInStats: true }) };
    for (const f of VALUE_FIELDS) delete keep[f];
    const next = { ...keep };
    for (const f of VALUE_FIELDS) if (rec[f] !== undefined) next[f] = Array.isArray(rec[f]) ? [...rec[f]] : rec[f];
    goals[key] = next;
  }
  let mode = currentMode || 'fixed';
  if (payload?.mode) mode = payload.mode;
  else if (payload?.goals?.calories && mode !== 'fixed') mode = 'fixed';
  return { goals, mode, modeChanged: mode !== (currentMode || 'fixed') };
}

/** Whether accepting changes the calorie mode to Fixed without asking for it. */
export const acceptSwitchesToFixed = (currentMode, payload) =>
  !payload?.mode && !!payload?.goals?.calories && (currentMode === 'dynamic' || currentMode === 'adaptive');

/** The template saved before a recommendation is applied (Undo applies it). */
export function beforeTemplate({ goals, mode, waterGoalMl, name, recommendationId, now = new Date() }) {
  const g = JSON.parse(JSON.stringify(goals || {}));
  return {
    id: now.getTime(),
    name,
    createdAt: now.toISOString(),
    goals: g,
    waterGoalMl: waterGoalMl ?? null,
    goalCount: Object.keys(g).filter(k => g[k]?.min != null || g[k]?.max != null).length + (waterGoalMl > 0 ? 1 : 0),
    calorieGoalMode: mode || 'fixed',
    coachRecommendationId: recommendationId,
  };
}

/** True when the goals and mode now are the template's (Undo already done). */
export function matchesTemplate(tpl, goals, mode) {
  if (!tpl) return false;
  return JSON.stringify(_sorted(tpl.goals || {})) === JSON.stringify(_sorted(goals || {}))
    && (tpl.calorieGoalMode || 'fixed') === (mode || 'fixed');
}
function _sorted(v) {
  if (Array.isArray(v)) return v.map(_sorted);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, _sorted(v[k])]));
}

/** A goal entry's target for a weekday (0 = Sunday), in its own unit. */
function _dayValue(e, wd) {
  if (!e) return null;
  if (e.sharedGoal !== false) return num(e.max ?? e.min);
  const v = Array.isArray(e.days) ? num(e.days[wd]) : null;
  return v ?? num(e.max ?? e.min);
}

/** Grams for a macro entry on a weekday (percent turned into grams). */
function _grams(entry, calEntry, key, wd) {
  const v = _dayValue(entry, wd);
  if (v === null) return null;
  if (!entry.isPercent) return v;
  const cal = _dayValue(calEntry, wd);
  return cal ? Math.round(cal * v / 100 / DENSITY[key]) : null;
}

/**
 * Rows for the card: per target, what it is now and what is recommended,
 * for one weekday (and whether either varies by weekday). Percent targets
 * also give their grams at that day's calorie target. Values are numbers;
 * the card formats them. `caloriesNow` is today's effective calorie goal
 * with Dynamic or Adaptive (what the Diary shows): "now" is read from it.
 */
export function comparisonRows(currentGoals, payload, weekday = new Date().getDay(), { caloriesNow = null } = {}) {
  const cur = currentGoals || {};
  const recGoals = payload?.goals || {};
  const after = applyTargets(cur, null, payload).goals;
  const calNow = caloriesNow != null ? { max: caloriesNow } : cur.calories;
  return TARGET_KEYS.filter(k => recGoals[k]).map(key => {
    const c = cur[key] || null, r = after[key];
    const cv = key === 'calories' ? (caloriesNow ?? _dayValue(c, weekday)) : _grams(c || {}, calNow, key, weekday);
    const rv = key === 'calories' ? _dayValue(r, weekday) : _grams(r, after.calories, key, weekday);
    return {
      key,
      current: c ? cv : null,
      proposed: rv,
      diff: c && cv !== null && rv !== null ? Math.round((rv - cv) * 10) / 10 : null,
      currentPercent: c?.isPercent ? _dayValue(c, weekday) : null,
      proposedPercent: r.isPercent ? _dayValue(r, weekday) : null,
      byWeekday: (c && c.sharedGoal === false) || r.sharedGoal === false,
      currentDays: c ? Array.from({ length: 7 }, (_, d) => (key === 'calories' ? _dayValue(c, d) : _grams(c, cur.calories, key, d))) : null,
      proposedDays: Array.from({ length: 7 }, (_, d) => (key === 'calories' ? _dayValue(r, d) : _grams(r, after.calories, key, d))),
    };
  });
}
