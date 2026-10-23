/**
 * backup-schedule.js: when the scheduled backup runs, and what its file is
 * called, in the time zone of whoever set the schedule (TraceApps/notetrace#44).
 *
 * The schedule's time ("02:00") is the time on the clock of the browser that
 * saved it, so its zone is saved with it. A schedule saved before that (or by
 * an API client that sends none) runs in the server's own zone, as it always
 * has: TZ on the container, else UTC.
 *
 * One rule for when a backup is due, for "Next", and for the phone: the first
 * scheduled time (that wall-clock time, in that zone) at least half an
 * interval after the last run. So runs stay on the time set through clock
 * changes and zone changes, a run missed while the server was down happens
 * once, at the next check, and the schedule then carries on at its time.
 *
 * Shared by the Trace apps: keep it identical in each.
 */
import { isValidTimeZone, processTimeZone, scheduledInstantToday, nextScheduledInstant, zonedStamp, zonedOffsetMinutes, offsetSuffix } from './zoned-time.js';

const INTERVAL_DAYS = { daily: 1, weekly: 7, monthly: 28 };

/** The zone the schedule runs in: the one saved with it, else the server's. */
export function effectiveTimeZone(saved) {
  return isValidTimeZone(saved) ? saved : processTimeZone();
}

/**
 * When the scheduled backup is due, in ms, or null when off or the time is
 * bad: the first scheduled time at least half an interval after the last run.
 * Nothing run yet: the first scheduled time after the schedule was set
 * (setAt); with no record of that either (set before #44), it's due now.
 */
export function backupDueAt({ schedule, time, timeZone, lastAutoRun, setAt }, now = Date.now()) {
  const intervalDays = INTERVAL_DAYS[schedule];
  if (!intervalDays) return null;
  const zone = effectiveTimeZone(timeZone);
  const lastMs = lastAutoRun ? new Date(lastAutoRun).getTime() : NaN;
  if (Number.isFinite(lastMs)) return nextScheduledInstant({ now: lastMs, time, timeZone: zone, lastRun: lastMs, intervalDays });
  const setMs = setAt ? new Date(setAt).getTime() : NaN;
  if (Number.isFinite(setMs)) return nextScheduledInstant({ now: setMs, time, timeZone: zone });
  return scheduledInstantToday(new Date(now).getTime(), time, zone) == null ? null : new Date(now).getTime();
}

/** True when the scheduled backup should run now. */
export function isBackupDue(cfg, now = Date.now()) {
  const at = backupDueAt(cfg, now);
  return at != null && new Date(now).getTime() >= at;
}

/**
 * When the next scheduled backup runs, as an ISO string, or null when off.
 * One that is already due runs at the next check, so it says now.
 */
export function nextBackupAt(cfg, now = Date.now()) {
  const at = backupDueAt(cfg, now);
  if (at == null) return null;
  return new Date(Math.max(at, new Date(now).getTime())).toISOString();
}

/**
 * "YYYY-MM-DDTHH-MM-SS-0400" for a backup's file name: the time in the
 * schedule's zone, and its offset from UTC, so the name alone says when it
 * was made (the hour clocks go back happens twice, with two offsets).
 */
export function backupFileStamp(timeZone, now = Date.now()) {
  const zone = effectiveTimeZone(timeZone);
  return `${zonedStamp(now, zone)}${offsetSuffix(zonedOffsetMinutes(now, zone))}`;
}

/**
 * When a backup was made, from its file name, in ms; null when the name has
 * no time. Names from before #44 carry no offset and were always UTC.
 */
export function backupNameInstant(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:([+-])(\d{2})(\d{2}))?/.exec(String(name || ''));
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!Number.isFinite(wall)) return null;
  const off = m[7] ? (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]) : 0;
  return wall - off * 60_000;
}

/** Backup names, newest first: by the time in the name, else by the file's date. */
export function newestFirst(entries) {
  const at = (e) => backupNameInstant(e.name) ?? (Number(e.mtime) || 0);
  return [...entries].sort((a, b) => (at(b) - at(a)) || String(b.name).localeCompare(String(a.name)));
}
