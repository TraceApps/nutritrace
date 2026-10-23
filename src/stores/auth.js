import { writable, get as getStore } from 'svelte/store';
import { loadServerSettings } from './settings.js';
import { isNative, getServerUrl, getAuthToken, apiUrl as _apiUrl } from '../lib/platform.js';
import { setCoachingFromServer, loadCachedCoaching, clearCoaching } from './coaching.js';
import { responseJson, webPageError, statusError, serverProblem } from '../lib/server-signin.js';

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

/** Why the server couldn't say who is signed in at startup, or null:
 *  'unreachable', 'server_error' (it answered with its own error) or
 *  'proxy' (something in front of it asked to sign in).
 *  The sign-in page says it with Retry, never the app with nobody signed in. */
export const authUnreachable = writable(null);
// Whoever signs in (any path) is past it: a later sign-out never shows it again.
currentUser.subscribe((u) => { if (u) authUnreachable.set(null); });

// Whether the server has accounts, as it last said: '1' yes, '0' single-user,
// none when never heard from. Decides the first screen when it can't be asked.
const MGMT_KEY = 'nt:cachedUserMgmt';
const _lastMgmt = () => localStorage.getItem(MGMT_KEY);

// A browser used with a single-user server before this was remembered: its
// settings sit under the bare `wl_` prefix (setup done), and nobody ever
// signed in here (no `wl_u<id>_` settings, no wl:userId).
function _singleUserBrowser() {
  if (localStorage.getItem('wl:userId')) return false;
  let setUp = false;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (/^wl_u\d+(@[^_]*)?_/.test(k)) return false;
    if (k === 'wl_setupComplete') setUp = true;
  }
  return setUp;
}

// No answer at all (offline, the connection refused, too slow), as opposed
// to an answer that isn't the server's (a proxy's page, a gateway's 5xx).
const _noAnswer = (e) => e instanceof TypeError || e?.name === 'TimeoutError' || e?.name === 'AbortError'
  || (typeof navigator !== 'undefined' && navigator.onLine === false);

/** True when the server has no users yet — PWA must show setup screen */
export const setupRequired = writable(false);
// Why the last sign-in didn't stick, if it didn't ('http' | 'dropped'), so
// the login page can say so. A store, not page state, because the login page
// is torn down and rebuilt when the user flips on and back off. See
// lib/cookie-check.js.
export const signInProblem = writable(null);

/** Server-controlled feature flags (mirrors process.env on the server).
 *  Populated from /api/auth/me responses. Currently empty; kept as a
 *  writable for forward compatibility so future flags can land without
 *  reintroducing the import surface. The apiTokens flag was retired in
 *  rc.42 once the federation API matured into a documented product
 *  feature; the Settings panel is now always visible to admins. */
