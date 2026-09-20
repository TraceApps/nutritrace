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
