/**
 * Server side of the Android sync fixes, on the real schema.
 *
 * - The push decides last-write-wins on the server's clock: the phone
 *   sends its clock (client_now) and its edit times are set against it.
 *   Apps that don't send it compare as before. A winning push keeps its
 *   edit time; the pull's cursor is changed_at, the server's write time.
 * - wellness_data and workouts lose rows outright (Clear all data, a
 *   wearable re-sync, the Fitbit duplicate clean-up). Each delete is noted
 *   in sync_deletions so the pull can tell phones; a key that exists again
 *   isn't reported, and noting never gets in the way of deleting an account.
 * - A diary item logged on a phone before its food went up names no
 *   server food (food_server_id null), so it doesn't take another food's
 *   units and barcode.
 *
 * End to end with the app's own code: scripts/android-sync.test.js.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

let db = null, dir = null, sync = null, helpers = null, claim = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'nt-android-sync-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  sync = await import('../server/routes/sync.js');
  helpers = await import('../server/lib/diary-helpers.js');
  claim = await import('../server/lib/claim-anonymous-data.js');
} catch { /* better-sqlite3 not built for this Node: the schema tests skip */ }
test.after(() => { try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });
const skip = t => { if (!db) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };

const MIN = 60_000;
const user = n => Number(db?.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(n + Math.random(), 'x').lastInsertRowid);
const wellness = (u, date, metric, value = 1, source = 'fitbit') => db.prepare(
  `INSERT INTO wellness_data (user_id, date, source, metric_type, value) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET value = excluded.value`
).run(u, date, source, metric, value);
const workout = (u, sid) => Number(db.prepare(
  `INSERT INTO workouts (user_id, source, source_id, date, activity_name) VALUES (?, 'fitbit', ?, '2026-10-01', 'Run')`
).run(u, sid).lastInsertRowid);
const EPOCH = '1970-01-01 00:00:00';

test("the phone's clock: from client_now against arrival, ignored when it can't be right", (t) => {
  if (skip(t)) return;
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.deepEqual(sync._clientClock(undefined, now), { known: false, offsetMs: 0 }, 'apps that send nothing');
  assert.deepEqual(sync._clientClock('soon', now), { known: false, offsetMs: 0 });
  assert.deepEqual(sync._clientClock('2026-08-01T12:00:00Z', now), { known: false, offsetMs: 0 }, 'more than 30 days out');
  assert.deepEqual(sync._clientClock('2026-10-06T11:59:59.000Z', now), { known: true, offsetMs: 0 }, 'a second is travel time');
  assert.equal(sync._clientOffsetMs('2026-10-06T11:55:00.000Z', now), 5 * MIN, 'a phone 5 minutes slow');
  assert.equal(sync._clientOffsetMs('2026-10-06T12:05:00.000Z', now), -5 * MIN, 'a phone 5 minutes fast');
});

test('last write wins on the server clock; without an offset, as before', (t) => {
  if (skip(t)) return;
  const server = '2026-10-06 12:00:00';
  assert.equal(sync._pushWins('2026-10-06T12:00:00.900Z', server, 0), true);
  assert.equal(sync._pushWins('2026-10-06T11:59:59.999Z', server, 0), false);
  assert.equal(sync._pushWins('2026-10-06 12:00:01', server, 0), true, "SQLite's UTC format is UTC");
  assert.equal(sync._pushWins(undefined, server, 0), false);
  assert.equal(sync._pushWins('2026-10-06T00:00:00Z', null, 0), true);
  assert.equal(sync._pushWins('2026-10-06T11:57:00Z', server, 0), false, 'used to lose');
  assert.equal(sync._pushWins('2026-10-06T11:57:00Z', server, 5 * MIN), true, 'wins once set right');
  assert.equal(sync._pushWins('2026-10-06T12:03:00Z', server, 0), true, 'used to beat a later edit');
  assert.equal(sync._pushWins('2026-10-06T12:03:00Z', server, -5 * MIN), false);
});

test("a winning push keeps its edit's time (on the server clock, never ahead of it); old apps get the push time", (t) => {
  if (skip(t)) return;
  const now = Date.parse('2026-10-06T12:00:00Z');
  const clock = sync._clientClock('2026-10-06T11:55:00Z', now);
  assert.equal(sync._editStamp('2026-10-06T11:50:00Z', clock, now), '2026-10-06 11:55:00');
  assert.equal(sync._editStamp('2026-10-06T11:59:00Z', clock, now), '2026-10-06 12:00:00', 'never later than now');
  assert.equal(sync._editStamp('2026-10-06T11:50:00Z', { known: false, offsetMs: 0 }, now), '2026-10-06 12:00:00');
});

test('a losing push answers with the server copy, and leaves its time alone', () => {
  const src = read('../server/routes/sync.js');
  for (const [name, t] of [['foods', 'foods'], ['meals', 'meals'], ['activity', 'activity_log'], ['fasts', 'fasts']]) {
    assert.match(src, new RegExp(`\\} else if \\(_ownsRow\\(existing, u\\)\\) \\{\\s*result\\.${name}\\.push\\(\\{ client_id: \\w\\.client_id, server_id: \\w\\.server_id, row: (parse\\()?winner\\('${t}'`), t);
  }
  assert.doesNotMatch(src, /restamp/);
  assert.match(src, /const receivedAt = Date\.now\(\);[\s\S]*clientClock\(req\.body\?\.client_now, receivedAt\)/, 'the clock is read on arrival');
});

test('changed_at, the pull cursor, moves on every write while updated_at keeps the edit time', (t) => {
  if (skip(t)) return;
  const u = user('cursor');
  const id = Number(db.prepare(`INSERT INTO foods (user_id, name, updated_at) VALUES (?, 'Old Edit', '2020-01-01 00:00:00')`).run(u).lastInsertRowid);
  const row = () => db.prepare('SELECT updated_at, changed_at FROM foods WHERE id = ?').get(id);
  assert.equal(row().updated_at, '2020-01-01 00:00:00');
  assert.ok(row().changed_at > '2026-01-01', 'an insert is a change now');
  db.prepare(`UPDATE foods SET changed_at = '2000-01-01 00:00:00' WHERE id = ?`).run(id);
  db.prepare(`UPDATE foods SET name = 'Older Edit', updated_at = '2019-01-01 00:00:00' WHERE id = ?`).run(id);
  assert.ok(row().changed_at > '2026-01-01', 'so is any update, whatever updated_at says');
  assert.match(read('../server/routes/sync.js'), /SELECT \* FROM foods WHERE changed_at >= \?/);
});

test("a day's note keeps when it was edited, whoever wrote it", (t) => {
  if (skip(t)) return;
  const u = user('notes');
  db.prepare(`INSERT INTO diary (user_id, date, notes) VALUES (?, '2026-10-01', 'First')`).run(u);
  const at = () => db.prepare(`SELECT notes_updated_at FROM diary WHERE user_id = ?`).get(u).notes_updated_at;
  assert.ok(at(), 'an insert with a note stamps it');
  db.prepare(`UPDATE diary SET notes_updated_at = '2000-01-01 00:00:00' WHERE user_id = ?`).run(u);
  db.prepare(`UPDATE diary SET items = '[]' WHERE user_id = ?`).run(u);
  assert.equal(at(), '2000-01-01 00:00:00', 'other changes leave it');
  db.prepare(`UPDATE diary SET notes = 'Second' WHERE user_id = ?`).run(u);
  assert.ok(at() > '2026-01-01', 'a new note moves it');
});

