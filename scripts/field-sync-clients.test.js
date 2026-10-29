/**
 * What the apps send so the server can keep the newer edit of each field
 * (scripts/sync-field-merge.test.js has the server side): the fields an
 * edit changed, from the browser's offline queue, its online saves, and the
 * Android app (src/lib/sync-base.js).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildCatalogPush, collapseCatalogOps, collapseOps, buildDiaryPush, statsChanged, changedSince, pushShape, copyStamp,
} from '../src/lib/offline-edits.js';
import { baseOf, changesOf, statsBase, statsChanges } from '../src/lib/sync-base.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the app and the server list the same synced fields', () => {
  assert.equal(read('../src/lib/sync-fields.js'), read('../server/lib/sync-fields.js'));
});

test("a queued edit goes up with its own time, and a delete stays a delete, whatever the copy carried", () => {
  const copy = { id: 5, name: 'Oats', updated_at: '2026-01-01 00:00:00', changed_at: '2026-01-01 00:00:00', deleted_at: null, field_times: '{}' };
  const at = Date.parse('2026-10-01T12:00:00Z');
  const edit = { seq: 1, type: 'catalog', v: 2, table: 'foods', action: 'update', id: 5, data: { ...copy, name: 'Rolled oats' }, at, changed: ['name'] };
  const row = buildCatalogPush([edit]).foods[0];
  assert.equal(row.updated_at, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(row.changed_fields, ['name']);
  assert.equal(row.changed_at, undefined);
  assert.equal(row.field_times, undefined);
  // Edited, then deleted, offline: the delete goes (it used to go as an edit).
  const del = { seq: 2, type: 'catalog', v: 2, table: 'foods', action: 'delete', id: 5, data: null, at: at + 1000 };
  assert.equal(buildCatalogPush([edit, del]).foods[0].deleted_at, '2026-10-01T12:00:01.000Z');
  // Queued by the app before (no v): as it always went.
  const { v: _v, changed: _c, ...legacy } = edit;
  assert.equal(buildCatalogPush([legacy]).foods[0].updated_at, '2026-01-01 00:00:00');
  assert.equal(buildCatalogPush([legacy]).foods[0].changed_fields, undefined);
});

test('queued edits of one row say every field they changed; one that can\'t say makes the row whole', () => {
  const a = { seq: 1, type: 'catalog', v: 2, table: 'foods', action: 'update', id: 5, data: { name: 'A' }, at: 1, changed: ['name'] };
  const b = { seq: 2, type: 'catalog', v: 2, table: 'foods', action: 'update', id: 5, data: { brand: 'B' }, at: 2, changed: ['brand'] };
  assert.deepEqual(collapseCatalogOps([a, b])[0].changed.sort(), ['brand', 'name']);
  const old = { seq: 3, type: 'catalog', v: 2, table: 'foods', action: 'update', id: 5, data: { notes: 'n' }, at: 3 };
  assert.equal(collapseCatalogOps([a, old])[0].changed, null);
  assert.equal(buildCatalogPush([a, old]).foods[0].changed_fields, undefined);
  // A row made offline goes up whole.
  const made = { seq: 1, type: 'catalog', v: 2, table: 'foods', action: 'create', id: -7, data: { name: 'New' }, at: 1 };
  assert.equal(buildCatalogPush([made, { ...a, id: -7 }]).foods[0].changed_fields, undefined);
});

test("the fields an edit changed, in the server's names (a picture, a food's category)", () => {
  const shown = { id: 1, name: 'Oats', imgUrl: '/uploads/a.jpg', categories: ['Grains'], nutrition: { kcal: 1 }, favorite: 1 };
  assert.deepEqual(changedSince('foods', shown, { ...shown }), []);
  assert.deepEqual(changedSince('foods', shown, { ...shown, imgUrl: '', categories: ['Cereal'], nutrition: '{"kcal":1}' }).sort(), ['category', 'img_url']);
  assert.deepEqual(pushShape('foods', { imgUrl: 'x', categories: ['A'] }), { img_url: 'x', category: 'A' });
  assert.deepEqual(changedSince('activity', { name: 'Walk', kcal: 100 }, { name: 'Walk', kcal: 120, note: 'x' }), ['kcal']);
  assert.equal(copyStamp({ changed_at: 'b', updated_at: 'a' }), 'b');
});

test("a day's measurements changed offline: set, changed or taken away", () => {
  assert.deepEqual(statsChanged({ body_stats: { weight: 80, waist: 90 } }, { body_stats: { weight: 79, body_fat: 20 } }).sort(), ['body_fat', 'waist', 'weight']);
  assert.deepEqual(statsChanged({ body_stats: { weight: 80 } }, { bodyStats: { weight: '80' } }), []);
  const op = (seq, stats) => ({ seq, type: 'diary', date: '2026-09-01', day: { items: [], water: [], body_stats: {} }, at: seq, ...(stats ? { stats_changed: stats } : {}) });
  assert.deepEqual(collapseOps([op(1, ['weight']), op(2, ['waist'])])[0].stats_changed.sort(), ['waist', 'weight']);
  // Mixed with an op from before (which says nothing): the measurements they
  // hold or say, so one added elsewhere since stays.
  assert.deepEqual(collapseOps([op(1, ['weight']), op(2)])[0].stats_changed, ['weight']);
  assert.equal(collapseOps([op(1), op(2)])[0].stats_changed, undefined, 'ops from before say nothing');
  assert.deepEqual(buildDiaryPush([op(1, ['weight'])], []).diary[0].body_stats_changed, ['weight']);
  assert.equal(buildDiaryPush([op(1)], []).diary[0].body_stats_changed, undefined);
});

test('the phone: fields changed since the copy the server has, compared as the push sends them', () => {
  const server = { name: 'Oats', brand: null, nutrition: { kcal: 380 }, portion: 100, unit: 'g', favorite: 0, alt_units: [{ abbr: 'cup', grams: 80 }] };
  const base = baseOf('foods', server);
  // As the phone stores it: JSON text, the same values.
  const local = { ...server, nutrition: '{"kcal":380}', alt_units: '[{"abbr":"cup","grams":80}]', brand: '' };
  assert.deepEqual(changesOf('foods', local, base), []);
  assert.deepEqual(changesOf('foods', { ...local, notes: 'x', favorite: 1 }, base).sort(), ['favorite', 'notes']);
  assert.equal(changesOf('foods', local, null), null, 'no copy kept: the row goes whole');
  const sb = statsBase('{"weight":80,"waist":90}');
  assert.deepEqual(statsChanges({ weight: 80, body_fat: 20 }, sb).sort(), ['body_fat', 'waist']);
  assert.equal(statsChanges({ weight: 1 }, null), null);
});

test('queued edits of a row send each field with the time of the edit that changed it', () => {
  const a = { seq: 1, type: 'catalog', v: 2, table: 'foods', action: 'update', id: 5, data: { name: 'A' }, at: Date.parse('2026-10-01T10:00:00Z'), changed: ['name'] };
  const b = { seq: 2, type: 'catalog', v: 2, table: 'foods', action: 'update', id: 5, data: { notes: 'n' }, at: Date.parse('2026-10-01T12:00:00Z'), changed: ['notes'] };
  const row = buildCatalogPush([a, b]).foods[0];
  assert.deepEqual(row.field_edits, { name: '2026-10-01T10:00:00.000Z', notes: '2026-10-01T12:00:00.000Z' });
  assert.equal(row.updated_at, '2026-10-01T12:00:00.000Z');
  const op = (seq, at, stats) => ({ seq, type: 'diary', date: '2026-09-01', day: { items: [], water: [], body_stats: {} }, at: Date.parse(at), stats_changed: stats });
  const day = buildDiaryPush([op(1, '2026-10-01T10:00:00Z', ['weight']), op(2, '2026-10-01T12:00:00Z', ['waist'])], []).diary[0];
  assert.deepEqual(day.body_stats_edits, { weight: '2026-10-01T10:00:00.000Z', waist: '2026-10-01T12:00:00.000Z' });
});
