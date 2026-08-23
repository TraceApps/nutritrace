import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeEntries, ensureUuids } from '../server/lib/diary-merge.js';

// These tests cover the Option C merge logic that replaced the old
// wholesale replace on PUT /api/diary/:date + POST /api/sync/push. The
// primary correctness property is that a client PUT can never wipe
// server items that the client didn't address explicitly (via
// deleted_uuids or an existing tombstone). See project_nutritrace_diary_
// persist_gap for the 2026-07-23 and 2026-08-11 incidents that motivated
// the redesign.

const _item = (uuid, extras = {}) => ({ uuid, meal: 0, addedAt: '2026-08-10T10:00:00.000Z', name: `item-${uuid}`, ...extras });

test('server preserves items when client sends empty list without tombstones', () => {
  // The exact bug we're fixing: mobile PUT with items:[] (stale cache) and
  // no deleted_uuids must NOT wipe the server's items.
  const server = [_item('a'), _item('b'), _item('c')];
  const { merged, newTombstoneUuids } = mergeEntries(server, [], [], []);
  assert.equal(merged.length, 3, 'all server items preserved');
  assert.deepEqual(merged.map(i => i.uuid).sort(), ['a', 'b', 'c']);
  assert.equal(newTombstoneUuids.length, 0);
});

test('client add: new uuid is added, existing preserved', () => {
  const server = [_item('a'), _item('b')];
  const client = [_item('a'), _item('b'), _item('c')];
  const { merged } = mergeEntries(server, client, [], []);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map(i => i.uuid).sort(), ['a', 'b', 'c']);
});

test('explicit delete via deleted_uuids removes the item + records a tombstone', () => {
  const server = [_item('a'), _item('b'), _item('c')];
  const client = [_item('a'), _item('c')]; // client dropped b
  const { merged, newTombstoneUuids } = mergeEntries(server, client, ['b'], []);
  assert.deepEqual(merged.map(i => i.uuid).sort(), ['a', 'c']);
  assert.deepEqual(newTombstoneUuids, ['b']);
});

test('tombstoned uuid stays gone even if a stale client re-sends it', () => {
  const server = [_item('a')]; // b already deleted, not on server
  const client = [_item('a'), _item('b')]; // stale client still has b
  const { merged } = mergeEntries(server, client, [], ['b']);
  assert.deepEqual(merged.map(i => i.uuid), ['a']);
});

test('item edited later: client copy with newer updatedAt wins', () => {
  const server = [_item('a', { name: 'old', updatedAt: '2026-08-10T09:00:00Z', portion: 100 })];
  const client = [_item('a', { name: 'new', updatedAt: '2026-08-10T11:00:00Z', portion: 200 })];
  const { merged } = mergeEntries(server, client, [], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'new');
  assert.equal(merged[0].portion, 200);
});

test('item edited later on server: server copy retained over older client', () => {
  const server = [_item('a', { updatedAt: '2026-08-10T11:00:00Z', name: 'server-newer' })];
  const client = [_item('a', { updatedAt: '2026-08-10T09:00:00Z', name: 'client-stale' })];
  const { merged } = mergeEntries(server, client, [], []);
  assert.equal(merged[0].name, 'server-newer');
});

test('addedAt is used as timestamp fallback when updatedAt absent', () => {
  const server = [_item('a', { addedAt: '2026-08-10T09:00:00Z', name: 'old' })];
  const client = [_item('a', { addedAt: '2026-08-10T11:00:00Z', name: 'new' })];
  const { merged } = mergeEntries(server, client, [], []);
  assert.equal(merged[0].name, 'new');
});

test('client item without uuid is auto-assigned and preserved', () => {
  const server = [_item('a')];
  const client = [_item('a'), { meal: 0, name: 'no-uuid', addedAt: '2026-08-10T12:00Z' }];
  const { merged } = mergeEntries(server, client, [], []);
  assert.equal(merged.length, 2);
  assert.ok(merged.every(i => typeof i.uuid === 'string' && i.uuid.length > 0));
});

test('server items without uuid get one assigned as they pass through', () => {
  const server = [{ meal: 0, name: 'legacy', addedAt: '2026-08-10T10:00Z' }];
  const client = [];
  const { merged } = mergeEntries(server, client, [], []);
  assert.equal(merged.length, 1);
  assert.ok(typeof merged[0].uuid === 'string' && merged[0].uuid.length > 0);
  assert.equal(merged[0].name, 'legacy');
});

