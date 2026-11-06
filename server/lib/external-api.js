/**
 * external-api.js: the outside food databases the server may ask, and how.
 *
 * Shared by the app's proxy (routes/proxy.js) and the MCP food tools (#314),
 * so both reach the same hosts, answer from the same local OFF mirror, honor
 * the same air gap (OFF_LOCAL_ONLY) and send the same user agent.
 */
import { logger } from '../logger.js';
import { fetchChecked, readBody } from './ssrf-guard.js';
import { isLocalOffEnabled, isLocalOffOnly, lookupByBarcode, searchByName } from './off-local.js';

// Hosts the proxy answers JSON for. Nothing else is ever asked.
export const API_ALLOWED = ['world.openfoodfacts.org', 'search.openfoodfacts.org', 'api.nal.usda.gov'];

export const EXTERNAL_USER_AGENT = 'Mozilla/5.0 (compatible; NutriTrace/1.0)';

// Strict host match: equal OR proper subdomain. Rejects 'i.imgur.com.evil.tld'.
export function hostMatches(hostname, allowed) {
  return hostname === allowed || hostname.endsWith('.' + allowed);
}

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
 *  last mirror refresh; without it, scans of recently-added products would
 *  give false negatives until the next snapshot pull. Air-gap mode keeps the
 *  old behavior: trust the mirror as authoritative.
 */
export async function tryLocalOff(parsedUrl) {
  const host = parsedUrl.hostname;
  const path = parsedUrl.pathname;
  const airGap = isLocalOffOnly();
  // Barcode lookup: /api/vN/product/CODE.json (also handle .json-less), and
  // point versions like v3.5 (#241), which the mirror answers the same way.
  if (host === 'world.openfoodfacts.org' && /^\/api\/v\d+(?:\.\d+)?\/product\//.test(path)) {
    const m = path.match(/^\/api\/v\d+(?:\.\d+)?\/product\/([^/.]+)/);
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
  // Name search: legacy /search?q=... and v2 /api/v2/search?search_terms=...
  if ((host === 'search.openfoodfacts.org' && path === '/search') ||
      (host === 'world.openfoodfacts.org' && path === '/api/v2/search')) {
    const q = parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('search_terms') || '';
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

// The request itself. Tests swap in one that answers from a local mock built
// from real Open Food Facts and USDA replies, so they never reach the network.
let _fetch = fetchChecked;
export function _setFetchForTests(fn) { _fetch = fn || fetchChecked; }

/** Why an outside source could not answer. `code` is one of 'not_allowed',
 *  'offline' (air-gapped, the mirror had no answer), 'unreachable' (network
 *  error or timeout) or 'bad_response' (not JSON, or too big). */
export class ExternalApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Air-gapped: OFF_LOCAL_ONLY is set. Stricter than the proxy's test
 * (isLocalOffOnly also wants a working mirror): for the MCP tools the flag
 * alone means nothing leaves the server, even when the mirror is missing or
 * failed to open.
 */
export function isAirGapped() {
  return !!process.env.OFF_LOCAL_ONLY;
}

/**
 * GET one of the allowed JSON APIs the way the proxy does: the local OFF
 * mirror first when it is set up, never the network when air-gapped,
 * otherwise the public host through the SSRF guard (redirects only within
 * the same host), with a timeout and a size cap. Returns
 * { status, ok, body, fromMirror }; `body` is the parsed JSON for a 2xx
 * answer, else null. Throws ExternalApiError.
 */
export async function fetchExternalJson(url, { timeoutMs = 15000, maxBytes = 5 * 1024 * 1024 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new ExternalApiError('not_allowed', 'Not a valid address.'); }
  if (parsed.protocol !== 'https:' || !API_ALLOWED.some(h => hostMatches(parsed.hostname, h))) {
    throw new ExternalApiError('not_allowed', 'That address is not one of the food databases NutriTrace uses.');
  }
  if (isLocalOffEnabled()) {
    const local = await tryLocalOff(parsed);
    if (local !== undefined) return { status: 200, ok: true, body: local, fromMirror: true };
  }
  if (isLocalOffOnly() || isAirGapped()) {
    throw new ExternalApiError('offline', 'This server is set to use only its local Open Food Facts copy (OFF_LOCAL_ONLY), and that copy has no answer.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await _fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': EXTERNAL_USER_AGENT, 'Accept': 'application/json' },
      }, { maxRedirects: 3, sameOrigin: true });
    } catch (e) {
      throw new ExternalApiError('unreachable', `Could not reach ${parsed.hostname}.`);
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      return { status: response.status, ok: false, body: null, fromMirror: false };
    }
    let text;
    try {
      text = (await readBody(response, maxBytes)).toString('utf8');
    } catch (e) {
      if (controller.signal.aborted) throw new ExternalApiError('unreachable', `Could not reach ${parsed.hostname}.`);
      throw new ExternalApiError('bad_response', `${parsed.hostname} sent an answer that was too big.`);
    }
    try {
      return { status: response.status, ok: true, body: JSON.parse(text), fromMirror: false };
    } catch {
      throw new ExternalApiError('bad_response', `${parsed.hostname} sent an answer NutriTrace could not read.`);
    }
  } finally {
    clearTimeout(timer);
  }
}
