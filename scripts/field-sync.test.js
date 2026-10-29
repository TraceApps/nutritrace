/**
 * field-sync.js, the per-field rule shared by the Trace apps: the newer edit
 * of each field stays, fields that belong together stay together, and a
 * delete made before a later edit doesn't win. The same file (and this same
 * test) in every app that uses it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  instantMs, laterThan, readTimes, rowTimes, fieldTime, sameValue, fieldUnits, mergeEdit,
  deleteLoses, editRevives, stampTimes, createdTimes, fieldTimesSql, rowBase, rowChanges,
} from '../server/lib/field-sync.js';

let Database = null;
try { Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); } catch { /* not built for this Node */ }
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

// Change every copy in every app together, then this hash in each app.
const FIELD_SYNC_SHA256 = 'd646ceeefde15c84051c7bd0d3ac94190102bb5d2b6ef283634fd31f3f388f0f';
test('field-sync.js is the same in the app, the server and every Trace app', () => {
  assert.equal(read('../src/lib/field-sync.js'), read('../server/lib/field-sync.js'));
  assert.equal(createHash('sha256').update(read('../server/lib/field-sync.js')).digest('hex'), FIELD_SYNC_SHA256);
});

const T = s => instantMs(`2026-10-01T${s}Z`);

test('times: zones are instants, SQLite times are UTC, whole seconds compare', () => {
  assert.equal(instantMs('2026-10-01 12:00:00'), Date.UTC(2026, 9, 1, 12));
  assert.equal(instantMs('2026-10-01T14:00:00+02:00'), Date.UTC(2026, 9, 1, 12));
  assert.equal(instantMs('2026-10-01T12:00:00.250+00:00'), Date.UTC(2026, 9, 1, 12) + 250);
  assert.ok(Number.isNaN(instantMs('yesterday')));
  assert.ok(Number.isNaN(instantMs(null)));
  assert.equal(laterThan('2026-10-01 12:00:01', '2026-10-01T12:00:00.900Z'), true);
  assert.equal(laterThan('2026-10-01T12:00:00.900Z', '2026-10-01 12:00:00'), false, 'same second: a tie');
  assert.equal(laterThan('nope', '2026-10-01 12:00:00'), false);
});

test('field times: own time, else _base, else none', () => {
  const t = readTimes('{"_base":"2026-10-01T10:00:00Z","name":"2026-10-01T11:00:00Z"}');
  assert.equal(fieldTime(t, 'name'), T('11:00:00'));
  assert.equal(fieldTime(t, 'brand'), T('10:00:00'));
  assert.ok(Number.isNaN(fieldTime({}, 'brand')));
  assert.deepEqual(readTimes('not json'), {});
  assert.deepEqual(readTimes('[1]'), {});
});

test('values stored another way are the same value; different text never is', () => {
  assert.ok(sameValue(null, ''));
  assert.ok(sameValue(true, 1));
  assert.ok(sameValue('1', true));
  assert.ok(sameValue('12.5', 12.5));
  assert.ok(!sameValue(0, null));
  assert.ok(!sameValue('a', 'b'));
  // Text is compared as written.
  assert.ok(!sameValue('007', '7'), 'a barcode');
  assert.ok(!sameValue('7.0', '7'));
  assert.ok(!sameValue('', '[]'), 'a note that says []');
  assert.ok(!sameValue('{"a":1}', '{ "a": 1 }'), 'two spellings in a note');
  assert.ok(!sameValue('{"a":1}', { a: 1 }), 'only a JSON field reads JSON');
  // A field that holds JSON: what it holds.
  assert.ok(sameValue('{"b":1,"a":2}', { a: 2, b: 1 }, true));
  assert.ok(sameValue('{"a":1}', '{ "a": 1 }', true));
  assert.ok(sameValue([], null, true));
  assert.ok(sameValue('{}', null, true));
  assert.ok(!sameValue('{"a":1}', '{"a":2}', true));
});

test('groups first, then every other field on its own', () => {
  assert.deepEqual(fieldUnits(['a', 'b', 'c', 'd'], [['b', 'c'], ['x']]), [['b', 'c'], ['a'], ['d']]);
});

const FIELDS = ['name', 'brand', 'portion', 'unit'];
const GROUPS = [['portion', 'unit']];
const here = (times, extra = {}) => ({ name: 'Oats', brand: 'Acme', portion: 40, unit: 'g', field_times: JSON.stringify(times), ...extra });

