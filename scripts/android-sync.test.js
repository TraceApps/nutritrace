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
import { mkdtempSync, rmSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
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

// Every request this test sends the server goes through here. fetch keeps
// connections alive, and the server closes one after 5 s idle; a phone run
// blocks this process for longer than that, so the next request can go out
// on a connection the server has already closed and fails at once with
// "fetch failed" (undici UND_ERR_SOCKET "other side closed"). The server
// never saw that request, so it is sent again on a fresh connection.
const STALE_SOCKET = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);
async function serverFetch(url, init) {
  try { return await fetch(url, init); } catch (e) {
    if (e?.message !== 'fetch failed' || !STALE_SOCKET.has(e?.cause?.code)) throw e;
    return fetch(url, init);
  }
}

async function http(tok, method, path, body) {
  const r = await serverFetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
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

// Settings come down from the server (stores/settings.js
// loadServerSettings) into the screen and the phone's copy. A setting
// changed on the phone and not sent yet is the newer one: it stays, and
// goes up on the next push.
test('a setting changed on the phone and not sent yet survives settings coming down from the server, then goes up', async (t) => {
  if (skip(t)) return;
  const kit = await account('kit', A);
  const K = (await http(kit, 'GET', '/api/auth/me')).user;
  await http(kit, 'PUT', '/api/settings', { key: 'waterGoalMl', value: 1800 });
  const r = phone('mirror-pending', kit, `
    const la = await import(p.src + 'lib/local-account.js');
    localStorage.setItem('nt:nativeMode', 'server');
    localStorage.setItem('wl:userId', '${K.id}');
    await la.ensureLocalAccount(${JSON.stringify(K)}, { confirm: async () => true });
    await p.sync();
    // Changed on the phone while offline (its push still waiting): the
    // screen's value and the copy's row, as the settings store leaves them.
    const { DB } = await import(p.src + 'lib/db.js');
    localStorage.setItem(DB._settingKey('waterGoalMl'), JSON.stringify(2500));
    await p.dbn.dbUpsertSetting('waterGoalMl', 2500);
    const { loadServerSettings } = await import(p.src + 'stores/settings.js');
    await loadServerSettings();
    await p.sleep(800);
    const db = await p.dbn.getDb();
    const row = async () => (await db.query("SELECT value, sync_status FROM user_settings WHERE key = 'waterGoalMl'", [])).values[0];
    const afterMirror = { row: await row(), shown: DB.getSetting('waterGoalMl', null) };
    await p.sync();
    p.done({ afterMirror, afterPush: await row() });`);
  assert.deepEqual(r, { afterMirror: { row: { value: '2500', sync_status: 'pending' }, shown: 2500 }, afterPush: { value: '2500', sync_status: 'synced' } });
  assert.deepEqual(q(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'waterGoalMl'`, K.id), [{ value: '2500' }]);
});

// Settings coming down for one account can still be writing when another
// signs in: none of them may land in the new account's copy.
test("settings still coming down for the last account write nothing into the next account's copy", async (t) => {
  if (skip(t)) return;
  const lux = await account('lux', A), mae = await account('mae', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const L = await me(lux), M = await me(mae);
  const keys = ['waterGoalMl', 'weightUnit', 'heightUnit', 'lengthUnit', 'distUnit', 'tempUnit', 'dateFormat', 'timeFormat',
    'statsChartType', 'foodsSort', 'mealsSort', 'recipesSort', 'energyUnit', 'waterUnit', 'offSearchLanguage', 'offSearchCountry'];
  for (const k of keys) await http(lux, 'PUT', '/api/settings', { key: k, value: 'lux-' + k });
  const r = phone('mirror-switch', lux, `
    const la = await import(p.src + 'lib/local-account.js');
    const platform = await import(p.src + 'lib/platform.js');
    localStorage.setItem('nt:nativeMode', 'server');
    localStorage.setItem('wl:userId', '${L.id}');
    await la.ensureLocalAccount(${JSON.stringify(L)}, { confirm: async () => true });
    await p.sync();
    const db = await p.dbn.getDb();
    await db.execute('DELETE FROM user_settings');
    // Lux's settings start coming down (each write a slow trip) ...
    const { loadServerSettings } = await import(p.src + 'stores/settings.js');
    process.env.BRIDGE_DELAY_MS = '40';
    await loadServerSettings();
    await p.sleep(150);
    // ... and Mae signs in meanwhile.
    platform.setAuthToken(${JSON.stringify(mae)});
    localStorage.setItem('wl:userId', '${M.id}');
    const ok = await la.ensureLocalAccount(${JSON.stringify(M)}, { confirm: async () => true });
    await p.sleep(2500);
    delete process.env.BRIDGE_DELAY_MS;
    const left = (await db.query("SELECT key, value FROM user_settings WHERE value LIKE '%lux-%'", [])).values;
    p.done({ ok, left });`);
  assert.deepEqual(r, { ok: true, left: [] });
});

async function account(name, admin) {
  const r = await serverFetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${admin}` } : {}) }, body: JSON.stringify({ username: name, password: 'Str0ng-Pass-77!x' }) });
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
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test',
      PUBLIC_API_ENABLED: '1', PUBLIC_API_WRITE_ENABLED: '1' },
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

// #277 (@Chrristin): items logged through MCP or the API carry only the
// food's server id (food_server_id) and no photo; the phone fills the photo
// in from its own copy of the food. It looked the server id up as one of
// its own ids, and compared the item's name trimmed with the food's name as
// stored, so once a reinstall renumbered the phone's ids a food saved as
// "Slim Milk " lost its photo, and an id that is another food's on the
// phone showed that food's photo.
test('#277: after a reinstall the phone shows the photo of the food or recipe an item came from', async (t) => {
  if (skip(t)) return;
  const D = '2026-09-27';
  const { raw: key } = await http(A, 'POST', '/api/admin/api-tokens', { name: 'nt-277', scopes: ['mcp:read', 'mcp:write'] });
  // Another account's first, so Alice's server ids run ahead of the phone's.
  for (let i = 0; i < 10; i++) {
    await http(B, 'POST', '/api/foods', { name: `Bob Filler 277 ${i}`, visibility: 'private' });
    await http(B, 'POST', '/api/meals', { name: `Bob Recipe 277 ${i}`, is_recipe: 1, items: [], visibility: 'private' });
  }
  const milk = await http(A, 'POST', '/api/foods', { name: 'Slim Milk 277 ', img_url: '/uploads/milk-277.jpg', nutrition: { calories: 35 } });
  const banana = await http(A, 'POST', '/api/foods', { name: 'Banana 277', img_url: '/uploads/banana-277.jpg', nutrition: { calories: 90 } });
  const oats = await http(A, 'POST', '/api/meals', { name: 'Overnight Oats 277 ', is_recipe: 1, items: [], img_url: '/uploads/oats-277.jpg' });
  // The reinstall: a new phone, with foods and a recipe of its own before
  // the account's come down, so its ids are not the server's.
  const first = phone('reinstall277', A, `
    await p.offline(async () => {
      await p.api.createFood({ name: 'Phone Only 277', nutrition: {} });
      await p.api.createMeal({ name: 'Phone Recipe 277', is_recipe: 1, items: [] });
    });
    await p.sync();
    // More of its own until the next new food's phone id is Banana's server
    // id, and the next recipe's is the recipe's.
    let f; do { f = await p.api.createFood({ name: 'Filler 277', nutrition: {} }); } while (f.id < ${banana.id} - 1);
    let m; do { m = await p.api.createMeal({ name: 'Filler Recipe 277', is_recipe: 1, items: [] }); } while (m.id < ${oats.id} - 1);
    await p.sync();
    const food = await p.food(${milk.id});
    p.done({ milkPhoneId: food.id, food: f.id, meal: m.id });`);
  assert.notEqual(first.milkPhoneId, milk.id, "the phone's ids are not the server's");
  assert.equal(first.food, banana.id - 1);
  assert.equal(first.meal, oats.id - 1);
  // Others of the same name, with another photo, that will take those ids.
  const other = await http(A, 'POST', '/api/foods', { name: 'Banana 277', img_url: '/uploads/other-banana-277.jpg', nutrition: { calories: 90 } });
  const otherOats = await http(A, 'POST', '/api/meals', { name: 'Overnight Oats 277 ', is_recipe: 1, items: [], img_url: '/uploads/other-oats-277.jpg' });
  // Logged in the browser (id and food_server_id both the server's) ...
  const web = (id, name, extra = {}) => ({ uuid: `web-${id}-277`, id, food_server_id: id, name, meal: 0, quantity: 1, nutrition: {}, imgUrl: '', ...extra });
  await http(A, 'PUT', `/api/diary/${D}`, { items: [web(banana.id, 'Banana 277'), web(oats.id, 'Overnight Oats 277 ', { is_recipe: 1 })], body_stats: {}, water: [] });
  // ... and through the API, as MCP does: food_server_id only, no photo.
  for (const food of [milk, banana]) {
    const r = await serverFetch(`${base}/api/v1/diary/${D}/food`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ food_id: food.id }) });
    assert.equal(r.status, 200, await r.text());
  }
  // A meal saved in the browser (its foods by their server ids in `id`),
  // logged through the API too.
  const breakfast = await http(A, 'POST', '/api/meals', { name: 'Banana Breakfast 277', items: [{ id: banana.id, name: 'Banana 277', quantity: 1, nutrition: { calories: 90 } }] });
  const lm = await serverFetch(`${base}/api/v1/diary/${D}/meal`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ meal_id: breakfast.id }) });
  assert.equal(lm.status, 200, await lm.text());
  const r = phone('reinstall277', A, `
    await p.sync();
    // Logged here, then again from Yesterday's Meals (the diary item itself).
    const { addDiaryItem } = await import(p.src + 'stores/diary.js');
    await addDiaryItem(await p.food(${banana.id}), 0, '2026-09-25');
    const logged = (await p.api.getDiaryDate('2026-09-25')).items[0];
    await addDiaryItem(logged, 0, '2026-09-26');
    const again = (await p.api.getDiaryDate('2026-09-26')).items[0];
    const clash = { food: (await p.api.getFoods()).find(x => x.id === ${banana.id})?.server_id ?? null,
      meal: (await p.api.getRecipes()).find(x => x.id === ${oats.id})?.server_id ?? null };
    const items = (await p.api.getDiaryDate('${D}')).items;
    p.done({ clash, items: items.map(i => [i.name, i.source || 'web', i.imgUrl]),
      relog: [logged.food_server_id, again.food_server_id, logged.imgUrl, again.imgUrl] });`);
  assert.deepEqual(r.clash, { food: other.id, meal: otherOats.id }, "the server ids of Banana and the recipe are the other ones' phone ids");
  const want = [
    ['Banana 277', 'web', '/uploads/banana-277.jpg'],
    ['Overnight Oats 277 ', 'web', '/uploads/oats-277.jpg'],
    ['Slim Milk 277 ', 'mcp', '/uploads/milk-277.jpg'],
    ['Banana 277', 'mcp', '/uploads/banana-277.jpg'],
    ['Banana 277', 'mcp:meal', '/uploads/banana-277.jpg'],
  ];
  assert.deepEqual(r.items, want, 'the phone');
  assert.deepEqual(r.relog, [banana.id, banana.id, '/uploads/banana-277.jpg', '/uploads/banana-277.jpg'], "logged again, it keeps its food's server id");
  const browser = await http(A, 'GET', `/api/diary/${D}`);
  assert.deepEqual(browser.items.map(i => [i.name, i.source || 'web', i.imgUrl]), want, 'the browser, the same');
});

