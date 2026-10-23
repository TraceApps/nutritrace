/**
 * plain-http.js: plain http:// to a server, in the Android app (#194).
 *
 * The app may use plain HTTP only with a server on the person's own network
 * (lib/local-address.js), and only after they said Connect Anyway to the
 * warning for that server. The answer is kept per origin, so the warning
 * comes once per server. The web app and the PWA never use this: there the
 * browser that opened the page decides.
 *
 * Android allows cleartext app-wide (it can't scope it by address range), so
 * every request the app makes is checked here instead:
 *   - window.fetch and XMLHttpRequest (lib/request-id-fetch.js);
 *   - CapacitorHttp (lib/native-http.js);
 *   - images, through a Content-Security-Policy (imagePolicy below);
 *   - the background Health Connect worker, by its own Kotlin copy of the
 *     rule and the value mirroredConfirmation() puts in sync_meta.
 * Anything else over http:// is refused, as Android refused it before.
 */
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { classifyServerAddress, addressOrigin } from './local-address.js';

const KEY = 'nt:plainHttpOk';
export const HTTPS_GUIDE_URL = 'https://traceapps.github.io/docs/self-hosting/lan-https/';

function _read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

/** Origins the person said Connect Anyway to. */
export function confirmedOrigins() {
  return _read();
}

/** Whether http:// to this URL is both local and confirmed. */
export function plainHttpConfirmed(url) {
  if (classifyServerAddress(url) !== 'local') return false;
  return _read().includes(addressOrigin(url));
}

/** Remember Connect Anyway for this server. Only a local http:// address is kept. */
export function confirmPlainHttp(url) {
  if (classifyServerAddress(url) !== 'local') return false;
  const origin = addressOrigin(url);
  const list = _read();
  if (!list.includes(origin)) {
    list.push(origin);
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { return false; }
  }
  return true;
}

/**
 * What connecting to a server address needs:
 *   'https'     - nothing, go ahead;
 *   'confirmed' - local http://, already confirmed: go ahead;
 *   'ask'       - local http://: show the warning first;
 *   'refuse'    - http:// to anything else: refuse before any request;
 *   'invalid'   - not an http(s) URL (no scheme, ftp:, a typo): the connect
 *                 screens ask for an http:// or https:// address instead.
 */
export function serverAddressCheck(url) {
  const kind = classifyServerAddress(url);
  if (kind === 'local') return plainHttpConfirmed(url) ? 'confirmed' : 'ask';
  if (kind === 'public') return 'refuse';
  return kind;
}

/**
 * The backstop for a request the Android app is about to make: false only
 * for http:// that isn't a confirmed local server. `base` resolves a relative
 * URL (the page's own address, which is https).
 */
export function requestAllowed(url, base) {
  let target;
  try { target = new URL(String(url), base); } catch { return true; } // unparseable: the request fails by itself
  if (target.protocol !== 'http:') return true;
  return plainHttpConfirmed(target.href);
}

function _originOf(url) {
  try { return new URL(String(url)).origin; } catch { return ''; }
}

/**
 * The error a refused request fails with: a network error (`offline`, see
 * lib/offline-edits.js), so callers treat it as no connection. Its message is
 * in the person's language, since a push test shows it as it comes.
 */
export function blockedError(url) {
  const origin = _originOf(url) || String(url ?? '');
  let message = `Plain HTTP to ${origin} isn't allowed. Use an https:// address, or a server on your own network.`;
  try {
    const t = get(_);
    const said = t('plain_http.blocked', { values: { origin } });
    if (said && said !== 'plain_http.blocked') message = said;
  } catch { /* i18n not started (tests, very early boot): English */ }
  const err = new TypeError(message);
  err.code = 'PLAIN_HTTP_BLOCKED';
  err.offline = true;
  return err;
}

// A refused request is logged once per origin, not on every 30-second retry.
const _logged = new Set();
export function logBlocked(url) {
  const origin = _originOf(url) || String(url ?? '');
  if (_logged.has(origin)) return;
  _logged.add(origin);
  console.warn(`[http] plain HTTP to ${origin} refused (not a confirmed server on your own network)`);
}

/**
 * The confirmed server as the URL parser writes it: origin plus path, no
 * trailing slash. The Kotlin worker rebuilds the same text from what it
 * parsed and sends only when the two match, so it can never reach a host
 * the two parsers read differently (#194).
 */
export function canonicalServerBase(url) {
  try {
    const u = new URL(String(url));
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

/**
 * The value platform.js keeps in sync_meta 'server_http_ok' for the Kotlin
 * worker: the confirmed local http:// server as canonicalServerBase() writes
 * it, otherwise ''. The worker sends over HTTP only when the address it
 * rebuilds from server_url is exactly this.
 */
export function mirroredConfirmation(serverUrl) {
  return serverUrl && plainHttpConfirmed(serverUrl) ? canonicalServerBase(serverUrl) : '';
}

/**
 * Content-Security-Policy for images in the Android app: anything but
 * http://, plus the confirmed local servers. Set once at start.
 *
 * Belt and braces: the WebView itself blocks an http:// image on the app's
 * https:// page as mixed content (seen on Android 15's WebView, with or
 * without this policy), and the app shows server pictures from its image
 * cache, downloaded through lib/native-http.js. A source list can't name an
 * IPv6 address or a name with an underscore, so those servers are left out
 * rather than written as a source the WebView would throw away.
 */
const CSP_HOST = /^http:\/\/[a-z0-9.-]+(:\d+)?$/;
export function imagePolicy(origins = confirmedOrigins()) {
  const local = origins.filter(o => classifyServerAddress(o) === 'local' && CSP_HOST.test(o));
  return ["img-src 'self' https: data: blob: file: content:", ...local].join(' ');
}

/**
 * Whether the policy set at start is missing a server confirmed since (an
 * OIDC sign-in from the setup screen finishes without a reload). A policy
 * can only be tightened once set, so the caller reloads.
 */
export function imagePolicyStale(current) {
  return typeof current === 'string' && current !== imagePolicy();
}
