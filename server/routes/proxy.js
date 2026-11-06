import { Router } from 'express';
import { logger } from '../logger.js';
import { redactUrl } from '../lib/redact-url.js';
import { fetchChecked, readBody } from '../lib/ssrf-guard.js';
import { frameAncestorsDirective } from '../lib/frame-ancestors.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { isLocalOffEnabled, isLocalOffOnly } from '../lib/off-local.js';
import { API_ALLOWED, EXTERNAL_USER_AGENT, hostMatches, tryLocalOff } from '../lib/external-api.js';

const router = Router();
const proxyLimit = makeRateLimiter({ max: 60, windowMs: 60_000, label: 'proxy' });
router.use(proxyLimit);

// Hosts allowed for API proxy (JSON responses): API_ALLOWED in
// lib/external-api.js, shared with the MCP food tools (#314).

// Image proxy: allowed hosts for image passthrough (binary responses)
const IMG_ALLOWED = ['external-content.duckduckgo.com', 'i5.walmartimages.com', 'images.openfoodfacts.org',
  'i.imgur.com', 'upload.wikimedia.org', 'www.kroger.com', 'target.scene7.com'];

router.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(403).json({ error: 'Protocol not allowed' });
    }
    const isApiHost = API_ALLOWED.some(h => hostMatches(parsed.hostname, h));
    const isImgHost = IMG_ALLOWED.some(h => hostMatches(parsed.hostname, h));

    if (!isApiHost && !isImgHost) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    // Local OFF mirror intercept. When the admin has set OFF_LOCAL_DB, try
    // a local DuckDB lookup before reaching the public OFF API. Falls back
    // to remote on a miss or an error unless OFF_LOCAL_ONLY is set (true
    // air-gap mode — return whatever the local mirror says, even if empty).
    // See server/lib/off-local.js for the lookup semantics and DEPLOY.md
    // for the full setup recipe. Issue #22 (duplaja).
    // `live=1` (Refresh from OFF, #241) skips the mirror: it is a periodic
    // dump, and the whole point of a refresh is an edit made on OFF since.
    // An air-gapped server still answers from the mirror.
    const wantLive = req.query.live === '1' && !isLocalOffOnly();
    if (isLocalOffEnabled() && isApiHost && !wantLive) {
      const local = await tryLocalOff(parsed);
      if (local !== undefined) {
        return res.json(local);
      }
      // local returned undefined → not an OFF request shape we handle, fall through to remote
      if (isLocalOffOnly()) {
        logger.warn(`[proxy] OFF_LOCAL_ONLY set but local mirror returned no shape match for ${redactUrl(url)} — refusing remote per air-gap policy`);
        return res.status(503).json({ error: 'Local OFF mirror has no answer; remote disabled (OFF_LOCAL_ONLY)' });
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    // Only the allowed public hosts, and a redirect may not lead into the
    // server's own network or to cloud metadata.
    const response = await fetchChecked(url, {
      signal: controller.signal,
      headers: { 'User-Agent': EXTERNAL_USER_AGENT },
    }, { maxRedirects: 3 });

    if (!response.ok) {
      logger.warn(`[proxy] upstream ${response.status} for ${redactUrl(url)}`);
      return res.status(response.status).json({ error: `Upstream ${response.status}` });
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    // Image response: only an image, sent so it can't act as a page. This
    // answers from the app's own origin, before sign-in, so an image host's
    // HTML or SVG passed through as-is could have run script as the app.
    // (An image host that names no type gets image/jpeg, as before.)
    if (contentType.startsWith('image/') || (isImgHost && !contentType)) {
      const buffer = await readBody(response, 10 * 1024 * 1024);
      clearTimeout(timer);
      res.set('Content-Type', contentType || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; sandbox; ${frameAncestorsDirective(process.env.FRAME_ANCESTORS)}`);
      return res.send(buffer);
    }
    if (isImgHost) {
      clearTimeout(timer);
      try { await response.body?.cancel(); } catch {}
      return res.status(502).json({ error: 'That address is not an image' });
    }

    // JSON API response
    const body = JSON.parse((await readBody(response, 5 * 1024 * 1024)).toString('utf8'));
    clearTimeout(timer);
    res.json(body);
  } catch(e) {
    logger.error('[proxy] fetch error:', e.message, 'url:', redactUrl(url));
    res.status(503).json({ error: 'Could not reach that service' });
  }
});

export default router;
