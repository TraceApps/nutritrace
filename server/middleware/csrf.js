import { userMgmtActive } from './auth.js';

const SAFE_METHODS  = new Set(['GET', 'HEAD', 'OPTIONS']);
// Login/logout/register don't need CSRF — they're how you get a token in the first place
const SKIP_PREFIXES = ['/api/auth/'];

/**
 * CSRF protection for cookie-based (PWA) sessions.
 *
 * Strategy: synchronizer token embedded in the JWT.
 * - Bearer token requests are inherently CSRF-safe (attacker can't set headers via HTML form/img).
 * - Single-user mode has no auth cookies, so CSRF isn't relevant.
 * - Old JWTs without a csrf field are let through for a seamless migration window.
 *   New sessions (issued after this change) are fully protected.
 */
export function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (SKIP_PREFIXES.some(p => req.path.startsWith(p))) return next();
  if (!userMgmtActive()) return next();                         // single-user mode
  if (req.headers.authorization?.startsWith('Bearer ')) return next(); // Bearer = CSRF-safe
  if (!req.user?.csrf) return next();                           // old token — skip for now

  const header = req.headers['x-csrf-token'];
  if (!header || header !== req.user.csrf) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}