test('edit-vs-delete race: tombstone (destructive) beats live copy', () => {
  // Client A edited item 'a'; client B deleted it. B pushes first with
  // deleted_uuids:['a']. Then A pushes with an edited 'a' still in items.
  // The merge must respect the tombstone → 'a' stays gone.
  const server = []; // B already applied
  const client = [_item('a', { name: 'A-edited', updatedAt: '2026-08-10T12:00Z' })];
  const { merged } = mergeEntries(server, client, [], ['a']);
  assert.equal(merged.length, 0);
});

test('two independent adds with different uuids both survive', () => {
  // Device A adds a banana (uuid=1). Device B adds a banana (uuid=2). Both
  // push. Result: two banana items, as intended (independent additions).
  const server = [_item('1', { name: 'banana' })];
  const client = [_item('1', { name: 'banana' }), _item('2', { name: 'banana' })];
  const { merged } = mergeEntries(server, client, [], []);
  assert.equal(merged.length, 2);
});

test('duplicate uuid in client list de-dupes to the later-timestamp copy', () => {
  const server = [];
  const client = [
    _item('a', { name: 'first',  updatedAt: '2026-08-10T10:00Z' }),
    _item('a', { name: 'second', updatedAt: '2026-08-10T11:00Z' }),
  ];
  const { merged } = mergeEntries(server, client, [], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'second');
});

test('empty inputs return empty output', () => {
  const { merged, newTombstoneUuids } = mergeEntries([], [], [], []);
  assert.deepEqual(merged, []);
  assert.deepEqual(newTombstoneUuids, []);
});

test('null/undefined inputs are handled gracefully', () => {
  const { merged, newTombstoneUuids } = mergeEntries(null, undefined, null, undefined);
  assert.deepEqual(merged, []);
  assert.deepEqual(newTombstoneUuids, []);
});

test('newTombstoneUuids only contains uuids not already in priorTombstones', () => {
  const server = [_item('a'), _item('b')];
  const client = [];
  const { newTombstoneUuids } = mergeEntries(server, client, ['a', 'b'], ['a']);
  assert.deepEqual(newTombstoneUuids, ['b'], 'a already tombstoned, only b is new');
});

test('non-object entries in input arrays are skipped without throwing', () => {
  const server = [_item('a'), null, undefined, 'string', 42];
  const client = [_item('b')];
  const { merged } = mergeEntries(server, client, [], []);
  assert.deepEqual(merged.map(i => i.uuid).sort(), ['a', 'b']);
});

test('water merge works with the same primitive shape', () => {
  const server = [{ uuid: 'w1', amount: 250, time: '08:00 AM' }, { uuid: 'w2', amount: 500, time: '10:00 AM' }];
  const client = [{ uuid: 'w1', amount: 250, time: '08:00 AM' }, { uuid: 'w3', amount: 300, time: '12:00 PM' }];
  const { merged } = mergeEntries(server, client, ['w2'], []);
  assert.deepEqual(merged.map(w => w.uuid).sort(), ['w1', 'w3']);
});

test('ensureUuids assigns uuids only to entries missing one', () => {
  const input = [{ uuid: 'a', name: 'x' }, { name: 'y' }, { uuid: 'c', name: 'z' }];
  const out = ensureUuids(input);
  assert.equal(out.length, 3);
  assert.equal(out[0].uuid, 'a');
  assert.ok(out[1].uuid && out[1].uuid.length > 0);
  assert.equal(out[2].uuid, 'c');
});

test('ensureUuids is a no-op (returns same array) when every entry already has one', () => {
  const input = [{ uuid: 'a' }, { uuid: 'b' }];
  const out = ensureUuids(input);
  assert.equal(out, input, 'returns original array when nothing to change');
});

test('ensureUuids returns empty array for non-array input', () => {
  assert.deepEqual(ensureUuids(null), []);
  assert.deepEqual(ensureUuids(undefined), []);
  assert.deepEqual(ensureUuids({}), []);
});

test('regression: the 2026-08-11 incident cannot happen under the new merge', () => {
  // Reproduce the incident shape:
  //   - Server had 24 items on 2026-08-10 for user 1
  //   - Mobile's local was empty by the time the 22:34 ET water PUT ran
  //   - PUT sent items:[], water:[{...}]
  // Under merge: the 24 server items must survive; the water gets added.
  const serverItems = Array.from({ length: 24 }, (_, i) => _item(`item-${i}`, { name: `Food ${i}` }));
  const clientItems = [];
  const { merged: mergedItems } = mergeEntries(serverItems, clientItems, [], []);
  assert.equal(mergedItems.length, 24, 'all 24 server items preserved despite empty client push');

  const serverWater = [];
  const clientWater = [{ uuid: 'new-water-1', amount: 3785, time: '10:34 PM' }];
  const { merged: mergedWater } = mergeEntries(serverWater, clientWater, [], []);
  assert.deepEqual(mergedWater.map(w => w.amount), [3785], 'water add still lands');
});