test('the server reports a lasting instance id, so a phone knows it at any address', () => {
  const src = read('../server/routes/auth.js');
  assert.match(src, /instance_id: serverInstanceId\(\),/);
  assert.match(src, /INSERT OR IGNORE INTO app_config \(key, value\) VALUES \('instance_id', \?\)/);
});

test('wellness and workouts deleted outright reach the pull as deletions', (t) => {
  if (skip(t)) return;
  const u = user('del');
  wellness(u, '2026-10-01', 'steps', 100);
  wellness(u, '2026-10-01', 'resting_hr', 60);
  const w1 = workout(u, 'w-1'), w2 = workout(u, 'w-2');
  db.prepare('DELETE FROM wellness_data WHERE user_id = ? AND metric_type = ?').run(u, 'steps');
  db.prepare('DELETE FROM workouts WHERE id = ?').run(w1);
  const d = sync._deletionsSince(u, EPOCH);
  assert.deepEqual(d.wellness, [{ date: '2026-10-01', source: 'fitbit', metric_type: 'steps' }]);
  assert.deepEqual(d.workouts, [w1]);
  assert.ok(!d.workouts.includes(w2));
  assert.deepEqual(sync._deletionsSince(user('someone-else'), EPOCH), { workouts: [], wellness: [] }, "another account's aren't listed");
});

test('a key written again (a wearable re-syncing a day) is not reported, and keeps one note', (t) => {
  if (skip(t)) return;
  const u = user('resync');
  for (let i = 0; i < 5; i++) {
    db.prepare(`DELETE FROM wellness_data WHERE user_id = ? AND date = '2026-10-02' AND source = 'fitbit'`).run(u);
    wellness(u, '2026-10-02', 'sleep_score', 80 + i);
  }
  assert.deepEqual(sync._deletionsSince(u, EPOCH).wellness, []);
  const notes = db.prepare(`SELECT COUNT(*) AS n FROM sync_deletions WHERE user_id = ? AND table_name = 'wellness_data'`).get(u).n;
  assert.equal(notes, 1);
});

test('deleting an account still works, before and after its rows go', (t) => {
  if (skip(t)) return;
  const u = user('gone');
  wellness(u, '2026-10-03', 'steps');
  workout(u, 'gone-1');
  db.prepare('DELETE FROM wellness_data WHERE user_id = ? AND metric_type = ?').run(u, 'steps');
  assert.ok(db.prepare('SELECT 1 FROM sync_deletions WHERE user_id = ?').get(u));
  db.prepare('DELETE FROM users WHERE id = ?').run(u);
  assert.equal(db.prepare('SELECT 1 FROM sync_deletions WHERE user_id = ?').get(u), undefined, 'its notes go with it');
  // wellness and workouts have no foreign key: their rows outlive the
  // account, and removing them later must not trip the users reference.
  assert.doesNotThrow(() => db.prepare('DELETE FROM workouts WHERE user_id = ?').run(u));
});

test('single-user mode: the pollers (0) and the phone (NULL) both count, and the first account claims them', (t) => {
  if (skip(t)) return;
  wellness(0, '2026-10-04', 'steps');
  wellness(null, '2026-10-04', 'weight_kg', 70, 'health_connect');
  db.prepare(`DELETE FROM wellness_data WHERE date = '2026-10-04' AND (user_id IS NULL OR user_id = 0)`).run();
  const d = sync._deletionsSince(null, EPOCH);
  assert.ok(d.wellness.some(w => w.metric_type === 'steps' && w.source === 'fitbit'));
  assert.ok(d.wellness.some(w => w.metric_type === 'weight_kg' && w.source === 'health_connect'));
  assert.ok(claim.CLAIM_NULL.includes('sync_deletions'));
});

test('Clear all data soft-deletes fasts too', () => {
  const src = read('../server/routes/data.js');
  assert.equal((src.match(/UPDATE fasts SET deleted_at = datetime\('now'\), updated_at = datetime\('now'\)/g) || []).length, 2);
});

test('an item logged before its food reached the server takes no food details by its phone id', (t) => {
  if (skip(t)) return;
  const u = user('hyd');
  const food = Number(db.prepare(`INSERT INTO foods (user_id, name, barcode) VALUES (?, 'Cheese', 'BC-CHEESE')`).run(u).lastInsertRowid);
  const [unsent] = helpers.hydrateItems([{ id: food, food_server_id: null, name: 'Milk' }], u);
  assert.equal(unsent.barcode, undefined);
  const [legacy] = helpers.hydrateItems([{ id: food, name: 'Cheese' }], u);
  assert.equal(legacy.barcode, 'BC-CHEESE', 'items without the key still match by id');
  const [byServer] = helpers.hydrateItems([{ id: 1, food_server_id: food, name: 'Cheese' }], u);
  assert.equal(byServer.barcode, 'BC-CHEESE');
});

// #277: the browser's photo of an item comes from its source by the
// server's id too. An item logged in the Android app has the phone's own
// id in `id`, which names another row here.
test("a diary item's photo comes from its source by the server's id, not the phone's", (t) => {
  if (skip(t)) return;
  for (const u of [user('img'), null]) {
    const food = (name, img) => Number(db.prepare(`INSERT INTO foods (user_id, name, img_url) VALUES (?, ?, ?)`).run(u, name, img).lastInsertRowid);
    const meal = (name, img) => Number(db.prepare(`INSERT INTO meals (user_id, name, items, is_recipe, img_url) VALUES (?, ?, '[]', 1, ?)`).run(u, name, img).lastInsertRowid);
    const a = food('Pear 277', '/a.jpg'), b = food('Pear 277', '/b.jpg');
    const ma = meal('Pear Crumble 277 ', '/ma.jpg'), mb = meal('Pear Crumble 277 ', '/mb.jpg');
    const milk = food('Slim Milk 277 ', '/milk.jpg');
    const got = helpers.freshenItemImages([
      { id: a, food_server_id: b, name: 'Pear 277' },                     // logged on a phone: its id is a's here
      { food_server_id: b, name: 'Pear 277' },                            // MCP / API
      { id: b, food_server_id: b, name: 'Pear 277' },                     // the browser
      { id: ma, food_server_id: mb, is_recipe: 1, name: 'Pear Crumble 277 ' }, // a recipe, the same
      { id: b, food_server_id: null, name: 'Pear 277' },                  // the phone's id, before it went up
      { name: 'Pear 277' },                                               // by name
      { food_server_id: milk, name: 'Slim Milk 277' },
      { name: 'slim milk 277' },
    ], u).map(i => i.imgUrl);
    assert.deepEqual(got, ['/b.jpg', '/b.jpg', '/b.jpg', '/mb.jpg', got[5], got[5], '/milk.jpg', '/milk.jpg'], `user ${u}`);
  }
});

