/**
 * Share to Open Food Facts (TraceApps/nutritrace#284).
 *
 * It sent a GET from the browser with a shared "nutritrace-app" login in
 * the address. Open Food Facts refuses that login with an HTML page, and
 * the app showed `Unexpected token '<', "<!-- start"... is not valid JSON`.
 * Now: only the person's own login, sent as a POST body through the app's
 * server (or straight to Open Food Facts from the Android app with no
 * server), and Open Food Facts' answer in plain words.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { shareWithOff, readOffAnswer, cleanOffFields, OffShareError, OFF_HOST, OFF_STAGING_HOST } from '../src/lib/off-contribute.js';

const APP = 'NutriTrace';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// What Open Food Facts answers a wrong login (world.openfoodfacts.net, 2026-10-22).
const LOGIN_PAGE = '<!-- start templates/web/common/site_layout.tt.html -->\n<!doctype html><html><body><h1>Error</h1><p>Incorrect user name or password. <a href="/cgi/user.pl">Forgotten password?</a></p></body></html>';

// A stand-in for Open Food Facts that records each request.
function fakeOff(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const a = answers[calls.length - 1] ?? answers[answers.length - 1];
    if (a instanceof Error) throw a;
    return new Response(a.body, { status: a.status || 200, headers: { 'content-type': a.type || 'application/json' } });
  };
  return { calls, fetchImpl };
}
const OK = { body: '{"status":1,"status_verbose":"fields saved"}' };
const product = { code: '0200000284001', lang: 'en', product_name_en: 'Test', nutrition_data_per: '100g', 'nutriment_energy-kcal': 120 };

test('the copies of off-contribute.js are identical', () => {
  assert.equal(read('../server/lib/off-contribute.js'), read('../src/lib/off-contribute.js'));
});

test('the old shared login and GET are gone from the app', () => {
  const client = read('../src/lib/api.js') + read('../src/lib/off-contribute.js');
  assert.doesNotMatch(client, /\|\|\s*["']nutritrace-app|product_jqm2\.pl\?/);
});

test('a product is a POST with the login in the body, never the address', async () => {
  const off = fakeOff([OK]);
  const out = await shareWithOff({ fetchImpl: off.fetchImpl, userId: ' me ', password: 'p&ss word', fields: { ...product, evil_field: 'x', imagefield: 'y' }, userAgent: `${APP}/1 (x)` });
  assert.deepEqual(out, { ok: true, photo: null });
  assert.equal(off.calls.length, 1);
  const { url, init } = off.calls[0];
  assert.equal(url, `${OFF_HOST}/cgi/product_jqm2.pl`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(init.headers['User-Agent'], `${APP}/1 (x)`);
  assert.equal(init.headers.Authorization, undefined, 'no staging auth on the real server');
  const body = new URLSearchParams(init.body);
  assert.equal(body.get('user_id'), 'me');
  assert.equal(body.get('password'), 'p&ss word');
  assert.equal(body.get('code'), '0200000284001');
  assert.equal(body.get('nutriment_energy-kcal'), '120');
  assert.equal(body.get('evil_field'), null, 'only product fields pass');
  assert.equal(body.get('imagefield'), null);
});

test('no login: nothing is sent', async () => {
  for (const [userId, password] of [['', 'x'], ['me', ''], ['  ', 'x'], [undefined, undefined]]) {
    const off = fakeOff([OK]);
    await assert.rejects(shareWithOff({ fetchImpl: off.fetchImpl, userId, password, fields: product }), (e) => e instanceof OffShareError && e.kind === 'no_account');
    assert.equal(off.calls.length, 0);
  }
});

test("Open Food Facts' answers become plain errors, never a JSON parse error", async () => {
  const cases = [
    [{ status: 403, type: 'text/html', body: LOGIN_PAGE }, 'login', ''],
    [{ body: '{"status":0,"status_verbose":"no user credentials"}' }, 'login', ''],
    [{ body: '{"status":0,"status_verbose":"no code or invalid code"}' }, 'refused', 'no code or invalid code'],
    [{ status: 502, type: 'text/html', body: '<html>Bad gateway</html>' }, 'unreachable', 'HTTP 502'],
    [new TypeError('fetch failed'), 'unreachable', ''],
  ];
  for (const [answer, kind, detail] of cases) {
    const off = fakeOff([answer]);
    await assert.rejects(shareWithOff({ fetchImpl: off.fetchImpl, userId: 'me', password: 'x', fields: product }), (e) => {
      assert.equal(e.kind, kind);
      assert.equal(e.detail, detail);
      assert.doesNotMatch(e.message, /JSON|Unexpected token/);
      return true;
    });
  }
});

test('the photo follows as multipart, and a refused photo keeps the product', async () => {
  const off = fakeOff([OK, { body: '{"status":"status ok","imagefield":"front_en"}' }]);
  const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
  const out = await shareWithOff({ fetchImpl: off.fetchImpl, userId: 'me', password: 'x', fields: product, image });
  assert.deepEqual(out, { ok: true, photo: 'sent' });
  const { url, init } = off.calls[1];
  assert.equal(url, `${OFF_HOST}/cgi/product_image_upload.pl`);
  assert.equal(init.method, 'POST');
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('code'), '0200000284001');
  assert.equal(init.body.get('user_id'), 'me');
  assert.equal(init.body.get('password'), 'x');
  assert.equal(init.body.get('imagefield'), 'front_en');
  assert.equal(init.body.get('imgupload_front_en').size, 4);

  const refused = fakeOff([OK, { body: '{"status":"status not ok","error":"too small"}' }]);
  assert.deepEqual(await shareWithOff({ fetchImpl: refused.fetchImpl, userId: 'me', password: 'x', fields: product, image }), { ok: true, photo: 'failed' });
});

test('staging gets its published basic auth; fields are cleaned', async () => {
  const off = fakeOff([OK]);
  await shareWithOff({ fetchImpl: off.fetchImpl, host: OFF_STAGING_HOST, userId: 'me', password: 'x', fields: product });
  assert.equal(off.calls[0].url, `${OFF_STAGING_HOST}/cgi/product_jqm2.pl`);
  assert.equal(off.calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('off:off').toString('base64'));
  assert.throws(() => cleanOffFields({ lang: 'en' }), (e) => e.kind === 'refused');
  assert.deepEqual(cleanOffFields({ code: 1, brands: { a: 1 }, product_name_eng: 'x', serving_size: ' 30 g ' }), { code: '1', serving_size: '30 g' });
  assert.deepEqual(readOffAnswer(200, '{"status":1}'), { ok: true });
});

// The server route, in-process, with Open Food Facts replaced by a stand-in.
let db = null, dir = null, server = null, base = null;
const realFetch = globalThis.fetch;
const offCalls = [];
let offAnswers = [];
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'off-contribute-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: offRoutes } = await import('../server/routes/off-contribute.js');
  const app = express();
  app.use((r, _res, next) => { r.user = r.headers['x-user'] ? { id: Number(r.headers['x-user']), role: 'user' } : null; next(); });
  app.use('/api/off', offRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    offCalls.push({ url: String(url), init });
    const a = offAnswers.shift() || OK;
    if (a instanceof Error) throw a;
    return new Response(a.body, { status: a.status || 200, headers: { 'content-type': a.type || 'application/json' } });
  };
} catch { /* better-sqlite3 not built for this Node: the route cases skip */ }
test.after(() => { globalThis.fetch = realFetch; server?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

function form({ user = 'me', password = 's3cret-pw', fields = product, image = null } = {}) {
  const fd = new FormData();
  if (user != null) fd.append('user_id', user);
  if (password != null) fd.append('password', password);
  fd.append('fields', JSON.stringify(fields));
  if (image) fd.append('image', image, 'front.jpg');
  return fd;
}
const post = (fd, headers = { 'x-user': '1' }) => realFetch(`${base}/api/off/contribute`, { method: 'POST', body: fd, headers });

test('route: signed in only, then a POST to Open Food Facts with the login in the body', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('someone', 'x');
  offCalls.length = 0;
  assert.equal((await post(form(), {})).status, 401, 'not signed in');
  assert.equal(offCalls.length, 0);

  const logs = [];
  const { log, error } = console;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    offAnswers = [OK];
    let res = await post(form());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, photo: null });
    const { url, init } = offCalls.at(-1);
    assert.equal(url, `${OFF_HOST}/cgi/product_jqm2.pl`, 'the real server, fixed');
    assert.equal(init.method, 'POST');
    assert.match(init.headers['User-Agent'], new RegExp(`^${APP}/\\S+ \\(https://github\\.com/TraceApps/${APP.toLowerCase()}\\)$`));
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('user_id'), 'me');
    assert.equal(body.get('password'), 's3cret-pw');

    offAnswers = [{ status: 403, type: 'text/html', body: LOGIN_PAGE }];
    res = await post(form());
    assert.equal(res.status, 422);
    assert.equal((await res.json()).kind, 'login');

    offAnswers = [{ body: '{"status":0,"status_verbose":"no code or invalid code"}' }];
    res = await post(form());
    assert.deepEqual(await res.json(), { error: 'Open Food Facts did not accept the product. (no code or invalid code)', kind: 'refused', detail: 'no code or invalid code' });

    offAnswers = [new TypeError('fetch failed')];
    res = await post(form());
    assert.equal(res.status, 502);
    assert.equal((await res.json()).kind, 'unreachable');

    res = await post(form({ user: null }));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).kind, 'no_account');
  } finally {
    console.log = log; console.error = error;
  }
  assert.ok(logs.some(l => l.includes('[off-share] login')), 'the outcome is logged');
  assert.ok(!logs.some(l => l.includes('s3cret-pw')), 'the password never is');
});

