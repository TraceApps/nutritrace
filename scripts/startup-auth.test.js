/**
 * The first screen when the server can't say who is signed in.
 *
 * On the web, a failed /api/auth/status or /api/auth/me (the server down
 * behind a proxy that still serves the page, a gateway's 502, a sign-in
 * proxy's page or redirect) opened the app with nobody signed in, as if the
 * server were single-user. On Android, signing out and opening the app again
 * showed the Diary with no account until (and unless) the server answered.
 * Now both show the sign-in page, the web one saying why with Retry. A
 * server known to be single-user still opens the app, an account or session
 * kept on the device still opens it, and a browser from before this was
 * remembered, opened with no answer at all, behaves as it always did.
 *
 * stores/auth.js runs here as it ships, with its imports supplied.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { writable, get } from 'svelte/store';

const signin = await import('../src/lib/server-signin.js');
const SRC = readFileSync(new URL('../src/stores/auth.js', import.meta.url), 'utf8');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const PAGE = '<!doctype html><html><head><title>Sign in</title></head><body>Proxy sign-in</body></html>';
const reply = (status, body, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const STATUS_MULTI = { active: true, setup_required: false, single_user_mode: false };
const STATUS_SINGLE = { active: false, setup_required: false, single_user_mode: true };
const NO_ANSWER = () => Promise.reject(new TypeError('Failed to fetch'));
const GATEWAY = () => reply(502, '<html>Bad Gateway</html>', 'text/html');
const PROXY_PAGE = () => reply(200, PAGE, 'text/html');
const PROXY_REDIRECT = () => ({ type: 'opaqueredirect', status: 0, ok: false, text: async () => '' });
const EMPTY = () => reply(200, '', 'text/plain');
const SERVER_500 = () => reply(500, { error: 'Something went wrong' });
const BUSY_429 = () => reply(429, { error: 'Too many requests' });

function load({ native = false, store = {}, fetch }) {
  const data = new Map(Object.entries(store));
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
  const source = SRC
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^export\s+/gm, '');
  const mod = runInNewContext(`${source}\n;({ currentUser, userMgmtActive, loadAuthState, authUnreachable: typeof authUnreachable === 'undefined' ? writable(null) : authUnreachable })`, {
    console: { ...console, warn: () => {} }, URL, AbortSignal, JSON, Promise, Error, TypeError, Object, Array, String, Number,
    localStorage, fetch,
    writable, getStore: get,
    isNative: native, getServerUrl: () => (native ? 'https://nt.example' : null),
    getAuthToken: () => data.get('nt:authToken') ?? null, _apiUrl: (p) => `https://nt.example${p}`,
    loadServerSettings: async () => {}, setCoachingFromServer: () => {}, loadCachedCoaching: () => {}, clearCoaching: () => {},
    responseJson: signin.responseJson, webPageError: signin.webPageError, statusError: signin.statusError, serverProblem: signin.serverProblem,
  }, { filename: 'stores/auth.js' });
  return { ...mod, data };
}
const both = (status, me) => async (url) => (String(url).endsWith('/api/auth/status') ? status() : me());
const failing = (make) => both(make, make);
const opened = async (o) => { const a = load(o); await a.loadAuthState(); return a; };

test('web, a server known to have accounts, signed out, no answer: the sign-in page saying so', async () => {
  for (const [why, make, reason] of [
    ['no answer', NO_ANSWER, 'unreachable'],
    ['a gateway\'s 502 page', GATEWAY, 'unreachable'],
    ['a sign-in proxy\'s page', PROXY_PAGE, 'proxy'],
    ['a sign-in proxy\'s redirect', PROXY_REDIRECT, 'proxy'],
    ['an empty answer', EMPTY, 'proxy'],
    ['the server\'s own 500', SERVER_500, 'server_error'],
    ['the server busy (429)', BUSY_429, 'server_error'],
    ['a gateway\'s 504 page', () => reply(504, '<html>Gateway Timeout</html>', 'text/html'), 'unreachable'],
    ['a gateway\'s 522 page', () => reply(522, '<html>Connection timed out</html>', 'text/html'), 'unreachable'],
  ]) {
    const a = await opened({ fetch: failing(make), store: { 'nt:cachedUserMgmt': '1' } });
    assert.equal(get(a.userMgmtActive), true, `${why}: the sign-in page`);
    assert.equal(get(a.currentUser), null, why);
    assert.equal(get(a.authUnreachable), reason, why);
    assert.equal(a.data.get('nt:cachedUserMgmt'), '1', `${why}: never remembered as single-user`);
  }
});

test('web, a server never heard from: an answer that isn\'t the server\'s is the sign-in page; no answer at all opens the app as before', async () => {
  for (const [why, make, reason] of [['a gateway\'s 502 page', GATEWAY, 'unreachable'], ['a proxy\'s page', PROXY_PAGE, 'proxy'], ['a proxy\'s redirect', PROXY_REDIRECT, 'proxy']]) {
    const a = await opened({ fetch: failing(make) });
    assert.equal(get(a.userMgmtActive), true, why);
    assert.equal(get(a.authUnreachable), reason, why);
  }
  // A browser from before the kind was remembered, opened offline: as it was, remembering nothing.
  const offline = await opened({ fetch: failing(NO_ANSWER) });
  assert.equal(get(offline.userMgmtActive), false, 'the app, as always');
  assert.equal(get(offline.authUnreachable), null);
  assert.equal(offline.data.has('nt:cachedUserMgmt'), false, 'nothing remembered from no answer');
  const slow = await opened({ fetch: failing(() => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))) });
  assert.equal(get(slow.userMgmtActive), false);
});

test('web, the server can\'t answer: a single-user server, a single-user browser and a kept account still open the app', async () => {
  for (const make of [NO_ANSWER, GATEWAY, PROXY_PAGE]) {
    const single = await opened({ fetch: failing(make), store: { 'nt:cachedUserMgmt': '0' } });
    assert.equal(get(single.userMgmtActive), false);
    assert.equal(get(single.currentUser)?.username, 'local', 'the single-user stand-in, as online');
    // Never told yet, but set up here with nobody ever signed in: a single-user browser.
    const before = await opened({ fetch: failing(make), store: { wl_setupComplete: 'true', wl_units: '"metric"' } });
    assert.equal(get(before.userMgmtActive), false);
    assert.equal(before.data.has('nt:cachedUserMgmt'), false, 'guessed, not remembered');
  }
  // Someone signed in here once (their settings are under wl_u<id>_): not a single-user browser.
  const signedOut = await opened({ fetch: failing(GATEWAY), store: { wl_setupComplete: 'true', wl_u3_units: '"metric"' } });
  assert.equal(get(signedOut.userMgmtActive), true);

  const ann = { id: 7, username: 'ann' };
  const kept = await opened({ fetch: failing(GATEWAY), store: { 'nt:cachedUser': JSON.stringify(ann), 'nt:cachedUserMgmt': '1' } });
  assert.deepEqual(get(kept.currentUser), ann);
  assert.equal(get(kept.authUnreachable), null);
});

test('web: what the server says is remembered, single-user included, and a sign-in clears the notice', async () => {
  const single = await opened({ fetch: both(() => reply(200, STATUS_SINGLE), () => reply(200, { user: null })) });
  assert.equal(single.data.get('nt:cachedUserMgmt'), '0');
  assert.equal(get(single.currentUser)?.username, 'local');

  const out = await opened({ fetch: both(() => reply(200, STATUS_MULTI), () => reply(200, { user: null })) });
  assert.equal(out.data.get('nt:cachedUserMgmt'), '1');
  assert.equal(get(out.userMgmtActive), true);
  assert.equal(get(out.authUnreachable), null);

  const later = await opened({ fetch: failing(GATEWAY), store: { 'nt:cachedUserMgmt': '1' } });
  assert.equal(get(later.authUnreachable), 'unreachable');
  later.currentUser.set({ id: 7, username: 'ann' });
  assert.equal(get(later.authUnreachable), null, 'signed in: a later sign-out never shows it again');
});

test('Android: signed out, the sign-in page from the first frame; a session kept on the phone opens the app', async () => {
  const hang = () => new Promise(() => {});
  // As Log Out leaves it: server mode, no token, no account kept.
  for (const last of ['1', undefined]) {
    const a = await opened({ native: true, fetch: failing(hang), store: last ? { 'nt:cachedUserMgmt': last } : {} });
    assert.equal(get(a.userMgmtActive), true, `last known ${last}: the sign-in page before the server answers`);
  }
  // Just connected (a token, the account not fetched yet), and the server doesn't answer: the app, as before.
  for (const make of [hang, NO_ANSWER]) {
    const fresh = await opened({ native: true, fetch: failing(make), store: { 'nt:authToken': 't0k' } });
    assert.equal(get(fresh.userMgmtActive), false, 'a session: never the sign-in page');
    assert.equal(get(fresh.currentUser), null, 'the refresh fills the account in');
  }
  const single = await opened({ native: true, fetch: failing(hang), store: { 'nt:cachedUserMgmt': '0' } });
  assert.equal(get(single.userMgmtActive), false);
  const ann = { id: 7, username: 'ann' };
  const kept = await opened({ native: true, fetch: failing(hang), store: { 'nt:cachedUser': JSON.stringify(ann), 'nt:cachedUserMgmt': '1', 'nt:authToken': 't0k' } });
  assert.deepEqual(get(kept.currentUser), ann);
});

test('every sign-in records that the server has accounts, and signing out keeps it', () => {
  const platform = read('../src/lib/platform.js');
  assert.match(platform, /export function setAuthToken\(token\) \{[\s\S]{0,400}if \(token\) localStorage\.setItem\('nt:cachedUserMgmt', '1'\);/);
  const auth = read('../src/stores/auth.js');
  const logout = auth.slice(auth.indexOf('export async function logout'));
  assert.doesNotMatch(logout.slice(0, logout.indexOf('\n}\n')), /removeItem\('nt:cachedUserMgmt'\)/);
});

test('one reason for every failure, the same on the startup notice and the sign-in options', async () => {
  const why = signin.serverProblem;
  assert.equal(why(new TypeError('Failed to fetch')), 'unreachable', 'no answer');
  assert.equal(why(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'unreachable', 'too slow');
  assert.equal(why(signin.webPageError()), 'proxy');
  assert.equal(why(signin.statusError(500, { error: 'boom' })), 'server_error');
  assert.equal(why(signin.statusError(429, { error: 'busy' })), 'server_error');
  assert.equal(why(signin.statusError(502, {})), 'unreachable', 'nothing of the server\'s to read');
  assert.equal(why(new Error('something odd')), 'options');
  // The web's own reads: a gateway's page is out of reach, the server's own error is an error.
  const read = async (r) => { try { const d = await signin.responseJson(r); if (!r.ok) throw signin.statusError(r.status, d); return 'ok'; } catch (e) { return why(e); } };
  assert.equal(await read(GATEWAY()), 'unreachable');
  assert.equal(await read(reply(504, '<html>Gateway Timeout</html>', 'text/html')), 'unreachable');
  assert.equal(await read(SERVER_500()), 'server_error');
  assert.equal(await read(BUSY_429()), 'server_error');
  assert.equal(await read(PROXY_PAGE()), 'proxy');
});

test('Android: the sign-in options say the real reason the server couldn\'t be read', async () => {
  const at = async (get) => {
    signin._useHttpForTests({ get, post: get });
    try { await signin.discoverSignIn('https://nt.example'); return 'ok'; } catch (e) { return signin.serverProblem(e); } finally { signin._useHttpForTests(null); }
  };
  assert.equal(await at(async () => { throw new Error('Unable to resolve host "nt.example"'); }), 'unreachable', 'the server off or no network');
  assert.equal(await at(async () => ({ status: 502, data: '<html>Bad Gateway</html>' })), 'unreachable');
  assert.equal(await at(async () => ({ status: 200, data: PAGE })), 'proxy');
  assert.equal(await at(async () => ({ status: 500, data: { error: 'boom' } })), 'server_error');
  assert.equal(await at(async () => ({ status: 429, data: { error: 'busy' } })), 'server_error');
  assert.equal(await at(async () => ({ status: 200, data: STATUS_MULTI })), 'ok');
});

test('the sign-in page shows one notice with one reason, in the current language, and a fresh install goes to setup', () => {
  const login = read('../src/routes/Login.svelte');
  assert.match(login, /\$: problem = \$authUnreachable \|\| optionsError \|\| null;/);
  assert.match(login, /optionsError = serverProblem\(e\);/);
  assert.match(login, /if \(why === 'proxy'\) return isNative \? t\('server_signin\.web_page'\) : t\('server_signin\.proxy_web'\);\s*\n\s*if \(why === 'server_error'\) return t\('server_signin\.server_error'\);\s*\n\s*if \(why === 'unreachable'\) return t\('server_signin\.unreachable'\);\s*\n\s*return t\('server_signin\.options_failed'\);/);
  assert.equal((login.match(/class="options-failed" role="alert"/g) || []).length, 1, 'one notice on the page');
  assert.match(login, /\{#if problem\}[\s\S]{0,400}\{problemText\(problem, \$_\)\}[\s\S]{0,200}on:click=\{\$authUnreachable \? retryServer : loadSignInOptions\}/);
  assert.match(login, /await loadAuthState\(\);[\s\S]{0,120}if \(get\(setupRequired\)\) \{ push\('\/wizard'\); return; \}\s*\n\s*if \(!get\(authUnreachable\)\) await loadSignInOptions\(\);/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.server_signin.unreachable, "Can't reach your server right now. Check that it's running, then Retry.");
  assert.equal(en.server_signin.proxy_web, 'Something in front of your server is asking you to sign in. Sign in there, then reload this page.');
  assert.equal(en.server_signin.server_error, 'Your server answered with an error. Try again in a moment.');
});
