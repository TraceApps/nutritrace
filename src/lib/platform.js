/**
 * platform.js — Runtime detection for Capacitor native vs web browser.
 *
 * All platform-specific branching in the app goes through this module.
 * Uses @capacitor/core for reliable detection (not window.Capacitor directly).
 */

import { Capacitor } from '@capacitor/core';
import { originalUrlForCachedImage } from './image-cache-map.js';
import { classifyServerAddress } from './local-address.js';
import { mirroredConfirmation, blockedError } from './plain-http.js';

/**
 * True when running inside the Capacitor native shell (Android / iOS).
 * False in the browser (PWA, desktop).
 */
export const isNative = Capacitor.isNativePlatform();

/**
 * Server-injected base path (when NutriTrace is mounted at a subpath via
 * BASE_URL env var, e.g. `/nutritrace`). Empty string when running at root,
 * or in native where API calls go through getServerUrl() which already
 * carries any path component the user configured.
 */
const _basePath = (typeof window !== 'undefined' && window.__NT_CONFIG__ && window.__NT_CONFIG__.basePath) || '';


/**
 * Native setup mode: 'local' | 'server' | null (not yet chosen).
 * Set during the Android onboarding wizard.
 */
export function getNativeMode() {
  if (!isNative) return null;
  return localStorage.getItem('nt:nativeMode') || null;
}

export function setNativeMode(mode) {
  if (mode) {
    localStorage.setItem('nt:nativeMode', mode);
  } else {
    localStorage.removeItem('nt:nativeMode');
  }
}

/**
 * The server URL to use for sync.
 * In web mode: always same-origin (relative URLs).
 * In native mode: read from localStorage, or null (standalone / offline-first).
 */
export function getServerUrl() {
  if (!isNative) return ''; // relative URLs — same origin
  return localStorage.getItem('nt:serverUrl') || null;
}

/**
 * Save the server URL for native sync mode.
 * Pass null to revert to standalone (offline-only) mode.
 */
export function setServerUrl(url) {
  if (url) {
    const clean = url.replace(/\/$/, '');
    localStorage.setItem('nt:serverUrl', clean);
    // Keep a copy for image cache lookups even after disconnecting
    localStorage.setItem('nt:lastServerUrl', clean);
  } else {
    localStorage.removeItem('nt:serverUrl');
    // Don't remove lastServerUrl — needed for cached image resolution
  }
  _mirrorAuthToSyncMeta();
}


/**
 * True when running native but setup hasn't been completed yet.
 */
export function needsNativeSetup() {
  return isNative && !getNativeMode();
}

/** Store the JWT token for native server mode (used in Authorization header) */
export function setAuthToken(token) {
  if (token) localStorage.setItem('nt:authToken', token);
  else localStorage.removeItem('nt:authToken');
  // A sign-in means the server has accounts: the next launch knows it
  // before the server answers (stores/auth.js). Signing out keeps it.
  if (token) localStorage.setItem('nt:cachedUserMgmt', '1');
  _mirrorAuthToSyncMeta();
}

export function getAuthToken() {
  return localStorage.getItem('nt:authToken') || null;
}

/**
 * Mirror serverUrl + authToken into the native SQLite sync_meta table so the
 * Kotlin HealthConnectSyncWorker can read them when posting freshly-synced
 * Health Connect metrics directly to the server (without needing the WebView
 * to be open). #68 part 2.
 *
 * Plain text (same as localStorage) and same threat model: lives in the app's
 * private data directory, not world-readable. Future improvement could swap
 * the auth_token row for EncryptedSharedPreferences.
 *
 * 'server_http_ok' is the server URL again when it is plain http:// to a
 * server on your own network that you said Connect Anyway to, and empty
 * otherwise; the worker sends over plain HTTP only when the two match (#194).
 *
 * Best-effort: silently skips on web, on local-only mode, on startup before
 * the DB is initialized, or on any other failure. Each setter calls this; on
 * app launch the auth store also fires it once via _bootMirror() below.
 */
