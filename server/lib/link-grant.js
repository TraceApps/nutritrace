/**
 * link-grant.js: linking a sign-in provider to an account takes a fresh
 * check first (#222).
 *
 * A session alone used to be enough to start Profile > Linked Accounts >
 * Link. Anyone holding a stolen or leaked session could link their own
 * identity provider account and from then on sign in with it: no password,
 * no two-step code, and still in after a password change or a reset. Now
 * the account's password (and its two-step code when that's on) buys a
 * grant from POST /api/auth/two-step/link-grant, and only a grant starts
 * the link (routes/oidc.js, GET /login/:id?link=1&link_grant=...).
 *
 * A grant:
 *   - is random, kept only as a hash, for one account;
 *   - lasts LINK_GRANT_MINUTES and works once (taken when the link starts,
 *     so a copied link address can't start a second one);
 *   - stops working when the account's password changes, or its sessions
 *     are signed out (lib/session-version.js).
 *
 * The link is also tied to the browser that started it: routes/oidc.js sets
 * a cookie holding a random value and keeps only its hash with the sign-in
 * state, and the callback links only for that browser. Someone who starts a
 * link with their own grant and sends the provider's address to someone
 * else can't link that person's provider to their account.
 *
 * An email changed with a session alone is held back the same way: until
 * the account confirms it (password, and code when two-step sign-in is on),
 * single sign-on never links to the account by that email, and a password
 * reset goes to the address it had before. Otherwise a stolen session could
 * set its own email and sign in through its own provider from then on.
 *
 * No settings and no app name: the same file serves every Trace app.
 */
import crypto from 'node:crypto';
import db from '../db.js';

export const LINK_GRANT_MINUTES = 5;
// An account with no password (single sign-on only) has nothing to type:
// its fresh check is a sign-in this recent.
export const FRESH_SIGN_IN_MINUTES = 15;

db.exec(`
  CREATE TABLE IF NOT EXISTS user_email_changes (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email          TEXT,
    previous_email TEXT,
    changed_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oidc_link_grants (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pwv        TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
`);

const _hash = (token) => crypto.createHash('sha256').update(`traceapps.link-grant:${token}`).digest('hex');
// The password and the session number: either changing ends a grant.
const _pwv = (user) => crypto.createHash('sha256').update(`${user.password_hash || ''}|${user.session_version ?? 0}`).digest('hex').slice(0, 16);

/** A new grant for this account: the token, shown once. */
export function issueLinkGrant(user) {
  const now = Date.now();
  db.prepare('DELETE FROM oidc_link_grants WHERE expires_at < ? OR used_at IS NOT NULL').run(now);
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO oidc_link_grants (token_hash, user_id, pwv, expires_at) VALUES (?, ?, ?, ?)')
    .run(_hash(token), user.id, _pwv(user), now + LINK_GRANT_MINUTES * 60 * 1000);
  return token;
}

/**
 * Takes a grant: the account it was given to, or null (unknown, expired,
 * used already, or the password changed since). Two requests racing with
 * one grant: only one gets the account.
 */
export function consumeLinkGrant(token) {
  if (typeof token !== 'string' || !token || token.length > 200) return null;
  const now = Date.now();
  const h = _hash(token);
  const row = db.prepare('SELECT * FROM oidc_link_grants WHERE token_hash = ?').get(h);
  if (!row || row.used_at != null || row.expires_at < now) return null;
  if (db.prepare('UPDATE oidc_link_grants SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now, h).changes !== 1) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || _pwv(user) !== row.pwv) return null;
  return user;
}

/**
 * Whether a session was signed in recently enough to count as a fresh
 * check. A session given again without a sign-in (a password change, Sign
 * Out Everywhere) carries the time of the sign-in it came from (auth_time).
 */
export function freshSignIn(session, nowMs = Date.now()) {
  const iat = Number(session?.auth_time ?? session?.iat);
  return Number.isFinite(iat) && nowMs / 1000 - iat <= FRESH_SIGN_IN_MINUTES * 60 && nowMs / 1000 - iat >= -60;
}

/** A browser binding for a link: the cookie's value, and the hash kept with the state. */
export function newLinkBinding() {
  const value = crypto.randomBytes(24).toString('base64url');
  return { value, hash: _hash(`binding:${value}`) };
}

/** Whether the cookie a callback came with is the one its link started with. */
export function linkBindingMatches(value, hash) {
  if (typeof value !== 'string' || !value || typeof hash !== 'string' || !hash) return false;
  const a = Buffer.from(_hash(`binding:${value}`), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── An email changed with a session alone ────────────────────────────────
const _norm = (email) => (email ? String(email).trim().toLowerCase() : null);

/**
 * The account's email changed through Profile: unconfirmed until
 * confirmEmail(). The address before the first unconfirmed change is kept,
 * for password resets meanwhile. Changing it back is no change.
 */
export function noteEmailChange(userId, previousEmail, email) {
  const prev = _norm(previousEmail), next = _norm(email);
  if (prev === next) return;
  const row = db.prepare('SELECT * FROM user_email_changes WHERE user_id = ?').get(userId);
  const confirmed = row ? row.previous_email : prev;
  if (next === confirmed) { db.prepare('DELETE FROM user_email_changes WHERE user_id = ?').run(userId); return; }
  db.prepare(`INSERT INTO user_email_changes (user_id, email, previous_email, changed_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, changed_at = excluded.changed_at`)
    .run(userId, next, confirmed, Date.now());
}

/** Whether this account's email is one it hasn't confirmed yet. */
export function emailUnconfirmed(user) {
  if (!user?.email) return false;
  const row = db.prepare('SELECT email FROM user_email_changes WHERE user_id = ?').get(user.id);
  return !!row && row.email === _norm(user.email);
}

/** The account confirmed its email (or an admin set it). */
export function confirmEmail(userId) {
  db.prepare('DELETE FROM user_email_changes WHERE user_id = ?').run(userId);
}

/**
 * Who a password reset for this email is for, and where it goes: { user,
 * to } or null. An unconfirmed email gets nothing; the address the account
 * had before it (typed or not) gets the reset.
 */
export function resetRecipient(email) {
  const e = _norm(email);
  if (!e) return null;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  if (user && !emailUnconfirmed(user)) return { user, to: user.email };
  const row = user
    ? db.prepare('SELECT * FROM user_email_changes WHERE user_id = ?').get(user.id)
    : db.prepare('SELECT * FROM user_email_changes WHERE previous_email = ?').get(e);
  if (!row?.previous_email) return null;
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!owner || !emailUnconfirmed(owner)) return null;
  return { user: owner, to: row.previous_email };
}
