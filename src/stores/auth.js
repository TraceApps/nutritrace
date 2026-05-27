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

/** Server-controlled feature flags (mirrors process.env on the server).
 *  Off by default so dev-only / preview features stay invisible until the
 *  operator opts in. Populated from /api/auth/me responses. */
export const serverFeatures = writable({ apiTokens: false });

// Synthetic local user for native standalone mode (no server configured).
// full_name is overridden at load time from the localUserName setting (set
// in the Wizard's name step) so the rest of the UI (Sidebar, Trace, etc.)
// can read $currentUser.full_name uniformly across server and local modes.
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

/** Read profile fields from local settings and set $currentUser to the
 *  synthetic LOCAL_USER. Used by both native standalone and PWA single-user
 *  so the rest of the UI can read $currentUser uniformly.
 *
 *  `setUserId` controls whether to also write `wl:userId`. Native standalone
 *  always sets it (LOCAL_USER.id=1) — its settings are keyed `wl_u1_<key>`
 *  from day one. PWA single-user does NOT set it: existing installs already
 *  have settings under the anonymous `wl_<key>` prefix, and switching to a
 *  per-user key would orphan them. */
async function _hydrateLocalUser({ setUserId = true } = {}) {
  let fullName = 'Local User';
  let nickname = null;
  let birthday = null;
  let gender   = null;
  let avatar   = null;
  try {
    const { DB } = await import('../lib/db.js');
    const _s = (k) => {
      const v = DB.getSetting(k, null);
      return (typeof v === 'string' && v.trim()) ? v.trim() : null;
    };
    fullName = _s('localUserName')     || fullName;
    nickname = _s('localUserNickname') || null;
    birthday = _s('dob')               || null;
    gender   = _s('gender')            || null;
    avatar   = _s('localUserAvatar')   || null;
  } catch {}
  currentUser.set({ ...LOCAL_USER, full_name: fullName, nickname, birthday, gender, avatar_url: avatar });
  if (setUserId) localStorage.setItem('wl:userId', String(LOCAL_USER.id));
}

