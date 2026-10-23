/**
 * prev-day.js (#280): the day before the day being logged to. Foods'
 * Yesterday's Meals and Smart Log's "same as yesterday" offer that day's
 * meals; both used to count back from today's date, so on any other day
 * of the diary they offered the meals of the day before today.
 */

const _ISO = /^\d{4}-\d{2}-\d{2}$/;
const _local = d => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dy}`;
};
const _shift = (day, n) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return _local(d);
};

/** YYYY-MM-DD: the day before `target` (today when there's no target). */
export function dayBefore(target, now = new Date()) {
  return _shift(_ISO.test(target || '') ? target : _local(now), -1);
}

/**
 * How to name `day` (the day the meals come from) next to today:
 * { kind: 'yesterday' | 'today' } for those two; { kind: 'weekday', name }
 * within a week either side; else { kind: 'date', day } for the caller to
 * show in the app's date format.
 */
export function dayName(day, now = new Date()) {
  const today = _local(now);
  if (day === today) return { kind: 'today' };
  if (day === _shift(today, -1)) return { kind: 'yesterday' };
  const diff = Math.round((new Date(`${day}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000);
  if (Math.abs(diff) <= 6) return { kind: 'weekday', name: new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' }) };
  return { kind: 'date', day };
}
