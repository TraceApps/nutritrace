/**
 * diary-copy.js (#283): the pure parts of copying diary items to other days
 * and moving a selection between meals. The Diary's Copy sheet (one item,
 * a meal, or the items picked with Select Multiple) can repeat a copy for
 * the following days; Select Multiple can also move its items to another
 * meal of the same day.
 */

/** Most days "Repeat for the next N days" goes up to. */
export const REPEAT_MAX_DAYS = 14;

const _ISO = /^\d{4}-\d{2}-\d{2}$/;
const _local = d => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dy}`;
};

/** The repeat count the sheet can use: a whole number from 0 to REPEAT_MAX_DAYS. */
export function clampRepeat(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(REPEAT_MAX_DAYS, v);
}

/**
 * YYYY-MM-DD days to copy to: `start`, then each of the next `extra` days.
 * Counted on local calendar days (noon, so a clock change can't skip or
 * repeat a day). An invalid start gives no days.
 */
export function repeatDates(start, extra = 0) {
  if (!_ISO.test(start || '')) return [];
  const [y, m, d] = start.split('-').map(Number);
  const out = [];
  for (let k = 0; k <= clampRepeat(extra); k++) out.push(_local(new Date(y, m - 1, d + k, 12)));
  return out;
}

/**
 * Which food a diary item came from (food_server_id), the rule addDiaryItem
 * uses. A diary item logged again keeps the one it has; a food row says it
 * by `server_id` (Android) or by its `id` (the browser).
 */
export function foodServerIdFor(foodItem) {
  const keepsSource = !('server_id' in foodItem) && 'food_server_id' in foodItem
    && (typeof foodItem.food_server_id === 'number' || foodItem.food_server_id === null);
  if (keepsSource) return foodItem.food_server_id;
  if ('server_id' in foodItem) return foodItem.server_id;
  return typeof foodItem.id === 'number' ? foodItem.id : null;
}

/**
 * A copy of a logged diary item, the same as copying it alone with Copy:
 * its row index (_i) and id are dropped, it gets a new uuid (a copy is a new
 * item), the meal it goes to, and when it was added. Everything else
 * (amount, nutrition, photo, notes, split ingredients, Quick Calories) stays.
 * `meal` null keeps the item's own meal.
 */
export function copyOfDiaryItem(item, meal, { uuid, now }) {
  const { _i, id, ...rest } = item || {};
  return {
    ...rest,
    uuid,
    meal: meal == null ? Number(rest.meal ?? 0) : Number(meal),
    addedAt: now,
    food_server_id: foodServerIdFor(rest),
  };
}

/**
 * Moves the items at `indices` to meal `toMeal`. Items already in that meal
 * are left alone. Returns the new item list and how many moved.
 */
export function moveItemsToMeal(items, indices, toMeal, now) {
  const pick = new Set(indices);
  const to = Number(toMeal);
  let moved = 0;
  const out = (items || []).map((it, i) => {
    if (!pick.has(i) || Number(it?.meal ?? 0) === to) return it;
    moved++;
    return { ...it, meal: to, updatedAt: now };
  });
  return { items: out, moved };
}

/**
 * Runs `copyOne(date)` for each day in turn and says which days took the
 * copy and which didn't. One day failing doesn't stop the others.
 * `copyOne` returns how many items it copied; 0 is "nothing to copy".
 */
export async function copyToDays(dates, copyOne) {
  const copied = [];
  const failed = [];
  let items = 0;
  for (const date of dates) {
    try {
      const n = await copyOne(date);
      if (n === 0) return { copied, failed, items, nothing: true };
      copied.push(date);
      items = Math.max(items, Number(n) || 0);
    } catch (error) {
      failed.push({ date, error });
    }
  }
  return { copied, failed, items, nothing: false };
}

/**
 * What the toast says after a copy, as an i18n key (under diary.copy) and
 * its values: every day copied, some days failed (naming them), or none
 * copied. `keepMeals`: each item went to its own meal, so no meal is named.
 * `fmt` writes a day as a plain date ("Thu, Oct 29"); `rel` names it next to
 * today ('yesterday' | 'today' | 'tomorrow' | 'other', see day-label.js).
 */
export function copyOutcome({ copied, failed, items, nothing }, { meal, keepMeals = false, fmt = d => d, rel = () => 'other' } = {}) {
  const n = items;
  if (nothing) return { level: 'info', key: 'diary.copy.toast_nothing', values: {} };
  if (!copied.length) {
    const error = failed.find(f => f?.error?.message)?.error?.message || '';
    return error
      ? { level: 'error', key: 'diary.copy.toast_failed_reason', values: { error } }
      : { level: 'error', key: 'diary.copy.toast_failed', values: {} };
  }
  if (failed.length) {
    return {
      level: 'error',
      key: 'diary.copy.toast_partial',
      values: { n, done: copied.length, total: copied.length + failed.length, failed: failed.map(f => fmt(f.date)).join('; ') }, // dates have commas of their own
    };
  }
  if (copied.length > 1) {
    const values = { n, meal, days: copied.length, from: fmt(copied[0]), to: fmt(copied[copied.length - 1]) };
    return { level: 'success', key: keepMeals ? 'diary.copy.toast_days' : 'diary.copy.toast_days_meal', values };
  }
  const day = { rel: rel(copied[0]), day: fmt(copied[0]) };
  return keepMeals
    ? { level: 'success', key: 'diary.copy.toast_day', values: { n, ...day } }
    : { level: 'success', key: 'diary.copy.toast_day_meal', values: { n, meal, ...day } };
}