// #277, each way an item names its row, on the phone's own database:
// server ids and the phone's ids swapped between two foods (and two
// recipes) of the same name, items logged before their food went up, and
// names stored with spaces around them.
test("#277: a diary item's photo comes from its own row, by the right kind of id, and names match trimmed", async (t) => {
  if (skip(t)) return;
  const r = phone('img277', A, `
    const db = await p.dbn.getDb();
    const me = await p.dbn.dbInstallId();
    const row = (t, id, sid, name, img, recipe) => db.run(
      'INSERT INTO ' + t + ' (id, server_id, name, img_url' + (t === 'meals' ? ', is_recipe' : '') + ') VALUES (?, ?, ?, ?' + (t === 'meals' ? ', ?' : '') + ')',
      t === 'meals' ? [id, sid, name, img, recipe ? 1 : 0] : [id, sid, name, img]);
    await row('foods', 7, 12, 'Banana', '/x.jpg');
    await row('foods', 12, 7, 'Banana', '/y.jpg');
    await row('foods', 20, null, 'Banana', '/z.jpg');
    await row('foods', 21, 7000, '  Oat Milk\\t', '/oat.jpg');
    await row('foods', 30, 30, 'Overnight Oats', '/food-oats.jpg');
    await row('meals', 3, 9, 'Overnight Oats ', '/r1.jpg', true);
    await row('meals', 9, 3, 'Overnight Oats ', '/r2.jpg', true);
    const items = [
      { id: 7, food_server_id: 7, name: 'Banana' },                       // logged in the browser: server id 7
      { food_server_id: 12, name: 'Banana' },                              // MCP / API: server id 12
      { id: 20, food_server_id: null, food_device: me, name: 'Banana' },   // logged here before it went up
      { id: 7, food_server_id: null, food_device: 'another-phone', name: 'Banana' }, // another phone's id
      { name: 'Banana' },                                                  // no id at all
      { id: 12, name: 'Banana' },                                          // from before food_server_id: this phone's id
      { food_server_id: 99999, name: 'oat MILK' },                         // its food is gone: by name, trimmed
      { id: 9, food_server_id: 9, is_recipe: 1, name: 'Overnight Oats' },  // recipe, server id 9
      { food_server_id: 3, is_recipe: 1, name: 'Overnight Oats ' },        // recipe, server id 3
      { is_recipe: 1, name: 'overnight oats' },                            // recipe by name only
      { food_server_id: 30, name: 'Overnight Oats' },                      // the food of that name
    ];
    await p.dbn.dbSaveDiaryDate('2026-09-28', { items });
    p.done((await p.dbn.dbGetDiaryDate('2026-09-28')).items.map(i => i.imgUrl));`);
  assert.deepEqual(r, [
    '/y.jpg', '/x.jpg', '/z.jpg',
    r[4], // another phone's id names nothing here: the name decides, as with no id
    r[4], '/y.jpg', '/oat.jpg',
    '/r1.jpg', '/r2.jpg', '/r1.jpg', '/food-oats.jpg',
  ]);
  assert.notEqual(r[3], '/x.jpg', "not the food that has that id on this phone");
});

