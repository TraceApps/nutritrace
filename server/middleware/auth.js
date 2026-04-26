import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import db from '../db.js';

// In production, refuse to start without an explicit JWT_SECRET — silently falling
// back to a known default would mean every deploy ships forgeable tokens.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is required in production. Generate one with: openssl rand -base64 48');
  process.exit(1);
}
export const JWT_SECRET = process.env.JWT_SECRET || 'nutritrace-dev-secret-change-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET not set — using insecure dev default. Set JWT_SECRET in your environment for production.');
}

/** Returns true if user management is active (at least one user exists) */
export function userMgmtActive() {
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() != null;
}

/** Sign a JWT for a user row */
export function signToken(user) {
  const cfg = db.prepare("SELECT value FROM app_config WHERE key = 'session_hours'").get();
  const hours = cfg?.value != null && cfg.value !== '' ? parseInt(cfg.value) : 720;
  const opts = hours > 0 ? { expiresIn: `${hours}h` } : {};
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, csrf: crypto.randomBytes(16).toString('hex') },
    JWT_SECRET,
    opts
  );
}

/** Read session maxAge for cookies (in ms). 0 = max-allowed (default 1 year). */
const MAX_SESSION_HOURS = parseInt(process.env.MAX_SESSION_HOURS || '8760'); // 1 year default cap
export function sessionMaxAge() {
  const cfg = db.prepare("SELECT value FROM app_config WHERE key = 'session_hours'").get();
  const raw = cfg?.value != null && cfg.value !== '' ? parseInt(cfg.value) : 720;
  const hours = raw > 0 ? Math.min(raw, MAX_SESSION_HOURS) : MAX_SESSION_HOURS;
  return hours * 60 * 60 * 1000;
}

/** Attach req.user if a valid JWT cookie is present (non-blocking) */
export function authenticate(req, res, next) {
  // Accept token from cookie OR Authorization: Bearer header (mobile apps use the header)
  let token = req.cookies?.nt_token;
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  }
  if (!token) { req.user = null; return next(); }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

/** Require a logged-in user when user management is active; pass through otherwise */
export function requireAuth(req, res, next) {
  if (!userMgmtActive()) return next();           // single-user mode — always allow
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

/** Require admin role */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
