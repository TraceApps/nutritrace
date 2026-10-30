/**
 * two-step.js: built-in two-step sign-in (#222). A code from an
 * authenticator app (lib/totp.js) after the password, or one of ten
 * single-use recovery codes.
 *
 * - Secrets are locked with their own key (lib/two-step-key.js), never the
 *   sign-in secret. Recovery codes are kept only as hashes.
 * - The password step never signs anyone in when a code is due: it hands
 *   back a pending token that lasts minutes, is signed with a key of its
 *   own (so it is never a session, whatever it's sent to) and opens only
 *   the second step.
 * - A code works once: the newest step used is kept, and it and anything
 *   older is refused. One step either side of now is accepted.
 * - Wrong codes are limited per account, per address, and per pending token.
 * - Getting back in never takes SQL, and always means one account: a
 *   recovery code, an admin's reset, or the owner's RECOVERY_TOKEN or
 *   `npm run reset-2fa -- <username>`. Each is logged (never a secret or a
 *   code) and the person is emailed when the server sends email.
 *
 * Owns its two tables, made here, so the file (with lib/totp.js,
 * lib/two-step-key.js and routes/two-step.js) moves to another Trace app
 * as is. Both cascade with the account.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import qrcode from 'qrcode-generator';
import db from '../db.js';
import { logger } from '../logger.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { isEmailConfigured, sendTwoStepNotice } from '../email.js';
import { linkBase } from './public-url.js';
import { base32Encode, newSecret, otpauthUri, verifyTotp, cleanCode } from './totp.js';
import { sealSecret, openSecret, keyAvailable } from './two-step-key.js';
import { emailUnconfirmed } from './link-grant.js';

export const APP_NAME = 'NutriTrace';
export const RECOVERY_CODE_COUNT = 10;
export const PENDING_MINUTES = { verify: 5, setup: 15 };

db.exec(`
  CREATE TABLE IF NOT EXISTS user_two_step (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 0,
    last_step  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS user_two_step_recovery (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_two_step_recovery_user ON user_two_step_recovery(user_id);
`);

// The tables, for backup and restore (routes/full-backup.js).
export const TWO_STEP_TABLES = ['user_two_step', 'user_two_step_recovery'];

// ── State ─────────────────────────────────────────────────────────────────
function _row(userId) {
  return db.prepare('SELECT * FROM user_two_step WHERE user_id = ?').get(userId) || null;
}

export function isEnabled(userId) {
  return _row(userId)?.enabled === 1;
}

/** Whether the admin requires two-step sign-in for everyone who signs in with a password. */
export function isRequired() {
  const v = db.prepare(`SELECT value FROM app_config WHERE key = 'two_step_required'`).get()?.value;
  return v === 'true' || v === '1';
}

function _remaining(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM user_two_step_recovery WHERE user_id = ? AND used_at IS NULL').get(userId).n;
}

/** What Settings shows a person (never the secret). */
export function statusFor(user) {
  const row = _row(user.id);
  const enabled = row?.enabled === 1;
  let keyProblem = null;
  if (enabled) {
    const opened = openSecret(row.secret_enc, user.id);
    keyProblem = opened.problem || null;
  }
  return {
    enabled,
    enabled_at: enabled ? row.enabled_at : null,
    recovery_codes_left: enabled ? _remaining(user.id) : 0,
    has_password: !!user.password_hash,
    required: isRequired(),
    can_set_up: keyAvailable(),
    key_problem: keyProblem,
    // An email changed in Profile and not confirmed yet (lib/link-grant.js).
    email_unconfirmed: emailUnconfirmed(user),
  };
}

/**
 * What the password step asks for next: 'verify' (a code), 'setup' (the
 * admin requires two-step sign-in and this person hasn't set it up), or
 * null (sign in). Setup is skipped, and said in the log, when the server
 * can't keep secrets (a read-only data folder): requiring something that
 * can't be set up would lock everyone out.
 */