// #277 follow-up: Connect > Upload (or Merge) sends the phone's foods,
// meals and recipes up as new rows, with new server ids. Diary items kept
// the server ids they had before (from the server the phone used to be
// connected to), so on the new server, and on the phone once its copy
// came back, they named no row or another one: no units, barcode or
// photo of their own. They follow their source now, the upload sent
// again or not, a row or a day that failed to go up included; an item
// whose source isn't one of the phone's rows stays as it was.
test('#277: after Connect > Upload diary items name their food and recipe by its new server id', async (t) => {
  if (skip(t)) return;
  const pia = await account('relinkpia', A), quinn = await account('relinkquinn', A);
  const P = (await http(pia, 'GET', '/api/auth/me')).user, Q = (await http(quinn, 'GET', '/api/auth/me')).user;
  const DW = '2026-06-19', D = '2026-06-20', D2 = '2026-06-21';
  const food = (name, extra = {}) => http(pia, 'POST', '/api/foods', { name, nutrition: { calories: 50 }, visibility: 'private', ...extra });
  const milk = await food('Relink Milk', { barcode: 'BC-RL-MILK', alt_units: [{ abbr: 'glass', grams: 250 }], img_url: '/uploads/rl-milk.jpg' });
  // Three of one name: by name alone neither the oldest nor the newest is
  // the middle one.
  const pears = [];
  for (const n of [1, 2, 3]) pears.push(await food('Relink Pear', { barcode: `BC-RL-PEAR${n}`, img_url: `/uploads/rl-pear-${n}.jpg` }));
  const oats = await http(pia, 'POST', '/api/meals', { name: 'Relink Oats', is_recipe: 1, items: [], img_url: '/uploads/rl-oats.jpg', visibility: 'private' });
  // Logged in the browser: id and food_server_id both Pia's server ids.
  const web = (f, extra = {}) => ({ uuid: `rl-web-${f.name}`, id: f.id, food_server_id: f.id, name: f.name, meal: 0, quantity: 1, nutrition: {}, ...extra });
  await http(pia, 'PUT', `/api/diary/${DW}`, { items: [web(milk), web(oats, { is_recipe: 1 }),
    // Its food isn't one of the phone's: it stays as it is.
    { uuid: 'rl-elsewhere', food_server_id: 987654, name: 'Elsewhere', meal: 0, quantity: 1, nutrition: {} }], body_stats: {}, water: [] });
  phone('relink', pia, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(P)}, { confirm: async () => true });
    await p.sync();
    const { addDiaryItem } = await import(p.src + 'stores/diary.js');
    await addDiaryItem(await p.food(${pears[1].id}), 1, '${D}');
    await addDiaryItem(await p.food(${milk.id}), 0, '${D2}');
    await addDiaryItem((await p.api.getRecipes()).find(r => r.server_id === ${oats.id}), 0, '${D2}');
    await p.sync();
    p.done();`);
  // Settings > Disconnect, then a food made and logged with no server.
  // Saving the day keeps only what names each item's food (diary.js
  // _toReferenceShape): units and barcode come from the food on reading.
  phone('relink', '', `
    const la = await import(p.src + 'lib/local-account.js');
    await la.setLocalOwner();
    const f = await p.dbn.dbCreateFood({ name: 'Relink Local', nutrition: {}, barcode: 'BC-RL-LOCAL' });
    const { addDiaryItem } = await import(p.src + 'stores/diary.js');
    await addDiaryItem(await p.dbn.dbGetFood(f.id), 2, '${DW}');
    p.done();`, { NT_SERVER: '' });
  // Connect as Quinn and choose Upload, twice (a retry): the recipe fails
  // both times, so it goes up only with the sync, after the days that name
  // it; the third day fails once and stays on the phone for the sync.
  let refuseMeal = 2, refuseDay = 1;
  const px = await proxy(req => {
    if (req.method === 'POST' && req.url === '/api/meals' && refuseMeal-- > 0) return { status: 500 };
    if (req.method === 'PUT' && req.url === `/api/diary/${D2}` && refuseDay-- > 0) return { status: 500 };
    return null;
  });
  let up;
  try {
    up = await phoneAsync('relink', quinn, `
      const la = await import(p.src + 'lib/local-account.js');
      const { uploadLocalToServer } = await import(p.src + 'lib/migrate.js');
      const first = await uploadLocalToServer({ serverUrl: process.env.NT_SERVER, authToken: process.env.NT_TOKEN });
      const summary = await uploadLocalToServer({ serverUrl: process.env.NT_SERVER, authToken: process.env.NT_TOKEN });
      await la.claimForServer(process.env.NT_SERVER, ${Q.id}, { uploaded: summary.uploaded });
      p.done({ errors: first.errors.map(e => e.stage), retried: summary.errors.map(e => e.stage) });`, { NT_SERVER: px.url });
  } finally { await px.close(); }
  assert.deepEqual(up.errors.sort(), ['diary', 'recipes']);
  assert.deepEqual(up.retried, ['recipes'], 'sent again, the recipe still fails');
  const r = phone('relink', quinn, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(Q)}, { confirm: async () => true });
    await p.sync(); await p.sync();
    const day = async d => (await p.api.getDiaryDate(d)).items.map(i => [i.name, i.food_server_id ?? null, i.barcode || null, i.alt_units?.[0]?.abbr || null, i.imgUrl || null]);
    p.done({ dw: await day('${DW}'), d: await day('${D}'), d2: await day('${D2}') });`);
  const id = img => q(`SELECT id FROM foods WHERE user_id = ? AND img_url = ? AND deleted_at IS NULL`, Q.id, img).map(x => x.id);
  const [qMilk] = id('/uploads/rl-milk.jpg'), [qPear2] = id('/uploads/rl-pear-2.jpg');
  const [qLocal] = q(`SELECT id FROM foods WHERE user_id = ? AND name = 'Relink Local'`, Q.id).map(x => x.id);
  const [qOats] = q(`SELECT id FROM meals WHERE user_id = ? AND img_url = '/uploads/rl-oats.jpg' AND deleted_at IS NULL`, Q.id).map(x => x.id);
  assert.ok(qMilk && qPear2 && qLocal && qOats, 'each went up');
  assert.equal(id('/uploads/rl-pear-2.jpg').length, 1, 'sent twice, made once');
  const want = {
    dw: [
      ['Relink Milk', qMilk, 'BC-RL-MILK', 'glass', '/uploads/rl-milk.jpg'],
      ['Relink Oats', qOats, null, null, '/uploads/rl-oats.jpg'],
      ['Elsewhere', 987654, null, null, null],
      ['Relink Local', qLocal, 'BC-RL-LOCAL', null, null],
    ],
    d: [['Relink Pear', qPear2, 'BC-RL-PEAR2', null, '/uploads/rl-pear-2.jpg']],
    d2: [
      ['Relink Milk', qMilk, 'BC-RL-MILK', 'glass', '/uploads/rl-milk.jpg'],
      ['Relink Oats', qOats, null, null, '/uploads/rl-oats.jpg'],
    ],
  };
  assert.deepEqual(r, want, 'the phone');
  const server = async d => (await http(quinn, 'GET', `/api/diary/${d}`)).items.map(i => [i.name, i.food_server_id ?? null, i.barcode || null, i.alt_units?.[0]?.abbr || null, i.imgUrl || null]);
  assert.deepEqual({ dw: await server(DW), d: await server(D), d2: await server(D2) }, want, 'the server');
});

