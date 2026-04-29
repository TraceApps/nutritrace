import { writable } from 'svelte/store';
import { loadServerSettings } from './settings.js';
import { isNative, getServerUrl, getAuthToken, apiUrl as _apiUrl } from '../lib/platform.js';

function _authHeaders() {
  const h = {};
  if (isNative && getServerUrl()) {
    const token = getAuthToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  }
  return h;
}

/** Currently logged-in user object, or null */
export const currentUser = writable(null);

/** Whether user management is enabled on the server */
export const userMgmtActive = writable(false);

/** True when the server has no users yet — PWA must show setup screen */
export const setupRequired = writable(false);

// Synthetic local user for native standalone mode (no server configured)
const LOCAL_USER = {
  id:        1,
  username:  'local',
  full_name: 'Local User',
  nickname:  null,
  role:      'admin',
  email:     null,
  avatar_url: null,
  birthday:  null,
  gender:    null,
};

/** Load auth state — handles both server mode and native standalone mode */
export async function loadAuthState() {
  // Native standalone: use the synthetic local user, skip all HTTP calls
  if (isNative && !getServerUrl()) {
    userMgmtActive.set(false);
    currentUser.set(LOCAL_USER);
    localStorage.setItem('wl:userId', String(LOCAL_USER.id));
    return;
  }

  // Native server mode: use cached auth IMMEDIATELY so app renders fast,
  // then refresh from server in the background
  if (isNative && getServerUrl()) {
    const cached = localStorage.getItem('nt:cachedUser');
    if (cached) {
      try {
        const user = JSON.parse(cached);
        currentUser.set(user);
        userMgmtActive.set(localStorage.getItem('nt:cachedUserMgmt') === '1');
        localStorage.setItem('wl:userId', String(user.id));
      } catch {}
    }
    // Refresh auth from server in the background (non-blocking)
    _refreshAuthFromServer();
    return;
  }

  // PWA: fetch from server (blocking — no cache to fall back on initially)
  await _fetchAuthFromServer();
}

/** Fetch auth state from server — used by PWA (blocking) and as background refresh for native */
async function _fetchAuthFromServer() {
  try {
    const [statusRes, meRes] = await Promise.all([
      fetch(_apiUrl('/api/auth/status'), { credentials: 'include', headers: _authHeaders(), signal: AbortSignal.timeout(8000) }),
      fetch(_apiUrl('/api/auth/me'),     { credentials: 'include', headers: _authHeaders(), signal: AbortSignal.timeout(8000) }),
    ]);
    const statusData = await statusRes.json();
    const meData     = await meRes.json();
    const user       = meData.user || null;
    userMgmtActive.set(!!statusData.active);
    setupRequired.set(!!statusData.setup_required);
    currentUser.set(user);
    if (user) localStorage.setItem('wl:userId', String(user.id));
    else       localStorage.removeItem('wl:userId');
    if (meData.csrf) localStorage.setItem('nt:csrf', meData.csrf);
    else             localStorage.removeItem('nt:csrf');
    // Cache for offline fallback
    if (user) {
      localStorage.setItem('nt:cachedUser', JSON.stringify(user));
      localStorage.setItem('nt:cachedUserMgmt', active ? '1' : '0');
    }
    if (user) await loadServerSettings();
  } catch {
    // Offline fallback for PWA (native uses cached auth above)
    const cached = localStorage.getItem('nt:cachedUser');
    if (cached) {
      try {
        const user = JSON.parse(cached);
        currentUser.set(user);
        userMgmtActive.set(localStorage.getItem('nt:cachedUserMgmt') === '1');
        localStorage.setItem('wl:userId', String(user.id));
        return;
      } catch {}
    }
    userMgmtActive.set(false);
    currentUser.set(null);
  }
}

/** Background refresh — updates cached auth if server is reachable.
 *  On native, never clear currentUser silently if the server is unreachable;
 *  but DO clear it when the server explicitly says "no user" (401 from /me),
 *  which is what happens after logout. */
async function _refreshAuthFromServer() {
  if (isNative) {
    try {
      const [statusRes, meRes] = await Promise.all([
        fetch(_apiUrl('/api/auth/status'), { credentials: 'include', headers: _authHeaders(), signal: AbortSignal.timeout(3000) }),
        fetch(_apiUrl('/api/auth/me'),     { credentials: 'include', headers: _authHeaders(), signal: AbortSignal.timeout(3000) }),
      ]);
      // Status tells us whether multi-user mode is on. Always update if it
      // came back ok — independent of whether /me succeeds.
      let active = null;
      if (statusRes.ok) {
        try {
          const sd = await statusRes.json();
          active = !!sd.active;
          userMgmtActive.set(active);
          localStorage.setItem('nt:cachedUserMgmt', active ? '1' : '0');
        } catch {}
      }
      // 401 from /me means logged-out (after a logout call, or token expired).
      // Clear local user state so needsLogin in App.svelte fires the Login route.
      if (meRes.status === 401) {
        currentUser.set(null);
        localStorage.removeItem('wl:userId');
        localStorage.removeItem('nt:cachedUser');
        localStorage.removeItem('nt:csrf');
        return;
      }
      if (!meRes.ok) return; // actual server error — keep cached auth
      const meData     = await meRes.json();
      const user       = meData.user || null;
      if (!user) return; // don't clear auth on native — keep cached user
      currentUser.set(user);
      localStorage.setItem('wl:userId', String(user.id));
      localStorage.setItem('nt:cachedUser', JSON.stringify(user));
      if (meData.csrf) localStorage.setItem('nt:csrf', meData.csrf);
      await loadServerSettings();
    } catch {} // server unreachable — silently keep cached auth
    return;
  }
  try {
    await _fetchAuthFromServer();
  } catch {}
}

export async function logout() {
  try { await fetch(_apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include', headers: _authHeaders() }); } catch {}
  // Clear auth state — but keep cached data (foods, images, server URL)
  if (isNative) {
    const { setAuthToken } = await import('../lib/platform.js');
    setAuthToken(null);
  }
  localStorage.removeItem('wl:userId');
  localStorage.removeItem('nt:cachedUser');
  localStorage.removeItem('nt:cachedUserMgmt');
  localStorage.removeItem('nt:csrf');
  currentUser.set(null);
  userMgmtActive.set(false);
}
