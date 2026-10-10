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

// Default raised from 720h (30 days) to 8760h (1 year) on 2026-06-09 after
// users with biometric sign-in hit the silent 30-day token expiry. With
// biometric on, the JWT is essentially a refresh proxy — the actual auth
// gate is fingerprint/face on app open — so a 30-day expiry forces a
// password re-login every month without any security benefit. Admins who
// want shorter sessions still set Settings, Users, Session Duration.
const DEFAULT_SESSION_HOURS = 8760;

/** Sign a JWT for a user row */
export function signToken(user) {
  const cfg = db.prepare("SELECT value FROM app_config WHERE key = 'session_hours'").get();
  const hours = cfg?.value != null && cfg.value !== '' ? parseInt(cfg.value) : DEFAULT_SESSION_HOURS;
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
  const raw = cfg?.value != null && cfg.value !== '' ? parseInt(cfg.value) : DEFAULT_SESSION_HOURS;
  const hours = raw > 0 ? Math.min(raw, MAX_SESSION_HOURS) : MAX_SESSION_HOURS;
  return hours * 60 * 60 * 1000;
}

// A bearer token is ours when its signature verifies with our secret,
// expired or not: { user } (null once expired). Anything else (an API
// token, a reverse proxy's or identity provider's token) isn't: null.
// jsonwebtoken checks the signature before the times, so an expiry error
// means the signature held.
function _ourBearer(token) {
  try { return { user: jwt.verify(token, JWT_SECRET) }; } catch (e) {
    return e?.name === 'TokenExpiredError' || e?.name === 'NotBeforeError' ? { user: null } : null;
  }
}

/** Attach req.user from our bearer token or the session cookie (non-blocking).
 *  req.authVia says which one decided: 'bearer', 'cookie' or null. */
export function authenticate(req, res, next) {
  // Our token in the Authorization header decides: the Android app sends
  // the signed-in account's token there, and its HTTP layer can also carry
  // a cookie an earlier account's sign-in left behind. Expired, it is no
  // session, never the cookie's. A bearer that isn't ours (a reverse proxy
  // in front of the web app can add its own) is left alone, and the web
  // signs in with its cookie as before.
  const auth = req.headers.authorization;
  const ours = auth?.startsWith('Bearer ') ? _ourBearer(auth.slice(7)) : null;
  if (ours) { req.user = ours.user; req.authVia = 'bearer'; return next(); }
  const cookie = req.cookies?.nt_token;
  req.user = null;
  if (cookie) { try { req.user = jwt.verify(cookie, JWT_SECRET); } catch { /* no session */ } }
  req.authVia = req.user ? 'cookie' : null;
  next();
}

/** Require a logged-in user when user management is active; pass through otherwise */
export function requireAuth(req, res, next) {
  if (!userMgmtActive()) return next();           // single-user mode — always allow
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

/** Require admin role. When user management is off the whole admin/non-admin
 *  distinction is meaningless (the single user IS the owner), so pass through
 *  in that mode — mirrors requireAuth above. Without this, admin-gated routes
 *  like POST /api/full-backup are unreachable from single-user installs even
 *  though the frontend correctly identifies them as effectively-admin. */
export function requireAdmin(req, res, next) {
  if (!userMgmtActive()) return next();  // single-user mode = effectively admin
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
