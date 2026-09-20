/**
 * The pure half of the browser's offline mode: applying queued days over the
 * mirror, collapsing the queue, and building the sync push. No browser needed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDiaryOps, dayWithOps, collapseOps, buildDiaryPush, sentSeqs, pushError, isOfflineError, emptyDay,
} from '../src/lib/offline-edits.js';

const day = (date, items) => ({ date, id: 7, items, water: [], body_stats: {} });
const op = (seq, date, items) => ({ seq, type: 'diary', date, day: { items, water: [], body_stats: {} }, at: 1_700_000_000_000 });

test('a queued day wins over what the server last sent', () => {
  const merged = applyDiaryOps([day('2026-09-20', [{ uuid: 'a' }])], [op(1, '2026-09-20', [{ uuid: 'a' }, { uuid: 'b' }])]);
  assert.equal(merged.get('2026-09-20').items.length, 2);
  assert.equal(merged.get('2026-09-20')._pending, true);
});

test('a day only ever edited offline still shows', () => {
  const d = dayWithOps([], [op(1, '2026-09-21', [{ uuid: 'x' }])], '2026-09-21');
  assert.equal(d.items.length, 1);
  assert.equal(d.date, '2026-09-21');
});

test('an unseen day reads as empty, never null', () => {
  assert.deepEqual(dayWithOps([], [], '2026-01-01'), emptyDay('2026-01-01'));
});

test('days the mirror has but the queue does not are untouched', () => {
  const merged = applyDiaryOps([day('2026-09-19', [{ uuid: 'z' }])], [op(1, '2026-09-20', [])]);
  assert.equal(merged.get('2026-09-19').items[0].uuid, 'z');
  assert.ok(!merged.get('2026-09-19')._pending);
});

test('only the last edit of a day is sent', () => {
  const ops = [op(1, '2026-09-20', [{ uuid: 'a' }]), op(2, '2026-09-20', [{ uuid: 'a' }, { uuid: 'b' }]), op(3, '2026-09-21', [])];
  const collapsed = collapseOps(ops);
  assert.deepEqual(collapsed.map(o => o.seq), [2, 3]);
  // Both edits of that day are cleared once the push lands, not just the last.
  assert.deepEqual(sentSeqs(ops).sort(), [1, 2, 3]);
});

test('the push is the row shape the Android app sends', () => {
  const payload = buildDiaryPush([op(1, '2026-09-20', [{ uuid: 'a' }])], [day('2026-09-20', [])]);
  assert.deepEqual(Object.keys(payload).sort(), ['activity', 'diary', 'fasts', 'foods', 'meals', 'settings', 'wellness', 'workouts'].sort());
  const row = payload.diary[0];
  assert.equal(row.server_id, 7);            // taken from the mirror when known
  assert.equal(row.client_id, null);
  assert.equal(row.date, '2026-09-20');
  assert.equal(row.items.length, 1);
  assert.deepEqual(row.deleted_uuids, { items: [], water: [] });
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a day first written offline has no server id, and the server matches it by date', () => {
  const row = buildDiaryPush([op(1, '2026-09-22', [])], []).diary[0];
  assert.equal(row.server_id, null);
  assert.equal(row.date, '2026-09-22');
});

test('deletions ride along so the merge can apply them', () => {
  const o = { seq: 1, type: 'diary', date: '2026-09-20', at: 1, day: { items: [], water: [], body_stats: {}, deleted_uuids: { items: ['gone'], water: [] } } };
  assert.deepEqual(buildDiaryPush([o], []).diary[0].deleted_uuids, { items: ['gone'], water: [] });
});

test('a refused table is reported, a successful push is not', () => {
  assert.equal(pushError({ tables: { diary: [{ id: 1 }] } }), null);
  assert.equal(pushError({ tables: { diary: { error: 'bad date' } } }), 'bad date');
  assert.equal(pushError(null), null);
});

test('a server being unreachable is told apart from a real answer', () => {
  assert.equal(isOfflineError(new TypeError('Failed to fetch')), true);
  assert.equal(isOfflineError(Object.assign(new Error('x'), { offline: true })), true);
  assert.equal(isOfflineError(new Error('The operation was aborted')), true);
  assert.equal(isOfflineError(new Error('API error 400')), false);
  assert.equal(isOfflineError(null), false);
});

test('a deletion made offline survives a later edit of the same day', () => {
  // Delete an item, then add another to the same day before going back online.
  // The app clears its own pending-deletions list after the first save, so the
  // second op carries none; without the union below the deleted item would be
  // resurrected by the server, which keeps whatever the client doesn't mention.
  const del = { seq: 1, type: 'diary', date: '2026-09-20', at: 1, day: { items: [{ uuid: 'keep' }], water: [], body_stats: {}, deleted_uuids: { items: ['gone'], water: ['spilled'] } } };
  const add = { seq: 2, type: 'diary', date: '2026-09-20', at: 2, day: { items: [{ uuid: 'keep' }, { uuid: 'new' }], water: [], body_stats: {} } };
  const row = buildDiaryPush([del, add], []).diary[0];
  assert.equal(row.items.length, 2, 'the newest day content is sent');
  assert.deepEqual(row.deleted_uuids.items, ['gone']);
  assert.deepEqual(row.deleted_uuids.water, ['spilled']);
});

test('tombstones from different days do not mix', () => {
  const a = { seq: 1, type: 'diary', date: '2026-09-20', at: 1, day: { items: [], water: [], body_stats: {}, deleted_uuids: { items: ['a'], water: [] } } };
  const b = { seq: 2, type: 'diary', date: '2026-09-21', at: 2, day: { items: [], water: [], body_stats: {}, deleted_uuids: { items: ['b'], water: [] } } };
  const rows = buildDiaryPush([a, b], []).diary;
  assert.deepEqual(rows.find(r => r.date === '2026-09-20').deleted_uuids.items, ['a']);
  assert.deepEqual(rows.find(r => r.date === '2026-09-21').deleted_uuids.items, ['b']);
});

// ── Foods made without a connection ─────────────────────────────────
import { applyFoodOps, collapseFoodOps, buildFoodsPush, createdFoodIds, remapFoodIds, newTempId, isTempId } from '../src/lib/offline-edits.js';

const fop = (seq, action, id, data) => ({ seq, type: 'food', action, id, data, at: 1_700_000_000_000 });

test('a temporary id cannot be mistaken for a server one', () => {
  const a = newTempId(), b = newTempId();
  assert.ok(isTempId(a) && isTempId(b) && a !== b);
  assert.equal(isTempId(42), false);
});

test('a food created offline shows in the catalogue at once', () => {
  const list = applyFoodOps([{ id: 5, name: 'Oats' }], [fop(1, 'create', -7, { name: 'Bread' })]);
  assert.equal(list.get(-7).name, 'Bread');
  assert.equal(list.get(-7)._pending, true);
  assert.equal(list.get(5).name, 'Oats');
});

test('editing a food created offline goes up as one create, not two rows', () => {
  const ops = [fop(1, 'create', -7, { name: 'Bread', portion: 40 }), fop(2, 'update', -7, { portion: 45 })];
  const rows = buildFoodsPush(ops).foods;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, -7);
  assert.equal(rows[0].server_id, null);
  assert.equal(rows[0].portion, 45);
  assert.equal(rows[0].name, 'Bread');
});

test('a food created and then deleted offline never goes up', () => {
  assert.deepEqual(collapseFoodOps([fop(1, 'create', -7, { name: 'Oops' }), fop(2, 'delete', -7, null)]), []);
});

test('deleting a food that exists on the server sends a deletion', () => {
  const row = buildFoodsPush([fop(1, 'delete', 12, null)]).foods[0];
  assert.equal(row.server_id, 12);
  assert.ok(row.deleted_at);
});

test('editing an existing food keeps its server id', () => {
  const row = buildFoodsPush([fop(1, 'update', 12, { name: 'Renamed' })]).foods[0];
  assert.equal(row.server_id, 12);
  assert.equal(row.client_id, null);
  assert.equal(row.deleted_at, null);
  assert.equal(row.name, 'Renamed');
});

test('diary entries follow a new food to its real id', () => {
  const map = createdFoodIds({ tables: { foods: [{ client_id: -7, server_id: 99 }] } });
  assert.deepEqual(map, { '-7': 99 });
  const day = { date: '2026-09-20', items: [{ uuid: 'a', id: -7, food_server_id: -7, name: 'Bread' }, { uuid: 'b', id: 5 }] };
  const fixed = remapFoodIds(day, map);
  assert.equal(fixed.items[0].id, 99);
  assert.equal(fixed.items[0].food_server_id, 99);
  assert.equal(fixed.items[1].id, 5, 'server ids are left alone');
});

test('remapping does nothing when the server created nothing', () => {
  const day = { items: [{ id: -7 }] };
  assert.equal(remapFoodIds(day, {}), day);
});
