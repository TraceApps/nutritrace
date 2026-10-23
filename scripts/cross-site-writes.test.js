/**
 * A change sent by a page on another site is refused (server/lib/cross-site.js),
 * against the real server (server/index.js on a scratch database) and the
 * module itself.
 *
 * A page anywhere can make a browser POST without asking first (an HTML
 * form, fetch() with mode 'no-cors', a file upload). In Chromium against the
 * real servers, a page on any site made a server with no accounts create a
 * backup and store an upload (on LiftTrace, which has no CSRF token, a page
 * on the same site did that with the signed-in person's cookie too). Now the browser's own
 * headers decide: Sec-Fetch-Site same-origin or none, or an Origin that is
 * the app's own address, its WebView or PUBLIC_URL, or no browser headers
 * at all (the watch, MCP, scripts, other servers).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const APP = 'nutritrace';
// Every origin the app's WebView has had (lib/cors.js gets the same list).
const APP_ORIGINS = ['https://app.nutritrace.local', 'https://localhost'];
const HOST = 'app.example.com';

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
  const dir = mkdtempSync(join(tmpdir(), `${APP}-xsite-`));
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, `${APP}.db`), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'xsite-test-0123456789abcdef0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srv = { proc, dir, port, base: (env.BASE_URL || '').replace(/\/$/, ''), log: '' };
  proc.stdout.on('data', (d) => { srv.log += d; });
  proc.stderr.on('data', (d) => { srv.log += d; });
  servers.push(srv);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}${srv.base}/api/auth/status`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

/** One request with exactly the headers given (a browser's, a proxy's), Host included. */
function ask(srv, { method = 'POST', path = '/api/full-backup', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: srv.base + path, headers: { host: HOST, ...(body != null ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on('error', (e) => reject(new Error(`${method} ${path} ${JSON.stringify(headers).slice(0, 120)}: ${e.message}`)));
    req.end(body);
  });
}
const backups = (srv) => (existsSync(join(srv.dir, 'backups')) ? readdirSync(join(srv.dir, 'backups')).length : 0);
const uploads = (srv) => { let n = 0; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) e.isDirectory() ? walk(join(p, e.name)) : n++; }; walk(join(srv.dir, 'uploads')); return n; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function multipart(field = 'file') {
  const b = '----xsite' + Date.now();
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from(`\r\n--${b}--\r\n`)]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** Make an account, then turn accounts off the way Settings does: single-user mode. */
async function singleUser(srv) {
  const reg = await ask(srv, { path: '/api/auth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'Owner-pass-2026!' }) });
  assert.equal(reg.status, 200, reg.text);
  const cookie = String(reg.headers['set-cookie']?.[0] || '').split(';')[0];
  const me = await ask(srv, { method: 'GET', path: '/api/auth/me', headers: { cookie } });
  const off = await ask(srv, { method: 'DELETE', path: '/api/auth/management', headers: { cookie, ...(me.json?.csrf ? { 'x-csrf-token': me.json.csrf } : {}) } });
  assert.equal(off.status, 200, off.text);
  const st = await ask(srv, { method: 'GET', path: '/api/auth/status' });
  assert.equal(st.json.single_user_mode, true);
}

let single = null, published = null, accounts = null;
test.before(async () => {
  if (!ready) return;
  single = await start();
  await singleUser(single);
  published = await start({ PUBLIC_URL: `https://example.com/${APP}`, BASE_URL: `/${APP}` });
  await singleUser(published);
  accounts = await start();
});
test.after(() => { for (const s of servers) { s.proc.kill(); rmSync(s.dir, { recursive: true, force: true }); } });

// What browsers send from a page on another address (seen in Chromium and
// Firefox against these servers): a form post, fetch no-cors, an upload, a
// sandboxed frame or a page with no referrer (Origin: null), over https
// (with Sec-Fetch-Site) and plain http (without).
const ATTACKS = [
  [{ origin: 'https://attacker.tld', 'sec-fetch-site': 'cross-site' }, 'another site'],
  [{ origin: 'https://evil.app.example.com', 'sec-fetch-site': 'same-site' }, 'a subdomain (same site)'],
  [{ origin: 'https://example.com', 'sec-fetch-site': 'same-site' }, 'the parent domain (same site)'],
  [{ origin: 'https://app.example.com:8443', 'sec-fetch-site': 'same-site' }, 'the same host on another port'],
  [{ origin: 'https://app.example.com.attacker.tld', 'sec-fetch-site': 'cross-site' }, 'a lookalike name'],
  [{ origin: 'null', 'sec-fetch-site': 'cross-site' }, 'a sandboxed frame or no-referrer page'],
  [{ origin: 'http://attacker.tld' }, 'another site over plain http (no Sec-Fetch-Site)'],
  [{ origin: 'null' }, 'Origin null over plain http'],
  [{ origin: 'http://app.example.com:3002' }, 'the same host on another port over plain http'],
  [{ 'sec-fetch-site': 'cross-site' }, 'Sec-Fetch-Site without an Origin'],
  [{ origin: 'https://app.example.com, https://attacker.tld' }, 'two origins in one header'],
];

test('single-user mode: a page on another address can\'t make a backup, upload, or change anything', { skip: !ready }, async () => {
  const b0 = backups(single), u0 = uploads(single);
  for (const [h, what] of ATTACKS) {
    const form = await ask(single, { headers: { ...FORM, ...h }, body: 'x=1' });
    assert.equal(form.status, 403, `${what}: a form post is refused`);
    assert.equal(form.json?.code, 'cross_site', what);
    assert.match(form.json?.error, /another address/);
    const mp = multipart();
    const up = await ask(single, { path: '/api/upload', headers: { 'content-type': mp.type, ...h }, body: mp.body });
    assert.equal(up.status, 403, `${what}: an upload is refused`);
    const rs = multipart('backup');
    const restore = await ask(single, { path: '/api/full-backup/upload-restore', headers: { 'content-type': rs.type, ...h }, body: rs.body });
    assert.equal(restore.status, 403, `${what}: a backup restore is refused`);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await ask(single, { method, path: '/api/settings', headers: { 'content-type': 'text/plain', ...h }, body: 'x' });
      assert.equal(r.status, 403, `${what}: ${method}`);
    }
  }
  assert.equal(backups(single), b0, 'no backup was made');
  assert.equal(uploads(single), u0, 'nothing was stored');
});

test('every route under the app is covered: MCP, the public API, sign-in, uploads, backups', { skip: !ready }, async () => {
  for (const path of ['/api/mcp', '/api/v1/workouts', '/api/auth/login', '/api/auth/register', '/api/upload', '/api/full-backup/x/restore', '/api/proxy/x', '/no-such-page']) {
    const r = await ask(single, { path, headers: { ...FORM, origin: 'https://attacker.tld', 'sec-fetch-site': 'cross-site' }, body: 'x=1' });
    assert.equal(r.status, 403, path);
  }
});

test('the web app on its own address still writes, whatever the browser sends', { skip: !ready }, async () => {
  const ok = [
    [{ 'sec-fetch-site': 'same-origin', origin: `https://${HOST}`, 'x-forwarded-proto': 'https' }, 'https behind a proxy'],
    [{ 'sec-fetch-site': 'same-origin', origin: 'https://app.example.com' }, 'https, a proxy that rewrites Host (Sec-Fetch-Site decides)'],
    [{ 'sec-fetch-site': 'none' }, 'the person typed the address'],
    [{ origin: `http://${HOST}` }, 'plain http by name, no Sec-Fetch-Site'],
    [{ origin: 'http://192.168.1.5:3002', host: '192.168.1.5:3002' }, 'plain http by LAN IP'],
    [{ origin: 'https://notes.example.org', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'notes.example.org' }, 'an older browser behind a proxy (X-Forwarded-Proto/Host)'],
    [{ origin: 'https://app.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'other.example.org' }, 'a proxy that keeps Host and sets X-Forwarded-Host'],
    [{ origin: 'https://app.example.com', host: 'app.example.com:443', 'x-forwarded-proto': 'https' }, 'the default port written out'],
  ];
  for (const [h, what] of ok) {
    const r = await ask(single, { headers: h });
    assert.equal(r.status, 200, `${what}: ${r.text}`);
    assert.match(String(r.json?.filename), /backup/, `${what}: a backup was made`);
  }
});

test('the Android app (current and older WebView origins), and clients with no browser headers, still write', { skip: !ready }, async () => {
  for (const origin of APP_ORIGINS) {
    for (const h of [{ origin, 'sec-fetch-site': 'cross-site' }, { origin }]) {
      const r = await ask(single, { method: 'PUT', path: '/api/settings', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'x', value: 1 }) });
      assert.equal(r.status, 200, `${origin} ${JSON.stringify(h)}`);
    }
  }
  // curl, the watch, MCP clients, scripts, another Trace server (Node's fetch sends Sec-Fetch-Mode only).
  for (const h of [{}, { 'sec-fetch-mode': 'cors', 'user-agent': 'node' }, { authorization: 'Bearer nope' }]) {
    const r = await ask(single, { method: 'PUT', path: '/api/settings', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'x', value: 2 }) });
    assert.notEqual(r.status, 403, JSON.stringify(h));
  }
});

