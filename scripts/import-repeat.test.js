/**
 * Importing the same export twice adds nothing twice.
 * - Fasts: the JSON import added every fast again, so a second import (or
 *   one into an account that has them) showed each fast twice. One already
 *   here (same start) is kept; one running here and finished in the export
 *   ends as it did there.
 * - Single-user days: with user management off a day has no account, so
 *   the import's INSERT OR REPLACE never met the day already here and added
 *   a second row for the date. It now replaces that day, as it does for an
 *   account.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-import-repeat-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.UPLOADS_PATH = join(temp, 'uploads');
mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'import-repeat-test-only-0123456789abcdef';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: data } = await import('../server/routes/data.js');

db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('single_user_mode', '1')`).run();
let asUser = null;
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, _res, next) => { if (asUser) req.user = { id: asUser, role: 'admin' }; next(); });
app.use('/api/data', data);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(r => server.close(r)); db.close(); rmSync(temp, { recursive: true, force: true }); });
const post = async body => {
  const r = await fetch(`${base}/api/data/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.text());
};
const items = n => [{ uuid: `u${n}`, name: `Food ${n}`, portion: 100, unit: 'g', quantity: 1, nutrition: { calories: n } }];

test('single-user: importing a day that is here replaces it, not a second row', async () => {
  // The day as the app saves it (routes/diary.js): no account.
  db.prepare(`INSERT INTO diary (date, items, body_stats, water, updated_at) VALUES ('2026-10-01', ?, '{}', '[]', datetime('now'))`).run(JSON.stringify(items(1)));
  await post({ diary: [{ date: '2026-10-01', items: items(2) }, { date: '2026-10-02', items: items(3) }] });
  await post({ diary: [{ date: '2026-10-01', items: items(4) }, { date: '2026-10-02', items: items(3) }] });
  const rows = d => db.prepare(`SELECT items, deleted_at FROM diary WHERE date = ? AND user_id IS NULL`).all(d);
  assert.equal(rows('2026-10-01').length, 1);
  assert.equal(JSON.parse(rows('2026-10-01')[0].items)[0].name, 'Food 4');
  assert.equal(rows('2026-10-02').length, 1);
  // A measurement imported counts from now, so an older phone edit doesn't win.
  db.prepare(`UPDATE diary SET body_stats = '{"weight":80}' WHERE date = '2026-10-01'`).run();
  const before = JSON.parse(db.prepare(`SELECT field_times FROM diary WHERE date = '2026-10-01'`).get().field_times || '{}');
  await post({ diary: [{ date: '2026-10-01', items: items(4), bodyStats: { weight: 75 } }] });
  const times = JSON.parse(db.prepare(`SELECT field_times FROM diary WHERE date = '2026-10-01'`).get().field_times || '{}');
  const key = Object.keys(times).find(k => k.includes('weight'));
  assert.ok(key, JSON.stringify(times));
  assert.notEqual(times[key], undefined);
  assert.ok(!before[key] || times[key] >= before[key]);
  // A day cleared (Clear All Data) comes back with the import.
  db.prepare(`UPDATE diary SET deleted_at = datetime('now') WHERE date = '2026-10-02'`).run();
  await post({ diary: [{ date: '2026-10-02', items: items(5) }] });
  assert.equal(rows('2026-10-02').length, 1);
  assert.equal(rows('2026-10-02')[0].deleted_at, null);
  assert.equal(JSON.parse(rows('2026-10-02')[0].items)[0].name, 'Food 5');
});

test('single-user: importing fasts twice adds each once', async () => {
  const fasts = [
    { start_at: '2026-09-01T20:00:00.000Z', end_at: '2026-09-02T12:00:00.000Z', goal_hours: 16 },
    { start_at: '2026-09-03T20:00:00.000Z', end_at: '2026-09-04T12:00:00.000Z', goal_hours: 16, notes: 'Easy' },
  ];
  await post({ fasts });
  await post({ fasts });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM fasts WHERE user_id IS NULL AND deleted_at IS NULL`).get().n, 2);
});

test('a fast running here and finished in the export ends; a second running one is not added', async () => {
  db.prepare(`INSERT INTO fasts (start_at, goal_hours, updated_at) VALUES ('2026-09-10T20:00:00.000Z', 16, datetime('now'))`).run();
  await post({ fasts: [
    { start_at: '2026-09-10T20:00:00.000Z', end_at: '2026-09-11T14:00:00.000Z', goal_hours: 16, notes: 'Done' },
  ] });
  const f = db.prepare(`SELECT end_at, notes FROM fasts WHERE start_at = '2026-09-10T20:00:00.000Z' AND deleted_at IS NULL`).all();
  assert.deepEqual(f, [{ end_at: '2026-09-11T14:00:00.000Z', notes: 'Done' }]);
  // One running here; the export's other running fast would make two.
  db.prepare(`INSERT INTO fasts (start_at, goal_hours, updated_at) VALUES ('2026-09-20T20:00:00.000Z', 16, datetime('now'))`).run();
  await post({ fasts: [{ start_at: '2026-09-21T20:00:00.000Z', goal_hours: 16 }] });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM fasts WHERE end_at IS NULL AND deleted_at IS NULL`).get().n, 1);
  // A deleted fast doesn't count: importing it brings it back.
  db.prepare(`UPDATE fasts SET deleted_at = datetime('now') WHERE start_at = '2026-09-01T20:00:00.000Z'`).run();
  await post({ fasts: [{ start_at: '2026-09-01T20:00:00.000Z', end_at: '2026-09-02T12:00:00.000Z', goal_hours: 16 }] });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM fasts WHERE start_at = '2026-09-01T20:00:00.000Z' AND deleted_at IS NULL`).get().n, 1);
});

test('with accounts: a day is replaced and fasts are added once, only in the account', async () => {
  asUser = Number(db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('owner', 'x', 'admin')`).run().lastInsertRowid);
  const other = Number(db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('other', 'x', 'user')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO fasts (user_id, start_at, end_at, goal_hours, updated_at) VALUES (?, '2026-08-01T20:00:00.000Z', '2026-08-02T12:00:00.000Z', 16, datetime('now'))`).run(other);
  const body = { diary: [{ date: '2026-08-05', items: items(6) }], fasts: [{ start_at: '2026-08-01T20:00:00.000Z', end_at: '2026-08-02T12:00:00.000Z', goal_hours: 16 }] };
  await post(body);
  await post({ ...body, diary: [{ date: '2026-08-05', items: items(7) }] });
  const days = db.prepare(`SELECT items FROM diary WHERE date = '2026-08-05' AND user_id = ?`).all(asUser);
  assert.equal(days.length, 1);
  assert.equal(JSON.parse(days[0].items)[0].name, 'Food 7');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM fasts WHERE user_id = ? AND deleted_at IS NULL`).get(asUser).n, 1, "another account's fast doesn't count");
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM fasts WHERE user_id = ?`).get(other).n, 1);
});
