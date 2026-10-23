/**
 * redact-url.js: a URL as it may appear in the server log.
 *
 * The proxy and other outbound requests logged the full address, so a USDA
 * search that came back with an error put the person's `api_key` in the
 * server log, and a `user:password@` address would have put a password
 * there. This keeps the host and path and replaces secrets with ***:
 * query parameters whose name says key, token, secret, password, auth,
 * signature or session, and any user name and password before the host.
 *
 * Only for logging. The request itself always uses the address unchanged.
 * Identical in NutriTrace, CookTrace, LiftTrace and NoteTrace.
 */

const SECRET_PARAM = /key|token|secret|pass(word|wd)?|pwd|auth|sig(nature)?|session|credential/i;

export function redactUrl(value) {
  const s = String(value ?? '');
  try {
    const u = new URL(s);
    if (u.username || u.password) { u.username = '***'; u.password = ''; }
    for (const name of [...new Set(u.searchParams.keys())]) {
      if (SECRET_PARAM.test(name)) u.searchParams.set(name, '***');
    }
    return u.toString();
  } catch {
    // Not a whole URL: still hide what looks like a secret.
    return s
      .replace(/\/\/[^/@\s?#]+@/g, '//***@')
      .replace(/([?&;]([^=&#\s]*)=)([^&#\s]*)/g, (m, head, name) => (SECRET_PARAM.test(name) ? head + '***' : m));
  }
}
