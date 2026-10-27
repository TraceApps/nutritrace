/**
 * Webhooks and the Android app's Upload, against the real server
 * (server/index.js on a scratch database) and a local receiver that checks
 * each delivery's signature.
 *
 * A phone used without a server keeps its diary on the phone. When it
 * connects to a server, Upload (src/lib/migrate.js) sends that history
 * through the app's own routes: its settings (goals among them), then one
 * PUT /api/diary/:date per day. Every one of those saves sent its webhooks
 * as if it had just been logged: a meal.logged, water.logged and
 * body_stat.logged per day, and a goal.achieved for every goal each day
 * reached.
 *
 * Now an Upload's days send none. The app marks them `history_upload`.
 * Ordinary saves, online or sent again, still send theirs once.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
// Opened, not just required: a binding built for another Node version
// loads only when a database opens.
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
const EVENTS = ['meal.logged', 'water.logged', 'body_stat.logged', 'goal.achieved'];
let proc = null, base = null, dir = null, receiver = null, hookUrl = null;
const secrets = new Set();
const deliveries = [];

async function call(auth, method, path, body) {
  const h = { 'Content-Type': 'application/json' };
  if (auth) h.Authorization = `Bearer ${auth}`;
  const r = await fetch(base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

// Every delivery `fn` caused, by event. Delivery is fire-and-forget, so
// this waits for the receiver to go quiet.
async function sent(fn) {
  const from = deliveries.length;
  const out = await fn();
  let last = -1;
  for (let i = 0; i < 40 && deliveries.length !== last; i++) { last = deliveries.length; await sleep(150); }
  const got = deliveries.slice(from);
  for (const d of got) assert.ok(d.signed, `${d.event} delivery carries a valid signature`);
  const count = Object.fromEntries(EVENTS.map(e => [e, got.filter(d => d.event === e).length]));
  return { out, got, count, total: got.length };
}

// A new account with a webhook for every event. The first account
// registers itself (and is an admin, as webhooks need); it makes the rest
// as admins.
let n = 0, admin = null;
async function account() {
  const username = `eater${++n}`;
  const reg = await call(admin, 'POST', '/api/auth/register', { username, password: PW, role: 'admin' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const login = await call(null, 'POST', '/api/auth/login', { username, password: PW });
  const token = login.data.token;
  assert.ok(token, JSON.stringify(login.data));
  if (!admin) admin = token;
  const hook = await call(token, 'POST', '/api/admin/webhooks', { url: `${hookUrl}/hook`, events: EVENTS });
  assert.ok(hook.data.secret, JSON.stringify(hook.data));
  secrets.add(hook.data.secret);
  return token;
}

const item = (uuid, calories) => ({ uuid, name: `Food ${uuid}`, quantity: 1, nutrition: { calories, proteins: 40, carbohydrates: 200, fat: 50 } });

// The phone's history as migrate.js reads it: goals among its settings, and
// eight days, each with a meal that reaches the calorie goal, a water entry
// that reaches the water goal, and a weigh-in.
function history() {
  const settings = { goals: { calories: 2000 }, waterGoalMl: 2000 };
  const diary = [];
  for (let i = 1; i <= 8; i++) {
    const date = `2026-03-0${i}`;
    diary.push({
      date,
      items: [item(`it-${i}`, 2100)],
      water: [{ uuid: `wa-${i}`, amount: 2000, time: `${date}T08:00:00` }],
      body_stats: { weight: 82 - i * 0.2 },
      notes: i === 1 ? 'first day' : '',
    });
  }
  return { settings, diary };
}

// Upload as migrate.js sends it: settings one at a time, then a PUT per day
// (its note only when it has one). `marked`: this app marks the days
// (history_upload); 1.5.0-dev02 and earlier don't.
async function upload(token, h, { marked = true } = {}) {
  for (const [key, value] of Object.entries(h.settings)) {
    const r = await call(token, 'PUT', '/api/settings', { key, value });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  for (const d of h.diary) {
    const r = await call(token, 'PUT', `/api/diary/${d.date}`, {
      items: d.items, body_stats: d.body_stats, water: d.water,
      ...(d.notes ? { notes: d.notes } : {}),
      ...(marked ? { history_upload: true } : {}),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'nt-history-upload-'));
  const hookPort = await freePort();
  hookUrl = `http://127.0.0.1:${hookPort}`;
  receiver = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let env = {};
      try { env = JSON.parse(raw); } catch { /* counted as unsigned below */ }
      const sig = req.headers['x-nutritrace-signature'];
      const signed = [...secrets].some(s => sig === `sha256=${createHmac('sha256', s).update(raw).digest('hex')}`);
      deliveries.push({ event: env.event, data: env.data, signed });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(hookPort, '127.0.0.1', r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'history-upload-test-0123456789abcdef0123',
      INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1', API_RATE_LIMIT_PER_MIN: '1000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    if (i >= 300) throw new Error('server did not start');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
});

