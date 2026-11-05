/**
 * PUT /api/diary/:date (the web's diary, the Android app online) into a day
 * deleted elsewhere, on a real server (server/index.js, scratch database).
 *
 * The save brought the day back with every item, water entry and
 * measurement deleted with it: the merge started from the deleted day's
 * contents. A save is made now, so it brings the day back
 * (lib/field-sync.js editRevives), but only with what was made after the
 * delete: an item or water entry logged or changed since (its own
 * updatedAt, else addedAt; one with no time that the deleted day didn't
 * hold is new), and the measurements and note the save sends. What the
 * deleted day held, and an older copy of it a stale form sends, stays
 * deleted (tombstoned, so a phone's older push can't put it back either).
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

const dir = ready ? mkdtempSync(join(tmpdir(), 'nt-put-deleted-day-')) : null;
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
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'put-deleted-day-secret-0123456789abcdef', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  await api('POST', '/api/auth/register', { username: 'pia', password: 'Str0ng-Pass-77!x' });
  token = (await api('POST', '/api/auth/login', { username: 'pia', password: 'Str0ng-Pass-77!x' })).token;
  me = (await api('GET', '/api/auth/me')).user.id;
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  sqlite = new Database(join(dir, 'server.db'));
});
test.after(() => {
  try { sqlite?.close(); } catch {}
  try { server?.kill(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});


const ago = ms => iso(Date.now() - ms);
async function deletedDay(date, extra = {}) {
  await api('PUT', `/api/diary/${date}`, { items: [item(`${date}-a`, { addedAt: ago(60_000) }), item(`${date}-b`, { addedAt: ago(60_000) })], body_stats: { weight: 80 }, water: [{ uuid: `${date}-w`, amount: 250 }], notes: 'old note', ...extra });
  await sleep(1100);
  await api('DELETE', `/api/diary/${date}`);
  assert.ok(day(date).deleted_at);
  await sleep(1100);
}
const waters = row => JSON.parse(row?.water || '[]').map(w => w.uuid).sort();
const stats = row => JSON.parse(row?.body_stats || '{}');

test('a food logged on the web into a deleted day brings back only that food', async (t) => {
  if (skip(t)) return;
  const D = '2026-07-01';
  await deletedDay(D);
  const r = await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-new`, { addedAt: iso(Date.now()) })], body_stats: {}, water: [] });
  const row = day(D);
  assert.equal(row.deleted_at, null, 'the day is back');
  assert.deepEqual(uuids(row), [`${D}-new`], 'with the new food only');
  assert.deepEqual(waters(row), []);
  assert.deepEqual(stats(row), {}, "the deleted day's weight stays deleted");
  assert.equal(row.notes, null, "and its note");
  assert.deepEqual(r.items.map(i => i.uuid), [`${D}-new`], 'the answer says so');
});

test("a stale form's older copy stays deleted; what it logged or changed since comes back", async (t) => {
  if (skip(t)) return;
  const D = '2026-07-02';
  await deletedDay(D);
  await api('PUT', `/api/diary/${D}`, {
    items: [item(`${D}-a`, { addedAt: ago(70_000) }), item(`${D}-b`, { addedAt: ago(70_000), updatedAt: iso(Date.now()), quantity: 2 }), item(`${D}-new`, { addedAt: iso(Date.now()) }), item(`${D}-untimed`)],
    water: [{ uuid: `${D}-w`, amount: 250 }, { uuid: `${D}-w2`, amount: 500 }],
    body_stats: {},
  });
  const row = day(D);
  assert.deepEqual(uuids(row), [`${D}-b`, `${D}-new`, `${D}-untimed`], 'changed since, new, and new with no time of its own');
  assert.deepEqual(waters(row), [`${D}-w2`], "the deleted day's water stays deleted, new water comes back");
  // A phone's older push of the day can't put the deleted ones back.
  await push({ client_now: iso(Date.now()), diary: [{ date: D, items: [item(`${D}-a`, { addedAt: ago(70_000) })], water: [{ uuid: `${D}-w`, amount: 250 }], body_stats: {}, updated_at: ago(2_000_000) }] });
  assert.deepEqual(uuids(day(D)), [`${D}-b`, `${D}-new`, `${D}-untimed`]);
  assert.deepEqual(waters(day(D)), [`${D}-w2`]);
});

test('measurements a save into a deleted day sends come back; the rest stay deleted', async (t) => {
  if (skip(t)) return;
  const D = '2026-07-03';
  await deletedDay(D, { body_stats: { weight: 80, body_fat: 25 } });
  await api('PUT', `/api/diary/${D}`, { items: [], water: [], body_stats: { weight: 80, body_fat: 20 }, body_stats_changed: ['body_fat'] });
  assert.deepEqual(stats(day(D)), { body_fat: 20 }, 'only the one it changed');
  assert.equal(day(D).deleted_at, null);
});

test('a save into a day that is not deleted merges as before', async (t) => {
  if (skip(t)) return;
  const D = '2026-07-04';
  await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-a`, { addedAt: ago(60_000) })], body_stats: { weight: 80 }, water: [] });
  await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-b`, { addedAt: iso(Date.now()) })], body_stats: {}, water: [] });
  assert.deepEqual(uuids(day(D)), [`${D}-a`, `${D}-b`]);
  assert.deepEqual(stats(day(D)), { weight: 80 });
});

test('a new food is never lost: a slow clock, or the second of the delete, still brings it back', async (t) => {
  if (skip(t)) return;
  const D = '2026-07-05';
  await deletedDay(D);
  // Logged on a laptop whose clock runs ten minutes slow: its time reads
  // as before the delete, but the deleted day never held it.
  const r = await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-slow`, { addedAt: ago(600_000) })], body_stats: {}, water: [] });
  assert.deepEqual(uuids(day(D)), [`${D}-slow`]);
  assert.ok(!(r.tombstones?.items || []).includes(`${D}-slow`), 'and it is no tombstone');
});

test("the app's Upload puts a deleted day back whole, as before", async (t) => {
  if (skip(t)) return;
  const D = '2026-07-06';
  await deletedDay(D);
  await api('PUT', `/api/diary/${D}`, { history_upload: true, items: [item(`${D}-a`, { addedAt: ago(70_000) }), item(`${D}-b`, { addedAt: ago(70_000) })], body_stats: { weight: 80 }, water: [{ uuid: `${D}-w`, amount: 250 }] });
  assert.deepEqual(uuids(day(D)), [`${D}-a`, `${D}-b`]);
  assert.deepEqual(waters(day(D)), [`${D}-w`]);
  assert.deepEqual(stats(day(D)), { weight: 80 });
});

test("the deleted day's note and measurements don't come back with a phone's older push", async (t) => {
  if (skip(t)) return;
  const D = '2026-07-07';
  await deletedDay(D);
  await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-new`, { addedAt: iso(Date.now()) })], body_stats: {}, water: [] });
  // A phone's edits from before the delete, sent now.
  await push({ client_now: iso(Date.now()), diary: [{ date: D, items: [], water: [], body_stats: { weight: 81 }, body_stats_changed: ['weight'], notes: 'phone note', notes_updated_at: ago(2_500_000), updated_at: ago(2_500_000) }] });
  assert.equal(day(D).notes, null, 'the older note loses to the delete');
  assert.deepEqual(stats(day(D)), {}, 'and the older weight');
  // One made after the delete comes back.
  await push({ client_now: iso(Date.now()), diary: [{ date: D, items: [], water: [], body_stats: { weight: 82 }, body_stats_changed: ['weight'], notes: 'new note', notes_updated_at: iso(Date.now()), updated_at: iso(Date.now()) }] });
  assert.equal(day(D).notes, 'new note');
  assert.deepEqual(stats(day(D)), { weight: 82 });
});

test("a stale form's whole-day save leaves the deleted note, measurements and completion marks deleted", async (t) => {
  if (skip(t)) return;
  const D = '2026-07-08';
  await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-a`, { addedAt: ago(60_000) })], body_stats: { weight: 80 }, water: [], notes: 'old note' });
  await api('PUT', `/api/diary/${D}/completion`, { completed: true });
  await api('PUT', `/api/diary/${D}/meal-completion`, { slot: 1, completed: true });
  await sleep(1100);
  await api('DELETE', `/api/diary/${D}`);
  await sleep(1100);
  // The web's water add from the day it still shows: the whole day, no times.
  await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-a`, { addedAt: ago(60_000) })], body_stats: { weight: 80, body_fat: 21 }, notes: 'old note', water: [{ uuid: `${D}-w-new`, amount: 300 }] });
  const row = day(D);
  assert.deepEqual(uuids(row), []);
  assert.deepEqual(waters(row), [`${D}-w-new`]);
  assert.deepEqual(stats(row), { body_fat: 21 }, 'the old weight stays deleted, a new measurement comes back');
  assert.equal(row.notes, null);
  assert.equal(row.completed_at, null, 'the day is no longer marked complete');
  assert.equal(row.completed_meals, null);
  // An older mark sent afterwards loses to the delete.
  await api('PUT', `/api/diary/${D}/completion`, { completed: true, at: ago(2_000_000) });
  assert.equal(day(D).completed_at, null);
});

test('an item stored without a uuid comes back from its echo only when changed after the delete', async (t) => {
  if (skip(t)) return;
  const D = '2026-07-09';
  const at = ago(60_000);
  await api('PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [] });
  // As an MCP or REST write stores it: no uuid.
  sqlite.prepare('UPDATE diary SET items = ? WHERE user_id = ? AND date = ?').run(JSON.stringify([{ name: 'Mcp Toast', nutrition: { calories: 90 }, quantity: 1, meal: 0, addedAt: at }]), me, D);
  await sleep(1100);
  await api('DELETE', `/api/diary/${D}`);
  await sleep(1100);
  await api('PUT', `/api/diary/${D}`, { items: [{ name: 'Mcp Toast', nutrition: { calories: 90 }, quantity: 1, meal: 0, addedAt: at }, item(`${D}-new`, { addedAt: iso(Date.now()) })], body_stats: {}, water: [] });
  assert.deepEqual(JSON.parse(day(D).items).map(i => i.name), [`${D}-new`]);
});

test('a completion mark made after the delete stays when the day comes back', async (t) => {
  if (skip(t)) return;
  const D = '2026-07-10';
  await deletedDay(D);
  await api('PUT', `/api/diary/${D}/completion`, { completed: true });
  await api('PUT', `/api/diary/${D}/meal-completion`, { slot: 2, completed: true });
  await api('PUT', `/api/diary/${D}`, { items: [], body_stats: {}, water: [{ uuid: `${D}-w-new`, amount: 300 }] });
  assert.ok(day(D).completed_at, 'the day mark made after the delete stays');
  assert.deepEqual(JSON.parse(day(D).completed_meals), [2]);
});