test('reads and preflights are not affected', { skip: !ready }, async () => {
  const get = await ask(single, { method: 'GET', path: '/api/auth/status', headers: { origin: 'https://attacker.tld', 'sec-fetch-site': 'cross-site' } });
  assert.equal(get.status, 200);
  const pre = await ask(single, { method: 'OPTIONS', path: '/api/settings', headers: { origin: APP_ORIGINS[0], 'access-control-request-method': 'PUT' } });
  assert.ok(pre.status >= 200 && pre.status < 300);
});

test('PUBLIC_URL\'s address writes, under a BASE_URL subpath; others are refused there too', { skip: !ready }, async () => {
  const ok = await ask(published, { headers: { origin: 'https://example.com', 'sec-fetch-site': 'cross-site', host: `127.0.0.1:${published.port}` } });
  assert.equal(ok.status, 200, ok.text);
  for (const origin of ['https://example.com.attacker.tld', 'http://example.com', 'https://www.example.com']) {
    const r = await ask(published, { headers: { origin, 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 403, origin);
  }
  const own = await ask(published, { method: 'PUT', path: '/api/settings', headers: { origin: `http://${HOST}`, 'content-type': 'application/json' }, body: '{"key":"x","value":1}' });
  assert.equal(own.status, 200, 'the own address under the subpath');
});

test('a refused address is logged once, with no secrets', { skip: !ready }, async () => {
  const origin = 'https://log-once.attacker.tld';
  for (let i = 0; i < 3; i++) await ask(single, { path: '/api/full-backup?token=secret-in-query', headers: { origin, 'sec-fetch-site': 'cross-site', cookie: 'x=secret-cookie' } });
  await sleep(200);
  const lines = single.log.split('\n').filter((l) => l.includes('[cross-site]') && l.includes(origin));
  assert.equal(lines.length, 1, single.log);
  assert.match(lines[0], /WARN/i);
  assert.doesNotMatch(lines[0], /secret/);
});

/** Sign the victim in with a cookie, as the web app does. */
async function signIn(srv) {
  const reg = await ask(srv, { path: '/api/auth/register', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'victim', password: 'Victim-pass-2026!' }) });
  assert.equal(reg.status, 200, reg.text);
  const cookie = String(reg.headers['set-cookie']?.[0] || '').split(';')[0];
  assert.ok(cookie, 'a sign-in cookie');
  const me = await ask(srv, { method: 'GET', path: '/api/auth/me', headers: { cookie } });
  const csrf = me.json?.csrf ? { 'x-csrf-token': me.json.csrf } : {};
  return { cookie, csrf, own: { cookie, ...csrf, 'sec-fetch-site': 'same-origin', origin: `https://${HOST}` } };
}
let victim = null;

