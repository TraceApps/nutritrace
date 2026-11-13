/**
 * The pull's goal_history key: only an account has goal history.
 *
 * Single-user mode has no account, so the key is left out rather than sent
 * as an empty array: a phone detects support by its presence
 * (`hasOwnProperty`), and `[]` would tell it the server keeps history and
 * leave its own days pending forever. With an account the key is there, empty
 * until a day exists.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-sync-goal-pull-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'sync-goal-pull-test-only';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: sync } = await import('../server/routes/sync.js');

// The signed-in account, once there is one (single-user mode has none).
let session = null;
const app = express();
app.use(express.json());
app.use('/api/sync', (req, _res, next) => { req.user = session; next(); }, sync);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(temp, { recursive: true, force: true });
});

const pull = async () => {
  const r = await fetch(`${base}/api/sync/pull?since=1970-01-01T00:00:00.000Z`);
  assert.equal(r.status, 200);
  return r.json();
};

test('single-user mode: the pull has no goal_history key', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 0);
  const body = await pull();
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'goal_history'), false,
    'no account, no history: [] would read as support');
});

test('with an account the pull carries the key, even when it is empty', async () => {
  const id = Number(db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('pull-goals', 'x', 'admin')"
  ).run().lastInsertRowid);
  session = { id, role: 'admin' };
  const body = await pull();
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'goal_history'), true);
  assert.deepEqual(body.goal_history, []);
});
