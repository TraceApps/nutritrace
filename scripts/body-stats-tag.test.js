/**
 * Days saved before weight and measurements carried their unit read in the
 * account's current unit in the Diary, Goals and Statistics, but as kg in
 * the adaptive TDEE, coaching, the email digest and Add Activity: a 180 lb
 * weigh-in counted as 180 kg there, and changing the unit setting made the
 * Diary read every untagged day in the new unit.
 *
 * POST /api/diary/body-stats-units tags them with the units the app shows
 * them in. Runs the real diary router against a temp database.
 * Single-user days (no user_id) are in body-stats-tag-single-user.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-bs-tag-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'bs-tag-test-only';

const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: diary } = await import('../server/routes/diary.js');
const { _bodyStatsWeightKg } = await import('../server/lib/adaptive-tdee.js');
const { readBodyStat, missingTags } = await import('../src/lib/body-stats-unit.js');

const alice = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('bs-alice', 'x', 'admin')").run().lastInsertRowid;
const bob = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('bs-bob', 'x', 'user')").run().lastInsertRowid;

let who = alice;
const app = express();
app.use(express.json());
app.use('/api/diary', (req, _res, next) => { req.user = { id: who, role: 'user' }; next(); }, diary);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.close(); db.close(); rmSync(temp, { recursive: true, force: true }); });

const OLD = '2026-04-28 09:00:00';
const day = (user, date, stats, times = null) => db.prepare(
  `INSERT INTO diary (user_id, date, items, body_stats, water, field_times, updated_at) VALUES (?, ?, '[]', ?, '[]', ?, ?)`
).run(user, date, JSON.stringify(stats), times == null ? null : JSON.stringify(times), OLD);
const row = (user, date) => db.prepare('SELECT body_stats, field_times, updated_at FROM diary WHERE user_id = ? AND date = ?').get(user, date);
const stats = (user, date) => JSON.parse(row(user, date).body_stats);
const post = (body, as = alice) => { who = as; return fetch(`${base}/api/diary/body-stats-units`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); };

// Alice shows lb / in. Her rc-era days have no tags.
day(alice, '2026-04-28', { weight: 180, waist: 34, body_fat: 20 });
day(alice, '2026-04-29', { weight: 179 }, { 'body_stats.weight': '2026-04-29T07:00:00.000Z', _base: '2026-04-29 06:00:00' });
day(alice, '2026-04-30', { body_fat: 21, neck: 15 });
// A day from before field times: none at all.
db.prepare(`UPDATE diary SET field_times = NULL WHERE user_id = ? AND date = '2026-04-30'`).run(alice);
day(alice, '2026-05-10', { weight: 81, weight_unit: 'kg', waist: 86, lengths_unit: 'cm' });
day(alice, '2026-05-11', { weight: '', body_fat: 19 });
day(alice, '2026-05-12', { weight: 178, weight_unit: '' });
day(alice, '2026-05-13', { weight: null, body_fat: 18 });
day(alice, '2026-04-27', { weight: 181 });
db.prepare(`UPDATE diary SET deleted_at = datetime('now') WHERE user_id = ? AND date = '2026-04-27'`).run(alice);
// Bob shows kg; his untagged day must wait for his own app.
day(bob, '2026-04-28', { weight: 70 });

test('before: the TDEE reads an untagged lb weigh-in as kg, and a unit change reinterprets it', () => {
  const bs = stats(alice, '2026-04-28');
  assert.equal(readBodyStat(bs, 'weight', 'lb', 'in'), 180);         // the Diary in lb
  assert.equal(_bodyStatsWeightKg(row(alice, '2026-04-28').body_stats), 180); // the TDEE: 180 kg
  assert.equal(readBodyStat(bs, 'weight', 'kg', 'cm'), 180);         // switch to kg: 180 kg
});

test('units the app does not show are refused', async () => {
  for (const body of [{}, { weight_unit: 'st', lengths_unit: 'in' }, { weight_unit: 'lb', lengths_unit: 'mm' }, { lengths_unit: 'ft' }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(missingTags(stats(alice, '2026-04-28')), { weight: true, lengths: true });
});

test("tags the account's untagged days with the units it shows, and nothing else", async () => {
  const res = await post({ weight_unit: 'lb', lengths_unit: 'in' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tagged: 4 });

  assert.deepEqual(stats(alice, '2026-04-28'), { weight: 180, waist: 34, body_fat: 20, weight_unit: 'lb', lengths_unit: 'in' });
  assert.deepEqual(stats(alice, '2026-04-29'), { weight: 179, weight_unit: 'lb' });
  assert.deepEqual(stats(alice, '2026-04-30'), { body_fat: 21, neck: 15, lengths_unit: 'in' });
  assert.deepEqual(stats(alice, '2026-05-10'), { weight: 81, weight_unit: 'kg', waist: 86, lengths_unit: 'cm' }, 'tagged day kept');
  assert.deepEqual(stats(alice, '2026-05-11'), { weight: '', body_fat: 19 }, 'no weight, no tag');
  assert.deepEqual(stats(alice, '2026-05-12'), { weight: 178, weight_unit: 'lb' }, 'an empty tag counts as none');
  assert.deepEqual(stats(alice, '2026-05-13'), { weight: null, body_fat: 18 }, 'a null weight, no tag');
  assert.deepEqual(stats(alice, '2026-04-27'), { weight: 181 }, 'a deleted day is left alone');
  assert.deepEqual(stats(bob, '2026-04-28'), { weight: 70 }, "another account's days wait for its own app");
});

test('after: every reader agrees, and a unit change no longer reinterprets history', () => {
  const bs = stats(alice, '2026-04-28');
  assert.equal(readBodyStat(bs, 'weight', 'lb', 'in'), 180);           // the Diary: unchanged
  assert.equal(readBodyStat(bs, 'waist', 'lb', 'in'), 34);
  assert.equal(readBodyStat(bs, 'weight', 'kg', 'cm'), 81.6);          // switch to kg: converted
  assert.equal(readBodyStat(bs, 'waist', 'kg', 'cm'), 86.4);
  assert.equal(Math.round(_bodyStatsWeightKg(row(alice, '2026-04-28').body_stats) * 10) / 10, 81.6); // the TDEE
});

test('a tag takes the time of the value it describes, and the day moves forward for phones', () => {
  const r29 = row(alice, '2026-04-29');
  assert.deepEqual(JSON.parse(r29.field_times), {
    'body_stats.weight': '2026-04-29T07:00:00.000Z', _base: '2026-04-29 06:00:00',
    'body_stats.weight_unit': '2026-04-29T07:00:00.000Z',
  }, 'no other field restamped');
  assert.notEqual(r29.updated_at, OLD, 'pulled again by phones');
  // Each tag takes its value's time (stamped by the insert trigger here).
  assert.deepEqual(JSON.parse(row(alice, '2026-04-28').field_times), {
    'body_stats.weight': OLD, 'body_stats.waist': OLD, 'body_stats.body_fat': OLD,
    'body_stats.weight_unit': OLD, 'body_stats.lengths_unit': OLD,
  });
  // A day with no times at all: its values have no time of their own, so
  // the tag is the oldest there is and loses to any edit, as they do.
  assert.deepEqual(JSON.parse(row(alice, '2026-04-30').field_times), { _base: OLD, 'body_stats.lengths_unit': '1970-01-01T00:00:00.000Z' });
  // Untouched days keep their time.
  assert.equal(row(alice, '2026-05-10').updated_at, OLD);
  assert.equal(row(alice, '2026-05-11').updated_at, OLD);
  assert.equal(row(alice, '2026-05-13').updated_at, OLD);
  assert.equal(row(bob, '2026-04-28').updated_at, OLD);
});

test('asking again changes nothing; another account gets its own units', async () => {
  const before = row(alice, '2026-04-28');
  assert.deepEqual(await (await post({ weight_unit: 'kg', lengths_unit: 'cm' })).json(), { tagged: 0 });
  assert.deepEqual(row(alice, '2026-04-28'), before, 'a later unit change keeps the tags');
  assert.deepEqual(await (await post({ weight_unit: 'kg', lengths_unit: 'cm' }, bob)).json(), { tagged: 1 });
  assert.deepEqual(stats(bob, '2026-04-28'), { weight: 70, weight_unit: 'kg' });
  assert.equal(_bodyStatsWeightKg(row(bob, '2026-04-28').body_stats), 70);
});

test('a newer edit of the weight still wins over the tag', async () => {
  // A phone edited Alice's 04-28 weight offline (in kg) after the day's
  // own time: its weight and its tag both beat the tag given here.
  who = alice;
  const res = await fetch(`${base}/api/diary/2026-04-28`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [], water: [], body_stats: { weight: 82, weight_unit: 'kg' },
      body_stats_changed: ['weight', 'weight_unit'],
      body_stats_edits: { weight: '2026-05-01T08:00:00.000Z', weight_unit: '2026-05-01T08:00:00.000Z' },
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const bs = stats(alice, '2026-04-28');
  assert.equal(bs.weight, 82);
  assert.equal(bs.weight_unit, 'kg');
  assert.equal(bs.waist, 34);
  assert.equal(bs.lengths_unit, 'in');
});

test('one unit alone tags only that kind (a device that chose only one)', async () => {
  day(bob, '2026-04-26', { weight: 71, hips: 100 });
  assert.deepEqual(await (await post({ lengths_unit: 'cm' }, bob)).json(), { tagged: 1 });
  assert.deepEqual(stats(bob, '2026-04-26'), { weight: 71, hips: 100, lengths_unit: 'cm' });
  assert.deepEqual(await (await post({ lengths_unit: 'cm' }, bob)).json(), { tagged: 0 }, 'the untagged weight is not read again');
});
