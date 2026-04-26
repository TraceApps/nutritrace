import { Router } from 'express';
import { logger } from '../logger.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';

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

export default router;
