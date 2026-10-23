/**
 * The Android app's sign-in options behind a sign-in proxy
 * (TraceApps/notetrace#36, the same code in NutriTrace).
 *
 * A proxy in front of the server (an Authentik or Authelia outpost,
 * Cloudflare Access) answers the app with its own login page. The connect
 * screen took that page as "server reachable", couldn't read the sign-in
 * options from it, and showed a password form without single sign-on and
 * without a word. Signing in then failed with "Unexpected token '<'".
 *
 * Against the real server (server/index.js, one SSO provider from env) behind
 * a stand-in proxy: the web page is said, options that couldn't be loaded
 * are said, and Settings > Server Connection offers SSO through the same
 * discovery. The SSO deep link from a Settings sign-in takes only the code
 * it asked for, is swapped at that server even after a cold start, and
 * never signs the app in on its own.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// localStorage, as the app has it.
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => _store.clear(),
};

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const signin = await import('../src/lib/server-signin.js');
const { explainConnectError } = await import('../src/lib/platform.js');

let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* server packages missing: the server cases skip */ }

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

// What CapacitorHttp hands back on Android: JSON parsed, anything else as text.
const capacitorLike = {
  async get({ url, headers }) { return this._send(url, { headers }); },
  async post({ url, headers, data }) { return this._send(url, { method: 'POST', headers, body: JSON.stringify(data) }); },
  async _send(url, init) {
    const r = await fetch(url, init);
    const text = await r.text();
    const json = /json/.test(r.headers.get('content-type') || '');
    return { status: r.status, data: json ? JSON.parse(text) : text };
  },
};
signin._useHttpForTests(capacitorLike);

const OUTPOST_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body><form>Sign in to continue</form></body></html>';
const APP_PAGE = '<!doctype html><html><head><title>NutriTrace</title></head><body><div id="app"></div></body></html>';
const isWebPage = (e) => e?.webPage === true;
const isUnreachable = (e) => e?.unreachable === true && !e.webPage;

// ── 5. What a web page in place of the server says ──────────────────────
test('the status decides before the body: a sign-in page or the wrong address is a web page; a gateway error page is the server out of reach', () => {
  const page = (status, data = OUTPOST_PAGE) => ({ status, data });
  for (const s of [200, 401, 403]) assert.throws(() => signin.serverJson(page(s)), isWebPage, `HTML with ${s}`);
  for (const s of [502, 504, 520, 522, 524, 500, 404]) assert.throws(() => signin.serverJson(page(s, '<html>Bad Gateway</html>')), isUnreachable, `HTML with ${s}`);
  // The server's own catch-all answers an address that isn't its API with the app page.
  assert.throws(() => signin.serverJson(page(200, APP_PAGE)), isWebPage);
  assert.deepEqual(signin.serverJson({ status: 200, data: { ok: true } }), { ok: true });
  assert.deepEqual(signin.serverJson({ status: 200, data: '{"ok":true}' }), { ok: true }, 'CapacitorHttp may hand back JSON as text');
  assert.deepEqual(signin.serverJson({ status: 302, data: '' }), {}, 'an empty body is {}; the caller judges the status');
  // The wording covers both: a proxy, or not the server's address.
  const msg = (() => { try { signin.serverJson(page(200)); } catch (e) { return e.message; } })();
  assert.match(msg, /Something other than NutriTrace answered with a web page: often a sign-in proxy \(Authentik, Authelia, Cloudflare Access\), or this isn't your server's address\. Let the app reach \/api on your server\./);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.server_signin.web_page, msg, 'the English fallback is the string Weblate sees');
  assert.match(en.server_signin.options_failed, /^Couldn't load this server's sign-in options\. Retry, or sign in with your password if the server allows it\.$/);
  assert.match(en.server_signin.token_refused, /older than NutriTrace 1\.4/);
  // Every connect screen says it the same way (explainConnectError).
  const t = (k) => `t:${k}`;
  assert.equal(explainConnectError(signin.webPageError(), 'https://x', t), 't:server_signin.web_page');
  assert.equal(explainConnectError(Object.assign(new Error('x'), { code: 'needs_setup' }), 'https://x', t), 't:native_setup.errors.server_needs_setup');
  assert.equal(signin.optionsErrorText(signin.webPageError()), msg);
  assert.match(signin.optionsErrorText(new Error('nope')), /^Couldn't load this server's sign-in options/);
});

