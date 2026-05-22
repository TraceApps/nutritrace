import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { wrap } from '../logger.js';
import { signToken, sessionMaxAge, userMgmtActive, requireAuth, requireAdmin } from '../middleware/auth.js';
import { listProviders as oidcListProviders, publicProvider as oidcPublicProvider, isPasswordLoginEnabled, listUserLinks } from '../lib/oidc.js';
import { sendPasswordReset, sendInvite, isEmailConfigured } from '../email.js';
import { estimate as estimatePasswordStrength, STRONG_MIN_SCORE } from '../lib/password-strength.js';

const router = Router();

function validatePassword(pw, userInputs = []) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must include a number';
  if (!/[^a-zA-Z0-9]/.test(pw)) return 'Password must include a special character';
  // When the admin enabled the strong-policy app_config, also enforce zxcvbn
  // score >= STRONG_MIN_SCORE. Default policy ('standard' / null) keeps the
  // existing rules only.
  const policy = db.prepare(`SELECT value FROM app_config WHERE key = 'password_policy'`).get()?.value;
  if (policy === 'strong') {
    const r = estimatePasswordStrength(pw, userInputs);
    if (r.score < STRONG_MIN_SCORE) {
      const tip = r.feedback?.warning || r.feedback?.suggestions?.[0] || 'Use a longer, less predictable password';
      return `Password is too weak: ${tip}`;
    }
  }
  return null;
}

// In-memory rate limiters for auth endpoints. Two independent buckets so an
// attacker behind multiple IPs can't get unlimited tries against one username,
// and a shared NAT can't lock everyone out of one account.
const _ipAttempts   = new Map(); // ip → { count, resetAt }
const _userAttempts = new Map(); // username → { count, resetAt }
const WINDOW_MS = 15 * 60 * 1000; // 15-min window
const IP_MAX    = 10;
const USER_MAX  = 5;

function _bumpBucket(map, key, max) {
  const now = Date.now();
  const entry = map.get(key);
  if (entry && now < entry.resetAt) {
    entry.count++;
    if (entry.count > max) return false;
  } else {
    map.set(key, { count: 1, resetAt: now + WINDOW_MS });
  }
  if (map.size > 1000) {
    for (const [k, v] of map) { if (now > v.resetAt) map.delete(k); }
  }
  return true;
}

function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const username = (req.body?.username || '').trim().toLowerCase();
  if (!_bumpBucket(_ipAttempts, ip, IP_MAX)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' });
  }
  if (username && !_bumpBucket(_userAttempts, username, USER_MAX)) {
    return res.status(429).json({ error: 'Too many login attempts for this account. Try again later.' });
  }
  next();
}

// Default to secure cookies (HTTPS-only) since most production deploys are
// behind a reverse proxy or Cloudflare Tunnel. Self-hosters running on plain
// HTTP (LAN, dev) can opt out with INSECURE_COOKIES=1 — they should be aware
// that auth cookies will be sent in cleartext.
const _insecureCookies = process.env.INSECURE_COOKIES === '1' || process.env.INSECURE_COOKIES === 'true';
if (_insecureCookies) {
  console.warn('[WARN] INSECURE_COOKIES=1 — auth cookies will be sent over plain HTTP. Only use this on a trusted LAN.');
}
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
  secure:   !_insecureCookies,
};

function safeUser(u) {
  const { password_hash, ...rest } = u;
  // Linked OIDC providers + password-set flag — surfaced so the Profile page
  // can render badges and the Unlink/Link UI without an extra round-trip.
  let linked_providers = [];
  try { linked_providers = listUserLinks(u.id); } catch {}
  return { ...rest, has_password: !!password_hash, linked_providers };
}

