import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { wrap } from '../logger.js';
import { signToken, sessionMaxAge, userMgmtActive, requireAuth, requireAdmin } from '../middleware/auth.js';
import { sendPasswordReset, sendInvite, isEmailConfigured } from '../email.js';

const router = Router();

function validatePassword(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must include a number';
  if (!/[^a-zA-Z0-9]/.test(pw)) return 'Password must include a special character';
  return null;
}

// Simple in-memory rate limiter for auth endpoints (no external dependency)
const _loginAttempts = new Map(); // ip → { count, resetAt }
function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = _loginAttempts.get(ip);
  if (entry && now < entry.resetAt) {
    entry.count++;
    if (entry.count > 10) { // 10 attempts per 15-min window
      return res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' });
    }
  } else {
    _loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  }
  // Cleanup stale entries periodically
  if (_loginAttempts.size > 1000) {
    for (const [k, v] of _loginAttempts) { if (now > v.resetAt) _loginAttempts.delete(k); }
  }
  next();
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
  secure:   process.env.NODE_ENV === 'production',
};

function safeUser(u) {
  const { password_hash, ...rest } = u;
  return rest;
}

// ── Status: is user management active? ────────────────────────────────────
router.get('/status', wrap((req, res) => {
  res.json({ active: userMgmtActive() });
}));

// ── Who am I? ─────────────────────────────────────────────────────────────
router.get('/me', wrap((req, res) => {
  if (!req.user) return res.json({ user: null, csrf: null });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: user ? safeUser(user) : null, csrf: req.user.csrf || null });
}));

// ── Login ──────────────────────────────────────────────────────────────────
router.post('/login', rateLimitLogin, wrap((req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
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
  { const pwErr = validatePassword(password); if (pwErr) return res.status(400).json({ error: pwErr }); }

  const hash = bcrypt.hashSync(password, 10);
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

// ── Change own password ────────────────────────────────────────────────────
router.put('/password', requireAuth, wrap((req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  { const pwErr = validatePassword(new_password); if (pwErr) return res.status(400).json({ error: pwErr }); }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  res.json({ ok: true });
}));

// ── Any user: list peers (id + display name) for sharing picker ───────────
router.get('/users/list', requireAuth, wrap((req, res) => {
  const peers = db.prepare('SELECT id, full_name, username FROM users WHERE id != ? ORDER BY full_name, username').all(req.user.id);
  res.json(peers.map(u => ({ id: u.id, name: u.full_name || u.username })));
}));

// ── Admin: list users ──────────────────────────────────────────────────────
router.get('/users', requireAuth, requireAdmin, wrap((req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at').all().map(safeUser);
  res.json(users);
}));

// ── Admin: delete user ─────────────────────────────────────────────────────
router.delete('/users/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
}));

// ── Admin: reset another user's password ──────────────────────────────────
router.put('/users/:id/password', requireAuth, requireAdmin, wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { new_password } = req.body;
  { const pwErr = validatePassword(new_password); if (pwErr) return res.status(400).json({ error: pwErr }); }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), id);
  res.json({ ok: true });
}));

// ── Admin: disable user management (delete all users) ─────────────────────
router.delete('/management', requireAuth, requireAdmin, wrap((req, res) => {
  db.prepare('DELETE FROM users').run();
  res.clearCookie('nt_token');
  res.json({ ok: true });
}));

// ── Lockout recovery: disable user management without credentials ──────────
// Requires RECOVERY_TOKEN env var to prevent unauthenticated account wipes.
router.post('/recover', rateLimitLogin, wrap((req, res) => {
  if (req.user) return res.status(400).json({ error: 'You are already signed in. Use Settings to disable user management.' });
  const token = process.env.RECOVERY_TOKEN;
  if (!token) return res.status(503).json({ error: 'Recovery not available. Set RECOVERY_TOKEN environment variable.' });
  if (req.body?.token !== token) return res.status(403).json({ error: 'Invalid recovery token.' });
  db.prepare('DELETE FROM users').run();
  res.clearCookie('nt_token');
  res.json({ ok: true });
}));

// ── Forgot password ────────────────────────────────────────────────────────
router.post('/forgot-password', rateLimitLogin, wrap(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!isEmailConfigured()) return res.status(503).json({ error: 'Email not configured on this server. Contact your administrator.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  // Always return success to avoid leaking whether the email exists
  if (!user) return res.json({ ok: true });

  // Invalidate any existing tokens for this user
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  await sendPasswordReset(user.email, `${baseUrl}/#/reset-password?token=${token}`);
  res.json({ ok: true });
}));

// ── Reset password (via token) ─────────────────────────────────────────────
router.post('/reset-password', wrap((req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  { const pwErr = validatePassword(password); if (pwErr) return res.status(400).json({ error: pwErr }); }

  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
  if (!row || row.used) return res.status(400).json({ error: 'Invalid or expired reset link' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Reset link has expired' });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').run(token);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  res.cookie('nt_token', signToken(user), COOKIE_OPTS);
  res.json({ user: safeUser(user) });
}));

// ── Admin: create invite ───────────────────────────────────────────────────
router.post('/invite', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { email, role = 'user' } = req.body;

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

// ── Accept invite ──────────────────────────────────────────────────────────
router.post('/accept-invite', wrap((req, res) => {
  const { token, username, password, full_name } = req.body;
  if (!token || !username || !password) return res.status(400).json({ error: 'Token, username and password required' });
  { const pwErr = validatePassword(password); if (pwErr) return res.status(400).json({ error: pwErr }); }

  const invite = db.prepare('SELECT * FROM invite_tokens WHERE token = ?').get(token);
  if (!invite || invite.used) return res.status(400).json({ error: 'Invalid or already used invite link' });
  if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invite link has expired' });

  const hash = bcrypt.hashSync(password, 10);
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