// Kept between launches, so what depends on a flag (the weekly summary
// toggle and email) still shows with no connection.
const _cachedFeatures = (() => { try { return JSON.parse(localStorage.getItem('nt:serverFeatures') || '{}') || {}; } catch { return {}; } })();
export const serverFeatures = writable(_cachedFeatures);
function _setFeatures(f) {
  serverFeatures.set(f);
  try { localStorage.setItem('nt:serverFeatures', JSON.stringify(f)); } catch {}
}

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
    clearCoaching();
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
        userMgmtActive.set(_lastMgmt() === '1');
        localStorage.setItem('wl:userId', String(user.id));
        loadCachedCoaching(user.id);
      } catch {}
    }
    // No account on the phone (signed out, or another's was cleared): the
    // sign-in page until the server says otherwise, never the app with
    // nobody. Only a server last known to be single-user opens the app.
    // A stored session (just connected, the account not fetched yet) opens the
    // app as before, and the refresh fills in the account.
    if (getStore(currentUser) == null && !getAuthToken() && _lastMgmt() !== '0') userMgmtActive.set(true);
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
    // redirect 'manual': the server never redirects these, so a redirect is
    // something in front of it sending this browser to its own sign-in.
    const [statusRes, meRes] = await Promise.all([
      fetch(_apiUrl('/api/auth/status'), { credentials: 'include', redirect: 'manual', headers: _authHeaders(), signal: AbortSignal.timeout(8000) }),
      fetch(_apiUrl('/api/auth/me'),     { credentials: 'include', redirect: 'manual', headers: _authHeaders(), signal: AbortSignal.timeout(8000) }),
    ]);
    if (statusRes.type === 'opaqueredirect' || meRes.type === 'opaqueredirect') throw webPageError();
    // A sign-in proxy's page or a gateway's error page isn't the server's
    // answer (lib/server-signin.js): the catch below says which.
    const statusData = await responseJson(statusRes);
    const meData     = await responseJson(meRes);
    // The server's own error (5xx, 429) is it answering; anything else is it out of reach.
    if (!statusRes.ok) throw statusError(statusRes.status, statusData);
    if (!meRes.ok) throw statusError(meRes.status, meData);
    // Every NutriTrace says whether it has accounts: an empty or other answer
    // is something else in the way, never taken for a single-user server.
    if (typeof statusData.active !== 'boolean') throw webPageError();
    const user       = meData.user || null;
    const active     = !!statusData.active;
    userMgmtActive.set(active);
    setupRequired.set(!!statusData.setup_required);
    authUnreachable.set(null);
    localStorage.setItem(MGMT_KEY, active ? '1' : '0');
    if (meData.features) _setFeatures(meData.features);

    // PWA single-user mode (server reachable, user mgmt off): hydrate the
    // synthetic LOCAL_USER from local settings so $currentUser is never
    // null. Mirrors native standalone — keeps Sidebar / Trace / gates that
    // read $currentUser.role === 'admin' working uniformly. Don't touch
    // `wl:userId`: settings already live under the anonymous `wl_<key>`
    // prefix and switching to per-user keys would silently orphan them.
    if (!active && !user) {
      clearCoaching();
      await _hydrateLocalUser({ setUserId: false });
      localStorage.removeItem('wl:userId');
      if (meData.csrf) localStorage.setItem('nt:csrf', meData.csrf);
      else             localStorage.removeItem('nt:csrf');
      return;
    }

    currentUser.set(user);
    if (user) localStorage.setItem('wl:userId', String(user.id));
    else       localStorage.removeItem('wl:userId');
    // Coaching: a server from before it sends neither field, and the tabs stay away.
    setCoachingFromServer({ supported: statusData.coaching ?? 0, state: user ? (meData.coaching ?? null) : null, userId: user?.id });
    if (meData.csrf) localStorage.setItem('nt:csrf', meData.csrf);
    else             localStorage.removeItem('nt:csrf');
    // Cache for offline fallback
    if (user) localStorage.setItem('nt:cachedUser', JSON.stringify(user));
    if (user) await loadServerSettings();
  } catch (e) {
    // Offline fallback for PWA (native uses cached auth above)
    const cached = localStorage.getItem('nt:cachedUser');
    if (cached) {
      try {
        const user = JSON.parse(cached);
        currentUser.set(user);
        userMgmtActive.set(_lastMgmt() === '1');
        localStorage.setItem('wl:userId', String(user.id));
        loadCachedCoaching(user.id);
        return;
      } catch {}
    }
    // Nobody signed in on this browser, and the server can't say who may
    // be: a server known to be single-user opens as it would online; any
    // other gets the sign-in page saying why, with Retry. Never the app
    // with nobody signed in.
    const last = _lastMgmt();
    if (last === '0' || (last == null && _singleUserBrowser())) {
      userMgmtActive.set(false);
      await _hydrateLocalUser({ setUserId: false });
      return;
    }
    // Never heard from and simply no answer (a browser from before this was
    // remembered, opened offline): as it always was, remembering nothing.
    if (last == null && _noAnswer(e)) {
      userMgmtActive.set(false);
      currentUser.set(null);
      return;
    }
    console.warn('[auth] server state unreadable:', e?.status || e?.message);
    userMgmtActive.set(true);
    currentUser.set(null);
    const why = serverProblem(e);
    authUnreachable.set(why === 'options' ? 'unreachable' : why);
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
      let coachingSupportedNow;
      if (statusRes.ok) {
        try {
          const sd = await statusRes.json();
          active = !!sd.active;
          userMgmtActive.set(active);
          localStorage.setItem(MGMT_KEY, active ? '1' : '0');
          coachingSupportedNow = sd.coaching ?? 0;
        } catch {}
      }
      // 401 from /me means logged-out (after a logout call, or token expired).
      // Clear local user state so needsLogin in App.svelte fires the Login route.
      if (meRes.status === 401) {
        currentUser.set(null);
        clearCoaching();
        localStorage.removeItem('wl:userId');
        localStorage.removeItem('nt:cachedUser');
        localStorage.removeItem('nt:csrf');
        try {
          const { forgetServerCookies } = await import('../lib/local-account.js');
          await forgetServerCookies();
        } catch {}
        return;
      }
      if (!meRes.ok) return; // actual server error — keep cached auth
      const meData     = await meRes.json();
      const user       = meData.user || null;
      if (meData.features) _setFeatures(meData.features);
      if (!user) return; // don't clear auth on native — keep cached user
      currentUser.set(user);
      localStorage.setItem('wl:userId', String(user.id));
      localStorage.setItem('nt:cachedUser', JSON.stringify(user));
      if (meData.csrf) localStorage.setItem('nt:csrf', meData.csrf);
      setCoachingFromServer({ supported: coachingSupportedNow, state: meData.coaching ?? null, userId: user.id });
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
  // Native: the phone keeps its copy of the account, so signing back in to
  // the same account picks up where it left off. Send what's waiting first,
  // while the session still works: a push only, cut off after a few
  // seconds. What can't go now stays for this account (lib/local-account.js
  // keeps it from going up under anyone else).
  if (isNative && getServerUrl()) {
    try {
      const { pushBeforeSignOut } = await import('../lib/sync.js');
      await pushBeforeSignOut();
    } catch { /* never block sign-out */ }
  }
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
      // Android: a server that doesn't answer never holds up signing out.
      ...(isNative ? { signal: AbortSignal.timeout(5000) } : {}),
      headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const oidcData = await oidcRes.json().catch(() => null);
    logoutUrl = oidcData?.logoutUrl || null;
    // Hint served its purpose; clear it whether or not the call succeeded.
    try { localStorage.removeItem('nt:oidc_logout_hint'); } catch {}
  } catch {}
  try { await fetch(_apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include', headers: _authHeaders(), ...(isNative ? { signal: AbortSignal.timeout(5000) } : {}) }); } catch {}

  // The browser's offline mirror and queue belong to the account that just
  // signed out, so they go with it. Anything still waiting is sent first, so
  // signing out on a flaky connection doesn't quietly drop a logged meal.
  if (!isNative) {
    try {
      const { flushOutbox, clearOffline, pendingCount } = await import('../lib/offline-api.js');
      const sent = await flushOutbox().catch(() => false);
      // Coaching messages written offline wait in their own queue: sent too.
      const cm = await import('../lib/coach-messages.js');
      await cm.flushCoachMessages().catch(() => {});
      const coachWaiting = (await cm.pendingCoachMessages().catch(() => [])).length;
      // If it couldn't go up (signing out in a dead zone), ask first: clearing
      // it would destroy work the user never saw fail.
      if ((!sent && (await pendingCount()) > 0) || coachWaiting > 0) {
        const waiting = (await pendingCount()) + coachWaiting;
        const { confirmDialog } = await import('./confirmDialog.js');
        const { get: getStore } = await import('svelte/store');
        const { _: t } = await import('svelte-i18n');
        const say = getStore(t);
        const ok = await confirmDialog({
          title: say('sync.sign_out_waiting_title'),
          message: say('sync.sign_out_waiting', { values: { count: waiting } }),
          confirmText: say('sync.sign_out_anyway'),
          dangerous: true,
        });
        if (!ok) return;
      }
      await clearOffline();
    } catch { /* never block sign-out */ }
  }
  // Clear auth state, but keep cached data (foods, images, server URL).
  if (isNative) {
    const { setAuthToken } = await import('../lib/platform.js');
    setAuthToken(null);
    // The server's session cookie goes too (lib/local-account.js).
    try {
      const { forgetServerCookies } = await import('../lib/local-account.js');
      await forgetServerCookies();
    } catch {}
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
  clearCoaching();
  // The day, activities and fasts on show are this account's: gone before
  // anyone else signs in (lib/user-state.js).
  try {
    const { resetUserState } = await import('../lib/user-state.js');
    await resetUserState();
    if (isNative) {
      const la = await import('../lib/local-account.js');
      la.bumpAccountGeneration();
      la.resetAccountGate();
    }
  } catch { /* never block sign-out */ }
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