// ── 1, 2, 3. The SSO deep link ──────────────────────────────────────────
const SERVER = 'https://nt.example.com';
function redeemer(answer) {
  const calls = [];
  const redeem = async (code, server) => { calls.push({ code, server }); if (answer instanceof Error) throw answer; return answer; };
  return { calls, redeem };
}

test('1. a Settings sign-in takes only the code it asked for: a bare token from another app is refused', async () => {
  localStorage.clear();
  signin.rememberSsoConnect(SERVER);
  const { calls, redeem } = redeemer({ token: 'never' });
  const r = await signin.routeSsoCallback({ token: 'attacker-token' }, { nativeMode: 'local', challengeSent: true, redeem });
  assert.deepEqual(r, { to: 'refused' });
  assert.equal(calls.length, 0, 'nothing is swapped');
  assert.equal(signin.pendingSsoConnect(), null, 'the sign-in is over');
  // First run and after Log Out (server mode, no Settings sign-in): an older
  // server's bare token still signs in, as before the code hand-off.
  assert.deepEqual(await signin.routeSsoCallback({ token: 'old-server', idTokenHint: 'h', providerId: '1' }, { nativeMode: 'server', challengeSent: true, redeem }),
    { to: 'app', token: 'old-server', idTokenHint: 'h', providerId: '1' });
  // The pending Settings sign-in counts only in local mode.
  signin.rememberSsoConnect(SERVER);
  assert.equal((await signin.routeSsoCallback({ token: 't' }, { nativeMode: 'server', challengeSent: true, redeem })).to, 'app');
  localStorage.clear();
});

