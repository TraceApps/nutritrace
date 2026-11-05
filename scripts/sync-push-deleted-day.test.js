/**
 * POST /api/sync/push meeting a diary day deleted elsewhere, and pushed
 * rows whose times can't be read, on a real server (server/index.js,
 * scratch database).
 *
 * A day deleted on the web came back with any push of that day: the
 * push wrote deleted_at = NULL whatever it held and whenever it was made.
 * A day now follows the rule every synced row does (lib/field-sync.js
 * editRevives): a push made after the delete that changes something
 * brings it back; one made before it, one that changes nothing (an item
 * deleted offline), or one with no readable updated_at leaves it deleted,
 * and the day is touched so the phone's next pull takes the delete. An
 * item or water entry logged or changed after the delete brings the day
 * back by its own time, whatever the day's says. A pushed delete of a
 * day made before a later edit there loses.
 *
 * A setting deleted elsewhere came back with a push that had no readable
 * time (it counted as made now). And a time far out of range (1e20, the
 * year -271821) made the push fail as a whole.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* not built for this Node */ }
const skip = t => { if (!ready) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };

const dir = ready ? mkdtempSync(join(tmpdir(), 'nt-push-deleted-day-')) : null;
let server = null, base = null, token = null, sqlite = null, me = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function call(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}
async function api(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}
const push = body => api('POST', '/api/sync/push', { foods: [], meals: [], diary: [], activity: [], fasts: [], wellness: [], settings: [], workouts: [], ...body });
const day = date => sqlite.prepare('SELECT * FROM diary WHERE user_id = ? AND date = ?').get(me, date);
const uuids = row => JSON.parse(row?.items || '[]').map(i => i.uuid).sort();
const item = (uuid, extra = {}) => ({ uuid, name: uuid, nutrition: { calories: 100 }, portion: 100, unit: 'g', quantity: 1, meal: 0, ...extra });
const iso = ms => new Date(ms).toISOString();

test.before(async () => {
  if (!ready) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'push-deleted-day-secret-0123456789abcdef', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  await api('POST', '/api/auth/register', { username: 'dora', password: 'Str0ng-Pass-77!x' });
  token = (await api('POST', '/api/auth/login', { username: 'dora', password: 'Str0ng-Pass-77!x' })).token;
  me = (await api('GET', '/api/auth/me')).user.id;
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  sqlite = new Database(join(dir, 'server.db'));
});
test.after(() => {
  try { sqlite?.close(); } catch {}
  try { server?.kill(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// A day with one item on the server, deleted on the web; `before`: a time
// a moment before the delete, `after` one a moment after it.
async function deletedDay(date) {
  await api('PUT', `/api/diary/${date}`, { items: [item(`${date}-old`)], body_stats: {}, water: [] });
  const before = Date.now() - 1000;
  await sleep(1100);
  await api('DELETE', `/api/diary/${date}`);
  const del = day(date);
  assert.ok(del.deleted_at);
  await sleep(1100);
  return { before, after: Date.now(), del };
}

test('a day pushed with an edit made before the web deleted it stays deleted, and the phone hears of the delete', async (t) => {
  if (skip(t)) return;
  const D = '2026-06-01';
  const { before, del } = await deletedDay(D);
  const now = iso(Date.now());
  await push({ client_now: now, diary: [{ date: D, items: [item(`${D}-old`, { addedAt: iso(before - 5000) })], body_stats: {}, water: [], updated_at: iso(before) }] });
  const row = day(D);
  assert.ok(row.deleted_at, 'still deleted');
  const pulled = (await api('GET', `/api/sync/pull?since=${encodeURIComponent(del.updated_at.replace(' ', 'T') + 'Z')}`)).diary.find(d => d.date === D);
  assert.ok(pulled?.deleted_at, 'the next pull brings the delete');
});

test('a day pushed with no readable updated_at stays deleted', async (t) => {
  if (skip(t)) return;
  for (const [i, updated_at] of [[2, undefined], [3, null], [4, ''], [5, 'soon']]) {
    const D = `2026-06-0${i}`;
    await deletedDay(D);
    await push({ diary: [{ date: D, items: [item(`${D}-old`)], body_stats: {}, water: [], ...(updated_at === undefined ? {} : { updated_at }) }] });
    assert.ok(day(D).deleted_at, `updated_at ${JSON.stringify(updated_at)}: still deleted`);
  }
});

test('an item deleted offline from a day deleted on the web does not bring the day back', async (t) => {
  if (skip(t)) return;
  const D = '2026-06-10';
  await deletedDay(D);
  // The phone's tombstone-only row: what it has deleted, sent as made now.
  await push({ client_now: iso(Date.now()), diary: [{ date: D, items: [], body_stats: {}, water: [], deleted_uuids: { items: [`${D}-old`], water: [] }, updated_at: iso(Date.now()) }] });
  assert.ok(day(D).deleted_at, 'still deleted');
});

test('a day pushed after the delete with something new comes back with it', async (t) => {
  if (skip(t)) return;
  const D = '2026-06-11';
  const { after } = await deletedDay(D);
  await push({ client_now: iso(Date.now()), diary: [{ date: D, items: [item(`${D}-old`), item(`${D}-new`, { addedAt: iso(after) })], body_stats: {}, water: [], updated_at: iso(after) }] });
  const row = day(D);
  assert.equal(row.deleted_at, null);
  assert.deepEqual(uuids(row), [`${D}-new`, `${D}-old`]);
});

test('an item logged after the delete brings the day back by its own time, even with no readable day time', async (t) => {
  if (skip(t)) return;
  const D = '2026-06-12';
  const { before, after } = await deletedDay(D);
  await push({ client_now: iso(Date.now()), diary: [{ date: D, items: [item(`${D}-new`, { addedAt: iso(after) })], body_stats: {}, water: [], updated_at: iso(before) }] });
  assert.equal(day(D).deleted_at, null, 'day time before the delete');
  assert.deepEqual(uuids(day(D)), [`${D}-new`, `${D}-old`]);
  const E = '2026-06-13';
  const e = await deletedDay(E);
  await push({ diary: [{ date: E, items: [], body_stats: {}, water: [{ uuid: `${E}-w`, amount: 250, addedAt: iso(e.after) }] }] });
  assert.equal(day(E).deleted_at, null, 'no day time at all');
  assert.deepEqual(JSON.parse(day(E).water).map(w => w.uuid), [`${E}-w`]);
});

test("a pushed delete of a day made before a later edit there loses; one made after it goes ahead", async (t) => {
  if (skip(t)) return;
  const D = '2026-06-14';
  await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-a`)], body_stats: {}, water: [] });
  const before = Date.now() - 2000;
  await sleep(1100);
  await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-a`), item(`${D}-b`)], body_stats: {}, water: [] });
  await sleep(1100);
  await push({ client_now: iso(Date.now()), diary: [{ date: D, updated_at: iso(before), deleted_at: iso(before) }] });
  assert.equal(day(D).deleted_at, null, 'the later edit stays');
  await push({ client_now: iso(Date.now()), diary: [{ date: D, updated_at: iso(Date.now()), deleted_at: iso(Date.now()) }] });
  assert.ok(day(D).deleted_at, 'a newer delete goes ahead');
  // A client that doesn't send its clock: its time can't be set against the
  // server's writes, so its delete counts as made now, as before.
  const E = '2026-06-15';
  await api('PUT', `/api/diary/${E}`, { items: [item(`${E}-a`)], body_stats: {}, water: [] });
  await push({ diary: [{ date: E, updated_at: iso(Date.now() - 3_600_000), deleted_at: iso(Date.now()) }] });
  assert.ok(day(E).deleted_at, 'no client_now: made now');
});

