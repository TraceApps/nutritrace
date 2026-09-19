import db from '../db.js';

// ── Claim anonymous (single-user mode) data for the first real account ────
// Single-user mode has no users row, so every write lands under a sentinel
// owner instead of a real id. Creating the first account has to re-point
// that data at it, or the whole instance looks empty to the new admin
// (TraceApps/docs#2).
//
// Two sentinels exist, and both must be handled:
//   NULL — what `uid()` in routes/*.js writes for FK-bearing tables.
//   0    — what the wearable pollers (fitbit, google-health, withings,
//          garmin) write. Their tables deliberately carry no FK to
//          users(id), which is what lets 0 be stored at all.
//
// wellness_data and workouts receive BOTH: the pollers write 0 while the
// Android client's /api/sync push writes NULL. They also carry UNIQUE
// indexes that include user_id, so the two sets can collide once they land
// on the same owner. NULL is claimed first and the poller rows are then
// applied with OR REPLACE, so server-fetched wearable data wins over the
// phone's copy of the same metric rather than aborting the registration.
//
// Deliberately NOT claimed:
//   oauth_state  — short-lived CSRF state, not user data.
//   user_settings, api_tokens, food_shares, meal_shares, user_oidc_links,
//   password_reset_tokens — user_id is NOT NULL, so they are never
//   anonymous in the first place.
//
// There are two ways to become the first account (password registration and
// OIDC first-login bootstrap), so this lives here rather than in either
// route and both call it.
export const CLAIM_NULL = [
  'foods', 'meals', 'diary', 'diary_tombstones',
  'activity_log', 'fasts', 'ai_chat_history',
];
export const CLAIM_ZERO = [
  'fitbit_tokens', 'google_health_tokens', 'withings_tokens', 'garmin_tokens',
];
export const CLAIM_BOTH = ['wellness_data', 'workouts'];

const ORPHAN_EXTRA_COUNTS = [
  ...CLAIM_BOTH.map(t => `SELECT COUNT(*) AS c FROM ${t} WHERE user_id IS NULL OR user_id = 0`),
  ...CLAIM_ZERO.map(t => `SELECT COUNT(*) AS c FROM ${t} WHERE user_id = 0`),
];

export const claimAnonymousData = db.transaction((userId) => {
  for (const t of CLAIM_NULL) {
    db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`).run(userId);
  }
  for (const t of CLAIM_BOTH) {
    db.prepare(`UPDATE OR REPLACE ${t} SET user_id = ? WHERE user_id IS NULL`).run(userId);
    db.prepare(`UPDATE OR REPLACE ${t} SET user_id = ? WHERE user_id = 0`).run(userId);
  }
  for (const t of CLAIM_ZERO) {
    db.prepare(`UPDATE OR REPLACE ${t} SET user_id = ? WHERE user_id = 0`).run(userId);
  }
  // Re-enabling user management: clear the single_user_mode flag set by a
  // prior DELETE /management or POST /recover. Without this, /status keeps
  // reporting single_user_mode=true even though a real account now exists.
  db.prepare(`DELETE FROM app_config WHERE key = 'single_user_mode'`).run();
});

// ── One-time repair for instances that upgraded past the old bug ──────────
// The claim above only runs while the first account is being created, so an
// instance that enabled user management on an older build already has its
// single-user data stranded and will never get it back on its own.
//
// This is safe to run automatically because a NULL owner can only mean
// "written while the instance had no accounts". Deleting a user never
// produces one: the FK-bearing tables cascade the rows away, and the tables
// without an FK keep the departed user's id rather than going NULL.
//
// Guarded on there being exactly one account, which is the only situation
// where the rightful owner is unambiguous. Zero accounts is normal
// single-user mode and must be left alone; two or more means the rows
// cannot be attributed without asking a human, so they are reported and
// left in place.
export function countOrphanedRows() {
  let n = 0;
  for (const t of CLAIM_NULL) n += db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id IS NULL`).get().c;
  ORPHAN_EXTRA_COUNTS.forEach(sql => { n += db.prepare(sql).get().c; });
  return n;
}

export function repairOrphanedData() {
  const users = db.prepare('SELECT id FROM users').all();
  if (users.length === 0) return { repaired: 0, rows: 0 };   // single-user mode, nothing to do
  const rows = countOrphanedRows();
  if (rows === 0) return { repaired: 0, rows: 0 };
  if (users.length > 1) return { repaired: 0, rows, ambiguous: true };
  claimAnonymousData(users[0].id);
  return { repaired: users[0].id, rows };
}

// ── Purge what the FK cascade cannot reach, on disable ────────────────────
// DELETE /management drops every account and the confirmation dialog states
// the data cannot be recovered. Most tables honour that through ON DELETE
// CASCADE, but the ones below deliberately carry no FK to users(id) (that is
// what lets the wearable pollers store their 0 sentinel), so a plain user
// delete left them behind: wearable history, and live OAuth refresh tokens
// for an account the UI said was gone.
//
// Only rows owned by a real account are removed. Genuinely anonymous rows
// (NULL, or the 0 sentinel) belong to single-user mode, which is the state
// the instance is returning to, so they stay readable.
const NO_CASCADE_TABLES = [
  'wellness_data', 'workouts',
  'fitbit_tokens', 'google_health_tokens', 'withings_tokens', 'garmin_tokens',
  'oauth_state',
];

export const purgeUnreferencedUserData = db.transaction(() => {
  for (const t of NO_CASCADE_TABLES) {
    db.prepare(`DELETE FROM ${t} WHERE user_id IS NOT NULL AND user_id != 0`).run();
  }
});

/** Same purge, scoped to one account — for the admin "delete user" action,
 *  which otherwise leaves this user's rows (wearable history, live OAuth
 *  refresh tokens) behind because these tables have no FK to users(id). */
export const purgeUserRows = db.transaction((userId) => {
  for (const t of NO_CASCADE_TABLES) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
  }
});