test('route: a photo goes up as multipart; a file that is not a picture is left out', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  offCalls.length = 0;
  offAnswers = [OK, { body: '{"status":"status ok"}' }];
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1])], { type: 'image/jpeg' });
  const res = await post(form({ image: jpeg }));
  assert.deepEqual(await res.json(), { ok: true, photo: 'sent' });
  assert.equal(offCalls[1].url, `${OFF_HOST}/cgi/product_image_upload.pl`);
  assert.equal(offCalls[1].init.body.get('imgupload_front_en').type, 'image/jpeg');

  offCalls.length = 0;
  offAnswers = [OK];
  const html = new Blob(['<html><script>x</script></html>'], { type: 'image/jpeg' });
  const res2 = await post(form({ image: html }));
  assert.deepEqual(await res2.json(), { ok: true, photo: 'failed' }, 'the product still goes, the file does not');
  assert.equal(offCalls.length, 1);
  assert.equal(offCalls[0].url, `${OFF_HOST}/cgi/product_jqm2.pl`);
});

test('route: staging only behind OFF_SHARE_STAGING', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  offCalls.length = 0;
  process.env.OFF_SHARE_STAGING = '1';
  try { await post(form()); } finally { delete process.env.OFF_SHARE_STAGING; }
  assert.equal(offCalls[0].url, `${OFF_STAGING_HOST}/cgi/product_jqm2.pl`);
});

test('route: an air-gapped server (OFF_LOCAL_ONLY) refuses', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  if (APP !== 'NutriTrace') return t.skip('NutriTrace only');
  offCalls.length = 0;
  process.env.OFF_LOCAL_DB = join(dir, 'none.duckdb');
  process.env.OFF_LOCAL_ONLY = '1';
  let res;
  try { res = await post(form()); } finally { delete process.env.OFF_LOCAL_DB; delete process.env.OFF_LOCAL_ONLY; }
  assert.equal(res.status, 403);
  assert.equal(offCalls.length, 0);
});
