/**
 * goal-history-baseline.js — where a person's goal history starts.
 *
 * The server keeps one snapshot of the goal settings per person per local
 * calendar day (lib/goal-history.js). An account that has none gets one
 * snapshot of the settings in effect when its history begins, dated that
 * day in the account's own time zone, so a reader can tell "the target is
 * known from this day" from "before history": dates before it stay unknown
 * on purpose, because the settings of that time were never recorded.
 *
 * This lives apart from goal-history.js so the two callers that need a
 * baseline — the server's startup migration (db.js) and a full-backup
 * restore (routes/full-backup.js), which must do it inside its own
 * transaction — can share it without a module cycle through db.js. Both
 * hand in the database they use.
 */
import {
  GOAL_HISTORY_FIELDS,
  GOAL_HISTORY_KEYS,
  goalHistoryFieldTimes,
  goalSnapshot,
} from '../../src/lib/goal-snapshot.js';
import { fieldTime, instantMs, isoTime, readTimes } from './field-sync.js';
import { isValidTimeZone, processTimeZone, zonedParts } from './zoned-time.js';

/**
 * The goal configuration in effect now, and when each of its fields last
 * changed: the field's own edit time (user_settings.field_times) else when
 * the row was last written. A time later than `at` is capped to it, since
 * the snapshot describes the configuration as of `at`.
 *
 * A deleted setting is the app's default, in effect from the moment it was
 * deleted (field_times.deleted_at, else the row's deleted_at): a day changed
 * after that moment must not date the default to when it was captured, or a
 * late edit made between the two would lose to it.
 *
 * Returns { snapshot, field_times } — field_times keyed by snapshot field
 * name, as a plain object (empty when nothing is known).
 */
export function currentGoalState(db, userId, { at = Date.now() } = {}) {
  const rows = db.prepare(
    `SELECT key, value, deleted_at, field_times, updated_at FROM user_settings
      WHERE user_id = ? AND key IN (${GOAL_HISTORY_KEYS.map(() => '?').join(',')})`
  ).all(userId, ...GOAL_HISTORY_KEYS);
  const values = new Map();
  const settingTimes = {};
  for (const row of rows) {
    const times = readTimes(row.field_times);
    if (row.deleted_at) {
      const own = instantMs(times.deleted_at);
      const known = Number.isFinite(own) ? own : instantMs(row.deleted_at);
      if (Number.isFinite(known)) settingTimes[row.key] = isoTime(Math.min(known, at));
      continue; // the default, not the deleted value
    }
    try {
      const parsed = JSON.parse(row.value);
      if (parsed != null) values.set(row.key, parsed);
    } catch { /* a broken value reads as its default */ }
    const own = fieldTime(times, 'value');
    const known = Number.isFinite(own) ? own : instantMs(row.updated_at);
    if (Number.isFinite(known)) settingTimes[row.key] = isoTime(Math.min(known, at));
  }
  return { snapshot: goalSnapshot(values), field_times: goalHistoryFieldTimes(settingTimes) };
}

function _accountZone(db, userId) {
  try {
    const row = db.prepare(
      `SELECT value FROM user_settings WHERE user_id = ? AND key = 'timezone' AND deleted_at IS NULL`
    ).get(userId);
    try {
      const tz = row?.value ? JSON.parse(row.value) : null;
      return typeof tz === 'string' && isValidTimeZone(tz) ? tz : null;
    } catch { /* not a zone */ }
  } catch { /* no row */ }
  return null;
}

function _dateIn(db, userId, at, fallback) {
  const p = zonedParts(at, _accountZone(db, userId) || fallback);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The calendar date `at` falls on for the account, in the zone it chose.
 *  With no valid zone it is UTC, the same fixed fallback the app uses
 *  (src/lib/goal-snapshot.js goalDateInZone): the app sets its zone on
 *  first launch and syncs it, so the two agree even before that arrives. */
export function userDate(db, userId, at = Date.now()) {
  return _dateIn(db, userId, at, 'UTC');
}

/** The date the current (no-argument) goals answer has always used: the
 *  account's zone, else the server's own. Historical dates keep the UTC
 *  fallback (userDate) so a phone and the server name one day; this one
 *  stays as the response was before goal history existed. */
export function currentUserDate(db, userId, at = Date.now()) {
  return _dateIn(db, userId, at, processTimeZone());
}

/**
 * Record a baseline for an account that has no goal history yet: its
 * current configuration, effective from `at`'s date in its own zone.
 * Returns the date written, or null when it already had history.
 */
export function ensureGoalHistoryBaseline(db, userId, { at = Date.now(), source = 'migration_baseline' } = {}) {
  const has = db.prepare('SELECT 1 FROM goal_history WHERE user_id = ? LIMIT 1').get(userId);
  if (has) return null;
  const date = userDate(db, userId, at);
  const { snapshot, field_times } = currentGoalState(db, userId, { at });
  // Every field has a time from the start, so a later day inherits the same
  // when it inherits the value (captureGoalSnapshot).
  const times = {};
  for (const field of GOAL_HISTORY_FIELDS) times[field] = field_times[field] || isoTime(at);
  db.prepare(
    `INSERT INTO goal_history (user_id, effective_date, snapshot, field_times, changed_at, updated_at, source)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, effective_date) DO NOTHING`
  ).run(userId, date, JSON.stringify(snapshot), JSON.stringify(times), isoTime(at), source);
  return date;
}
