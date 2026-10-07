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
  assert.match(read('../src/routes/Foods.svelte'), /const ref = itemSourceRef\(item, \{ native: isNative \}\);/);
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