// #277 follow-up: Push all from this device (a server that lost its
// rows) sends every food, meal and recipe up again as a new row. Diary
// items kept the server ids from before, so they named no row on the
// phone or on the server: no units, barcode or photo of their own. They
// follow now, push all run once or twice.
test('#277: after Push all from this device diary items name their food and recipe by its new server id', async (t) => {
  if (skip(t)) return;
  const ravi = await account('ravi', A);
  const R = (await http(ravi, 'GET', '/api/auth/me')).user;
  const DW = '2026-06-23', D = '2026-06-22';
  const food = (name, extra = {}) => http(ravi, 'POST', '/api/foods', { name, nutrition: { calories: 50 }, visibility: 'private', ...extra });
  const milk = await food('Push Milk', { barcode: 'BC-PA-MILK', alt_units: [{ abbr: 'glass', grams: 250 }], img_url: '/uploads/pa-milk.jpg' });
  const pears = [];
  for (const n of [1, 2, 3]) pears.push(await food('Push Pear', { barcode: `BC-PA-PEAR${n}`, img_url: `/uploads/pa-pear-${n}.jpg` }));
  const oats = await http(ravi, 'POST', '/api/meals', { name: 'Push Oats', is_recipe: 1, items: [], img_url: '/uploads/pa-oats.jpg', visibility: 'private' });
  await http(ravi, 'PUT', `/api/diary/${DW}`, { items: [
    { uuid: 'pa-web-milk', id: milk.id, food_server_id: milk.id, name: 'Push Milk', meal: 0, quantity: 1, nutrition: {} },
    { uuid: 'pa-elsewhere', food_server_id: 987655, name: 'Elsewhere', meal: 0, quantity: 1, nutrition: {} },
  ], body_stats: {}, water: [] });
  phone('pushall', ravi, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(R)}, { confirm: async () => true });
    await p.sync();
    const { addDiaryItem } = await import(p.src + 'stores/diary.js');
    await addDiaryItem(await p.food(${pears[1].id}), 1, '${D}');
    await addDiaryItem((await p.api.getRecipes()).find(r => r.server_id === ${oats.id}), 1, '${D}');
    const phoneMade = await p.api.createFood({ name: 'Push Phone Made', nutrition: {}, barcode: 'BC-PA-PHONE' });
    await addDiaryItem(await p.api.getFood(phoneMade.id), 2, '${D}');
    await p.sync();
    p.done();`);
  // The server loses the rows made in the browser.
  for (const f of [milk, ...pears]) await http(ravi, 'DELETE', `/api/foods/${f.id}`);
  await http(ravi, 'DELETE', `/api/meals/${oats.id}`);
  const r = phone('pushall', ravi, `
    // A day saved here keeps only what names each item's food: units and
    // barcode come from the food on reading.
    await p.offline(async () => {
      const { addDiaryItem } = await import(p.src + 'stores/diary.js');
      await addDiaryItem(await p.api.getFood((await p.api.getFoods()).find(f => f.name === 'Push Phone Made').id), 2, '${DW}');
    });
    const { pushAllFromDevice } = await import(p.src + 'lib/sync.js');
    await pushAllFromDevice();
    await pushAllFromDevice();
    const sid = async name => (await p.api.getFoods()).find(f => f.name === name && (name !== 'Push Pear' || f.barcode === 'BC-PA-PEAR2'))?.server_id;
    const ids = { milk: await sid('Push Milk'), pear: await sid('Push Pear'), phone: await sid('Push Phone Made'),
      oats: (await p.api.getRecipes()).find(x => x.name === 'Push Oats')?.server_id };
    const day = async d => (await p.api.getDiaryDate(d)).items.map(i => [i.name, i.food_server_id ?? null, i.barcode || null, i.alt_units?.[0]?.abbr || null, i.imgUrl || null]);
    p.done({ ids, items: [...await day('${DW}'), ...await day('${D}')] });`);
  const { ids } = r;
  assert.ok(ids.milk && ids.pear && ids.oats && ids.phone);
  assert.notEqual(ids.milk, milk.id, 'Push all made the food again, with a new server id');
  const want = [
    ['Push Milk', ids.milk, 'BC-PA-MILK', 'glass', '/uploads/pa-milk.jpg'],
    ['Elsewhere', 987655, null, null, null],
    ['Push Phone Made', ids.phone, 'BC-PA-PHONE', null, null],
    ['Push Pear', ids.pear, 'BC-PA-PEAR2', null, '/uploads/pa-pear-2.jpg'],
    ['Push Oats', ids.oats, null, null, '/uploads/pa-oats.jpg'],
    ['Push Phone Made', ids.phone, 'BC-PA-PHONE', null, null],
  ];
  assert.deepEqual(r.items, want, 'the phone');
  const server = async d => (await http(ravi, 'GET', `/api/diary/${d}`)).items.map(i => [i.name, i.food_server_id ?? null, i.barcode || null, i.alt_units?.[0]?.abbr || null, i.imgUrl || null]);
  assert.deepEqual([...await server(DW), ...await server(D)], want, 'the server');
});

// #277 follow-up: of several foods (or recipes) of one name, with no id to
// tell them apart, the phone showed the newest one's photo by its own ids
// and the server the oldest one's. Both show the newest now, by one rule
// (fixtures/same-name.mjs); the server's side is in
// android-sync-server.test.js. The phone's own ids run in another order
// than the server's here; a row not on the server yet is the newest.
test("#277: same-named foods: the phone shows the newest one's photo, as the server does", async (t) => {
  if (skip(t)) return;
  const { ROWS, ITEMS, expectedPhotos } = await import('./fixtures/same-name.mjs');
  const r = phone('same-name', A, `
    const db = await p.dbn.getDb();
    const ROWS = ${JSON.stringify(ROWS)};
    // Server ids in the order the rows were made; the phone's own the other way round.
    for (const t of ['foods', 'meals']) {
      const rows = ROWS[t];
      for (let i = rows.length - 1; i >= 0; i--) {
        const x = rows[i];
        if (t === 'foods') await db.run('INSERT INTO foods (id, server_id, name, brand, img_url) VALUES (?, ?, ?, ?, ?)', [900 - i, 5000 + i, x.name, x.brand || null, x.img]);
        else await db.run('INSERT INTO meals (id, server_id, name, img_url, is_recipe) VALUES (?, ?, ?, ?, 1)', [900 - i, 6000 + i, x.name, x.img]);
      }
    }
    const items = ${JSON.stringify(ITEMS.map(x => x.item))};
    await p.dbn.dbSaveDiaryDate('2026-06-24', { items });
    const before = (await p.dbn.dbGetDiaryDate('2026-06-24')).items.map(i => i.imgUrl);
    await db.run("INSERT INTO foods (id, server_id, name, img_url) VALUES (1, NULL, 'Twin Pear', '/same/new.jpg')", []);
    const unsent = (await p.dbn.dbGetDiaryDate('2026-06-24')).items[0].imgUrl;
    p.done({ before, unsent });`);
  assert.deepEqual(r.before, expectedPhotos());
  assert.equal(r.unsent, '/same/new.jpg', 'a row not on the server yet is the newest');
});

// #280 (@fatman00): Smart Log's "same as yesterday" on the phone, from its
// own database: the day before the day being logged to (matchItems' date;
// Trace logs to today), the rule Foods' Yesterday's Meals now follows.
test('#280: "same as yesterday" on the phone is the day before the day being logged to', async (t) => {
  if (skip(t)) return;
  const r = phone('prev-day', A, `
    await p.dbn.dbSaveDiaryDate('2026-03-01', { items: [{ uuid: 'pd-1', name: 'Day One Soup', meal: 1, quantity: 1, nutrition: { calories: 100 } }] });
    await p.dbn.dbSaveDiaryDate('2026-03-02', { items: [{ uuid: 'pd-2', name: 'Day Two Salad', meal: 1, quantity: 1, nutrition: { calories: 200 } }] });
    const { matchItems } = await import(p.src + 'lib/quick-log.js');
    const lunch = [{ name: 'Lunch', quantity: 1, unit: null, kind: 'yesterday' }];
    const [day3] = await matchItems(lunch, { date: '2026-03-03' });
    const [day2] = await matchItems(lunch, { date: '2026-03-02' });
    p.done({ day3: [day3.best?._yesterdayDate, (day3.best?.items || []).map(i => i.name)], day2: [day2.best?._yesterdayDate, (day2.best?.items || []).map(i => i.name)] });`);
  assert.deepEqual(r, { day3: ['2026-03-02', ['Day Two Salad']], day2: ['2026-03-01', ['Day One Soup']] });
});

// #277 follow-up: a saved meal's and recipe's ingredients name their foods
// (and recipes) by server id too: the id in a meal saved in the browser,
// server_id in one saved in the Android app. Connect > Upload and Push all
// send the foods up as new rows; the ingredients kept the ids from before,
// so logging the meal or splitting the recipe later named no food, or
// another one. They follow now, a recipe inside a meal too.
async function ingredientCase(t, mode) {
  const a = await account(`ingr${mode}a`, A), b = mode === 'upload' ? await account(`ingr${mode}b`, A) : a;
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const AU = await me(a), BU = await me(b);
  const D = mode === 'upload' ? '2026-05-10' : '2026-05-11';
  const food = (name, extra = {}) => http(a, 'POST', '/api/foods', { name, nutrition: { calories: 50 }, portion: 100, unit: 'g', visibility: 'private', ...extra });
  const milk = await food(`Ingr Milk ${mode}`, { barcode: `BC-IG-MILK-${mode}`, alt_units: [{ abbr: 'glass', grams: 250 }] });
  const oats = await food(`Ingr Oats ${mode}`, { barcode: `BC-IG-OATS-${mode}` });
  // A recipe saved in the browser: the server's ids in `id`.
  const ing = (f, portion) => ({ id: f.id, name: f.name, portion, unit: 'g', quantity: 1, nutrition: { calories: portion } });
  const bowl = await http(a, 'POST', '/api/meals', { name: `Ingr Bowl ${mode}`, is_recipe: 1, visibility: 'private', portion: 150, items: [ing(milk, 100), ing(oats, 50)] });
  const phoneName = `ingr-${mode}`;
  phone(phoneName, a, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(AU)}, { confirm: async () => true });
    await p.sync();
    // A meal saved on the phone (the phone's shape): Milk and the bowl recipe.
    const milk = await p.food(${milk.id});
    const bowl = (await p.api.getRecipes()).find(r => r.server_id === ${bowl.id});
    await p.api.createMeal({ name: 'Ingr Breakfast ${mode}', is_recipe: 0, items: [{ ...milk, quantity: 1 }, { ...bowl, is_recipe: 1, quantity: 1 }] });
    await p.sync();
    p.done();`);
  if (mode === 'upload') {
    phone(phoneName, '', `
      const la = await import(p.src + 'lib/local-account.js');
      await la.setLocalOwner();
      p.done();`, { NT_SERVER: '' });
    phone(phoneName, b, `
      const la = await import(p.src + 'lib/local-account.js');
      const { uploadLocalToServer } = await import(p.src + 'lib/migrate.js');
      await uploadLocalToServer({ serverUrl: process.env.NT_SERVER, authToken: process.env.NT_TOKEN });
      const summary = await uploadLocalToServer({ serverUrl: process.env.NT_SERVER, authToken: process.env.NT_TOKEN });
      await la.claimForServer(process.env.NT_SERVER, ${BU.id}, { uploaded: summary.uploaded });
      await la.prepareLocalAccount(${JSON.stringify(BU)}, { confirm: async () => true });
      await p.sync(); await p.sync();
      p.done();`);
  } else {
    // The server loses the rows made in the browser; Push all, twice.
    for (const f of [milk, oats]) await http(a, 'DELETE', `/api/foods/${f.id}`);
    await http(a, 'DELETE', `/api/meals/${bowl.id}`);
    phone(phoneName, a, `
      const { pushAllFromDevice } = await import(p.src + 'lib/sync.js');
      await pushAllFromDevice();
      await pushAllFromDevice();
      await p.sync();
      p.done();`);
  }
  const ids = name => q(`SELECT id FROM foods WHERE user_id = ? AND name = ? AND deleted_at IS NULL`, BU.id, name).map(x => x.id);
  const mealId = name => q(`SELECT id FROM meals WHERE user_id = ? AND name = ? AND deleted_at IS NULL`, BU.id, name).map(x => x.id);
  const [nMilk] = ids(milk.name), [nOats] = ids(oats.name), [nBowl] = mealId(bowl.name), [nBreakfast] = mealId(`Ingr Breakfast ${mode}`);
  assert.ok(nMilk && nOats && nBowl && nBreakfast, 'each on the server');
  assert.notEqual(nMilk, milk.id, 'made again, with a new id');
  // On the phone: split the recipe in the diary, and log the meal.
  const r = phone(phoneName, b, `
    const store = await import(p.src + 'stores/diary.js');
    const bowl = (await p.api.getRecipes()).find(m => m.name === '${bowl.name}');
    const breakfast = (await p.api.getMeals()).find(m => m.name === 'Ingr Breakfast ${mode}');
    await store.addDiaryItem({ ...bowl, is_recipe: 1 }, 0, '${D}');
    await store.loadEntry('${D}');
    await store.splitRecipeItem(0);
    for (const it of breakfast.items) await store.addDiaryItem(it, 1, '${D}');
    const day = await p.api.getDiaryDate('${D}');
    p.done({
      split: day.items[0]._splitItems.map(i => [i.name, i.food_server_id ?? null, i.barcode || null]),
      logged: day.items.slice(1).map(i => [i.name, i.food_server_id ?? null]),
      bowl: bowl.items.map(i => i.server_id ?? null), breakfast: breakfast.items.map(i => i.server_id ?? null),
    });`);
  assert.deepEqual(r.split, [[milk.name, nMilk, `BC-IG-MILK-${mode}`], [oats.name, nOats, `BC-IG-OATS-${mode}`]], 'the split recipe names its foods');
  assert.deepEqual(r.logged, [[milk.name, nMilk], [bowl.name, nBowl]], 'the logged meal too');
  assert.deepEqual([r.bowl, r.breakfast], [[nMilk, nOats], [nMilk, nBowl]], "the phone's copies");
  // What reached the server: log_meal (MCP and the API) names the foods.
  const items = id => JSON.parse(q(`SELECT items FROM meals WHERE id = ?`, id)[0].items);
  const sid = it => (typeof it.food_server_id === 'number' ? it.food_server_id : 'server_id' in it ? it.server_id : it.id);
  assert.deepEqual(items(nBowl).map(sid), [nMilk, nOats], "the server's recipe");
  assert.deepEqual(items(nBreakfast).map(sid), [nMilk, nBowl], "the server's meal");
}
test("#277: after Connect > Upload a saved meal's and recipe's ingredients follow their foods", async (t) => {
  if (skip(t)) return;
  await ingredientCase(t, 'upload');
});
test("#277: after Push all a saved meal's and recipe's ingredients follow their foods", async (t) => {
  if (skip(t)) return;
  await ingredientCase(t, 'pushall');
});

