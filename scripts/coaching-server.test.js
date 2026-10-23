/**
 * Coaching, phase 1 (connecting), against the real server (server/index.js
 * on a scratch database).
 *
 * - Privacy: every route under /api/coaching/clients/:clientId answers only
 *   the coach with an active pairing. Another coach's client, a pending
 *   request, a declined request, an ended pairing, a non-coach and an admin
 *   who isn't the coach all get nothing. The list of routes is read from
 *   server/routes/coaching.js, so a route added later is tested too.
 * - No coaching answer carries a full user row: people are { id, name }.
 * - Requests, answers, leaving, ending, one coach per client, the Coach
 *   role, role changes ending pairings, invites naming a coach, account
 *   deletion, backup and restore (with a backup from before coaching).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
const TODAY = new Date().toLocaleDateString('sv-SE');
let proc = null, base = null, dir = null;
const tok = {};
const ids = {};

async function call(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok[who]}`;
  const r = await fetch(base + path, { method, headers, body: body == null || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

async function boot() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function login(name) {
  const r = await call(null, 'POST', '/api/auth/login', { username: name, password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  tok[name] = r.data.token;
  ids[name] = r.data.user.id;
}

// Signing in is rate limited per address (ten in 15 minutes), so the other
// accounts get the same token the server signs at sign-in, made here with
// the server's secret.
const JWT_SECRET = 'coaching-test-0123456789abcdef0123456789';
async function makeUser(name, role, full_name) {
  const { user } = await ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, full_name, role });
  const jwt = serverRequire('jsonwebtoken');
  tok[name] = jwt.sign({ id: user.id, username: user.username, role: user.role, csrf: 'x' }, JWT_SECRET, { expiresIn: '1h' });
  ids[name] = user.id;
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'nt-coaching-'));
  await boot();
  await ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
  await login('admin');
  await makeUser('admin2', 'admin', 'Second Admin');
  await makeUser('coach1', 'coach', 'Sam Coach');
  await makeUser('coach2', 'coach', 'Kim Coach');
  await makeUser('client1', 'user', 'Cleo Client');
  await makeUser('client2', 'user', 'Dev Client');
  await makeUser('client3', 'user', 'Eli Client');
  await makeUser('client4', 'user', 'Fay Client');
  await makeUser('plain', 'user', 'Pat Plain');
  // Something for the coach to read.
  await ok('client1', 'PUT', '/api/settings', { key: 'goals', value: { calories: { max: 2000 }, proteins: { min: 30, isPercent: true }, fat: { max: 70 } } });
  await ok('client1', 'PUT', `/api/diary/${TODAY}`, {
    items: [{ uuid: 'i1', name: 'Oats', portion: 60, unit: 'g', quantity: 1, meal: 0, nutrition: { calories: 230, proteins: 8, carbohydrates: 40, fat: 4 } }],
    water: [{ uuid: 'w1', amount: 500 }], body_stats: { weight: 70.5 }, notes: 'Felt good',
  });
});
test.after(() => { proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const request = (coach, client, note) => call(coach, 'POST', '/api/coaching/requests', { client_id: ids[client], note });
// The client's coach, else their newest request (as { id, status, coach }).
const pairingOf = async (client) => {
  const s = await ok(client, 'GET', '/api/coaching/state');
  return s.as_client || (s.requests[0] ? { ...s.requests[0], status: 'pending' } : null);
};

// Routes under /clients/:clientId, read from the source so none is missed.
function clientRoutes() {
  const src = readFileSync(new URL('../server/routes/coaching.js', import.meta.url), 'utf8');
  return [...src.matchAll(/router\.(get|post|put|patch|delete)\('(\/clients\/:clientId[^']*)'/g)].map(([, m, p]) => [m.toUpperCase(), p]);
}
const fill = (p, clientId) => '/api/coaching' + p.replace(':clientId', clientId).replace(':date', TODAY);
// A valid body for every write, so only the guard decides the answer.
let _n = 0;
const bodyFor = (m, p = '') => (m === 'GET' ? undefined
  : /recommendations/.test(p) ? { payload: { goals: { calories: { max: 2000 } } } }
  : { uuid: `privacy-${Date.now()}-${++_n}`, body: 'Hello' });

// Any object that looks like a person must be { id, name } and nothing else.
const ROW_KEYS = ['password_hash', 'email', 'username', 'birthday', 'gender', 'avatar_url', 'full_name', 'nickname', 'role_id'];
function assertNoUserRows(value, where) {
  if (Array.isArray(value)) return value.forEach((v) => assertNoUserRows(v, where));
  if (!value || typeof value !== 'object') return;
  for (const k of ROW_KEYS) assert.ok(!(k in value), `${where}: ${k} leaked in ${JSON.stringify(value).slice(0, 200)}`);
  for (const k of ['coach', 'client']) if (value[k] && typeof value[k] === 'object') assert.deepEqual(Object.keys(value[k]).sort(), ['id', 'name'], `${where}: ${k}`);
  for (const v of Object.values(value)) assertNoUserRows(v, where);
}

test('the server says it supports coaching, and /me says where you stand', { skip: !ready }, async () => {
  assert.equal((await call(null, 'GET', '/api/auth/status')).data.coaching, 1);
  const me = (await call('plain', 'GET', '/api/auth/me')).data;
  assert.deepEqual(me.coaching, { role: 'user', can_coach: false, as_client: null, requests: [], past: [], as_coach: { pending: 0, active: 0, recent: 0, active_ids: [], unread: 0 }, unread: 0, awaiting: 0, recommendations: 0, latest_recommendation: 0 });
  assert.equal((await call('coach1', 'GET', '/api/auth/me')).data.coaching.can_coach, true);
});

test('a request, the answer, and the privacy table for every client route', { skip: !ready }, async () => {
  const routes = clientRoutes();
  assert.ok(routes.length >= 2, 'overview and diary at least');

  // Pending: nothing visible before Accept.
  const req1 = await request('coach1', 'client1', 'Happy to help with your cut');
  assert.equal(req1.status, 200, JSON.stringify(req1.data));
  assertNoUserRows(req1.data, 'POST /requests');
  const pending = await pairingOf('client1');
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.coach, { id: ids.coach1, name: 'Sam Coach' });
  assert.equal(pending.note, 'Happy to help with your cut');
  for (const [m, p] of routes) assert.equal((await call('coach1', m, fill(p, ids.client1), bodyFor(m, p))).status, 404, `pending: ${m} ${p}`);

  await ok('client1', 'POST', `/api/coaching/pairings/${pending.id}/accept`);
  assert.equal((await pairingOf('client1')).status, 'active');

  // Another pairing for the "another coach's client" row.
  const r2 = await request('coach2', 'client2');
  await ok('client2', 'POST', `/api/coaching/pairings/${r2.data.id}/accept`);
  // A declined and an ended one.
  const r3 = await request('coach1', 'client3');
  await ok('client3', 'POST', `/api/coaching/pairings/${r3.data.id}/decline`);
  const r4 = await request('coach1', 'client4');
  await ok('client4', 'POST', `/api/coaching/pairings/${r4.data.id}/accept`);
  await ok('client4', 'POST', `/api/coaching/pairings/${r4.data.id}/end`);

  const table = [
    ['own client', 'coach1', 'client1', 200],
    ["another coach's client", 'coach1', 'client2', 404],
    ['declined request', 'coach1', 'client3', 404],
    ['ended pairing', 'coach1', 'client4', 404],
    ['non-coach', 'plain', 'client1', 403],
    ['the client themself', 'client1', 'client1', 403],
    ["admin who isn't the coach", 'admin2', 'client1', 404],
    ["admin who isn't the coach (other client)", 'admin', 'client2', 404],
    ['a user id that does not exist', 'coach1', null, 404],
    ['signed out', null, 'client1', 401],
  ];
  const rows = [];
  for (const [m, p] of routes) {
    for (const [label, who, client, want] of table) {
      const r = await call(who, m, fill(p, client ? ids[client] : 99999), bodyFor(m, p));
      assert.equal(r.status, want, `${label}: ${m} ${p} -> ${r.status}`);
      if (want === 200) assertNoUserRows(r.data, `${m} ${p}`);
      rows.push(`${m} ${p} | ${label} | ${r.status}`);
    }
  }
  if (process.env.NT_PRIVACY_TABLE) writeFileSync(process.env.NT_PRIVACY_TABLE, rows.join('\n') + '\n');

  // What the coach does see.
  const ov = await ok('coach1', 'GET', `/api/coaching/clients/${ids.client1}/overview?today=${TODAY}`);
  assert.equal(ov.days.length, 7);
  const today = ov.days.at(-1);
  assert.equal(today.date, TODAY);
  assert.equal(today.totals.calories, 230);
  assert.deepEqual(today.targets, { calories: 2000, proteins: 150, carbohydrates: null, fat: 70 });
  assert.equal(ov.last_logged, TODAY);
  assert.deepEqual(ov.weights, [{ date: TODAY, kg: 70.5 }]);
  const day = await ok('coach1', 'GET', `/api/coaching/clients/${ids.client1}/diary/${TODAY}`);
  assert.equal(day.items.length, 1);
  assert.equal(day.items[0].name, 'Oats');
  assert.equal(day.water_ml, 500);
  assert.equal(day.notes, 'Felt good');
  assert.equal((await call('coach1', 'GET', `/api/coaching/clients/${ids.client1}/diary/not-a-date`)).status, 400);

  // The coach's list: active with a week summary, the declined and the
  // client-ended ones for a week; nothing of coach2's.
  const list = await ok('coach1', 'GET', `/api/coaching/clients?today=${TODAY}`);
  // The answers the list still shows are counted, so an admin who coaches keeps the tab.
  const asCoach = (await ok('coach1', 'GET', '/api/coaching/state')).as_coach;
  assert.deepEqual({ pending: asCoach.pending, active: asCoach.active, recent: asCoach.recent }, { pending: 0, active: 1, recent: 2 });
  assertNoUserRows(list, 'GET /clients');
  const byClient = Object.fromEntries(list.map((r) => [r.client.id, r]));
  assert.equal(byClient[ids.client1].status, 'active');
  assert.equal(byClient[ids.client1].last_logged, TODAY);
  assert.equal(byClient[ids.client3].status, 'declined');
  assert.equal(byClient[ids.client4].status, 'ended');
  assert.equal(byClient[ids.client2], undefined);
  assert.equal(new Set(list.map((r) => r.client.id)).size, list.length, 'one row per client');

  // No other coaching answer carries a user row either.
  for (const [who, path] of [['coach1', '/api/coaching/candidates'], ['client1', '/api/coaching/state'], ['admin', '/api/coaching/admin/pairings'], ['admin', '/api/auth/invites']]) {
    assertNoUserRows((await ok(who, 'GET', path)), path);
  }
  const cands = await ok('coach1', 'GET', '/api/coaching/candidates');
  assert.ok(cands.every((c) => Object.keys(c).sort().join() === 'id,name'));
  assert.ok(!cands.some((c) => c.id === ids.client1 || c.id === ids.coach1), 'own clients and self left out');
  assert.ok(cands.some((c) => c.id === ids.client2), 'nothing says who has another coach');

  // Non-coaches can't list, ask or see candidates.
  for (const [m, p] of [['GET', '/api/coaching/clients'], ['GET', '/api/coaching/candidates'], ['POST', '/api/coaching/requests']]) {
    assert.equal((await call('plain', m, p, { client_id: ids.client3 })).status, 403, `${m} ${p}`);
  }
  // Only admins see every pairing.
  assert.equal((await call('coach1', 'GET', '/api/coaching/admin/pairings')).status, 403);
  const all = await ok('admin', 'GET', '/api/coaching/admin/pairings');
  assert.deepEqual(all.map((p) => p.client.id).sort(), [ids.client1, ids.client2].sort());
});

test('asking never says who has a coach; one coach is enforced at Accept', { skip: !ready }, async () => {
  // client1 has coach1. coach2's request to them answers exactly as one to
  // someone with no coach (plain): nothing tells coach2 who is coached.
  const toCoached = await request('coach2', 'client1');
  const toFree = await request('coach2', 'plain');
  assert.equal(toCoached.status, 200);
  assert.equal(toFree.status, 200);
  assert.deepEqual(Object.keys(toCoached.data).sort(), Object.keys(toFree.data).sort());
  assert.equal(toCoached.data.status, 'pending');
  // Asking twice is refused, but only from the coach's own requests.
  const twice = await request('coach2', 'client1');
  assert.equal(twice.status, 409);
  assert.match(twice.data.error, /You already asked/);
  assert.equal((await request('coach1', 'client1')).status, 409, 'already your client');
  assert.equal((await request('coach1', 'coach1')).status, 400, 'no coaching yourself');
  // The client sees both: their coach and the new request, which can't be
  // accepted until they leave their coach.
  const st = await ok('client1', 'GET', '/api/coaching/state');
  assert.equal(st.as_client.coach.id, ids.coach1);
  assert.deepEqual(st.requests.map((r) => r.coach.id), [ids.coach2]);
  const blocked = await call('client1', 'POST', `/api/coaching/pairings/${toCoached.data.id}/accept`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'leave_first');
  assert.equal((await ok('client1', 'GET', '/api/coaching/state')).as_client.coach.id, ids.coach1, 'nothing changed');
  // Several coaches may ask the same person.
  const third = await request('coach1', 'plain');
  assert.equal(third.status, 200);
  assert.deepEqual((await ok('plain', 'GET', '/api/coaching/state')).requests.map((r) => r.coach.id).sort(), [ids.coach1, ids.coach2].sort());
  await ok('plain', 'POST', `/api/coaching/pairings/${toFree.data.id}/decline`);
  await ok('coach1', 'POST', `/api/coaching/pairings/${third.data.id}/end`);
  await ok('client1', 'POST', `/api/coaching/pairings/${toCoached.data.id}/decline`);

  const p = await pairingOf('client1');
  assert.equal(p.status, 'active');
  assert.equal((await call('coach1', 'POST', `/api/coaching/pairings/${p.id}/accept`)).status, 404, 'the coach cannot accept for the client');
  assert.equal((await call('coach2', 'POST', `/api/coaching/pairings/${p.id}/end`)).status, 404, 'another coach cannot end it');
  assert.equal((await call('plain', 'POST', `/api/coaching/pairings/${p.id}/end`)).status, 404);
  assert.equal((await call('client1', 'POST', `/api/coaching/pairings/${p.id}/accept`)).status, 409, 'answered already');

  // An admin can end any pairing; the coach loses the client at once.
  await ok('admin2', 'POST', `/api/coaching/pairings/${p.id}/end`);
  assert.equal(await pairingOf('client1'), null);
  assert.equal((await call('coach1', 'GET', `/api/coaching/clients/${ids.client1}/overview`)).status, 404);
  assert.equal((await call('admin2', 'POST', `/api/coaching/pairings/${p.id}/end`)).status, 409);

  // No coach now: a new request can be accepted.
  const again = await request('coach2', 'client1');
  assert.equal(again.status, 200);
  // The coach can take back a request before it is answered.
  await ok('coach2', 'POST', `/api/coaching/pairings/${again.data.id}/end`);
  assert.equal(await pairingOf('client1'), null);
});

test('the settings refresh carries a coaching fingerprint that changes with a request', { skip: !ready }, async () => {
  const before = (await call('client3', 'GET', '/api/settings')).headers.get('x-nt-coaching');
  assert.ok(before);
  const r = await request('coach2', 'client3');
  const after = (await call('client3', 'GET', '/api/settings')).headers.get('x-nt-coaching');
  assert.notEqual(after, before);
  // The app computes the same fingerprint from the state it holds, so it asks
  // again only when the server's moved.
  const src = readFileSync(new URL('../src/stores/coaching.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function coachingSignature'), src.indexOf('function _save'));
  const appSig = new Function(`${body.replace('export ', '')}; return coachingSignature;`)();
  assert.equal(appSig(await ok('client3', 'GET', '/api/coaching/state')), after);
  assert.equal(appSig(await ok('coach2', 'GET', '/api/coaching/state')), (await call('coach2', 'GET', '/api/settings')).headers.get('x-nt-coaching'));
  await ok('client3', 'POST', `/api/coaching/pairings/${r.data.id}/decline`);
  assert.equal((await call('client3', 'GET', '/api/settings')).headers.get('x-nt-coaching'), before);
});

test('a Coach is a User everywhere else; losing the role ends their coaching', { skip: !ready }, async () => {
  // Coaches can't reach admin routes.
  assert.equal((await call('coach1', 'GET', '/api/auth/users')).status, 403);
  assert.equal((await call('coach1', 'GET', '/api/app-config')).status < 500, true);
  assert.equal((await call('coach1', 'POST', '/api/full-backup')).status, 403);
  // Their own data works as for anyone.
  await ok('coach1', 'PUT', '/api/settings', { key: 'mealNames', value: ['A', 'B'] });
  await ok('coach1', 'GET', '/api/foods');

  const r = await request('coach1', 'client2');
  assert.equal(r.status, 200, 'asking someone with a coach is allowed');
  await ok('coach1', 'POST', `/api/coaching/pairings/${r.data.id}/end`);
  const r5 = await request('coach1', 'client3');
  await ok('client3', 'POST', `/api/coaching/pairings/${r5.data.id}/accept`);
  const change = await ok('admin', 'PUT', `/api/auth/users/${ids.coach1}/role`, { role: 'user' });
  assert.equal(change.coaching_ended, 1);
  assert.equal(await pairingOf('client3'), null);
  assert.equal((await call('coach1', 'GET', '/api/coaching/clients')).status, 403, 'the role is read fresh, not from the token');
  assert.equal((await call('admin', 'PUT', `/api/auth/users/${ids.coach1}/role`, { role: 'trainer' })).status, 400);
  await ok('admin', 'PUT', `/api/auth/users/${ids.coach1}/role`, { role: 'coach' });
  assert.equal((await call('coach1', 'GET', '/api/coaching/clients')).status, 200);

  // An admin made a User stops seeing every pairing at once, whatever the token says.
  await ok('admin', 'PUT', `/api/auth/users/${ids.admin2}/role`, { role: 'user' });
  assert.equal((await call('admin2', 'GET', '/api/coaching/admin/pairings')).status, 403);
  await ok('admin', 'PUT', `/api/auth/users/${ids.admin2}/role`, { role: 'admin' });
  assert.equal((await call('admin2', 'GET', '/api/coaching/admin/pairings')).status, 200);
});

test('an invite can name a coach; the request waits for the new person', { skip: !ready }, async () => {
  assert.equal((await call('admin', 'POST', '/api/auth/invite', { email: 'new@example.com', role: 'user', coach_id: ids.plain })).status, 400, 'not a coach');
  assert.equal((await call('admin', 'POST', '/api/auth/invite', { email: 'x@example.com', role: 'boss' })).status, 400);
  const inv = await ok('admin', 'POST', '/api/auth/invite', { email: 'new@example.com', role: 'user', coach_id: ids.coach1 });
  const token = new URL(inv.inviteUrl.replace('/#/', '/')).searchParams.get('token');
  const listed = (await ok('admin', 'GET', '/api/auth/invites')).find((i) => i.email === 'new@example.com');
  assert.deepEqual(listed.coach, { id: ids.coach1, name: 'Sam Coach' });
  const acc = await call(null, 'POST', '/api/auth/accept-invite', { token, username: 'newbie', password: PW, full_name: 'Nia New' });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  tok.newbie = acc.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('nt_token='))?.slice(9);
  ids.newbie = acc.data.user.id;
  const p = await pairingOf('newbie');
  assert.equal(p.status, 'pending', 'never auto-accepted');
  assert.equal(p.coach.id, ids.coach1);
  assert.equal((await call('coach1', 'GET', `/api/coaching/clients/${ids.newbie}/overview`)).status, 404);
});

test('deleting an account removes its pairings; the other side carries on', { skip: !ready }, async () => {
  const p = await pairingOf('newbie');
  await ok('newbie', 'POST', `/api/coaching/pairings/${p.id}/accept`);
  await ok('newbie', 'DELETE', '/api/auth/me');
  const list = await ok('coach1', 'GET', '/api/coaching/clients');
  assert.ok(!list.some((r) => r.client.id === ids.newbie));
  assert.ok(!(await ok('admin', 'GET', '/api/coaching/admin/pairings')).some((r) => r.client.id === ids.newbie));
  // And a coach's account: their client is free again.
  await makeUser('coach3', 'coach', 'Lee Coach');
  const r = await request('coach3', 'client4');
  await ok('client4', 'POST', `/api/coaching/pairings/${r.data.id}/accept`);
  await ok('admin', 'DELETE', `/api/auth/users/${ids.coach3}`);
  assert.equal(await pairingOf('client4'), null);
  assert.equal((await request('coach2', 'client4')).status, 200);
});

test('backup and restore keep pairings; a backup from before coaching restores', { skip: !ready }, async () => {
  const AdmZip = serverRequire('adm-zip');
  const before = (await ok('admin', 'GET', '/api/coaching/admin/pairings')).map((p) => `${p.coach.id}>${p.client.id}:${p.status}`).sort();
  assert.ok(before.length >= 2);
  const made = await ok('admin', 'POST', '/api/full-backup');
  const zip = new AdmZip(join(dir, 'backups', made.filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  assert.ok(Array.isArray(data.coach_clients) && data.coach_clients.length >= before.length);

  // Change things, restore, and the pairings come back as they were.
  await ok('admin', 'POST', `/api/coaching/pairings/${(await pairingOf('client2')).id}/end`);
  await ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(made.filename)}/restore`);
  const after = (await ok('admin', 'GET', '/api/coaching/admin/pairings')).map((p) => `${p.coach.id}>${p.client.id}:${p.status}`).sort();
  assert.deepEqual(after, before);

  // A 1.4 backup: no coach_clients, invites without coach_id.
  delete data.coach_clients;
  delete data.coach_messages;
  for (const i of data.invite_tokens || []) delete i.coach_id;
  const old = new AdmZip();
  old.addFile('database.json', Buffer.from(JSON.stringify(data)));
  const oldName = 'nutritrace-backup-2026-01-01T00-00-00.zip';
  old.writeZip(join(dir, 'backups', oldName));
  await ok('admin', 'POST', `/api/full-backup/${oldName}/restore`);
  assert.deepEqual(await ok('admin', 'GET', '/api/coaching/admin/pairings'), []);
  assert.equal((await ok('client1', 'GET', '/api/coaching/state')).as_client, null);
  assert.equal((await call('client1', 'GET', `/api/diary/${TODAY}`)).status, 200);
});
