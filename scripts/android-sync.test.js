/**
 * Android sync, end to end: the app's own native code (db-native.js,
 * sync.js, api-cached.js, the diary store, local-account.js) running as a
 * phone in Node (scripts/fixtures/native-sync) against a real server
 * (server/index.js on a scratch database). Each case was a way a phone
 * lost or mixed up data:
 *   - the day's note and a food's CookTrace origin, wiped by every push;
 *   - a food edited offline, lost when the app restarted before syncing;
 *   - edits and deletes of a food not yet pushed, sent with the phone's
 *     own id, hitting another food of the account;
 *   - a diary item keeping the phone's id after its food went up, and a
 *     server id looked up as a phone id (another food's units, barcode);
 *   - Clear all data never reaching the phone;
 *   - the phone's clock deciding which edit wins, and a losing phone
 *     keeping its copy for good;
 *   - a second account on the same phone seeing, and pushing, the first's;
 *   - completion marks set or cleared offline, undone by the next pull.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = new URL('./fixtures/native-sync/', import.meta.url);
let ready = false;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  await import('svelte/store');
  ready = true;
} catch { /* better-sqlite3 or the app's packages missing: the cases skip */ }

const dir = ready ? mkdtempSync(join(tmpdir(), 'nt-android-e2e-')) : null;
let server = null, base = null, sqlite = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function http(tok, method, path, body) {
  const go = () => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  // A kept-alive connection the server closed meanwhile (its 5 s idle
  // timeout, during a long phone run) fails once with "fetch failed".
  const r = await go().catch(e => { if (e?.message === 'fetch failed') return go(); throw e; });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
// Sign-in is rate limited (10 a quarter hour per address), so only the
// first account signs in; the others get a session the way the server
// makes one (middleware/auth.js signToken) with the test's secret.
const JWT_SECRET = 'android-sync-test-secret-0123456789abcdef';
// Signing in on the phone (NativeSetup, Settings > Server) goes through
// CapacitorHttp, and the server's answer leaves its session cookie in the
// phone's jar. Every later native request carries it: CapacitorHttp, and
// the Health Connect worker's push (HttpURLConnection, same jar). When
// another account signs in, that cookie must neither decide who the
// server answers as nor survive the switch.
test("another account's sign-in cookie left on the phone never decides whose data the server answers with", async (t) => {
  if (skip(t)) return;
  const frank = await account('frank', A);
  const gina = await account('gina', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const F = await me(frank), G = await me(gina);
  await http(frank, 'POST', '/api/foods', { name: 'Frank Web Food' });
  await http(gina, 'POST', '/api/foods', { name: 'Gina Web Food' });
  const first = phone('cookie', frank, `
    const { CapacitorHttp, CapacitorCookies } = await import('@capacitor/core');
    const platform = await import(p.src + 'lib/platform.js');
    const la = await import(p.src + 'lib/local-account.js');
    const login = await CapacitorHttp.post({ url: process.env.NT_SERVER + '/api/auth/login', headers: { 'Content-Type': 'application/json' }, data: { username: 'frank', password: 'Str0ng-Pass-77!x' } });
    platform.setAuthToken(login.data.token);
    await la.prepareLocalAccount(${JSON.stringify(F)}, { confirm: async () => true });
    await p.sync();
    // A sign-in gate's cookies, in front of the server and on its own host.
    await CapacitorCookies.setCookie({ url: process.env.NT_SERVER, key: 'authelia_session', value: 'gate' });
    await CapacitorCookies.setCookie({ url: 'https://gate.example.com', key: 'CF_Authorization', value: 'gate' });
    p.done({ jar: Object.keys(await CapacitorCookies.getCookies({ url: process.env.NT_SERVER })).sort() });`);
  assert.deepEqual(first.jar, ['authelia_session', 'nt_token'], 'the sign-in left its cookie in the jar');
  const r = phone('cookie', gina, `
    const { CapacitorHttp, CapacitorCookies } = await import('@capacitor/core');
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(G)}, { confirm: async () => true });
    const jar = await CapacitorCookies._all();
    const auth = { Authorization: 'Bearer ' + process.env.NT_TOKEN, 'Content-Type': 'application/json' };
    // What the Health Connect worker sends, with Gina's token.
    await CapacitorHttp.post({ url: process.env.NT_SERVER + '/api/sync/push', headers: auth, data: { foods: [], meals: [], diary: [], activity: [], fasts: [], settings: [], workouts: [],
      wellness: [{ date: '2026-09-20', source: 'health_connect', metric_type: 'steps', value: 4321, metadata: {} }] } });
    const who = (await CapacitorHttp.get({ url: process.env.NT_SERVER + '/api/auth/me', headers: auth })).data.user?.username;
    await p.sync();
    p.done({ jar, who, foods: (await p.api.getFoods()).map(f => f.name).filter(n => /Web Food$/.test(n)).sort() });`);
  const host = new URL(base).host;
  assert.deepEqual(r, { jar: { [host]: { authelia_session: 'gate' }, 'gate.example.com': { CF_Authorization: 'gate' }, localhost: {} }, who: 'gina', foods: ['Gina Web Food'] },
    "only NutriTrace's cookies go, at the server and at the app's own address; a gate's stay");
  assert.deepEqual(q(`SELECT u.username FROM wellness_data w JOIN users u ON u.id = w.user_id WHERE w.metric_type = 'steps' AND w.value = 4321`), [{ username: 'gina' }]);
});

// Android's Auto Backup and device transfer copy the phone's database, its
// install id and id counters included, to another phone. Both then give
// their next new row the same id; with the same install id they'd send
// the same create key, and the server would keep one row for both.
test("a phone restored from another's backup makes its own create keys: rows made on each with the same id both reach the server", async (t) => {
  if (skip(t)) return;
  const hana = await account('hana', A);
  const H = (await http(hana, 'GET', '/api/auth/me')).user;
  const first = phone('cloneA', hana, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(H)}, { confirm: async () => true });
    await p.sync();
    p.done(await p.dbn.dbInstallId());`);
  // The restore: the database comes back, the files the backup skips don't.
  const copied = readdirSync(dir).filter(f => f.startsWith('cloneA-'));
  for (const f of copied) copyFileSync(join(dir, f), join(dir, 'cloneB-' + f.slice('cloneA-'.length)));
  assert.ok(copied.some(f => f.endsWith('.db')), 'the database was copied');
  const make = (name, food) => phone(name, hana, `
    await p.offline(async () => { await p.api.createFood({ name: ${JSON.stringify(food)}, nutrition: {} }); });
    const f = (await p.api.getFoods()).find(x => x.name === ${JSON.stringify(food)});
    const own = [...(await p.dbn.dbOwnInstallIds())];
    p.done({ id: await p.dbn.dbInstallId(), own, local: f.id });`);
  const a = make('cloneA', 'Clone A Food'), b = make('cloneB', 'Clone B Food');
  assert.equal(a.local, b.local, 'both phones gave their new food the same id');
  assert.equal(a.id, first, 'the phone that made the backup keeps its id');
  assert.notEqual(b.id, first, 'the restored copy takes a new one');
  assert.ok(b.own.includes(first), "items the copy tagged before stay the copy's own");
  phone('cloneA', hana, `await p.sync(); p.done();`);
  phone('cloneB', hana, `await p.sync(); p.done();`);
  assert.deepEqual(q(`SELECT name FROM foods WHERE user_id = ? AND name LIKE 'Clone % Food' AND deleted_at IS NULL ORDER BY name`, H.id).map(r => r.name),
    ['Clone A Food', 'Clone B Food']);
  // Each phone ends with both, once.
  const seen = n => phone(n, hana, `await p.sync(); p.done((await p.api.getFoods()).map(f => f.name).filter(x => /^Clone . Food$/.test(x)).sort());`);
  assert.deepEqual(seen('cloneA'), ['Clone A Food', 'Clone B Food']);
  assert.deepEqual(seen('cloneB'), ['Clone A Food', 'Clone B Food']);
});

test("a setting the last account changed and never sent counts as waiting when someone else signs in", async (t) => {
  if (skip(t)) return;
  const ivan = await account('ivan', A), jade = await account('jade', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const I = await me(ivan), J = await me(jade);
  phone('setpend', ivan, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(I)}, { confirm: async () => true });
    await p.sync();
    await p.dbn.dbUpsertSetting('calorieGoal', 1800);
    p.done();`);
  const r = phone('setpend', jade, `
    const la = await import(p.src + 'lib/local-account.js');
    let asked = null;
    const ok = await la.prepareLocalAccount(${JSON.stringify(J)}, { confirm: async n => { asked = n; return false; } });
    p.done({ ok, asked });`);
  assert.deepEqual(r, { ok: false, asked: 1 });
  phone('setpend', ivan, `await p.sync(); p.done();`);
  assert.deepEqual(q(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'calorieGoal'`, I.id), [{ value: '1800' }], 'kept, and sent as the account that changed it');
});

async function account(name, admin) {
  const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${admin}` } : {}) }, body: JSON.stringify({ username: name, password: 'Str0ng-Pass-77!x' }) });
  if (!admin) return (await http(null, 'POST', '/api/auth/login', { username: name, password: 'Str0ng-Pass-77!x' })).token;
  const { user } = await r.json();
  const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
  return jwt.sign({ id: user.id, username: user.username, role: user.role, csrf: 'test' }, JWT_SECRET, { expiresIn: '1h' });
}
const q = (sql, ...a) => sqlite.prepare(sql).all(...a);