// #277 follow-up: the phone's twin of the server's rule above
// (android-sync-server.test.js): a food its id names lends an item units
// and barcode only if it is the item's.
test("#277: on the phone a food lends an item its units and barcode only if it is the item's", async (t) => {
  if (skip(t)) return;
  const r = phone('lend', A, `
    const db = await p.dbn.getDb();
    const row = (id, sid, name, made, bc) => db.run("INSERT INTO foods (id, server_id, name, barcode, alt_units, created_at) VALUES (?, ?, ?, ?, '[{\\"abbr\\":\\"cup\\",\\"grams\\":200}]', ?)", [id, sid, name, bc, made]);
    await row(801, 9801, 'Unrelated Lend', '2026-01-02 10:00:00', 'BC-UNRELATED');
    await row(802, 9802, 'Whole Milk Lend', '2025-12-01 08:00:00', 'BC-MILK');
    await row(803, 9803, 'Banana Lend', '2026-01-02 10:00:00', 'BC-BANANA');
    await p.dbn.dbSaveDiaryDate('2026-05-20', { items: [
      { uuid: 'l1', food_server_id: 9801, name: 'Banana Lend', addedAt: '2026-01-01T00:00:00.000Z' },
      { uuid: 'l2', food_server_id: 9802, name: 'Milk Lend', addedAt: '2026-01-01T00:00:00.000Z' },
      { uuid: 'l3', food_server_id: 9803, name: 'banana lend ', addedAt: '2026-01-01T00:00:00.000Z' },
      { uuid: 'l4', id: 801, name: 'Banana Lend' },
    ] });
    p.done((await p.dbn.dbGetDiaryDate('2026-05-20')).items.map(i => [i.barcode || null, i.alt_units?.[0]?.abbr || null]));`);
  assert.deepEqual(r, [[null, null], ['BC-MILK', 'cup'], ['BC-BANANA', 'cup'], [null, null]]);
});