test('an older edit of another field goes in; the newer field here stays', () => {
  // Made at 10:30 offline: the brand. Here at 11:00: the name.
  const existing = here({ _base: '2026-10-01T10:00:00Z', name: '2026-10-01T11:00:00Z' }, { name: 'Rolled oats' });
  const m = mergeEdit({ existing, values: { name: 'Oats', brand: 'Acme Co', portion: 40, unit: 'g' }, fields: FIELDS, groups: GROUPS, at: T('10:30:00') });
  assert.equal(m.row.name, 'Rolled oats');
  assert.equal(m.row.brand, 'Acme Co');
  assert.deepEqual(m.applied, ['brand']);
  assert.deepEqual(m.lost, ['name']);
  assert.equal(m.times.brand, '2026-10-01T10:30:00.000Z');
  assert.equal(m.times.name, '2026-10-01T11:00:00Z');
  assert.ok(m.write && m.differs);
});

test('a newer edit that says what it changed leaves the rest alone', () => {
  // Here at 11:00: the name. Made at 11:30 on a copy from before: the brand.
  const existing = here({ _base: '2026-10-01T10:00:00Z', name: '2026-10-01T11:00:00Z' }, { name: 'Rolled oats' });
  const values = { name: 'Oats', brand: 'Acme Co', portion: 40, unit: 'g' };
  const said = mergeEdit({ existing, values, fields: FIELDS, groups: GROUPS, changed: ['brand'], at: T('11:30:00') });
  assert.equal(said.row.name, 'Rolled oats');
  assert.equal(said.row.brand, 'Acme Co');
  // An edit that can't say changed every field it sent, at its own time.
  const whole = mergeEdit({ existing, values, fields: FIELDS, groups: GROUPS, at: T('11:30:00') });
  assert.equal(whole.row.name, 'Oats');
});

test('fields that belong together stay together', () => {
  // Here at 11:00: the unit (40 g to 40 oz, say). Made at 10:30: the portion.
  const existing = here({ _base: '2026-10-01T10:00:00Z', unit: '2026-10-01T11:00:00Z' }, { unit: 'oz' });
  const older = mergeEdit({ existing, values: { portion: 100, unit: 'g' }, fields: FIELDS, groups: GROUPS, changed: ['portion'], at: T('10:30:00') });
  assert.deepEqual([older.row.portion, older.row.unit], [40, 'oz']);
  assert.deepEqual(older.lost, ['portion']);
  const newer = mergeEdit({ existing, values: { portion: 100, unit: 'g' }, fields: FIELDS, groups: GROUPS, changed: ['portion'], at: T('11:30:00') });
  assert.deepEqual([newer.row.portion, newer.row.unit], [100, 'g']);
  assert.equal(newer.times.unit, '2026-10-01T11:30:00.000Z');
});

test('an edit of text to a value that only looks the same still goes in', () => {
  const existing = { notes: '7', field_times: JSON.stringify({ _base: '2026-10-01T10:00:00Z' }) };
  const m = mergeEdit({ existing, values: { notes: '007' }, fields: ['notes'], at: T('11:00:00') });
  assert.deepEqual([m.row.notes, m.write], ['007', true]);
  const j = mergeEdit({ existing: { items: '[{"a":1}]' }, values: { items: [{ a: 1 }] }, fields: ['items'], json: ['items'], at: T('11:00:00') });
  assert.equal(j.write, false, 'the same JSON, parsed');
});

test("each field keeps its own edit time when the sender knows it (fieldAt)", () => {
  // Here at 11:00: the name. The edit: its name changed at 10:30, its brand at 11:30.
  const existing = here({ _base: '2026-10-01T10:00:00Z', name: '2026-10-01T11:00:00Z' }, { name: 'Rolled oats' });
  const m = mergeEdit({ existing, values: { name: 'Oats!', brand: 'Acme Co' }, fields: FIELDS, changed: ['name', 'brand'],
    at: T('11:30:00'), fieldAt: { name: T('10:30:00'), brand: T('11:30:00') } });
  assert.deepEqual([m.row.name, m.row.brand], ['Rolled oats', 'Acme Co']);
  assert.equal(m.times.brand, '2026-10-01T11:30:00.000Z');
  // A field's own time never later than the edit's.
  const later = mergeEdit({ existing, values: { brand: 'X' }, fields: FIELDS, at: T('10:30:00'), fieldAt: { brand: T('23:00:00') } });
  assert.equal(later.times.brand, '2026-10-01T10:30:00.000Z');
});