// #277: log_meal (MCP and the API) names each item's food by its server
// id, whether the meal was saved in the browser (the server's id in `id`)
// or in the Android app (the phone's own in `id`, the server's in
// `server_id`).
test("a meal logged through MCP or the API names each item's food by its server id", async (t) => {
  if (skip(t)) return;
  const { logMealCore } = await import('../server/lib/mcp/tools/log-meal.js');
  const u = user('lm');
  const food = (name, img) => Number(db.prepare(`INSERT INTO foods (user_id, name, img_url) VALUES (?, ?, ?)`).run(u, name, img).lastInsertRowid);
  const a = food('Plum 277', '/plum-a.jpg'), b = food('Plum 277', '/plum-b.jpg');
  const meal = items => Number(db.prepare(`INSERT INTO meals (user_id, name, items, is_recipe) VALUES (?, 'Plums', ?, 0)`).run(u, JSON.stringify(items)).lastInsertRowid);
  const web = meal([{ id: b, name: 'Plum 277', nutrition: {} }]);
  const phone = meal([{ id: a, server_id: b, name: 'Plum 277', nutrition: {} }, { id: a, server_id: null, name: 'Plum 277', nutrition: {} }]);
  logMealCore(u, { meal_id: web, date: '2026-09-29' });
  logMealCore(u, { meal_id: phone, date: '2026-09-29' });
  const items = JSON.parse(db.prepare(`SELECT items FROM diary WHERE user_id = ? AND date = '2026-09-29'`).get(u).items);
  assert.deepEqual(items.map(i => i.food_server_id), [b, b, null]);
  assert.deepEqual(helpers.freshenItemImages(items, u).map(i => i.imgUrl).slice(0, 2), ['/plum-b.jpg', '/plum-b.jpg']);
});

test("the browser's offline push sends the day's note and its clock too", async () => {
  const { buildDiaryPush } = await import('../src/lib/offline-edits.js');
  const row = buildDiaryPush([{ type: 'diary', seq: 1, date: '2026-10-05', day: { items: [], notes: 'Late lunch' }, at: Date.now() }], []).diary[0];
  assert.equal(row.notes, 'Late lunch');
  assert.match(row.notes_updated_at, /^\d{4}-/);
  const same = buildDiaryPush([{ type: 'diary', seq: 1, date: '2026-10-05', day: { items: [], notes: 'Late lunch' }, at: Date.now() }], [{ date: '2026-10-05', id: 3, notes: 'Late lunch' }]).diary[0];
  assert.equal('notes' in same, false, "a note this browser didn't change isn't sent");
  const api = read('../src/lib/offline-api.js');
  assert.equal((api.match(/_post\('\/api\/sync\/push', \{ \.\.\.build(Catalog|Diary)Push\([^)]*\), client_now: new Date\(\)\.toISOString\(\) \}\)/g) || []).length, 2);
});

test('the Android push sends the note (only when edited there) with its edit time, the CookTrace origin and its clock', () => {
  const src = read('../src/lib/sync.js');
  assert.match(src, /\.\.\.\(\(d\.notes_dirty \|\| !keepsNotes\) \? \{ notes: d\.notes \|\| '', notes_updated_at: d\.notes_updated_at \|\| null \} : \{\}\),/);
  assert.match(src, /source_app: f\.source_app \|\| null,/);
  assert.match(src, /payload\.client_now = new Date\(\)\.toISOString\(\);/);
});

