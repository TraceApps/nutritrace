/**
 * #194: how the Android app enforces the plain-HTTP rule (src/lib/plain-http.js):
 * the warning once per server, the backstop on every request path, the
 * worker's confirmation, images, and the web app left exactly as it was.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};
beforeEach(() => store.clear());

const {
  serverAddressCheck, confirmPlainHttp, plainHttpConfirmed, requestAllowed,
  mirroredConfirmation, imagePolicy, imagePolicyStale, blockedError, confirmedOrigins, logBlocked, canonicalServerBase,
} = await import('../src/lib/plain-http.js');
const { nativeRequestUrl, nativeRequestOptions } = await import('../src/lib/native-http.js');
const { askPlainHttp, plainHttpRequest } = await import('../src/stores/plainHttp.js');
const { isOfflineError } = await import('../src/lib/offline-edits.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PAGE = 'https://app.nutritrace.local/#/diary';

test('connecting: https goes, local http asks once per server, public http is refused', () => {
  assert.equal(serverAddressCheck('https://nt.example.com'), 'https');
  assert.equal(serverAddressCheck('http://203.0.113.10:3001'), 'refuse');
  assert.equal(serverAddressCheck('http://example.com'), 'refuse');
  assert.equal(serverAddressCheck('http://192.168.1.5@evil.com'), 'refuse');
  assert.equal(serverAddressCheck('nutritrace.lan:3001'), 'invalid');
  assert.equal(serverAddressCheck('http://10.0.2.2:3971'), 'ask');
  assert.equal(confirmPlainHttp('http://10.0.2.2:3971'), true);
  assert.equal(serverAddressCheck('http://10.0.2.2:3971'), 'confirmed');
  // Per origin: the same server with a path is the same answer, another port is not.
  assert.equal(serverAddressCheck('http://10.0.2.2:3971/nutritrace'), 'confirmed');
  assert.equal(serverAddressCheck('http://10.0.2.2:3972'), 'ask');
  // The same server written another way is the same origin.
  assert.equal(serverAddressCheck('HTTP://10.0.2.2:3971/'), 'confirmed');
});

test('only a local http address can be confirmed', () => {
  assert.equal(confirmPlainHttp('http://203.0.113.10'), false);
  assert.equal(confirmPlainHttp('https://nt.example.com'), false);
  assert.deepEqual(confirmedOrigins(), []);
  // Even a tampered list can't open a public origin.
  store.set('nt:plainHttpOk', JSON.stringify(['http://203.0.113.10']));
  assert.equal(plainHttpConfirmed('http://203.0.113.10'), false);
  assert.equal(requestAllowed('http://203.0.113.10/api/health', PAGE), false);
  store.set('nt:plainHttpOk', 'not json');
  assert.deepEqual(confirmedOrigins(), []);
});

test('the backstop: http only to a confirmed local server, everything else as before', () => {
  assert.equal(requestAllowed('http://10.0.2.2:3971/api/health', PAGE), false, 'local but not confirmed');
  confirmPlainHttp('http://10.0.2.2:3971');
  assert.equal(requestAllowed('http://10.0.2.2:3971/api/sync/push', PAGE), true);
  assert.equal(requestAllowed('http://10.0.2.2:3971/uploads/a.png', PAGE), true);
  assert.equal(requestAllowed('http://10.0.2.2:3972/api/health', PAGE), false, 'another port');
  assert.equal(requestAllowed('http://192.168.1.9/x.png', PAGE), false, 'another local host');
  assert.equal(requestAllowed('http://example.com/x', PAGE), false);
  assert.equal(requestAllowed('http://10.0.2.2:3971@example.com/x', PAGE), false);
  // https, the app's own pages, data and blob URLs are untouched.
  for (const u of ['https://world.openfoodfacts.org/api/v2/product/1', '/api/health', 'data:image/png;base64,AA', 'blob:https://app.nutritrace.local/1', 'https://app.nutritrace.local/_capacitor_file_/x.jpg']) {
    assert.equal(requestAllowed(u, PAGE), true, u);
  }
});

test('a refused request is a network error, so callers treat it as offline', () => {
  const e = blockedError('http://203.0.113.10:3001/api/health');
  assert.ok(e instanceof TypeError);
  assert.equal(e.code, 'PLAIN_HTTP_BLOCKED');
  assert.equal(e.offline, true);
  assert.equal(isOfflineError(e), true, 'queued like any offline write');
  assert.match(e.message, /203\.0\.113\.10:3001/);
  // Untranslated here (i18n isn't started in tests): the same words as en.json.
  const en = JSON.parse(read('../src/i18n/en.json')).plain_http.blocked;
  assert.equal(e.message, en.replace('{origin}', 'http://203.0.113.10:3001'));
});

test('a refusal is logged once per origin, not on every retry', () => {
  const seen = [];
  const warn = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    for (let i = 0; i < 5; i++) logBlocked('http://203.0.113.10:3001/api/health');
    logBlocked('http://203.0.113.10:3001/api/sync/pull');
    logBlocked('http://203.0.113.11/x');
  } finally { console.warn = warn; }
  assert.equal(seen.length, 2);
});

test('one plain-HTTP sheet at a time: a second request is answered no', async () => {
  const first = askPlainHttp('http://10.0.2.2:3971');
  assert.equal(await askPlainHttp('http://10.0.2.2:3972'), false);
  let req; plainHttpRequest.subscribe(v => { req = v; })();
  assert.equal(req.url, 'http://10.0.2.2:3971');
  req.resolve(true); plainHttpRequest.set(null);
  assert.equal(await first, true);
});

test('CapacitorHttp: https as given, confirmed local http as the URL parser writes it, the rest refused', () => {
  assert.equal(nativeRequestUrl('https://world.openfoodfacts.org/a b?x=1'), 'https://world.openfoodfacts.org/a b?x=1');
  assert.throws(() => nativeRequestUrl('http://10.0.2.2:3971/api/health'), e => e.code === 'PLAIN_HTTP_BLOCKED');
  assert.throws(() => nativeRequestUrl('http://ntfy.example.com/topic'), e => e.code === 'PLAIN_HTTP_BLOCKED');
  assert.throws(() => nativeRequestUrl('not a url'), e => e.code === 'PLAIN_HTTP_BLOCKED');
  assert.throws(() => nativeRequestUrl('ftp://10.0.2.2/x'), e => e.code === 'PLAIN_HTTP_BLOCKED');
  confirmPlainHttp('http://192.168.1.5:3001');
  assert.equal(nativeRequestUrl('http://192.168.1.5:3001/api/health'), 'http://192.168.1.5:3001/api/health');
  // Plain HTTP never follows a redirect (Android would resend it in cleartext); https is as before.
  assert.deepEqual(nativeRequestOptions({ url: 'http://192.168.1.5:3001/api/health', headers: { a: 1 } }),
    { url: 'http://192.168.1.5:3001/api/health', headers: { a: 1 }, disableRedirects: true });
  assert.deepEqual(nativeRequestOptions({ url: 'https://world.openfoodfacts.org/x' }), { url: 'https://world.openfoodfacts.org/x' });
  // Java reads "\@" differently from the URL parser; the normalized URL leaves it no room.
  assert.equal(nativeRequestUrl('http://192.168.1.5:3001\\@evil.com/api/health'), 'http://192.168.1.5:3001/@evil.com/api/health');
});

test('every CapacitorHttp request goes through lib/native-http.js', () => {
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|svelte)$/.test(f)) files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname);
  const offenders = files.filter(f => !f.endsWith('native-http.js'))
    .filter(f => /CapacitorHttp\s*\.\s*(get|post|put|patch|delete|request)\s*\(|\{\s*CapacitorHttp\s*\}/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('the worker gets the confirmation only for a confirmed local http server', () => {
  assert.equal(mirroredConfirmation('https://nt.example.com'), '');
  assert.equal(mirroredConfirmation('http://192.168.1.5:3001'), '');
  confirmPlainHttp('http://192.168.1.5:3001');
  assert.equal(mirroredConfirmation('http://192.168.1.5:3001'), 'http://192.168.1.5:3001');
  assert.equal(mirroredConfirmation('http://192.168.1.5:3001/nutritrace/'), 'http://192.168.1.5:3001/nutritrace');
  // Written as the URL parser writes it, which the Kotlin worker must rebuild exactly.
  assert.equal(mirroredConfirmation('HTTP://192.168.1.5:3001/'), 'http://192.168.1.5:3001');
  assert.equal(canonicalServerBase('http://0xC0A80105:80/nt'), 'http://192.168.1.5/nt');
  confirmPlainHttp('http://stra\u00dfe.local:3001');
  assert.equal(mirroredConfirmation('http://stra\u00dfe.local:3001'), 'http://xn--strae-oqa.local:3001');
  assert.equal(mirroredConfirmation(''), '');
  assert.equal(mirroredConfirmation(null), '');
});

test('images: no http except confirmed local servers', () => {
  assert.equal(imagePolicy([]), "img-src 'self' https: data: blob: file: content:");
  confirmPlainHttp('http://10.0.2.2:3971');
  assert.equal(imagePolicy(), "img-src 'self' https: data: blob: file: content: http://10.0.2.2:3971");
  assert.equal(imagePolicy(['http://203.0.113.10', 'http://10.0.0.1:3001']), "img-src 'self' https: data: blob: file: content: http://10.0.0.1:3001");
  // A source list can't name IPv6 or an underscore: left out, never written malformed.
  assert.equal(imagePolicy(['http://[fd00::5]:3001', 'http://nutritrace_srv:3001', 'http://nas.local:3001']),
    "img-src 'self' https: data: blob: file: content: http://nas.local:3001");
});

test('the image policy is stale once a server is confirmed after start', () => {
  const atStart = imagePolicy();
  assert.equal(imagePolicyStale(atStart), false);
  assert.equal(imagePolicyStale(undefined), false, 'no policy (web): never');
  confirmPlainHttp('http://10.0.2.2:3971');
  assert.equal(imagePolicyStale(atStart), true);
  assert.equal(imagePolicyStale(imagePolicy()), false);
  const app = read('../src/App.svelte');
  const token = app.indexOf('setAuthToken(token);');
  const reload = app.indexOf('if (imagePolicyStale(');
  assert.ok(token > 0 && reload > token, 'checked after an OIDC sign-in');
});

// A fake window for the fetch and XMLHttpRequest wrappers.
function fakeWindow() {
  const calls = [];
  class FakeXHR extends EventTarget {
    open(method, url) { this.url = url; }
    send() { calls.push(['xhr', this.url]); }
  }
  const win = {
    location: { href: PAGE },
    fetch: async (input) => { calls.push(['fetch', String(input?.url || input)]); return new Response('{}', { status: 200 }); },
    XMLHttpRequest: FakeXHR,
  };
  return { win, calls };
}

async function withWindow(native, run) {
  const { win, calls } = fakeWindow();
  const saved = globalThis.window;
  globalThis.window = win;
  try {
    const mod = await import(`../src/lib/request-id-fetch.js?${native ? 'native' : 'web'}-${Math.random()}`);
    mod.installRequestIdFetch({ native });
    await run(win, calls);
  } finally {
    if (saved === undefined) delete globalThis.window; else globalThis.window = saved;
  }
}

test('Android fetch: refused before anything is sent, the rest as before', async () => {
  await withWindow(true, async (win, calls) => {
    await assert.rejects(win.fetch('http://203.0.113.10:3001/api/health'), e => e.code === 'PLAIN_HTTP_BLOCKED');
    await assert.rejects(win.fetch('http://10.0.2.2:3971/api/health'), e => e instanceof TypeError);
    assert.deepEqual(calls, [], 'nothing reached the network');
    confirmPlainHttp('http://10.0.2.2:3971');
    await win.fetch('http://10.0.2.2:3971/api/health');
    await win.fetch('https://world.openfoodfacts.org/x');
    await win.fetch('/icons/icon-192.png');
    assert.deepEqual(calls.map(c => c[1]), ['http://10.0.2.2:3971/api/health', 'https://world.openfoodfacts.org/x', '/icons/icon-192.png']);
  });
});

test('Android XMLHttpRequest: a refused one fails like a network error, with nothing sent', async () => {
  await withWindow(true, async (win, calls) => {
    const xhr = new win.XMLHttpRequest();
    const events = [];
    xhr.addEventListener('error', () => events.push('error'));
    xhr.addEventListener('loadend', () => events.push('loadend'));
    xhr.open('POST', 'http://203.0.113.10/api/full-backup/upload-restore');
    xhr.send('x');
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(events, ['error', 'loadend']);
    assert.deepEqual(calls, []);
    const ok = new win.XMLHttpRequest();
    ok.open('POST', 'https://nt.example.com/api/full-backup/upload-restore');
    ok.send('x');
    assert.deepEqual(calls, [['xhr', 'https://nt.example.com/api/full-backup/upload-restore']]);
  });
});

test('the web app is untouched: plain http goes out exactly as before', async () => {
  await withWindow(false, async (win, calls) => {
    await win.fetch('http://203.0.113.10:3001/api/health');
    await win.fetch('http://192.168.1.5:3001/api/health');
    const xhr = new win.XMLHttpRequest();
    xhr.open('GET', 'http://203.0.113.10/x');
    xhr.send();
    assert.deepEqual(calls.map(c => c[1]), ['http://203.0.113.10:3001/api/health', 'http://192.168.1.5:3001/api/health', 'http://203.0.113.10/x']);
  });
});

test('wiring: the guards are installed for the Android app only', () => {
  const main = read('../src/main.js');
  assert.match(main, /installRequestIdFetch\(\{ native: _native \}\)/);
  assert.match(main, /if \(_native\) \{[\s\S]*?Content-Security-Policy[\s\S]*?imagePolicy\(\)/);
  const app = read('../src/App.svelte');
  assert.match(app, /\{#if isNative\}<PlainHttpSheetMount \/>\{\/if\}/);
});

test('wiring: both connect screens check the address before any request', () => {
  for (const f of ['../src/routes/NativeSetup.svelte', '../src/routes/settings/ServerConnection.svelte']) {
    const src = read(f);
    const check = src.indexOf('serverAddressCheck(url)');
    // The first request is the server check (lib/server-signin.js, #36).
    const first = src.indexOf('await checkServer(url)');
    assert.ok(check > 0 && first > check, `${f}: the check comes first`);
    assert.match(src, /plain === 'invalid'\) \{ showError\(\$_\('plain_http\.invalid_address'\)\); return( false)?; \}/);
    assert.match(src, /plain === 'refuse'\) \{ await askPlainHttp\(url, \{ kind: 'refuse' \}\); return( false)?; \}/);
    assert.match(src, /if \(!\(await askPlainHttp\(url\)\)\) return( false)?;\s*confirmPlainHttp\(url\);/);
  }
});

test('wiring: a saved http server is asked about at start, before auth goes to it', () => {
  const app = read('../src/App.svelte');
  const gate = app.indexOf("const plain = serverAddressCheck(saved);");
  const auth = app.indexOf('try { await loadAuthState(); } finally { authLoaded = true; }');
  assert.ok(gate > 0 && auth > gate);
  assert.match(app, /if \(plain === 'ask' \|\| plain === 'refuse'\) \{\s*authLoaded = false;/);
  assert.match(app, /askPlainHttp\(saved, \{ kind: plain, stored: true \}\)/);
});

test('wiring: the worker checks the address before any request, and the mirror feeds it', () => {
  const kt = read('../android/app/src/main/java/com/nutritrace/app/HealthConnectSyncWorker.kt');
  const base = kt.indexOf('val base = LocalAddress.workerBase(serverUrl, httpOk)');
  assert.ok(base > 0 && base < kt.indexOf('dataIsTokensAccount(ctx, serverUrl, base!!, authToken)'));
  assert.match(kt, /pushToServer\(base!!, authToken/);
  assert.match(kt, /readSyncMeta\(db, "server_http_ok"\)/);
  assert.equal((kt.match(/if \(url\.protocol == "http"\) instanceFollowRedirects = false/g) || []).length, 2);
  const platform = read('../src/lib/platform.js');
  assert.match(platform, /await db\.run\(sql, \['server_http_ok', httpOk\]\);/);
});

test('Android allows cleartext app-wide but keeps both trust anchors; the app enforces the rule', () => {
  const xml = read('../android/app/src/main/res/xml/network_security_config.xml');
  assert.match(xml, /<base-config cleartextTrafficPermitted="true">/);
  assert.match(xml, /<certificates src="system" \/>/);
  assert.match(xml, /<certificates src="user" \/>/);
  assert.doesNotMatch(xml, /domain-config/);
});

test('the APK download stays on HTTPS', () => {
  const src = read('../src/lib/updates.js');
  const check = src.indexOf("if (assetUrl?.protocol !== 'https:') throw new Error('Download failed');");
  assert.ok(check > 0 && check < src.indexOf('Filesystem.downloadFile('));
});
