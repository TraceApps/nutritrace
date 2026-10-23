/**
 * week.js: which day a week starts on, and the week math that follows.
 *
 * Adapted from CookTrace's src/lib/week.js (firstDayOfWeek, weekStartOf,
 * weekdayNames). This copy also takes the person's First Day of Week
 * setting (Settings > Regional & Units): 'auto', 'monday', 'sunday' or
 * 'saturday'. Automatic follows the device's locale.
 *
 * Days are counted as Date#getDay counts them: 0 Sunday, 1 Monday ... 6
 * Saturday. Anything stored by weekday (goals by weekday, fasting days, the
 * weekly summary day) stays indexed that way; the setting only changes the
 * order weeks are shown in and where a week begins.
 *
 * Dates are YYYY-MM-DD strings and the math runs on UTC midnights, so a
 * time zone or a daylight-saving change can never move a day. The server
 * imports this file too (the weekly summary), so nothing here may touch
 * the DOM at load.
 */

/** The setting's values, and the day each explicit one stands for. */
export const FIRST_DAY_SETTINGS = Object.freeze({ monday: 1, sunday: 0, saturday: 6 });
export const FIRST_DAY_DEFAULT = 'auto';

// Regions whose weeks don't start on Monday, for browsers without Intl
// weekInfo (Chrome before 99, Firefox and older Android WebViews). From
// CLDR's weekData as ICU has it (Node 26, 2026-10).
const SUNDAY_REGIONS = new Set(['AG', 'AS', 'BD', 'BR', 'BS', 'BT', 'BW', 'BZ', 'CA', 'CO', 'DM', 'DO', 'ET', 'GT', 'GU', 'HK', 'HN', 'ID', 'IL', 'IN', 'IS', 'JM', 'JP', 'KE', 'KH', 'KR', 'LA', 'MH', 'MM', 'MO', 'MT', 'MX', 'MZ', 'NI', 'NP', 'PA', 'PE', 'PH', 'PK', 'PR', 'PT', 'PY', 'SA', 'SG', 'SV', 'TH', 'TT', 'TW', 'UM', 'US', 'VE', 'VI', 'WS', 'YE', 'ZA', 'ZW']);
const SATURDAY_REGIONS = new Set(['AF', 'BH', 'DJ', 'DZ', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SD', 'SY']);
const FRIDAY_REGIONS = new Set(['MV']);
// A language's usual region, for a bare tag ("en", "ar") where Intl.Locale
// can't fill it in. Languages not listed fall back to Monday.
const LANGUAGE_REGION = { en: 'US', ar: 'EG', fa: 'IR', ps: 'AF', he: 'IL', ja: 'JP', ko: 'KR', pt: 'BR', hi: 'IN', bn: 'BD', th: 'TH', id: 'ID', ur: 'PK', km: 'KH', lo: 'LA', my: 'MM', ne: 'NP', am: 'ET', zu: 'ZA', dv: 'MV' };

function _regionFirstDay(region) {
  const r = String(region || '').toUpperCase();
  if (SUNDAY_REGIONS.has(r)) return 0;
  if (SATURDAY_REGIONS.has(r)) return 6;
  if (FRIDAY_REGIONS.has(r)) return 5;
  return 1;
}

/** The device's locale: the one the browser formats dates with (as every
 *  toLocaleDateString(undefined) in the app does), else navigator.language. */
export function deviceLocale() {
  try {
    const loc = new Intl.DateTimeFormat().resolvedOptions().locale;
    if (loc) return loc;
  } catch { /* no Intl: below */ }
  return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
}

/** The first day of the week for a locale (0 Sunday, 1 Monday ...). */
export function localeFirstDay(locale) {
  const tag = String(locale || deviceLocale() || 'en-US');
  try {
    const L = new Intl.Locale(tag);
    // getWeekInfo() is the current name, weekInfo the older getter; both
    // count 1 Monday ... 7 Sunday.
    const info = typeof L.getWeekInfo === 'function' ? L.getWeekInfo() : L.weekInfo;
    if (info && Number.isInteger(info.firstDay)) return info.firstDay % 7;
    const region = L.region || (typeof L.maximize === 'function' ? L.maximize().region : '') || LANGUAGE_REGION[L.language];
    return _regionFirstDay(region);
  } catch { /* no Intl.Locale, or an odd tag: read the tag itself */ }
  const m = /^([a-z]{2,3})(?:[-_][a-z]{4})?(?:[-_]([a-z]{2}))?\b/i.exec(tag);
  if (!m) return 1;
  return _regionFirstDay(m[2] || LANGUAGE_REGION[m[1].toLowerCase()]);
}

/** The day an explicit setting stands for, or null for Automatic (or anything unknown). */
export function explicitFirstDay(setting) {
  const key = String(setting ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(FIRST_DAY_SETTINGS, key) ? FIRST_DAY_SETTINGS[key] : null;
}

/** The first day of the week for a setting: the chosen day, or the locale's. */
export function resolveFirstDay(setting, locale) {
  const d = explicitFirstDay(setting);
  return d != null ? d : localeFirstDay(locale);
}

/** The seven weekdays (0 Sunday ...) in the order a week shows them. */
export function weekdayOrder(firstDay) {
  const f = ((Number(firstDay) % 7) + 7) % 7 || 0;
  return Array.from({ length: 7 }, (_, i) => (f + i) % 7);
}

/** A list indexed by weekday (0 Sunday ...), in the order a week shows it. */
export function inWeekOrder(byWeekday, firstDay) {
  return weekdayOrder(firstDay).map(d => byWeekday?.[d]);
}

const _utc = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const _iso = (dt) => dt.toISOString().slice(0, 10);

/** The weekday of a YYYY-MM-DD (0 Sunday ...). */
export function weekdayOf(iso) {
  return _utc(iso).getUTCDay();
}

/** A YYYY-MM-DD moved by n days. */
export function shiftIso(iso, n) {
  const dt = _utc(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return _iso(dt);
}

/** The first day of the week a YYYY-MM-DD falls in. */
export function weekStartIso(iso, firstDay) {
  return shiftIso(iso, -((weekdayOf(iso) - firstDay + 7) % 7));
}

/** The seven YYYY-MM-DD days of the week a date falls in, first day first. */
export function weekIsos(iso, firstDay) {
  const start = weekStartIso(iso, firstDay);
  return Array.from({ length: 7 }, (_, i) => shiftIso(start, i));
}

/** Empty cells before the 1st in a month grid (month 0-11). */
export function leadingBlanks(year, month, firstDay) {
  return (new Date(Date.UTC(year, month, 1)).getUTCDay() - firstDay + 7) % 7;
}

/**
 * The days a weekly summary sent on `todayIso` covers, for the person's
 * First Day of Week setting: the latest whole week that has ended by
 * today (today counts when it's the week's last day). Automatic returns
 * null: the server can't see the device's locale, so the summary keeps
 * covering the 7 days up to today, as it always has.
 */
export function weeklySummaryRange(setting, todayIso) {
  const firstDay = explicitFirstDay(setting);
  if (firstDay == null || !/^\d{4}-\d{2}-\d{2}$/.test(String(todayIso || ''))) return null;
  const start = weekStartIso(todayIso, firstDay);
  const end = shiftIso(start, 6);
  if (end === todayIso) return { from: start, to: end };
  return { from: shiftIso(start, -7), to: shiftIso(start, -1) };
}