function _mirrorAuthToSyncMeta() {
  if (!isNative) return;
  const url   = localStorage.getItem('nt:serverUrl')  || '';
  const token = localStorage.getItem('nt:authToken')  || '';
  const httpOk = mirroredConfirmation(url);
  (async () => {
    try {
      const { getDb } = await import('./db-native.js');
      const db = await getDb();
      const sql = `INSERT INTO sync_meta (key, value) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
      await db.run(sql, ['server_url', url]);
      await db.run(sql, ['auth_token', token]);
      await db.run(sql, ['server_http_ok', httpOk]);
    } catch { /* db not ready or local-only mode — fine */ }
  })();
}

/** Fire once at app boot so a fresh install / reinstall has values written
 *  immediately, not only after the next setServerUrl/setAuthToken call. */
export function bootMirrorAuth() {
  _mirrorAuthToSyncMeta();
}

/**
 * A server that answered but has no account yet (a fresh install): it needs
 * setting up in a browser before an app can sign in. `res` is what
 * CapacitorHttp returns for /api/health ({ status, data }). Newer servers say
 * so with a 200, older ones with a 503 "Setup required".
 */
export function healthNeedsSetup(res) {
  try {
    const d = typeof res?.data === 'string' ? JSON.parse(res.data) : res?.data;
    return !!d?.setup_required;
  } catch { return false; }
}

/**
 * Translate a connect-server error into something the user can act on.
 * `t` is svelte-i18n's translate function ($_).
 *
 * The Android app uses plain http:// only with a server on your own network,
 * after the warning (lib/plain-http.js, #194); any other http:// address is
 * refused before a request is made. So a plain-HTTP failure is either that
 * refusal, or a local server the phone can't reach (a wrong address, or not
 * on the same network or VPN), and the message says which.
 *
 * lib/server-signin.js marks the answers that weren't the server's own:
 * a fresh install, and a web page in its place (a sign-in proxy, or not
 * the server's address, #36).
 */
export function explainConnectError(rawError, serverUrl, t) {
  if (rawError?.webPage) return t('server_signin.web_page');
  if (rawError?.code === 'needs_setup') return t('native_setup.errors.server_needs_setup');
  const fallback = rawError?.message || t('native_setup.errors.unreachable');
  if (!isNative) return fallback;
  const kind = classifyServerAddress(serverUrl);
  if (kind === 'invalid') return t('plain_http.invalid_address');
  const msg = (rawError?.message || String(rawError) || '').toLowerCase();
  if (kind === 'public' || rawError?.code === blockedError().code || msg.includes('cleartext')) {
    return t('plain_http.refused_short');
  }
  if (kind === 'local' && /network|not reachable|failed to fetch|connect|timed? ?out|unreachable/.test(msg)) {
    return t('plain_http.unreachable', { values: { url: serverUrl } });
  }
  return fallback;
}

/**
 * In-memory image cache map: server URL → local file URI.
 * Populated during sync by loadImageMap(). Used by resolveAssetUrl() synchronously.
 */
let _imageMap = {};

// Files under these public/ directories are copied into the Capacitor bundle.
// They must stay on the WebView's local origin in native server mode; otherwise
// resolveAssetUrl() rewrites them to the configured server and they disappear
// whenever that server is unreachable.
const BUNDLED_ASSET_PREFIXES = ['/icons/', '/fonts/', '/templates/', '/vendor/'];

function _isBundledAssetPath(path) {
  return BUNDLED_ASSET_PREFIXES.some(prefix => path.startsWith(prefix));
}

/** Load the image map from local DB into memory (call once on sync init).
 *  Honors image_cache_version (#61): if the stored version differs from
 *  the current code, the cached map is treated as empty because old keys
 *  pointed at filenames that may have collided across products. The next
 *  cacheAllImages() run rebuilds the map with collision-safe keys. */
export async function loadImageMap() {
  if (!isNative) return;
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    // Must stay in sync with CACHE_VERSION in image-cache.js. Treated as a
    // small magic number on purpose to avoid creating a cross-file import
    // just for this one constant; only image-cache.js writes it.
    const IMAGE_CACHE_VERSION = 3;
    const vr = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_cache_version'`, []);
    const storedVersion = parseInt(vr?.values?.[0]?.value || '1', 10);
    if (storedVersion !== IMAGE_CACHE_VERSION) { _imageMap = {}; return; }
    const r = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_map'`, []);
    const row = r?.values?.[0];
    if (row?.value) _imageMap = JSON.parse(row.value);
  } catch {}
}

/** Update the in-memory image map (called after image cache downloads) */
export function setImageMap(map) {
  _imageMap = map || {};
}

/**
 * Convert an Android offline-cache URI back to the exact image URL it was
 * downloaded from. Returns null when the URI is not present in the cache map.
 */
export function restoreCachedAssetUrl(localUrl) {
  return originalUrlForCachedImage(localUrl, _imageMap);
}

/**
 * Resolve a relative URL (e.g. /uploads/photo.jpg) to an absolute URL
 * when in native server mode. Checks local image cache first for offline support.
 * On web, returns the path unchanged.
 */
/**
 * Version-busted URL for one of the app's icon PNGs (favicon, logo,
 * launcher). Browsers cache these hard by URL and won't refetch when
 * the file changes underneath them; appending ?v=<version> makes
 * each dev bump a new URL so a shipped icon fix is actually visible
 * without asking users to clear their cache. Kept separate from
 * resolveAssetUrl so we only cache-bust things we know will change
 * between builds (icons), not every image the app serves.
 */
export function iconUrl(path) {
  const resolved = resolveAssetUrl(path);
  if (!resolved) return resolved;
  if (resolved.startsWith('data:') || resolved.includes('?')) return resolved;
  // Lazy import to avoid a circular dep — version.js doesn't touch platform.js.
  const v = (typeof __APP_VERSION__ !== 'undefined')
    ? __APP_VERSION__
    : (typeof window !== 'undefined' && window.__NT_VERSION__) || 'dev';
  return `${resolved}?v=${encodeURIComponent(v)}`;
}

// WebView's own origin — historically https://localhost, now
// https://app.nutritrace.local after the hostname flip for password-
// manager identity. Resolved once at load time; any absolute URL that
// begins with this origin is already a bundled asset served from the
// APK and doesn't need further path resolution.
const _webviewOrigin = typeof window !== 'undefined' ? window.location.origin : '';

export function resolveAssetUrl(path) {
  if (!path) return path;
  if (path.startsWith('data:') || path.startsWith('file:')) return path;
  if (_webviewOrigin && path.startsWith(_webviewOrigin)) return path;
  if (isNative) {
    // Vite copies public/ to the root of the local Capacitor web bundle.
    if (_isBundledAssetPath(path)) return path;
    // Always check local image cache first (fastest, works offline + disconnected)
    if (_imageMap[path]) return _imageMap[path];
    const url = getServerUrl() || localStorage.getItem('nt:lastServerUrl') || '';
    if (url) {
      const fullUrl = path.startsWith('http') ? path : url + path;
      if (_imageMap[fullUrl]) return _imageMap[fullUrl];
    }
    // External https URLs (arbitrary recipe / product photos, NT-federation
    // images, etc.): let the WebView fetch direct. CORS doesn't apply to
    // <img> rendering, and image-cache.js downloads them via CapacitorHttp
    // for offline use. Routing every external image through /api/proxy was
    // the previous approach and it broke on every host outside the small
    // IMG_ALLOWED list on the server (403 "Domain not allowed") — which is
    // what makes a pasted URL from an arbitrary site render broken after
    // save. See feedback_proxy_images.md for the full write-up.
    if (path.startsWith('https://')) return path;
    // Server-hosted images
    if (url && !path.startsWith('http')) return url + path;
    if (path.startsWith('http')) return path;
  }
  // PWA: prefix server-relative paths with base path so they resolve under
  // the configured subpath instead of the document root.
  if (_basePath && (path.startsWith('/uploads/') || path.startsWith('/api/') || _isBundledAssetPath(path))) {
    return _basePath + path;
  }
  return path;
}

/**
 * Prefix an API path with the server URL when in native server-connected mode.
 * In native local mode, returns the path unchanged (caller intercepts to local
 * SQLite). In PWA mode, prefixes with the server-injected base path so the
 * request reaches the right place when the server is mounted at a subpath.
 */
export function apiUrl(path) {
  if (isNative) {
    const url = getServerUrl();
    if (url) return url + path; // server URL already carries any subpath the user configured
    return path; // native local — caller redirects to NtApiNative
  }
  return _basePath + path;
}