// A stand-in for the network between phone and server: forwards to the
// real server, except where `rule(req)` answers ({ status }) or holds a
// request ({ delayMs }) first. Records each request's method, path and
// token.
// Also keeps each request's body (`body`), and can answer with the real
// answer rewritten ({ rewrite(text) }) or never answer after the server
// has it ({ dropReply }).
async function proxy(rule = () => null) {
  const seen = [];
  const target = new URL(base);
  const srv = httpServer((req, res) => {
    const auth = req.headers.authorization || '';
    const entry = { method: req.method, path: req.url, token: auth.replace(/^Bearer /, ''), body: '' };
    seen.push(entry);
    const act = rule(req) || {};
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      entry.body = bodyBuf.toString('utf8');
      const go = () => {
        if (act.status) { res.writeHead(act.status, { 'Content-Type': 'application/json' }); res.end('{"error":"stand-in"}'); return; }
        const headers = { ...req.headers, 'content-length': String(bodyBuf.length) };
        delete headers['accept-encoding'];
        const up = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, r => {
          if (act.dropReply) { r.resume(); r.on('end', () => res.destroy()); return; }
          if (act.rewrite) {
            const out = [];
            r.on('data', c => out.push(c));
            r.on('end', () => {
              const text = act.rewrite(Buffer.concat(out).toString('utf8'));
              const h = { ...r.headers, 'content-length': String(Buffer.byteLength(text)) };
              delete h['content-encoding'];
              res.writeHead(r.statusCode, h); res.end(text);
            });
            return;
          }
          res.writeHead(r.statusCode, r.headers); r.pipe(res);
        });
        up.on('error', () => { try { res.destroy(); } catch {} });
        up.end(bodyBuf);
      };
      if (act.delayMs) setTimeout(go, act.delayMs); else go();
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}

// One phone run: `code` uses `p` (fixtures/native-sync/app.mjs) and ends
// with p.done(result). Same `phone` name = same phone, across restarts.
function phone(name, token, code, env = {}) {
  const prelude = `const { open } = await import(${JSON.stringify(new URL('app.mjs', fixtures).href)}); const p = await open();\n`;
  const r = spawnSync(process.execPath, ['--import', new URL('register.mjs', fixtures).href, '--input-type=module', '-e', prelude + code], {
    cwd: root, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, NT_SERVER: base, NT_TOKEN: token, PHONE_DB: join(dir, name), ...env },
  });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`phone ${name} failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}

// The same, without blocking this process: needed when the phone talks
// through proxy() (which runs here).
function phoneAsync(name, token, code, env = {}) {
  const prelude = `const { open } = await import(${JSON.stringify(new URL('app.mjs', fixtures).href)}); const p = await open();\n`;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--import', new URL('register.mjs', fixtures).href, '--input-type=module', '-e', prelude + code], {
      cwd: root, env: { ...process.env, NT_SERVER: base, NT_TOKEN: token, PHONE_DB: join(dir, name), ...env },
    });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    const kill = setTimeout(() => c.kill(), 180_000);
    c.on('close', () => {
      clearTimeout(kill);
      const line = out.split('\n').find(l => l.startsWith('RESULT '));
      if (!line) reject(new Error(`phone ${name} failed:\n${out}\n${err}`)); else resolve(JSON.parse(line.slice(7)));
    });
  });
}

let A = null, B = null;
test.before(async () => {
  if (!ready) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  A = await account('alice');
  B = await account('bob', A);
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  sqlite = new Database(join(dir, 'server.db'), { readonly: true, fileMustExist: true });
});
test.after(() => {
  try { sqlite?.close(); } catch {}
  try { server?.kill(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const skip = t => { if (!ready) { t.skip('better-sqlite3 or the app packages are missing'); return true; } return false; };

test("a push keeps the day's note and a food's CookTrace origin", async (t) => {
  if (skip(t)) return;
  const flour = await http(A, 'POST', '/api/foods', { name: 'CT Flour', source_app: 'cooktrace', source_external_id: 'ct-7', source_url: 'https://ct.example/p/7' });
  await http(A, 'PUT', '/api/diary/2026-09-01', { items: [], body_stats: {}, water: [], notes: 'Written on the web' });
  phone('notes', A, `
    await p.sync();
    await p.offline(async () => {
      const f = await p.food(${flour.id});
      await p.api.updateFood(f.id, { ...f, portion: 50 });
      await p.api.saveDiaryDate('2026-09-02', { items: [{ uuid: 'n1', name: 'Toast', nutrition: {}, portion: 30, unit: 'g', quantity: 1, meal: 0 }], body_stats: {}, water: [], notes: 'Written offline' });
      const d = await p.api.getDiaryDate('2026-09-01');
      await p.api.saveDiaryDate('2026-09-01', { ...d, items: [{ uuid: 'n2', name: 'Egg', nutrition: {}, portion: 50, unit: 'g', quantity: 1, meal: 0 }] });
    });
    await p.sync();
    p.done();`);
  assert.deepEqual(q('SELECT portion, source_app, source_external_id, source_url FROM foods WHERE id = ?', flour.id),
    [{ portion: 50, source_app: 'cooktrace', source_external_id: 'ct-7', source_url: 'https://ct.example/p/7' }]);
  assert.deepEqual(q(`SELECT date, notes FROM diary WHERE date IN ('2026-09-01', '2026-09-02') ORDER BY date`),
    [{ date: '2026-09-01', notes: 'Written on the web' }, { date: '2026-09-02', notes: 'Written offline' }]);
});

test('a food edited offline still goes up after the app restarts', async (t) => {
  if (skip(t)) return;
  const soup = await http(A, 'POST', '/api/foods', { name: 'Restart Soup' });
  phone('restart', A, `await p.sync(); p.done();`);
  phone('restart', A, `await p.offline(async () => { const f = await p.food(${soup.id}); await p.api.updateFood(f.id, { ...f, name: 'Restart Soup (offline)' }); }); p.done();`);
  phone('restart', A, `await p.sync(); p.done();`);
  assert.equal(q('SELECT name FROM foods WHERE id = ?', soup.id)[0].name, 'Restart Soup (offline)');
});

test("edits and deletes of a food not pushed yet never hit another of the account's foods", async (t) => {
  if (skip(t)) return;
  // Another account's foods first, so Alice's server ids run ahead of the phone's.
  for (let i = 0; i < 10; i++) await http(B, 'POST', '/api/foods', { name: `Bob Filler ${i}` });
  const a = await http(A, 'POST', '/api/foods', { name: 'Keep A' });
  const b = await http(A, 'POST', '/api/foods', { name: 'Keep B' });
  const r = phone('ids', A, `
    await p.sync();
    // New foods here until the phone's own ids reach the server ids of Keep A and B.
    let f; do { f = await p.api.createFood({ name: 'Filler', nutrition: {} }); } while (f.id < ${a.id} - 1);
    const oats = await p.api.createFood({ name: 'Phone Oats', nutrition: {} });
    await p.api.updateFood(oats.id, { ...oats, name: 'Phone Oats v2' });
    const tmp = await p.api.createFood({ name: 'Phone Temp', nutrition: {} });
    await p.api.deleteFood(tmp.id);
    // Logged before it went up, with the app's own diary store.
    const { addDiaryItem } = await import(p.src + 'stores/diary.js');
    await addDiaryItem(await p.api.getFood(oats.id), 0, '2026-09-03');
    await p.sleep(3500);
    await p.sync(); await p.sync();
    p.done({ oats: oats.id, tmp: tmp.id, item: (await p.api.getDiaryDate('2026-09-03')).items.at(-1) });`);
  assert.equal(r.oats, a.id, 'the phone id of Phone Oats is the server id of Keep A');
  assert.equal(r.tmp, b.id, 'the phone id of Phone Temp is the server id of Keep B');
  assert.deepEqual(q('SELECT name, deleted_at FROM foods WHERE id IN (?, ?) ORDER BY id', a.id, b.id),
    [{ name: 'Keep A', deleted_at: null }, { name: 'Keep B', deleted_at: null }]);
  const oatsServer = q(`SELECT id FROM foods WHERE name = 'Phone Oats v2' AND deleted_at IS NULL`);
  assert.equal(oatsServer.length, 1);
  assert.equal(r.item.food_server_id, oatsServer[0].id, 'the diary item has the food server id on the phone');
  const web = await http(A, 'GET', '/api/diary/2026-09-03');
  assert.equal(web.items.at(-1).food_server_id, oatsServer[0].id, 'and on the server');
});

test("a diary item shows its own food's units and barcode on the phone", async (t) => {
  if (skip(t)) return;
  const ids = {};
  for (const [n, u] of [['Milk', 'glass'], ['Cheese', 'wedge']]) ids[n] = (await http(B, 'POST', '/api/foods', { name: n, barcode: `BC-${n}`, alt_units: [{ abbr: u, grams: 10 }] })).id;
  const r = phone('hydrate', B, `
    await p.sync();
    let milk = (await p.api.getFoods()).find(f => f.name === 'Milk');
    // Foods made here until one has Milk's server id as its phone id.
    let f; do { f = await p.api.createFood({ name: 'Wrong', barcode: 'BC-WRONG', alt_units: [{ abbr: 'wrong', grams: 1 }], nutrition: {} }); } while (f.id < milk.server_id);
    const clash = (await p.api.getFoods()).find(x => x.id === milk.server_id && x.name !== 'Milk')?.name || null;
    const { addDiaryItem } = await import(p.src + 'stores/diary.js');
    await addDiaryItem(milk, 0, '2026-09-04');
    const it = (await p.api.getDiaryDate('2026-09-04')).items[0];
    p.done({ clash, barcode: it.barcode, units: it.alt_units });`);
  assert.ok(r.clash, "the lookup can go wrong: Milk's server id is another food's phone id");
  assert.equal(r.barcode, 'BC-Milk');
  assert.deepEqual(r.units, [{ abbr: 'glass', grams: 10 }]);
});

test('Clear all data reaches the phone: wellness, workouts and fasts too', async (t) => {
  if (skip(t)) return;
  const cookie = await account('carol', A);
  const r = phone('clear', cookie, `
    const D = '2026-09-05';
    await p.dbn.dbStartFast({ goal_hours: 14 });
    await p.dbn.dbUpsertWellness(D, 'health_connect', 'steps', 4321, {});
    await p.dbn.dbUpsertWorkoutLocal({ source: 'health_connect', source_id: 'hc-1', date: D, activity_name: 'Phone Run', duration_ms: 60000 });
    await p.sync();
    await fetch(process.env.NT_SERVER + '/api/data', { method: 'DELETE', headers: { Authorization: 'Bearer ' + process.env.NT_TOKEN } });
    await p.sync();
    const db = await p.dbn.getDb();
    const n = async t => (await db.query('SELECT COUNT(*) AS n FROM ' + t, [])).values[0].n;
    p.done({ wellness: await n('wellness_data'), workouts: await n('workouts'), fasts: (await p.dbn.dbGetFasts()).length });`);
  assert.deepEqual(r, { wellness: 0, workouts: 0, fasts: 0 });
});

for (const [skewMs, label] of [[-5 * 60_000, '5 minutes slow'], [5 * 60_000, '5 minutes fast']]) {
  test(`a phone ${label}: the later edit wins, and the phone ends up with it`, async (t) => {
    if (skip(t)) return;
    const a = await http(A, 'POST', '/api/foods', { name: `Clock A ${skewMs}` });
    const b = await http(A, 'POST', '/api/foods', { name: `Clock B ${skewMs}` });
    const name = `clock${skewMs}`;
    phone(name, A, `await p.sync(); p.done();`, { SKEW_MS: String(skewMs) });
    // A: the web edits, the phone pulls that, then edits it later on.
    await http(A, 'PUT', `/api/foods/${a.id}`, { name: 'A web (first)' });
    await sleep(3000);
    phone(name, A, `await p.sync(); p.done();`, { SKEW_MS: String(skewMs) });
    await sleep(3000);
    phone(name, A, `await p.offline(async () => { const f = await p.food(${a.id}); await p.api.updateFood(f.id, { ...f, name: 'A phone (later)' }); }); p.done();`, { SKEW_MS: String(skewMs) });
    // B: the phone edits offline first, the web edits later.
    phone(name, A, `await p.offline(async () => { const f = await p.food(${b.id}); await p.api.updateFood(f.id, { ...f, name: 'B phone (first)' }); }); p.done();`, { SKEW_MS: String(skewMs) });
    await sleep(3000);
    await http(A, 'PUT', `/api/foods/${b.id}`, { name: 'B web (later)' });
    await sleep(3000);
    const r = phone(name, A, `await p.sync(); await p.sync(); p.done({ a: (await p.food(${a.id})).name, b: (await p.food(${b.id})).name });`, { SKEW_MS: String(skewMs) });
    assert.equal(q('SELECT name FROM foods WHERE id = ?', a.id)[0].name, 'A phone (later)');
    assert.equal(q('SELECT name FROM foods WHERE id = ?', b.id)[0].name, 'B web (later)');
    assert.deepEqual(r, { a: 'A phone (later)', b: 'B web (later)' });
  });
}

test("another account signing in on the phone neither sees nor pushes the first one's data", async (t) => {
  if (skip(t)) return;
  const dave = await account('dave', A);
  const erin = await account('erin', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const D = await me(dave), E = await me(erin);
  await http(dave, 'POST', '/api/foods', { name: 'Dave Web Food' });
  phone('switch', dave, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(D)}, { confirm: async () => true });
    await p.sync();
    await p.offline(async () => {
      await p.api.createFood({ name: 'Dave Offline Food', nutrition: {} });
      await p.api.saveDiaryDate('2026-09-06', { items: [], body_stats: {}, water: [], notes: 'Dave private note' });
    });
    p.done();`);
  // Erin signs in on the same phone. Before the app has checked, sync refuses.
  const early = phone('switch', erin, `p.done(await p.fullSync(true, true));`);
  assert.equal(early.reason, 'other_account');
  // Saying no keeps Dave's changes, and Dave's next sign-in sends them as Dave.
  const kept = phone('switch', erin, `
    const la = await import(p.src + 'lib/local-account.js');
    let asked = null;
    const ok = await la.prepareLocalAccount(${JSON.stringify(E)}, { confirm: async n => { asked = n; return false; } });
    p.done({ ok, asked });`);
  assert.deepEqual(kept, { ok: false, asked: 2 });
  phone('switch', dave, `await p.sync(); p.done();`);
  assert.deepEqual(q(`SELECT u.username FROM foods f JOIN users u ON u.id = f.user_id WHERE f.name = 'Dave Offline Food'`), [{ username: 'dave' }]);
  // Dave left again with something unsent; Erin says yes this time.
  phone('switch', dave, `await p.offline(async () => { await p.api.createFood({ name: 'Dave Second Food', nutrition: {} }); }); p.done();`);
  const r = phone('switch', erin, `
    const la = await import(p.src + 'lib/local-account.js');
    const ok = await la.prepareLocalAccount(${JSON.stringify(E)}, { confirm: async () => true });
    const before = (await p.api.getFoods()).map(f => f.name);
    await p.sync();
    p.done({ ok, before, note: (await p.api.getDiaryDate('2026-09-06')).notes || '' });`);
  assert.deepEqual(r, { ok: true, before: [], note: '' });
  assert.deepEqual(q(`SELECT name FROM foods WHERE user_id = ?`, E.id), []);
  assert.deepEqual(q(`SELECT 1 FROM foods WHERE name = 'Dave Second Food'`), [], 'discarded only after saying so');
  // Same account back: nothing to ask, nothing cleared.
  const same = phone('switch', erin, `
    const la = await import(p.src + 'lib/local-account.js');
    await p.offline(async () => { await p.api.createFood({ name: 'Erin Waiting', nutrition: {} }); });
    let asked = false;
    const ok = await la.prepareLocalAccount(${JSON.stringify(E)}, { confirm: async () => { asked = true; return true; } });
    await p.sync();
    p.done({ ok, asked });`);
  assert.deepEqual(same, { ok: true, asked: false });
  assert.deepEqual(q(`SELECT u.username FROM foods f JOIN users u ON u.id = f.user_id WHERE f.name = 'Erin Waiting'`), [{ username: 'erin' }]);
});

