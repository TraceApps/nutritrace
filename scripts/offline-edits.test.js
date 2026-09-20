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
import { applyCatalogOps, collapseCatalogOps, buildCatalogPush, createdIds, remapIds, newTempId, isTempId } from '../src/lib/offline-edits.js';

const fop = (seq, action, id, data, table = 'foods') => ({ seq, type: 'catalog', table, action, id, data, at: 1_700_000_000_000 });

test('a temporary id cannot be mistaken for a server one', () => {
  const a = newTempId(), b = newTempId();
  assert.ok(isTempId(a) && isTempId(b) && a !== b);
  assert.equal(isTempId(42), false);
});

test('a food created offline shows in the catalogue at once', () => {
  const list = applyCatalogOps([{ id: 5, name: 'Oats' }], [fop(1, 'create', -7, { name: 'Bread' })]);
  assert.equal(list.get(-7).name, 'Bread');
  assert.equal(list.get(-7)._pending, true);
  assert.equal(list.get(5).name, 'Oats');
});

test('editing a food created offline goes up as one create, not two rows', () => {
  const ops = [fop(1, 'create', -7, { name: 'Bread', portion: 40 }), fop(2, 'update', -7, { portion: 45 })];
  const rows = buildCatalogPush(ops).foods;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, -7);
  assert.equal(rows[0].server_id, null);
  assert.equal(rows[0].portion, 45);
  assert.equal(rows[0].name, 'Bread');
});

test('a food created and then deleted offline never goes up', () => {
  assert.deepEqual(collapseCatalogOps([fop(1, 'create', -7, { name: 'Oops' }), fop(2, 'delete', -7, null)]), []);
});

test('deleting a food that exists on the server sends a deletion', () => {
  const row = buildCatalogPush([fop(1, 'delete', 12, null)]).foods[0];
  assert.equal(row.server_id, 12);
  assert.ok(row.deleted_at);
});

test('editing an existing food keeps its server id', () => {
  const row = buildCatalogPush([fop(1, 'update', 12, { name: 'Renamed' })]).foods[0];
  assert.equal(row.server_id, 12);
  assert.equal(row.client_id, null);
  assert.equal(row.deleted_at, null);
  assert.equal(row.name, 'Renamed');
});

test('diary entries follow a new food to its real id', () => {
  const map = createdIds({ tables: { foods: [{ client_id: -7, server_id: 99 }] } });
  assert.deepEqual(map, { '-7': 99 });
  const day = { date: '2026-09-20', items: [{ uuid: 'a', id: -7, food_server_id: -7, name: 'Bread' }, { uuid: 'b', id: 5 }] };
  const fixed = remapIds(day, map);
  assert.equal(fixed.items[0].id, 99);
  assert.equal(fixed.items[0].food_server_id, 99);
  assert.equal(fixed.items[1].id, 5, 'server ids are left alone');
});

test('remapping does nothing when the server created nothing', () => {
  const day = { items: [{ id: -7 }] };
  assert.equal(remapIds(day, {}), day);
});

test('meals and recipes queue onto the meals side of the push', () => {
  const ops = [fop(1, 'create', -3, { name: 'Chilli', is_recipe: true }, 'meals'), fop(2, 'create', -4, { name: 'Bread' }, 'foods')];
  const push = buildCatalogPush(ops);
  assert.equal(push.meals.length, 1);
  assert.equal(push.foods.length, 1);
  assert.equal(push.meals[0].name, 'Chilli');
  assert.equal(push.foods[0].name, 'Bread');
});

test('ids created in either table are remapped together', () => {
  const map = createdIds({ tables: { foods: [{ client_id: -4, server_id: 40 }], meals: [{ client_id: -3, server_id: 30 }] } });
  assert.deepEqual(map, { '-4': 40, '-3': 30 });
  const day = { items: [{ id: -4 }, { id: -3, is_recipe: true }] };
  assert.deepEqual(remapIds(day, map).items.map(i => i.id), [40, 30]);
});

test('manual workouts queue onto the activity side of the push', () => {
  const ops = [
    fop(1, 'create', -9, { date: '2026-09-20', name: 'Walk', kcal: 180 }, 'activity'),
    fop(2, 'delete', 4, null, 'activity'),
  ];
  const push = buildCatalogPush(ops);
  assert.equal(push.activity.length, 2);
  assert.equal(push.foods.length, 0);
  const made = push.activity.find(r => r.client_id === -9);
  assert.equal(made.name, 'Walk');
  assert.equal(made.server_id, null);
  const gone = push.activity.find(r => r.server_id === 4);
  assert.ok(gone.deleted_at);
});

test('a workout logged offline shows in the day it belongs to', () => {
  const rows = applyCatalogOps([{ id: 3, date: '2026-09-20', name: 'Row', kcal: 90 }],
    [fop(1, 'create', -9, { date: '2026-09-20', name: 'Walk', kcal: 180 }, 'activity')], 'activity');
  assert.equal(rows.size, 2);
  assert.equal(rows.get(-9).kcal, 180);
  assert.equal(rows.get(-9)._pending, true);
});

test('a setting changed offline goes up once, with the last value', () => {
  const ops = [
    { seq: 1, type: 'setting', key: 'diaryShowActivity', data: true, at: 1 },
    { seq: 2, type: 'setting', key: 'diaryShowActivity', data: false, at: 2 },
    { seq: 3, type: 'setting', key: 'weightUnit', data: 'lb', at: 3 },
  ];
  const rows = buildCatalogPush(ops).settings;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.key === 'diaryShowActivity').value, false);
  assert.equal(rows.find(r => r.key === 'weightUnit').value, 'lb');
});

