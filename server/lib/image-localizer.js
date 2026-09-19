/**
 * image-localizer.js — Download external images to /uploads/ and return local path.
 *
 * Used by food/meal routes to self-host external images (DuckDuckGo, Walmart, etc.)
 * so they're always available and don't depend on third-party proxies.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { logger } from '../logger.js';
import { detectImageTypeFromBuffer } from './image-magic.js';

const UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';
// Cap on decoded data URL size. Mirrors the multer /api/upload limit so a
// food save can't smuggle a larger image past the proper upload path.
const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;
// Map magic-byte detector output to a file extension.
const _EXT_BY_TYPE = {
  jpeg: '.jpg', png: '.png', gif: '.gif', bmp: '.bmp',
  webp: '.webp', heic: '.heic', avif: '.avif',
};

/**
 * SSRF protection: block private/loopback/link-local IP ranges so an authed
 * user can't trick the server into fetching internal admin panels or cloud
 * metadata endpoints (169.254.169.254). Note: there's a TOCTOU window between
 * resolution and fetch — for higher-assurance environments, switch to a
 * pinned-IP HTTP agent.
 */
function _isPrivateIP(ip) {
  if (!net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    return (
      o[0] === 0 ||                                // 0.0.0.0/8
      o[0] === 10 ||                               // 10.0.0.0/8
      o[0] === 127 ||                              // 127.0.0.0/8 loopback
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || // 100.64.0.0/10 CGNAT
      (o[0] === 169 && o[1] === 254) ||            // 169.254.0.0/16 link-local + cloud metadata
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||// 172.16.0.0/12
      (o[0] === 192 && o[1] === 168)               // 192.168.0.0/16
    );
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;       // fc00::/7 ULA
  if (lower.startsWith('fe80:') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;     // fe80::/10
  if (lower.startsWith('::ffff:')) return _isPrivateIP(lower.slice(7));    // IPv4-mapped
  return false;
}

async function _hostnameResolvesPrivate(hostname) {
  // Literal IPs: check directly.
  if (net.isIP(hostname)) return _isPrivateIP(hostname);
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.some(a => _isPrivateIP(a.address));
  } catch {
    return true;  // DNS failure → treat as unsafe
  }
}

/**
 * If img_url is an external URL OR an inline base64 data URL, convert it to
 * a /uploads/X.<ext> path and return that. If it's already a local path
 * (/uploads/...) or null/empty, returns as-is.
 *
 * Data URL support added 2026-06-10 after the FoodEditor's camera/gallery
 * flow was found to be saving images inline in the food JSON, which then
 * got replicated across every diary item that referenced the food and
 * blew past PUT /api/diary's body-size limit (PayloadTooLargeError).
 * Magic-byte validates the decoded bytes so an authed user can't smuggle
 * arbitrary content into /uploads/ via a fake MIME-typed data URL.
 *
 * Returns the (possibly updated) img_url. On any failure, returns the
 * original — never throws.
 */
export async function localizeImage(img_url, opts = {}) {
  if (!img_url) return img_url;
  if (img_url.startsWith('data:')) return await _localizeDataUrl(img_url);
  if (!img_url.startsWith('http')) return img_url; // Already local

  // Check if it's already on our server
  let parsedUrl;
  try {
    parsedUrl = new URL(img_url);
    // If it's a proxy URL on our server, extract the original
    if (parsedUrl.pathname === '/api/proxy') {
      const originalUrl = parsedUrl.searchParams.get('url');
      if (originalUrl) return localizeImage(originalUrl, opts);
    }
  } catch {
    return img_url;
  }
  // Reject non-http(s) protocols outright
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    logger.warn(`[image-localizer] Refusing non-http(s) URL: ${img_url.substring(0, 80)}`);
    return img_url;
  }
  // SSRF guard: refuse private/loopback/link-local hosts (incl. cloud
  // metadata 169.254.169.254). Exception: callers can pass a trustedOrigins
  // list of origins the current user has explicitly configured in Settings
  // (their saved CookTrace / Mealie base URL, etc). The user has proven
  // they can reach that host on their own network, so an image pull from
  // it is not an SSRF vector; without this bypass, LAN federation setups
  // silently store the raw private-IP URL and every downstream viewer
  // sees an empty image slot.
  const trusted = Array.isArray(opts.trustedOrigins)
    ? opts.trustedOrigins.map(o => _originOf(o)).filter(Boolean)
    : [];
  const thisOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const isTrusted = trusted.includes(thisOrigin);
  if (!isTrusted && await _hostnameResolvesPrivate(parsedUrl.hostname)) {
    logger.warn(`[image-localizer] Refusing private/loopback URL: ${img_url.substring(0, 80)}`);
    return img_url;
  }

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
 * Decode an inline base64 data URL ("data:image/jpeg;base64,...") into a
 * file under /uploads/ and return the local path. Magic-byte validates
 * the decoded bytes so the declared MIME type can't be lied about.
 *
 * On invalid format / bad base64 / unrecognised image / oversize / disk
 * write failure: returns the original data URL untouched so the caller's
 * UPDATE/INSERT still succeeds — the storage bloat is recoverable on the
 * next save once the user fixes the offending image. Never throws.
 */
async function _localizeDataUrl(dataUrl) {
  // Expected shape: data:image/<subtype>;base64,<base64-payload>
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(dataUrl);
  if (!m) {
    logger.debug(`[image-localizer] Not a base64 image data URL — keeping inline`);
    return dataUrl;
  }
  let buf;
  try {
    buf = Buffer.from(m[1], 'base64');
  } catch (e) {
    logger.debug(`[image-localizer] base64 decode failed: ${e.message}`);
    return dataUrl;
  }
  if (buf.length < 100) {
    logger.debug(`[image-localizer] Decoded data URL too small (${buf.length}b)`);
    return dataUrl;
  }
  if (buf.length > MAX_DATA_URL_BYTES) {
    logger.warn(`[image-localizer] Decoded data URL too large (${buf.length}b), rejecting`);
    return dataUrl;
  }
  const detected = detectImageTypeFromBuffer(buf);
  if (!detected) {
    logger.warn(`[image-localizer] Data URL did not magic-byte match any supported image type`);
    return dataUrl;
  }
  const ext = _EXT_BY_TYPE[detected] || '.jpg';
  // Hash the bytes — same image saved twice ends up under the same
  // filename, which avoids stray /uploads/ duplicates when a user
  // re-saves a food whose image hasn't changed.
  const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
  const filename = `${Date.now()}-${hash}${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(filePath, buf);
  } catch (e) {
    logger.warn(`[image-localizer] Disk write failed for data URL: ${e.message}`);
    return dataUrl;
  }
  const localPath = `/uploads/${filename}`;
  logger.debug(`[image-localizer] Inlined data URL → ${localPath} (${detected}, ${buf.length}b)`);
  return localPath;
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
 * Check if a URL needs to be converted into a /uploads/ path via
 * localizeImage. Three cases qualify:
 *   - data:image/... inline base64 (FoodEditor camera/gallery output)
 *   - http(s) URL that does not already point at /uploads/
 * Local /uploads/ paths, relative paths, and null/empty are passed through.
 */
/**
 * Normalize a base URL string to a bare origin ("https://host:port").
 * Returns null when the input can't be parsed. Used by localizeImage's
 * trustedOrigins bypass so a saved integration base URL like
 * "https://cooktrace.lan/" or "https://cooktrace.lan/api" both collapse
 * to the same origin key.
 */
function _originOf(u) {
  if (!u) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    return `${p.protocol}//${p.host}`;
  } catch { return null; }
}

export function isExternalUrl(url) {
  if (!url) return false;
  if (url.startsWith('data:image/')) return true;
  if (!url.startsWith('http')) return false;
  // A URL is "external" only if it does NOT point at our own /uploads/
  // directory. Earlier versions returned true for ANY http URL, which made
  // a boot-time migration loop re-download the server's own files from
  // itself on every restart. The strip functions in src/lib/api-cached.js
  // and src/stores/diary.js now keep full-host URLs out of the table at
  // write time, but harden this too in case any future caller relies on it.
  return url.indexOf('/uploads/') < 0;
}