// ── Status: is user management active? ────────────────────────────────────
router.get('/status', wrap((req, res) => {
  const active = userMgmtActive();
  // setup_required tells the client whether to force the wizard's
  // mandatory account-creation step. Two cases without users:
  //   1) Fresh install — no users, no flag, setup IS required.
  //   2) Single-user mode — user explicitly disabled user management; the
  //      `single_user_mode` flag is set so the client knows not to force
  //      another account-creation pass. Fixes #34 — disabling user
  //      management was re-triggering the wizard on every load because
  //      setup_required was just `!active`, which didn't distinguish
  //      between these two cases.
  const singleUser = db.prepare(`SELECT value FROM app_config WHERE key = 'single_user_mode'`).get()?.value === '1';
  // Surface OIDC providers + password-login flag for the Login page to use.
  const providers = oidcListProviders({ activeOnly: true }).map(oidcPublicProvider);
  const policy = db.prepare(`SELECT value FROM app_config WHERE key = 'password_policy'`).get()?.value || 'standard';
  res.json({
    active,
    setup_required: !active && !singleUser,
    single_user_mode: singleUser,
    oidc: { providers, enable_email_password_login: isPasswordLoginEnabled() },
    password_policy: policy,                  // 'standard' | 'strong'
    password_min_score: policy === 'strong' ? STRONG_MIN_SCORE : 0,
  });
}));

// ── Server-controlled feature flags surfaced to the client UI ────────────
// Off-by-default so the public build doesn't expose half-baked features;
// operators flip these on per-deployment via env vars.
function _serverFeatures() {
  return {
    apiTokens: process.env.NT_FEATURES_API === '1',
  };
}

// ── Who am I? ─────────────────────────────────────────────────────────────
router.get('/me', wrap((req, res) => {
  const features = _serverFeatures();
  if (!req.user) return res.json({ user: null, csrf: null, features });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: user ? safeUser(user) : null, csrf: req.user.csrf || null, features });
}));

// ── Login ──────────────────────────────────────────────────────────────────
router.post('/login', rateLimitLogin, wrap((req, res) => {
  if (!isPasswordLoginEnabled()) {
    return res.status(403).json({ error: 'Password login is disabled. Use Single Sign-On instead.' });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signToken(user);
  const cookieOpts = { ...COOKIE_OPTS, maxAge: sessionMaxAge() };
  res.cookie('nt_token', token, cookieOpts);
  res.json({ user: safeUser(user), token });
}));

// ── Logout ─────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('nt_token');
  res.json({ ok: true });
});

// ── Register (admin only, or first user = auto-admin) ─────────────────────
router.post('/register', wrap((req, res) => {
  const isFirst = !userMgmtActive();

  // Only first registration is open; subsequent require admin JWT
  if (!isFirst && (!req.user || req.user.role !== 'admin')) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const { username, password, full_name, nickname, birthday, gender, role, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  { const pwErr = validatePassword(password, [username, email, full_name].filter(Boolean)); if (pwErr) return res.status(400).json({ error: pwErr }); }

  const hash = bcrypt.hashSync(password, 12);
  const assignedRole = isFirst ? 'admin' : (role === 'admin' ? 'admin' : 'user');

  const result = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, nickname, birthday, gender, role, email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    username.trim().toLowerCase(), hash,
    full_name || null, nickname || null, birthday || null, gender || null, assignedRole,
    email ? email.trim().toLowerCase() : null
  );

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);

  // First user: claim all existing data (user_id = NULL → new admin's id)
  if (isFirst) {
    db.prepare('UPDATE foods SET user_id = ? WHERE user_id IS NULL').run(user.id);
    db.prepare('UPDATE meals SET user_id = ? WHERE user_id IS NULL').run(user.id);
    db.prepare('UPDATE diary SET user_id = ? WHERE user_id IS NULL').run(user.id);
    // Re-enabling user management: clear the single_user_mode flag set by
    // a prior DELETE /management or POST /recover. Without this, /status
    // would still report single_user_mode=true even with a real user.
    db.prepare(`DELETE FROM app_config WHERE key = 'single_user_mode'`).run();
    res.cookie('nt_token', signToken(user), COOKIE_OPTS);
  }

  res.json({ user: safeUser(user) });
}));