/** Load auth state — handles both server mode and native standalone mode */
export async function loadAuthState() {
  // Native standalone: use the synthetic local user, skip all HTTP calls.
  // Hydrate full_name / nickname / birthday / gender / avatar from settings
  // so Sidebar / Trace / Profile / etc. read $currentUser.* uniformly across
  // server and local modes. Wizard + Profile.svelte write to these keys.
  if (isNative && !getServerUrl()) {
    userMgmtActive.set(false);
    await _hydrateLocalUser();
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
    const active     = !!statusData.active;
    userMgmtActive.set(active);
    setupRequired.set(!!statusData.setup_required);
    if (meData.features) serverFeatures.set(meData.features);

    // PWA single-user mode (server reachable, user mgmt off): hydrate the
    // synthetic LOCAL_USER from local settings so $currentUser is never
    // null. Mirrors native standalone — keeps Sidebar / Trace / gates that
    // read $currentUser.role === 'admin' working uniformly. Don't touch
    // `wl:userId`: settings already live under the anonymous `wl_<key>`
    // prefix and switching to per-user keys would silently orphan them.
    if (!active && !user) {
      await _hydrateLocalUser({ setUserId: false });
      localStorage.removeItem('wl:userId');
      if (meData.csrf) localStorage.setItem('nt:csrf', meData.csrf);
      else             localStorage.removeItem('nt:csrf');
      return;
    }

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
      if (meData.features) serverFeatures.set(meData.features);
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

/**
 * Inspect the URL hash for an OIDC callback marker and act on it:
 *   - ?oidc=ok      → toast success, refresh auth + settings
 *   - ?oidc=linked  → toast linked, refresh auth (Profile-page link flow)
 *   - ?oidc_error=  → toast the (URL-decoded) error message
 *
 * Strips the marker from the URL after handling so a refresh doesn't repeat
 * the side effects.
 */
export async function handleOidcCallback() {
  if (typeof window === 'undefined' || !window.location?.hash) return false;
  const hash = window.location.hash; // e.g. "#/?oidc=ok" or "#/profile?oidc_error=foo"
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return false;
  const path = hash.slice(0, qIdx);
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const ok = params.get('oidc');
  const err = params.get('oidc_error');
  if (!ok && !err) return false;

  // Strip marker(s) and leave the rest of the query intact.
  params.delete('oidc');
  params.delete('oidc_error');
  const remaining = params.toString();
  const cleanHash = remaining ? `${path}?${remaining}` : path;
  history.replaceState(null, '', window.location.pathname + window.location.search + cleanHash);

  const { showSuccess, showError } = await import('./toast.js');
  const { get } = await import('svelte/store');
  const { _ } = await import('svelte-i18n');
  const t = (key, fallback) => {
    try { const v = get(_)(key); return (v && v !== key) ? v : fallback; }
    catch { return fallback; }
  };
  if (err) {
    showError(decodeURIComponent(err));
    return true;
  }
  if (ok === 'ok') {
    showSuccess(t('common.signed_in', 'Signed in'));
    await _fetchAuthFromServer();
  } else if (ok === 'linked') {
    showSuccess(t('common.linked', 'Linked'));
    await _fetchAuthFromServer();
  }
  return true;
}

export async function logout() {
  let logoutUrl = null;
  try {
    // Mobile flag tells the server to use the nutritrace://oidc-callback
    // deep link as post_logout_redirect_uri so the Capacitor browser can
    // route back into the app after the IdP destroys the session. PWA
    // uses the HTTPS root URL of the deployment.
    const logoutPath = isNative
      ? '/api/auth/oidc/logout?mobile=1'
      : '/api/auth/oidc/logout';
    // Native clients send back the id_token_hint + providerId they were
    // handed at OIDC login time. PWA leaves the body empty and the server
    // reads the matching httpOnly cookie instead.
    let body = null;
    if (isNative) {
      try {
        const raw = localStorage.getItem('nt:oidc_logout_hint');
        if (raw) body = JSON.parse(raw);
      } catch {}
    }
    const oidcRes = await fetch(_apiUrl(logoutPath), {
      method: 'POST',
      credentials: 'include',
      headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const oidcData = await oidcRes.json().catch(() => null);
    logoutUrl = oidcData?.logoutUrl || null;
    // Hint served its purpose; clear it whether or not the call succeeded.
    try { localStorage.removeItem('nt:oidc_logout_hint'); } catch {}
  } catch {}
  try { await fetch(_apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include', headers: _authHeaders() }); } catch {}
  // Clear auth state — but keep cached data (foods, images, server URL)
  if (isNative) {
    const { setAuthToken } = await import('../lib/platform.js');
    setAuthToken(null);
    // Wipe biometric-cached JWT too, otherwise the next launch could
    // bypass the password gate after the user explicitly signed out.
    try {
      const { clearSavedToken } = await import('../lib/biometric.js');
      await clearSavedToken();
    } catch {}
  }
  localStorage.removeItem('wl:userId');
  localStorage.removeItem('nt:cachedUser');
  localStorage.removeItem('nt:csrf');
  currentUser.set(null);
  // Note: userMgmtActive is a server-wide flag, not per-session. Don't flip
  // it on logout — that hides the Login gate in App.svelte (needsLogin =
  // userMgmtActive && !currentUser) and leaves the user stuck in a half-
  // rendered app. Keep the cached value too so a post-logout reload doesn't
  // briefly flicker into the wizard before the server confirms.
  if (logoutUrl) {
    if (isNative) {
      // Open the IdP's end-session URL in @capacitor/browser; the IdP
      // redirects to nutritrace://oidc-callback when done, which
      // App.svelte's appUrlOpen listener catches and closes the browser.
      try {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url: logoutUrl, presentationStyle: 'popover' });
      } catch {}
    } else {
      window.location.href = logoutUrl;
    }
  }
}
