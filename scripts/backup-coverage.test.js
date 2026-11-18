/**
 * What backups and exports carry (the backup check after #332):
 * - The JSON import keeps a day's completion marks and when its note was
 *   written, and doesn't take them away from a day it replaces; foods and
 *   meals keep where they came from ("From CookTrace") and a recipe's
 *   import warnings.
 * - A backup or export asks for every fast, not the newest 365.
 * - A full backup keeps an email changed and not yet confirmed: a restore
 *   used to make it count as confirmed.
 * - The Android app restores fasts as they were (a running one no longer
 *   stops the rest), imports fasts from an export, and keeps per-meal marks.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-backup-coverage-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.UPLOADS_PATH = join(temp, 'uploads');
mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'backup-coverage-test-only-0123456789abcdef';

const { default: db } = await import('../server/db.js');
await import('../server/lib/link-grant.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: data } = await import('../server/routes/data.js');
const { default: fasts } = await import('../server/routes/fasts.js');
const fb = await import('../server/routes/full-backup.js');

db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('single_user_mode', '1')`).run();
let asUser = null; // set once an account exists (user management on)
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, _res, next) => { if (asUser) req.user = { id: asUser, role: 'admin' }; next(); });
app.use('/api/data', data);
app.use('/api/fasts', fasts);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(r => server.close(r)); db.close(); rmSync(temp, { recursive: true, force: true }); });
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the JSON import keeps completion marks and the note time, and a replaced day keeps its own', async () => {
  // A day here already closed, with two meals marked.
  db.prepare(`INSERT INTO diary (date, items, body_stats, water, completed_at, completed_meals, updated_at) VALUES ('2026-11-01', '[]', '{}', '[]', '2026-11-01 21:00:00', '[0,2]', datetime('now'))`).run();
  const r = await post('/api/data/import', { diary: [
    { date: '2026-11-02', items: [], notes: 'Felt good', notes_updated_at: '2026-11-02T20:00:00.000Z', completed_at: '2026-11-02 22:00:00', completed_meals: [1, 3], completion_marked_at: '2026-11-02T22:00:00.000Z' },
    // An export from before the marks: the day keeps the ones it has.
    { date: '2026-11-01', items: [], notes: '' },
  ] });
  assert.equal(r.status, 200, await r.clone().text());
  const d2 = db.prepare(`SELECT * FROM diary WHERE date = '2026-11-02'`).get();
  assert.equal(d2.completed_at, '2026-11-02 22:00:00');
  assert.equal(d2.completed_meals, '[1,3]');
  assert.equal(d2.notes_updated_at, '2026-11-02T20:00:00.000Z');
  // The imported day (single-user days have no account, so the import adds
  // its own row: read the newest).
  const d1 = db.prepare(`SELECT * FROM diary WHERE date = '2026-11-01' ORDER BY id DESC`).get();
  assert.equal(d1.completed_at, '2026-11-01 21:00:00');
  assert.equal(d1.completed_meals, '[0,2]');
  // An export that says the day wasn't closed clears the mark: the marks go as one.
  await post('/api/data/import', { diary: [{ date: '2026-11-02', items: [], completed_at: null, completed_meals: [], completion_marked_at: null, meal_marks_at: null }] });
  const d2b = db.prepare(`SELECT * FROM diary WHERE date = '2026-11-02' ORDER BY id DESC`).get();
  assert.equal(d2b.completed_at, null);
  assert.equal(d2b.completed_meals, null);
  // A note without its time counts from now, not from the note it replaced.
  await post('/api/data/import', { diary: [{ date: '2026-11-02', items: [], notes: 'New note' }] });
  const d2c = db.prepare(`SELECT * FROM diary WHERE date = '2026-11-02' ORDER BY id DESC`).get();
  assert.notEqual(d2c.notes_updated_at, '2026-11-02T20:00:00.000Z');
});

test('the JSON import keeps where foods and recipes came from, and import warnings', async () => {
  const r = await post('/api/data/import', {
    foodList: [{ name: 'Flour', source_app: 'cooktrace', source_external_id: 'pantry:3', source_url: 'https://ct.example/#/pantry/3' }],
    recipes: [{ name: 'Bread', items: [], source_app: 'cooktrace', source_external_id: 'recipe:9', source_url: 'https://ct.example/#/recipes/9', import_warnings: ['No nutrition for yeast'] }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(db.prepare(`SELECT source_app, source_external_id, source_url FROM foods WHERE name = 'Flour'`).get(),
    { source_app: 'cooktrace', source_external_id: 'pantry:3', source_url: 'https://ct.example/#/pantry/3' });
  const m = db.prepare(`SELECT source_app, source_external_id, import_warnings FROM meals WHERE name = 'Bread'`).get();
  assert.equal(m.source_external_id, 'recipe:9');
  assert.deepEqual(JSON.parse(m.import_warnings), ['No nutrition for yeast']);
});

test('a backup or export gets every fast, not the newest 365', async () => {
  const ins = db.prepare(`INSERT INTO fasts (start_at, end_at, goal_hours, updated_at) VALUES (?, ?, 16, datetime('now'))`);
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();
    ins.run(d, d.replace('T00', 'T16'));
  }
  const all = await (await fetch(`${base}/api/fasts?limit=10000`)).json();
  assert.equal(all.length, 400);
  assert.equal((await (await fetch(`${base}/api/fasts`)).json()).length, 30, 'the list on screen keeps its default');
  for (const p of ['src/lib/api-native.js', 'src/lib/api-cached.js']) assert.doesNotMatch(read(p), /Math\.min\(365,/, p);
});

test('a full backup keeps an email changed and not yet confirmed', async () => {
  const uid = Number(db.prepare(`INSERT INTO users (username, password_hash, role, email) VALUES ('owner', 'x', 'admin', 'old@example.com')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO user_email_changes (user_id, email, previous_email, changed_at) VALUES (?, 'new@example.com', 'old@example.com', ?)`).run(uid, Date.now());
  const { filename: name } = fb.createBackup();
  db.prepare('DELETE FROM user_email_changes').run(); // gone meanwhile; the restore brings it back
  const layer = fb.default.stack.find(l => l.route && l.route.path === '/:name/restore');
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = await new Promise(resolve => {
    const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ code: this.c || 200, body: b }); }, set() { return this; } };
    handle({ params: { name }, user: { id: uid, role: 'admin' }, headers: {}, get: () => undefined }, res);
  });
  assert.equal(out.code, 200, JSON.stringify(out.body));
  assert.deepEqual(db.prepare('SELECT user_id, email, previous_email FROM user_email_changes').all(),
    [{ user_id: uid, email: 'new@example.com', previous_email: 'old@example.com' }]);
  // One bad row in the archive doesn't stop the rest.
  const src = read('server/routes/full-backup.js');
  assert.match(src, /try \{ insEmailChange\.run\(\{ email: null, previous_email: null, \.\.\.c, changed_at: c\.changed_at \?\? Date\.now\(\) \}\); \} catch/);
});

test('the Android app restores and imports fasts as they were, and keeps per-meal marks', () => {
  const native = read('src/lib/db-native.js');
  const fn = native.slice(native.indexOf('export async function dbRestoreFast('), native.indexOf('export async function dbStartFast('));
  assert.match(fn, /SELECT id, end_at FROM fasts WHERE user_id = \? AND start_at = \?/, 'the same fast is not added twice');
  assert.match(fn, /if \(here\.end_at \|\| !f\.end_at\) return false;\s*await dbUpdateFast\(here\.id, \{ end_at: f\.end_at/, 'one running here and finished in the backup ends');
  assert.match(fn, /if \(!f\.end_at && await dbGetActiveFast\(\)\) return false;/, 'a running one only when none runs here');
  assert.match(fn, /INSERT INTO fasts \(user_id, start_at, end_at, goal_hours, notes/, 'finished ones go in whole');
  assert.doesNotMatch(read('src/lib/local-backup.js'), /dbStartFast/, 'restore no longer starts them one by one');
  assert.match(read('src/lib/local-backup.js'), /await dbRestoreFast\(f\)/);
  assert.match(read('src/components/settings/SettingsImportExport.svelte'), /for \(const f of \(data\.fasts \|\| \[\]\)\) await dbm\.dbRestoreFast\(f\)/);
  assert.match(native, /typeof data\.completed_meals === 'string' \? _parseSlotArrayLocal\(data\.completed_meals\)/);
});

test('after Clear All Data, an import brings back foods and recipes from CookTrace', async () => {
  asUser = Number(db.prepare(`SELECT id FROM users WHERE username = 'owner'`).get().id);
  const body = {
    foodList: [{ name: 'Rye Flour', source_app: 'cooktrace', source_external_id: 'pantry:44' }],
    recipes: [{ name: 'Rye Bread', items: [], source_app: 'cooktrace', source_external_id: 'recipe:44' }],
  };
  assert.equal((await post('/api/data/import', body)).status, 200);
  // Cleared: deleted, still holding their place in the source index.
  db.prepare(`UPDATE foods SET deleted_at = datetime('now') WHERE user_id = ?`).run(asUser);
  db.prepare(`UPDATE meals SET deleted_at = datetime('now') WHERE user_id = ?`).run(asUser);
  assert.equal((await post('/api/data/import', body)).status, 200);
  assert.deepEqual(db.prepare(`SELECT name, source_external_id FROM foods WHERE user_id = ? AND deleted_at IS NULL`).all(asUser), [{ name: 'Rye Flour', source_external_id: 'pantry:44' }]);
  assert.deepEqual(db.prepare(`SELECT name, source_external_id FROM meals WHERE user_id = ? AND deleted_at IS NULL`).all(asUser), [{ name: 'Rye Bread', source_external_id: 'recipe:44' }]);
});