test('signed in: a page on another address can\'t use the sign-in cookie to write', { skip: !ready }, async () => {
  victim = await signIn(accounts);
  const { cookie, csrf } = victim;
  const b0 = backups(accounts), u0 = uploads(accounts);
  for (const [h, what] of ATTACKS) {
    // Even with the CSRF token where the app has one (a page that could read it).
    const r = await ask(accounts, { headers: { ...FORM, cookie, ...csrf, ...h }, body: 'x=1' });
    assert.equal(r.status, 403, `${what}: a backup`);
    const mp = multipart();
    const up = await ask(accounts, { path: '/api/upload', headers: { 'content-type': mp.type, cookie, ...csrf, ...h }, body: mp.body });
    assert.equal(up.status, 403, `${what}: an upload`);
  }
  assert.equal(backups(accounts), b0, 'no backup was made');
  assert.equal(uploads(accounts), u0, 'nothing was stored');
  // The person's own page still can.
  assert.equal((await ask(accounts, { headers: victim.own })).status, 200);
  const mp = multipart();
  assert.equal((await ask(accounts, { path: '/api/upload', headers: { ...victim.own, 'content-type': mp.type }, body: mp.body })).status, 200);
});

test('crossSiteAllowed and ownOrigins', async () => {
  const { crossSiteAllowed, ownOrigins } = await import('../server/lib/cross-site.js');
  const req = (method, headers, protocol = 'http') => ({ method, protocol, headers: { host: HOST, ...headers } });
  const opts = { appOrigins: APP_ORIGINS, env: {} };
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(crossSiteAllowed(req(m, { origin: 'https://attacker.tld', 'sec-fetch-site': 'cross-site' }), opts), true, m);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
    assert.equal(crossSiteAllowed(req(m, { origin: 'https://attacker.tld', 'sec-fetch-site': 'cross-site' }), opts), false, m);
    assert.equal(crossSiteAllowed(req(m, {}), opts), true, `${m} with no browser headers`);
  }
  assert.equal(crossSiteAllowed(req('POST', { 'sec-fetch-site': 'same-origin' }), opts), true);
  assert.equal(crossSiteAllowed(req('POST', { 'sec-fetch-site': 'none' }), opts), true);
  assert.equal(crossSiteAllowed(req('POST', { 'sec-fetch-site': 'same-site', origin: 'https://evil.example.com' }), opts), false);
  assert.equal(crossSiteAllowed(req('POST', { 'sec-fetch-site': 'cross-site' }), opts), false, 'Sec-Fetch-Site alone');
  assert.equal(crossSiteAllowed(req('POST', { origin: 'null' }), opts), false);
  assert.equal(crossSiteAllowed(req('POST', { origin: '' }), opts), false, 'an empty Origin is still a browser');
  assert.equal(crossSiteAllowed(req('POST', { origin: `http://${HOST}/` }), opts), false, 'an Origin is never a URL with a path');
  assert.equal(crossSiteAllowed(req('POST', { origin: `HTTP://${HOST.toUpperCase()}` }), opts), false, 'browsers send it lowercase');
  assert.equal(crossSiteAllowed(req('POST', { origin: `http://${HOST}` }), opts), true);
  assert.equal(crossSiteAllowed(req('POST', { origin: `https://${HOST}` }), opts), false, 'another scheme is another address');
  assert.equal(crossSiteAllowed(req('POST', { origin: `https://${HOST}` }, 'https'), opts), true, 'TLS at the server');
  assert.equal(crossSiteAllowed(req('POST', { origin: `https://${HOST}`, 'x-forwarded-proto': 'https,http' }), opts), true);
  assert.equal(crossSiteAllowed(req('POST', { origin: 'https://attacker.tld', host: 'attacker.tld@app.example.com' }), opts), false);
  for (const o of APP_ORIGINS) assert.equal(crossSiteAllowed(req('POST', { origin: o, 'sec-fetch-site': 'cross-site' }), opts), true, o);
  assert.equal(crossSiteAllowed(req('POST', { origin: APP_ORIGINS[0] }), { env: {} }), false, 'no WebView origin unless passed');
  assert.equal(crossSiteAllowed(req('POST', { origin: 'https://pub.example.com', 'sec-fetch-site': 'cross-site' }), { ...opts, env: { PUBLIC_URL: 'https://pub.example.com/sub/' } }), true);
  assert.deepEqual(ownOrigins(req('POST', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'pub.example.com, inner', host: 'app:3002' })), ['https://pub.example.com', 'https://app:3002']);
  assert.deepEqual(ownOrigins(req('POST', { host: 'APP.example.com:80' })), ['http://app.example.com']);
  assert.deepEqual(ownOrigins(req('POST', { host: 'a b' })), []);
  assert.deepEqual(ownOrigins({ headers: {} }), []);
});