// #277 follow-up: a relinked item is a change the server's merge keeps
// (server/lib/diary-merge.js keeps the copy of an item with the later
// updatedAt). It kept its old time, so another device sending its older
// copy of the day again, with the old id, put the old id back. Now the
// relinked copy wins over that, and still loses to a real edit made
// elsewhere in the meantime. Two clients: the phone (Push all) and the
// browser (PUT /api/diary, as the web app saves a day).
test('#277: a relinked diary item beats an older copy of the day sent again, not a newer edit', async (t) => {
  if (skip(t)) return;
  const tok = await account('relinkmerge', A);
  const U = (await http(tok, 'GET', '/api/auth/me')).user;
  const D1 = '2026-05-30', D2 = '2026-05-31';
  const milk = await http(tok, 'POST', '/api/foods', { name: 'Merge Milk', barcode: 'BC-MERGE', nutrition: { calories: 60 }, visibility: 'private' });
  const at = '2026-05-30T08:00:00.000Z';
  const item = (uuid, extra = {}) => ({ uuid, id: milk.id, food_server_id: milk.id, name: 'Merge Milk', meal: 0, quantity: 1, portion: 100, unit: 'g', nutrition: { calories: 60 }, addedAt: at, ...extra });
  // The browser's copy of each day, as it loaded it.
  const web1 = { items: [item('mm-1')], body_stats: {}, water: [] };
  const web2 = { items: [item('mm-2')], body_stats: {}, water: [] };
  await http(tok, 'PUT', `/api/diary/${D1}`, web1);
  await http(tok, 'PUT', `/api/diary/${D2}`, web2);
  phone('relinkmerge', tok, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(U)}, { confirm: async () => true });
    await p.sync();
    p.done();`);
  // The server loses Milk. Meanwhile the browser really edits day 2's
  // item (2 servings), before the phone's Push all goes up.
  await http(tok, 'DELETE', `/api/foods/${milk.id}`);
  await http(tok, 'PUT', `/api/diary/${D2}`, { ...web2, items: [item('mm-2', { quantity: 2, updatedAt: new Date().toISOString() })] });
  const r = phone('relinkmerge', tok, `
    const { pushAllFromDevice } = await import(p.src + 'lib/sync.js');
    await pushAllFromDevice();
    await p.sync();
    p.done({ milk: (await p.api.getFoods()).find(f => f.name === 'Merge Milk')?.server_id });`);
  assert.ok(r.milk && r.milk !== milk.id, 'Milk made again');
  const day = async d => (await http(tok, 'GET', `/api/diary/${d}`)).items.map(i => [i.food_server_id, i.quantity]);
  assert.deepEqual(await day(D1), [[r.milk, 1]], 'relinked');
  // The browser sends its older copy of day 1 again (an unrelated save).
  await http(tok, 'PUT', `/api/diary/${D1}`, { ...web1, notes: 'saved again' });
  assert.deepEqual(await day(D1), [[r.milk, 1]], 'the older copy does not bring the old id back');
  assert.deepEqual(await day(D2), [[milk.id, 2]], 'the newer edit made elsewhere still wins');
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

test('Health Connect read again with the same values leaves them sent; a new value goes up', async (t) => {
  if (skip(t)) return;
  // The suite's first account (signing up more runs into the server's limit).
  const H = (await http(A, 'GET', '/api/auth/me')).user;
  const r = phone('wellness', A, `
    const la = await import(p.src + 'lib/local-account.js');
    await la.prepareLocalAccount(${JSON.stringify(H)}, { confirm: async () => true });
    const db = await p.dbn.getDb();
    const D = '2031-07-19';
    const status = async () => (await db.query("SELECT value, sync_status FROM wellness_data WHERE date = ? AND metric_type = 'steps'", [D])).values[0];
    await p.dbn.dbUpsertWellness(D, 'health_connect', 'steps', 1382);
    await p.sync();
    const sent = await status();
    // The 30s sync reads Health Connect again: same steps.
    await p.dbn.dbUpsertWellness(D, 'health_connect', 'steps', 1382);
    const same = await status();
    await p.dbn.dbUpsertWellness(D, 'health_connect', 'steps', 1500);
    const more = await status();
    await p.sync();
    p.done({ sent, same, more, after: await status() });`);
  assert.equal(r.sent.sync_status, 'synced');
  assert.deepEqual(r.same, { value: 1382, sync_status: 'synced' }, 'the same steps are not sent again every 30s');
  assert.deepEqual(r.more, { value: 1500, sync_status: 'pending' });
  assert.equal(r.after.sync_status, 'synced');
  const rows = q(`SELECT w.value FROM wellness_data w WHERE w.user_id = ? AND w.date = '2031-07-19' AND w.metric_type = 'steps'`, H.id);
  assert.deepEqual(rows, [{ value: 1500 }]);
});

test('the connection check and the sync stop while the app is hidden, and syncs say whether anything changed', () => {
  const sync = readFileSync(new URL('../src/lib/sync.js', import.meta.url), 'utf8');
  const monitor = sync.slice(sync.indexOf('export function startNetworkMonitor'), sync.indexOf('export function schedulePush'));
  assert.doesNotMatch(monitor, /setInterval\(async/, 'an ungated interval');
  assert.match(monitor, /document\.hidden \? off\(\) : on\(\)/);
  assert.match(monitor, /addListener\('pause', off\)/);
  assert.match(sync, /new CustomEvent\('nt:sync-complete', \{ detail: \{ changed: !!hadChanges \} \}\)/);
  // A pull that only removed rows (Clear all data, a wearable re-sync) is a change.
  assert.match(sync, /Object\.values\(data\.deletions \|\| \{\}\)\.reduce/);
  assert.match(sync, /data\.diary_tombstones\?\.length/);
  for (const f of ['../src/routes/Wellness.svelte', '../src/routes/Diary.svelte', '../src/components/ai/Trace.svelte']) {
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /e\?\.detail\?\.changed === false/, f);
  }
});

// Coaching messages on the phone (1.5): written with no connection, kept on
// the phone with their own uuid, and stored once on the server however often
// they go (a direct send whose answer was lost, then the sync push). The
// phone keeps the conversation from the pull; a coach whose client left
// loses it from the phone too.
test('a coaching message written offline on the phone is stored once; the conversation stays on the phone; a former coach loses it', async (t) => {
  if (skip(t)) return;
  const coach = await account('cm-coach', A), client = await account('cm-client', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const CO = await me(coach), CL = await me(client);
  await http(A, 'PUT', `/api/auth/users/${CO.id}/role`, { role: 'coach' });
  const req = await http(coach, 'POST', '/api/coaching/requests', { client_id: CL.id });
  await http(client, 'POST', `/api/coaching/pairings/${req.id}/accept`);
  await http(coach, 'POST', `/api/coaching/clients/${CL.id}/messages`, { uuid: 'from-coach-0001', body: 'Hi Cliff' });

  // The phone's direct send reaches the server but its answer is lost; the
  // next sync carries the same message again.
  let drop = 1;
  const px = await proxy(r => (r.method === 'POST' && /\/api\/coaching\/pairings\/\d+\/messages$/.test(r.url) && drop-- > 0 ? { dropReply: true } : null));
  let r;
  try {
    r = await phoneAsync('coachmsg', client, `
      const la = await import(p.src + 'lib/local-account.js');
      localStorage.setItem('wl:userId', '${CL.id}');
      await la.prepareLocalAccount(${JSON.stringify(CL)}, { confirm: async () => true });
      await p.sync();
      const cm = await import(p.src + 'lib/coach-messages.js');
      const conv = { pairingId: ${req.id}, side: 'client' };
      const pulled = (await cm.loadConversation(conv)).map(m => m.body);
      let row;
      await p.offline(async () => { row = await cm.sendMessage(conv, { body: 'Written in a dead zone' }); await cm.flushCoachMessages(); });
      const waiting = (await cm.loadConversation(conv)).find(m => m.uuid === row.uuid).sync_status;
      await cm.flushCoachMessages();             // reaches the server, answer lost
      const afterLost = (await cm.loadConversation(conv)).find(m => m.uuid === row.uuid).sync_status;
      await p.sync();                            // the push sends it again
      const after = (await cm.loadConversation(conv)).filter(m => m.uuid === row.uuid);
      p.done({ pulled, waiting, afterLost, after: after.map(m => m.sync_status), uuid: row.uuid });`, { NT_SERVER: px.url });
  } finally { await px.close(); }
  assert.deepEqual(r.pulled, ['Hi Cliff'], 'the pull brought the conversation');
  assert.equal(r.waiting, 'pending', 'kept on the phone while offline');
  assert.equal(r.afterLost, 'pending', 'still waiting: the answer never came');
  assert.deepEqual(r.after, ['synced']);
  assert.deepEqual(q(`SELECT COUNT(*) AS n FROM coach_messages WHERE uuid = ?`, r.uuid), [{ n: 1 }], 'stored once');
  assert.deepEqual(q(`SELECT body FROM coach_messages WHERE pairing_id = ? ORDER BY id`, req.id).map(x => x.body), ['Hi Cliff', 'Written in a dead zone']);

  // The coach's phone holds the conversation, then the client leaves.
  const c1 = phone('coachside', coach, `
    const la = await import(p.src + 'lib/local-account.js');
    localStorage.setItem('wl:userId', '${CO.id}');
    await la.prepareLocalAccount(${JSON.stringify(CO)}, { confirm: async () => true });
    await p.sync();
    const cm = await import(p.src + 'lib/coach-messages.js');
    p.done((await cm.loadConversation({ pairingId: ${req.id}, side: 'coach', clientId: ${CL.id} })).length);`);
  assert.equal(c1, 2);
  await http(client, 'POST', `/api/coaching/pairings/${req.id}/end`);
  const c2 = phone('coachside', coach, `
    await p.sync();
    const cm = await import(p.src + 'lib/coach-messages.js');
    const db = await p.dbn.getDb();
    p.done({ kept: (await cm.loadConversation({ pairingId: ${req.id}, side: 'coach', clientId: ${CL.id} })).length,
      rows: (await db.query('SELECT COUNT(*) AS n FROM coach_messages', [])).values[0].n });`);
  assert.deepEqual(c2, { kept: 0, rows: 0 }, 'the coach loses it on the phone too');
  // The client keeps theirs.
  const c3 = phone('coachmsg', client, `
    await p.sync();
    const cm = await import(p.src + 'lib/coach-messages.js');
    p.done((await cm.loadConversation({ pairingId: ${req.id}, side: 'client' })).length);`);
  assert.equal(c3, 2);
});

// Coaching targets (1.5): a coach's recommendation comes down with the sync;
// accepted with no connection, the goals change on the phone and the answer
// waits; the next sync sends both. Undo brings the goals back exactly.
test('targets accepted offline on the phone: goals change there, the answer and the goals reach the server; Undo restores them exactly', async (t) => {
  if (skip(t)) return;
  const coach = await account('tg-coach', A), client = await account('tg-client', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const CO = await me(coach), CL = await me(client);
  await http(A, 'PUT', `/api/auth/users/${CO.id}/role`, { role: 'coach' });
  const req = await http(coach, 'POST', '/api/coaching/requests', { client_id: CL.id });
  await http(client, 'POST', `/api/coaching/pairings/${req.id}/accept`);
  const START = {
    calories: { sharedGoal: false, isMin: false, isPercent: false, showInDiary: true, showInStats: true, days: [2300, 2000, 2000, 2100, 2000, 2000, 2400], max: 2400 },
    proteins: { sharedGoal: true, isMin: false, isPercent: true, showInDiary: false, showInStats: true, days: Array(7).fill(30), max: 30 },
  };
  await http(client, 'PUT', '/api/settings', { key: 'goals', value: START });
  await http(client, 'PUT', '/api/settings', { key: 'calorieGoalMode', value: 'adaptive' });
  const rec = await http(coach, 'POST', `/api/coaching/clients/${CL.id}/recommendations`, { payload: { goals: { calories: { max: 1900 }, proteins: { max: 150 } } } });
  const r = phone('targets', client, `
    const la = await import(p.src + 'lib/local-account.js');
    localStorage.setItem('wl:userId', '${CL.id}');
    await la.prepareLocalAccount(${JSON.stringify(CL)}, { confirm: async () => true });
    const { loadServerSettings } = await import(p.src + 'stores/settings.js');
    await loadServerSettings();
    await p.sync();
    const cr = await import(p.src + 'lib/coach-recommendations.js');
    const recs = await cr.loadRecommendations();
    const mine = recs.find(x => x.id === ${rec.id});
    await p.offline(async () => { await cr.acceptTargets(mine, { t: (k, o) => 'Before coach change, ' + o.values.date, date: 'today' }); });
    const waiting = (await p.dbn.dbPendingCoachAnswers()).map(a => a.status);
    await p.sleep(1200);
    await p.sync();
    const { get } = await import('svelte/store');
    const s = await import(p.src + 'stores/settings.js');
    const tplNames = get(s.goalTemplates).map(x => x.name);
    p.done({ pulled: !!mine, waiting, tplNames, after: (await cr.loadRecommendations()).find(x => x.id === ${rec.id}).status });`);
  assert.equal(r.pulled, true, 'the recommendation came with the sync');
  assert.deepEqual(r.waiting, ['accepted'], 'the answer waited while offline');
  assert.deepEqual(r.tplNames, ['Before coach change, today']);
  assert.equal(r.after, 'accepted');
  assert.equal(q(`SELECT status FROM coach_recommendations WHERE id = ?`, rec.id)[0].status, 'accepted');
  const goalsNow = JSON.parse(q(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'goals'`, CL.id)[0].value);
  assert.equal(goalsNow.calories.max, 1900);
  assert.equal(goalsNow.proteins.isPercent, false);
  assert.equal(goalsNow.proteins.showInDiary, false, 'show/hide stays');
  assert.equal(JSON.parse(q(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'calorieGoalMode'`, CL.id)[0].value), 'fixed');
  // Undo on the phone; the server ends with the goals exactly as they were.
  const u = phone('targets', client, `
    const cr = await import(p.src + 'lib/coach-recommendations.js');
    const mine = (await cr.loadRecommendations()).find(x => x.id === ${rec.id});
    const { get } = await import('svelte/store');
    const s = await import(p.src + 'stores/settings.js');
    // What the app does when it opens: this account's settings come down
    // (the template Accept saved went up with them).
    localStorage.setItem('wl:userId', '${CL.id}');
    await s.loadServerSettings();
    const undone = cr.undoTargets(mine);
    await p.sleep(1200);
    await p.sync();
    p.done({ undone, templates: get(s.goalTemplates).length });`);
  assert.equal(u.undone, true, JSON.stringify(u));
  assert.deepEqual(JSON.parse(q(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'goals'`, CL.id)[0].value), START);
  assert.equal(JSON.parse(q(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'calorieGoalMode'`, CL.id)[0].value), 'adaptive');
});

// An Accept made offline that the server refuses (the coach replaced the
// recommendation meanwhile): the goals go back to what they were, and the
// card says it was replaced.
test('targets accepted offline but replaced meanwhile: the phone puts the goals back', async (t) => {
  if (skip(t)) return;
  const coach = await account('rc-coach', A), client = await account('rc-client', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const CO = await me(coach), CL = await me(client);
  await http(A, 'PUT', `/api/auth/users/${CO.id}/role`, { role: 'coach' });
  const req = await http(coach, 'POST', '/api/coaching/requests', { client_id: CL.id });
  await http(client, 'POST', `/api/coaching/pairings/${req.id}/accept`);
  const START = { calories: { sharedGoal: true, isMin: false, isPercent: false, showInDiary: true, showInStats: true, days: Array(7).fill(2200), max: 2200 } };
  await http(client, 'PUT', '/api/settings', { key: 'goals', value: START });
  const rec = await http(coach, 'POST', `/api/coaching/clients/${CL.id}/recommendations`, { payload: { goals: { calories: { max: 1700 } } } });
  // One phone run, as on a real phone: accepted with no connection, the
  // coach replaces the recommendation meanwhile, then the phone syncs.
  const r = phone('refused', client, `
    const la = await import(p.src + 'lib/local-account.js');
    localStorage.setItem('wl:userId', '${CL.id}');
    await la.prepareLocalAccount(${JSON.stringify(CL)}, { confirm: async () => true });
    const s = await import(p.src + 'stores/settings.js');
    const { get } = await import('svelte/store');
    await s.loadServerSettings();
    await p.sync();
    const cr = await import(p.src + 'lib/coach-recommendations.js');
    const mine = (await cr.loadRecommendations()).find(x => x.id === ${rec.id});
    await p.offline(async () => { await cr.acceptTargets(mine, { t: (k, o) => 'Before coach change, ' + o.values.date, date: 'today' }); });
    const applied = get(s.goals).calories?.max;
    await fetch(process.env.NT_SERVER + '/api/coaching/clients/${CL.id}/recommendations', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${coach}' },
      body: JSON.stringify({ payload: { goals: { calories: { max: 1800 } } } }) });
    await p.sleep(1200);
    await p.sync();
    await p.sleep(1200);
    await p.sync();
    p.done({ applied, after: get(s.goals).calories?.max, status: (await cr.loadRecommendations()).find(x => x.id === ${rec.id}).status });`);
  assert.equal(r.applied, 1700, 'applied while offline');
  assert.equal(r.status, 'replaced');
  assert.equal(r.after, 2200, 'the goals went back ' + JSON.stringify(r));
  assert.equal(q(`SELECT status FROM coach_recommendations WHERE id = ?`, rec.id)[0].status, 'replaced');
  assert.deepEqual(JSON.parse(q(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'goals'`, CL.id)[0].value), START);
});

