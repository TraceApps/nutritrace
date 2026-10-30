/**
 * session-version.js: signing every other device out (nutritrace#222).
 *
 * A session is a signed token that lasts up to a year, so on its own it
 * can't be taken back: a stolen one kept working after a password change.
 * Each account now has a number, session_version, and every session carries
 * the number it was made with (`sv`). The sign-in check (middleware/auth.js)
 * compares the two on every request, cookie, header or image address
 * alike, and a session with an old number is no session.
 *
 * The number goes up when the password changes (in Profile, by an emailed
 * reset link, or by an admin), when two-step sign-in is turned on or off or
 * reset (by an admin, the RECOVERY_TOKEN or npm run reset-2fa), and with
 * Sign Out Everywhere. The device that made the change is given a new
 * session in the same answer, so only the others sign out.
 *
 * A session from before this has no `sv` and counts as 0, the number every
 * account starts with, so nobody is signed out by the upgrade itself.
 * API tokens and MCP tokens are separate credentials with their own Revoke:
 * this never touches them.
 *
 * No settings and no app name: the same file serves every Trace app.
 */
import db from '../db.js';
import { logger } from '../logger.js';

if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'session_version')) {
  db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
}

const _get = db.prepare('SELECT session_version, role FROM users WHERE id = ?');

/** The account's number now: 0 for an account that never changed it. */
export function sessionVersion(userId) {
  return _get.get(userId)?.session_version ?? 0;
}

/**
 * The session as it stands now: { session, ended }. `session` is null when
 * it is no longer good: the account is gone, or its number moved on since
 * the session was made. `ended` is only the second, signed out on purpose:
 * an account that's gone (or a server switched to no accounts) isn't
 * "signed out on this device". The role comes from the account, so a
 * changed role holds at once.
 */
export function checkSession(payload) {
  if (!payload || typeof payload !== 'object') return { session: null, ended: false };
  const row = _get.get(payload.id);
  if (!row) return { session: null, ended: false };
  const sv = Number.isInteger(payload.sv) ? payload.sv : 0;
  if (sv !== (row.session_version ?? 0)) return { session: null, ended: true };
  return { session: row.role && row.role !== payload.role ? { ...payload, role: row.role } : payload, ended: false };
}

/**
 * Signs out every session the account has: its number goes up. `why` is
 * for the log. Returns the new number.
 */
export function bumpSessionVersion(userId, why, { by = null, req = null } = {}) {
  db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(userId);
  const v = sessionVersion(userId);
  const parts = [`[sessions] user id ${userId}: every session signed out (${why})`];
  if (by) parts.push(`by ${by.username} (id ${by.id})`);
  if (req?.ip) parts.push(`from ${req.ip}`);
  logger.info(parts.join(' '));
  return v;
}

/**
 * A backup restore puts the accounts back. `fn` does the restore;
 * afterwards each account keeps the highest number it had here, in the
 * backup (`restored`: the backup's users rows), or since, so a session
 * signed out before the restore, here or on the server the backup came
 * from, stays signed out.
 */
export function keepSessionVersions(fn, restored = []) {
  const before = db.prepare('SELECT id, session_version FROM users').all();
  const out = fn();
  const keep = db.prepare('UPDATE users SET session_version = MAX(session_version, ?) WHERE id = ?');
  for (const r of [...before, ...(Array.isArray(restored) ? restored : [])]) {
    const v = Number(r?.session_version);
    if (r?.id != null && Number.isInteger(v) && v > 0) keep.run(v, r.id);
  }
  return out;
}
