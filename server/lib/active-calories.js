import db from '../db.js';

// Sum manually-logged activity calories for a user on a given date.
// Returns an integer; 0 if no entries.
export function sumManualActivity(userId, date) {
  const sql = userId == null
    ? `SELECT COALESCE(SUM(kcal), 0) AS s FROM activity_log
        WHERE user_id IS NULL AND date = ? AND deleted_at IS NULL`
    : `SELECT COALESCE(SUM(kcal), 0) AS s FROM activity_log
        WHERE user_id = ? AND date = ? AND deleted_at IS NULL`;
  const row = userId == null
    ? db.prepare(sql).get(date)
    : db.prepare(sql).get(userId, date);
  return Math.max(0, Math.round(row?.s || 0));
}

// Sum wearable active_calories for a date across all sources.
// Picks the highest single-source value to avoid double-counting when
// multiple integrations are connected (Fitbit + Garmin etc).
export function wearableActiveCalories(userId, date) {
  const sql = userId == null
    ? `SELECT MAX(value) AS v FROM wellness_data
        WHERE user_id IS NULL AND date = ? AND metric_type = 'active_calories'`
    : `SELECT MAX(value) AS v FROM wellness_data
        WHERE user_id = ? AND date = ? AND metric_type = 'active_calories'`;
  const row = userId == null
    ? db.prepare(sql).get(date)
    : db.prepare(sql).get(userId, date);
  return row?.v != null ? Math.max(0, Math.round(row.v)) : 0;
}

// Combine wearable + manual per the user's manualActivityPolicy.
// policy: 'wearable_wins' (default) | 'manual_wins' | 'additive'
export function effectiveActiveCalories(userId, date, policy = 'wearable_wins') {
  const wearable = wearableActiveCalories(userId, date);
  const manual = sumManualActivity(userId, date);
  if (!wearable) return manual;
  if (!manual) return wearable;
  switch (policy) {
    case 'manual_wins': return manual;
    case 'additive':    return wearable + manual;
    case 'wearable_wins':
    default:            return wearable;
  }
}
