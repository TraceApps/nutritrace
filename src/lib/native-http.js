/**
 * native-http.js: every CapacitorHttp request the app makes goes through
 * here (scripts/plain-http.test.js keeps it that way).
 *
 * CapacitorHttp sends from Android's own HTTP stack, outside the WebView, so
 * the fetch backstop doesn't see it. Here https:// goes as it always has;
 * http:// goes only to a confirmed server on the person's own network
 * (lib/plain-http.js), and as the URL parser writes it, so Android connects
 * to the same host that was checked; and plain HTTP never follows a redirect,
 * which Android's HTTP stack would otherwise send on in cleartext to wherever
 * it points. Anything else is refused before it leaves, as Android refused
 * cleartext before #194.
 */
import { requestAllowed, blockedError, logBlocked } from './plain-http.js';

/** The URL to hand to CapacitorHttp, or a thrown network error. */
export function nativeRequestUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw blockedError(raw); }
  if (url.protocol === 'https:') return String(raw);
  if (url.protocol === 'http:' && requestAllowed(url.href)) return url.href;
  logBlocked(raw);
  throw blockedError(raw);
}

/** The options CapacitorHttp gets: the checked URL, and no redirects over plain HTTP. */
export function nativeRequestOptions(options = {}) {
  const url = nativeRequestUrl(options.url);
  return url.startsWith('http:') ? { ...options, url, disableRedirects: true } : { ...options, url };
}

async function _send(method, options = {}) {
  const opts = nativeRequestOptions(options);
  const { CapacitorHttp } = await import('@capacitor/core');
  return method === 'post' ? CapacitorHttp.post(opts) : CapacitorHttp.get(opts);
}

export const NativeHttp = {
  get: (options) => _send('get', options),
  post: (options) => _send('post', options),
};
