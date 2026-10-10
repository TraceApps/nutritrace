/**
 * #239 (@Chrristin): MCP write tools stored diary items without a uuid, and
 * the next save of that day from the app kept every one of them twice.
 *
 * The server's copy and the app's echo of the same item each got a fresh
 * random uuid, so the per-uuid merge matched nothing. The diet import and
 * restores of old exports stored uuid-less items the same way.
 *
 * Covered here: the merge adopting the twin's uuid for an echo, and the
 * write paths that now always store a uuid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeEntries, ensureUuids } from '../server/lib/diary-merge.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// What log_food stored: no uuid, source 'mcp', addedAt to the millisecond.
const mcp = (name, addedAt, extra = {}) => ({
  name, meal: 0, quantity: 1, portion: 100, unit: 'g', nutrition: { calories: 100 },
  food_server_id: 7, addedAt, source: 'mcp', imgUrl: '/uploads/x.jpg', ...extra,
});
// The app echoes an item back without imgUrl and without a uuid it never had.
const echo = ({ imgUrl, ...rest }) => ({ ...rest });

const DAY = [
  mcp('Oatmeal', '2026-09-24T04:36:43.101Z'),
  mcp('Banana', '2026-09-24T04:37:02.450Z'),
  mcp('Coffee', '2026-09-24T04:37:20.007Z'),
  mcp('Yogurt', '2026-09-24T04:37:34.982Z'),
];

test("the report: four MCP items, one save from the app, still four", () => {
  const { merged } = mergeEntries(DAY, DAY.map(echo), [], []);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged.map(e => e.name), ['Oatmeal', 'Banana', 'Coffee', 'Yogurt']);
  assert.equal(new Set(merged.map(e => e.uuid)).size, 4);
});

test('the day stays at four through repeated saves, including the stale-copy case that made three', () => {
  let stored = mergeEntries(DAY, DAY.map(echo), [], []).merged;
  // The app refetches and saves again: the echoes now carry the stored uuids.
  stored = mergeEntries(stored, stored.map(echo), [], []).merged;
  assert.equal(stored.length, 4);
  // A client still holding its old uuid-less copy (offline copy, Android) saves.
  stored = mergeEntries(stored, DAY.map(echo), [], []).merged;
  assert.equal(stored.length, 4);
  const uuids = stored.map(e => e.uuid);
  stored = mergeEntries(stored, DAY.map(echo), [], []).merged;
  assert.deepEqual(stored.map(e => e.uuid), uuids, 'uuids are stable once assigned');
});

test('an echo that was edited or moved still matches, and the edit wins', () => {
  const edited = { ...echo(DAY[1]), portion: 150, meal: 2, updatedAt: '2026-09-24T05:00:00.000Z' };
  const { merged } = mergeEntries(DAY, [echo(DAY[0]), edited, echo(DAY[2]), echo(DAY[3])], [], []);
  assert.equal(merged.length, 4);
  const banana = merged.find(e => e.name === 'Banana');
  assert.equal(banana.portion, 150);
  assert.equal(banana.meal, 2);
});

test('two genuinely identical items stay two, never collapse to one or grow to four', () => {
  const t = '2026-09-24T04:40:00.000Z';
  const twins = [mcp('Egg', t), mcp('Egg', t)];
  assert.equal(mergeEntries(twins, twins.map(echo), [], []).merged.length, 2);
  assert.equal(mergeEntries(twins, [echo(twins[0])], [], []).merged.length, 2, 'an item the app did not send is preserved, as before');
  // Each echo claims its own twin: edit the two eggs differently and both edits survive.
  const later = '2026-09-24T05:00:00.000Z';
  const edits = [{ ...echo(twins[0]), portion: 50, updatedAt: later }, { ...echo(twins[1]), portion: 60, updatedAt: later }];
  const { merged } = mergeEntries(twins, edits, [], []);
  assert.deepEqual(merged.map(e => e.portion).sort(), [50, 60]);
});

test('an echo never takes an item the app names by its uuid', () => {
  const t = '2026-09-24T04:40:00.000Z';
  const stored = [{ ...mcp('Egg', t), uuid: 'A' }, { ...mcp('Egg', t), uuid: 'B' }];
  const edited = { ...echo(mcp('Egg', t)), portion: 77, updatedAt: '2026-09-24T05:00:00.000Z' };
  const { merged } = mergeEntries(stored, [{ ...echo(stored[0]), uuid: 'A' }, edited], [], []);
  assert.deepEqual(merged.map(e => e.uuid).sort(), ['A', 'B']);
  assert.equal(merged.find(e => e.uuid === 'B').portion, 77, 'the uuid-less echo is B, so its edit lands on B');
  assert.equal(merged.find(e => e.uuid === 'A').portion, 100, 'A is untouched');
});

test("an echo never adopts a tombstoned item's uuid", () => {
  const stored = [{ ...DAY[0], uuid: 'gone' }, { ...DAY[1], uuid: 'kept' }];
  const { merged } = mergeEntries(stored, [echo(DAY[0]), echo(DAY[1])], [], ['gone']);
  assert.equal(merged.filter(e => e.uuid === 'kept').length, 1, 'the live item matches its twin');
  assert.equal(merged.filter(e => e.uuid === 'gone').length, 0, 'the deleted uuid stays deleted');
  // Known, and unchanged by #239: a stale copy of an item deleted elsewhere has
  // no twin left and arrives as a new item, exactly as it did before.
  assert.equal(merged.length, 2);
});

test('a brand-new uuid-less item with no twin is still added', () => {
  const { merged } = mergeEntries(DAY, [...DAY.map(echo), { name: 'Tea', meal: 1, addedAt: '2026-09-24T06:00:00.000Z' }], [], []);
  assert.equal(merged.length, 5);
});

test('an entry with no addedAt is never matched to a twin', () => {
  const legacy = [{ name: 'Old', meal: 0 }];
  assert.equal(mergeEntries(legacy, [{ name: 'Old', meal: 0 }], [], []).merged.length, 2, 'unchanged legacy behavior');
});

test('water logged through MCP does not double either', () => {
  const water = [{ amount: 250, addedAt: '2026-09-24T07:00:00.000Z' }, { amount: 500, addedAt: '2026-09-24T08:00:00.000Z' }];
  assert.equal(mergeEntries(water, water.map(w => ({ ...w })), [], []).merged.length, 2);
});

test('ensureUuids fills gaps and leaves existing uuids alone', () => {
  const out = ensureUuids([{ uuid: 'keep' }, { name: 'x' }, null]);
  assert.equal(out[0].uuid, 'keep');
  assert.match(out[1].uuid, /^[0-9a-f-]{36}$/);
  assert.equal(out[2], null);
});

test('the save routes hand the merge the client list as sent, so it can see echoes', () => {
  for (const f of ['../server/routes/diary.js', '../server/routes/sync.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /mergeEntries\([^)]*ensureUuids\(/, `${f} must not pre-assign random uuids`);
    assert.equal((src.match(/mergeEntries\(server(Items|Water), /g) || []).length, 2, f);
  }
});

test('every server path that writes diary items stores a uuid', () => {
  const write = read('../server/lib/mcp/_diary-write.js');
  assert.match(write, /next\.items = ensureUuids\(next\.items \?\? \[\]\);/);
  assert.match(write, /next\.water = ensureUuids\(next\.water \?\? \[\]\);/);
  assert.match(read('../server/routes/nutrition-import.js'), /JSON\.stringify\(ensureUuids\(nextItems\)\)/);
  const data = read('../server/routes/data.js');
  assert.match(data, /JSON\.stringify\(ensureUuids\(e\.items \|\| \[\]\)\)/);
  assert.match(data, /JSON\.stringify\(ensureUuids\(e\.water \|\| \[\]\)\)/);
});

test('REST writes go through the same MCP cores, so they are covered too', () => {
  const v1 = read('../server/routes/api/v1/diary.js');
  for (const core of ['logFoodCore', 'logWaterCore', 'logMealCore']) assert.match(v1, new RegExp(`import \\{ ${core} \\}`));
});

test('a second backfill gives stored items a uuid without bumping updated_at', () => {
  const db = read('../server/db.js');
  const block = db.slice(db.indexOf("key = 'diary_uuid_backfill_v2'"), db.indexOf("'diary_uuid_backfill_v2', ?)"));
  assert.match(block, /UPDATE diary SET items = \?, water = \? WHERE id = \?/);
  assert.doesNotMatch(block, /updated_at/, 'bumping it would make Android re-pull over unsynced edits');
});