test('completion marks set or cleared offline reach the server and stay', async (t) => {
  if (skip(t)) return;
  const D = '2026-09-07', E = '2026-09-08';
  await http(B, 'PUT', `/api/diary/${D}`, { items: [{ uuid: 'c1', name: 'Toast', nutrition: {}, portion: 30, unit: 'g', quantity: 1, meal: 0 }], body_stats: {}, water: [] });
  await http(B, 'PUT', `/api/diary/${D}/completion`, { completed: true });
  await http(B, 'PUT', `/api/diary/${D}/meal-completion`, { slot: 0, completed: true });
  const r = phone('marks', B, `
    await p.sync();
    await p.offline(async () => {
      await p.api.setDiaryCompletion('${D}', false);
      await p.api.setDiaryMealCompletion('${D}', 0, false);
      await p.api.setDiaryCompletion('${E}', true);
      await p.api.setDiaryMealCompletion('${E}', 2, true);
    });
    await p.sync(); await p.sync();
    const day = async d => { const x = await p.api.getDiaryDate(d); return { day: !!x.completed_at, meals: x.completed_meals }; };
    p.done({ D: await day('${D}'), E: await day('${E}') });`);
  assert.deepEqual(r, { D: { day: false, meals: [] }, E: { day: true, meals: [2] } });
  assert.deepEqual(q(`SELECT date, completed_at IS NOT NULL AS day, completed_meals FROM diary WHERE user_id = (SELECT id FROM users WHERE username = 'bob') AND date IN (?, ?) ORDER BY date`, D, E),
    [{ date: D, day: 0, completed_meals: null }, { date: E, day: 1, completed_meals: '[2]' }]);
});

test('three devices: a stale phone loses without blocking a newer phone, and every device ends on the newest edit', async (t) => {
  if (skip(t)) return;
  const f = await http(A, 'POST', '/api/foods', { name: 'Three 0' });
  phone('three-a', A, `await p.sync(); p.done();`);
  phone('three-b', A, `await p.sync(); p.done();`);
  // Phone A edits offline first; then the web; then phone B, offline too.
  phone('three-a', A, `await p.offline(async () => { const x = await p.food(${f.id}); await p.api.updateFood(x.id, { ...x, name: 'Three A (oldest)' }); }); p.done();`);
  await sleep(3000);
  await http(A, 'PUT', `/api/foods/${f.id}`, { name: 'Three web (middle)' });
  await sleep(3000);
  phone('three-b', A, `await p.offline(async () => { const x = await p.food(${f.id}); await p.api.updateFood(x.id, { ...x, name: 'Three B (newest)' }); }); p.done();`);
  await sleep(3000);
  // A syncs first and loses; B syncs after and must still win.
  const a1 = phone('three-a', A, `await p.sync(); p.done((await p.food(${f.id})).name);`);
  assert.equal(a1, 'Three web (middle)', 'the losing phone takes the server copy at once');
  const b1 = phone('three-b', A, `await p.sync(); p.done((await p.food(${f.id})).name);`);
  assert.equal(b1, 'Three B (newest)');
  assert.equal(q('SELECT name FROM foods WHERE id = ?', f.id)[0].name, 'Three B (newest)');
  const a2 = phone('three-a', A, `await p.sync(); p.done((await p.food(${f.id})).name);`);
  assert.equal(a2, 'Three B (newest)');
});

