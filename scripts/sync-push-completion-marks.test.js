/**
 * POST /api/sync/push meeting a diary day's completion marks (#207), on a
 * real server (server/index.js, scratch database).
 *
 * A push that said the day (or a meal) was completed marked it again,
 * whatever was done here since: a day unmarked on the web after the
 * phone's mark came back marked with the phone's next push of the day.
 * Marks now follow the newer-wins rule the completion routes keep
 * (completion_marked_at, meal_marks_at): the pushed day mark (completed_at
 * is when it was made) goes in only when made after the unmark here; one
 * with no readable time, and a pushed meal (no time of its own), don't
 * undo an unmark here. A mark on a day or meal never unmarked here still
 * goes in, and a push without a mark keeps the mark here.
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

const dir = ready ? mkdtempSync(join(tmpdir(), 'nt-push-marks-')) : null;
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
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'push-marks-secret-0123456789abcdef0123', NODE_ENV: 'test' },
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


const date = n => `2026-07-${String(n).padStart(2, '0')}`;
const markDay = (D, completed, extra = {}) => api('PUT', `/api/diary/${D}/completion`, { completed, ...extra });
const markMeal = (D, slot, completed) => api('PUT', `/api/diary/${D}/meal-completion`, { slot, completed });
// The phone's push of day D: an item changed now, with what the day holds.
const pushDay = (D, marks) => {
  const now = iso(Date.now());
  return push({ client_now: now, diary: [{ date: D, items: [item(`${D}-a`, { addedAt: now, updatedAt: now })], body_stats: {}, water: [], updated_at: now, ...marks }] });
};
const meals = D => JSON.parse(day(D)?.completed_meals || '[]');

test('a day marked on the phone, then unmarked on the web, stays unmarked through the phone\'s next push', async (t) => {
  if (skip(t)) return;
  const D = date(1);
  await api('PUT', `/api/diary/${D}`, { items: [item(`${D}-a`)], body_stats: {}, water: [] });
  const phoneMark = iso(Date.now());
  await markDay(D, true, { at: phoneMark, client_now: phoneMark });
  const pulled = day(D).completed_at;
  assert.ok(pulled);
  await sleep(1100);
  await markDay(D, false);
  await sleep(1100);
  // As made on the phone (its own clock) and as pulled from here.
  await pushDay(D, { completed_at: phoneMark });
  assert.equal(day(D).completed_at, null, 'the phone time');
  await pushDay(D, { completed_at: pulled });
  assert.equal(day(D).completed_at, null, 'the pulled time');
  // From a phone whose clock is 5 minutes slow: the pulled time is the
  // server's own, and moving it by the phone's offset would put it after
  // the unmark.
  const slow = iso(Date.now() - 5 * 60000);
  await push({ client_now: slow, diary: [{ date: D, items: [item(`${D}-a`, { addedAt: slow, updatedAt: slow })], body_stats: {}, water: [], updated_at: slow, completed_at: pulled }] });
  assert.equal(day(D).completed_at, null, 'the pulled time from a slow phone');
});

test('a pushed mark with no readable time doesn\'t undo a web unmark', async (t) => {
  if (skip(t)) return;
  const D = date(2);
  await markDay(D, true);
  await markDay(D, false);
  for (const completed_at of ['soon', 'true', '2026-13-45']) {
    await pushDay(D, { completed_at });
    assert.equal(day(D).completed_at, null, completed_at);
  }
});

test('a phone\'s mark made after the web unmark still goes in, with its time', async (t) => {
  if (skip(t)) return;
  const D = date(3);
  await markDay(D, true);
  await markDay(D, false);
  const unmarked = day(D).completion_marked_at;
  await sleep(1100);
  const at = iso(Date.now());
  await pushDay(D, { completed_at: at });
  const row = day(D);
  assert.equal(row.completed_at, at);
  assert.ok(row.completion_marked_at > unmarked, 'the mark keeps its own time');
  // An older mark sent through the completion route afterwards changes nothing.
  await markDay(D, false, { at: iso(Date.parse(at) - 60000), client_now: iso(Date.now()) });
  assert.equal(day(D).completed_at, at);
});

test('a mark on a day never unmarked here goes in, and a push without one keeps the mark here', async (t) => {
  if (skip(t)) return;
  const D = date(4);
  const at = iso(Date.now() - 5000);
  await pushDay(D, { completed_at: at });
  assert.equal(day(D).completed_at, at, 'a new day');
  const E = date(5);
  await api('PUT', `/api/diary/${E}`, { items: [item(`${E}-a`)], body_stats: {}, water: [] });
  await pushDay(E, { completed_at: at });
  assert.equal(day(E).completed_at, at, 'a day with no marks yet');
  await markDay(E, false);
  await markDay(E, true);
  const kept = day(E).completed_at;
  for (const completed_at of [undefined, null, '']) {
    await pushDay(E, { completed_at });
    assert.equal(day(E).completed_at, kept, String(completed_at));
  }
});

test('a meal unmarked on the web stays unmarked through a push that holds it; other meals still go in', async (t) => {
  if (skip(t)) return;
  const D = date(6);
  await markMeal(D, 1, true);
  await markMeal(D, 2, true);
  await markMeal(D, 1, false);
  await pushDay(D, { completed_meals: [1, 2, 3, 40, -1, 'x'] });
  assert.deepEqual(meals(D), [2, 3]);
  // A push without meals keeps them.
  await pushDay(D, { completed_meals: [] });
  assert.deepEqual(meals(D), [2, 3]);
});
