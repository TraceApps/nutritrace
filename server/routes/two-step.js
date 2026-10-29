/**
 * /api/auth/two-step: two-step sign-in (#222). lib/two-step.js has the rules.
 *
 *   GET  /status                  Settings: on or off, recovery codes left
 *   POST /setup/start             a new secret and QR code (password, or a pending setup token)
 *   POST /setup/confirm           the first code turns it on: the recovery codes
 *   POST /verify                  sign-in, second step: a code or a recovery code
 *   POST /disable                 turn it off (password and a code)
 *   POST /recovery-codes          new recovery codes (password and a code)
 *   POST /users/:id/reset         an admin resets it for someone else (own password)
 *   POST /recover                 the owner resets it for one account with RECOVERY_TOKEN
 *
 * Everything under /api/auth skips the CSRF middleware (it's where sessions
 * start), so the routes a session uses check the CSRF token themselves.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { wrap, logger } from '../logger.js';
import { userMgmtActive } from '../middleware/auth.js';
import { isPasswordLoginEnabled } from '../lib/oidc.js';
import { finishSignIn, rateLimitLogin } from './auth.js';
import {
  statusFor, readPending, spendPending, codeLimit, noteWrongCode, checkCode,
  startSetup, confirmSetup, newRecoveryCodes, turnOff, isEnabled, checkRecoveryToken,
} from '../lib/two-step.js';

const router = Router();

const NO_PASSWORD = 'Two-step sign-in is for signing in with a password. Your single sign-on provider handles its own.';

// The signed-in account, read fresh. Null when there's no session (or the
// server has no accounts: two-step sign-in needs them).
function _sessionUser(req) {
  if (!userMgmtActive() || !req.user?.id) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) || null;
}

// A browser session (cookie) sends its CSRF token; the app's bearer can't
// be forged by a page.
function _csrfOk(req) {
  if (req.authVia !== 'cookie' || !req.user?.csrf) return true;
  return req.headers['x-csrf-token'] === req.user.csrf;
}

function _session(req, res) {
  const user = _sessionUser(req);
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return null; }
  if (!_csrfOk(req)) { res.status(403).json({ error: 'Invalid CSRF token' }); return null; }
  return user;
}

function _passwordOk(user, password) {
  return !!(user.password_hash && typeof password === 'string' && password && bcrypt.compareSync(password, user.password_hash));
}

// Password and code, for turning it off and for new recovery codes. Wrong
// ones count against the account's limit. Null when both are right, else
// the answer was sent.
// Wrong ones count against the account only, not the address: behind a
// reverse proxy everyone can share one address, and someone signed in
// shouldn't be able to block everyone else's sign-in from it.
function _passwordAndCode(req, res, user) {
  const ip = null;
  const limited = codeLimit({ userId: user.id, ip });
  if (limited) { res.status(429).json({ error: limited }); return false; }
  const { password, code } = req.body || {};
  if (!_passwordOk(user, password)) {
    noteWrongCode({ userId: user.id, ip });
    res.status(401).json({ error: 'Your password is incorrect.' });
    return false;
  }
  const r = checkCode(user, code, { ip, req });
  if (!r.ok) { res.status(r.keyProblem ? 409 : 401).json({ error: r.error, key_problem: r.keyProblem || null }); return false; }
  return true;
}

// ── Settings ─────────────────────────────────────────────────────────────
router.get('/status', wrap((req, res) => {
  const user = _sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(statusFor(user));
}));

// Who is setting up: someone signed in (who gives their password again), or
// someone mid sign-in whom the admin requires to set it up (pending token).
function _setupUser(req, res) {
  const pending = req.body?.pending_token;
  if (pending) {
    const p = readPending(pending, 'setup');
    if (p.error) { res.status(401).json({ error: p.error, restart: true }); return null; }
    return p;
  }
  const user = _session(req, res);
  if (!user) return null;
  return { user };
}

router.post('/setup/start', wrap((req, res) => {
  const who = _setupUser(req, res);
  if (!who) return;
  const { user } = who;
  if (!user.password_hash) return res.status(400).json({ error: NO_PASSWORD });
  if (!who.jti) {
    const limited = codeLimit({ userId: user.id });
    if (limited) return res.status(429).json({ error: limited });
    if (!_passwordOk(user, req.body?.password)) {
      noteWrongCode({ userId: user.id });
      return res.status(401).json({ error: 'Your password is incorrect.' });
    }
  }
  try {
    res.json(startSetup(user));
  } catch (e) {
    if (!e.status) throw e;
    res.status(e.status).json({ error: e.message });
  }
}));

router.post('/setup/confirm', wrap((req, res) => {
  const who = _setupUser(req, res);
  if (!who) return;
  const { user, jti, exp } = who;
  // Mid sign-in, the address counts too; signed in, the account only.
  const ip = jti ? req.ip : null;
  if (jti && !isPasswordLoginEnabled()) return res.status(403).json({ error: 'Password login is disabled. Use Single Sign-On instead.', restart: true });
  const limited = codeLimit({ userId: user.id, ip, jti });
  if (limited) return res.status(429).json({ error: limited });
  const r = confirmSetup(user, req.body?.code, { ip, jti, req });
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  if (jti) {
    // Set up while signing in: this finishes the sign-in.
    spendPending(jti, exp);
    return finishSignIn(req, res, user, { recovery_codes: r.recovery_codes });
  }
  res.json({ recovery_codes: r.recovery_codes });
}));

router.post('/disable', wrap((req, res) => {
  const user = _session(req, res);
  if (!user) return;
  if (!isEnabled(user.id)) return res.status(400).json({ error: 'Two-step sign-in is already off.' });
  if (!_passwordAndCode(req, res, user)) return;
  turnOff(user, 'disabled', { req });
  res.json({ ok: true });
}));

router.post('/recovery-codes', wrap((req, res) => {
  const user = _session(req, res);
  if (!user) return;
  if (!isEnabled(user.id)) return res.status(400).json({ error: 'Two-step sign-in is off.' });
  if (!_passwordAndCode(req, res, user)) return;
  res.json({ recovery_codes: newRecoveryCodes(user, { req }) });
}));

// ── Sign-in, second step ─────────────────────────────────────────────────
router.post('/verify', wrap((req, res) => {
  const p = readPending(req.body?.pending_token, 'verify');
  if (p.error) return res.status(401).json({ error: p.error, restart: true });
  // Password login turned off since the password step: no sign-in by it.
  if (!isPasswordLoginEnabled()) return res.status(403).json({ error: 'Password login is disabled. Use Single Sign-On instead.', restart: true });
  const { user, jti, exp } = p;
  const limited = codeLimit({ userId: user.id, ip: req.ip, jti });
  if (limited) {
    // This pending token took its share of wrong codes: back to the password.
    const spent = codeLimit({ jti }) != null;
    if (spent) spendPending(jti, exp);
    return res.status(429).json({ error: limited, restart: spent });
  }
  const r = checkCode(user, req.body?.code, { ip: req.ip, jti, req });
  if (!r.ok) return res.status(r.keyProblem ? 409 : 401).json({ error: r.error, key_problem: r.keyProblem || null });
  spendPending(jti, exp);
  finishSignIn(req, res, user, r.via === 'recovery' ? { recovery_codes_left: r.recovery_codes_left } : {});
}));

// ── Getting back in: an admin ────────────────────────────────────────────
// For someone else (their own goes through Settings, with a code). The
// admin gives their own password, and their own code when they have
// two-step sign-in on, so a session left open isn't enough.
router.post('/users/:id/reset', wrap((req, res) => {
  const admin = _session(req, res);
  if (!admin) return;
  if (admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  if (id === admin.id) return res.status(400).json({ error: "You can't reset your own two-step sign-in here. Turn it off in Settings, Profile, or sign in with a recovery code." });
  const target = Number.isInteger(id) ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
  if (!target) return res.status(404).json({ error: 'User not found' });
  const limited = codeLimit({ userId: admin.id });
  if (limited) return res.status(429).json({ error: limited });
  if (!_passwordOk(admin, req.body?.password)) {
    noteWrongCode({ userId: admin.id });
    return res.status(401).json({ error: 'Your password is incorrect.' });
  }
  if (isEnabled(admin.id)) {
    const r = checkCode(admin, req.body?.code, { req });
    if (!r.ok) return res.status(r.keyProblem ? 409 : 401).json({ error: r.error, key_problem: r.keyProblem || null, code_required: true });
  }
  if (!turnOff(target, 'reset_by_admin', { req, by: admin })) {
    return res.status(400).json({ error: 'Two-step sign-in is already off for this person.' });
  }
  res.json({ ok: true });
}));

// ── Getting back in: the owner, with RECOVERY_TOKEN ──────────────────────
// The Login page's Locked Out? box. Resets one account, nothing else.
// Limited per address and per username (rateLimitLogin), and wrong tokens
// from every address together (lib/two-step.js checkRecoveryToken, shared
// with disabling user management). A token too short to be safe isn't
// taken for this; the log says why, the page only that it's unavailable.
const MIN_RECOVERY_TOKEN = 16;

router.post('/recover', rateLimitLogin, wrap((req, res) => {
  const configured = process.env.RECOVERY_TOKEN || '';
  if (configured && configured.length < MIN_RECOVERY_TOKEN) {
    logger.warn(`[two-step] RECOVERY_TOKEN is shorter than ${MIN_RECOVERY_TOKEN} characters, so it can't reset two-step sign-in. Use a longer one (openssl rand -hex 24), or npm run reset-2fa on the server.`);
    return res.status(503).json({ error: 'Recovery not available. Set RECOVERY_TOKEN environment variable.' });
  }
  const check = checkRecoveryToken(req.body?.token, { ip: req.ip });
  if (check === 'limited') return res.status(429).json({ error: 'Too many wrong recovery tokens. Try again later, or use npm run reset-2fa on the server.' });
  if (check === 'unset') return res.status(503).json({ error: 'Recovery not available. Set RECOVERY_TOKEN environment variable.' });
  if (check !== 'ok') return res.status(403).json({ error: 'Invalid recovery token.' });
  const username = String(req.body?.username || '').trim().toLowerCase();
  const user = username ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
  if (!user) return res.status(404).json({ error: 'No account has that username.' });
  if (!turnOff(user, 'reset_by_owner', { req })) {
    return res.status(400).json({ error: 'Two-step sign-in is already off for that account.' });
  }
  res.json({ ok: true });
}));

export default router;