test('the clock is read when the push arrives, not after its photos download', async (t) => {
  if (skip(t)) return;
  // A photo host that takes 5 seconds.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const slow = httpServer((req, res) => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png); }, 5000));
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  try {
    const f = await http(A, 'POST', '/api/foods', { name: 'Photo 0' });
    phone('slowimg', A, `await p.sync(); p.done();`);
    phone('slowimg', A, `await p.offline(async () => { const x = await p.food(${f.id}); await p.api.updateFood(x.id, { ...x, name: 'Photo phone (older)', imgUrl: 'http://127.0.0.1:${slow.address().port}/a.png' }); }); p.done();`);
    await sleep(2500);
    await http(A, 'PUT', `/api/foods/${f.id}`, { name: 'Photo web (newer)' });
    phone('slowimg', A, `await p.sync(); p.done();`);
    assert.equal(q('SELECT name FROM foods WHERE id = ?', f.id)[0].name, 'Photo web (newer)');
  } finally { slow.closeAllConnections?.(); slow.close(); }
});

test('Clear all data on a long history reaches the phone in a few hundred statements, not one per value', async (t) => {
  if (skip(t)) return;
  const zed = await account('zed', A);
  const r = phone('bigclear', zed, `
    const db = await p.dbn.getDb();
    await p.sync();
    // 20,000 wearable values the phone already has, as a pull would leave them.
    await db.execute("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19999) INSERT INTO wellness_data (user_id, date, source, metric_type, value, sync_status) SELECT 1, date('2000-01-01', '+' || (i % 1000) || ' days'), 'fitbit', 'm' || (i / 1000), 1, 'synced' FROM n");
    const del = [];
    for (let i = 0; i < 20000; i++) del.push({ date: new Date(Date.UTC(2000, 0, 1) + (i % 1000) * 86400000).toISOString().slice(0, 10), source: 'fitbit', metric_type: 'm' + Math.floor(i / 1000) });
    globalThis.__bridgeRuns = 0;
    const t0 = Date.now();
    await p.dbn.dbApplyServerDeletions({ wellness: del, workouts: [] });
    const left = (await db.query('SELECT COUNT(*) AS n FROM wellness_data', [])).values[0].n;
    p.done({ runs: globalThis.__bridgeRuns, ms: Date.now() - t0, left });`);
  assert.equal(r.left, 0);
  assert.ok(r.runs <= 200, `${r.runs} statements`);
});

test('a completion mark the server asks to retry (429, 408) is sent again, and an old mark never undoes a newer one', async (t) => {
  if (skip(t)) return;
  const D = '2026-08-11', E = '2026-08-12';
  let refuse = 1;
  const px = await proxy(req => (req.method === 'PUT' && req.url.endsWith('/completion') && refuse-- > 0 ? { status: 429 } : null));
  try {
    const r = await phoneAsync('marks429', B, `
      await p.sync();
      await p.api.setDiaryCompletion('${D}', true);
      await p.sleep(800);
      await p.sync(); await p.sync();
      p.done((await p.dbn.dbGetCompletionOps()).length);`, { NT_SERVER: px.url });
    assert.equal(r, 0);
    assert.deepEqual(q(`SELECT completed_at IS NOT NULL AS c FROM diary WHERE user_id = (SELECT id FROM users WHERE username = 'bob') AND date = ?`, D), [{ c: 1 }]);
  } finally { await px.close(); }
  // Marked offline, then unmarked online: the unmark is the last word.
  const r2 = phone('marksorder', B, `
    await p.sync();
    await p.offline(async () => { await p.api.setDiaryCompletion('${E}', true); });
    await p.api.setDiaryCompletion('${E}', false);
    await p.sleep(800);
    await p.sync(); await p.sync();
    p.done(!!(await p.api.getDiaryDate('${E}')).completed_at);`);
  assert.equal(r2, false);
  assert.deepEqual(q(`SELECT completed_at IS NOT NULL AS c FROM diary WHERE user_id = (SELECT id FROM users WHERE username = 'bob') AND date = ?`, E), [{ c: 0 }]);
});

test("the day's note: the newer edit wins either way, and a note cleared offline stays cleared", async (t) => {
  if (skip(t)) return;
  const D1 = '2026-08-21', D2 = '2026-08-22', D3 = '2026-08-23';
  for (const d of [D1, D2, D3]) await http(A, 'PUT', `/api/diary/${d}`, { items: [], body_stats: {}, water: [], notes: 'Web first' });
  phone('notes2', A, `await p.sync(); p.done();`);
  // D1: the phone edits offline, the web edits later: the web's stays.
  phone('notes2', A, `await p.offline(async () => { const d = await p.api.getDiaryDate('${D1}'); await p.api.saveDiaryDate('${D1}', { ...d, notes: 'Phone (older)' }); }); p.done();`);
  await sleep(3000);
  await http(A, 'PUT', `/api/diary/${D1}`, { items: [], body_stats: {}, water: [], notes: 'Web (newer)' });
  // D2: the web edits, then the phone edits offline later: the phone's wins.
  await http(A, 'PUT', `/api/diary/${D2}`, { items: [], body_stats: {}, water: [], notes: 'Web (older)' });
  await sleep(3000);
  // D3: cleared on the phone offline.
  const r = phone('notes2', A, `
    await p.offline(async () => {
      const d2 = await p.api.getDiaryDate('${D2}'); await p.api.saveDiaryDate('${D2}', { ...d2, notes: 'Phone (newer)' });
      const d3 = await p.api.getDiaryDate('${D3}'); await p.api.saveDiaryDate('${D3}', { ...d3, notes: '' });
    });
    await p.sync(); await p.sync();
    const n = async d => (await p.api.getDiaryDate(d)).notes || '';
    p.done([await n('${D1}'), await n('${D2}'), await n('${D3}')]);`);
  assert.deepEqual(q(`SELECT notes FROM diary WHERE user_id = (SELECT id FROM users WHERE username = 'alice') AND date IN (?, ?, ?) ORDER BY date`, D1, D2, D3).map(x => x.notes), ['Web (newer)', 'Phone (newer)', null]);
  assert.deepEqual(r, ['Web (newer)', 'Phone (newer)', '']);
});

test("a food pulled before the phone had origin columns doesn't wipe the server's origin when edited", async (t) => {
  if (skip(t)) return;
  const f = await http(A, 'POST', '/api/foods', { name: 'CT Sugar', source_app: 'cooktrace', source_external_id: 'ct-9', source_url: 'https://ct.example/p/9' });
  phone('prov', A, `
    await p.sync();
    const db = await p.dbn.getDb();
    await db.run('UPDATE foods SET source_app = NULL, source_external_id = NULL, source_url = NULL WHERE server_id = ?', [${f.id}]);
    await p.offline(async () => { const x = await p.food(${f.id}); await p.api.updateFood(x.id, { ...x, portion: 5 }); });
    await p.sync();
    p.done();`);
  assert.deepEqual(q('SELECT portion, source_app, source_external_id, source_url FROM foods WHERE id = ?', f.id),
    [{ portion: 5, source_app: 'cooktrace', source_external_id: 'ct-9', source_url: 'https://ct.example/p/9' }]);
});

