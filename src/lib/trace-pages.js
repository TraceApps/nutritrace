/**
 * Trace's reads that go through a lot at once (TraceApps/notetrace#34): the
 * diary over a range of days, and the meals library a page at a time. Each
 * answer stays within what one tool answer should hold and says where the
 * rest starts, so Trace can go through all of it over a few calls.
 */
import { foldText } from './search-text.js';

export const DIARY_RANGE_MAX_DAYS = 31;
// One get_diary answer over a range, measured as the JSON the model gets.
export const DIARY_RANGE_BUDGET = 16000;
export const MEALS_PAGE_MAX = 50;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const _nextDay = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};
const _valid = (d) => DATE.test(d || '') && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** Nothing logged that day: no food, body stats, water, notes or activity. */
export function emptyDiaryDay(day) {
  return !day?.totals && !Object.keys(day?.meals || {}).length && !Object.keys(day?.body_stats || {}).length
    && !day?.water_ml && !day?.day_notes && !day?.activities?.length && !day?.error;
}

/**
 * get_diary: one date as it always was, or every day from `date` to `to`.
 * `readDay(date)` builds one day's answer. Days with nothing logged are only
 * counted; past 31 days or the size budget, next_from says where to go on.
 */
export async function diaryRange(args, readDay) {
  const from = args?.date;
  if (!args?.to || args.to === from) return readDay(from);
  if (!_valid(from) || !_valid(args.to)) return { error: 'date and to must be dates, YYYY-MM-DD.' };
  if (args.to < from) return { error: 'to must be on or after date.' };
  const dates = [];
  for (let d = from; d <= args.to && dates.length < DIARY_RANGE_MAX_DAYS; d = _nextDay(d)) dates.push(d);
  const days = [];
  let budget = DIARY_RANGE_BUDGET, empty = 0, covered = null, stopped = null;
  // A week at a time: the same reads one date at a time would make.
  for (let i = 0; i < dates.length && !stopped; i += 7) {
    const week = await Promise.all(dates.slice(i, i + 7).map((d) => Promise.resolve(readDay(d)).catch(() => ({ date: d, error: 'Could not load diary' }))));
    for (const day of week) {
      if (emptyDiaryDay(day)) { empty++; covered = day.date; continue; }
      const size = JSON.stringify(day).length;
      // A day too big to share an answer still comes back, on its own.
      if (size > budget && days.length) { stopped = day.date; break; }
      days.push(day);
      budget -= size;
      covered = day.date;
    }
  }
  const last = dates[dates.length - 1];
  const next = stopped || (last < args.to ? _nextDay(last) : null);
  return {
    from, to: covered || from, days, days_with_nothing_logged: empty,
    complete: next == null,
    ...(next != null ? { next_from: next, more: `This covers ${from} to ${covered || from}: call get_diary again with date ${next} and to ${args.to} for the rest.` } : {}),
  };
}

/**
 * get_meals: the library in one order (meals, then recipes, by name), a page
 * at a time. `count` is every match; next_offset is where the next page starts.
 */
export function mealsPage(list, args = {}) {
  const q = foldText(args.query).trim();
  const all = (q ? list.filter((m) => foldText(m.name).includes(q)) : [...list]).sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'meal' ? -1 : 1)
    || foldText(a.name).localeCompare(foldText(b.name))
    || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const limit = Math.min(MEALS_PAGE_MAX, Math.max(1, Math.floor(Number(args.limit)) || MEALS_PAGE_MAX));
  const offset = Math.max(0, Math.floor(Number(args.offset)) || 0);
  const page = all.slice(offset, offset + limit);
  const next = offset + page.length < all.length ? offset + page.length : null;
  return {
    count: all.length, offset, returned: page.length, next_offset: next, complete: next == null,
    // Said in words too: a model that skims the numbers still sees there's more.
    ...(next != null ? { more: `This is ${offset + 1} to ${offset + page.length} of ${all.length}: call get_meals again with offset ${next} for the rest.` } : {}),
    meals: page,
  };
}
