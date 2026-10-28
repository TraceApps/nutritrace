/**
 * #298 (@ThomasLeMezo): with the link toggle on, a serving-size change
 * scaled from the values the editor opened with, so a nutrient typed later
 * was skipped (case 1) or had its old value written back over it (case 2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapshotOf, scaledFood } from '../src/lib/proportional-scale.js';

const NUTS = [{ id: 'calories' }, { id: 'proteins' }, { id: 'vitamin-c' }];
const opened = () => ({ portion: 100, calories: 100, proteins: 10, 'vitamin-c': '' });

// The editor's sequence: snapshot on open, type a nutrient (the fix
// re-snapshots), then change the serving size.
function edit(food, typed, { refresh }) {
  let snap = snapshotOf(food, NUTS);
  food = { ...food, ...typed };
  if (refresh) snap = snapshotOf(food, NUTS);
  return scaledFood({ ...food, portion: 200 }, snap, '__portion__', 200, NUTS);
}

test('case 1: a nutrient typed after opening scales with the serving size', () => {
  assert.equal(edit(opened(), { 'vitamin-c': 50 }, { refresh: false })['vitamin-c'], 50, 'the bug, as reported');
  const f = edit(opened(), { 'vitamin-c': 50 }, { refresh: true });
  assert.deepEqual([f.calories, f.proteins, f['vitamin-c']], [200, 20, 100]);
});

test('case 2: a corrected nutrient is scaled, not overwritten', () => {
  assert.equal(edit(opened(), { proteins: 12 }, { refresh: false }).proteins, 20, 'the bug, as reported');
  assert.equal(edit(opened(), { proteins: 12 }, { refresh: true }).proteins, 24);
});

test('a pending serving-size change applied while typing keeps the typed field', () => {
  const snap = snapshotOf(opened(), NUTS);
  const f = scaledFood({ ...opened(), portion: 200, proteins: 7 }, snap, '__portion__', 200, NUTS, 'proteins');
  assert.deepEqual([f.calories, f.proteins], [200, 7]);
});

test('comma decimals and empty fields', () => {
  const snap = snapshotOf({ portion: '50', calories: '1,5', proteins: '' }, NUTS);
  const f = scaledFood({ portion: '100', calories: '1,5', proteins: '' }, snap, '__portion__', 100, NUTS);
  assert.equal(f.calories, 3);
  assert.equal(f.proteins, '');
  assert.equal(scaledFood({}, snapshotOf({ portion: 0 }, NUTS), '__portion__', 100, NUTS), null);
});

test('the editor re-takes the baseline when a nutrient is typed with the toggle on', () => {
  const src = readFileSync(new URL('../src/routes/FoodEditor.svelte', import.meta.url), 'utf8').replace(/\r/g, '');
  const body = src.slice(src.indexOf('function onNutInput(id)'), src.indexOf('function _handleSaltSodiumDerivation'));
  assert.match(body, /if \(linked\) \{[\s\S]*run\(id\)[\s\S]*takeSnapshot\(\);/);
  assert.match(src, /values_for/);
});