// ── Fasting without a connection ────────────────────────────────────
import { activeFastRow, fastList, newFastRow, fastWith } from '../src/lib/offline-edits.js';

const past = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test('a fast started offline runs from now, with the goal the user asked for', () => {
  const row = newFastRow({ goal_hours: 18 });
  assert.equal(row.goal_hours, 18);
  assert.equal(row.end_at, null);
  assert.ok(Date.now() - new Date(row.start_at).getTime() < 5_000);
});

test('a goal the server would refuse falls back to sixteen hours', () => {
  assert.equal(newFastRow({ goal_hours: 0 }).goal_hours, 16);
  assert.equal(newFastRow({ goal_hours: 900 }).goal_hours, 16);
  assert.equal(newFastRow({}).goal_hours, 16);
});

test('a back-dated start is kept, but only within the last day', () => {
  const now = Date.now();
  assert.equal(newFastRow({ start_at: new Date(now - 3 * 3600_000).toISOString() }, now).start_at,
    new Date(now - 3 * 3600_000).toISOString());
  // Two days back, and tomorrow, both become now, as the server does.
  assert.equal(newFastRow({ start_at: new Date(now - 48 * 3600_000).toISOString() }, now).start_at, new Date(now).toISOString());
  assert.equal(newFastRow({ start_at: new Date(now + 3600_000).toISOString() }, now).start_at, new Date(now).toISOString());
});

test('the running fast is the one with no end, queue included', () => {
  const mirror = [{ id: 3, start_at: past(30), end_at: past(14), goal_hours: 16 }];
  const started = fop(1, 'create', -5, { start_at: past(2), end_at: null, goal_hours: 18 }, 'fasts');
  assert.equal(activeFastRow(mirror, []), null, 'nothing running on the server');
  assert.equal(activeFastRow(mirror, [started]).id, -5);
  assert.equal(activeFastRow(mirror, [started]).goal_hours, 18);
});

test('ending a fast offline clears it and leaves it in the history', () => {
  const stopped = past(1);
  const mirror = [{ id: 7, start_at: past(17), end_at: null, goal_hours: 16, notes: null }];
  const ended = fop(1, 'update', 7, fastWith(mirror, [], 7, { end_at: stopped }), 'fasts');
  assert.equal(activeFastRow(mirror, [ended]), null);
  const list = fastList(mirror, [ended]);
  assert.equal(list.length, 1);
  assert.equal(list[0].end_at, stopped);
  assert.equal(list[0].goal_hours, 16, 'the rest of the row is kept');
});

test('the queued fast carries every column, because the merge writes them all', () => {
  const mirror = [{ id: 7, start_at: past(17), end_at: null, goal_hours: 20, notes: 'hi', user_id: 2 }];
  const row = fastWith(mirror, [], 7, { end_at: past(1) });
  assert.deepEqual(Object.keys(row).sort(), ['end_at', 'goal_hours', 'notes', 'start_at']);
  assert.equal(row.goal_hours, 20);
  assert.equal(row.notes, 'hi');
});

test('a fast this browser never saw cannot be changed offline', () => {
  assert.equal(fastWith([], [], 99, { end_at: past(1) }), null);
});

test('fasts are newest first and cut to the limit asked for', () => {
  const mirror = [
    { id: 1, start_at: past(72), end_at: past(60) },
    { id: 2, start_at: past(48), end_at: past(30) },
    { id: 3, start_at: past(20), end_at: null },
  ];
  assert.deepEqual(fastList(mirror, []).map(f => f.id), [3, 2, 1]);
  assert.deepEqual(fastList(mirror, [], 2).map(f => f.id), [3, 2]);
});

test('a fast deleted offline drops out of the history', () => {
  const mirror = [{ id: 4, start_at: past(30), end_at: past(14) }];
  assert.deepEqual(fastList(mirror, [fop(1, 'delete', 4, null, 'fasts')]), []);
});

test('fasts ride on their own side of the push, and a new one gets a real id', () => {
  const ops = [
    fop(1, 'create', -5, { start_at: past(6), end_at: null, goal_hours: 18 }, 'fasts'),
    fop(2, 'delete', 4, null, 'fasts'),
  ];
  const push = buildCatalogPush(ops);
  assert.equal(push.fasts.length, 2);
  assert.equal(push.foods.length, 0);
  assert.equal(push.diary.length, 0);
  const made = push.fasts.find(r => r.client_id === -5);
  assert.equal(made.goal_hours, 18);
  assert.equal(made.server_id, null);
  assert.ok(push.fasts.find(r => r.server_id === 4).deleted_at);
  assert.deepEqual(createdIds({ tables: { fasts: [{ client_id: -5, server_id: 12 }] } }), { '-5': 12 });
});

test('a fast started and ended offline goes up as one finished fast', () => {
  const [began, stopped] = [past(18), past(1)];
  const ops = [
    fop(1, 'create', -5, { start_at: began, end_at: null, goal_hours: 16 }, 'fasts'),
    fop(2, 'create', -5, { start_at: began, end_at: stopped, goal_hours: 16 }, 'fasts'),
  ];
  const rows = buildCatalogPush(ops).fasts;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, -5);
  assert.equal(rows[0].end_at, stopped);
});
