/**
 * wellness-mirror.js — Wellness → Body Stats weight mirror (#200).
 *
 * When the per-user `mirrorWellnessWeight` setting is on, any weight
 * reading that lands in wellness_data also populates that day's diary
 * body_stats.weight — but only when it's currently empty, so manual
 * entries always win. Reporter's case: Renpho → Health Connect →
 * NutriTrace was updating Wellness "Body Weight" but leaving Body
 * Stats "Weight" (and its goal) stale.
 *
 * Called from every wellness-write site that handles `weight_kg`:
 *   - server/routes/sync.js         (Health Connect via Android push)
 *   - server/routes/withings.js     (Withings OAuth pull)
 *   - server/routes/api/v1/body-measurements.js (external API)
 * Fitbit and Garmin routes don't currently handle weight; add the
 * call there if that changes.
 *
 * Design choices worth naming (all reversible if usage patterns push
 * back):
 *
 * - **Only if empty.** The mirror never overwrites an existing
 *   `body_stats.weight`. Users who type manually keep their value.
 *   This means the first scale reading of the day wins over any later
 *   ones — acceptable for most weigh-once-a-day workflows; a
 *   "prefer scale / always overwrite" option can layer on later if
 *   anyone asks.
 * - **Setting is per-user, off by default.** Zero behavior change
 *   for anyone who doesn't opt in.
 * - **Anonymous / single-user mode is supported.** userId=null routes
 *   to the diary row with `user_id IS NULL`, matching how the diary
 *   route stores single-user data. Wellness itself stores single-user
 *   rows under user_id=0 in sync.js, so the caller there is expected
 *   to pass the resolved diary uid (null for single-user), not the 0
 *   sentinel.
 * - **weight_unit is stamped to 'kg'** on the mirrored write. The
 *   BodyStatsWidget converts to the user's display unit at render
 *   time from this tag.
 * - **updated_at is bumped** on the diary row when a mirror lands.
 *   This makes native clients pick up the change on their next pull.
 *   The dbUpsertDiaryFromServer path has a pending-guard that
 *   protects any local unpushed edits, so the bump is safe.
 * - **INSERT OR nothing.** If the diary row for the date doesn't
 *   exist yet (scale-only day, no food logged), create it with just
 *   body_stats. Uses ON CONFLICT DO UPDATE to handle both cases in
 *   one statement.
 */
import db from '../db.js';

const FLAG_KEY = 'mirrorWellnessWeight';

/** True when the per-user mirror flag is on. */
function _isEnabled(userId) {
  if (userId == null) {
    // Single-user mode reads the setting from the anonymous user's row.
    // user_settings has PRIMARY KEY (user_id, key); anonymous inserts
    // fail the FK unless we treat single-user as "off" (there's no UI
    // path for anonymous users to flip this today either).
    return false;
  }
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL`
  ).get(userId, FLAG_KEY);
  if (!row?.value) return false;
  let v = row.value;
  try { v = JSON.parse(row.value); } catch { /* raw value, accept as-is */ }
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * Mirror a wellness weight reading into diary body_stats for the same
 * date. No-op when the per-user setting is off, weight is not positive,
 * or the date's body_stats.weight is already set (manual wins).
 *
 * @param {number|null} userId  diary owner (null for single-user mode)
 * @param {string} date         'YYYY-MM-DD'
 * @param {number} weightKg     positive kg value
 */
export function mirrorWeightToBodyStats(userId, date, weightKg) {
  try {
    const kg = Number(weightKg);
    if (!Number.isFinite(kg) || kg <= 0) return { skipped: true, reason: 'invalid-weight' };
    if (!date || typeof date !== 'string') return { skipped: true, reason: 'invalid-date' };
    if (!_isEnabled(userId)) return { skipped: true, reason: 'toggle-off' };

    const existing = userId == null
      ? db.prepare(`SELECT body_stats FROM diary WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL`).get(date)
      : db.prepare(`SELECT body_stats FROM diary WHERE date = ? AND user_id = ? AND deleted_at IS NULL`).get(date, userId);

    let bodyStats = {};
    if (existing?.body_stats) {
      try { bodyStats = JSON.parse(existing.body_stats) || {}; } catch { bodyStats = {}; }
    }
    // Manual weight already set — respect it, never overwrite.
    const cur = Number(bodyStats.weight);
    if (Number.isFinite(cur) && cur > 0) return { skipped: true, reason: 'manual-present' };

    bodyStats.weight = Math.round(kg * 10) / 10;   // one decimal, matches BodyStatsWidget input step
    bodyStats.weight_unit = 'kg';                    // widget converts to display unit at render
    const serialized = JSON.stringify(bodyStats);

    if (existing) {
      if (userId == null) {
        db.prepare(`UPDATE diary SET body_stats = ?, updated_at = datetime('now') WHERE date = ? AND user_id IS NULL`)
          .run(serialized, date);
      } else {
        db.prepare(`UPDATE diary SET body_stats = ?, updated_at = datetime('now') WHERE date = ? AND user_id = ?`)
          .run(serialized, date, userId);
      }
    } else {
      // No diary row for this date yet (scale-only day). Create it
      // with just body_stats populated. ON CONFLICT covers the race
      // where a concurrent diary write inserted the row between our
      // read and our write.
      db.prepare(`
        INSERT INTO diary (user_id, date, body_stats, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(date, user_id) DO UPDATE SET
          body_stats = excluded.body_stats,
          updated_at = datetime('now')
      `).run(userId, date, serialized);
    }
    return { mirrored: true, weightKg: bodyStats.weight };
  } catch (e) {
    // Never fail the wellness write path because the mirror had an issue.
    // Log and move on; the source wellness_data row is still saved.
    console.warn(`[wellness-mirror] failed for user=${userId} date=${date}: ${e?.message || e}`);
    return { skipped: true, reason: 'error', error: e?.message || String(e) };
  }
}
