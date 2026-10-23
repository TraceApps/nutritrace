/**
 * A fresh install, against the real server (server/index.js on a scratch
 * database):
 *
 * - /api/health answers before the first account exists, and says the
 *   server needs setting up, so the Android app's connect screen can say so
 *   instead of "Server not reachable". Data routes still answer 503
 *   "Setup required"; a server that is set up still answers { ok: true }.
 *   Signing in before setup says the same, for apps from before this check.
 * - The update-check choice is saved: updates.js sends the CSRF token from
 *   where stores/auth.js keeps it (CSRF_KEY, the same constant in every Trace
 *   app's copy; CookTrace and NoteTrace read NutriTrace's key and got 403).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const APP = 'nutritrace';
const DATA_ROUTE = '/api/foods';
const CONNECT_FILES = ['../src/routes/NativeSetup.svelte', '../src/routes/settings/ServerConnection.svelte'];

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* server packages missing: the server cases skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only what this test sets: a developer's BASE_URL, UPDATE_CHECK, OIDC_*,
// password-login or other app settings must not change what it sees.
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

let proc = null, base = null, dir = null;
test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), `${APP}-first-run-`));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, `${APP}.db`), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'first-run-test-0123456789abcdef0123456789', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
});
test.after(() => { proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test('a fresh server answers health, and says it needs setting up', { skip: !ready }, async () => {
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, setup_required: true });
  const data = await fetch(base + DATA_ROUTE);
  assert.equal(data.status, 503, 'data routes still wait for setup');
  assert.equal((await data.json()).setup_required, true);
  // Apps from before this check sign in next: they get told the same thing.
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Str0ng-Pass-77!x' }) });
  assert.equal(login.status, 503);
  const said = await login.json();
  assert.equal(said.setup_required, true);
  assert.match(said.error, /isn't set up yet\. Open it in a browser/);
});

test('once set up, health is { ok: true } and the update-check choice saves', { skip: !ready }, async () => {
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Str0ng-Pass-77!x' }) });
  assert.equal(reg.status, 200, await reg.clone().text());
  const cookie = reg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie, 'signed in by a cookie, as in the browser');

  assert.deepEqual(await (await fetch(base + '/api/health')).json(), { ok: true });
  const wrong = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong-Pass-1!' }) });
  assert.equal(wrong.status, 401, 'set up: a wrong password is just that');

  const me = await (await fetch(base + '/api/auth/me', { headers: { cookie } })).json();
  assert.ok(me.csrf, 'the server hands the browser a CSRF token');
  const put = (headers) => fetch(base + '/api/updates/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: JSON.stringify({ enabled: true }) });
  assert.equal((await put({})).status, 403, 'without the token it is refused (what the wizard hit)');
  assert.equal((await put({ 'X-CSRF-Token': me.csrf })).status, 200);
  const cfg = await (await fetch(base + '/api/updates/config', { headers: { cookie } })).json();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.answered, true);
});

test('updates.js sends the CSRF token from where stores/auth.js keeps it', () => {
  const stored = read('../src/stores/auth.js').match(/localStorage\.setItem\('([a-z]+:csrf)'/)?.[1];
  assert.ok(stored, 'stores/auth.js keeps the token');
  const updates = read('../src/lib/updates.js');
  assert.equal(updates.match(/const CSRF_KEY = '([a-z]+:csrf)';/)?.[1], stored);
  assert.match(updates, /localStorage\.getItem\(CSRF_KEY\)/);
  assert.doesNotMatch(updates, /localStorage\.getItem\('[a-z]+:csrf'\)/);
});

test('the connect screens tell a fresh server from one that is down', () => {
  const src = read('../src/lib/platform.js');
  const body = src.slice(src.indexOf('export function healthNeedsSetup'), src.indexOf('export function explainConnectError'));
  const healthNeedsSetup = new Function(`${body.replace('export ', '')}; return healthNeedsSetup;`)();
  assert.equal(healthNeedsSetup({ status: 200, data: { ok: true, setup_required: true } }), true);
  assert.equal(healthNeedsSetup({ status: 200, data: '{"ok":true,"setup_required":true}' }), true, 'CapacitorHttp may hand back text');
  assert.equal(healthNeedsSetup({ status: 503, data: { error: 'Setup required', setup_required: true } }), true, 'an older server');
  assert.equal(healthNeedsSetup({ status: 200, data: { ok: true } }), false);
  assert.equal(healthNeedsSetup({ status: 502, data: '<html>Bad Gateway</html>' }), false);
  assert.equal(healthNeedsSetup(undefined), false);
  // Both connect screens check through lib/server-signin.js, whose code
  // explainConnectError turns into this message (#36).
  assert.match(read('../src/lib/server-signin.js'), /if \(healthNeedsSetup\(res\)\) throw Object\.assign\(new Error\('Server needs setup'\), \{ code: 'needs_setup' \}\);/);
  assert.match(src, /if \(rawError\?\.code === 'needs_setup'\) return t\('native_setup\.errors\.server_needs_setup'\);/);
  for (const f of CONNECT_FILES) assert.match(read(f), /await checkServer\(url\);/, f);
});