test('the same account at another address of the same server is still the same account', async (t) => {
  if (skip(t)) return;
  const me = (await http(B, 'GET', '/api/auth/me')).user;
  const alt = base.replace('127.0.0.1', 'localhost');
  phone('alias', B, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async () => true });
    await p.sync();
    await p.offline(async () => { await p.api.createFood({ name: 'Bob Alias Unsent', nutrition: {} }); });
    p.done();`);
  const r = phone('alias', B, `
    const la = await import(p.src + 'lib/local-account.js');
    let asked = null;
    const ok = await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async n => { asked = n; return true; } });
    await p.sync();
    p.done({ ok, asked, foods: (await p.api.getFoods()).map(f => f.name).filter(n => n.startsWith('Bob Alias')) });`, { NT_SERVER: alt });
  assert.deepEqual(r, { ok: true, asked: null, foods: ['Bob Alias Unsent'] });
  assert.deepEqual(q(`SELECT u.username FROM foods f JOIN users u ON u.id = f.user_id WHERE f.name = 'Bob Alias Unsent'`), [{ username: 'bob' }]);
});

test('a food renamed before its first push still links its diary items', async (t) => {
  if (skip(t)) return;
  const D = '2026-08-31';
  const r = phone('rename', B, `
    const ds = await import(p.src + 'stores/diary.js');
    await p.sync();
    let f;
    await p.offline(async () => {
      f = await p.api.createFood({ name: 'Oats', nutrition: { calories: 100 }, portion: 40, unit: 'g' });
      await ds.addDiaryItem(await p.api.getFood(f.id), 0, '${D}');
      await p.api.updateFood(f.id, { ...f, name: 'Rolled Oats' });
    });
    await p.sync(); await p.sync();
    const it = (await p.api.getDiaryDate('${D}')).items[0];
    p.done({ fsid: it.food_server_id, server: (await p.api.getFood(f.id)).server_id });`);
  assert.ok(r.server, 'the food went up');
  assert.equal(r.fsid, r.server);
  const web = await http(B, 'GET', `/api/diary/${D}`);
  assert.equal(web.items[0].food_server_id, r.server);
});

test("signing out mid-push never sends one account's rows under the next account's session", async (t) => {
  if (skip(t)) return;
  const fay = await account('fay', A);
  const gil = await account('gil', A);
  // A completion mark waits first, and the server takes 6 seconds to take
  // it; sign-out gives the push 4. The rows would go after the mark.
  const px = await proxy(req => (req.method === 'PUT' && req.url.endsWith('/completion') ? { delayMs: 6000 } : null));
  try {
    await phoneAsync('signout', fay, `
      const la = await import(p.src + 'lib/local-account.js');
      await p.sync();
      await p.offline(async () => {
        await p.api.createFood({ name: 'Fay Waiting', nutrition: {} });
        await p.api.setDiaryCompletion('2026-09-30', true);
      });
      const { pushBeforeSignOut } = await import(p.src + 'lib/sync.js');
      const t0 = Date.now();
      await pushBeforeSignOut();
      const took = Date.now() - t0;
      // Signed out, and Gil signs in on the same phone at once.
      process.env.NT_TOKEN = ${JSON.stringify(gil)};
      await p.sleep(5000);
      if (took > 5000) throw new Error('sign-out waited ' + took + 'ms');
      p.done(took);`, { NT_SERVER: px.url });
    const sent = px.seen.filter(x => x.path.startsWith('/api/sync/push') || x.path.includes('/completion'));
    assert.ok(sent.length > 0);
    assert.ok(sent.every(x => x.token === fay), "every request carried the signing-out account's session");
    assert.deepEqual(q(`SELECT u.username FROM foods f JOIN users u ON u.id = f.user_id WHERE f.name = 'Fay Waiting'`).filter(x => x.username !== 'fay'), []);
  } finally { await px.close(); }
});

test("settings the new account loads wait for the account check: they neither count as the previous account's nor go over them", async (t) => {
  if (skip(t)) return;
  const hal = await account('hal', A), ivy = await account('ivy', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const H = await me(hal), I = await me(ivy);
  await http(ivy, 'PUT', '/api/settings', { key: 'waterGoalMl', value: 1800 });
  const r = phone('settings-switch', hal, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(H)}, { confirm: async () => true });
    await p.sync();
    localStorage.setItem('nt:nativeMode', 'server');
    // Ivy signs in: her session and id, then her settings load from the
    // server, as stores/auth.js does, before the account check has run.
    process.env.NT_TOKEN = ${JSON.stringify(ivy)};
    localStorage.setItem('wl:userId', '${I.id}');
    const { loadServerSettings } = await import(p.src + 'stores/settings.js');
    await loadServerSettings();
    await p.sleep(300);
    const db = await p.dbn.getDb();
    const rows = async () => (await db.query("SELECT key, value, sync_status FROM user_settings WHERE key = 'waterGoalMl'", [])).values;
    const beforeCheck = await rows();
    let asked = null;
    const ok = await la.ensureLocalAccount(${JSON.stringify(I)}, { confirm: async n => { asked = n; return false; } });
    await p.sleep(500);
    p.done({ ok, asked, beforeCheck, afterCheck: await rows() });`);
  assert.deepEqual(r, { ok: true, asked: null, beforeCheck: [], afterCheck: [{ key: 'waterGoalMl', value: '1800', sync_status: 'synced' }] });
});

test('if the phone cannot tell whose data it holds, it shows none of it and can try again', async (t) => {
  if (skip(t)) return;
  const jo = await account('jo', A);
  const J = (await http(jo, 'GET', '/api/auth/me')).user;
  const r = phone('gate-error', jo, `
    const la = await import(p.src + 'lib/local-account.js');
    const { get } = await import('svelte/store');
    const db = await p.dbn.getDb();
    await db.execute('ALTER TABLE sync_meta RENAME TO sync_meta_away');
    const first = await la.ensureLocalAccount(${JSON.stringify(J)}, { confirm: async () => true });
    const gate1 = get(la.accountGate);
    const shown1 = la.accountReadyFor(gate1, ${J.id});
    await db.execute('ALTER TABLE sync_meta_away RENAME TO sync_meta');
    const second = await la.ensureLocalAccount(${JSON.stringify(J)}, { confirm: async () => true });
    p.done({ first, state1: gate1.state, shown1, second, shown2: la.accountReadyFor(get(la.accountGate), ${J.id}) });`);
  assert.deepEqual(r, { first: false, state1: 'error', shown1: false, second: true, shown2: true });
});

test('Disconnect, use the phone on its own, then connect to another account: no question, nothing lost or sent twice', async (t) => {
  if (skip(t)) return;
  const kim = await account('kim', A), lee = await account('lee', A);
  const K = (await http(kim, 'GET', '/api/auth/me')).user, L = (await http(lee, 'GET', '/api/auth/me')).user;
  phone('disconnect', kim, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(K)}, { confirm: async () => true });
    await p.sync();
    p.done();`);
  // Settings > Disconnect (as ServerConnection.svelte), then local use.
  phone('disconnect', '', `
    const la = await import(p.src + 'lib/local-account.js');
    await la.setLocalOwner?.();
    await p.dbn.dbCreateFood({ name: 'Made Offline Alone', nutrition: {} });
    p.done();`, { NT_SERVER: '' });
  // Connect to the server as Lee and choose Upload (ServerConnection.svelte).
  const r = phone('disconnect', lee, `
    const la = await import(p.src + 'lib/local-account.js');
    const { uploadLocalToServer } = await import(p.src + 'lib/migrate.js');
    const summary = await uploadLocalToServer({ serverUrl: process.env.NT_SERVER, authToken: process.env.NT_TOKEN });
    await la.claimForServer?.(process.env.NT_SERVER, ${L.id}, { clear: !summary.errors.length });
    let asked = null;
    const ok = await la.prepareLocalAccount(${JSON.stringify(L)}, { confirm: async n => { asked = n; return false; } });
    if (ok) { await p.sync(); await p.sync(); }
    p.done({ ok, asked, foods: (await p.api.getFoods()).map(f => f.name).filter(n => n === 'Made Offline Alone') });`);
  assert.deepEqual(r, { ok: true, asked: null, foods: ['Made Offline Alone'] });
  assert.deepEqual(q(`SELECT u.username FROM foods f JOIN users u ON u.id = f.user_id WHERE f.name = 'Made Offline Alone' AND f.deleted_at IS NULL`), [{ username: 'lee' }]);
});

// ── Fourth review ─────────────────────────────────────────────────────────

test("an online diary save on the phone keeps a newer note written on the web", async (t) => {
  if (skip(t)) return;
  const D = '2026-07-01';
  phone('rv1', A, `await p.sync(); p.done();`);
  await http(A, 'PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [], notes: 'Web note' });
  phone('rv1', A, `
    const d = await p.api.getDiaryDate('${D}');
    await p.api.saveDiaryDate('${D}', { items: [{ uuid: 'r1', name: 'Egg', nutrition: {}, portion: 50, unit: 'g', quantity: 1, meal: 0 }], body_stats: {}, water: [], notes: d.notes || '' });
    await p.sleep(1500);
    await p.sync();
    p.done();`);
  assert.equal(q(`SELECT notes FROM diary WHERE user_id = (SELECT id FROM users WHERE username='alice') AND date = ?`, D)[0].notes, 'Web note');
});

test("a slow phone's unrelated diary edit doesn't bring back its older note", async (t) => {
  if (skip(t)) return;
  const D = '2026-07-02';
  const env = { SKEW_MS: String(-60_000) };
  phone('rv2', A, `await p.sync(); await p.api.saveDiaryDate('${D}', { items: [], body_stats: {}, water: [], notes: 'Phone note' }); await p.sync(); await p.sync(); p.done();`, env);
  await sleep(5000);
  await http(A, 'PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [], notes: 'Web note (newer)' });
  phone('rv2', A, `
    await p.offline(async () => {
      const d = await p.api.getDiaryDate('${D}');
      await p.api.saveDiaryDate('${D}', { ...d, items: [{ uuid: 'r2', name: 'Toast', nutrition: {}, portion: 30, unit: 'g', quantity: 1, meal: 0 }] });
    });
    await p.sync();
    p.done();`, env);
  assert.equal(q(`SELECT notes FROM diary WHERE user_id = (SELECT id FROM users WHERE username='alice') AND date = ?`, D)[0].notes, 'Web note (newer)');
});

test('the diary route keeps the note when a save leaves it out, and the newer edit wins when it has one', async (t) => {
  if (skip(t)) return;
  const D = '2026-07-05';
  const day = () => q(`SELECT notes, notes_updated_at AS at FROM diary WHERE user_id = (SELECT id FROM users WHERE username='alice') AND date = ?`, D)[0];
  await http(A, 'PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [], notes: 'Kept' });
  const first = day();
  await sleep(1500);
  await http(A, 'PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [] });
  assert.deepEqual(day(), first, 'no note in the save: the note and its time stay');
  await http(A, 'PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [], notes: 'Kept' });
  assert.deepEqual(day(), first, 'the same note: its time stays');
  const old = new Date(Date.now() - 3600_000).toISOString();
  await http(A, 'PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [], notes: 'Older edit', notes_updated_at: old, client_now: new Date().toISOString() });
  assert.equal(day().notes, 'Kept', 'an older edit loses');
  await http(A, 'PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [], notes: '', notes_updated_at: new Date().toISOString(), client_now: new Date().toISOString() });
  assert.equal(day().notes, null, 'a newer clear wins');
});

test('Connect > Upload keeps every kind of local data: what went up comes back, what failed goes up later', async (t) => {
  if (skip(t)) return;
  const mo = await account('mo', A);
  const M = (await http(mo, 'GET', '/api/auth/me')).user;
  phone('rv3', '', `
    const la = await import(p.src + 'lib/local-account.js');
    await la.setLocalOwner();
    const food = await p.dbn.dbCreateFood({ name: 'Up Food', nutrition: {} });
    await p.dbn.dbCreateMeal({ name: 'Up Meal', items: [] });
    await p.dbn.dbCreateMeal({ name: 'Up Recipe', items: [], is_recipe: 1 });
    await p.dbn.dbSaveDiaryDate('2026-07-03', { items: [{ uuid: 'u1', id: food.id, food_server_id: null, name: 'Up Food', nutrition: {}, portion: 1, unit: 'g', quantity: 1, meal: 0 }], body_stats: {}, water: [], notes: 'Up note' });
    await p.dbn.dbSetDiaryCompletion('2026-07-03', true);
    await p.dbn.dbCreateActivity({ date: '2026-07-03', name: 'Up Run', kcal: 300, duration_min: 30 });
    await p.dbn.dbStartFast({ goal_hours: 16 });
    await p.dbn.dbUpsertWellness('2026-07-03', 'health_connect', 'steps', 1234, {});
    await p.dbn.dbUpsertWorkoutLocal({ source: 'health_connect', source_id: 'up-1', date: '2026-07-03', activity_name: 'Up Walk', duration_ms: 60000 });
    p.done();`, { NT_SERVER: '' });
  // The meal upload fails once (the server refuses it): it must stay here and go up with the sync.
  let refuse = 1;
  const px = await proxy(req => (req.method === 'POST' && req.url === '/api/meals' && refuse-- > 0 ? { status: 500 } : null));
  let r;
  try {
    r = await phoneAsync('rv3', mo, `
      const la = await import(p.src + 'lib/local-account.js');
      const { uploadLocalToServer } = await import(p.src + 'lib/migrate.js');
      const summary = await uploadLocalToServer({ serverUrl: process.env.NT_SERVER, authToken: process.env.NT_TOKEN });
      await la.claimForServer(process.env.NT_SERVER, ${M.id}, { uploaded: summary.uploaded });
      p.done({ errors: summary.errors.map(e => e.stage) });`, { NT_SERVER: px.url });
  } finally { await px.close(); }
  assert.equal(r.errors.length, 1, 'one row failed to go up');
  const after = phone('rv3', mo, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(M)}, { confirm: async () => true });
    await p.sync(); await p.sync();
    const db = await p.dbn.getDb();
    const n = async sql => (await db.query(sql, [])).values[0].n;
    const d = await p.api.getDiaryDate('2026-07-03');
    p.done({
      foods: await n("SELECT COUNT(*) AS n FROM foods WHERE name = 'Up Food'"),
      meals: await n("SELECT COUNT(*) AS n FROM meals WHERE name IN ('Up Meal', 'Up Recipe')"),
      activity: await n('SELECT COUNT(*) AS n FROM activity_log'), fasts: await n('SELECT COUNT(*) AS n FROM fasts'),
      wellness: await n("SELECT COUNT(*) AS n FROM wellness_data WHERE metric_type = 'steps'"), workouts: await n('SELECT COUNT(*) AS n FROM workouts'),
      note: d.notes, done: !!d.completed_at, linked: typeof d.items[0]?.food_server_id === 'number',
    });`);
  assert.deepEqual(after, { foods: 1, meals: 2, activity: 1, fasts: 1, wellness: 1, workouts: 1, note: 'Up note', done: true, linked: true });
  const n = (sql) => q(sql, M.id)[0].n;
  assert.deepEqual({
    foods: n(`SELECT COUNT(*) AS n FROM foods WHERE user_id = ? AND deleted_at IS NULL`),
    meals: n(`SELECT COUNT(*) AS n FROM meals WHERE user_id = ? AND deleted_at IS NULL`),
    activity: n(`SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ?`),
    fasts: n(`SELECT COUNT(*) AS n FROM fasts WHERE user_id = ?`),
    wellness: n(`SELECT COUNT(*) AS n FROM wellness_data WHERE user_id = ? AND metric_type = 'steps'`),
    workouts: n(`SELECT COUNT(*) AS n FROM workouts WHERE user_id = ?`),
  }, { foods: 1, meals: 2, activity: 1, fasts: 1, wellness: 1, workouts: 1 }, 'each once on the server');
});

