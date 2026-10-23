/**
 * A CookTrace recipe's ingredients keep the values for their amounts (#296).
 *
 * CookTrace sent each ingredient's pantry values for the pantry serving
 * (usually 100 g), and NutriTrace showed them for the recipe amount: 250 g
 * of flour had the values of 100 g. CookTrace now scales each item to its
 * amount (scaled: true) and says which serving the values are for (basis).
 * An amount it can't convert (a pinch against 100 g) comes unscaled
 * (scaled: false): NutriTrace shows that row at the serving the values are
 * for, says what CookTrace couldn't convert, and Edit rescales from there.
 * Recipes imported before get the refresh offer. Older CookTrace servers
 * send neither field and import exactly as before.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { CookTrace } = await import('../src/lib/cooktraceApi.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const recipe = (items) => ({ id: 8, name: 'Pancakes', servings: 1, nutrition: {}, items });

test('scaled items keep the values CookTrace sent for the amount', () => {
  const [flour] = CookTrace.mapRecipe(recipe([
    { name: 'Flour', quantity: 1, portion: 250, unit: 'g', nutrition: { calories: 910 }, basis: { amount: 100, unit: 'g' }, scaled: true },
  ])).items;
  assert.equal(flour.portion, 250);
  assert.equal(flour.unit, 'g');
  assert.equal(flour.nutrition.calories, 910);
  assert.equal(flour.ct_scaled, true);
  assert.equal(flour.ct_amount, undefined);
});

test('an amount CookTrace could not convert shows at its serving, marked', () => {
  const [salt, taste, eggs, blank] = CookTrace.mapRecipe(recipe([
    { name: 'Salt', quantity: 1, portion: 1, unit: 'pinch', nutrition: { sodium: 38.7 }, basis: { amount: 100, unit: 'g' }, scaled: false, amount_text: '1 pinch' },
    { name: 'Pepper', quantity: 1, portion: 1, unit: 'g', qty_text: 'to taste', nutrition: { calories: 251 }, basis: { amount: 100, unit: 'g' }, scaled: false, amount_text: 'to taste' },
    // "2 eggs" with no unit: CookTrace shows the pantry unit, but couldn't convert "2".
    { name: 'Egg', quantity: 1, portion: 2, unit: 'g', nutrition: { calories: 72 }, basis: { amount: 50, unit: 'g' }, scaled: false, amount_text: '2' },
    { name: 'Oil', quantity: 1, portion: 1, unit: 'ml', nutrition: { calories: 884 }, basis: { amount: 100, unit: 'ml' }, scaled: false, amount_text: '' },
  ])).items;
  assert.equal(salt.portion, 100);
  assert.equal(salt.unit, 'g');
  assert.equal(salt.nutrition.sodium, 38.7);
  assert.equal(salt.ct_scaled, false);
  assert.equal(salt.ct_amount, '1 pinch');
  assert.equal(taste.ct_amount, 'to taste');
  assert.equal(eggs.ct_amount, '2');
  assert.equal(eggs.portion, 50);
  assert.equal(blank.ct_amount, '');
});

test('an older CookTrace server imports exactly as before', () => {
  const old = { name: 'Flour', quantity: 1, portion: 250, unit: 'g', nutrition: { calories: 364 } };
  const [flour] = CookTrace.mapRecipe(recipe([old])).items;
  assert.deepEqual(Object.keys(flour).sort(), ['brand', 'name', 'nutrition', 'portion', 'quantity', 'unit']);
  assert.equal(flour.portion, 250);
  assert.equal(flour.nutrition.calories, 364);
});

test('the recipe editor marks unscaled rows, clears the mark on Edit, and offers the refresh', () => {
  const src = read('../src/routes/MealEditor.svelte');
  assert.match(src, /\{#if item\.ct_amount != null\}[\s\S]{0,300}meal_editor\.ct_unscaled'[\s\S]{0,120}meal_editor\.ct_unscaled_blank/);
  // Once such an amount is set here, the save counts the ingredients, not CookTrace's rollup without it.
  assert.match(src, /_ctAmountFixed = \(meal\.items \|\| \[\]\)\.some\(it => it\?\.ct_scaled === false && it\.ct_amount == null\);\s*if \(_hasSourceRollup && _itemsMatchSourceCount && !_ctAmountFixed\)/);
  assert.match(src, /const \{ ct_amount: _ctAmount, \.\.\.kept \} = item;\s*items\[editingIndex\] = \{ \.\.\.kept,/);
  assert.match(src, /_unscaledImport = \(fresh\.items \|\| \[\]\)\.some\(it => typeof it\?\.scaled === 'boolean'\)\s*&& !\(meal\.items \|\| \[\]\)\.some\(it => typeof it\?\.ct_scaled === 'boolean'\)/);
  assert.match(src, /if \(_unscaledImport \|\|/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.meal_editor.ct_unscaled, /\{amount\}/);
  assert.ok(en.meal_editor.ct_unscaled_blank);
});
