/**
 * #347: logging a food that isn't in the library yet (Open Food Facts, USDA,
 * CookTrace, a catalog result) saves it to the library from the food as
 * found, not from the copy scaled to the amount being logged. The diary
 * entry is worked out from the row the server kept, so it carries the amount
 * typed even when the server hands back a food already in the library.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/routes/Foods.svelte', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('async function _addFoodToDiaryNoNav'), src.indexOf('async function _addFoodToDiary('));

test('a new food is saved from its template, not the scaled copy', () => {
  assert.match(fn, /async function _addFoodToDiaryNoNav\(food, qty, kind = null, template = null\)/);
  assert.match(fn, /const \{ id: _drop, \.\.\.rest \} = template \|\| food;/);
});

test('the diary entry is scaled from the row the server kept', () => {
  assert.match(fn, /const factor = _canScale\(baseUnit, unit, created\)\n\s+\? _unitScaleFactor\(basePortion, baseUnit, food\.portion, unit, created\)\n\s+: null;/);
  // A saved row in a unit that won't convert keeps the prompt's values.
  assert.match(fn, /nutrition: factor == null\n\s+\? food\.nutrition/);
  assert.match(fn, /portion: food\.portion,/);
  assert.match(fn, /\.map\(\(\[k, v\]\) => \[k, \(parseFloat\(v\) \|\| 0\) \* factor\]\)/);
});

test('both places that log at a typed amount pass the food as found', () => {
  assert.match(src, /await _addFoodToDiary\(food, parseDecimal\(promptServings\) \|\| 1, promptKind, promptFood\);/);
  assert.match(src, /await _addFoodToDiaryNoNav\(food, parseDecimal\(item\.servings\) \|\| 1, null, item\.food\);/);
  assert.match(src, /async function _addFoodToDiary\(food, qty, kind = null, template = null\)[\s\S]{0,200}_addFoodToDiaryNoNav\(food, qty, kind, template\)/);
});

test('canScale tells a real conversion from the numeric fallback', async () => {
  const { canScale, scaleFactor } = await import('../src/lib/units.js');
  // An edited "1 serving" row can't be logged at 165 g by ratio (165x).
  assert.equal(canScale('serving', 'g', { unit: 'serving', portion: 1 }), false);
  assert.equal(canScale('g', 'g', {}), true);
  assert.equal(canScale('g', 'oz', {}), true);
  assert.ok(Math.abs(scaleFactor(100, 'g', 6, 'oz') - 1.70097) < 0.001);
});
