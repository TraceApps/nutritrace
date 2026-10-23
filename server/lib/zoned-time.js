/**
 * zoned-time.js: wall-clock times in an IANA time zone, with nothing but Intl
 * (Node carries its own zone data, so this works without tzdata in the image).
 *
 * The backup schedule says "02:00" in the zone of whoever set it; the server
 * runs in its own zone (TZ, else UTC). These helpers turn one into the other,
 * across daylight saving changes: a time that doesn't exist that day (02:30
 * when clocks skip from 02:00 to 03:00) runs at the first moment after the
 * skip, and a time that happens twice (01:30 when clocks go back) runs once,
 * the first time.
 *
 * Shared by the Trace apps: keep it identical in each.
 */

const MINUTE = 60_000;
const _formatters = new Map();

function _fmt(timeZone) {
  let f = _formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    _formatters.set(timeZone, f);
  }
  return f;
}

/** The IANA zone this process runs in (TZ, else UTC on a container). */
export function processTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

/** True for a zone Intl knows, such as "America/New_York" or "UTC". */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try { _fmt(timeZone).format(0); return true; }
  catch { return false; }
}

/** The wall clock in a zone at an instant: { year, month, day, hour, minute, second }. */
export function zonedParts(date, timeZone) {
  const out = {};
  for (const p of _fmt(timeZone).formatToParts(new Date(date))) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}

// Milliseconds the zone is ahead of UTC at an instant (whole seconds).
function _offset(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function _same(ms, timeZone, y, mo, d, h, mi) {
  const p = zonedParts(ms, timeZone);
  return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi;
}

/**
 * The instant a zone's wall clock shows y-mo-d h:mi. Twice that day (clocks
 * going back): the first. Never that day (clocks skipping ahead): the first
 * moment after the skip.
 */
export function zonedTimeToInstant(y, mo, d, h, mi, timeZone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offsets = new Set([_offset(wall - 36 * 60 * MINUTE, timeZone), _offset(wall, timeZone), _offset(wall + 36 * 60 * MINUTE, timeZone)]);
  const hits = [...offsets].map(off => wall - off).filter(t => _same(t, timeZone, y, mo, d, h, mi));
  if (hits.length) return Math.min(...hits);
  // Skipped: the moment the clock jumps, between the two readings of that wall time.
  let lo = Math.min(...[...offsets].map(off => wall - off));
  let hi = Math.max(...[...offsets].map(off => wall - off));
  const before = (t) => {
    const p = zonedParts(t, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) < wall;
  };
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (before(mid)) lo = mid; else hi = mid;
  }
  return hi;
}

function _hhmm(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  return h <= 23 && mi <= 59 ? [h, mi] : null;
}

/** Today's (in that zone) instant for a "HH:MM" time, or null for a bad time. */
export function scheduledInstantToday(now, time, timeZone) {
  const hm = _hhmm(time);
  if (!hm) return null;
  const p = zonedParts(now, timeZone);
  return zonedTimeToInstant(p.year, p.month, p.day, hm[0], hm[1], timeZone);
}

/**
 * The next run for a schedule: the first day's "HH:MM" in the zone that is
 * after now and, once something has run, at least intervalDays (less half a
 * day) after the last run. Null for a bad time.
 */
export function nextScheduledInstant({ now = Date.now(), time, timeZone, lastRun = null, intervalDays = 1 }) {
  const hm = _hhmm(time);
  if (!hm) return null;
  const nowMs = new Date(now).getTime();
  const lastMs = lastRun ? new Date(lastRun).getTime() : NaN;
  const p = zonedParts(nowMs, timeZone);
  // Walk calendar days in the zone (a day isn't always 24 hours there).
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const t = zonedTimeToInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hm[0], hm[1], timeZone);
    if (t <= nowMs) continue;
    if (Number.isFinite(lastMs) && (t - lastMs) / 86_400_000 < intervalDays - 0.5) continue;
    return t;
  }
  return null;
}

/** Minutes a zone is ahead of UTC at an instant (-240 for New York in summer). */
export function zonedOffsetMinutes(date, timeZone) {
  return Math.round(_offset(new Date(date).getTime(), timeZone) / MINUTE);
}

/** "+0530" / "-0400" for an offset in minutes. */
export function offsetSuffix(minutes) {
  const m = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

/** "YYYY-MM-DDTHH-MM-SS" for a file name, in a zone's wall-clock time. */
export function zonedStamp(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}-${two(p.minute)}-${two(p.second)}`;
}