test('crossSiteGuard: 403 with a JSON reason, exact exempt paths, at most 20 warnings a minute', async () => {
  const { crossSiteGuard } = await import('../server/lib/cross-site.js');
  const lines = [];
  const guard = crossSiteGuard({ appOrigins: APP_ORIGINS, exempt: ['/share-target'], warn: (m) => lines.push(m), env: {} });
  const run = (path, origin) => {
    let status = null, body = null, passed = false;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    guard({ method: 'POST', path, protocol: 'http', headers: { host: HOST, origin, 'sec-fetch-site': 'cross-site' } }, res, () => { passed = true; });
    return { status, body, passed };
  };
  const r = run('/api/x', 'https://attacker.tld');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'cross_site');
  assert.equal(run('/share-target', 'https://attacker.tld').passed, true);
  assert.equal(run('/share-target/', 'https://attacker.tld').status, 403);
  for (let i = 0; i < 40; i++) assert.equal(run('/api/x', `https://a${i}.attacker.tld`).status, 403);
  assert.equal(lines.length, 20, 'one per address, 20 a minute at most');
  assert.match(lines[0], /\[cross-site\] refused POST \/api\/x from https:\/\/attacker\.tld \(Sec-Fetch-Site: cross-site\)/);
});

test('server/index.js refuses cross-site changes before any route, with the WebView origins CORS has', () => {
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const cors = src.match(/corsOrigin\(req, \{ appOrigins: (\[[^\]]*\]) \}\)/);
  const guard = src.match(/router\.use\(crossSiteGuard\(\{ appOrigins: (\[[^\]]*\])/);
  assert.ok(cors && guard, 'both are in server/index.js');
  assert.equal(guard[1], cors[1], 'the same WebView origins');
  const at = src.indexOf('router.use(crossSiteGuard(');
  // Every route, and every router or static mount (body parsers may come first).
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete|all)\(|router\.use\((authenticate|'[^']*',\s*(?!express\.json)[A-Za-z_])/g)];
  assert.ok(routes.length > 10);
  for (const m of routes) assert.ok(at < m.index, `the check comes before ${src.slice(m.index, m.index + 50)}`);
  assert.doesNotMatch(src, /^app\.(post|put|patch|delete|all)\(/m, 'no route outside the router');
});