// ── Update own profile ─────────────────────────────────────────────────────
router.put('/profile', requireAuth, wrap((req, res) => {
  const { full_name, nickname, birthday, gender, avatar_url, email } = req.body;
  db.prepare(
    `UPDATE users SET full_name=?, nickname=?, birthday=?, gender=?, avatar_url=?, email=? WHERE id=?`
  ).run(full_name || null, nickname || null, birthday || null, gender || null, avatar_url || null,
        email ? email.trim().toLowerCase() : null, req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: safeUser(user) });
}));

// ── Change / set own password ──────────────────────────────────────────────
// OIDC-only users (no password_hash) can use this endpoint to *set* their
// first password without supplying current_password. Existing-password users
// still need to verify with their current one.
router.put('/password', requireAuth, wrap((req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'New password required' });
  { const pwErr = validatePassword(new_password); if (pwErr) return res.status(400).json({ error: pwErr }); }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.password_hash) {
    if (!current_password) return res.status(400).json({ error: 'Current password required' });
    if (!bcrypt.compareSync(current_password, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 12), req.user.id);
  // Rotate JWT (and its CSRF token) so existing sessions on other devices stop working.
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.cookie('nt_token', signToken(updated), { ...COOKIE_OPTS, maxAge: sessionMaxAge() });
  res.json({ ok: true });
}));

// ── List peers for the sharing picker ─────────────────────────────────────
// Only exposed when sharing is enabled — otherwise instance-wide user enumeration
// is unnecessary and leaks membership to every account.
router.get('/users/list', requireAuth, wrap((req, res) => {
  const cfg = db.prepare("SELECT value FROM app_config WHERE key = 'sharing_enabled'").get();
  if (cfg?.value !== 'true' && cfg?.value !== '1') return res.json([]);
  const peers = db.prepare('SELECT id, full_name, username FROM users WHERE id != ? ORDER BY full_name, username').all(req.user.id);
  res.json(peers.map(u => ({ id: u.id, name: u.full_name || u.username })));
}));

// ── Admin: list users ──────────────────────────────────────────────────────
router.get('/users', requireAuth, requireAdmin, wrap((req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at').all().map(safeUser);
  res.json(users);
}));

// ── Self-service: delete own account ───────────────────────────────────────
router.delete('/me', requireAuth, wrap((req, res) => {
  const userId = req.user.id;
  // Prevent the last admin from deleting themselves (would lock out the instance)
  const admins = db.prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'admin'`).get();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (user?.role === 'admin' && admins.count <= 1) {
    return res.status(400).json({ error: 'Cannot delete the only admin account. Transfer admin to another user first.' });
  }
  // CASCADE handles foods, meals, diary, settings, wellness_data, ai_chat_history, etc.
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.clearCookie('nt_token');
  res.json({ ok: true });
}));

// ── Admin: count what a user owns (informational, drives delete confirmation) ─
router.get('/users/:id/data-counts', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Each count is a "how much would CASCADE delete" preview. Tables that
  // don't exist on older deploys (or were renamed) just return 0 silently.
  const _count = (sql, ...params) => {
    try { return db.prepare(sql).get(...params)?.c ?? 0; }
    catch { return 0; }
  };
  res.json({
    username: user.username,
    foods:        _count('SELECT COUNT(*) c FROM foods   WHERE user_id = ?', id),
    meals:        _count(`SELECT COUNT(*) c FROM meals   WHERE user_id = ? AND is_recipe = 0`, id),
    recipes:      _count(`SELECT COUNT(*) c FROM meals   WHERE user_id = ? AND is_recipe = 1`, id),
    diary_days:   _count('SELECT COUNT(*) c FROM diary   WHERE user_id = ?', id),
    wellness_data: _count('SELECT COUNT(*) c FROM wellness_data WHERE user_id = ?', id),
    activities:   _count('SELECT COUNT(*) c FROM activity_log   WHERE user_id = ?', id),
    workouts:     _count('SELECT COUNT(*) c FROM workouts       WHERE user_id = ?', id),
  });
}));

// ── Admin: delete user ─────────────────────────────────────────────────────
router.delete('/users/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Don't let an admin delete the only other admin if they're the only ones
  // left — would lock the instance into a single-admin state where any future
  // self-delete via /me would create a no-admin situation. (Defensive — /me
  // already guards this, but doing it here keeps the explicit error visible.)
  if (target.role === 'admin') {
    const adminCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin'`).get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only admin account.' });
    }
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
}));

