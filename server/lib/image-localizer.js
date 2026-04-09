/**
 * image-localizer.js — Download external images to /uploads/ and return local path.
 *
 * Used by food/meal routes to self-host external images (DuckDuckGo, Walmart, etc.)
 * so they're always available and don't depend on third-party proxies.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../logger.js';

const UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';

/**
 * If img_url is an external URL, download it to /uploads/ and return the local path.
 * If it's already a local path (/uploads/...) or null/empty, returns as-is.
 * Returns the (possibly updated) img_url.
 */
export async function localizeImage(img_url) {
  if (!img_url) return img_url;
  if (!img_url.startsWith('http')) return img_url; // Already local

  // Check if it's already on our server
  try {
    const parsed = new URL(img_url);
    // If it's a proxy URL on our server, extract the original
    if (parsed.pathname === '/api/proxy') {
      const originalUrl = parsed.searchParams.get('url');
      if (originalUrl) return localizeImage(originalUrl);
    }
  } catch {}

  try {
    // Generate a unique filename from the URL
    const hash = crypto.createHash('md5').update(img_url).digest('hex').slice(0, 12);
    const ext = _guessExtension(img_url);
    const filename = `${Date.now()}-${hash}${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    // Download the image
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(img_url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NutriTrace/1.0)' },
    });
    clearTimeout(timer);

    if (!response.ok) {
      logger.debug(`[image-localizer] Failed to download (${response.status}): ${img_url.substring(0, 80)}`);
      return img_url; // Keep original URL — might work sometimes
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100) {
      logger.debug(`[image-localizer] Image too small (${buffer.length}b), skipping: ${img_url.substring(0, 80)}`);
      return img_url;
    }

    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    const localPath = `/uploads/${filename}`;
    logger.debug(`[image-localizer] Downloaded: ${img_url.substring(0, 60)} → ${localPath}`);
    return localPath;
  } catch (e) {
    logger.debug(`[image-localizer] Error: ${e.message} — ${img_url.substring(0, 80)}`);
    return img_url; // Keep original on failure
  }
}

/**
 * Guess file extension from URL or content-type.
 */
function _guessExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(jpe?g|png|webp|gif|svg)$/i);
    if (match) return '.' + match[1].toLowerCase();
  } catch {}
  return '.jpg'; // Default to jpg
}

/**
 * Check if a URL is external (not a local /uploads/ path).
 */
export function isExternalUrl(url) {
  return url && url.startsWith('http');
}
