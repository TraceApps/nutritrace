/**
 * public-url.js: the address put in links that leave the app, such as the
 * link in a password reset, an invite or a "shared with you" email.
 *
 * Those links used to be built from the request's Host and X-Forwarded-Host
 * headers, which the sender of the request controls. Asking for a reset of
 * someone else's account with X-Forwarded-Host set to your own domain sent
 * the victim a real reset email whose link, token and all, pointed at you.
 *
 * Where the address comes from now, in order:
 *   1. PUBLIC_URL, when the server sets it: the full address the app is
 *      opened at, subpath included (https://example.com/lifttrace).
 *   2. An address an admin has used. Every signed-in admin request records
 *      the address it came in on, so a link goes back to the address it
 *      was asked from when an admin uses that address too. Anything else,
 *      a forged header included, gets the admin's latest address, passing
 *      over localhost when a real one is known. Only a signed-in admin is
 *      recorded: before the first account exists anyone counts as the
 *      operator, and could otherwise plant an address for later.
 *   3. With nothing recorded yet (an upgrade, before an admin has opened
 *      the app), the request's own address, but only when an admin asked:
 *      for anyone else the result is '' and the caller sends no email,
 *      since that address is exactly what an attacker would forge.
 *
 * This file is identical in all four Trace apps.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { userMgmtActive } from '../middleware/auth.js';

const KNOWN_KEY = 'known_origins';   // JSON list, newest last
const LATEST_KEY = 'app_url';        // the admin's latest address
const MAX_KNOWN = 10;
const ORIGIN_RE = /^https?:\/\/[a-z0-9._\-]+(:\d{1,5})?$|^https?:\/\/\[[0-9a-f:.]+\](:\d{1,5})?$/;
const LOOPBACK_RE = /^https?:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/;

const _basePath = () => (process.env.BASE_URL || '').replace(/\/$/, '');

/** The origin a request came in on, from the headers (untrusted). */
export function requestOrigin(req) {
  if (!req?.headers) return null;
  const first = (v) => String(v || '').split(',')[0].trim();
  const proto = (first(req.headers['x-forwarded-proto']) || req.protocol || 'http').toLowerCase();
  const host = (first(req.headers['x-forwarded-host']) || first(req.headers.host)).toLowerCase();
  const origin = `${proto}://${host}`;
  return ORIGIN_RE.test(origin) ? origin : null;
}

/** The logic, apart from where it is stored (tests pass their own store). */
export function createPublicUrl(store, { env = process.env, warn = () => {}, isAdmin = () => false } = {}) {
  // Read fresh each time (one small row): a backup restore rewrites it.
  const load = () => {
    let list = [];
    try { list = JSON.parse(store.get(KNOWN_KEY) || '[]'); } catch { list = []; }
    return Array.isArray(list) ? list.filter(o => ORIGIN_RE.test(o)) : [];
  };
  const latest = () => {
    const l = load();
    if (l.length) return [...l].reverse().find(o => !LOOPBACK_RE.test(o)) || l[l.length - 1];
    // LiftTrace stored one address before this file existed; use it until
    // an admin has been seen.
    const saved = store.get(LATEST_KEY);
    return saved && ORIGIN_RE.test(saved) ? saved : null;
  };

  return {
    /** Record the address of a request an admin made. Cheap when nothing changed. */
    remember(req) {
      // Only a browser or the app: a health check or script hitting the
      // server sends none of these, and shouldn't decide the address.
      const h = req?.headers || {};
      if (!h['sec-fetch-site'] && !h.origin && !h.referer) return;
      const origin = requestOrigin(req);
      if (!origin) return;
      const l = load();
      if (l[l.length - 1] === origin) return;
      const known = l.filter(o => o !== origin).concat(origin).slice(-MAX_KNOWN);
      store.set(KNOWN_KEY, JSON.stringify(known));
      store.set(LATEST_KEY, origin);
    },
    /**
     * Base for an emailed link: scheme, host and subpath, no trailing slash.
     * `req` is the request asking for the email, or null (the scheduler).
     */
    linkBase(req) {
      const pub = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
      if (/^https?:\/\/[^\s/]+/i.test(pub)) return pub;
      const base = _basePath();
      const asked = requestOrigin(req);
      const l = load();
      if (asked && l.includes(asked)) return asked + base;
      const last = latest();
      if (last) return last + base;
      if (asked && isAdmin(req)) return asked + base;
      if (req) warn('[public-url] no email sent: no admin address is known yet. Set PUBLIC_URL, or open the app once as an admin.');
      return '';
    },
  };
}

const _store = {
  get: (key) => db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value ?? null,
  set: (key, value) => db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run(key, value),
};
const _publicUrl = createPublicUrl(_store, {
  warn: (m) => logger.warn(m),
  isAdmin: (req) => !userMgmtActive() || req?.user?.role === 'admin',
});

export const rememberAdminOrigin = (req) => { try { _publicUrl.remember(req); } catch (e) { logger.warn(`[public-url] ${e.message}`); } };
export const linkBase = (req) => _publicUrl.linkBase(req);