test('2. a Settings sign-in never falls through to the app\'s own sign-in, whatever happens to the code', async () => {
  localStorage.clear();
  signin.rememberSsoConnect(SERVER);
  const ok = redeemer({ token: 'tok', id_token_hint: 'hint', provider_id: 3 });
  const r = await signin.routeSsoCallback({ code: 'c1' }, { nativeMode: 'local', challengeSent: true, redeem: ok.redeem });
  assert.deepEqual(r, { to: 'settings', url: SERVER, token: 'tok', idTokenHint: 'hint', providerId: '3' });
  assert.deepEqual(ok.calls, [{ code: 'c1', server: SERVER }], 'swapped at the server Settings asked, not the app\'s own');
  // The code couldn't be swapped: said, and the app doesn't sign itself in.
  signin.rememberSsoConnect(SERVER);
  const bad = redeemer(new Error('Code expired'));
  assert.deepEqual(await signin.routeSsoCallback({ code: 'c2' }, { nativeMode: 'local', challengeSent: true, redeem: bad.redeem }), { to: 'failed', message: 'Code expired' });
  // An error from the server ends the Settings sign-in too.
  signin.rememberSsoConnect(SERVER);
  assert.deepEqual(await signin.routeSsoCallback({ error: 'access_denied' }, { nativeMode: 'local', challengeSent: true, redeem: bad.redeem }), { to: 'error' });
  assert.equal(signin.pendingSsoConnect(), null);

  // App.svelte acts on the outcome: Settings gets the token through the
  // store, and only an 'app' outcome sets the app's token.
  const app = read('../src/App.svelte');
  const branch = app.slice(app.indexOf("if (host === 'oidc-callback')"), app.indexOf("params.get('fitbit')        === 'connected'"));
  assert.match(branch, /const routed = await routeSsoCallback\(\{[\s\S]*?\}, \{ nativeMode: getNativeMode\(\), challengeSent: challengeSent\(\), redeem: redeemHandoff \}\);/);
  assert.match(branch, /if \(routed\.to === 'settings'\) \{\s*ssoConnectResult\.set\(/);
  assert.match(branch, /routed\.to === 'refused'\) \{\s*import\('\.\/stores\/toast\.js'\)\.then\(\(\{ showError \}\) => showError\(getStore\(_\)\('server_signin\.token_refused'\)\)\);/);
  const tokenSet = branch.indexOf('setAuthToken(token);');
  assert.ok(tokenSet > branch.indexOf("} else if (routed.to === 'app') {"), 'the app signs itself in only on an app outcome');
  assert.equal(branch.split('setAuthToken(').length - 1, 1);
});

test('3. a cold start from the link still knows where a Settings sign-in was going, for half an hour', async () => {
  localStorage.clear();
  signin.rememberSsoConnect(SERVER);
  // The app was closed while the browser was open: a fresh copy of the module.
  const fresh = await import(`../src/lib/server-signin.js?cold-${Date.now()}`);
  const { calls, redeem } = redeemer({ token: 'tok' });
  const r = await fresh.routeSsoCallback({ code: 'c' }, { nativeMode: 'local', challengeSent: true, redeem });
  assert.equal(r.to, 'settings');
  assert.equal(calls[0].server, SERVER, 'swapped at that server, not apiUrl() (nothing in local mode)');
  // An old one (over half an hour) is forgotten, not used.
  localStorage.setItem('nt:ssoConnect', JSON.stringify({ url: SERVER, at: Date.now() - 31 * 60 * 1000 }));
  assert.equal(signin.pendingSsoConnect(), null);
  assert.equal(localStorage.getItem('nt:ssoConnect'), null);
  // App.svelte opens Server Connection for it once the first screen is chosen.
  const app = read('../src/App.svelte');
  assert.match(app, /_setupRouted = true;\s*\/\/[^\n]*\n[^\n]*\n\s*if \(isNative\) \{\s*const \{ ssoConnectResult \} = await import\('\.\/lib\/server-signin\.js'\);\s*if \(getStore\(ssoConnectResult\)\) \(await import\('svelte-spa-router'\)\)\.push\('\/settings\/serverConnection'\);/);
  assert.match(app, /if \(_setupRouted\) \(await import\('svelte-spa-router'\)\)\.push\('\/settings\/serverConnection'\);/);
  localStorage.clear();
});

test('4. the IdP logout hint is kept only for a finished SSO connect; a password connect and Disconnect clear it', () => {
  signin.keepSsoLogoutHint({ providerId: '1', idTokenHint: 'h' });
  assert.equal(localStorage.getItem('nt:oidc_logout_hint'), JSON.stringify({ providerId: '1', idTokenHint: 'h' }));
  signin.keepSsoLogoutHint(null);
  assert.equal(localStorage.getItem('nt:oidc_logout_hint'), null);
  signin.keepSsoLogoutHint({ providerId: '1' });
  assert.equal(localStorage.getItem('nt:oidc_logout_hint'), null, 'half a hint is none');
  const sc = read('../src/routes/settings/ServerConnection.svelte');
  assert.match(sc, /keepSsoLogoutHint\(_pendingLogoutHint\);\s*_pendingLogoutHint = null;\s*setServerUrl\(_pendingServerUrl\);/, 'saved when the connect is done');
  assert.match(sc, /const user = await accountFor\(url, token\);\s*_pendingLogoutHint = idTokenHint && providerId \? \{ providerId, idTokenHint \} : null;/, 'only after the account is known');
  assert.match(sc, /function cancelMerge\(\) \{\s*mergeStep = null;\s*_pendingLogoutHint = null;/);
  assert.match(sc.slice(sc.indexOf('async function disconnectServer')), /keepSsoLogoutHint\(null\);/);
  assert.match(sc, /passwordSignIn\(url, serverUsername\.trim\(\), serverPassword\);\s*_pendingLogoutHint = null;/);
  // The app's own SSO sign-in keeps it as before, and no longer before the hand-off.
  assert.match(read('../src/App.svelte'), /\} else if \(routed\.to === 'app'\) \{[\s\S]{0,500}keepSsoLogoutHint\(\{ providerId: routed\.providerId, idTokenHint: routed\.idTokenHint \}\);/);
});

// ── 6. Settings: options follow the address field ───────────────────────
test('6. Settings options: typing clears them at once, an old answer is dropped, a half-typed host is no error', async () => {
  const answers = new Map();
  const asked = [];
  const discover = (url) => { asked.push(url); return new Promise((res, rej) => answers.set(url, { res, rej })); };
  const opts = signin.createSignInOptions({ discover, delay: 5 });
  let now; opts.subscribe((v) => { now = v; });

  opts.typed('https://nt.example.com');
  await sleep(15);
  assert.equal(now.state, 'checking');
  opts.typed('https://nt.example.co'); // still typing
  assert.equal(now.state, '', 'cleared at once');
  answers.get('https://nt.example.com').res({ providers: [{ id: 1 }], passwordLoginEnabled: true });
  await sleep(1);
  assert.deepEqual(now.providers, [], 'the old address\'s answer is dropped');
  await sleep(15);
  answers.get('https://nt.example.co').rej(new Error('ENOTFOUND'));
  await sleep(1);
  assert.equal(now.state, '', 'a failure while typing is no error');
  opts.left('https://nt.example.co');
  await sleep(1);
  answers.get('https://nt.example.co').rej(new Error('ENOTFOUND'));
  await sleep(1);
  assert.equal(now.state, 'failed', 'said once the field is left');
  assert.match(now.error, /Couldn't load this server's sign-in options/);
  opts.typed('https://nt'); // not a whole host yet: not even asked
  await sleep(15);
  assert.equal(asked.includes('https://nt'), false);
  opts.stop();

  const sc = read('../src/routes/settings/ServerConnection.svelte');
  assert.match(sc, /on:input=\{\(\) => signInOptions\.typed\(serverUrlInput\)\} on:blur=\{addressLeft\}/);
  assert.match(sc, /discover: \(url\) => _lookupAllowed\(url\) \? discoverSignIn\(url\) : Promise\.reject/, 'nothing goes to a plain-http address before its warning (#194)');
  assert.match(sc, /async function connectWithSso\(providerId\) \{[\s\S]*?if \(serverConnecting\) return;[\s\S]*?serverConnecting = true;[\s\S]*?rememberSsoConnect\(url\);\s*await openSsoSignIn\(url, providerId\);/, 'one browser at a time');
  assert.match(sc, /\{#each ssoProviders as p \(p\.id\)\}[\s\S]*?disabled=\{serverConnecting\}/);
  assert.match(read('../src/routes/Login.svelte'), /if \(ssoOpening\) return;/);
  assert.match(read('../src/routes/NativeSetup.svelte'), /async function loginWithOidc\(providerId\) \{[\s\S]*?if \(connecting\) return;\s*connecting = true;/);
});

// ── Against the real server, behind a stand-in proxy ────────────────────
let proc = null, dir = null, server = null, proxy = null, viaProxy = null;
let mode = 'pass'; // 'pass' | 'wall' (an outpost) | 'status-down' | 'app-page' (the server's catch-all for a wrong address)
test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'nutritrace-sso-'));
  const port = await freePort();
  server = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nutritrace.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'sso-discovery-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error',
      OIDC_ISSUER: 'http://127.0.0.1:9/realms/test', OIDC_CLIENT_ID: 'nutritrace-test', OIDC_CLIENT_SECRET: 'secret',
      OIDC_PROVIDER_1_DISPLAY_NAME: 'Authentik',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(server + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  proxy = http.createServer(async (req, res) => {
    if (mode === 'wall') {
      if (req.url === '/outpost/login') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(OUTPOST_PAGE);
      return res.writeHead(302, { Location: '/outpost/login' }).end();
    }
    if (mode === 'app-page') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(APP_PAGE);
    if (mode === 'status-down' && req.url.startsWith('/api/auth/status')) return res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html>502 Bad Gateway</html>');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const r = await fetch(server + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] || '', authorization: req.headers.authorization || '' }, body: body || undefined });
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/plain' }).end(await r.text());
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  viaProxy = `http://127.0.0.1:${proxy.address().port}`;
});
test.after(() => { proc?.kill(); proxy?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// The connect screen's discovery as it was (NativeSetup.validateAndNext on dev).
async function discoveryBefore(url) {
  const healthRes = await capacitorLike.get({ url: `${url}/api/health` });
  if (healthRes.status < 200 || healthRes.status >= 300) throw new Error('Server not reachable');
  let providers = [];
  try {
    const statusRes = await capacitorLike.get({ url: `${url}/api/auth/status` });
    if (statusRes.status >= 200 && statusRes.status < 300) {
      const data = typeof statusRes.data === 'string' ? JSON.parse(statusRes.data) : statusRes.data;
      if (data?.oidc) providers = Array.isArray(data.oidc.providers) ? data.oidc.providers : [];
    }
  } catch { /* leave defaults */ }
  return { providers };
}

test('a fresh server says it needs setting up', { skip: !ready }, async () => {
  mode = 'pass';
  await assert.rejects(signin.checkServer(viaProxy), (e) => e.code === 'needs_setup');
  const reg = await fetch(server + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Str0ng-Pass-77!x' }) });
  assert.equal(reg.status, 200, await reg.clone().text());
});

test('through a plain proxy, the server\'s SSO is offered and password sign-in works', { skip: !ready }, async () => {
  mode = 'pass';
  await signin.checkServer(viaProxy);
  const found = await signin.discoverSignIn(viaProxy);
  assert.equal(found.passwordLoginEnabled, true);
  assert.deepEqual(found.providers.map((p) => p.display_name), ['Authentik']);
  const login = await signin.passwordSignIn(viaProxy, 'admin', 'Str0ng-Pass-77!x');
  assert.ok(login.token);
  const user = await signin.accountFor(viaProxy, login.token);
  assert.deepEqual([user.id, user.created_at], [login.user.id, login.user.created_at], 'what Settings hands on after an SSO sign-in, as after a password one');
  await assert.rejects(signin.passwordSignIn(viaProxy, 'admin', 'wrong-Pass-1!'), /Invalid username or password/);
});

test('behind a sign-in outpost: it was a silent password-only form, now it says a web page answered', { skip: !ready }, async () => {
  mode = 'wall';
  assert.deepEqual(await discoveryBefore(viaProxy), { providers: [] }, 'before: no SSO and nothing said');
  const loginPage = await capacitorLike.post({ url: `${viaProxy}/api/auth/login`, data: {} });
  assert.throws(() => JSON.parse(loginPage.data), /Unexpected token '<'|is not valid JSON/, 'before: the raw JSON error');
  await assert.rejects(signin.checkServer(viaProxy), isWebPage);
  await assert.rejects(signin.discoverSignIn(viaProxy), isWebPage);
  await assert.rejects(signin.passwordSignIn(viaProxy, 'admin', 'x'), isWebPage);
});

test('5. a wrong address the server answers with its app page says so too', { skip: !ready }, async () => {
  mode = 'app-page';
  await assert.rejects(signin.checkServer(`${viaProxy}/notnutritrace`), (e) => isWebPage(e) && /or this isn't your server's address/.test(e.message));
});

test('options that couldn\'t be loaded throw, for the screen to say with Retry', { skip: !ready }, async () => {
  mode = 'status-down';
  await signin.checkServer(viaProxy); // health is fine
  await assert.rejects(signin.discoverSignIn(viaProxy), isUnreachable, 'a 502 page is the server out of reach, not a proxy');
  mode = 'pass';
  assert.equal((await signin.discoverSignIn(viaProxy)).providers.length, 1, 'Retry loads them');
});

test('wiring: every connect screen uses the shared discovery and says what it couldn\'t load', () => {
  const setup = read('../src/routes/NativeSetup.svelte');
  assert.doesNotMatch(setup, /catch \{ \/\* leave defaults/, 'no silent password-only fallback');
  assert.match(setup, /await checkServer\(url\);\s*validatedUrl = url;\s*await loadSignInOptions\(\);/);
  assert.match(setup, /optionsError = optionsErrorText\(e\);/);
  assert.match(setup, /\{#if optionsError\}[\s\S]*?\{optionsError\}[\s\S]*?on:click=\{retryOptions\}/);
  assert.match(setup, /await passwordSignIn\(validatedUrl, username\.trim\(\), password\);\s*keepSsoLogoutHint\(null\);/);

  const sc = read('../src/routes/settings/ServerConnection.svelte');
  assert.match(sc, /\{:else if optionsState === 'failed'\}[\s\S]*?\{optionsError\}[\s\S]*?signInOptions\.retry\(\)/);
  assert.match(sc, /\{#if passwordEnabled\}/, 'a server with password sign-in off shows no password form');
  assert.match(sc, /await checkServer\(url\);\s*const loginData = await passwordSignIn/);
  assert.match(sc, /await _afterSignIn\(url, \{ token: loginData\.token, user: loginData\.user \}\);/, 'password');
  assert.match(sc, /await _afterSignIn\(url, \{ token, user \}\);/, 'single sign-on: the same steps after');
  assert.match(sc, /onDestroy\(ssoConnectResult\.subscribe\(\(r\) => \{\s*if \(!r\) return;\s*ssoConnectResult\.set\(null\);\s*_finishSso\(r\);/);

  const login = read('../src/routes/Login.svelte');
  assert.match(login, /if \(isNative\) data = \(await discoverSignIn\(getServerUrl\(\)\)\)\.status;/, 'the app reads it natively');
  assert.match(login, /optionsError = serverProblem\(e\);/);
  assert.match(login, /\{#if problem\}[\s\S]*?on:click=\{\$authUnreachable \? retryServer : loadSignInOptions\}/);
  assert.match(login, /try \{ data = await responseJson\(res\); \} catch \(e\) \{ showError\(e\.message\); return; \}/);
  assert.match(read('../src/lib/oidc-app-handoff.js'), /export function challengeSent\(\)/);
});
