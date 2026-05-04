/**
 * server/middleware/bearer-auth.js
 *
 * Bearer-token auth for the federation API (/api/v1/*). Validates the
 * Authorization header against api_tokens, attaches { user, token } to
 * the request, and rate-limits per token.
 *
 * See docs/federation.md for the contract.
 */
import { lookupRawToken } from '../lib/api-tokens.js';

const RATE_LIMIT_PER_MIN = Number(process.env.API_RATE_LIMIT_PER_MIN) || 60;
const WINDOW_MS = 60 * 1000;

// Per-token sliding-window counters. Cleared lazily on access.
const _buckets = new Map();

function _take(tokenId) {
  const now = Date.now();
  let b = _buckets.get(tokenId);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    _buckets.set(tokenId, b);
  }
  b.count++;
  return {
    count: b.count,
    remaining: Math.max(0, RATE_LIMIT_PER_MIN - b.count),
    resetAt: b.resetAt,
    over: b.count > RATE_LIMIT_PER_MIN,
  };
}

/**
 * Express middleware. Extracts the Bearer token, validates it, and
 * attaches:
 *   req.apiToken = { id, user_id, name, scopes, ... }
 *   req.apiUser  = { id, username, full_name, role }
 *
 * Sets X-RateLimit-* headers on every response. Returns 401/403/429
 * with a stable `code` field on errors.
 */
export function bearerAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
  if (!m) {
    return res.status(401).json({ error: 'Token required', code: 'auth_missing' });
  }

  const lookup = lookupRawToken(m[1]);
  if (!lookup) {
    return res.status(401).json({ error: 'Invalid token', code: 'auth_invalid' });
  }

  // Rate limit
  const bucket = _take(lookup.token.id);
  res.set('X-RateLimit-Limit', String(RATE_LIMIT_PER_MIN));
  res.set('X-RateLimit-Remaining', String(bucket.remaining));
  res.set('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));
  if (bucket.over) {
    const retry = Math.ceil((bucket.resetAt - Date.now()) / 1000);
    res.set('Retry-After', String(retry));
    return res.status(429).json({ error: 'Rate limited', code: 'rate_limited' });
  }

  req.apiToken = lookup.token;
  req.apiUser = lookup.user;
  next();
}

/**
 * Scope-check middleware factory. Use AFTER bearerAuth.
 *   router.get('/foods', bearerAuth, requireScope('read:foods'), handler)
 */
export function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiToken) {
      return res.status(401).json({ error: 'Token required', code: 'auth_missing' });
    }
    if (!req.apiToken.scopes.includes(scope)) {
      return res.status(403).json({ error: `Token lacks ${scope}`, code: 'auth_scope' });
    }
    next();
  };
}