test("after an account switch, the new account never sees or edits the day the last one had open", async (t) => {
  if (skip(t)) return;
  const nia = await account('nia', A), oz = await account('oz', A);
  const N = (await http(nia, 'GET', '/api/auth/me')).user, O = (await http(oz, 'GET', '/api/auth/me')).user;
  const D = '2026-07-04';
  await http(nia, 'PUT', `/api/diary/${D}`, { items: [
    { uuid: 'n-a', name: 'Nia secret A', nutrition: {}, portion: 1, unit: 'g', quantity: 1, meal: 0 },
    { uuid: 'n-b', name: 'Nia secret B', nutrition: {}, portion: 1, unit: 'g', quantity: 1, meal: 0 }], body_stats: {}, water: [], notes: 'Nia note' });
  const r = phone('rv4', nia, `
    const la = await import(p.src + 'lib/local-account.js');
    const { get } = await import('svelte/store');
    await la.prepareLocalAccount(${JSON.stringify(N)}, { confirm: async () => true });
    await p.sync();
    const st = await import(p.src + 'stores/diary.js');
    await st.loadEntry('${D}');
    process.env.NT_TOKEN = ${JSON.stringify(oz)};
    const ok = await la.prepareLocalAccount(${JSON.stringify(O)}, { confirm: async () => true });
    const shown = (get(st.currentEntry)?.items || []).map(i => i.name);
    await st.removeDiaryItem(0);
    await p.sleep(1500);
    await p.sync();
    p.done({ ok, shown });`);
  assert.deepEqual(r, { ok: true, shown: [] });
  assert.deepEqual(q(`SELECT items FROM diary WHERE user_id = ? AND date = ?`, O.id, D), []);
});

test('a switch waits for a pull still running, and a pull never writes into a copy that changed hands', async (t) => {
  if (skip(t)) return;
  const pia = await account('pia', A), quin = await account('quin', A);
  const P = (await http(pia, 'GET', '/api/auth/me')).user, Q = (await http(quin, 'GET', '/api/auth/me')).user;
  // A long history, so the pull is still writing when Quin signs in.
  await http(pia, 'POST', '/api/data/import', { foodList: Array.from({ length: 3000 }, (_, i) => ({ name: `Pia Food ${i}`, nutrition: {} })) });
  const r = await phoneAsync('rv5', pia, `
    const la = await import(p.src + 'lib/local-account.js');
    const db = await p.dbn.getDb();
    const count = async () => (await db.query('SELECT COUNT(*) AS n FROM foods', [])).values[0].n;
    await la.prepareLocalAccount(${JSON.stringify(P)}, { confirm: async () => true });
    const pulling = p.fullSync(true, true);
    while ((await count()) === 0) await p.sleep(5);
    const atSwitch = await count();
    process.env.NT_TOKEN = ${JSON.stringify(quin)};
    await la.prepareLocalAccount(${JSON.stringify(Q)}, { confirm: async () => true });
    await pulling;
    const quinsCopy = await count();
    // The pull's own check: the tag changes hands while it's writing.
    process.env.NT_TOKEN = ${JSON.stringify(pia)};
    const tag = JSON.parse(await p.dbn.dbGetSyncMeta('account'));
    await p.dbn.dbSetSyncMeta('account', JSON.stringify({ ...tag, u: ${P.id}, c: null }));
    const second = p.fullSync(true, true);
    while ((await count()) === 0) await p.sleep(5);
    await p.dbn.dbSetSyncMeta('account', JSON.stringify({ ...tag, u: ${Q.id} }));
    await second;
    p.done({ atSwitch, quinsCopy, stoppedAt: await count(), cursor: await p.dbn.dbGetSyncMeta('last_sync_at') });`);
  assert.ok(r.atSwitch < 3000, 'the switch came while the pull was writing');
  assert.equal(r.quinsCopy, 0, "nothing of Pia's in Quin's copy");
  assert.ok(r.stoppedAt < 3000, `the pull stopped (${r.stoppedAt} of 3000)`);
  assert.equal(r.cursor, null, 'the cursor is not set for a copy that changed hands');
});

test('cold start with the same account and the server not answering: the app shows at once', async (t) => {
  if (skip(t)) return;
  const me = (await http(B, 'GET', '/api/auth/me')).user;
  // A server that takes the connection and never answers.
  const px = await proxy(() => ({ delayMs: 60_000 }));
  try {
    await phoneAsync('rv6', B, `
      const la = await import(p.src + 'lib/local-account.js');
      await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async () => true });
      p.done();`, { NT_SERVER: px.url.replace('127.0.0.1', 'localhost') });
    // The phone keeps the address it had; a fresh app start:
    const r = await phoneAsync('rv6', B, `
      const la = await import(p.src + 'lib/local-account.js');
      const { get } = await import('svelte/store');
      const t0 = Date.now();
      const ok = await la.ensureLocalAccount(${JSON.stringify(me)}, { confirm: async () => true });
      p.done({ ok, ms: Date.now() - t0, shown: la.accountReadyFor(get(la.accountGate), ${me.id}) });`, { NT_SERVER: px.url.replace('127.0.0.1', 'localhost') });
    assert.equal(r.ok, true);
    assert.equal(r.shown, true);
    assert.ok(r.ms < 1000, `${r.ms} ms`);
  } finally { await px.close(); }
});

