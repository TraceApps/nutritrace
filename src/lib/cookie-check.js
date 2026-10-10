/**
 * cookie-check.js: will the browser keep the sign-in cookie?
 *
 * The server marks its session cookie Secure unless INSECURE_COOKIES=1, and a
 * browser only keeps a Secure cookie on a secure page (HTTPS, or localhost).
 * From a plain-HTTP address the sign-in succeeds, the cookie is thrown away,
 * and the next request lands back on the login page with no error, which is
 * how #20, #41, #43 and #195 all started. The login page and the setup
 * wizard check this up front and say why, instead of looping.
 *
 * `status` is the server's /api/auth/status reply. The Android app is never
 * affected: it signs in with a token, not the cookie.
 */
export function cookieBlockedByHttp(status, { native = false, secureContext } = {}) {
  if (native) return false;
  const secure = secureContext ?? (typeof window !== 'undefined' ? window.isSecureContext : true);
  return status?.secure_cookies === true && secure === false;
}

/** Why a sign-in that succeeded did not stick: plain HTTP, or something else
 *  (blocked cookies, a proxy dropping them). Drives the wording on screen. */
export function droppedCookieReason(status, opts = {}) {
  return cookieBlockedByHttp(status, opts) ? 'http' : 'dropped';
}

// Where "How to fix it" goes for each reason: the plain-HTTP page, or the
// reverse-proxy guide when the page was secure and something else dropped it.
export const COOKIE_HELP_URLS = {
  http:    'https://traceapps.github.io/docs/getting-started/lan-http/',
  dropped: 'https://traceapps.github.io/docs/getting-started/reverse-proxy/',
};
