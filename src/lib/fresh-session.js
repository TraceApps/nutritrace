/**
 * fresh-session.js: when the account's sessions change (#222).
 *
 * A password change, two-step sign-in turned on or off, or Sign Out
 * Everywhere signs every session out (server/lib/session-version.js). The
 * device that made the change gets a new session in the same answer
 * (`session`: { token, csrf }), and adoptSession() puts it where this app
 * keeps its sign-in: the Android app's token (and the copy biometric unlock
 * keeps), the browser's CSRF token (the server set the new cookie).
 *
 * Every other device is told 401 with `session_ended` from then on.
 * endSessionHere() takes it to the sign-in page with a plain message
 * (stores/auth.js sessionEnded). Nothing waiting to go up is dropped: the
 * browser's queue is kept under the account (lib/offline-api.js), the
 * Android app's unsent changes stay on the phone (lib/local-account.js),
 * and both go up at the account's next sign-in.
 */
import { isNative, getServerUrl } from './platform.js';

/** Takes the new session an answer carries, if it carries one. */
export async function adoptSession(session) {
  if (!session || typeof session !== 'object') return;
  if (isNative && getServerUrl() && typeof session.token === 'string' && session.token) {
    const { setAuthToken } = await import('./platform.js');
    setAuthToken(session.token);
    try {
      // Biometric unlock restores its own copy: the old one no longer works.
      const { readSavedToken, saveTokenForBiometric } = await import('./biometric.js');
      if (await readSavedToken()) await saveTokenForBiometric(session.token);
    } catch { /* no biometric unlock */ }
  }
  if (typeof session.csrf === 'string' && session.csrf) {
    try { localStorage.setItem('nt:csrf', session.csrf); } catch { /* no storage */ }
  }
}

// A request sent before this device took its new session (a password
// change, Sign Out Everywhere made here) can come back refused after it:
// asked again with what this device holds now, the server says whether
// this device is really signed out.
async function _stillSignedIn() {
  try {
    const { apiUrl, getAuthToken } = await import('./platform.js');
    const headers = {};
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (!t) return false;
      headers.Authorization = `Bearer ${t}`;
    }
    const res = await fetch(apiUrl('/api/auth/me'), { credentials: 'include', headers, cache: 'no-store' });
    if (!res.ok) return false;
    return !!(await res.json())?.user;
  } catch { return false; }
}

/**
 * This device was signed out: the sign-in page, saying why. The account's
 * copy on this device and anything waiting to go up are kept for its next
 * sign-in; only the sign-in itself goes.
 */
export async function endSessionHere() {
  if (await _stillSignedIn()) return;
  const { currentUser, sessionEnded } = await import('../stores/auth.js');
  sessionEnded.set(true);
  if (isNative) {
    try {
      const { setAuthToken } = await import('./platform.js');
      setAuthToken(null);
    } catch { /* nothing kept */ }
    try {
      const { clearSavedToken } = await import('./biometric.js');
      await clearSavedToken();
    } catch { /* no biometric unlock */ }
    try {
      const { forgetServerCookies } = await import('./local-account.js');
      await forgetServerCookies();
    } catch { /* none kept */ }
  }
  try {
    localStorage.removeItem('wl:userId');
    localStorage.removeItem('nt:cachedUser');
    localStorage.removeItem('nt:csrf');
  } catch { /* no storage */ }
  currentUser.set(null);
}
