/**
 * cross-site.js: refuses changes that a page on another site makes the
 * person's browser send.
 *
 * A page anywhere can make a browser send a POST to this server without
 * asking first: an HTML form, fetch() with mode 'no-cors', a file upload.
 * The page can't read the answer, but the change is made. Two kinds of
 * server had nothing to stop that:
 *   - a server with no accounts (single-user mode) takes any request, so a
 *     page on any site could, for example, restore an uploaded backup;
 *   - a page the browser counts as the same site (another name under the
 *     same domain, the same machine on another port) gets the sign-in
 *     cookie too, since SameSite=Lax only holds back other sites, and an
 *     app without a CSRF token took those writes as the person's own.
 *
 * Browsers say where a request comes from, and a page can't change or drop
 * those headers (both are forbidden to scripts):
 *   - Sec-Fetch-Site (Fetch Metadata): 'same-origin', 'same-site',
 *     'cross-site', or 'none' when the person typed the address. Only sent
 *     to https addresses and localhost.
 *   - Origin: sent with every request that isn't GET or HEAD, same-origin
 *     ones included (Fetch standard, "append a request Origin header").
 *     It is 'null' from a sandboxed frame, a file:// page, a redirect from
 *     another origin, or a page that sends no referrer.
 *
 * So a change (any method but GET, HEAD and OPTIONS) is let through when:
 *   1. Sec-Fetch-Site is 'same-origin' or 'none'; or
 *   2. Origin is one the app already allows for CORS (lib/cors.js: its
 *      Android WebView, PUBLIC_URL's address), or exactly this request's
 *      own address: the scheme and host it came in on, as a reverse proxy
 *      reports them (X-Forwarded-Proto, X-Forwarded-Host) or as the Host
 *      header says (the web app over plain http on a LAN sends no
 *      Sec-Fetch-Site); or
 *   3. it carries neither header: it isn't from a browser page (the
 *      Android app's native code, the watch apps, MCP clients, scripts,
 *      another Trace server). A browser always sends Origin on these
 *      methods, so a page can't pass this way.
 * Anything else gets a 403 and one warning in the log per address (at
 * most 20 a minute).
 *
 * This file is identical in all four Trace apps.
 */
import { corsOrigin, originOf } from './cors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_LOGGED = 200;      // addresses remembered as already logged
const MAX_PER_MINUTE = 20;   // warnings at most, however many addresses

const first = (v) => String(v ?? '').split(',')[0].trim();

/**
 * The addresses this request came in on, written like an Origin header:
 * the reverse proxy's view (X-Forwarded-Proto and X-Forwarded-Host) and
 * the Host header's, which differ when a proxy forwards both.
 */
export function ownOrigins(req) {
  const h = req?.headers || {};
  const proto = (first(h['x-forwarded-proto']) || req?.protocol || 'http').toLowerCase();
  const out = [];
  for (const host of [first(h['x-forwarded-host']), first(h.host)]) {
    if (!host || /[\s/@\\?#]/.test(host)) continue;
    const o = originOf(`${proto}://${host}`);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

/**
 * Whether a request may change something. `appOrigins` are the addresses
 * the app's WebView has had, as passed to corsOrigin().
 */
export function crossSiteAllowed(req, { appOrigins = [], env = process.env } = {}) {
  if (SAFE_METHODS.has(String(req?.method || '').toUpperCase())) return true;
  const h = req?.headers || {};
  const site = h['sec-fetch-site'];
  const header = h.origin;
  if (site === 'same-origin' || site === 'none') return true;
  if (site === undefined && header === undefined) return true;
  if (header === undefined) return false;
  if (corsOrigin(req, { appOrigins, env })) return true;
  const origin = originOf(header, { whole: true });
  return !!origin && ownOrigins(req).includes(origin);
}

/**
 * Express middleware. `exempt` lists exact paths (relative to where the
 * router is mounted) that change nothing and must work from anywhere.
 * `warn` gets one line per refused address.
 */
export function crossSiteGuard({ appOrigins = [], exempt = [], warn = () => {}, env = process.env } = {}) {
  const logged = new Set();
  let minute = 0, inMinute = 0;
  return (req, res, next) => {
    if (crossSiteAllowed(req, { appOrigins, env })) return next();
    if (exempt.includes(req.path)) return next();
    // Header values go into the log printable and short.
    const clean = (v, n) => (v === undefined ? 'not sent' : String(v).replace(/[^\x21-\x7e]/g, '?').slice(0, n));
    const origin = clean(req.headers.origin, 200);
    const now = Math.floor(Date.now() / 60000);
    if (now !== minute) { minute = now; inMinute = 0; }
    if (!logged.has(origin) && inMinute < MAX_PER_MINUTE) {
      if (logged.size >= MAX_LOGGED) logged.clear();
      logged.add(origin);
      inMinute++;
      const site = clean(req.headers['sec-fetch-site'], 40);
      warn(`[cross-site] refused ${req.method} ${req.path.slice(0, 200)} from ${origin} (Sec-Fetch-Site: ${site}). Logged once per address. If this is the app's own address, set PUBLIC_URL to it.`);
    }
    res.status(403).json({
      error: 'This change came from a page on another address, so it was refused. If this is the app\'s own address, set PUBLIC_URL to it on the server.',
      code: 'cross_site',
    });
  };
}