test('a setting deleted on the server stays deleted for a push with no readable time', async (t) => {
  if (skip(t)) return;
  await push({ client_now: iso(Date.now()), settings: [{ key: 'waterGoalMl', value: 1800, updated_at: iso(Date.now()) }] });
  await sleep(1100);
  await push({ client_now: iso(Date.now()), settings: [{ key: 'waterGoalMl', value: 1800, deleted_at: iso(Date.now()), updated_at: iso(Date.now()) }] });
  const get = () => sqlite.prepare("SELECT value, deleted_at FROM user_settings WHERE user_id = ? AND key = 'waterGoalMl'").get(me);
  assert.ok(get().deleted_at);
  await sleep(1100);
  await push({ settings: [{ key: 'waterGoalMl', value: 2400 }] });
  assert.ok(get().deleted_at, 'no time: stays deleted');
  await push({ client_now: iso(Date.now()), settings: [{ key: 'waterGoalMl', value: 2600, updated_at: iso(Date.now()) }] });
  assert.deepEqual(get(), { value: '2600', deleted_at: null }, 'a later edit with its time brings it back');
});

test('a pushed time far out of range never fails the push', async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Range Oats', nutrition: { calories: 10 } });
  const bad = [1e20, -1e20, '1e20', '-1e20', '+275760-09-13T00:00:00.000Z', '-271821-04-20T00:00:00.000Z', '9999-12-31T23:59:59Z', '0000-01-01T00:00:00Z'];
  // A phone a minute fast, and one a minute slow: the clock shift can push
  // a time past the end of the range.
  for (const skew of [60_000, -60_000]) {
    for (const v of bad) {
      const r = await call('POST', '/api/sync/push', {
        client_now: iso(Date.now() + skew),
        foods: [{ client_id: 1, server_id: f.id, name: 'Range Oats', updated_at: v, field_edits: { name: v } },
          { client_id: 2, name: `New ${v}`, updated_at: v, client_key: `k-${skew}-${v}` }],
        meals: [], activity: [{ client_id: 3, name: 'Walk', date: '2026-06-20', kcal: 50, updated_at: v, client_key: `a-${skew}-${v}` }],
        fasts: [{ client_id: 4, start_at: '2026-06-20T08:00:00Z', updated_at: v, client_key: `f-${skew}-${v}` }],
        diary: [{ date: '2026-06-21', items: [item(`r-${skew}-${v}`, { addedAt: v })], water: [], body_stats: { weight: 70 }, body_stats_edits: { weight: v }, notes: `n ${v}`, notes_updated_at: v, updated_at: v }],
        wellness: [], workouts: [], settings: [{ key: 'waterUnit', value: 'ml', updated_at: v }],
      });
      assert.equal(r.status, 200, `updated_at ${JSON.stringify(v)}, clock ${skew}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }
});