test('the same user at the same address is the same account, even after a restore gave the server a new id', async (t) => {
  if (skip(t)) return;
  const me = (await http(B, 'GET', '/api/auth/me')).user;
  const r = phone('rv7b', B, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async () => true });
    await p.offline(async () => { await p.api.createFood({ name: 'Bob Restore Waiting', nutrition: {} }); });
    const tag = JSON.parse(await p.dbn.dbGetSyncMeta('account'));
    await p.dbn.dbSetSyncMeta('account', JSON.stringify({ ...tag, i: 'before-the-restore' }));
    let asked = null;
    const ok = await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async n => { asked = n; return false; } });
    p.done({ ok, asked, food: (await p.api.getFoods()).some(f => f.name === 'Bob Restore Waiting') });`);
  assert.deepEqual(r, { ok: true, asked: null, food: true });
});

test("an old completion change made offline doesn't undo a newer one made on the web", async (t) => {
  if (skip(t)) return;
  const D = '2026-07-06';
  await http(B, 'PUT', `/api/diary/${D}/completion`, { completed: true });
  phone('rv7a', B, `await p.sync(); p.done();`);
  phone('rv7a', B, `await p.offline(async () => { await p.api.setDiaryCompletion('${D}', false); }); p.done();`);
  await sleep(3000);
  await http(B, 'PUT', `/api/diary/${D}/completion`, { completed: false });
  await http(B, 'PUT', `/api/diary/${D}/completion`, { completed: true });
  const r = phone('rv7a', B, `await p.sync(); await p.sync(); p.done(!!(await p.api.getDiaryDate('${D}')).completed_at);`);
  assert.deepEqual(q(`SELECT completed_at IS NOT NULL AS c FROM diary WHERE user_id = (SELECT id FROM users WHERE username = 'bob') AND date = ?`, D), [{ c: 1 }]);
  assert.equal(r, true);
});

// ── Clock put right between an edit and its push ─────────────────────────

for (const [skewMs, label] of [[-5 * 60_000, 'slow'], [5 * 60_000, 'fast']]) {
  test(`a phone running ${label} whose clock is put right before it syncs: the edit keeps its real time`, async (t) => {
    if (skip(t)) return;
    const f = await http(A, 'POST', '/api/foods', { name: `Fixed ${label} 0` });
    const name = `fixed-${label}`;
    const off = { SKEW_MS: String(skewMs) };
    phone(name, A, `await p.sync(); p.done();`, off);
    if (label === 'slow') {
      // The web edits first; the phone edits after it (really), offline,
      // with its clock 5 minutes behind.
      await http(A, 'PUT', `/api/foods/${f.id}`, { name: 'Web (first)' });
      await sleep(3000);
      phone(name, A, `await p.offline(async () => { const x = await p.food(${f.id}); await p.api.updateFood(x.id, { ...x, name: 'Phone (later)' }); }); p.done();`, off);
    } else {
      // The phone edits first, offline, 5 minutes ahead; the web after it.
      phone(name, A, `await p.offline(async () => { const x = await p.food(${f.id}); await p.api.updateFood(x.id, { ...x, name: 'Phone (first)' }); }); p.done();`, off);
      await sleep(3000);
      await http(A, 'PUT', `/api/foods/${f.id}`, { name: 'Web (later)' });
    }
    await sleep(1500);
    // The phone's clock is right again when it syncs.
    const r = phone(name, A, `await p.sync(); await p.sync(); p.done((await p.food(${f.id})).name);`);
    const want = label === 'slow' ? 'Phone (later)' : 'Web (later)';
    assert.equal(q('SELECT name FROM foods WHERE id = ?', f.id)[0].name, want);
    assert.equal(r, want);
  });
}

test("another account never sees or saves the last one's settings, waiting changes or editor drafts", async (t) => {
  if (skip(t)) return;
  const rae = await account('rae', A), sam = await account('sam', A);
  const R = (await http(rae, 'GET', '/api/auth/me')).user, S = (await http(sam, 'GET', '/api/auth/me')).user;
  const r = phone('settings-scope', rae, `
    const la = await import(p.src + 'lib/local-account.js');
    const { get } = await import('svelte/store');
    localStorage.setItem('wl:userId', '${R.id}');
    const st = await import(p.src + 'stores/settings.js');
    const ed = await import(p.src + 'lib/editor-draft.js');
    const es = await import(p.src + 'stores/editorState.js');
    await la.prepareLocalAccount(${JSON.stringify(R)}, { confirm: async () => true });
    // Rae sets goals and meal names, starts typing a new food, and the
    // goal change is still waiting to be sent when she signs out.
    st.goals.set({ calories: { min: 1111 } });
    st.mealNames.set(['Rae Breakfast', 'Rae Lunch']);
    ed.saveDraft(ed.draftKey('food', null), { name: 'Rae secret draft' });
    es.editorState.foodPrefill = { name: 'Rae prefill' };
    // Sam signs in on the same phone at once.
    process.env.NT_TOKEN = ${JSON.stringify(sam)};
    localStorage.setItem('wl:userId', '${S.id}');
    await la.prepareLocalAccount(${JSON.stringify(S)}, { confirm: async () => true });
    const seen = { goals: get(st.goals), meals: get(st.mealNames), draft: ed.loadDraft(ed.draftKey('food', null)), prefill: es.editorState.foodPrefill };
    // Sam changes one setting of his own; Rae's other values stay hers.
    st.energyUnit.set('kJ');
    await p.sleep(1500);
    localStorage.setItem('wl:userId', '${R.id}');
    st.reloadSettingStores?.();
    p.done({ seen, raeAgain: get(st.goals), raeDraft: ed.loadDraft(ed.draftKey('food', null)) });`);
  assert.deepEqual(r.seen.goals, {}, "Sam doesn't see Rae's goals");
  assert.deepEqual(r.seen.meals, ['Breakfast', 'Lunch', 'Dinner', 'Snacks']);
  assert.equal(r.seen.draft, null, "nor her draft");
  assert.equal(r.seen.prefill, null);
  assert.deepEqual(r.raeAgain, { calories: { min: 1111 } }, 'Rae keeps hers on this phone');
  assert.deepEqual(r.raeDraft, { name: 'Rae secret draft' }, 'and gets her draft back');
  const samSettings = Object.fromEntries(q(`SELECT key, value FROM user_settings WHERE user_id = ?`, S.id).map(x => [x.key, x.value]));
  assert.equal(samSettings.goals, undefined, "Rae's waiting goal change never reached Sam's server");
  assert.equal(samSettings.mealNames, undefined);
  assert.equal(samSettings.energyUnit, '"kJ"', "Sam's own change does");
});

// ── Fifth review ──────────────────────────────────────────────────────────

// The server before sync_version 2: its status names no instance or sync
// version (a proxy takes them out; that server cleared a note on a save
// without one, which scripts/android-sync-server.test.js covers).
const asOldServer = req => (req.url.startsWith('/api/auth/status')
  ? { rewrite: t => { const j = JSON.parse(t); delete j.instance_id; delete j.sync_version; return JSON.stringify(j); } }
  : null);

test('against a server before sync_version 2, the phone sends its note with every save and push, as before', async (t) => {
  if (skip(t)) return;
  const tia = await account('tia', A);
  const D = '2026-06-01';
  const px = await proxy(asOldServer);
  try {
    await phoneAsync('oldsrv', tia, `
      await p.sync();
      await p.api.saveDiaryDate('${D}', { items: [], body_stats: {}, water: [], notes: 'Tia note' });
      await p.sleep(800); await p.sync();
      // A later save that doesn't touch the note, online and by push.
      const d = await p.api.getDiaryDate('${D}');
      await p.api.saveDiaryDate('${D}', { ...d, items: [{ uuid: 'o1', name: 'Egg', nutrition: {}, portion: 1, unit: 'g', quantity: 1, meal: 0 }] });
      await p.sleep(800); await p.sync();
      p.done();`, { NT_SERVER: px.url });
    const puts = px.seen.filter(x => x.method === 'PUT' && x.path === `/api/diary/${D}`).map(x => JSON.parse(x.body));
    const pushes = px.seen.filter(x => x.path === '/api/sync/push').map(x => JSON.parse(x.body)).flatMap(b => b.diary || []).filter(d => d.date === D);
    assert.ok(puts.length >= 2 && puts.every(b => b.notes === 'Tia note'), 'every save carries the note');
    assert.ok(pushes.length >= 1 && pushes.every(d => d.notes === 'Tia note'), 'every push carries the note');
  } finally { await px.close(); }
  // The current server: the untouched note stays out.
  const px2 = await proxy(() => null);
  try {
    await phoneAsync('newsrv', tia, `
      await p.sync();
      const d = await p.api.getDiaryDate('${D}');
      await p.api.saveDiaryDate('${D}', { ...d, items: [...d.items, { uuid: 'o2', name: 'Toast', nutrition: {}, portion: 1, unit: 'g', quantity: 1, meal: 0 }] });
      await p.sleep(800);
      p.done();`, { NT_SERVER: px2.url });
    const put = px2.seen.filter(x => x.method === 'PUT' && x.path === `/api/diary/${D}`).map(x => JSON.parse(x.body));
    assert.ok(put.length && put.every(b => !('notes' in b)));
  } finally { await px2.close(); }
  assert.equal(q(`SELECT notes FROM diary WHERE user_id = (SELECT id FROM users WHERE username = 'tia') AND date = ?`, D)[0].notes, 'Tia note');
});

test('a switch during a long pull writes nothing of the previous account, however long it takes', async (t) => {
  if (skip(t)) return;
  const uma = await account('uma', A), vic = await account('vic', A);
  const U = (await http(uma, 'GET', '/api/auth/me')).user, V = (await http(vic, 'GET', '/api/auth/me')).user;
  await http(uma, 'POST', '/api/data/import', { foodList: Array.from({ length: 25000 }, (_, i) => ({ name: `Uma Food ${i}`, nutrition: {} })) });
  const r = await phoneAsync('rv5gen', uma, `
    const la = await import(p.src + 'lib/local-account.js');
    const db = await p.dbn.getDb();
    const count = async () => (await db.query('SELECT COUNT(*) AS n FROM foods', [])).values[0].n;
    await la.prepareLocalAccount(${JSON.stringify(U)}, { confirm: async () => true });
    const pulling = p.fullSync(true, true);
    while ((await count()) < 100) await p.sleep(20);
    process.env.NT_TOKEN = ${JSON.stringify(vic)};
    const t0 = Date.now();
    await la.prepareLocalAccount(${JSON.stringify(V)}, { confirm: async () => true });
    const switchMs = Date.now() - t0;
    await pulling;
    await p.sleep(1000);
    p.done({ switchMs, vicsCopy: await count(), cursor: await p.dbn.dbGetSyncMeta('last_sync_at') });`, { BRIDGE_DELAY_MS: '2' });
  assert.equal(r.vicsCopy, 0, "not one of Uma's foods in Vic's copy");
  assert.equal(r.cursor, null);
  assert.ok(r.switchMs < 15000, `the switch waited ${r.switchMs} ms`);
});

test('an offline note edited before the update still goes up after it', async (t) => {
  if (skip(t)) return;
  const D = '2026-06-02';
  phone('upgrade', A, `
    await p.sync();
    const db = await p.dbn.getDb();
    // The app before: a day edited offline, its note in it, no note tracking.
    await db.execute("ALTER TABLE diary DROP COLUMN notes_dirty");
    await db.execute("ALTER TABLE diary DROP COLUMN notes_updated_at");
    await db.run("INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at, sync_status) VALUES (1, ?, '[]', '{}', '[]', 'Offline before the update', ?, 'pending')", ['${D}', new Date().toISOString()]);
    p.done();`);
  phone('upgrade', A, `await p.sync(); p.done();`);
  assert.equal(q(`SELECT notes FROM diary WHERE user_id = (SELECT id FROM users WHERE username = 'alice') AND date = ?`, D)[0]?.notes, 'Offline before the update');
});

test("Upload sent twice, or a push whose answer was lost, makes each row once", async (t) => {
  if (skip(t)) return;
  const wes = await account('wes', A);
  const W = (await http(wes, 'GET', '/api/auth/me')).user;
  phone('dedupe', '', `
    const la = await import(p.src + 'lib/local-account.js');
    await la.setLocalOwner();
    await p.dbn.dbCreateFood({ name: 'Wes Food', nutrition: {} });
    await p.dbn.dbCreateMeal({ name: 'Wes Recipe', items: [], is_recipe: 1 });
    await p.dbn.dbCreateActivity({ date: '2026-06-03', name: 'Wes Run', kcal: 100, duration_min: 10 });
    await p.dbn.dbStartFast({ goal_hours: 16 });
    p.done();`, { NT_SERVER: '' });
  phone('dedupe', wes, `
    const { uploadLocalToServer } = await import(p.src + 'lib/migrate.js');
    await uploadLocalToServer({ serverUrl: process.env.NT_SERVER, authToken: process.env.NT_TOKEN });
    await uploadLocalToServer({ serverUrl: process.env.NT_SERVER, authToken: process.env.NT_TOKEN });
    p.done();`);
  const n = sql => q(sql, W.id)[0].n;
  assert.deepEqual({
    foods: n(`SELECT COUNT(*) AS n FROM foods WHERE user_id = ?`), meals: n(`SELECT COUNT(*) AS n FROM meals WHERE user_id = ?`),
    activity: n(`SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ?`), fasts: n(`SELECT COUNT(*) AS n FROM fasts WHERE user_id = ?`),
  }, { foods: 1, meals: 1, activity: 1, fasts: 1 });
  // A push whose answer never arrives: the next one sends the same rows.
  let drop = 1;
  const px = await proxy(req => (req.url === '/api/sync/push' && drop-- > 0 ? { dropReply: true } : null));
  try {
    await phoneAsync('lostreply', wes, `
      await p.sync();
      await p.offline(async () => { await p.api.createFood({ name: 'Wes Lost Answer', nutrition: {} }); });
      await p.fullSync(true, true).catch(() => {});
      await p.sync();
      p.done();`, { NT_SERVER: px.url });
  } finally { await px.close(); }
  assert.equal(q(`SELECT COUNT(*) AS n FROM foods WHERE name = 'Wes Lost Answer'`)[0].n, 1);
});

test('the same user id on a server rebuilt with a fresh database is another account; a restore is not', async (t) => {
  if (skip(t)) return;
  const me = (await http(B, 'GET', '/api/auth/me')).user;
  const r = phone('rebuilt', B, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async () => true });
    await p.offline(async () => { await p.api.createFood({ name: 'Bob Before Rebuild', nutrition: {} }); });
    const tag = JSON.parse(await p.dbn.dbGetSyncMeta('account'));
    // Restored: same account, made at the same time.
    let asked = null;
    const sameOk = await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async n => { asked = n; return false; } });
    // Rebuilt: the account with this id was made at another time.
    await p.dbn.dbSetSyncMeta('account', JSON.stringify({ ...tag, c: '2001-01-01 00:00:00' }));
    let asked2 = null;
    const rebuiltOk = await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async n => { asked2 = n; return false; } });
    p.done({ sameOk, asked, rebuiltOk, asked2, c: tag.c });`);
  assert.equal(r.c, me.created_at, 'the tag keeps when the account was made');
  assert.deepEqual({ sameOk: r.sameOk, asked: r.asked }, { sameOk: true, asked: null });
  assert.deepEqual({ rebuiltOk: r.rebuiltOk, asked2: r.asked2 > 0 }, { rebuiltOk: false, asked2: true });
});