test("an item logged before its food synced (food_server_id null) names no food, on the web or the server's recent foods", async (t) => {
  const { itemSourceRef } = await import('../src/lib/item-source.js');
  assert.deepEqual(itemSourceRef({ id: 5, food_server_id: 9 }, { native: true }), { serverId: 9 });
  assert.deepEqual(itemSourceRef({ id: 5, food_server_id: null }, { native: true }), { localId: 5, unsent: true });
  assert.equal(itemSourceRef({ id: 5, food_server_id: null }, { native: false }), null, "another phone's id means nothing on the web");
  assert.deepEqual(itemSourceRef({ id: 5 }, { native: false }), { serverId: 5 }, 'older items read as before');
  assert.deepEqual(itemSourceRef({ id: 5 }, { native: true }), { localId: 5, unsent: false });
  assert.match(read('../src/stores/diary.js'), /const ref = itemSourceRef\(item, \{ native: isNative \}\);[\s\S]*dbFindLocalId\('meals', ref\.serverId\)/, 'splitting a recipe on a phone finds it by server id');
  assert.match(read('../src/routes/Foods.svelte'), /return catalogImgFor\(item, \{ foods: localFoods \|\| \[\], meals: \[\.\.\.\(localMeals \|\| \[\]\), \.\.\.\(localRecipes \|\| \[\]\)\] \}, \{ native: isNative, mine: _myInstalls \}\);/);
  if (skip(t)) return;
  const { registerRecentFoods } = await import('../server/lib/mcp/tools/recent-foods.js');
  const u = user('recent');
  const mine = Number(db.prepare(`INSERT INTO foods (user_id, name) VALUES (?, 'Real Recent')`).run(u).lastInsertRowid);
  const other = Number(db.prepare(`INSERT INTO foods (user_id, name) VALUES (?, 'Not Logged')`).run(u).lastInsertRowid);
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO diary (user_id, date, items) VALUES (?, ?, ?)`).run(u, today, JSON.stringify([
    { id: mine, food_server_id: mine, name: 'Real Recent' },
    { id: other, food_server_id: null, name: 'Phone Food' },
  ]));
  let handler = null;
  registerRecentFoods({ registerTool: (_n, _d, h) => { handler = h; } }, { userId: u });
  const res = await handler({ limit: 10 });
  const names = (res.structuredContent?.items || []).map(i => i.name);
  assert.deepEqual(names, ['Real Recent']);
});

// #277 follow-up: Yesterday's Meals (Foods.svelte liveImgFor) shows each
// item's photo the way the diary does: a recipe's from the recipes, by the
// server id first, then by name, trimmed and case-insensitively. It looked
// in foods, meals and recipes at once, so a recipe took the photo of a food
// with the same id, and a name with a space after it or in other letter
// case found nothing.
test("Yesterday's Meals shows each item's photo the way the diary does", (t) => {
  return import('../src/lib/item-source.js').then(({ catalogImgFor }) => {
    // The browser: a row's id is the server's.
    const foods = [{ id: 3, name: 'Toast', imgUrl: '/toast.jpg' }, { id: 4, name: 'Slim Milk ', imgUrl: '/milk.jpg' }, { id: 5, name: 'pear', brand: 'Orchard', imgUrl: '/pear.jpg' }];
    const meals = [{ id: 3, name: 'Overnight Oats', is_recipe: 1, imgUrl: '/oats.jpg' }];
    const web = it => catalogImgFor(it, { foods, meals });
    assert.equal(web({ id: 3, food_server_id: 3, is_recipe: 1, name: 'Overnight Oats' }), '/oats.jpg', "a recipe's photo, not the food with its id");
    assert.equal(web({ id: 3, food_server_id: 3, name: 'Toast' }), '/toast.jpg');
    assert.equal(web({ food_server_id: 99, name: 'slim milk', imgUrl: '' }), '/milk.jpg', 'by name, trimmed, any case');
    assert.equal(web({ name: 'PEAR ', brand: 'orchard' }), '/pear.jpg', 'name and brand, trimmed, any case');
    assert.equal(web({ name: 'Pear', brand: 'Other' }), '/pear.jpg', 'then the name alone, as the diary');
    assert.equal(web({ food_server_id: 3, name: 'Butter', imgUrl: '/own.jpg' }), '/own.jpg', "an id whose row has another name isn't it");
    assert.equal(web({ id: 4, food_server_id: null, name: 'Slim Milk' }), '/milk.jpg', "another phone's id names nothing; the name decides");
    // The Android app: its own ids in id, the server's in server_id.
    const pf = [{ id: 1, server_id: 3, name: 'Toast', imgUrl: '/p-toast.jpg' }, { id: 3, server_id: 9, name: 'Toast', imgUrl: '/p-toast9.jpg' }, { id: 7, server_id: null, name: 'New Food', imgUrl: '/p-new.jpg' }];
    const phone = it => catalogImgFor(it, { foods: pf, meals: [] }, { native: true });
    assert.equal(phone({ id: 3, food_server_id: 3, name: 'Toast' }), '/p-toast.jpg', "by the server's id, not the phone's");
    assert.equal(phone({ id: 7, food_server_id: null, name: 'new food' }), '/p-new.jpg', 'logged before it went up');
    const twoNew = { foods: [{ id: 7, server_id: null, name: 'Soup', imgUrl: '/old-soup.jpg' }, { id: 8, server_id: null, name: 'Soup', imgUrl: '/new-soup.jpg' }], meals: [] };
    const other = { id: 7, food_server_id: null, food_device: 'other-phone', name: 'Soup' };
    assert.equal(catalogImgFor(other, twoNew, { native: true, mine: new Set(['me']) }), catalogImgFor({ name: 'Soup' }, twoNew, { native: true }), "another phone's id names nothing here: by name, as the diary");
    assert.equal(catalogImgFor({ ...other, food_device: 'me' }, twoNew, { native: true, mine: new Set(['me']) }), '/old-soup.jpg', "this phone's: by its id");
  });
});

// The same, against the diary's own lookup on the server: for each item
// Yesterday's Meals and the diary show the same photo.
test("Yesterday's Meals and the diary agree on each item's photo", (t) => {
  if (skip(t)) return;
  return import('../src/lib/item-source.js').then(({ catalogImgFor }) => {
    const u = user('yday');
    const food = (name, img, brand = null) => ({ id: Number(db.prepare(`INSERT INTO foods (user_id, name, brand, img_url) VALUES (?, ?, ?, ?)`).run(u, name, brand, img).lastInsertRowid), name, brand, imgUrl: img });
    const meal = (name, img) => ({ id: Number(db.prepare(`INSERT INTO meals (user_id, name, items, is_recipe, img_url) VALUES (?, ?, '[]', 1, ?)`).run(u, name, img).lastInsertRowid), name, is_recipe: 1, imgUrl: img });
    const toast = food('Toast Y', '/y-toast.jpg'), milk = food('Slim Milk Y ', '/y-milk.jpg'), cheese = food('Cheese Y', '/y-cheese.jpg', 'Dairy Co');
    const oats = meal('Oats Y', '/y-oats.jpg');
    const items = [
      { id: toast.id, food_server_id: toast.id, name: 'Toast Y' },
      { id: oats.id, food_server_id: oats.id, is_recipe: 1, name: 'Oats Y' },
      { id: toast.id, food_server_id: toast.id, is_recipe: 1, name: 'Oats Y' },
      { food_server_id: null, id: 1, name: 'slim milk y' },
      { name: 'CHEESE Y ', brand: ' dairy co' },
      { name: 'cheese y', brand: 'Another' },
    ];
    const server = helpers.freshenItemImages(items, u).map(i => i.imgUrl);
    const catalogue = { foods: [toast, milk, cheese], meals: [oats] };
    assert.deepEqual(items.map(i => catalogImgFor(i, catalogue)), server);
    assert.deepEqual(server, ['/y-toast.jpg', '/y-oats.jpg', '/y-oats.jpg', '/y-milk.jpg', '/y-cheese.jpg', '/y-cheese.jpg']);
  });
});

// #277 follow-up: of several foods (or recipes) of one name, with no id to
// tell them apart, the server showed the oldest one's photo and the phone
// the newest's. Both show the newest now, by one rule
// (fixtures/same-name.mjs); the phone's side is in android-sync.test.js.
test('same-named foods: the server and Yesterday\'s Meals show the newest one\'s photo', async (t) => {
  const { ROWS, ITEMS, expectedPhotos } = await import('./fixtures/same-name.mjs');
  const { catalogImgFor } = await import('../src/lib/item-source.js');
  const want = expectedPhotos();
  const items = ITEMS.map(x => x.item);
  if (!skip(t)) {
    const u = user('same-name');
    for (const r of ROWS.foods) db.prepare(`INSERT INTO foods (user_id, name, brand, img_url) VALUES (?, ?, ?, ?)`).run(u, r.name, r.brand || null, r.img);
    for (const r of ROWS.meals) db.prepare(`INSERT INTO meals (user_id, name, items, is_recipe, img_url) VALUES (?, ?, '[]', 1, ?)`).run(u, r.name, r.img);
    assert.deepEqual(helpers.freshenItemImages(items, u).map(i => i.imgUrl), want, 'the server, with accounts');
    assert.deepEqual(helpers.freshenItemImages(items, null).map(i => i.imgUrl), want, 'the server, without');
  }
  // Yesterday's Meals, in the browser (the server's ids) and on a phone
  // (its own ids, listed in another order than the server's).
  const ids = { foods: ROWS.foods.map((r, i) => 100 + i), meals: ROWS.meals.map((r, i) => 200 + i) };
  const web = { foods: ROWS.foods.map((r, i) => ({ id: ids.foods[i], name: r.name, brand: r.brand, imgUrl: r.img })),
    meals: ROWS.meals.map((r, i) => ({ id: ids.meals[i], name: r.name, is_recipe: 1, imgUrl: r.img })) };
  assert.deepEqual(items.map(i => catalogImgFor(i, web)), want, 'the browser');
  assert.deepEqual(items.map(i => catalogImgFor(i, { foods: [...web.foods].reverse(), meals: [...web.meals].reverse() })), want, 'in any order');
  const phone = { foods: web.foods.map((r, i) => ({ ...r, id: 50 - i, server_id: r.id })), meals: web.meals.map((r, i) => ({ ...r, id: 50 - i, server_id: r.id })) };
  assert.deepEqual(items.map(i => catalogImgFor(i, phone, { native: true })), want, 'a phone');
  // A row not on the server yet is the newest.
  const unsent = { ...phone, foods: [...phone.foods, { id: 1, server_id: null, name: 'Twin Pear', imgUrl: '/same/new.jpg' }] };
  assert.equal(catalogImgFor(items[0], unsent, { native: true }), '/same/new.jpg');
});

// #277 follow-up: when the phone's foods, meals and recipes go up as new
// rows (Connect > Upload or Merge, Push all), each diary item that names
// one of them follows it, and nothing else moves.
test("diary items follow their food, meal or recipe to its new server id, and only theirs", async () => {
  const { relinkItems } = await import('../src/lib/item-source.js');
  const rows = {
    foods: [{ id: 1, server_id: 101, name: 'Milk' }, { id: 2, server_id: 102, name: 'Pear' }, { id: 3, server_id: null, name: 'Made Here' }, { id: 4, server_id: 104, name: 'Not Up' }],
    meals: [{ id: 1, server_id: 201, name: 'Oats' }],
  };
  const newIds = { foods: [[1, 501], [2, 502], [3, 503]], meals: [[1, 601]] };
  const opts = { rows, newIds, install: 'me', mine: new Set(['me', 'me-before']) };
  const items = [
    { uuid: 'a', id: 101, food_server_id: 101, name: 'Milk' },                    // logged in the browser
    { uuid: 'b', id: 2, food_server_id: 102, name: 'Pear (renamed)' },            // logged here: the server id decides, not the name
    { uuid: 'c', id: 3, food_server_id: null, food_device: 'me-before', name: 'Made Here' }, // before it went up, this phone
    { uuid: 'd', id: 3, food_server_id: null, food_device: 'another', name: 'Made Here' },   // another phone's id
    { uuid: 'e', id: 1, food_server_id: 101, is_recipe: 1, name: 'Milk' },        // a recipe's server id 101 is no recipe here
    { uuid: 'f', id: 7, food_server_id: 201, is_recipe: 1, name: 'Oats' },        // the recipe
    { uuid: 'g', food_server_id: 999, name: 'Elsewhere' },                         // not one of the phone's
    { uuid: 'h', id: 104, food_server_id: 104, name: 'Not Up' },                  // its food didn't go up: the phone's id until it does
    { uuid: 'i', id: 2, name: 'Pear' },                                            // older, untagged: same name
    { uuid: 'j', id: 2, name: 'Apple' },                                           // older, another name: left alone
    { uuid: 'k', id: 3, food_server_id: null, name: 'made here ' },               // untagged before it went up: same name
    { uuid: 'l', name: 'Split', is_recipe: 1, _splitItems: [{ uuid: 'l1', id: 101, food_server_id: 101, name: 'Milk' }] },
    { uuid: 'm', id: 102, name: 'Pear' },                                          // older, logged in the browser: the server's id, same name
    { uuid: 'n', id: 102, name: 'Plum' },                                          // the same, another name: left alone
  ];
  const { items: out, changed } = relinkItems(items, opts);
  assert.equal(changed, true);
  assert.deepEqual(out.map(i => [i.uuid, i.id ?? null, i.food_server_id, i.food_device ?? null]), [
    ['a', 101, 501, null], ['b', 2, 502, null], ['c', 3, 503, null], ['d', 3, null, 'another'],
    ['e', 1, 101, null], ['f', 7, 601, null], ['g', null, 999, null], ['h', 4, null, 'me'],
    ['i', 2, 502, null], ['j', 2, undefined, null], ['k', 3, 503, null], ['l', null, undefined, null],
    ['m', 102, 502, null], ['n', 102, undefined, null],
  ]);
  assert.deepEqual(out[11]._splitItems.map(i => i.food_server_id), [501]);
  assert.equal(out[6], items[6], 'untouched items are the same objects');
  // Again, on what it gave (an upload sent twice): the same.
  assert.deepEqual(relinkItems(out, { ...opts, rows: { foods: rows.foods.map(r => ({ ...r, server_id: Object.fromEntries(newIds.foods)[r.id] ?? r.server_id })), meals: [{ id: 1, server_id: 601, name: 'Oats' }] } }).items, out);
  // Push all: no new ids yet, so the phone's own until they come back; again, the same.
  const pushAll = relinkItems(items, { ...opts, newIds: {} });
  assert.deepEqual(pushAll.items.slice(0, 3).map(i => [i.id, i.food_server_id, i.food_device]), [[1, null, 'me'], [2, null, 'me'], [3, null, 'me']]);
  assert.equal(relinkItems(pushAll.items, { ...opts, newIds: {} }).changed, false);
  assert.deepEqual(relinkItems([items[6], items[3]], opts), { items: [items[6], items[3]], changed: false });
});

// #277 follow-up: a saved meal's or recipe's ingredients follow their food
// the same way, in whichever shape they name it, and nothing else moves.
test("a meal's ingredients follow their food or recipe to its new server id, and only theirs", async () => {
  const { relinkIngredients } = await import('../src/lib/item-source.js');
  const rows = {
    foods: [{ id: 1, server_id: 101, name: 'Milk' }, { id: 2, server_id: null, name: 'Made Here' }, { id: 3, server_id: 103, name: 'Not Up' }],
    meals: [{ id: 1, server_id: 201, name: 'Bowl' }],
  };
  const opts = { rows, newIds: { foods: [[1, 501], [2, 502]], meals: [[1, 601]] }, install: 'me', mine: new Set(['me']) };
  const items = [
    { id: 101, name: 'Milk' },                                              // saved in the browser
    { id: 1, server_id: 101, name: 'Milk (renamed)' },                       // saved on the phone: the server id decides
    { id: 2, server_id: null, name: 'Made Here' },                           // before its food went up, untagged: same name
    { id: 2, server_id: null, food_device: 'other', name: 'Made Here' },     // another phone's
    { id: 9, food_server_id: 101, name: 'Milk' },                            // saved from the diary
    { id: 1, server_id: 201, is_recipe: 1, name: 'Bowl' },                   // a recipe inside
    { id: 103, name: 'Not Up' },                                             // its food goes up later
    { id: 999, name: 'Elsewhere' },                                          // not one of the phone's
    { id: 101, name: 'Plum' },                                               // the browser's id, another name: left alone
  ];
  const { items: out, changed } = relinkIngredients(items, opts);
  assert.equal(changed, true);
  assert.deepEqual(out.map(i => [i.id, i.server_id, i.food_server_id, i.food_device]), [
    [1, 501, undefined, undefined], [1, 501, undefined, undefined], [2, 502, undefined, undefined], [2, null, undefined, 'other'],
    [1, 501, 501, undefined], [1, 601, undefined, undefined], [3, null, undefined, 'me'], [999, undefined, undefined, undefined],
    [101, undefined, undefined, undefined],
  ]);
  assert.equal(out[7], items[7]);
  const again = relinkIngredients(out, { ...opts, rows: { foods: [{ id: 1, server_id: 501, name: 'Milk' }, { id: 2, server_id: 502, name: 'Made Here' }, { id: 3, server_id: 103, name: 'Not Up' }], meals: [{ id: 1, server_id: 601, name: 'Bowl' }] } });
  assert.deepEqual(again.items, out, 'sent twice: the same');
  // Push all: no new ids yet, so the phone's own until they come back; again, the same.
  const pushAll = relinkIngredients(items, { ...opts, newIds: {} });
  assert.deepEqual(pushAll.items.slice(0, 3).map(i => [i.id, i.server_id, i.food_device]), [[1, null, 'me'], [1, null, 'me'], [2, null, 'me']]);
  assert.equal(relinkIngredients(pushAll.items, { ...opts, newIds: {} }).changed, false);
  // The split and log_meal read them the same way.
  assert.match(read('../src/stores/diary.js'), /const food_server_id = \(typeof ing\.food_server_id === 'number' \|\| ing\.food_server_id === null\)/);
});

// #277 follow-up: an item's id can be out of date (another server's, after
// Connect > Upload or Push all, whose food never came along). The food it
// names here lends its units and barcode only if it is the item's: the
// same name, trimmed and any case, or there when the item was logged (a
// food renamed since). One rule on the server and the phone.
const FOOD_MATCH_CASES = [
  // [food name, food made, item name, item addedAt, lends?]
  ['Banana', '2026-01-02 10:00:00', ' banana ', '2026-01-01T00:00:00.000Z', true],    // the same name, whenever made
  ['Unrelated', '2026-01-02 10:00:00', 'Banana', '2026-01-01T00:00:00.000Z', false],  // another food, made after: an id out of date
  ['Whole Milk', '2025-12-01 08:00:00', 'Milk', '2026-01-01T00:00:00.000Z', true],    // renamed since it was logged
  ['Whole Milk', '2026-01-01 00:00:00', 'Milk', '2026-01-01T00:00:00.000Z', true],    // made the same second
  ['Whole Milk', '2025-12-01 08:00:00', 'Milk', undefined, false],                    // no addedAt: the name decides
  ['Whole Milk', null, 'Milk', '2026-01-01T00:00:00.000Z', false],                    // no made time: the name decides
];
test("a food lends an item its units and barcode only if it is the item's, the same on the server and the phone", async (t) => {
  if (!skip(t)) {
  const u = user('lend');
  const food = (name, made, barcode) => Number(db.prepare(`INSERT INTO foods (user_id, name, barcode, alt_units, created_at) VALUES (?, ?, ?, '[{"abbr":"cup","grams":200}]', ?)`).run(u, name, barcode, made).lastInsertRowid);
  const stale = food('Unrelated Lend', '2026-01-02 10:00:00', 'BC-UNRELATED');
  const renamed = food('Whole Milk Lend', '2025-12-01 08:00:00', 'BC-MILK');
  const same = food('Banana Lend', '2026-01-02 10:00:00', 'BC-BANANA');
  const got = helpers.hydrateItems([
    { food_server_id: stale, name: 'Banana Lend', addedAt: '2026-01-01T00:00:00.000Z' },
    { food_server_id: renamed, name: 'Milk Lend', addedAt: '2026-01-01T00:00:00.000Z' },
    { food_server_id: same, name: 'banana lend ', addedAt: '2026-01-01T00:00:00.000Z' },
    { id: stale, name: 'Banana Lend' },
  ], u).map(i => [i.barcode || null, i.alt_units?.[0]?.abbr || null]);
  assert.deepEqual(got, [[null, null], ['BC-MILK', 'cup'], ['BC-BANANA', 'cup'], [null, null]]);
  // A day of only a split recipe: its parts are filled in too.
  const [bowl] = helpers.hydrateItems([{ is_recipe: 1, name: 'Bowl Lend', _splitItems: [
    { food_server_id: same, name: 'Banana Lend', addedAt: '2026-01-01T00:00:00.000Z' },
    { food_server_id: stale, name: 'Banana Lend', addedAt: '2026-01-01T00:00:00.000Z' },
  ] }], u);
  assert.deepEqual(bowl._splitItems.map(i => i.barcode || null), ['BC-BANANA', null]);
  }
  const phone = (await import('../src/lib/item-source.js')).itemFoodMatches;
  for (const [name, created_at, itemName, addedAt, want] of FOOD_MATCH_CASES) {
    const args = [{ name, created_at }, { name: itemName, addedAt }];
    assert.equal(phone(...args), want, `phone: ${name} / ${itemName}`);
    if (helpers) assert.equal(helpers.itemFoodMatches(...args), want, `server: ${name} / ${itemName}`);
  }
});

// #277 follow-up: a relinked item wins the server's merge over an older
// copy of itself, and loses to any later edit.
test('a relinked item is a millisecond newer than the copy it came from, by the merge', async () => {
  const { relinkedAt, relinkItems } = await import('../src/lib/item-source.js');
  const { mergeEntries } = await import('../server/lib/diary-merge.js');
  for (const [was, want] of [
    [{ updatedAt: '2026-05-30T08:00:00.000Z' }, '2026-05-30T08:00:00.001Z'],
    [{ addedAt: '2026-05-30T08:00:00.999Z' }, '2026-05-30T08:00:01.000Z'],
    [{ updatedAt: '2026-05-30T08:00:00Z' }, '2026-05-30T08:00:00Z1'],
    [{}, '1970-01-01T00:00:00.001Z'],
  ]) assert.equal(relinkedAt(was), want);
  const old = { uuid: 'x', food_server_id: 1, name: 'Milk', addedAt: '2026-05-30T08:00:00.000Z' };
  const [linked] = relinkItems([old], { rows: { foods: [{ id: 5, server_id: 1, name: 'Milk' }] }, newIds: { foods: [[5, 9]] } }).items;
  assert.equal(linked.updatedAt, '2026-05-30T08:00:00.001Z');
  assert.equal(mergeEntries([linked], [old], [], []).merged[0].food_server_id, 9, 'the older copy sent again loses');
  const edit = { ...old, quantity: 2, updatedAt: '2026-05-30T08:00:05.000Z' };
  assert.equal(mergeEntries([linked], [edit], [], []).merged[0].quantity, 2, 'a later edit wins');
  assert.equal(mergeEntries([edit], [linked], [], []).merged[0].quantity, 2, 'whichever arrives first');
  assert.equal(relinkItems([linked], { rows: { foods: [{ id: 5, server_id: 9, name: 'Milk' }] }, newIds: { foods: [[5, 9]] } }).changed, false, 'again: no change, the same time');
});

// Review round: a food renamed since an item was logged, then made again
// by Upload or Merge (newer than the item), still lends it units and
// barcode: the phone keeps the food's name on the item it links (food_name).
test('a renamed food made again by an upload still lends the items linked to it', async (t) => {
  const { relinkItems, itemFoodMatches } = await import('../src/lib/item-source.js');
  const it = { uuid: 'r1', food_server_id: 101, name: 'Chicken Breast', addedAt: '2026-01-01T00:00:00.000Z' };
  const rows = { foods: [{ id: 1, server_id: 101, name: 'Chicken Breast, Raw' }] };
  const [linked] = relinkItems([it], { rows, newIds: { foods: [[1, 501]] } }).items;
  assert.equal(linked.food_name, 'Chicken Breast, Raw');
  const [same] = relinkItems([{ ...it, name: 'chicken breast, raw ' }], { rows, newIds: { foods: [[1, 501]] } }).items;
  assert.equal('food_name' in same, false, 'not where the names agree');
  const madeAgain = { name: 'Chicken Breast, Raw', created_at: '2026-06-01 10:00:00' };
  assert.equal(itemFoodMatches(madeAgain, it), false, 'without it: newer, another name');
  assert.equal(itemFoodMatches(madeAgain, linked), true, 'with it');
  if (helpers) assert.equal(helpers.itemFoodMatches(madeAgain, linked), true, 'the server too');
  assert.match(read('../src/stores/diary.js'), /'food_name',\s+\/\/ its food's name when linked again/, 'kept when the day is saved');
  assert.match(read('../src/lib/db-native.js'), /source_url, updated_at, created_at, sync_status\)/, "a pulled food keeps the server's created_at");
  if (skip(t)) return;
  const u = user('renamed');
  const id = Number(db.prepare(`INSERT INTO foods (user_id, name, barcode, created_at) VALUES (?, 'Chicken Breast, Raw', 'BC-CHICKEN', '2026-06-01 10:00:00')`).run(u).lastInsertRowid);
  const [got] = helpers.hydrateItems([{ ...linked, food_server_id: id }], u);
  assert.equal(got.barcode, 'BC-CHICKEN');
});

// Review round: an edit of a split recipe or a move between meals is an
// edit (its own updatedAt), so a relinked copy never wins over it; a meal's
// ingredient keeps the phone it names; MCP's get_meal_details names an
// Android-saved ingredient's food by its server id.
test('split and move edits carry their time; ingredients keep their phone; get_meal_details reads server_id', async (t) => {
  const diary = read('../src/stores/diary.js');
  assert.match(diary, /items: entry\.items\.map\(\(it, i\) => i === index \? \{ \.\.\.item, _splitItems: splitItems, updatedAt: now \}/);
  assert.equal((diary.match(/_splitItems: (remaining|newChildren), updatedAt: new Date\(\)\.toISOString\(\)/g) || []).length, 2);
  assert.match(diary, /return \{ \.\.\.it, meal: Number\(toMealIdx\), updatedAt: new Date\(\)\.toISOString\(\) \};/);
  assert.match(diary, /typeof foodItem\.id === 'number' && !foodItem\.food_device\)/);
  if (skip(t)) return;
  const { getMealDetailsCore } = await import('../server/lib/mcp/tools/get-meal-details.js');
  const u = user('details');
  const meal = Number(db.prepare(`INSERT INTO meals (user_id, name, items) VALUES (?, 'Details', ?)`).run(u, JSON.stringify([
    { id: 4, server_id: 77, name: 'Phone Shape' }, { id: 4, server_id: null, name: 'Not Up' }, { id: 88, name: 'Browser Shape' }, { id: 9, food_server_id: 99, name: 'Diary Shape' },
  ])).lastInsertRowid);
  const r = getMealDetailsCore(u, { meal_id: meal });
  assert.deepEqual((r.items || r.meal?.items).map(i => [i.id, i.food_server_id]), [[77, 77], [null, null], [88, 88], [9, 99]]);
});

test('a note: unchanged keeps its time, an edit with no time is now, an older edit loses', async () => {
  const { resolveNote, clientClock } = await import('../server/lib/sync-clock.js');
  const now = Date.parse('2026-10-06T12:00:00Z');
  const row = { notes: 'Web', notes_updated_at: '2026-10-06 11:00:00', updated_at: '2026-10-06 11:30:00' };
  const clock = clientClock('2026-10-06T12:00:00Z', now);
  assert.deepEqual(resolveNote(row, { has: false }, clock, now), { notes: 'Web', at: '2026-10-06 11:00:00' });
  assert.deepEqual(resolveNote(row, { has: true, notes: 'Web', at: '2026-10-06T11:59:00Z' }, clock, now), { notes: 'Web', at: '2026-10-06 11:00:00' }, 'the same note never moves its time');
  assert.deepEqual(resolveNote(row, { has: true, notes: 'New' }, clock, now), { notes: 'New', at: '2026-10-06 12:00:00' });
  assert.deepEqual(resolveNote(row, { has: true, notes: 'Old', at: '2026-10-06T10:00:00Z' }, clock, now), { notes: 'Web', at: '2026-10-06 11:00:00' });
  assert.deepEqual(resolveNote(row, { has: true, notes: '', at: '2026-10-06T11:30:00Z' }, clock, now), { notes: null, at: '2026-10-06 11:30:00' });
});

test("times the phone already put on the server's clock aren't shifted again; implausible ones count as now", async () => {
  const { pushWins, editStamp, clientClock, onServerClock } = await import('../server/lib/sync-clock.js');
  const now = Date.parse('2026-10-06T12:00:00Z');
  const clock = clientClock('2026-10-06T11:55:00Z', now); // this push: phone 5 minutes slow
  assert.equal(onServerClock('2026-10-06T11:58:00.000+00:00'), true);
  // Stamped on the server's clock at 11:58 (the phone knew it then): not moved to 12:03.
  assert.equal(editStamp('2026-10-06T11:58:00.000+00:00', clock, now), '2026-10-06 11:58:00');
  assert.equal(pushWins('2026-10-06T11:58:00.000+00:00', '2026-10-06 11:59:00', clock.offsetMs, { serverNow: now }), false);
  // Without the marker, the push-time offset still applies.
  assert.equal(editStamp('2026-10-06T11:50:00.000Z', clock, now), '2026-10-06 11:55:00');
  // In the future: now.
  assert.equal(editStamp('2026-10-06T13:00:00.000+00:00', clock, now), '2026-10-06 12:00:00');
  assert.equal(pushWins('2026-10-06T13:00:00.000+00:00', '2026-10-06 12:00:00', 0, { serverNow: now }), true);
  // Before the row was made: now.
  assert.equal(editStamp('2026-10-06T09:00:00.000+00:00', clock, now, { createdAt: '2026-10-06 10:00:00' }), '2026-10-06 12:00:00');
  assert.equal(pushWins('2026-10-06T09:00:00.000+00:00', '2026-10-06 11:00:00', 0, { serverNow: now, createdAt: '2026-10-06 10:00:00' }), true);
  // Old app with no clock: the time it arrived, as before.
  assert.equal(editStamp('2026-10-06T09:00:00.000Z', clientClock(undefined, now), now), '2026-10-06 12:00:00');
});

test('a push reply carries the server clock, and the phone stamps edits with it', () => {
  assert.match(read('../server/routes/sync.js'), /res\.json\(\{ ok: true, \.\.\.result, server_time: new Date\(\)\.toISOString\(\) \}\)/);
  const dbn = read('../src/lib/db-native.js');
  assert.match(dbn, /new Date\(Date\.now\(\) \+ _clockOffsetMs\)\.toISOString\(\)\.replace\(\/Z\$\/, '\+00:00'\)/);
  for (const fn of ['dbUpdateFood', 'dbUpdateMeal', 'dbDeleteFood', 'dbDeleteMeal', 'dbUpdateActivity', 'dbDeleteActivity', 'dbEndFast', 'dbUpdateFast', 'dbDeleteFast', 'dbQueueCompletionOp']) {
    const body = dbn.slice(dbn.indexOf(`export async function ${fn}(`), dbn.indexOf('\n}\n', dbn.indexOf(`export async function ${fn}(`)));
    assert.match(body, /_editNow\(\)/, fn);
  }
});

test("a pushed note without its own time is dated by the day's edit time, and the newer one wins", async (t) => {
  if (skip(t)) return;
  const { resolveNote, clientClock } = await import('../server/lib/sync-clock.js');
  const now = Date.parse('2026-10-06T12:00:00Z');
  const clock = clientClock('2026-10-06T12:00:00Z', now);
  const row = { notes: 'Server', notes_updated_at: '2026-10-06 11:00:00', updated_at: '2026-10-06 11:00:00' };
  assert.deepEqual(resolveNote(row, { has: true, notes: 'Old day', at: '2026-10-06T10:00:00Z' }, clock, now), { notes: 'Server', at: '2026-10-06 11:00:00' });
  assert.deepEqual(resolveNote(row, { has: true, notes: 'New day', at: '2026-10-06T11:30:00Z' }, clock, now), { notes: 'New day', at: '2026-10-06 11:30:00' });
  assert.match(read('../server/routes/sync.js'), /at: hasNoteTime \? d\.notes_updated_at : \(d\.updated_at \|\| null\)/);
});

test("the browser's offline queue keeps whether a save changed the note, not the copy at flush time", async () => {
  const { buildDiaryPush, noteChangedAt } = await import('../src/lib/offline-edits.js');
  const at = Date.parse('2026-10-07T09:10:00Z');
  // Queued with the note as it was ("A"); since then the mirror moved on to "B".
  const untouched = { type: 'diary', date: '2026-10-07', day: { items: [{ uuid: 'x' }], notes: 'A' }, at, seq: 1, note_at: noteChangedAt({ notes: 'A' }, { notes: 'A' }, at) };
  assert.equal('notes' in buildDiaryPush([untouched], [{ date: '2026-10-07', notes: 'B' }]).diary[0], false, 'the stale note is not sent');
  const edited = { ...untouched, day: { notes: 'C' }, note_at: noteChangedAt({ notes: 'A' }, { notes: 'C' }, at) };
  const row = buildDiaryPush([edited], [{ date: '2026-10-07', notes: 'B' }]).diary[0];
  assert.equal(row.notes, 'C');
  assert.equal(row.notes_updated_at, '2026-10-07T09:10:00.000Z');
  // Two ops for the day: the note edited in the first, items in the second.
  const two = buildDiaryPush([edited, { ...untouched, seq: 2, at: at + 60000, day: { notes: 'C', items: [] }, note_at: null }], []).diary[0];
  assert.equal(two.notes_updated_at, '2026-10-07T09:10:00.000Z', 'the time of the note edit, not of the later save');
});

test('settings are kept per account and server, moved once from before, and follow the account to a new address', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null, get length() { return store.size; },
  };
  try {
    store.set('wl_u1_goals', '{"a":1}');
    store.set('nt:serverUrl', 'https://Server.A:8443/');
    store.set('wl:userId', '1');
    const m = await import(`../src/lib/setting-key.js?fresh=${Date.now()}`);
    assert.equal(m.settingPrefix(), 'wl_u1@server.a-8443_');
    assert.equal(store.get('wl_u1@server.a-8443_goals'), '{"a":1}', 'moved to the server it was made on');
    assert.equal(store.has('wl_u1_goals'), false);
    store.set('nt:serverUrl', 'https://other.b');
    assert.equal(m.settingPrefix(), 'wl_u1@other.b_', 'the same id on another server is another account');
    m.moveSettingScope('1', 'https://server.a:8443');
    assert.equal(store.get('wl_u1@other.b_goals'), '{"a":1}', 'the same account at a new address keeps them');
    store.delete('nt:serverUrl');
    assert.equal(m.settingPrefix(), 'wl_u1_', 'web and local mode: per account');
  } finally { delete globalThis.localStorage; }
});

test("the phone's clock comes from the quickest reply, a push's beating a pull's, and pull replies stamp it on the way out", async () => {
  const src = read('../src/lib/sync.js');
  const fn = src.slice(src.indexOf('export function betterClockSample'), src.indexOf('\n}\n', src.indexOf('export function betterClockSample')) + 2);
  const betterClockSample = new Function(`${fn.replace('export ', '')}; return betterClockSample;`)();
  const at = Date.now();
  const pull = { rtt: 900, kind: 'pull', at, offset: 1000 };
  assert.equal(betterClockSample(null, pull), true);
  assert.equal(betterClockSample(pull, { rtt: 1500, kind: 'pull', at, offset: 1200 }), false, 'a slower pull loses');
  assert.equal(betterClockSample(pull, { rtt: 1500, kind: 'push', at, offset: 1010 }), true, 'a push within twice the time wins');
  assert.equal(betterClockSample({ rtt: 50, kind: 'push', at, offset: 0 }, { rtt: 900, kind: 'pull', at, offset: 10 }), false);
  assert.equal(betterClockSample({ rtt: 50, kind: 'push', at, offset: 0 }, { rtt: 900, kind: 'pull', at, offset: 120000 }), true, 'the phone clock moved');
  assert.match(read('../server/routes/sync.js'), /server_time: serverTime, clock_time: new Date\(\)\.toISOString\(\)/);
  assert.match(src, /_learnClock\(data\.clock_time, sentAt, 'pull'\)/);
});

test('the status names the server and the sync it speaks; a rebuilt server is told apart by the account made-at time', () => {
  const auth = read('../server/routes/auth.js');
  assert.match(auth, /sync_version: 2,/);
  const la = read('../src/lib/local-account.js');
  assert.match(la, /if \(owner\.c && c && owner\.c !== c\) return \{ same: false \};/);
  assert.match(la, /if \(!owner\.i \|\| !i\) return \{ same: false, ambiguous: true, tag \};/);
});

// The Android app sends its account's token in the Authorization header,
// and its native HTTP layer can also send a cookie an earlier account's
// sign-in left behind. Our token decides, expired or not. A bearer that
// isn't ours (a reverse proxy in front of the web app can add one) is left
// alone: the cookie signs in, and the CSRF check applies to it.
test("our bearer token decides the session, never another account's cookie; anyone else's bearer leaves the web on its cookie", async (t) => {
  if (skip(t)) return;
  const { authenticate, signToken, JWT_SECRET } = await import('../server/middleware/auth.js');
  const { csrfProtect } = await import('../server/middleware/csrf.js');
  const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
  const a = user('hdr-a'), b = user('hdr-b');
  const ta = signToken({ id: a, username: 'a', role: 'user' }), tb = signToken({ id: b, username: 'b', role: 'user' });
  const expired = jwt.sign({ id: a, username: 'a', role: 'user', csrf: 'x', exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);
  const idp = jwt.sign({ sub: 'someone', email: 'a@example.com' }, 'the-identity-providers-own-key');
  const run = (headers, cookies, method = 'GET', path = '/api/foods') => {
    const req = { method, path, headers, cookies };
    authenticate(req, {}, () => {});
    let status = 200;
    const res = { status(c) { status = c; return { json() {} }; } };
    csrfProtect(req, res, () => {});
    return { who: req.user?.id ?? null, status };
  };
  const who = (h, c) => run(h, c).who;
  assert.equal(who({ authorization: `Bearer ${ta}` }, { nt_token: tb }), a, "our bearer's account, not the cookie's");
  assert.equal(who({ authorization: `Bearer ${expired}` }, { nt_token: tb }), null, 'our expired bearer is no session, never the cookie');
  assert.equal(who({ authorization: `Bearer ${idp}` }, { nt_token: tb }), b, "a proxy's or identity provider's bearer: the web's cookie");
  assert.equal(who({ authorization: 'Bearer opaque-proxy-token' }, { nt_token: tb }), b);
  assert.equal(who({}, { nt_token: tb }), b, 'the web signs in with its cookie');
  assert.equal(who({ authorization: `Bearer ${ta}` }, {}), a);
  assert.equal(who({ authorization: `Bearer ${idp}` }, {}), null);
  assert.equal(who({}, {}), null);
  // Changes: the cookie session needs its CSRF token, whatever bearer comes along.
  const csrfB = jwt.decode(tb).csrf;
  assert.equal(run({ authorization: `Bearer ${idp}` }, { nt_token: tb }, 'POST').status, 403, "someone else's bearer doesn't skip the cookie's CSRF check");
  assert.equal(run({ authorization: 'Bearer opaque-proxy-token' }, { nt_token: tb }, 'POST').status, 403);
  assert.equal(run({ authorization: `Bearer ${idp}`, 'x-csrf-token': csrfB }, { nt_token: tb }, 'POST').status, 200);
  assert.equal(run({}, { nt_token: tb }, 'POST').status, 403, 'the web without its CSRF token, as before');
  assert.equal(run({ authorization: `Bearer ${ta}` }, { nt_token: tb }, 'POST').status, 200, 'our bearer needs none');
  // The API signs in by its own API token, never the cookie: as before.
  assert.equal(run({ authorization: 'Bearer nt_api_token' }, { nt_token: tb }, 'POST', '/api/v1/foods').status, 200);
  assert.equal(run({ authorization: 'Bearer nt_api_token' }, { nt_token: tb }, 'POST', '/api/mcp').status, 200);
  assert.equal(run({}, { nt_token: tb }, 'POST', '/api/v1/foods').status, 403, 'a cookie alone gets no pass there');
});
