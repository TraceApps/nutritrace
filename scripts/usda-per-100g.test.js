/**
 * #290 (@wallinb): foods added from USDA were saved with every value
 * multiplied by 100 / servingSize.
 *
 * FoodData Central gives nutrients per 100 g (or 100 ml) for every data type,
 * Branded included; servingSize is only the label's serving. The fixtures are
 * real responses recorded from api.nal.usda.gov (see their _note), so these
 * tests never touch the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapUsdaFood, usdaFdcId } from '../src/lib/usda-map.js';
import { applyOffRefresh } from '../src/lib/off-refresh.js';
import { NUTRIMENTS } from '../src/lib/nutrition.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const R = JSON.parse(read('./fixtures/usda-290-responses.json'));
const IDS = NUTRIMENTS.map(n => n.id);
const food = (k, id) => R[k].foods.find(f => f.fdcId === id);

test('the reporter\'s popcorn (13 g serving) maps to 385 kcal per 100 g', () => {
  const item = food('search_popcorn', 2607245);
  assert.equal(item.servingSize, 13);
  const m = mapUsdaFood(item);
  assert.equal(m.portion, 100);
  assert.equal(m.unit, 'g');
  assert.equal(m.barcode, 'fdcId_2607245');
  assert.equal(m.nutrition.calories, 385);
  assert.equal(m.nutrition.proteins, 7.69);
  assert.equal(m.nutrition.sodium, 692);
  // The label says 50 kcal per 13 g serving: the same density.
  const label = R.food_2607245.labelNutrients.calories.value;
  assert.ok(Math.abs(m.nutrition.calories * 13 / 100 - label) < 0.5);
});

test('a serving over 100 g is not scaled down', () => {
  const g = mapUsdaFood(food('search_over_100', 2185701));
  assert.equal(g.nutrition.calories, 47);
  assert.equal(g.unit, 'g');
  const ml = mapUsdaFood(food('search_over_100', 463067));
  assert.equal(ml.nutrition.calories, 94);
  assert.equal(ml.unit, 'ml');
  assert.equal(ml.portion, 100);
});

test('a 100 g serving maps the same as before', () => {
  const m = mapUsdaFood(food('search_exactly_100', 2266000));
  assert.equal(m.nutrition.calories, 400);
  assert.equal(m.nutrition.sodium, 940);
});

test('the detail response (amount, per 100 g) agrees with the search one', () => {
  const s = mapUsdaFood(food('search_popcorn', 2607245)).nutrition;
  const d = mapUsdaFood(R.food_2607245).nutrition;
  assert.equal(d.calories, 385);
  for (const k of ['calories', 'proteins', 'fat', 'fiber', 'sodium', 'carbohydrates']) {
    assert.ok(Math.abs(s[k] - d[k]) < 0.1, k + ': ' + s[k] + ' vs ' + d[k]);
  }
});

test('SR Legacy detail: per 100 g, salt derived, net carbs kept', () => {
  const m = mapUsdaFood(R.food_171688);
  assert.equal(m.dataType, 'SR Legacy');
  assert.equal(m.portion, 100);
  assert.equal(m.unit, 'g');
  assert.equal(m.nutrition.calories, 52);
  assert.equal(m.nutrition.kilojoules, 218);
  assert.equal(m.nutrition.carbohydrates, 11.41); // 13.81 by difference, less 2.4 fiber
  assert.equal(m.nutrition.sodium, 1);
  assert.ok(m.nutrition.salt > 0);
  assert.equal(m.nutrition._derived.salt, true);
  assert.ok(m._offPresent.includes('salt') && m._offPresent.includes('calories'));
});

test('Refresh from USDA corrects a food saved by the old code', () => {
  const raw = R.food_2607245;
  // What the old mapper saved: every value times 100 / 13.
  const old = { name: 'Popcorn', portion: 100, unit: 'g', barcode: 'fdcId_2607245', calories: Math.round(385 * 100 / 13 * 10000) / 10000, proteins: 59.1538, sodium: 5323.0769 };
  const usda = mapUsdaFood(raw);
  const r = applyOffRefresh(old, usda, IDS);
  assert.equal(r.reason, 'updated');
  assert.equal(r.food.calories, 385);
  assert.equal(r.food.proteins, 7.69);
  assert.equal(r.food.sodium, 692);
  assert.equal(r.food.name, 'Popcorn');      // a name is never overwritten
  // A second refresh has nothing to change.
  assert.equal(applyOffRefresh(r.food, usda, IDS).reason, 'up_to_date');
  // A food kept per 13 g gets the label's serving values.
  assert.equal(applyOffRefresh({ ...old, portion: 13 }, usda, IDS).food.calories, 50.05);
});

test('usdaFdcId reads only fdcId_ barcodes', () => {
  assert.equal(usdaFdcId('fdcId_2607245'), '2607245');
  assert.equal(usdaFdcId(' fdcId_171688 '), '171688');
  assert.equal(usdaFdcId('0123456789012'), null);
  assert.equal(usdaFdcId(''), null);
  assert.equal(usdaFdcId(null), null);
});

test('api.js maps every USDA path through mapUsdaFood, with no serving factor', () => {
  const api = read('../src/lib/api.js');
  assert.doesNotMatch(api, /100 \/ servingSize/);
  assert.doesNotMatch(api, /_mapProduct\([^)]*,/);
  assert.match(api, /import \{ mapUsdaFood \} from '\.\/usda-map\.js'/);
  assert.match(api, /async lookupFdcId\(fdcId, apiKey\)/);
});

test('the food editor offers Refresh from USDA for fdcId_ foods, through Refresh from OFF\'s rules', () => {
  const ed = read('../src/routes/FoodEditor.svelte');
  assert.match(ed, /\$: usdaId = usdaFdcId\(food\.barcode\)/);
  assert.match(ed, /USDA\.lookupFdcId\(usdaId, \$usdaApiKey\)/);
  const fn = ed.slice(ed.indexOf('async function downloadFromUSDA'), ed.indexOf('// ── Scan Label'));
  assert.match(fn, /applyOffRefresh\(food, result/);
  assert.match(fn, /usda_needs_key/);
  assert.match(fn, /usda_offline/);
  assert.match(ed, /on:click=\{downloadFromUSDA\}/);
  const en = JSON.parse(read('../src/i18n/en.json')).food_editor;
  assert.equal(en.refresh_usda, 'Refresh from USDA');
  for (const k of ['usda_updated', 'usda_up_to_date', 'usda_not_found', 'usda_units_differ', 'usda_no_nutrition', 'usda_offline', 'usda_needs_key']) {
    assert.ok(en.toast[k], k);
  }
});