test('a new row takes every field it sends, whatever it says it changed', () => {
  const n = mergeEdit({ existing: null, values: { name: 'New', brand: 'B' }, fields: FIELDS, changed: [], at: T('09:00:00') });
  assert.deepEqual([n.row.name, n.row.brand], ['New', 'B']);
});

test('a tie goes to the edit arriving; an unchanged value is no edit', () => {
  const existing = here({ name: '2026-10-01T11:00:00.800Z' });
  assert.equal(mergeEdit({ existing, values: { name: 'X' }, fields: FIELDS, at: T('11:00:00.100') }).row.name, 'X');
  const same = mergeEdit({ existing, values: { name: 'Oats', brand: 'Acme' }, fields: FIELDS, at: T('12:00:00') });
  assert.equal(same.write, false);
  assert.deepEqual(same.times, readTimes(existing.field_times), 'nothing stamped');
});

test('a row with no times at all takes the edit; a new row takes all of it', () => {
  const m = mergeEdit({ existing: { name: 'A', brand: 'B' }, values: { name: 'C' }, fields: FIELDS, at: T('09:00:00') });
  assert.equal(m.row.name, 'C');
  assert.equal(m.row.brand, 'B');
  const n = mergeEdit({ existing: null, values: { name: 'C', brand: 'D' }, fields: FIELDS, at: T('09:00:00') });
  assert.deepEqual(n.applied, ['name', 'brand']);
});

test('a delete loses to a later edit, and an older edit does not bring a row back', () => {
  const existing = here({ _base: '2026-10-01T10:00:00Z', brand: '2026-10-01T11:00:00Z' });
  assert.equal(deleteLoses({ existing, fields: FIELDS, at: T('10:30:00') }), T('11:00:00'));
  assert.equal(deleteLoses({ existing, fields: FIELDS, at: T('11:30:00') }), null);
  assert.equal(deleteLoses({ existing, fields: FIELDS, at: T('11:00:00.500') }), null, 'a tie goes to the delete');
  // Brought back (deleted_at cleared) after a delete made elsewhere: that delete loses.
  const back = here({ _base: '2026-10-01T10:00:00Z', deleted_at: '2026-10-01T11:00:00Z' });
  assert.equal(deleteLoses({ existing: back, fields: FIELDS, at: T('10:30:00') }), T('11:00:00'));
  // A row from before the times: its last write stands for every field.
  assert.equal(deleteLoses({ existing: { updated_at: '2026-10-01 11:00:00' }, fields: FIELDS, at: T('10:30:00') }), T('11:00:00'));
  assert.equal(mergeEdit({ existing: { name: 'A', updated_at: '2026-10-01 11:00:00' }, values: { name: 'B' }, fields: FIELDS, at: T('10:30:00') }).row.name, 'A');
  const gone = { ...existing, deleted_at: '2026-10-01 12:00:00', field_times: JSON.stringify(stampTimes(existing.field_times, ['deleted_at'], T('11:45:00'))) };
  assert.equal(editRevives({ existing: gone, at: T('11:40:00') }), false);
  assert.equal(editRevives({ existing: gone, at: T('11:45:00') }), false, 'a tie keeps the delete');
  assert.equal(editRevives({ existing: gone, at: T('11:50:00') }), true);
  // No time of its delete kept: deleted_at stands for it.
  assert.equal(editRevives({ existing: { deleted_at: '2026-10-01 12:00:00' }, at: T('11:50:00') }), false);
  assert.deepEqual(createdTimes(T('09:00:00')), { _base: '2026-10-01T09:00:00.000Z' });
});

