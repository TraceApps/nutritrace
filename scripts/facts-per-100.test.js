/**
 * #297 (@fatman00): the Nutrition Facts label's right column can read
 * "Per 100 g" (100 ml for drinks) instead of % Daily Value, so foods with
 * different serving sizes can be compared.
 *
 * Per 100 = value / serving in grams (or ml) * 100. The serving goes through
 * lib/units.js; a serving with no weight leaves the column blank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { servingInBase, itemsInBase } from '../src/lib/units.js';
import { per100, factsColumn, FACTS_COLUMN_DEFAULT } from '../src/lib/facts-column.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const EM_DASH = String.fromCharCode(8212);

test('a gram serving: 30 g with 12 g protein is 40 g per 100 g', () => {
  const base = servingInBase(30, 'g');
  assert.deepEqual(base, { amount: 30, basis: 'g' });
  close(per100(12, base), 40);
  close(per100(150, base), 500);
});

test('other mass units convert to grams', () => {
  close(servingInBase(1, 'oz').amount, 28.3495);
  assert.equal(servingInBase(1, 'oz').basis, 'g');
  close(servingInBase(0.5, 'kg').amount, 500);
});

test('a milliliter serving reads per 100 ml', () => {
  const base = servingInBase(250, 'ml');
  assert.deepEqual(base, { amount: 250, basis: 'ml' });
  close(per100(105, base), 42);
  assert.deepEqual(servingInBase(1, 'cup'), { amount: 236.588, basis: 'ml' });
});

test('a food\'s own serving unit with grams: 1 slice = 35 g', () => {
  const bread = { alt_units: [{ abbr: 'slice', grams: 35 }] };
  const base = servingInBase(2, 'slice', bread);
  assert.deepEqual(base, { amount: 70, basis: 'g' });
  close(per100(7, base), 10);
  // The foods column stores alt_units as a JSON string (#237).
  assert.deepEqual(servingInBase(1, 'Slice', { alt_units: JSON.stringify(bread.alt_units) }), { amount: 35, basis: 'g' });
});

test('an alt unit on a per-100-ml food goes through density', () => {
  const oil = { nutrition_basis: 'ml', density_g_ml: 0.92, alt_units: [{ abbr: 'bottle', grams: 460 }] };
  const base = servingInBase(1, 'bottle', oil);
  assert.equal(base.basis, 'ml');
  close(base.amount, 500);
  // No density: 1 ml = 1 g, and it reads the way the food is labeled.
  assert.deepEqual(servingInBase(1, 'bottle', { nutrition_basis: 'ml', alt_units: oil.alt_units }), { amount: 460, basis: 'ml' });
});

test('density bridges a volume serving to a per-100-g food and back', () => {
  const honey = { nutrition_basis: 'g', density_g_ml: 1.42 };
  const tbsp = servingInBase(1, 'tbsp', honey);
  assert.equal(tbsp.basis, 'g');
  close(tbsp.amount, 14.787 * 1.42);
  const milk = { nutrition_basis: 'ml', density_g_ml: 1.03 };
  const g = servingInBase(103, 'g', milk);
  assert.equal(g.basis, 'ml');
  close(g.amount, 100);
});

test('no density across systems: 1 ml = 1 g, labeled the way the food is', () => {
  // Open Food Facts imports a per-100-ml drink as "100 g" (api.js).
  assert.deepEqual(servingInBase(100, 'g', { nutrition_basis: 'ml' }), { amount: 100, basis: 'ml' });
  assert.deepEqual(servingInBase(250, 'ml', { nutrition_basis: 'g' }), { amount: 250, basis: 'g' });
});

test('a serving with no weight leaves the column blank', () => {
  assert.equal(servingInBase(1, 'piece'), null);
  assert.equal(servingInBase(1, 'piece', { alt_units: [{ abbr: 'slice', grams: 35 }] }), null);
  assert.equal(servingInBase(1, 'scoop', { alt_units: [{ abbr: 'scoop', grams: 0 }] }), null);
  assert.equal(servingInBase(1, ''), null);
  assert.equal(per100(12, null), null);
});

test('a zero, missing or bad serving leaves the column blank', () => {
  assert.equal(servingInBase(0, 'g'), null);
  assert.equal(servingInBase(-5, 'g'), null);
  assert.equal(servingInBase(null, 'g'), null);
  assert.equal(servingInBase('abc', 'g'), null);
  assert.equal(per100(12, { amount: 0, basis: 'g' }), null);
});

test('a missing value stays blank, a zero value stays zero', () => {
  const base = { amount: 50, basis: 'g' };
  assert.equal(per100(null, base), null);
  assert.equal(per100('', base), null);
  assert.equal(per100(undefined, base), null);
  assert.equal(per100(0, base), 0);
  close(per100('2.5', base), 5);
});

test('a meal is weighed from its items, or left blank', () => {
  const items = [
    { portion: 100, unit: 'g' },
    { portion: 1, unit: 'slice', quantity: 2, alt_units: [{ abbr: 'slice', grams: 35 }] },
  ];
  assert.deepEqual(itemsInBase(items), { amount: 170, basis: 'g' });
  assert.equal(itemsInBase([...items, { portion: 1, unit: 'piece' }]), null, 'an item with no weight');
  assert.equal(itemsInBase([...items, { portion: 200, unit: 'ml' }]), null, 'grams and milliliters mixed');
  assert.equal(itemsInBase([]), null);
  assert.equal(itemsInBase(null), null);
});

test('the setting defaults to % Daily Value and keeps today\'s label', () => {
  assert.equal(FACTS_COLUMN_DEFAULT, 'dv');
  assert.equal(factsColumn(undefined), 'dv');
  assert.equal(factsColumn(null), 'dv');
  assert.equal(factsColumn('bogus'), 'dv');
  assert.equal(factsColumn('per100'), 'per100');
  const settings = read('src/stores/settings.js');
  assert.match(settings, /createSettingStore\('nutritionFactsColumn', +FACTS_COLUMN_DEFAULT\)/);
  const box = read('src/components/ui/NutritionFactsBox.svelte');
  assert.match(box, /% Daily Value\*/, 'the default header is unchanged');
});

