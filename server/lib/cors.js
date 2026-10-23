/**
 * cors.js: which web pages on another address may call this server's API
 * with the person's sign-in, and read the answer.
 *
 * The check used to be `origin.includes(host)`, so any address with this
 * server's name inside it passed: https://notes.example.com.attacker.tld,
 * https://xnotes.example.com, https://anything.notes.example.com, the same
 * name on another port or scheme, and on a LAN http://192.168.1.5:30041 for
 * a server on :3004. A page on an address the browser counts as the same
 * site (a subdomain, another name under the same domain, another port on the
 * same machine) gets the sign-in cookie too, so it could read the account
 * and write to it, CSRF token included (read from /api/auth/me). Other
 * lookalikes get no cookie (SameSite=Lax), but on a server with no accounts
 * (single-user mode) they could read everything the browser can reach.
 *
 * Now an address is compared whole (scheme, host and port), and only these
 * get CORS headers:
 *   - the Android app's WebView: https://app.<app>.local, and for an app
 *     whose older versions ran on it, https://localhost (the caller says);
 *   - the address in PUBLIC_URL, when it is set.
 * The web app calls its own address, which needs no CORS headers; scripts,
 * the API, MCP, the watch apps and other servers send no Origin.
 *
 * This file is identical in all four Trace apps.
 */

/**
 * The scheme, host and port of an address, written the way a browser writes
 * an Origin header (lowercase, default port left out), or null when it isn't
 * an http(s) address. With `whole`, the value must be exactly that already
 * (an Origin header never has a path, a user or a trailing slash).
 */
export function originOf(value, { whole = false } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (whole && s !== u.origin) return null;
  return u.origin;
}

/**
 * The Origin to answer with Access-Control-Allow-Origin (the request's own
 * header, exactly), or null for no CORS headers. `appOrigins` are the
 * addresses the app's WebView has had, such as https://app.lifttrace.local.
 */
export function corsOrigin(req, { appOrigins = [], env = process.env } = {}) {
  const header = req?.headers?.origin;
  const origin = originOf(header, { whole: true });
  if (!origin) return null;
  if (appOrigins.includes(origin)) return header;
  const pub = originOf(env.PUBLIC_URL);
  if (pub && origin === pub) return header;
  return null;
}
