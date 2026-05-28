import { Router } from 'express';
import { logger } from '../logger.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { isLocalOffEnabled, isLocalOffOnly, lookupByBarcode, searchByName } from '../lib/off-local.js';

const router = Router();
const proxyLimit = makeRateLimiter({ max: 60, windowMs: 60_000, label: 'proxy' });
router.use(proxyLimit);

// Whitelist: hosts allowed for API proxy (JSON responses)
const API_ALLOWED = ['world.openfoodfacts.org', 'search.openfoodfacts.org', 'api.nal.usda.gov'];

// Image proxy: allowed hosts for image passthrough (binary responses)
const IMG_ALLOWED = ['external-content.duckduckgo.com', 'i5.walmartimages.com', 'images.openfoodfacts.org',
  'i.imgur.com', 'upload.wikimedia.org', 'www.kroger.com', 'target.scene7.com'];

// Strict host match: equal OR proper subdomain. Rejects 'i.imgur.com.evil.tld'.
function _hostMatches(hostname, allowed) {
  return hostname === allowed || hostname.endsWith('.' + allowed);
}

router.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(403).json({ error: 'Protocol not allowed' });
    }
    const isApiHost = API_ALLOWED.some(h => _hostMatches(parsed.hostname, h));
    const isImgHost = IMG_ALLOWED.some(h => _hostMatches(parsed.hostname, h));

    if (!isApiHost && !isImgHost) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    // Local OFF mirror intercept. When the admin has set OFF_LOCAL_DB, try
    // a local DuckDB lookup before reaching the public OFF API. Falls back
    // to remote on a miss or an error unless OFF_LOCAL_ONLY is set (true
    // air-gap mode — return whatever the local mirror says, even if empty).
    // See server/lib/off-local.js for the lookup semantics and DEPLOY.md
    // for the full setup recipe. Issue #22 (duplaja).
    if (isLocalOffEnabled() && isApiHost) {
      const local = await _tryLocalOff(parsed);
      if (local !== undefined) {
        return res.json(local);
      }
      // local returned undefined → not an OFF request shape we handle, fall through to remote
      if (isLocalOffOnly()) {
        logger.warn(`[proxy] OFF_LOCAL_ONLY set but local mirror returned no shape match for ${url} — refusing remote per air-gap policy`);
        return res.status(503).json({ error: 'Local OFF mirror has no answer; remote disabled (OFF_LOCAL_ONLY)' });
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NutriTrace/1.0)' },
    });
    clearTimeout(timer);

    if (!response.ok) {
      logger.warn(`[proxy] upstream ${response.status} for ${url}`);
      return res.status(response.status).json({ error: `Upstream ${response.status}` });
    }

    const contentType = response.headers.get('content-type') || '';

    // Image response: pipe binary data with proper content-type
    if (contentType.startsWith('image/') || isImgHost) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.set('Content-Type', contentType || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    }

    // JSON API response
    res.json(await response.json());
  } catch(e) {
    logger.error('[proxy] fetch error:', e.message, 'url:', url);
    res.status(503).json({ error: e.message });
  }
});

/** Pattern-match OFF URLs and dispatch to the local mirror. Returns:
 *  - parsed JSON object (use it as the response)
 *  - undefined (URL didn't match a known OFF shape, OR mirror returned an
 *               error / empty result and we should fall through to remote)
 *
 *  Known shapes:
 *    https://world.openfoodfacts.org/api/v{N}/product/<barcode>(.json)?
 *    https://search.openfoodfacts.org/search?q=<query>&page=<n>&page_size=<m>
 *
 *  Stale-mirror fallback: when the mirror cleanly returns "no match" (barcode
 *  not in the local DB, or search hits empty) AND air-gap mode is off, we
 *  treat that as a cache miss and fall through to the live OFF API. This
 *  auto-heals the common case where a product was added to OFF after the
 *  last mirror refresh — without it, scans of recently-added products would
 *  give false negatives until the next snapshot pull. Air-gap mode keeps the
 *  old behavior: trust the mirror as authoritative.
 */
async function _tryLocalOff(parsedUrl) {
  const host = parsedUrl.hostname;
  const path = parsedUrl.pathname;
  const airGap = isLocalOffOnly();
  // Barcode lookup: /api/vN/product/CODE.json (also handle .json-less)
  if (host === 'world.openfoodfacts.org' && /^\/api\/v\d+\/product\//.test(path)) {
    const m = path.match(/^\/api\/v\d+\/product\/([^/.]+)/);
    if (!m) return undefined;
    const code = m[1];
    const result = await lookupByBarcode(code);
    if (result == null) {
      logger.debug(`[off-local] barcode ${code} → mirror error, falling through to remote OFF`);
      return undefined;
    }
    if (result.status === 0 && !airGap) {
      logger.debug(`[off-local] barcode ${code} → miss, falling through to remote OFF`);
      return undefined;
    }
    logger.debug(`[off-local] barcode ${code} → hit from local mirror${airGap && result.status === 0 ? ' (air-gap, returning empty)' : ''}`);
    return result;
  }
  // Name search: /search?q=...&page=...&page_size=...
  if (host === 'search.openfoodfacts.org' && path === '/search') {
    const q = parsedUrl.searchParams.get('q') || '';
    const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
    const pageSize = parseInt(parsedUrl.searchParams.get('page_size') || '20', 10);
    const result = await searchByName(q, { page, pageSize });
    if (result == null) {
      logger.debug(`[off-local] search "${q}" → mirror error, falling through to remote OFF`);
      return undefined;
    }
    const hitCount = result.hits?.length ?? 0;
    if (hitCount === 0 && !airGap) {
      logger.debug(`[off-local] search "${q}" → 0 hits, falling through to remote OFF`);
      return undefined;
    }
    logger.debug(`[off-local] search "${q}" → ${hitCount} hits from local mirror${airGap && hitCount === 0 ? ' (air-gap, returning empty)' : ''}`);
    return result;
  }
  // Any other OFF endpoint (CGI scripts for product upload, images, etc.):
  // no local equivalent, let it fall through to remote.
  return undefined;
}

export default router;
