/**
 * Single-user mode keeps its settings in the browser (GET /api/settings is
 * empty), so only the app knows which units it shows: POST
 * /api/diary/body-stats-units tags the days with no user_id with those.
 * The account case is in body-stats-tag.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-bs-tag-single-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'bs-tag-single-test-only';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: diary } = await import('../server/routes/diary.js');
const { userMgmtActive } = await import('../server/middleware/auth.js');

db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('single_user_mode', '1')`).run();
const app = express();
app.use(express.json());
app.use('/api/diary', diary);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.close(); db.close(); rmSync(temp, { recursive: true, force: true }); });

test('single-user days are tagged with the units the browser shows', async () => {
  assert.equal(userMgmtActive(), false);
  db.prepare(`INSERT INTO diary (date, items, body_stats, water, updated_at) VALUES ('2026-04-28', '[]', ?, '[]', '2026-04-28 09:00:00')`)
    .run(JSON.stringify({ weight: 80, hips: 100 }));
  const res = await fetch(`${base}/api/diary/body-stats-units`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weight_unit: 'kg', lengths_unit: 'cm' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tagged: 1 });
  const bs = JSON.parse(db.prepare(`SELECT body_stats FROM diary WHERE date = '2026-04-28' AND user_id IS NULL`).get().body_stats);
  assert.deepEqual(bs, { weight: 80, hips: 100, weight_unit: 'kg', lengths_unit: 'cm' });
});
