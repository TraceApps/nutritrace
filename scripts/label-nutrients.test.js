/**
 * #281: the built-in nutrients are the ones on a Nutrition Facts label, in
 * box order (US label first, EU label for what the US one lacks), and Open
 * Food Facts, USDA and the Cronometer import all fill the ones they carry.
 *
 * The USDA ids were checked against the live FoodData Central API
 * (2026-10-23); the OFF keys against real product records in
 * fixtures/off-nutrition-sets.json and the OFF nutrients taxonomy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NUTRIMENTS, Nutrition } from '../src/lib/nutrition.js';
import { offProductName } from '../src/lib/off-name.js';
import { USDA_NUTRIENT_MAP } from '../src/lib/usda-map.js';
import { parseCronometer } from '../server/lib/nutrition-import/cronometer.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ids = NUTRIMENTS.map(n => n.id);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('vitamins and minerals follow the order of 21 CFR 101.9', () => {
  const from = ids.indexOf('vitamin-d');
  const to = ids.indexOf('choline');
  assert.deepEqual(ids.slice(from, to + 1), [
    'vitamin-d', 'calcium', 'iron', 'potassium',
    'vitamin-a', 'vitamin-c', 'vitamin-e', 'vitamin-k',
    'b1', 'b2', 'b3', 'b6', 'b9', 'b12', 'b5',
    'phosphorus', 'iodine', 'magnesium', 'zinc', 'selenium', 'copper', 'manganese',
    'choline',
  ]);
});

test('starch is a Carbs sub-row right after the sugars', () => {
  assert.equal(ids.indexOf('starch'), ids.indexOf('added-sugars') + 1);
  assert.equal(NUTRIMENTS.find(n => n.id === 'starch').subOf, 'carbohydrates');
});

test('the new nutrients carry the label unit and the FDA Daily Value', () => {
  const want = {
    starch: ['g', null], b5: ['mg', 5], iodine: ['mcg', 150], selenium: ['mcg', 55],
    copper: ['mg', 0.9], manganese: ['mg', 2.3], choline: ['mg', 550],
  };
  for (const [id, [unit, dv]] of Object.entries(want)) {
    const n = NUTRIMENTS.find(x => x.id === id);
    assert.ok(n, id);
    assert.equal(n.unit, unit, id);
    assert.equal(n.dv, dv, id);
    assert.equal(n.default, false, `${id} stays hidden until the user turns it on`);
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

// api.js needs Vite to load, so lift the tables and the mapper out of it.
const api = read('../src/lib/api.js');
const table = (name) => {
  const a = api.indexOf(`const ${name} = `);
  assert.ok(a > 0, name);
  return api.slice(a, api.indexOf('\n};', a) + 3).replace(/^const \w+ = /, '').replace(/;$/, '');
};

test('USDA ids map to the new nutrients', () => {
  const map = USDA_NUTRIENT_MAP;
  assert.deepEqual(
    { 1009: map[1009], 1170: map[1170], 1100: map[1100], 1103: map[1103], 1098: map[1098], 1101: map[1101], 1180: map[1180] },
    { 1009: 'starch', 1170: 'b5', 1100: 'iodine', 1103: 'selenium', 1098: 'copper', 1101: 'manganese', 1180: 'choline' },
  );
  for (const key of Object.values(map)) {
    assert.ok(ids.includes(key), `${key} is a built-in nutrient`);
  }
});

function mapOff(nutriments) {
  const a = api.indexOf('const _OFF_NUTRIENTS = [');
  const tbl = api.slice(a, api.indexOf('];', a) + 2);
  const sig = '  _mapOFFProduct(p, { full = false } = {}) {';
  const s = api.indexOf(sig), e = api.indexOf('\n  }\n', s);
  const r = api.indexOf('const _OFF_INFO_MAX');
  const registry = api.slice(r, api.indexOf('const API = {', r));
  const make = new Function('offProductName', '_getOffSearchLanguage', 'localStorage', 'Nutrition', 'settingPrefix',
    `${tbl}\n${registry}\nreturn { map(p, full) { ${api.slice(s + sig.length, e)} } };`);
  const m = make(offProductName, () => 'en', { getItem: () => null }, Nutrition, () => 'wl_');
  return m.map({ code: '1', product_name: 'Test', nutrition_data_per: '100g', nutriments }, true);
}

test('Open Food Facts values arrive in our units', () => {
  // OFF stores every amount in grams per 100 g.
  const out = mapOff({
    'energy-kcal_100g': 100,
    starch_100g: 12.5,
    'pantothenic-acid_100g': 0.005,
    iodine_100g: 0.00015,
    selenium_100g: 0.000055,
    copper_100g: 0.0009,
    manganese_100g: 0.0023,
    choline_100g: 0.55,
  });
  const n = out.nutrition;
  near(n.starch, 12.5);
  near(n.b5, 5);
  near(n.iodine, 150);
  near(n.selenium, 55);
  near(n.copper, 0.9);
  near(n.manganese, 2.3);
  near(n.choline, 550);
  for (const id of ['starch', 'b5', 'iodine', 'selenium', 'copper', 'manganese', 'choline']) {
    assert.ok(out._offPresent.includes(id), `${id} counts as present, so a refresh may write it`);
  }
});

test('an OFF product without them leaves them absent, not a real 0', () => {
  const out = mapOff({ 'energy-kcal_100g': 100 });
  for (const id of ['starch', 'b5', 'iodine', 'selenium', 'copper', 'manganese', 'choline']) {
    assert.ok(!out._offPresent.includes(id), id);
  }
});

test('Cronometer columns land on the new nutrients', () => {
  const header = ['Day', 'Time', 'Group', 'Food Name', 'Amount', 'Energy (kcal)', 'Starch (g)',
    'Selenium (µg)', 'Copper (mg)', 'Manganese (mg)', 'Choline (mg)', 'B5 (Pantothenic Acid) (mg)'];
  const row = ['2026-09-08', '8:33 AM', 'Breakfast', 'Brazil Nuts', '28.00 g', '186', '0.4', '544', '0.5', '0.3', '10', '0.1'];
  const [out] = parseCronometer([header, row].map(r => r.join(',')).join('\n') + '\n');
  assert.equal(out.nutrition.starch, 0.4);
  assert.equal(out.nutrition.selenium, 544);
  assert.equal(out.nutrition.copper, 0.5);
  assert.equal(out.nutrition.manganese, 0.3);
  assert.equal(out.nutrition.choline, 10);
  assert.equal(out.nutrition.b5, 0.1);
});

test('MCP create_food accepts the new ids and the pantothenic alias', () => {
  const src = read('../server/lib/mcp/tools/create-food.js');
  assert.match(src, /'pantothenic-acid': 'b5'/);
  assert.match(src, /new Set\(NUTRIMENTS\.map\(n => n\.id\)\)/, 'the key list comes from the registry');
});
