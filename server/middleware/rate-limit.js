/**
 * In-memory token-bucket rate limiter, keyed by user ID (when authenticated)
 * or IP (when anonymous). No external dependency.
 *
 * Usage:
 *   import { makeRateLimiter } from '../middleware/rate-limit.js';
 *   const aiLimit = makeRateLimiter({ max: 30, windowMs: 60_000, label: 'ai' });
 *   router.post('/chat', aiLimit, handler);
 *
 * Each limiter has its own bucket map — limits are independent across endpoints.
 */
export function makeRateLimiter({ max, windowMs, label = 'rate' }) {
  const buckets = new Map(); // key → { count, resetAt }
  return function rateLimit(req, res, next) {
    const key = (req.user?.id != null ? `u${req.user.id}` : `ip${req.ip || req.connection?.remoteAddress || 'unknown'}`);
    const now = Date.now();
    const entry = buckets.get(key);
    if (entry && now < entry.resetAt) {
      entry.count++;
      if (entry.count > max) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many requests. Try again in ${retryAfter}s.` });
      }
    } else {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
    }
    // Periodic cleanup so buckets don't grow unbounded
    if (buckets.size > 2000) {
      for (const [k, v] of buckets) { if (now > v.resetAt) buckets.delete(k); }
    }
    next();
  };
}
