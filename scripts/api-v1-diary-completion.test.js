/**
 * #207 completion marks on GET /api/v1/diary/:date (read-only).
 *
 * Runs the real public-API diary router (mcp:read token, no new scope) and
 * the real app diary router that sets the marks, against a temp database,
 * so every state is produced the way the app produces it: preference not
 * stored / on / off, open, closed, reopened, a past date, an empty closed
 * day, edits after closing, a deleted day and malformed stored values.
 * The single-user → user-management case is in
 * api-v1-diary-completion-single-user.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-v1-completion-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'v1-completion-test-only';
process.env.PUBLIC_API_ENABLED = '1';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: diary } = await import('../server/routes/diary.js');
const { default: v1Diary } = await import('../server/routes/api/v1/diary.js');

const userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('v1-completion', 'x', 'admin')").run().lastInsertRowid;
const otherId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('v1-other', 'x', 'user')").run().lastInsertRowid;

const app = express();
app.use(express.json());
// App session for the marking routes; a read-only API token for /api/v1.
app.use('/api/diary', (req, _res, next) => { req.user = { id: userId, role: 'admin' }; next(); }, diary);
app.use('/api/v1/diary', (req, _res, next) => {
  req.apiToken = { id: 1, user_id: userId, scopes: (req.get('x-test-scopes') ?? 'mcp:read').split(',').filter(Boolean) };
  req.apiUser = { id: userId, role: 'admin' };
  next();
}, v1Diary);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(temp, { recursive: true, force: true });
});

const put = (path, body) => fetch(base + path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => { assert.equal(r.status, 200, await r.text()); });
const read = async (date, scopes) => {
  const r = await fetch(`${base}/api/v1/diary/${date}`, { headers: scopes === undefined ? {} : { 'x-test-scopes': scopes } });
  return { status: r.status, body: await r.json() };
};
const day = async date => { const { status, body } = await read(date); assert.equal(status, 200); return body; };
const setPref = value => db.prepare(
  `INSERT INTO user_settings (user_id, key, value) VALUES (?, 'diaryShowCompletion', ?)
   ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, deleted_at = NULL`
).run(userId, JSON.stringify(value));
const item = (uuid, meal) => ({ uuid, name: 'Synthetic food', meal, portion: 100, unit: 'g', quantity: 1, nutrition: { calories: 100 }, addedAt: '2026-10-20T12:00:00.000Z' });

test('existing fields are unchanged and the three completion fields are added', async () => {
  await put('/api/diary/2026-10-20', { items: [item('a1', 0), item('a2', 2)] });
  const body = await day('2026-10-20');
  assert.deepEqual(Object.keys(body), ['date', 'items', 'count', 'completion_enabled', 'completed_at', 'completed_meals']);
  assert.equal(body.date, '2026-10-20');
  assert.equal(body.count, 2);
  assert.deepEqual(body.items.map(i => i.uuid), ['a1', 'a2']);
});

test('preference never stored on the server: completion_enabled null (unknown), day reads as unmarked', async () => {
  const body = await day('2026-10-20');
  assert.equal(body.completion_enabled, null);
  assert.equal(body.completed_at, null);
  assert.deepEqual(body.completed_meals, []);
});

test('tracking enabled, day open: completed_at null and completion_enabled true', async () => {
  setPref(true);
  const body = await day('2026-10-20');
  assert.equal(body.completion_enabled, true);
  assert.equal(body.completed_at, null);
});

test('meals and day closed through the app routes are reported; first mark kept on repeat', async () => {
  await put('/api/diary/2026-10-20/meal-completion', { slot: 2, completed: true });
  await put('/api/diary/2026-10-20/meal-completion', { slot: 0, completed: true });
  await put('/api/diary/2026-10-20/completion', { completed: true });
  const first = await day('2026-10-20');
  assert.equal(typeof first.completed_at, 'string');
  assert.ok(first.completed_at.length > 0);
  assert.deepEqual(first.completed_meals, [0, 2]);
  await put('/api/diary/2026-10-20/completion', { completed: true });
  assert.equal((await day('2026-10-20')).completed_at, first.completed_at);
});

test('editing a closed day keeps the mark (the app does not reopen it)', async () => {
  const before = await day('2026-10-20');
  await put('/api/diary/2026-10-20', { items: [item('a1', 0), item('a2', 2), item('a3', 1)] });
  const after = await day('2026-10-20');
  assert.equal(after.count, 3);
  assert.equal(after.completed_at, before.completed_at);
  assert.deepEqual(after.completed_meals, [0, 2]);
});

test('reopened day: completed_at back to null, meal marks as stored', async () => {
  await put('/api/diary/2026-10-20/completion', { completed: false });
  const body = await day('2026-10-20');
  assert.equal(body.completed_at, null);
  assert.deepEqual(body.completed_meals, [0, 2]);
  await put('/api/diary/2026-10-20/meal-completion', { slot: 2, completed: false });
  assert.deepEqual((await day('2026-10-20')).completed_meals, [0]);
});

test('a past date closed later is reported for that date only', async () => {
  await put('/api/diary/2026-09-01', { items: [item('p1', 1)] });
  await put('/api/diary/2026-09-01/completion', { completed: true });
  assert.equal(typeof (await day('2026-09-01')).completed_at, 'string');
  assert.equal((await day('2026-09-02')).completed_at, null);
});

test('empty closed day (e.g. a fast) and a day with no row', async () => {
  await put('/api/diary/2026-09-10/completion', { completed: true });
  const fast = await day('2026-09-10');
  assert.equal(fast.count, 0);
  assert.deepEqual(fast.items, []);
  assert.equal(typeof fast.completed_at, 'string');
  const none = await day('2026-09-11');
  assert.deepEqual([none.count, none.completed_at, none.completed_meals], [0, null, []]);
});

test('deleted day reads as no row; malformed stored meal marks read as []', async () => {
  await put('/api/diary/2026-09-20', { items: [item('d1', 0)] });
  await put('/api/diary/2026-09-20/completion', { completed: true });
  await fetch(`${base}/api/diary/2026-09-20`, { method: 'DELETE' });
  const deleted = await day('2026-09-20');
  assert.deepEqual([deleted.count, deleted.completed_at, deleted.completed_meals], [0, null, []]);
  db.prepare("UPDATE diary SET completed_meals = 'not json' WHERE user_id = ? AND date = '2026-09-01'").run(userId);
  assert.deepEqual((await day('2026-09-01')).completed_meals, []);
  db.prepare("UPDATE diary SET completed_meals = '[3, 1, 99, -1, \"x\", 1.5, 3]' WHERE user_id = ? AND date = '2026-09-01'").run(userId);
  assert.deepEqual((await day('2026-09-01')).completed_meals, [1, 3]);
});

test('preference turned off reads as false; cleared or non-boolean reads as null; marks still reported', async () => {
  setPref(false);
  const off = await day('2026-09-01');
  assert.equal(off.completion_enabled, false);
  assert.equal(typeof off.completed_at, 'string');
  db.prepare("UPDATE user_settings SET deleted_at = datetime('now') WHERE user_id = ? AND key = 'diaryShowCompletion'").run(userId);
  assert.equal((await day('2026-09-01')).completion_enabled, null);
  for (const raw of ['nope', '"true"', '1', 'null', '']) {
    db.prepare("UPDATE user_settings SET value = ?, deleted_at = NULL WHERE user_id = ? AND key = 'diaryShowCompletion'").run(raw, userId);
    assert.equal((await day('2026-09-01')).completion_enabled, null, `stored ${JSON.stringify(raw)}`);
  }
  setPref(true);
  assert.equal((await day('2026-09-01')).completion_enabled, true);
});

test('another user\'s marks and preference never leak', async () => {
  db.prepare("INSERT INTO diary (user_id, date, items, completed_at, completed_meals) VALUES (?, '2026-08-01', '[]', datetime('now'), '[1]')").run(otherId);
  db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'diaryShowCompletion', 'true')").run(otherId);
  db.prepare("UPDATE user_settings SET deleted_at = datetime('now') WHERE user_id = ?").run(userId);
  const body = await day('2026-08-01');
  assert.deepEqual([body.completion_enabled, body.completed_at, body.completed_meals], [null, null, []]);
});

test('scope unchanged: mcp:read suffices, a token without it is refused, totals unchanged', async () => {
  assert.equal((await read('2026-10-20', 'mcp:read')).status, 200);
  const refused = await read('2026-10-20', 'mcp:write');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'auth_scope');
  const totals = await fetch(`${base}/api/v1/diary/2026-10-20/totals`).then(r => r.json());
  assert.deepEqual(Object.keys(totals), ['date', 'totals', 'water_ml', 'item_count']);
});

test('invalid date still answers 400', async () => {
  assert.equal((await read('2026-02-30')).status, 400);
});
