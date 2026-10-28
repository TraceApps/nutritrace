/**
 * day-label.js (#267, #283): naming a diary day next to today. The day
 * chips (Yesterday, Today, Tomorrow) and the toasts that say where items
 * went ("Added to yesterday's Dinner", "Moved 2 items to Lunch on Thu,
 * Oct 29") read the day the same way.
 */

const _ISO = /^\d{4}-\d{2}-\d{2}$/;
const _local = d => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dy}`;
};

/** YYYY-MM-DD for today on this device. */
export function todayIso(now = new Date()) { return _local(now); }

/** YYYY-MM-DD `n` calendar days from `day` (noon, so clock changes can't skip a day). */
export function shiftDay(day, n) {
  if (!_ISO.test(day || '')) return '';
  const [y, m, d] = day.split('-').map(Number);
  return _local(new Date(y, m - 1, d + n, 12));
}

/** 'yesterday' | 'today' | 'tomorrow' for those days, else 'other'. */
export function relativeDay(day, now = new Date()) {
  const today = _local(now);
  if (day === today) return 'today';
  if (day === shiftDay(today, -1)) return 'yesterday';
  if (day === shiftDay(today, 1)) return 'tomorrow';
  return 'other';
}

/** "Thu, Oct 29" in the app's language (never "Today"). */
export function plainDay(day, lang) {
  if (!_ISO.test(day || '')) return day || '';
  const [y, m, d] = day.split('-').map(Number);
  try {
    return new Date(y, m - 1, d, 12).toLocaleDateString(lang || undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return day;
  }
}

/** The values a "{rel, select, ...}" message needs for `day`. */
export function dayValues(day, { now = new Date(), lang } = {}) {
  return { rel: relativeDay(day, now), day: plainDay(day, lang) };
}