export function challengeFor(user) {
  if (!user?.password_hash) return null;
  if (isEnabled(user.id)) return 'verify';
  if (isRequired()) {
    if (keyAvailable()) return 'setup';
    logger.error(`[two-step] two-step sign-in is required, but the server can't save its key, so ${user.username} signed in without setting it up. Check that the data folder is writable, or set TWO_STEP_KEY.`);
  }
  return null;
}

// ── Pending tokens: between the password and the code ─────────────────────
const _pendingKey = (() => {
  const out = crypto.hkdfSync('sha256', Buffer.from(JWT_SECRET, 'utf8'), Buffer.from('traceapps.two-step.pending.v1'), Buffer.alloc(0), 32);
  return Buffer.from(out);
})();
const PENDING_TYP = 'two_step_pending';
const _pwv = (user) => crypto.createHash('sha256').update(String(user.password_hash || '')).digest('hex').slice(0, 16);

export function issuePending(user, kind) {
  return jwt.sign(
    { typ: PENDING_TYP, sub: String(user.id), kind, pwv: _pwv(user), jti: crypto.randomBytes(12).toString('hex') },
    _pendingKey,
    { expiresIn: `${PENDING_MINUTES[kind]}m`, algorithm: 'HS256' },
  );
}

/**
 * The account a pending token is for: { user, kind, jti } or { error }.
 * Refused when expired, of the wrong kind, used up by wrong codes, or when
 * the password or two-step state changed since it was given.
 */
export function readPending(token, kind) {
  const expired = { error: 'Your sign-in timed out. Enter your password again.', status: 401, restart: true };
  if (typeof token !== 'string' || !token) return expired;
  let p;
  try { p = jwt.verify(token, _pendingKey, { algorithms: ['HS256'] }); } catch { return expired; }
  if (p.typ !== PENDING_TYP || (kind && p.kind !== kind)) return expired;
  if (_spent.has(p.jti)) return expired;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(p.sub));
  if (!user || _pwv(user) !== p.pwv) return expired;
  // Still due? Reset since (verify), or set up elsewhere since (setup).
  if (challengeFor(user) !== p.kind) return expired;
  return { user, kind: p.kind, jti: p.jti, exp: p.exp };
}

// A pending token that took too many wrong codes, or that was used, is
// done: jti until it would have expired anyway.
const _spent = new Map(); // jti -> expires (ms)
export function spendPending(jti, exp) {
  _spent.set(jti, exp * 1000);
  if (_spent.size > 1000) { const now = Date.now(); for (const [k, v] of _spent) if (v < now) _spent.delete(k); }
}

// ── Wrong-code limits ─────────────────────────────────────────────────────
// Wrong codes only: someone signing in on several devices isn't slowed.
// Six digits, three steps accepted: at five a quarter hour an account would
// take years to guess into.
const WINDOW_MS = 15 * 60 * 1000;
export const LIMITS = { account: 5, ip: 10, pending: 5 };
const _fails = { account: new Map(), ip: new Map(), pending: new Map() };

function _count(map, key) {
  const e = map.get(key);
  if (!e || Date.now() > e.resetAt) return 0;
  return e.count;
}
function _bump(map, key) {
  const now = Date.now();
  const e = map.get(key);
  if (e && now < e.resetAt) e.count++;
  else map.set(key, { count: 1, resetAt: now + WINDOW_MS });
  if (map.size > 2000) for (const [k, v] of map) if (now > v.resetAt) map.delete(k);
}

/** Null when a code may be tried now, else the error to answer with (429). */
export function codeLimit({ userId, ip, jti }) {
  if (ip != null && _count(_fails.ip, ip) >= LIMITS.ip) return 'Too many wrong codes from this address. Try again in a few minutes.';
  if (userId != null && _count(_fails.account, userId) >= LIMITS.account) return 'Too many wrong codes for this account. Try again in 15 minutes.';
  if (jti != null && _count(_fails.pending, jti) >= LIMITS.pending) return 'Too many wrong codes. Enter your password again.';
  return null;
}
export function noteWrongCode({ userId, ip, jti }) {
  if (ip != null) _bump(_fails.ip, ip);
  if (userId != null) _bump(_fails.account, userId);
  if (jti != null) _bump(_fails.pending, jti);
}
/** Tests only. */
export function _resetLimitsForTests() { for (const m of Object.values(_fails)) m.clear(); _spent.clear(); _recoverFails = { count: 0, resetAt: 0 }; }