// ── Admin: reset another user's password ──────────────────────────────────
router.put('/users/:id/password', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { new_password } = req.body;
  { const pwErr = validatePassword(new_password); if (pwErr) return res.status(400).json({ error: pwErr }); }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 12), id);
  res.json({ ok: true });
}));

// ── Admin: change another user's role (user | admin) ──────────────────────
router.put('/users/:id/role', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });
  // Last-admin guard — refuse to demote the only admin and lock the instance out.
  if (role !== 'admin') {
    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
    if (target?.role === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get();
      if (admins.count <= 1) {
        return res.status(400).json({ error: 'Cannot demote the only admin. Promote another user to admin first.' });
      }
    }
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  res.json({ ok: true });
}));

// ── Admin: disable user management (delete all users) ─────────────────────
router.delete('/management', requireAuth, requireAdmin, wrap((req, res) => {
  db.prepare('DELETE FROM users').run();
  // Remember this was an intentional disable, not a fresh install — so
  // /status returns setup_required=false and the client doesn't re-route
  // to the wizard's mandatory account-creation step. Cleared on next
  // /register so re-enabling user management Just Works.
  db.prepare(`INSERT INTO app_config (key, value) VALUES ('single_user_mode', '1')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  res.clearCookie('nt_token');
  res.json({ ok: true });
}));

// ── Lockout recovery: disable user management without credentials ──────────
// Requires RECOVERY_TOKEN env var to prevent unauthenticated account wipes.
router.post('/recover', rateLimitLogin, wrap((req, res) => {
  if (req.user) return res.status(400).json({ error: 'You are already signed in. Use Settings to disable user management.' });
  const token = process.env.RECOVERY_TOKEN;
  if (!token) return res.status(503).json({ error: 'Recovery not available. Set RECOVERY_TOKEN environment variable.' });
  // Constant-time comparison to defeat timing-attack guesses against the token.
  const provided = req.body?.token || '';
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Invalid recovery token.' });
  }
  db.prepare('DELETE FROM users').run();
  // Same single-user-mode flag as DELETE /management (intentional disable,
  // not a fresh install). Without this the lockout-recovery path also
  // re-triggers the wizard on next load.
  db.prepare(`INSERT INTO app_config (key, value) VALUES ('single_user_mode', '1')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  res.clearCookie('nt_token');
  res.json({ ok: true });
}));

// ── Forgot password ────────────────────────────────────────────────────────
// Always returns 200 (after a small constant delay) so an unauthenticated caller
// can't enumerate users, fingerprint instances by their SMTP-configured state,
// or learn anything about whether the email exists by timing the response.
router.post('/forgot-password', rateLimitLogin, wrap(async (req, res) => {
  const startedAt = Date.now();
  const { email } = req.body;
  const respondOk = async () => {
    // Pad to ~400ms so DB-lookup and email-send timing don't leak existence.
    const elapsed = Date.now() - startedAt;
    if (elapsed < 400) await new Promise(r => setTimeout(r, 400 - elapsed));
    res.json({ ok: true });
  };
  if (!email) return respondOk();
  if (!isEmailConfigured()) return respondOk();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return respondOk();

  // Invalidate any existing tokens for this user
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    await sendPasswordReset(user.email, `${baseUrl}/#/reset-password?token=${token}`);
  } catch (e) {
    // Don't surface email-send errors to the client — it would leak existence.
    // The token is still issued; the admin can investigate the email backend.
  }
  return respondOk();
}));

// ── Reset password (via token) ─────────────────────────────────────────────
router.post('/reset-password', wrap((req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  { const pwErr = validatePassword(password); if (pwErr) return res.status(400).json({ error: pwErr }); }

  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
  if (!row || row.used) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Reset link has expired' });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').run(token);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  res.cookie('nt_token', signToken(user), COOKIE_OPTS);
  res.json({ user: safeUser(user) });
}));