// Coaching day plans (1.5): a plan comes down with the sync; accepted and
// logged with no connection, its items are what a manual add makes on the
// phone, the coach's food is copied into the client's catalog once (with
// its source), and all of it reaches the server; the coach sees the meal
// logged.
test('a day plan accepted and logged offline on the phone: the same items as a manual add, the coach\'s food copied once, all of it on the server', async (t) => {
  if (skip(t)) return;
  const coach = await account('dp-coach', A), client = await account('dp-client', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const CO = await me(coach), CL = await me(client);
  await http(A, 'PUT', `/api/auth/users/${CO.id}/role`, { role: 'coach' });
  const req = await http(coach, 'POST', '/api/coaching/requests', { client_id: CL.id });
  await http(client, 'POST', `/api/coaching/pairings/${req.id}/accept`);
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
  const TODAY = day(0), OTHER = day(-1);
  const oats = await http(client, 'POST', '/api/foods', { name: 'Oats', brand: 'Mill', portion: 50, unit: 'g', nutrition: { calories: 190, proteins: 6.5, carbohydrates: 33, fat: 3.5 } });
  const granola = await http(coach, 'POST', '/api/foods', { name: 'Coach Granola', portion: 60, unit: 'g', nutrition: { calories: 270, proteins: 7, carbohydrates: 38, fat: 10 } });
  const { planItemFrom } = await import('../src/lib/coach-plans.js');
  const [plan] = await http(coach, 'POST', `/api/coaching/clients/${CL.id}/recommendations`, { kind: 'day_plan', date: TODAY, payload: { meals: [
    { meal: 0, items: [planItemFrom(oats, 'client_food'), { ...planItemFrom(granola, 'coach_food'), quantity: 1.5 }] },
    { meal: 2, items: [planItemFrom(oats, 'client_food')] },
  ] } });
  const r = phone('dayplan', client, `
    const la = await import(p.src + 'lib/local-account.js');
    localStorage.setItem('wl:userId', '${CL.id}');
    await la.prepareLocalAccount(${JSON.stringify(CL)}, { confirm: async () => true });
    const s = await import(p.src + 'stores/settings.js');
    await s.loadServerSettings();
    await p.sync();
    const cr = await import(p.src + 'lib/coach-recommendations.js');
    const plan = (await cr.loadRecommendations()).find(x => x.id === ${plan.id});
    const log = await import(p.src + 'lib/coach-plan-log.js');
    const d = await import(p.src + 'stores/diary.js');
    const { NtApi } = await import(p.src + 'lib/api.js');
    const { loggedMeals } = await import(p.src + 'lib/coach-plans.js');
    let answered;
    await p.offline(async () => {
      answered = await cr.answerPlan(plan, 'accepted');
      await log.logPlanMeal(plan, 0);
      // The same foods added by hand the Foods page's way, on another day.
      const foods = await NtApi.getFoods();
      const m = (f, q) => ({ ...f, portion: f.portion || 100, unit: f.unit || 'g', quantity: q, nutrition: f.nutrition });
      await d.addDiaryItem(m(foods.find(f => f.name === 'Oats'), 1), 0, '${OTHER}');
      await d.addDiaryItem(m(foods.find(f => f.name === 'Coach Granola'), 1.5), 0, '${OTHER}');
    });
    const local = (await NtApi.getDiaryDate('${TODAY}')).items;
    const copies = (await NtApi.getFoods()).filter(f => f.name === 'Coach Granola').length;
    await p.sleep(1200);
    await p.sync();
    await p.sleep(1200);
    await p.sync();
    p.done({ offline: answered.offline, localLogged: [...loggedMeals(local, plan)], copies,
      status: (await cr.loadRecommendations()).find(x => x.id === ${plan.id}).status });`);
  assert.equal(r.offline, true, 'the answer waited');
  assert.deepEqual(r.localLogged, [0], 'Log This turned to Logged on the phone');
  assert.equal(r.copies, 1);
  assert.equal(r.status, 'accepted');
  assert.equal(q(`SELECT status FROM coach_recommendations WHERE id = ?`, plan.id)[0].status, 'accepted');
  const items = (date) => JSON.parse(q(`SELECT items FROM diary WHERE user_id = ? AND date = ?`, CL.id, date)[0].items);
  const strip = (it) => { const { uuid: _u, addedAt: _a, source: _s, updatedAt: _t, ...rest } = it; return rest; };
  assert.equal(items(TODAY).length, 2);
  assert.deepEqual(items(TODAY).map(strip), items(OTHER).map(strip), 'the same items as a manual add');
  assert.deepEqual(items(TODAY).map(i => i.source), ['0.0', '0.1'].map(k => `coach:plan:${plan.id}:${k}`));
  assert.ok(items(TODAY).every(i => typeof i.food_server_id === 'number'));
  const copies = q(`SELECT id, source_app, source_external_id FROM foods WHERE user_id = ? AND name = 'Coach Granola' AND deleted_at IS NULL`, CL.id);
  assert.deepEqual(copies.map(c => [c.source_app, c.source_external_id]), [['coach', `food:${granola.id}`]], 'copied once, with its source');
  const coachView = (await http(coach, 'GET', `/api/coaching/clients/${CL.id}/recommendations`)).find(x => x.id === plan.id);
  assert.deepEqual(coachView.logged_meals, [0]);
});

// Send to Client (1.5): a recipe the coach sent, accepted on the phone with
// no connection; the next sync sends the answer, the server makes the
// client's copy (with its ingredient's food), and the pull brings both.
test('a sent recipe accepted offline on the phone: the copy is made on the server and comes down to the phone', async (t) => {
  if (skip(t)) return;
  const coach = await account('sr-coach', A), client = await account('sr-client', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const CO = await me(coach), CL = await me(client);
  await http(A, 'PUT', `/api/auth/users/${CO.id}/role`, { role: 'coach' });
  const req = await http(coach, 'POST', '/api/coaching/requests', { client_id: CL.id });
  await http(client, 'POST', `/api/coaching/pairings/${req.id}/accept`);
  const oats = await http(coach, 'POST', '/api/foods', { name: 'Sent Oats', portion: 50, unit: 'g', nutrition: { calories: 190 } });
  const bowl = await http(coach, 'POST', '/api/meals', { name: 'Sent Bowl', is_recipe: true, portion: 300, unit: 'g', nutrition: { calories: 285 }, items: [{ ...oats, quantity: 1 }] });
  const rec = await http(coach, 'POST', `/api/coaching/clients/${CL.id}/recommendations`, { kind: 'recipe', meal_id: bowl.id });
  const r = phone('sendrecipe', client, `
    const la = await import(p.src + 'lib/local-account.js');
    localStorage.setItem('wl:userId', '${CL.id}');
    await la.prepareLocalAccount(${JSON.stringify(CL)}, { confirm: async () => true });
    await p.sync();
    const cr = await import(p.src + 'lib/coach-recommendations.js');
    const mine = (await cr.loadRecommendations()).find(x => x.id === ${rec.id});
    let answered;
    await p.offline(async () => { answered = await cr.answerPlan(mine, 'accepted'); });
    const { NtApi } = await import(p.src + 'lib/api.js');
    const before = (await NtApi.getRecipes()).map(m => m.name);
    await p.sleep(1200);
    await p.sync();
    await p.sleep(1200);
    await p.sync();
    const recipes = await NtApi.getRecipes();
    const foods = await NtApi.getFoods();
    p.done({ kind: mine.kind, offline: answered.offline, before, recipes: recipes.map(m => m.name),
      foods: foods.filter(f => f.name === 'Sent Oats').map(f => [f.source_app, f.source_external_id]) });`);
  assert.equal(r.kind, 'recipe');
  assert.equal(r.offline, true, 'the answer waited');
  assert.deepEqual(r.before, [], 'no copy while offline');
  assert.deepEqual(r.recipes, ['Sent Bowl'], 'the copy came down');
  assert.deepEqual(r.foods, [['coach', `food:${oats.id}`]], 'with its ingredient\'s food');
  assert.deepEqual(q(`SELECT name, source_app, source_external_id FROM meals WHERE user_id = ?`, CL.id), [{ name: 'Sent Bowl', source_app: 'coach', source_external_id: `meal:${bowl.id}:${rec.id}` }]);
});

// Trace in coaching (1.5): on the phone, a coach's Trace reads a client's
// summary and foods and drafts targets and a day plan; nothing is sent. A
// client's Trace reads what their coach recommended, never the conversation.
test("Trace's coaching tools on the phone: a coach's drafts send nothing; a client reads recommendations, never messages", async (t) => {
  if (skip(t)) return;
  const coach = await account('tr-coach', A), client = await account('tr-client', A);
  const me = async tok => (await http(tok, 'GET', '/api/auth/me')).user;
  const CO = await me(coach), CL = await me(client);
  await http(A, 'PUT', `/api/auth/users/${CO.id}/role`, { role: 'coach' });
  const req = await http(coach, 'POST', '/api/coaching/requests', { client_id: CL.id });
  await http(client, 'POST', `/api/coaching/pairings/${req.id}/accept`);
  await http(client, 'PUT', '/api/settings', { key: 'goals', value: { calories: { sharedGoal: true, isMin: false, isPercent: false, days: Array(7).fill(2200), max: 2200 } } });
  const oats = await http(client, 'POST', '/api/foods', { name: 'Trace Oats', portion: 50, unit: 'g', nutrition: { calories: 190, proteins: 6.5, carbohydrates: 33, fat: 3.5 } });
  await http(coach, 'POST', `/api/coaching/clients/${CL.id}/messages`, { uuid: 'tr-secret-0001', body: 'A private word' });
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString('sv-SE'); })();
  const r = phone('tracecoach', coach, `
    const la = await import(p.src + 'lib/local-account.js');
    localStorage.setItem('wl:userId', '${CO.id}');
    await la.prepareLocalAccount(${JSON.stringify(CO)}, { confirm: async () => true });
    await p.sync();
    const tr = await import(p.src + 'lib/coach-trace.js');
    const as = { coach: true, client: false };
    // How often the client list is read through the tools below.
    let listReads = 0;
    const _fetch = globalThis.fetch;
    globalThis.fetch = (u, o) => { const s = String(u); if (s.includes('/api/coaching/clients?') || s.endsWith('/api/coaching/clients')) listReads++; return _fetch(u, o); };
    const clients = (await tr.runCoachingTool('get_coaching_clients', {}, as)).result;
    const summary = (await tr.runCoachingTool('get_client_summary', { client_id: ${CL.id} }, as)).result;
    const foods = (await tr.runCoachingTool('get_client_foods', { client_id: ${CL.id}, query: 'oats' }, as)).result;
    const targets = await tr.runCoachingTool('draft_targets', { client_id: ${CL.id}, calories: 2000, protein_g: 150, note: 'A little less' }, as);
    const plan = await tr.runCoachingTool('draft_day_plan', { client_id: ${CL.id}, date: '${tomorrow}', meals: [{ meal: 0, items: [{ id: foods[0].id, kind: 'food', whose: 'client', servings: 2 }] }] }, as);
    const notCoach = (await tr.runCoachingTool('draft_targets', { client_id: ${CL.id}, calories: 1 }, { coach: false, client: false })).result;
    const names = tr.coachingTools({}).map(x => x.name);
    globalThis.fetch = _fetch;
    p.done({ listReads, clients, summaryTargets: summary.targets, foods, targets: targets.draft, targetsResult: targets.result, plan: plan.draft, planResult: plan.result, notCoach, names, allNames: tr.coachingTools({ coach: true, client: true }).map(x => x.name) });`);
  assert.deepEqual(r.clients.map(c => c.name), ['tr-client']);
  assert.equal(r.listReads, 1, 'the client list is read once for the turn, not by every tool');
  assert.equal(r.summaryTargets.calories.max, 2200);
  assert.deepEqual(r.foods.map(f => [f.id, f.name, f.calories]), [[oats.id, 'Trace Oats', 190]]);
  assert.deepEqual(r.targets.payload.goals.calories.max, 2000);
  assert.equal(r.targets.note, 'A little less');
  assert.match(r.targetsResult.note, /Nothing was sent/);
  assert.deepEqual(r.plan.payload.meals[0].items.map(i => [i.name, i.quantity, i.source.kind, i.source.id]), [['Trace Oats', 2, 'client_food', oats.id]]);
  assert.equal(r.planResult.totals.calories, 380);
  assert.equal(r.notCoach.error, 'This needs coaching.');
  assert.deepEqual(r.names, [], 'nothing for people not in coaching');
  assert.ok(!r.allNames.some(n => /message|conversation/.test(n)), 'no tool reads the conversation');
  assert.equal(q(`SELECT COUNT(*) AS n FROM coach_recommendations WHERE client_id = ?`, CL.id)[0].n, 0, 'drafts send nothing');

  // The client's Trace: what was recommended, from the recommendations.
  await http(coach, 'POST', `/api/coaching/clients/${CL.id}/recommendations`, { payload: { goals: { calories: { max: 2000 } } }, note: 'Slightly less' });
  const c = phone('traceclient', client, `
    const la = await import(p.src + 'lib/local-account.js');
    localStorage.setItem('wl:userId', '${CL.id}');
    await la.prepareLocalAccount(${JSON.stringify(CL)}, { confirm: async () => true });
    await p.sync();
    const tr = await import(p.src + 'lib/coach-trace.js');
    const out = (await tr.runCoachingTool('get_coach_recommendations', {}, { coach: false, client: true })).result;
    p.done({ out, text: JSON.stringify(out) });`);
  assert.equal(c.out.length, 1);
  assert.deepEqual([c.out[0].kind, c.out[0].status, c.out[0].coach_note_text, c.out[0].recommended_goals.calories.max], ['targets', 'pending', 'Slightly less', 2000]);
  assert.doesNotMatch(c.text, /A private word/, 'never the conversation');
});
