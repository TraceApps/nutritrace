/**
 * CORS answers only the app's own WebView and PUBLIC_URL, against the real
 * server (server/index.js on a scratch database) and lib/cors.js itself.
 *
 * The check was `origin.includes(host)`, so a page on any address with the
 * server's name inside it (app.example.com.attacker.tld, xapp.example.com,
 * evil.app.example.com, the name on another port, or 192.168.1.5:30021 for
 * a server on :3002) got Access-Control-Allow-Origin with credentials. A
 * page the browser counts as the same site gets the sign-in cookie too: in
 * Chromium against the real servers it read the signed-in account and wrote
 * a setting (CSRF token included, from /api/auth/me). Now addresses are
 * compared whole, and the Android app (current and older origins), PUBLIC_URL,
 * the web app on its own address and requests with no Origin (MCP, the API,
 * the watch app) work as before.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const APP = 'nutritrace';
const APP_ORIGIN = 'https://app.nutritrace.local';
// Every origin the app's WebView has had (older versions ran on https://localhost).
const APP_ORIGINS = [APP_ORIGIN, 'https://localhost'];
// No version of the app ever ran on these (androidScheme was always https).
const NEVER_APP_ORIGINS = ['http://localhost'];

let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* server packages missing: the server cases skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const servers = [];
async function start(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${APP}-cors-`));
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, `${APP}.db`), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'cors-test-0123456789abcdef0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', ...env },
    stdio: 'ignore',
  });
  servers.push({ proc, dir });
  const base = (env.BASE_URL || '').replace(/\/$/, '');
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}${base}/api/auth/status`)).ok) return { port, base }; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

/** One request with the headers a browser (or a reverse proxy) would send, Host included. */
function ask(srv, { method = 'GET', path = '/api/auth/me', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: srv.base + path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
const preflight = (srv, origin, host, extra = {}) => ask(srv, {
  method: 'OPTIONS',
  headers: { host, origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,authorization', ...extra },
});

let plain = null, published = null;
test.before(async () => {
  if (!ready) return;
  plain = await start();
  published = await start({ PUBLIC_URL: `https://example.com/${APP}`, BASE_URL: `/${APP}` });
});
test.after(() => { for (const s of servers) { s.proc.kill(); rmSync(s.dir, { recursive: true, force: true }); } });

const LOOKALIKES = [
  ['https://app.example.com.attacker.tld', 'app.example.com', 'the name with another domain after it'],
  ['https://xapp.example.com', 'app.example.com', 'a longer name ending in it'],
  ['https://evil.app.example.com', 'app.example.com', 'a subdomain of it'],
  ['https://app.example.com@attacker.tld', 'app.example.com', 'the name as a user part'],
  ['https://app.example.com:8443', 'app.example.com', 'the name on another port'],
  ['http://app.example.com', 'app.example.com', 'the name on plain http'],
  ['http://192.168.1.5:30021', '192.168.1.5:3002', 'another port starting with its port'],
  ['https://attacker.tld', 'app.example.com', 'an unrelated site'],
  ['null', 'app.example.com', 'an opaque origin'],
  ['capacitor://localhost', 'app.example.com', 'a scheme the apps never use'],
  ...NEVER_APP_ORIGINS.map((o) => [o, 'app.example.com', 'an origin no version of the app had']),
];

test('a lookalike address gets no CORS headers, preflight or not', { skip: !ready }, async () => {
  for (const [origin, host, what] of LOOKALIKES) {
    for (const res of [await preflight(plain, origin, host, { 'x-forwarded-proto': 'https' }), await ask(plain, { headers: { host, origin, 'x-forwarded-proto': 'https' } })]) {
      assert.equal(res.headers['access-control-allow-origin'], undefined, `${what}: ${origin} must not be allowed`);
      assert.equal(res.headers['access-control-allow-credentials'], undefined, `${what}: ${origin} gets no credentials`);
      assert.match(String(res.headers.vary), /Origin/i, 'caches keep answers apart by Origin');
    }
  }
});

test('the Android app, current and older versions, still gets CORS with credentials', { skip: !ready }, async () => {
  for (const origin of APP_ORIGINS) {
    for (const host of ['app.example.com', '192.168.1.5:3002', `127.0.0.1:${plain.port}`]) {
      const pre = await preflight(plain, origin, host);
      assert.ok(pre.status >= 200 && pre.status < 300, `${origin} preflight answers ${pre.status}`);
      assert.equal(pre.headers['access-control-allow-origin'], origin);
      assert.equal(pre.headers['access-control-allow-credentials'], 'true');
      assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
      const get = await ask(plain, { headers: { host, origin } });
      assert.equal(get.status, 200);
      assert.equal(get.headers['access-control-allow-origin'], origin);
      assert.match(String(get.headers.vary), /Origin/i, 'caches keep answers apart by Origin');
    }
  }
});

test('the web app on its own address is answered as before (same-origin needs no CORS headers)', { skip: !ready }, async () => {
  for (const [origin, host, xfp] of [['http://192.168.1.5:3002', '192.168.1.5:3002'], ['https://app.example.com', 'app.example.com', 'https'], ['https://app.example.com', 'app:3002']]) {
    const res = await ask(plain, { headers: { host, origin, 'sec-fetch-site': 'same-origin', ...(xfp ? { 'x-forwarded-proto': xfp } : {}) } });
    assert.equal(res.status, 200, `${origin} via ${host}`);
  }
});

test('PUBLIC_URL\'s address is allowed, under a BASE_URL subpath too', { skip: !ready }, async () => {
  const host = `127.0.0.1:${published.port}`;
  const ok = await ask(published, { headers: { host, origin: 'https://example.com' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://example.com');
  const pre = await preflight(published, APP_ORIGIN, host);
  assert.equal(pre.headers['access-control-allow-origin'], APP_ORIGIN);
  for (const origin of ['https://example.com.attacker.tld', 'http://example.com', 'https://www.example.com']) {
    const res = await ask(published, { headers: { host, origin } });
    assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
  }
});

test('requests with no Origin (MCP, the API, the watch app, scripts) answer as before', { skip: !ready }, async () => {
  const res = await ask(plain, { headers: { host: 'app.example.com' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('corsOrigin: exact matches only', async () => {
  const { corsOrigin, originOf } = await import('../server/lib/cors.js');
  const req = (origin, host = 'app.example.com') => ({ protocol: 'https', headers: { origin, host, 'x-forwarded-proto': 'https' } });
  const opts = { appOrigins: APP_ORIGINS, env: {} };
  for (const o of APP_ORIGINS) assert.equal(corsOrigin(req(o), opts), o);
  assert.equal(corsOrigin(req('https://localhost:8443'), opts), null, 'a port makes another address');
  assert.equal(corsOrigin(req('https://app.example.com'), opts), null, 'the own address needs no CORS headers');
  assert.equal(corsOrigin(req(`${APP_ORIGIN}/`), opts), null, 'an Origin header is never a full URL');
  assert.equal(corsOrigin(req(APP_ORIGIN.toUpperCase()), opts), null, 'browsers send it lowercase');
  assert.equal(corsOrigin(req(`${APP_ORIGIN}, https://attacker.tld`), opts), null, 'one origin only');
  assert.equal(corsOrigin(req(undefined), opts), null);
  assert.equal(corsOrigin(req(APP_ORIGIN), {}), null, 'nothing is allowed by default');
  for (const [origin, host] of LOOKALIKES) assert.equal(corsOrigin(req(origin, host), opts), null, origin);
  assert.equal(corsOrigin(req('https://notes.example.com'), { ...opts, env: { PUBLIC_URL: 'https://notes.example.com/notes/' } }), 'https://notes.example.com');
  assert.equal(corsOrigin(req('https://notes.example.com:444'), { ...opts, env: { PUBLIC_URL: 'https://notes.example.com/notes/' } }), null);
  assert.equal(corsOrigin(req('https://notes.example.com'), { ...opts, env: { PUBLIC_URL: 'not a url' } }), null);
  assert.equal(originOf('HTTPS://Example.COM:443/path'), 'https://example.com');
  assert.equal(originOf('ftp://example.com'), null);
});

test('each app passes only the WebView origins its versions had', () => {
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const m = src.match(/corsOrigin\(req, \{ appOrigins: \[([^\]]*)\] \}\)/);
  assert.ok(m, 'server/index.js asks lib/cors.js');
  assert.deepEqual(m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')), APP_ORIGINS);
  assert.doesNotMatch(src, /origin\.includes\(/, 'no substring match on Origin');
});