test.after(async () => {
  if (proc) {
    const p = proc; proc = null;
    await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); });
  }
  if (receiver) await new Promise((r) => receiver.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const opts = { skip: !ready && 'server packages not installed' };
const none = Object.fromEntries(EVENTS.map(e => [e, 0]));

test('Upload of a phone\'s diary sends no webhooks, and uploading again sends none', opts, async () => {
  const token = await account();
  const h = history();
  const first = await sent(() => upload(token, h));
  assert.deepEqual(first.count, none, 'the first Upload');
  const again = await sent(() => upload(token, h));
  assert.deepEqual(again.count, none, 'the same Upload again');
  // It all went up.
  const day = (await call(token, 'GET', '/api/diary/2026-03-08')).data;
  assert.equal(day.items.length, 1);
  assert.equal(day.water.length, 1);
  // Something logged now, after the Upload, still sends once.
  const next = await sent(() => call(token, 'PUT', '/api/diary/2026-04-01', { items: [item('new-1', 300)], body_stats: {}, water: [] }));
  assert.equal(next.out.status, 200, JSON.stringify(next.out.data));
  assert.equal(next.count['meal.logged'], 1);
  assert.equal(next.count['goal.achieved'], 0);
});

test('an earlier app\'s Upload (not marked) still sends, as documented', opts, async () => {
  const token = await account();
  const first = await sent(() => upload(token, history(), { marked: false }));
  assert.equal(first.count['meal.logged'], 8);
});

test('a connected phone\'s or the web\'s saves still send once, and a save sent again sends none', opts, async () => {
  const token = await account();
  await call(token, 'PUT', '/api/settings', { key: 'goals', value: { calories: 2000 } });
  await call(token, 'PUT', '/api/settings', { key: 'waterGoalMl', value: 2000 });
  const body = { items: [item('a-1', 2100)], body_stats: { weight: 80 }, water: [{ uuid: 'w-1', amount: 2000, time: '2026-05-01T08:00:00' }] };
  const online = await sent(() => call(token, 'PUT', '/api/diary/2026-05-01', body));
  assert.equal(online.out.status, 200, JSON.stringify(online.out.data));
  assert.deepEqual(online.count, { 'meal.logged': 1, 'water.logged': 1, 'body_stat.logged': 1, 'goal.achieved': 2 });
  // The same save again (its answer was lost, or the sync sends it again).
  const replay = await sent(() => call(token, 'PUT', '/api/diary/2026-05-01', body));
  assert.deepEqual(replay.count, none);
  // Only `history_upload: true` marks a save as history.
  const other = await sent(() => call(token, 'PUT', '/api/diary/2026-05-02', { ...body, items: [item('a-2', 100)], water: [], history_upload: 'yes' }));
  assert.equal(other.count['meal.logged'], 1);
});

test('adding to an uploaded day afterwards sends what a save sends', opts, async () => {
  const token = await account();
  const h = history();
  await sent(() => upload(token, h));
  const d = h.diary[7];
  const add = await sent(() => call(token, 'PUT', `/api/diary/${d.date}`, { items: [...d.items, item('later', 50)], body_stats: d.body_stats, water: d.water }));
  assert.equal(add.out.status, 200, JSON.stringify(add.out.data));
  assert.deepEqual(add.count, { ...none, 'meal.logged': 1 });
  assert.deepEqual(add.got.find(x => x.event === 'meal.logged').data.items.map(i => i.uuid), ['later']);
});

test('the app\'s Upload marks its diary days as history', () => {
  const src = readFileSync(new URL('../src/lib/migrate.js', import.meta.url), 'utf8');
  const at = src.indexOf('await _put(day, headers, {');
  assert.ok(at > 0, 'the diary PUT');
  const put = src.slice(at, src.indexOf('});', at));
  assert.match(put, /history_upload: true/, 'the diary goes up marked');
});
