/**
 * Foundation foods saved at 0 kcal (found while building #314).
 *
 * Since October 2020 FoodData Central's Foundation foods no longer show
 * nutrient 1008 ("Energy", kcal); most give only 2047 (Energy, Atwater
 * General Factors) and 2048 (Energy, Atwater Specific Factors), both kcal.
 * The mapper read 1008 and 1062 (kJ) only, so "Yogurt, Greek, plain, whole
 * milk" (fdcId 2259794), ranked first among USDA results, came in at 0 kcal
 * and log_external_food refused it as having no calories.
 *
 * Calories come from 1008, else 2048, else 2047, else 1062 kJ / 4.184
 * (USDA_ENERGY_IDS in usda-map.js). The fixtures are real USDA data
 * (api.nal.usda.gov and its Foundation Foods download, see their _note);
 * nothing here reaches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as usdaMap from '../src/lib/usda-map.js';
import { applyOffRefresh } from '../src/lib/off-refresh.js';
import { NUTRIMENTS } from '../src/lib/nutrition.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const E = read('./fixtures/usda-energy-responses.json');
const R290 = read('./fixtures/usda-290-responses.json');
// #314's recorded "greek yogurt plain" search: Foundation, SR Legacy, Survey, Branded.
const GREEK = read('./fixtures/mcp-external-foods.json').usda_search_greek;
// The mapper keeps 4 decimals.
const r4 = (x) => Math.round(x * 10000) / 10000;
const { mapUsdaFood } = usdaMap;
const IDS = NUTRIMENTS.map(n => n.id);

const inSearch = (search, id) => search.foods.find(f => f.fdcId === id);
// The energy rows a reply has, by id: search rows carry nutrientId/value,
// detail rows nutrient.id/amount.
function energyOf(item) {
  const out = {};
  for (const fn of item.foodNutrients) {
    const id = fn.nutrientId ?? fn.nutrient?.id;
    if ([1008, 1062, 2047, 2048].includes(id)) out[id] = fn.value ?? fn.amount;
  }
  return out;
}
// The same reply without some of its rows (a real food, fewer energy ids).
const without = (item, ...ids) => ({
  ...item,
  foodNutrients: item.foodNutrients.filter(fn => !ids.includes(fn.nutrientId ?? fn.nutrient?.id)),
});

test('the order is 1008, then 2048, then 2047', () => {
  assert.deepEqual(usdaMap.USDA_ENERGY_IDS, [1008, 2048, 2047]);
});

test('Greek yogurt, whole milk (Foundation, 2047 and 2048 only): search reply', () => {
  const item = inSearch(GREEK, 2259794);
  assert.equal(item.dataType, 'Foundation');
  const e = energyOf(item);
  assert.deepEqual(Object.keys(e).map(Number).sort(), [2047, 2048], 'USDA gives no 1008 or 1062 for it');
  const m = mapUsdaFood(item);
  assert.equal(m.nutrition.calories, e[2048]);
  assert.ok(m.nutrition.calories > 90 && m.nutrition.calories < 100);
  assert.equal(m.nutrition.kilojoules, Math.round(e[2048] * 4.184 * 10) / 10);
  assert.ok(m._offPresent.includes('calories'), 'calories count as reported');
  assert.ok(m._offPresent.includes('kilojoules'));
});

test('the same food from the detail reply (nutrient.id, amount) agrees', () => {
  const d = E.food_2259794;
  assert.equal(d.fdcId, 2259794);
  const e = energyOf(d);
  assert.ok(e[2048] != null && e[1008] == null);
  const m = mapUsdaFood(d);
  assert.equal(m.nutrition.calories, r4(e[2048]));
  assert.ok(m._offPresent.includes('calories'));
  const s = mapUsdaFood(inSearch(GREEK, 2259794)).nutrition;
  for (const k of ['calories', 'proteins', 'fat']) {
    assert.ok(Math.abs(s[k] - m.nutrition[k]) < 0.1, `${k}: ${s[k]} vs ${m.nutrition[k]}`);
  }
});

test('a Foundation food with 2047 only takes 2047', () => {
  // The search reply's Greek yogurt without its 2048 row: 2047 alone, search shape.
  const s = without(inSearch(GREEK, 2259794), 2048);
  const d = E.download_2257044;
  for (const item of [s, d]) {
    const e = energyOf(item);
    assert.deepEqual(Object.keys(e).map(Number), [2047], 'only Atwater General Factors');
    const m = mapUsdaFood(item);
    assert.equal(m.nutrition.calories, r4(e[2047]));
    assert.ok(m.nutrition.calories > 0);
    assert.ok(m._offPresent.includes('calories'));
  }
});

test('2048 alone is read too', () => {
  const item = without(E.food_2259794, 2047);
  assert.equal(mapUsdaFood(item).nutrition.calories, r4(energyOf(E.food_2259794)[2048]));
});

test('foods with 1008 keep it, whatever else they have', () => {
  // SR Legacy in the search reply: 1008 and 1062.
  const sr = inSearch(GREEK, 171304);
  assert.equal(sr.dataType, 'SR Legacy');
  const se = energyOf(sr);
  const m = mapUsdaFood(sr);
  assert.equal(m.nutrition.calories, se[1008]);
  assert.equal(m.nutrition.kilojoules, se[1062], 'USDA\'s own kJ, not one worked out');
  // Survey (FNDDS) and Branded in the same reply: 1008 only.
  for (const id of [2705422, 2067508]) {
    const f = inSearch(GREEK, id);
    assert.equal(mapUsdaFood(f).nutrition.calories, energyOf(f)[1008]);
  }
  // #290's recorded detail replies are unchanged: Branded and SR Legacy.
  assert.equal(mapUsdaFood(R290.food_2607245).nutrition.calories, 385);
  assert.equal(mapUsdaFood(R290.food_171688).nutrition.calories, 52);
  assert.equal(mapUsdaFood(R290.food_171688).nutrition.kilojoules, 218);
  // A food with every id takes 1008.
  const both = { ...sr, foodNutrients: [...E.food_2259794.foodNutrients.filter(fn => [2047, 2048].includes(fn.nutrient.id)), ...sr.foodNutrients] };
  assert.equal(mapUsdaFood(both).nutrition.calories, se[1008]);
});

test('kJ only: calories are kJ / 4.184, as for Open Food Facts', () => {
  for (const item of [inSearch(GREEK, 171304), R290.food_171688]) {
    const kj = energyOf(item)[1062];
    const m = mapUsdaFood(without(item, 1008));
    assert.equal(m.nutrition.calories, Math.round(kj / 4.184 * 10) / 10);
    assert.equal(m.nutrition.kilojoules, kj);
    assert.ok(m._offPresent.includes('calories'));
  }
});

test('no energy at all stays unreported, not 0 reported', () => {
  const m = mapUsdaFood(without(E.food_2259794, 1008, 1062, 2047, 2048));
  assert.equal(m.nutrition.calories, undefined);
  assert.ok(!m._offPresent.includes('calories'));
});

test('Refresh from USDA brings a food saved at 0 kcal up to USDA\'s calories', () => {
  // As the old code saved it: no calories, everything else per 100 g.
  const fresh = mapUsdaFood(E.food_2259794);
  const saved = { name: fresh.name, barcode: 'fdcId_2259794', portion: 100, unit: 'g', calories: 0, proteins: fresh.nutrition.proteins };
  const { food, changed, reason } = applyOffRefresh(saved, fresh, IDS);
  assert.equal(reason, 'updated');
  assert.equal(food.calories, r4(energyOf(E.food_2259794)[2048]));
  assert.ok(changed >= 1);
  // Kept per 150 g, it scales like every other value.
  const big = applyOffRefresh({ ...saved, portion: 150 }, fresh, IDS).food;
  assert.equal(big.calories, Math.round(r4(energyOf(E.food_2259794)[2048]) * 1.5 * 100) / 100);
});
