/**
 * The days a person's weekly summary covers (#232).
 *
 * With First Day of Week set to Monday, Sunday or Saturday, the summary
 * covers the latest whole week that has ended by the day it's sent (that
 * day included when it's the week's last). With Automatic, or a setting
 * never saved, it returns null and the summary keeps its 7 days up to
 * today: the server can't see the device's locale, so it doesn't guess.
 */
import db from '../db.js';
import { weeklySummaryRange } from '../../src/lib/week.js';

/** Today as YYYY-MM-DD in a time zone; without one, the server's own date
 *  (the scheduler picks the send day by the server's clock then). */
export function todayIn(tz, now = new Date()) {
  if (tz) {
    try { return now.toLocaleDateString('sv-SE', { timeZone: tz }); } catch { /* unknown zone */ }
  }
  return now.toLocaleDateString('sv-SE');
}

/** The range for a setting and time zone at a moment, or null (pure, for tests). */
export function weeklyRangeFor(setting, tz, now = new Date()) {
  return weeklySummaryRange(setting, todayIn(tz, now));
}

function _setting(userId, key) {
  try {
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL').get(userId, key);
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

/** The range for a person now, or null for the 7 days up to today. */
export function userWeeklyRange(userId, now = new Date()) {
  return weeklyRangeFor(_setting(userId, 'firstDayOfWeek'), _setting(userId, 'timezone'), now);
}
