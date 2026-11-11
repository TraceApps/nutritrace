/**
 * #289: USDA generic foods (SR Legacy, Foundation, Survey) came in per 100 g
 * only, so there was no "1 large" to pick for a fried egg. SR Legacy and
 * Foundation search hits have no portions (the /food/{fdcId} detail has
 * them as foodPortions); Survey hits carry them as foodMeasures.
 * usdaPortionsToAltUnits maps either shape to alt_units rows, mapUsdaFood
 * puts them on the food, and Refresh from USDA adds the ones a saved food
 * doesn't have (mergeUsdaAltUnits). Fixtures are real rows from FoodData
 * Central; usda-290-responses.json is the #290 recording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usdaPortionsToAltUnits, mergeUsdaAltUnits, mapUsdaFood } from '../src/lib/usda-map.js';
import { scaleFactor } from '../src/lib/units.js';
import { applyOffRefresh } from '../src/lib/off-refresh.js';
import { NUTRIMENTS } from '../src/lib/nutrition.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const R = JSON.parse(read('./fixtures/usda-290-responses.json'));
const IDS = NUTRIMENTS.map(n => n.id);

// SR Legacy 173423 "Egg, whole, cooked, fried"
const SR_EGG = [
  { amount: 1.0, modifier: 'large', portionDescription: null, gramWeight: 46.0, measureUnit: { name: 'undetermined' } },
];
// Foundation 790577 "Onions, red, raw"
const FOUNDATION_ONION = [
  { amount: 1.0, modifier: 'Edible', portionDescription: null, gramWeight: 197.0, measureUnit: { name: 'Onion' } },
  { amount: 1.0, modifier: null, portionDescription: null, gramWeight: 85.0, measureUnit: { name: 'RACC' } },
];
// Survey (FNDDS) 2707159 "Egg, whole, fried with butter": modifier is a code
const FNDDS_EGG = [
  { amount: null, modifier: '60710', portionDescription: '1 egg', gramWeight: 55, measureUnit: { name: 'undetermined' } },
  { amount: null, modifier: '10205', portionDescription: '1 cup', gramWeight: 135, measureUnit: { name: 'undetermined' } },
  { amount: null, modifier: '90000', portionDescription: 'Quantity not specified', gramWeight: 55, measureUnit: { name: 'undetermined' } },
];

// The same Survey food as a foods/search hit: foodMeasures, not foodPortions
const FNDDS_EGG_SEARCH_HIT = [
  { disseminationText: '1 egg', gramWeight: 55, id: 297285, modifier: '60710', rank: 1, measureUnitAbbreviation: 'undetermined', measureUnitName: 'undetermined', measureUnitId: 9999 },
  { disseminationText: '1 cup', gramWeight: 135, id: 297286, modifier: '10205', rank: 2, measureUnitAbbreviation: 'undetermined', measureUnitName: 'undetermined', measureUnitId: 9999 },
  { disseminationText: 'Quantity not specified', gramWeight: 55, id: 297287, modifier: '90000', rank: 3, measureUnitAbbreviation: 'undetermined', measureUnitName: 'undetermined', measureUnitId: 9999 },
];

// SR Legacy 171688 "Apples, raw, with skin", as its detail maps
const APPLE_UNITS = [
  { abbr: 'cup slices', grams: 109 },
  { abbr: 'medium (3" dia)', grams: 182 },
  { abbr: 'small (2-3/4" dia)', grams: 149 },
  { abbr: 'nlea serving', grams: 242 },
  { abbr: 'cup, quartered or chopped', grams: 125 },
  { abbr: 'extra small (2-1/2" dia)', grams: 101 },
  { abbr: 'large (3-1/4" dia)', grams: 223 },
];

test('SR Legacy: the modifier is the unit ("1 large" fried egg = 46 g)', () => {
  assert.deepEqual(usdaPortionsToAltUnits(SR_EGG), [{ abbr: 'large', grams: 46 }]);
});

test('Foundation: measureUnit names the unit; the RACC row is dropped', () => {
  assert.deepEqual(usdaPortionsToAltUnits(FOUNDATION_ONION), [{ abbr: 'onion, edible', grams: 197 }]);
});

test('Survey (FNDDS): label from portionDescription, numeric modifier ignored, "serving" dropped when it weighs the same as "egg"', () => {
  assert.deepEqual(usdaPortionsToAltUnits(FNDDS_EGG), [
    { abbr: 'egg', grams: 55 },
    { abbr: 'cup', grams: 135 },
  ]);
});

test('"Quantity not specified" becomes "serving" when its weight is its own', () => {
  // Survey 2708961 'Sushi roll, California' (search hit): serving = 6 pieces
  const sushi = [
    { disseminationText: '1 cup', gramWeight: 150, modifier: '10205', measureUnitName: 'undetermined' },
    { disseminationText: 'Quantity not specified', gramWeight: 180, modifier: '90000', measureUnitName: 'undetermined' },
    { disseminationText: '1 piece', gramWeight: 30, modifier: '61667', measureUnitName: 'undetermined' },
  ];
  assert.deepEqual(usdaPortionsToAltUnits(sushi), [
    { abbr: 'cup', grams: 150 },
    { abbr: 'serving', grams: 180 },
    { abbr: 'piece', grams: 30 },
  ]);
});

test('Survey search hits (foodMeasures) map the same as the detail (foodPortions)', () => {
  assert.deepEqual(usdaPortionsToAltUnits(FNDDS_EGG_SEARCH_HIT), usdaPortionsToAltUnits(FNDDS_EGG));
});

test('a Survey row whose text starts with a fraction gives grams per one unit', () => {
  const rows = [
    { portionDescription: '1/2 cup', gramWeight: 120, modifier: '10201', measureUnit: { name: 'undetermined' } },
    { disseminationText: '2 slices', gramWeight: 56, modifier: '50120', measureUnitName: 'undetermined' },
  ];
  assert.deepEqual(usdaPortionsToAltUnits(rows), [{ abbr: 'cup', grams: 240 }, { abbr: 'slices', grams: 28 }]);
});

test('grams are per one unit when amount is not 1', () => {
  const rows = [{ amount: 0.5, modifier: 'cup, chopped', gramWeight: 80, measureUnit: { name: 'undetermined' } }];
  assert.deepEqual(usdaPortionsToAltUnits(rows), [{ abbr: 'cup, chopped', grams: 160 }]);
});

test('duplicate labels keep the first row; bad rows are skipped', () => {
  const rows = [
    { amount: 1, modifier: 'large', gramWeight: 50, measureUnit: { name: 'undetermined' } },
    { amount: 1, modifier: 'Large', gramWeight: 46, measureUnit: { name: 'undetermined' } },
    { amount: 1, modifier: 'medium', gramWeight: 0 },
    null,
  ];
  assert.deepEqual(usdaPortionsToAltUnits(rows), [{ abbr: 'large', grams: 50 }]);
});

test("reference amounts and bare mass units are dropped; food-specific cups stay", () => {
  // Real rows: Survey 'Peanut butter' (search hit) and SR Legacy 'Crackers, milk'.
  const pb = [
    { disseminationText: 'Guideline amount per sandwich', gramWeight: 32, modifier: '90001', measureUnitName: 'undetermined' },
    { disseminationText: '1 tablespoon', gramWeight: 16, modifier: '10001', measureUnitName: 'undetermined' },
  ];
  const crackers = [
    { amount: 1, modifier: 'cracker', gramWeight: 11, measureUnit: { name: 'undetermined' } },
    { amount: 1, modifier: 'oz', gramWeight: 28.35, measureUnit: { name: 'undetermined' } },
  ];
  assert.deepEqual(usdaPortionsToAltUnits(pb), [{ abbr: 'tablespoon', grams: 16 }]);
  assert.deepEqual(usdaPortionsToAltUnits(crackers), [{ abbr: 'cracker', grams: 11 }]);
});

test('nothing usable gives null, like OFF altUnits', () => {
  assert.equal(usdaPortionsToAltUnits(undefined), null);
  assert.equal(usdaPortionsToAltUnits([]), null);
  assert.equal(usdaPortionsToAltUnits([FOUNDATION_ONION[1]]), null);
});

test('2 large fried eggs scale to 92 g of the per-100g food', () => {
  const egg = { nutrition_basis: 'g', alt_units: usdaPortionsToAltUnits(SR_EGG) };
  assert.ok(Math.abs(scaleFactor(100, 'g', 2, 'large', egg) - 0.92) < 1e-9);
});

test('mapUsdaFood puts the detail\'s portions on the food (SR Legacy apple)', () => {
  const apple = mapUsdaFood(R.food_171688);
  assert.deepEqual(apple.alt_units, APPLE_UNITS);
  // Still per 100 g (#290): the units only say how much one of each weighs.
  assert.equal(apple.portion, 100);
  assert.equal(apple.unit, 'g');
  assert.ok(Math.abs(scaleFactor(100, 'g', 1, 'medium (3" dia)', apple) - 1.82) < 1e-9);
});

test('mapUsdaFood maps a Survey search hit\'s foodMeasures; Branded foods get no units', () => {
  const hit = { fdcId: 2707159, description: 'Egg, whole, fried with butter', dataType: 'Survey (FNDDS)', foodNutrients: [], foodMeasures: FNDDS_EGG_SEARCH_HIT };
  assert.deepEqual(mapUsdaFood(hit).alt_units, [{ abbr: 'egg', grams: 55 }, { abbr: 'cup', grams: 135 }]);
  // The popcorn's detail has foodPortions: [], its search hit foodMeasures: [].
  assert.equal(mapUsdaFood(R.food_2607245).alt_units, null);
  assert.equal(mapUsdaFood(R.search_popcorn.foods.find(f => f.fdcId === 2607245)).alt_units, null);
});

test('Refresh adds USDA units to a food that has none', () => {
  const r = mergeUsdaAltUnits(null, APPLE_UNITS);
  assert.equal(r.added, 7);
  assert.deepEqual(r.alt_units, APPLE_UNITS);
  assert.equal(mergeUsdaAltUnits([], APPLE_UNITS).added, 7);
});

test('Refresh keeps the units the user added, and their grams, adding only the missing ones', () => {
  const own = [
    { abbr: 'my bowl', grams: 300 },
    { abbr: 'Medium (3" dia)', grams: '180' },  // corrected by hand, typed in another case
    { abbr: '', grams: '' },                    // a row added and not filled in yet
  ];
  const r = mergeUsdaAltUnits(own, APPLE_UNITS);
  assert.equal(r.added, 6);
  assert.deepEqual(r.alt_units.slice(0, 3), own);
  assert.deepEqual(r.alt_units.slice(3).map(u => u.abbr), APPLE_UNITS.map(u => u.abbr).filter(a => a !== 'medium (3" dia)'));
  // A second refresh has nothing to add and hands back the same list.
  const again = mergeUsdaAltUnits(r.alt_units, APPLE_UNITS);
  assert.equal(again.added, 0);
  assert.equal(again.alt_units, r.alt_units);
});

test('Refresh reads alt_units kept as the foods column\'s JSON string', () => {
  const r = mergeUsdaAltUnits(JSON.stringify([{ abbr: 'large (3-1/4" dia)', grams: 223 }]), APPLE_UNITS);
  assert.equal(r.added, 6);
  assert.equal(r.alt_units[0].abbr, 'large (3-1/4" dia)');
});

test('USDA with no units leaves the food\'s own as they were', () => {
  const own = [{ abbr: 'bag', grams: 13 }];
  assert.deepEqual(mergeUsdaAltUnits(own, null), { alt_units: own, added: 0 });
  assert.deepEqual(mergeUsdaAltUnits(null, null), { alt_units: null, added: 0 });
});

test('a food saved before #289 gets its units on refresh, its nutrients up to date', () => {
  const usda = mapUsdaFood(R.food_171688);
  const saved = { name: 'Apple', portion: 100, unit: 'g', barcode: 'fdcId_171688', alt_units: [{ abbr: 'slice', grams: 20 }] };
  for (const id of usda._offPresent) saved[id] = usda.nutrition[id];
  const { food: next, reason } = applyOffRefresh(saved, usda, IDS);
  assert.equal(reason, 'up_to_date');
  const { alt_units, added } = mergeUsdaAltUnits(next.alt_units, usda.alt_units);
  assert.equal(added, 7);
  assert.deepEqual(alt_units, [{ abbr: 'slice', grams: 20 }, ...APPLE_UNITS]);
});

test('picking an SR Legacy or Foundation hit fetches its units through lookupFdcId', () => {
  const api = read('../src/lib/api.js');
  const fn = api.slice(api.indexOf('async fetchAltUnits'), api.indexOf('// ── NutriTrace Server API'));
  assert.match(fn, /this\.lookupFdcId\(fdcId, apiKey\)/);
  assert.doesNotMatch(fn, /_USDA_BASE/, 'one request path for a food\'s detail');
  const foods = read('../src/routes/Foods.svelte');
  const pick = foods.slice(foods.indexOf('async function pickFood'), foods.indexOf('// #241: in pick mode'));
  assert.match(pick, /food\.dataType === 'SR Legacy' \|\| food\.dataType === 'Foundation'/);
  assert.match(pick, /USDA\.fetchAltUnits\(usdaFdcId\(food\.barcode\), usdaApiKey\.get\(\)\)/);
});

test('Refresh from USDA merges the units and says how many it added', () => {
  const ed = read('../src/routes/FoodEditor.svelte');
  const fn = ed.slice(ed.indexOf('async function downloadFromUSDA'), ed.indexOf('// ── Scan Label'));
  assert.match(fn, /mergeUsdaAltUnits\(next\.alt_units, result\.alt_units\)/);
  assert.match(fn, /usda_updated_units/);
  assert.match(fn, /usda_units_added/);
  const en = JSON.parse(read('../src/i18n/en.json')).food_editor.toast;
  assert.match(en.usda_updated_units, /\{units, plural,/);
  assert.match(en.usda_units_added, /\{units, plural,/);
});