test('the triggers stamp every write that changes a field, unless it stamps its own', (t) => {
  if (!Database) { t.skip('better-sqlite3 is not built for this Node'); return; }
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE foods (id INTEGER PRIMARY KEY, name TEXT, brand TEXT, uses INTEGER DEFAULT 0, updated_at TEXT, changed_at TEXT, field_times TEXT)`);
  db.prepare(`INSERT INTO foods (name, brand, updated_at, changed_at) VALUES ('Old', 'Row', '2026-01-01 00:00:00', 'then')`).run();
  // An app's own trigger on every write (a pull's cursor): starting the
  // times writes no row, so it doesn't move.
  db.exec(`CREATE TRIGGER cursor AFTER UPDATE ON foods FOR EACH ROW WHEN NEW.changed_at IS OLD.changed_at
           BEGIN UPDATE foods SET changed_at = 'moved' WHERE id = NEW.id; END;`);
  db.exec(fieldTimesSql('foods', ['name', 'brand']));
  db.exec(fieldTimesSql('foods', ['name', 'brand'])); // twice: as each start does
  const row = id => db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
  const get = id => readTimes(row(id).field_times);
  assert.equal(row(1).changed_at, 'then');
  assert.equal(row(1).field_times, null);
  assert.deepEqual(rowTimes(row(1)), { _base: '2026-01-01 00:00:00' }, 'a row from before counts from its last write');
  db.prepare(`UPDATE foods SET uses = uses + 1 WHERE id = 1`).run();
  assert.equal(row(1).field_times, null, 'a write of no stamped field starts nothing');
  db.prepare(`UPDATE foods SET name = 'New', brand = 'Row', uses = uses + 1 WHERE id = 1`).run();
  const st = get(1);
  assert.equal(st._base, '2026-01-01 00:00:00', 'its first write starts them from its last');
  assert.ok(Number.isFinite(instantMs(st.name)) && Math.abs(instantMs(st.name) - Date.now()) < 5000);
  assert.equal(st.brand, undefined, 'unchanged: no stamp');
  db.prepare(`UPDATE foods SET brand = 'Two', name = 'Two' WHERE id = 1`).run();
  assert.ok(get(1).brand && get(1).name, 'two fields in one write: both stamped');
  // Times that aren't JSON never stop a write: they start again.
  db.prepare(`UPDATE foods SET field_times = 'oops' WHERE id = 1`).run();
  db.prepare(`UPDATE foods SET name = 'Three' WHERE id = 1`).run();
  assert.ok(get(1).name && get(1)._base === '2026-01-01 00:00:00' || get(1).name, 'stamped');
  db.prepare(`UPDATE foods SET brand = 'Mine', field_times = ? WHERE id = 1`).run(JSON.stringify({ _base: 'x', brand: '2026-02-02T00:00:00.000Z' }));
  assert.deepEqual(get(1), { _base: 'x', brand: '2026-02-02T00:00:00.000Z' });
  db.prepare(`INSERT INTO foods (name) VALUES ('Made')`).run();
  assert.ok(Number.isFinite(instantMs(get(2)._base)) && Math.abs(instantMs(get(2)._base) - Date.now()) < 5000, 'made now');
  db.prepare(`INSERT INTO foods (name, updated_at) VALUES ('Restored', '2025-05-05 05:05:05')`).run();
  assert.equal(get(3)._base, '2025-05-05 05:05:05', 'a restored row counts from its own time');
  db.prepare(`INSERT INTO foods (name, field_times) VALUES ('Made', '{"_base":"2026-03-03T00:00:00.000Z"}')`).run();
  assert.equal(get(4)._base, '2026-03-03T00:00:00.000Z');
  db.close();
});

test('the phone says which fields it changed since the copy the server has', () => {
  const fields = ['name', 'nutrition', 'favorite', 'barcode'];
  const json = ['nutrition'];
  const base = rowBase(fields, { name: 'Oats', nutrition: '{"kcal":1}', favorite: 1, barcode: '007' }, json);
  assert.deepEqual(rowChanges(fields, { name: 'Oats', nutrition: { kcal: 1 }, favorite: true, barcode: '007' }, base, json), []);
  assert.deepEqual(rowChanges(fields, { name: 'Oats!', nutrition: { kcal: 1 }, favorite: 0, barcode: '7' }, base, json), ['name', 'favorite', 'barcode']);
  assert.deepEqual(rowChanges(fields, { name: 'Oats', nutrition: '{ "kcal": 1 }', favorite: 1, barcode: '007' }, base, json), [], 'the same JSON spelled another way');
  assert.deepEqual(rowChanges(fields, { name: 'Oats', nutrition: '{ "kcal": 1 }', favorite: 1, barcode: '007' }, base), ['nutrition'], 'not said to be JSON: as text');
  assert.equal(rowChanges(fields, { name: 'x' }, null), null);
  assert.equal(rowChanges(fields, { name: 'x' }, 'garbage'), null);
});
