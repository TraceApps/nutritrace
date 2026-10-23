import { userMgmtActive } from './auth.js';

const SAFE_METHODS  = new Set(['GET', 'HEAD', 'OPTIONS']);
// Login/logout/register don't need CSRF — they're how you get a token in the first place.
// Wellness OAuth callbacks are exempt because OAuth providers redirect users back to us
// via a top-level navigation that can't carry our CSRF header — those endpoints validate
// their own state token (CSRF-equivalent) via the oauth_state DB table.
const SKIP_PREFIXES = ['/api/auth/'];
const SKIP_SUFFIXES = ['/callback'];
const BEARER_ONLY = ['/api/v1', '/api/mcp'];

/**
 * CSRF protection for cookie-based (PWA) sessions.
 *
 * Strategy: synchronizer token embedded in the JWT.
 * - Requests signed in by our bearer token are CSRF-safe (attacker can't set headers via HTML form/img).
 *   A cookie session is checked even when the request also carries someone else's bearer.
 * - Single-user mode has no auth cookies, so CSRF isn't relevant.
 * - Old JWTs without a csrf field are let through for a seamless migration window.
 *   New sessions (issued after this change) are fully protected.
 */
export function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (SKIP_PREFIXES.some(p => req.path.startsWith(p))) return next();
  // Allow OAuth callback paths (e.g. /api/wellness/fitbit/callback) — they validate
  // their own state tokens, and the cross-origin redirect can't carry our CSRF header.
  if (SKIP_SUFFIXES.some(s => req.path.endsWith(s))) return next();
  if (!userMgmtActive()) return next();                         // single-user mode
  // Signed in by our bearer token: CSRF-safe (a page can't set the header).
  // A session from the cookie is checked even when the request carries
  // someone else's bearer (a reverse proxy can add one).
  if (req.authVia === 'bearer') return next();
  // The API (/api/v1, /api/mcp) signs in by its own API token only, never
  // the cookie, and its clients send no CSRF token.
  if (BEARER_ONLY.some(p => req.path === p || req.path.startsWith(p + '/')) && req.headers.authorization?.startsWith('Bearer ')) return next();
  if (!req.user?.csrf) return next();                           // old token — skip for now

  const header = req.headers['x-csrf-token'];
  if (!header || header !== req.user.csrf) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}