// ── Recovery codes ────────────────────────────────────────────────────────
// 16 characters from 31 easily told apart (no 0/o, 1/l/i): about 79 bits,
// so a plain salted hash is enough. Shown as xxxx-xxxx-xxxx-xxxx.
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function _recoveryCode() {
  let out = '';
  while (out.length < 16) {
    const b = crypto.randomBytes(1)[0];
    if (b < 248) out += RC_ALPHABET[b % 31]; // 248 = 31 * 8: no bias
  }
  return out.match(/.{4}/g).join('-');
}
const _normRecovery = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const _hashRecovery = (userId, code) => crypto.createHash('sha256').update(`traceapps.two-step.rc:${userId}:${_normRecovery(code)}`).digest('hex');

/** Looks like a recovery code (not six digits). */
export function looksLikeRecoveryCode(code) {
  return _normRecovery(code).length === 16;
}

function _newRecoveryCodes(userId) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, _recoveryCode);
  db.transaction(() => {
    db.prepare('DELETE FROM user_two_step_recovery WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_two_step_recovery (user_id, code_hash) VALUES (?, ?)');
    for (const c of codes) ins.run(userId, _hashRecovery(userId, c));
  })();
  return codes;
}

function _useRecoveryCode(userId, code) {
  if (!looksLikeRecoveryCode(code)) return false;
  const want = Buffer.from(_hashRecovery(userId, code), 'hex');
  const rows = db.prepare('SELECT id, code_hash FROM user_two_step_recovery WHERE user_id = ? AND used_at IS NULL').all(userId);
  let hit = null;
  for (const r of rows) {
    const have = Buffer.from(r.code_hash, 'hex');
    if (have.length === want.length && crypto.timingSafeEqual(have, want) && hit == null) hit = r.id;
  }
  if (hit == null) return false;
  // Two sign-ins racing with one code: only one marks it used.
  return db.prepare(`UPDATE user_two_step_recovery SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`).run(hit).changes === 1;
}

// ── Codes ─────────────────────────────────────────────────────────────────
export const KEY_PROBLEM_MESSAGE = "This server can't check codes from your authenticator app right now: the key that protects them changed or is missing. Sign in with a recovery code, or ask an admin to reset two-step sign-in for you.";

/**
 * Check a code for someone with two-step sign-in on: an authenticator code,
 * or a recovery code (used up here). { ok: true, via } or { ok: false,
 * error, keyProblem? }. Wrong codes count against the limits; the caller
 * checks codeLimit() first.
 */
export function checkCode(user, code, { ip = null, jti = null, req = null } = {}) {
  const row = _row(user.id);
  if (!row || row.enabled !== 1) return { ok: false, error: 'Two-step sign-in is off for this account.' };
  const given = cleanCode(code);
  if (looksLikeRecoveryCode(given)) {
    if (_useRecoveryCode(user.id, given)) {
      const left = _remaining(user.id);
      audit('recovery_code_used', user, { req, extra: `${left} left` });
      return { ok: true, via: 'recovery', recovery_codes_left: left };
    }
    noteWrongCode({ userId: user.id, ip, jti });
    return { ok: false, error: "That recovery code isn't right, or it was already used." };
  }
  const opened = openSecret(row.secret_enc, user.id);
  if (!opened.secret) {
    logger.error(`[two-step] can't open the secret of ${user.username} (${opened.problem}). They can sign in with a recovery code, or an admin can reset two-step sign-in.`);
    return { ok: false, error: KEY_PROBLEM_MESSAGE, keyProblem: opened.problem };
  }
  const step = verifyTotp(opened.secret, given, { lastStep: row.last_step });
  // Two requests racing with one code: only one moves last_step forward.
  if (step != null && db.prepare('UPDATE user_two_step SET last_step = ? WHERE user_id = ? AND last_step < ?').run(step, user.id, step).changes === 1) {
    return { ok: true, via: 'app' };
  }
  noteWrongCode({ userId: user.id, ip, jti });
  return { ok: false, error: "That code isn't right. Check your authenticator app and try again. A code works once." };
}

