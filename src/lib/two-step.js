/**
 * two-step.js: the app's side of two-step sign-in (#222). The server half
 * is server/routes/two-step.js.
 *
 * Every sign-in that takes a password (the sign-in page, the Android app's
 * first run, Settings > Server Connection) gets a second step when the
 * server answers with `two_step`: 'verify' (a code) or 'setup' (the admin
 * requires it and it isn't set up yet). components/TwoStepChallenge.svelte
 * asks for it; this file talks to the server.
 */
import { apiUrl, isNative, getServerUrl, getAuthToken } from './platform.js';

/** The second step a sign-in answer asks for: { kind, pendingToken }, or null. */
export function twoStepChallenge(data) {
  const kind = data?.two_step;
  if ((kind === 'verify' || kind === 'setup') && typeof data.pending_token === 'string' && data.pending_token) {
    return { kind, pendingToken: data.pending_token };
  }
  return null;
}

function _headers() {
  const h = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    const t = getAuthToken();
    if (t) h.Authorization = `Bearer ${t}`;
  } else {
    try {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    } catch { /* no storage */ }
  }
  return h;
}

/**
 * One call to /api/auth/two-step{path}: { status, data }. `serverUrl` is for
 * the Android app signing in to a server it isn't connected to yet (its own
 * HTTP, no CORS, no session); otherwise the app's own server, with this
 * session's sign-in.
 */
export async function twoStepCall(path, { method = 'POST', body, serverUrl = null } = {}) {
  if (serverUrl) {
    const { NativeHttp } = await import('./native-http.js');
    const { serverJson } = await import('./server-signin.js');
    const url = `${serverUrl}/api/auth/two-step${path}`;
    const res = method === 'GET'
      ? await NativeHttp.get({ url, headers: { 'Content-Type': 'application/json' } })
      : await NativeHttp.post({ url, headers: { 'Content-Type': 'application/json' }, data: body || {} });
    return { status: res.status, data: serverJson(res) };
  }
  const res = await fetch(apiUrl(`/api/auth/two-step${path}`), {
    method,
    credentials: 'include',
    headers: _headers(),
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  // Turned on or off from a session: every other device signed out, and the
  // answer carries this one's new session (lib/fresh-session.js).
  if (res.ok && data?.session && !body?.pending_token) {
    const { adoptSession } = await import('./fresh-session.js');
    await adoptSession(data.session);
  }
  return { status: res.status, data };
}

/** The error a failed call says, as an Error with the server's fields on it. */
export function callError(r, fallback) {
  return Object.assign(new Error(r?.data?.error || fallback), {
    status: r?.status,
    restart: !!r?.data?.restart,
    keyProblem: r?.data?.key_problem || null,
    codeRequired: !!r?.data?.code_required,
  });
}

/** Recovery codes as text to copy or keep: one a line, with what they are. */
export function recoveryCodesText(codes, { account = '', server = '' } = {}) {
  const head = ['NutriTrace recovery codes', account && `Account: ${account}`, server && `Server: ${server}`, 'Each code signs in once.'].filter(Boolean);
  return [...head, '', ...codes].join('\n');
}

/** A base32 key in groups of four, easier to type into an app. */
export function groupKey(key) {
  return String(key || '').replace(/(.{4})(?=.)/g, '$1 ');
}
