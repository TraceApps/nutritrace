/**
 * #207 completion_enabled across the single-user → user-management switch.
 *
 * Single-user mode keeps settings in the browser only (PUT /api/settings
 * answers ok without storing), and enabling user management moves them to
 * the new account locally without sending them to the server. The diary
 * rows, marks included, are claimed by that first account. The public API
 * must then say it does not know the preference (null), never that
 * completion is off, while still reporting the marks themselves.
 *
 * Real app routes (settings, diary, first-account registration) and the
 * real public-API diary router run against an empty temp database.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-v1-completion-single-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'v1-completion-single-user-test-only';
process.env.PUBLIC_API_ENABLED = '1';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: auth } = await import('../server/routes/auth.js');
const { default: settings } = await import('../server/routes/settings.js');
const { default: diary } = await import('../server/routes/diary.js');
const { default: v1Diary } = await import('../server/routes/api/v1/diary.js');

// The signed-in account, once there is one (single-user mode has none).
let session = null;
const asSession = (req, _res, next) => { req.user = session; next(); };
const app = express();
app.use(express.json());
app.use('/api/auth', asSession, auth);
app.use('/api/settings', asSession, settings);
app.use('/api/diary', asSession, diary);
app.use('/api/v1/diary', (req, _res, next) => {
  req.apiToken = { id: 1, user_id: session.id, scopes: ['mcp:read'] };
  req.apiUser = { id: session.id, role: session.role };
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

const send = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  return json;
};
const day = date => fetch(`${base}/api/v1/diary/${date}`).then(r => r.json());
const item = uuid => ({ uuid, name: 'Synthetic food', meal: 1, portion: 100, unit: 'g', quantity: 1, nutrition: { calories: 100 }, addedAt: '2026-10-01T12:00:00.000Z' });

test('single-user mode: the preference never reaches the server, marks do', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 0);
  await send('PUT', '/api/settings', { key: 'diaryShowCompletion', value: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_settings').get().c, 0);
  await send('PUT', '/api/diary/2026-10-01', { items: [item('s1')] });
  await send('PUT', '/api/diary/2026-10-01/meal-completion', { slot: 1, completed: true });
  await send('PUT', '/api/diary/2026-10-01/completion', { completed: true });
});

test('after enabling user management: marks reported, preference unknown (null), not false', async () => {
  const { user } = await send('POST', '/api/auth/register', { username: 'first-admin', password: 'Synthetic-fixture-only-Passphrase-2026!' });
  session = { id: user.id, role: user.role };
  assert.equal(user.role, 'admin');
  const body = await day('2026-10-01');
  assert.equal(body.count, 1);
  assert.equal(typeof body.completed_at, 'string');
  assert.deepEqual(body.completed_meals, [1]);
  assert.equal(body.completion_enabled, null);
  const open = await day('2026-10-02');
  assert.deepEqual([open.completed_at, open.completion_enabled], [null, null]);
});

test('once the preference is saved from the app, the API reports it as stored', async () => {
  await send('PUT', '/api/settings', { key: 'diaryShowCompletion', value: true });
  assert.equal((await day('2026-10-02')).completion_enabled, true);
  await send('PUT', '/api/settings', { key: 'diaryShowCompletion', value: false });
  const off = await day('2026-10-01');
  assert.equal(off.completion_enabled, false);
  assert.equal(typeof off.completed_at, 'string');
});
