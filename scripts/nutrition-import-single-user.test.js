/**
 * Single-user mode stores diary rows with user_id NULL, and SQLite never
 * treats two NULLs as a conflict, so ON CONFLICT(date, user_id) cannot
 * update the day. A merge or replace import must change the existing row,
 * not add a second one for the same date.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-import-single-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'import-single-user-test-only';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: diary } = await import('../server/routes/diary.js');
const { default: nutritionImport } = await import('../server/routes/nutrition-import.js');

const app = express();
app.use(express.json());
app.use('/api/diary', diary);
app.use('/api/nutrition-import', nutritionImport);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(temp, { recursive: true, force: true });
});

const csv = 'Date,Meal,Name,Quantity,Unit,Calories\n2026-04-30,Breakfast,Imported oats,1,cup,150\n';
const importDay = async onDuplicate => {
  const form = new FormData();
  form.append('source', 'spreadsheet');
  form.append('onDuplicate', onDuplicate);
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'day.csv');
  const r = await fetch(`${base}/api/nutrition-import/commit`, { method: 'POST', body: form });
  assert.equal(r.status, 200, await r.text());
};
const names = async () => {
  const day = await fetch(`${base}/api/diary/2026-04-30`).then(r => r.json());
  return day.items.map(i => i.name);
};
const rows = () => db.prepare("SELECT COUNT(*) AS c FROM diary WHERE date = '2026-04-30'").get().c;

test('merge and replace imports update the existing single-user day', async () => {
  const put = await fetch(`${base}/api/diary/2026-04-30`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ name: 'Existing toast', meal: 1, quantity: 1, nutrition: { calories: 80 } }] }),
  });
  assert.equal(put.status, 200);

  await importDay('merge');
  assert.equal(rows(), 1);
  assert.deepEqual(await names(), ['Existing toast', 'Imported oats']);

  await importDay('replace');
  assert.equal(rows(), 1);
  assert.deepEqual(await names(), ['Imported oats']);
});