// ── Admin: create invite ───────────────────────────────────────────────────
router.post('/invite', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { email, role = 'user' } = req.body;

  // Refuse if the email is already registered — silently sending an invite
  // to an existing user would let the recipient create a second account.
  if (email) {
    const normalized = email.trim().toLowerCase();
    const existing = db.prepare('SELECT username FROM users WHERE LOWER(email) = ?').get(normalized);
    if (existing) {
      return res.status(409).json({
        error: `An account with that email already exists (username: ${existing.username}). They can sign in directly or use Forgot Password.`,
      });
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
  db.prepare('INSERT INTO invite_tokens (token, email, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, email ? email.trim().toLowerCase() : null, role, req.user.id, expires);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const inviteUrl = `${baseUrl}/#/accept-invite?token=${token}`;

  if (email && isEmailConfigured()) {
    const inviter = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const inviterName = inviter?.nickname || inviter?.full_name || inviter?.username || 'An admin';
    await sendInvite(email, inviteUrl, inviterName);
    res.json({ ok: true, sent: true, inviteUrl });
  } else {
    res.json({ ok: true, sent: false, inviteUrl });
  }
}));

// ── Admin: list pending invites (not used, not expired) ───────────────────
router.get('/invites', requireAuth, requireAdmin, wrap((req, res) => {
  const rows = db.prepare(
    `SELECT token, email, role, expires_at, created_by
     FROM invite_tokens
     WHERE used = 0 AND expires_at > datetime('now')
     ORDER BY expires_at DESC`
  ).all();
  res.json(rows);
}));

// ── Admin: revoke a pending invite ────────────────────────────────────────
router.delete('/invites/:token', requireAuth, requireAdmin, wrap((req, res) => {
  const result = db.prepare('DELETE FROM invite_tokens WHERE token = ?').run(req.params.token);
  if (result.changes === 0) return res.status(404).json({ error: 'Invite not found' });
  res.json({ ok: true });
}));

// ── Accept invite ──────────────────────────────────────────────────────────
router.post('/accept-invite', wrap((req, res) => {
  const { token, username, password, full_name } = req.body;
  if (!token || !username || !password) return res.status(400).json({ error: 'Token, username and password required' });
  { const pwErr = validatePassword(password); if (pwErr) return res.status(400).json({ error: pwErr }); }

  const invite = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(token);
  if (!invite || invite.used) return res.status(400).json({ error: 'Invalid or already used invite link' });
  if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invite link has expired' });

  // Belt-and-suspenders: re-check email isn't taken since the invite was created.
  if (invite.email) {
    const existing = db.prepare('SELECT username FROM users WHERE LOWER(email) = ?').get(invite.email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    }
  }

  const hash = bcrypt.hashSync(password, 12);
  const result = db.prepare(
    `INSERT INTO users (username, password_hash, full_name, role, email)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    username.trim().toLowerCase(), hash,
    full_name || null, invite.role,
    invite.email || null
  );

  db.prepare('UPDATE invite_tokens SET used = 1 WHERE token = ?').run(token);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.cookie('nt_token', signToken(user), COOKIE_OPTS);
  res.json({ user: safeUser(user) });
}));

// ── Validate a token (reset or invite) without consuming it ───────────────
router.get('/validate-token', wrap((req, res) => {
  const { token, type } = req.query;
  if (!token || !type) return res.status(400).json({ error: 'token and type required' });

  if (type === 'reset') {
    const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
    if (!row || row.used || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Invalid or expired link' });
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(row.user_id);
    return res.json({ ok: true, username: user?.username });
  }

  if (type === 'invite') {
    const row = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(token);
    if (!row || row.used || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Invalid or expired link' });
    return res.json({ ok: true, email: row.email || null, role: row.role });
  }

  res.status(400).json({ error: 'Unknown token type' });
}));

export default router;