test('the setting syncs, has its row, strings and search words', () => {
  const settings = read('src/stores/settings.js');
  const at = settings.indexOf('export const USER_PREFS');
  const prefs = settings.slice(at, settings.indexOf(']);', at));
  assert.match(prefs, /'nutritionFactsColumn'/, 'in USER_PREFS: synced to the server and the Android app');
  const page = read('src/routes/settings/Foods.svelte');
  assert.match(page, /<option value="dv">/);
  assert.match(page, /<option value="per100">/);
  const en = JSON.parse(read('src/i18n/en.json'));
  assert.equal(en.settings_foods_picker.facts_column, 'Right Column');
  assert.equal(en.settings_foods_picker.facts_column_dv, '% Daily Value');
  assert.equal(en.settings_foods_picker.facts_column_per100, 'Per 100 g');
  assert.equal(en.nutrition_facts.per_100, 'Per 100 {unit}');
  for (const v of Object.values({ ...en.settings_foods_picker, ...en.nutrition_facts })) {
    assert.ok(!v.includes(EM_DASH), 'no em dashes');
  }
  assert.match(read('src/routes/Settings.svelte'), /foods: +\[[^\]]*'daily value'[^\]]*'per 100 g'/);
});

test('every Nutrition Facts label is given its serving', () => {
  const sheet = read('src/components/ui/FoodDetailSheet.svelte');
  assert.equal((sheet.match(/portion=\{_factsServing\.portion\}/g) || []).length, 2, 'sheet and desktop pane');
  const trace = read('src/components/ai/Trace.svelte');
  assert.equal((trace.match(/<NutritionFactsBox[^>]*portion=/g) || []).length, 2, 'both Trace cards');
});