// ── Setup ─────────────────────────────────────────────────────────────────
function _qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * A new secret, waiting for its first code (setup isn't on until then).
 * Starting again replaces one that was never confirmed. Throws a plain
 * error when two-step sign-in is already on, or the key can't be saved.
 */
export function startSetup(user) {
  if (isEnabled(user.id)) throw Object.assign(new Error('Two-step sign-in is already on.'), { status: 409 });
  if (!keyAvailable()) {
    throw Object.assign(new Error("Two-step sign-in can't be set up: the server couldn't save its key. Ask your admin to check that the data folder is writable, or to set TWO_STEP_KEY."), { status: 503 });
  }
  const secret = newSecret();
  db.prepare(`INSERT INTO user_two_step (user_id, secret_enc, enabled, last_step) VALUES (?, ?, 0, 0)
              ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, enabled = 0, last_step = 0, created_at = datetime('now'), enabled_at = NULL`)
    .run(user.id, sealSecret(secret, user.id));
  const key = base32Encode(secret);
  const uri = otpauthUri({ issuer: APP_NAME, account: user.username, secret: key });
  return { secret: key, otpauth_uri: uri, qr: _qrDataUrl(uri) };
}

/** The first code turns it on: { recovery_codes } or { error }. */
export function confirmSetup(user, code, { ip = null, jti = null, req = null } = {}) {
  const row = _row(user.id);
  if (!row) return { error: 'Start setup again.', status: 400 };
  if (row.enabled === 1) return { error: 'Two-step sign-in is already on.', status: 409 };
  const opened = openSecret(row.secret_enc, user.id);
  if (!opened.secret) return { error: 'Start setup again.', status: 400 };
  const step = verifyTotp(opened.secret, code);
  if (step == null) {
    noteWrongCode({ userId: user.id, ip, jti });
    return { error: "That code isn't right. Check that the app shows NutriTrace and your phone's clock is set automatically, then try the newest code.", status: 400 };
  }
  db.prepare(`UPDATE user_two_step SET enabled = 1, last_step = ?, enabled_at = datetime('now') WHERE user_id = ?`).run(step, user.id);
  const codes = _newRecoveryCodes(user.id);
  audit('enabled', user, { req });
  return { recovery_codes: codes };
}

export function newRecoveryCodes(user, { req = null } = {}) {
  const codes = _newRecoveryCodes(user.id);
  audit('recovery_codes_replaced', user, { req });
  return codes;
}

/**
 * Turn it off: the secret and recovery codes go. `how` names who did it, for
 * the log and email. Returns whether it was on; a setup never finished is
 * cleared without a notice.
 */
export function turnOff(user, how, { req = null, by = null } = {}) {
  const wasOn = isEnabled(user.id);
  db.transaction(() => {
    db.prepare('DELETE FROM user_two_step WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM user_two_step_recovery WHERE user_id = ?').run(user.id);
  })();
  if (wasOn) audit(how, user, { req, by });
  return wasOn;
}

// ── RECOVERY_TOKEN ────────────────────────────────────────────────────────
// One check for both Locked Out? actions (reset two-step sign-in for one
// account, and disabling user management), so a cap on wrong tokens can't
// be walked around through the other. Constant time whatever the length
// typed; wrong tokens from every address count together, thirty a quarter
// hour (the command line, npm run reset-2fa, still works then).
export const RECOVER_GLOBAL_MAX = 30;
let _recoverFails = { count: 0, resetAt: 0 };
/** 'limited' | 'unset' | 'wrong' | 'ok' */
export function checkRecoveryToken(provided, { ip = null } = {}) {
  const now = Date.now();
  if (now > _recoverFails.resetAt) _recoverFails = { count: 0, resetAt: now + WINDOW_MS };
  if (_recoverFails.count >= RECOVER_GLOBAL_MAX) return 'limited';
  const token = process.env.RECOVERY_TOKEN || '';
  if (!token) return 'unset';
  const a = crypto.createHash('sha256').update(token, 'utf8').digest();
  const b = crypto.createHash('sha256').update(typeof provided === 'string' ? provided : '', 'utf8').digest();
  if (!crypto.timingSafeEqual(a, b)) {
    _recoverFails.count++;
    logger.warn(`[recover] wrong RECOVERY_TOKEN${ip ? ` from ${ip}` : ''}`);
    return 'wrong';
  }
  return 'ok';
}

/**
 * After a backup restore: who has two-step sign-in on now, said in the log,
 * since a restore can turn it on or off for anyone.
 */
export function logAfterRestore() {
  const on = db.prepare('SELECT u.username FROM user_two_step t JOIN users u ON u.id = t.user_id WHERE t.enabled = 1 ORDER BY u.username').all().map((r) => r.username);
  logger.info(`[two-step] after the restore, two-step sign-in is on for ${on.length ? on.join(', ') : 'nobody'}`);
}

// ── Log and email ─────────────────────────────────────────────────────────
const NOTICES = {
  enabled:                 { log: 'turned on',                                       title: 'Two-Step Sign-In Turned On',      say: 'Two-step sign-in was turned on for your NutriTrace account.' },
  disabled:                { log: 'turned off by its owner',                         title: 'Two-Step Sign-In Turned Off',     say: 'Two-step sign-in was turned off for your NutriTrace account.' },
  recovery_codes_replaced: { log: 'got new recovery codes (the old ones stopped working)', title: 'New Recovery Codes',          say: 'New recovery codes were made for your NutriTrace account. The old ones no longer work.' },
  recovery_code_used:      { log: 'signed in with a recovery code',                  title: 'Recovery Code Used',              say: 'Someone signed in to your NutriTrace account with one of your recovery codes.' },
  reset_by_admin:          { log: 'reset by an admin',                               title: 'Two-Step Sign-In Reset',          say: 'An admin reset two-step sign-in for your NutriTrace account. You can sign in with your password alone until you set it up again.' },
  reset_by_owner:          { log: 'reset with the RECOVERY_TOKEN',                   title: 'Two-Step Sign-In Reset',          say: "Two-step sign-in for your NutriTrace account was reset with the server's recovery token. You can sign in with your password alone until you set it up again." },
  reset_by_command:        { log: 'reset from the command line (npm run reset-2fa)', title: 'Two-Step Sign-In Reset',          say: "Two-step sign-in for your NutriTrace account was reset on the server. You can sign in with your password alone until you set it up again." },
};

/** Logs the event (no secrets, no codes) and emails the person when the server sends email. */
export function audit(event, user, { req = null, by = null, extra = '' } = {}) {
  const n = NOTICES[event];
  if (!n) return;
  const who = `${user.username} (id ${user.id})`;
  const parts = [`[two-step] ${who}: ${n.log}`];
  if (by) parts.push(`by ${by.username} (id ${by.id})`);
  if (extra) parts.push(`(${extra})`);
  if (req?.ip) parts.push(`from ${req.ip}`);
  logger.info(parts.join(' '));
  if (!user.email || !isEmailConfigured()) return;
  const base = linkBase(req);
  sendTwoStepNotice(user.email, { title: n.title, message: n.say, appUrl: base ? `${base}/` : '' })
    .catch((e) => logger.warn(`[two-step] notice email to ${who} failed: ${e?.message || e}`));
}

