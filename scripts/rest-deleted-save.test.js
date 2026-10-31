/**
 * A save sent straight to the server (PUT /api/foods/:id, /api/meals/:id:
 * the web's editors, the Android app online) of a food, meal or recipe
 * that was deleted elsewhere, on a real server (server/index.js, scratch
 * database).
 *
 * Before, the save wrote its fields into the deleted row, left it deleted
 * and answered as if it had landed; the next push of the same change
 * changed nothing, so the server kept the delete and the save was lost
 * without a word. Now it follows the rule a push of the same change
 * follows (lib/field-sync.js editRevives): a save is made now, so one that
 * changes something brings the row back; one that changes nothing, or that
 * comes in the second the row was deleted, doesn't, and is refused as gone
 * (410, `gone: true`, as LiftTrace answers a save made before a delete).
 * Activities and fasts already answer 404 for a deleted row.
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

const dir = ready ? mkdtempSync(join(tmpdir(), 'nt-rest-deleted-')) : null;
let server = null, base = null, token = null, sqlite = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function call(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
async function api(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}
const pull = () => api('GET', '/api/sync/pull?since=1970-01-01T00:00:00.000Z');
const row = (table, id) => sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

test.before(async () => {
  if (!ready) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'rest-deleted-test-secret-0123456789abcdef', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  await api('POST', '/api/auth/register', { username: 'ida', password: 'Str0ng-Pass-77!x' });
  token = (await api('POST', '/api/auth/login', { username: 'ida', password: 'Str0ng-Pass-77!x' })).token;
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  sqlite = new Database(join(dir, 'server.db'));
});
test.after(() => {
  try { sqlite?.close(); } catch {}
  try { server?.kill(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const KINDS = {
  foods: {
    path: '/api/foods', pulled: 'foods',
    make: () => api('POST', '/api/foods', { name: 'Rest Oats', brand: 'Mill', nutrition: { calories: 380 }, portion: 100, unit: 'g' }),
  },
  meals: {
    path: '/api/meals', pulled: 'meals',
    make: () => api('POST', '/api/meals', { name: 'Rest Porridge', nutrition: { calories: 300 }, items: [], portion: 100, unit: 'g' }),
  },
  recipes: {
    path: '/api/meals', pulled: 'meals', table: 'meals',
    make: () => api('POST', '/api/meals', { name: 'Rest Stew', is_recipe: 1, nutrition: { calories: 200 }, items: [], portion: 100, unit: 'g', servings: 2 }),
  },
};

for (const [kind, k] of Object.entries(KINDS)) {
  const table = k.table || kind;

  test(`${kind}: a save that changes something, made after the row was deleted elsewhere, brings it back with the change`, async (t) => {
    if (skip(t)) return;
    const made = await k.make();
    await api('DELETE', `${k.path}/${made.id}`);
    await sleep(1100);
    const r = await call('PUT', `${k.path}/${made.id}`, { ...made, notes: 'Saved after the delete', changed_fields: ['notes'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.notes, 'Saved after the delete');
    assert.equal(r.body.deleted_at, null, 'the answer is the row, back');
    const got = row(table, made.id);
    assert.equal(got.deleted_at, null);
    assert.equal(got.notes, 'Saved after the delete');
    // The row is stamped as brought back at the save, so a delete made
    // before it (a phone's, offline) can't take it away again.
    assert.ok(Date.parse(JSON.parse(got.field_times).deleted_at) >= Date.now() - 5000, 'brought back now');
    // Every device's next pull gets it, alive.
    const p = (await pull())[k.pulled].find(x => x.id === made.id);
    assert.equal(p.deleted_at, null);
    assert.equal(p.notes, 'Saved after the delete');
    // And the push of the same change, from a phone that made it, changes nothing more.
    const back = await api('POST', '/api/sync/push', { client_now: new Date().toISOString(), [kind === 'foods' ? 'foods' : 'meals']: [{ client_id: 1, server_id: made.id, notes: 'Saved after the delete', updated_at: new Date().toISOString(), changed_fields: ['notes'] }] });
    assert.equal((back[kind === 'foods' ? 'foods' : 'meals'][0].row), undefined, 'nothing to hand back');
    assert.equal(row(table, made.id).deleted_at, null);
  });

  test(`${kind}: only the fields the save says it changed go into the row it brings back`, async (t) => {
    if (skip(t)) return;
    const made = await k.make();
    await api('DELETE', `${k.path}/${made.id}`);
    await sleep(1100);
    // A form opened on the old copy: its other fields are the old values.
    const r = await call('PUT', `${k.path}/${made.id}`, { ...made, name: 'Never saved', notes: 'Just the note', changed_fields: ['notes'] });
    assert.equal(r.status, 200);
    const got = row(table, made.id);
    assert.deepEqual({ name: got.name, notes: got.notes, deleted_at: got.deleted_at }, { name: made.name, notes: 'Just the note', deleted_at: null });
  });

  test(`${kind}: a whole save from an older page (no changed_fields) brings the row back with what it sends`, async (t) => {
    if (skip(t)) return;
    const made = await k.make();
    await api('DELETE', `${k.path}/${made.id}`);
    await sleep(1100);
    const r = await call('PUT', `${k.path}/${made.id}`, { ...made, name: 'Renamed whole', notes: 'whole save' });
    assert.equal(r.status, 200);
    assert.deepEqual({ name: row(table, made.id).name, deleted_at: row(table, made.id).deleted_at }, { name: 'Renamed whole', deleted_at: null });
  });

  test(`${kind}: a save that changes nothing doesn't bring a deleted row back; it is refused as gone`, async (t) => {
    if (skip(t)) return;
    const made = await k.make();
    await api('DELETE', `${k.path}/${made.id}`);
    await sleep(1100);
    const before = row(table, made.id);
    const r = await call('PUT', `${k.path}/${made.id}`, { ...made });
    assert.equal(r.status, 410);
    assert.equal(r.body.gone, true);
    const after = row(table, made.id);
    assert.equal(after.deleted_at, before.deleted_at, 'still deleted');
    assert.equal(after.updated_at, before.updated_at, 'and not touched');
    assert.equal(after.field_times, before.field_times);
    const same = await call('PUT', `${k.path}/${made.id}`, { ...made, changed_fields: [] });
    assert.equal(same.status, 410);
    assert.ok(row(table, made.id).deleted_at);
  });

  test(`${kind}: a save that only carries a different visibility doesn't bring a deleted row back`, async (t) => {
    if (skip(t)) return;
    const made = await k.make();
    await api('DELETE', `${k.path}/${made.id}`);
    await sleep(1100);
    const r = await call('PUT', `${k.path}/${made.id}`, { ...made, visibility: made.visibility === 'group' ? 'private' : 'group' });
    assert.equal(r.status, 410);
    assert.ok(row(table, made.id).deleted_at);
  });

  test(`${kind}: a save in the second the row was deleted is not after the delete: refused as gone, the delete stays`, async (t) => {
    if (skip(t)) return;
    const made = await k.make();
    // Early in a second, so the delete and the save both fall inside it.
    const t0 = Math.ceil((Date.now() + 1) / 1000) * 1000 + 20;
    while (Date.now() < t0) await sleep(5);
    await api('DELETE', `${k.path}/${made.id}`);
    const r = await call('PUT', `${k.path}/${made.id}`, { ...made, notes: 'too soon', changed_fields: ['notes'] });
    assert.ok(Date.now() < t0 + 900, 'the delete and the save were in one second');
    assert.equal(r.status, 410);
    assert.equal(r.body.gone, true);
    assert.ok(row(table, made.id).deleted_at, 'the delete stays');
    assert.equal(row(table, made.id).notes ?? null, null, 'and the save is not written into it');
  });

  test(`${kind}: a row that isn't deleted is saved as before`, async (t) => {
    if (skip(t)) return;
    const made = await k.make();
    const r = await call('PUT', `${k.path}/${made.id}`, { ...made, notes: 'plain', changed_fields: ['notes'] });
    assert.equal(r.status, 200);
    assert.equal(row(table, made.id).notes, 'plain');
    assert.equal(row(table, made.id).deleted_at, null);
    const none = await call('PUT', `${k.path}/99999999`, { name: 'x' });
    assert.equal(none.status, 404, 'a row that was never there is still not found');
  });
}

test('another account\'s deleted food is still forbidden, not brought back', async (t) => {
  if (skip(t)) return;
  const made = await KINDS.foods.make();
  await api('DELETE', `/api/foods/${made.id}`);
  const mine = token;
  const r = await call('POST', '/api/auth/register', { username: 'jo', password: 'Str0ng-Pass-77!x' });
  if (r.status >= 400) { t.skip('a second account could not be made'); return; }
  const other = (await api('POST', '/api/auth/login', { username: 'jo', password: 'Str0ng-Pass-77!x' })).token;
  token = other;
  try {
    await sleep(1100);
    const put = await call('PUT', `/api/foods/${made.id}`, { ...made, notes: 'not mine', changed_fields: ['notes'] });
    assert.ok(put.status === 403 || put.status === 404, `refused (${put.status})`);
  } finally { token = mine; }
  assert.ok(row('foods', made.id).deleted_at);
  assert.equal(row('foods', made.id).notes ?? null, null);
});

test('an activity or a fast deleted elsewhere is still not found for a save (unchanged)', async (t) => {
  if (skip(t)) return;
  const a = await api('POST', '/api/activity', { date: '2026-10-01', name: 'Walk', kcal: 100, duration_min: 30 });
  await api('DELETE', `/api/activity/${a.id}`);
  assert.equal((await call('PUT', `/api/activity/${a.id}`, { name: 'Walk 2' })).status, 404);
  const on = await call('GET', '/api/fasts/active');
  if (on.body?.id) await api('POST', `/api/fasts/${on.body.id}/end`, {});
  const f = await api('POST', '/api/fasts/start', { goal_hours: 16 });
  await api('DELETE', `/api/fasts/${f.id}`);
  assert.equal((await call('PATCH', `/api/fasts/${f.id}`, { notes: 'x' })).status, 404);
});
