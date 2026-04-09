import { writable } from 'svelte/store';
import { loadServerSettings } from './settings.js';
import { isNative, getServerUrl, getAuthToken } from '../lib/platform.js';

function _apiUrl(path) {
  if (isNative) { const url = getServerUrl(); if (url) return url + path; }
  return path;
}

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
    const { active } = await statusRes.json();
    const meData     = await meRes.json();
    const user       = meData.user || null;
    userMgmtActive.set(!!active);
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

/** Background refresh — updates cached auth if server is reachable */
async function _refreshAuthFromServer() {
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