test("another address that can't name itself: the person is asked, and nothing goes up unless they say it's the same server", async (t) => {
  if (skip(t)) return;
  const me = (await http(B, 'GET', '/api/auth/me')).user;
  phone('ambig', B, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(me)}, { confirm: async () => true });
    await p.sync();
    await p.offline(async () => { await p.api.createFood({ name: 'Bob Server A Only', nutrition: {} }); });
    p.done();`);
  // Server "B": another address, too old to name itself, the same user id.
  const px = await proxy(asOldServer);
  try {
    const no = await phoneAsync('ambig', B, `
      const la = await import(p.src + 'lib/local-account.js');
      let askedSame = 0, askedDiscard = null;
      const ok = await la.prepareLocalAccount(${JSON.stringify(me)}, {
        sameServer: async () => { askedSame++; return false; },
        confirm: async n => { askedDiscard = n; return false; },
      });
      const r = await p.fullSync(true, true);
      p.done({ ok, askedSame, askedDiscard, sync: r.reason || 'ok' });`, { NT_SERVER: px.url.replace('127.0.0.1', 'localhost') });
    assert.deepEqual(no, { ok: false, askedSame: 1, askedDiscard: 1, sync: 'other_account' });
    assert.deepEqual(q(`SELECT 1 FROM foods WHERE name = 'Bob Server A Only'`), [], 'nothing went up');
    assert.equal(px.seen.filter(x => x.path === '/api/sync/push').length, 0);
    const yes = await phoneAsync('ambig', B, `
      const la = await import(p.src + 'lib/local-account.js');
      let askedSame = 0;
      const ok = await la.prepareLocalAccount(${JSON.stringify(me)}, { sameServer: async () => { askedSame++; return true; }, confirm: async () => false });
      await p.sync();
      p.done({ ok, askedSame });`, { NT_SERVER: px.url.replace('127.0.0.1', 'localhost') });
    assert.deepEqual(yes, { ok: true, askedSame: 1 });
    assert.deepEqual(q(`SELECT u.username FROM foods f JOIN users u ON u.id = f.user_id WHERE f.name = 'Bob Server A Only'`), [{ username: 'bob' }], 'said the same server: it goes up');
  } finally { await px.close(); }
});

// ── The Android SQLite plugin runs one statement per ";\n"-ended piece ───

test("after another account signs in, the phone's database holds nothing of the last one, the diary included", async (t) => {
  if (skip(t)) return;
  const xia = await account('xia', A), yan = await account('yan', A);
  const X = (await http(xia, 'GET', '/api/auth/me')).user, Y = (await http(yan, 'GET', '/api/auth/me')).user;
  const D = '2026-05-01';
  await http(xia, 'PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [], notes: 'Xia server note' });
  await http(xia, 'POST', '/api/foods', { name: 'Xia Food' });
  const r = phone('dbclear', xia, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(X)}, { confirm: async () => true });
    await p.sync();
    const db = await p.dbn.getDb();
    const rows = async () => {
      const out = {};
      for (const t of ['foods', 'meals', 'diary', 'diary_tombstones', 'activity_log', 'fasts', 'wellness_data', 'workouts', 'user_settings']) out[t] = (await db.query('SELECT COUNT(*) AS n FROM ' + t, [])).values[0].n;
      return out;
    };
    const before = await rows();
    process.env.NT_TOKEN = ${JSON.stringify(yan)};
    await la.prepareLocalAccount(${JSON.stringify(Y)}, { confirm: async () => true });
    const after = await rows();
    await p.sync();
    p.done({ before, after, note: (await p.api.getDiaryDate('${D}')).notes || '', diaryRows: (await db.query('SELECT notes FROM diary', [])).values });`);
  assert.ok(r.before.diary >= 1 && r.before.foods >= 1, 'Xia had a day and a food here');
  assert.deepEqual(Object.values(r.after).every(n => n === 0), true, JSON.stringify(r.after));
  assert.equal(r.note, '');
  assert.deepEqual(r.diaryRows, []);
});
