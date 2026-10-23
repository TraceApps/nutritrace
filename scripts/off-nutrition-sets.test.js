/**
 * #241: "as sold" values from Open Food Facts' nutrition sets.
 *
 * OFF keeps each product's values as sets and builds one "aggregated set"
 * from them, preferring "as prepared" when a product has both. v3, the API
 * NutriTrace reads, is built from that set only, so a can of beans with both
 * came back "as prepared" only (101 kcal, not the 64 on the label), and so did
 * Nesquik, two baby formulas and Benco. v3.5 serves the sets, and
 * off-nutrition-sets.js builds the "as sold" values from them with OFF's own
 * rules. The fixtures are real OFF products, as v3 and v3.5 return them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asSoldNutriments } from '../src/lib/off-nutrition-sets.js';
import { offNutritionStatus } from '../src/lib/off-nutrition.js';
import { Nutrition } from '../src/lib/nutrition.js';
import { offProductName } from '../src/lib/off-name.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const { products: P } = JSON.parse(read('./fixtures/off-nutrition-sets.json'));

// The real mapper, registry and full lookup, lifted out of api.js (which
// needs Vite to load), with the network stubbed.
function realApi({ perServing = false, fetchSets = async () => ({ ok: false }) } = {}) {
  const src = read('../src/lib/api.js');
  const body = (sig, end) => {
    const a = src.indexOf(sig), b = src.indexOf(end, a);
    assert.ok(a > 0 && b > a, `api.js still has ${sig.trim()}`);
    return src.slice(a + sig.length, b);
  };
  const table = src.slice(src.indexOf('const _OFF_NUTRIENTS = ['), src.indexOf('];', src.indexOf('const _OFF_NUTRIENTS = [')) + 2);
  const registry = src.slice(src.indexOf('const _OFF_INFO_MAX'), src.indexOf('const API = {'));
  const success = src.slice(src.indexOf('function _isOffSuccess'), src.indexOf('\n}\n', src.indexOf('function _isOffSuccess')) + 3);
  const calls = [];
  const localStorage = { getItem: (k) => (perServing && /offImportPortion/.test(k) ? '"perServing"' : null) };
  const make = new Function('offProductName', '_getOffSearchLanguage', 'localStorage', 'Nutrition', 'asSoldNutriments', '_extFetch', 'settingPrefix',
    `${table}\n${registry}\n${success}\nreturn {
      OFF_BASE: 'https://world.openfoodfacts.org',
      _mapOFFProduct(p, { full = false } = {}) { ${body('  _mapOFFProduct(p, { full = false } = {}) {', '\n  }\n')} },
      async _mapFullOFFProduct(product, code, { live = false } = {}) { ${body('  async _mapFullOFFProduct(product, code, { live = false } = {}) {', '\n  },\n')} },
      info: (code) => _offInfo.get(String(code)) || null,
    };`);
  const api = make(offProductName, () => 'en', localStorage, Nutrition, asSoldNutriments,
    async (url, opts) => { calls.push({ url, live: !!opts?.live }); return fetchSets(url); }, () => 'wl_');
  return { api, calls };
}
const reply = (body) => async () => ({ ok: true, json: async () => body });
const setsOf = (name) => reply({ status: 'success', product: P[name].v3_5 });

// Keys the mapper reads, for the product "as sold".
const asSoldKeys = (n) => Object.keys(n).filter(k => /^[a-z0-9-]+_(100g|serving|modifier)$/.test(k)
  && !k.includes('_prepared') && !k.includes('-estimate-from-ingredients'));

test('the port gives the values OFF gives, for products whose own answer is "as sold"', () => {
  for (const name of ['as_sold_only_15_digits', 'as_sold_only_serving_tie', 'as_sold_only_per_serving_set',
    'as_sold_only_salt_per_serving', 'as_sold_only_salt_per_serving_2', 'as_sold_only_per_unitless_quantity']) {
    const { v3, v3_5 } = P[name];
    assert.equal(v3_5.nutrition.aggregated_set.preparation, 'as_sold', `${name} is one OFF answers "as sold"`);
    const ours = asSoldNutriments(v3_5.nutrition, v3.serving_quantity);
    const keys = new Set([...asSoldKeys(v3.nutriments), ...asSoldKeys(ours.nutriments)]);
    assert.ok(keys.size > 10, name);
    for (const k of keys) assert.equal(ours.nutriments[k], v3.nutriments[k], `${name}: ${k}`);
    assert.equal(ours.per, v3.nutrition_data_per, `${name}: per`);
    // And through NutriTrace's mapper, in both import modes.
    for (const perServing of [false, true]) {
      const { api } = realApi({ perServing });
      const merged = api._mapOFFProduct({ ...v3, nutriments: ours.nutriments, nutrition_data_per: ours.per }, { full: true });
      const plain = api._mapOFFProduct(v3, { full: true });
      assert.deepEqual(merged.nutrition, plain.nutrition, `${name}, ${perServing ? 'per serving' : 'per 100'}`);
      assert.deepEqual(merged._offPresent, plain._offPresent);
      assert.equal(merged.portion, plain.portion);
    }
  }
});

test('products with both: the "as sold" values come through', async () => {
  const cases = [
    ['beans', 64, 'g', { proteins: 5.166, fat: 0.4, carbohydrates: 7.56, fiber: 4.41 }],
    ['nesquik', 386, 'g', {}],
    ['benco', 377, 'g', {}],
    ['formula_bio', 495, 'g', {}], // the manufacturer's set comes first, as in OFF
    ['formula_optipro', 67, 'ml', {}],
    ['hot_chocolate_serving_only', 390, 'g', {}], // only per serving on the label
  ];
  for (const [name, kcal, basis, more] of cases) {
    const { v3 } = P[name];
    const { api, calls } = realApi({ fetchSets: setsOf(name) });
    const before = api._mapOFFProduct(v3, { full: true });
    assert.equal(before._offPreparedOnly, true, `${name}: v3 alone shows it "as prepared" only`);
    const m = await api._mapFullOFFProduct(v3, v3.code);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].url, `https://world.openfoodfacts.org/api/v3.5/product/${v3.code}?fields=nutrition`);
    assert.equal(Math.round(m.nutrition.calories), kcal, `${name}: kcal`);
    assert.equal(m.nutrition_basis, basis, `${name}: per 100 ${basis}`);
    for (const [id, v] of Object.entries(more)) assert.equal(m.nutrition[id], v, `${name}: ${id}`);
    assert.ok(m._offPresent.includes('calories'));
    assert.equal(m._offPreparedOnly, false);
    assert.equal(offNutritionStatus(m, api.info(m.barcode)), 'ok', `${name}: nothing to warn about`);
    assert.ok(!Object.keys(m).some(k => k.startsWith('_off')), `${name}: nothing extra is saved with a food`);
  }
});

test('"as sold" values without calories keep the "as prepared" offer', async () => {
  // A real formula: its "as sold" column holds only "sugars 0".
  const { v3 } = P.formula_sugars_only_as_sold;
  const { api, calls } = realApi({ fetchSets: setsOf('formula_sugars_only_as_sold') });
  const m = await api._mapFullOFFProduct(v3, v3.code);
  assert.equal(calls.length, 1);
  assert.equal(m._offPreparedOnly, true);
  assert.deepEqual(m._offPresent, []);
  assert.equal(offNutritionStatus(m, api.info(m.barcode)), 'prepared', 'offered its "as prepared" values, not shown as 0 kcal');
  assert.equal(api.info(m.barcode).prepared.nutrition.calories, 66);
});

test('a product with values "as sold" is never asked about again', async () => {
  const { v3 } = P.as_sold_only_15_digits;
  const { api, calls } = realApi({ fetchSets: async () => { throw new Error('must not be called'); } });
  const m = await api._mapFullOFFProduct(v3, v3.code);
  assert.equal(calls.length, 0);
  assert.deepEqual(m.nutrition, api._mapOFFProduct(v3, { full: true }).nutrition);
});

test('anything unexpected keeps the v3 answer', async () => {
  const { v3 } = P.beans;
  const mirror = { status: 1, product: { code: v3.code, nutriments: v3.nutriments } }; // the local mirror's shape
  const withoutAsSold = { status: 'success', product: { nutrition: { input_sets: P.beans.v3_5.nutrition.input_sets.filter(s => s.preparation !== 'as_sold') } } };
  for (const [what, fetchSets] of [
    ['a failed request', async () => ({ ok: false, status: 503 })],
    ['a network error', async () => { throw new Error('offline'); }],
    ['bad JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } })],
    ['product not found', reply({ status: 'failure', product: null })],
    ['the local mirror answering', reply(mirror)],
    ['no "as sold" set', reply(withoutAsSold)],
    ['sets in another shape', reply({ status: 'success', product: { nutrition: { input_sets: 'x' } } })],
  ]) {
    const { api, calls } = realApi({ fetchSets });
    const m = await api._mapFullOFFProduct(v3, v3.code, { live: true });
    assert.equal(calls.length, 1, what);
    assert.equal(calls[0].live, true, `${what}: Refresh from OFF asks OFF itself for the sets too`);
    assert.equal(m._offPreparedOnly, true, `${what}: still "as prepared" only`);
    assert.equal(m.nutrition.calories, 0, what);
    assert.equal(offNutritionStatus(m, api.info(m.barcode)), 'prepared', what);
  }
});

test('bad input never throws and never invents a value', () => {
  for (const bad of [undefined, null, {}, { input_sets: null }, { input_sets: 'x' }, { input_sets: [null, 1, 'x'] },
    { input_sets: [{ preparation: 'as_sold' }] },
    { input_sets: [{ preparation: 'as_sold', per: '100g', per_quantity: 100, per_unit: 'g', nutrients: 'x' }] },
    { input_sets: [{ preparation: 'as_sold', source: 'estimate', per: '100g', per_quantity: 100, per_unit: 'g', nutrients: { fat: { value: 1, unit: 'g' } } }] },
  ]) assert.equal(asSoldNutriments(bad, 30), null, JSON.stringify(bad));
  const set = (nutrients, extra = {}) => ({ input_sets: [{ preparation: 'as_sold', source: 'packaging', per: '100g', per_quantity: 100, per_unit: 'g', nutrients, ...extra }] });
  // A unit it doesn't know is left out, not read as grams.
  const odd = asSoldNutriments(set({ fat: { value: 5, unit: 'blorps' }, proteins: { value: 3, unit: 'g' } }));
  assert.equal(odd.nutriments.fat_100g, undefined);
  assert.equal(odd.nutriments.proteins_100g, 3);
  // Units convert as OFF converts them.
  const units = asSoldNutriments(set({ sodium: { value: 400, unit: 'mg' }, 'vitamin-d': { value: 400, unit: 'IU' }, 'energy-kj': { value: 1000, unit: 'kJ' } }));
  assert.equal(units.nutriments.sodium_100g, 0.4);
  assert.equal(units.nutriments['vitamin-d_100g'], 0.00001, '400 IU of vitamin D is 10 µg');
  assert.equal(units.nutriments.energy_100g, 1000);
  // A set under 5 g is not scaled up to 100 g, as in OFF.
  assert.equal(asSoldNutriments(set({ fat: { value: 1, unit: 'g' } }, { per: 'serving', per_quantity: 2 })), null);
  // Each nutrient comes from the first set that lists it, even without a
  // value (OFF then reads it as 0): a lower set never fills it in.
  const two = asSoldNutriments({ input_sets: [
    { preparation: 'as_sold', source: 'packaging', per: '100g', per_quantity: 100, per_unit: 'g', nutrients: { fat: { unit: 'g' }, proteins: { value: 2, unit: 'g' } } },
    { preparation: 'as_sold', source: 'manufacturer', per: '100g', per_quantity: 100, per_unit: 'g', nutrients: { proteins: { value: 3, unit: 'g' } } },
    { preparation: 'as_sold', source: 'usda', per: '100g', per_quantity: 100, per_unit: 'g', nutrients: { fat: { value: 9, unit: 'g' } } },
  ] });
  assert.equal(two.nutriments.proteins_100g, 3, 'the manufacturer\'s set comes first');
  assert.equal(two.nutriments.fat_100g, 0);
  // A computed value is marked approximate, so the mapper leaves it out.
  assert.equal(asSoldNutriments(set({ sodium: { value_computed: 0.2, unit: 'g' } })).nutriments.sodium_modifier, '~');
});

test('per-serving values round as OFF rounds them', () => {
  const kj = (value, serving) => asSoldNutriments({ input_sets: [{ preparation: 'as_sold', source: 'packaging', per: '100g', per_quantity: 100, per_unit: 'g',
    nutrients: { 'energy-kj': { value, unit: 'kJ' } } }] }, serving).nutriments['energy-kj_serving'];
  assert.equal(kj(1225, 100), 1220, 'an exact tie goes to the even digit, as C printf does');
  assert.equal(kj(1235, 100), 1240);
  assert.equal(kj(1592.857142857143, 7), 111, 'worked out from the 15-digit value OFF stores');
});

test('a set per a quantity with no unit is read as grams, as in OFF', () => {
  // Real: pancake mix 0041190074594, per 67 with no unit.
  const r = asSoldNutriments({ input_sets: [{ preparation: 'as_sold', source: 'packaging', per: 'serving', per_quantity: 67, per_unit: null,
    nutrients: { calcium: { value: 0.26, unit: 'g' }, 'added-sugars': { value: 9, unit: 'g' } } }] }, 67);
  assert.equal(r.nutriments.calcium_100g, 0.388059701492537);
  assert.equal(r.nutriments['added-sugars_100g'], 13.4328358208955);
  assert.equal(r.per, '100g');
});

test('the local mirror answers v3.5 lookups like any other version', () => {
  const proxy = read('../server/routes/proxy.js');
  const re = new RegExp(proxy.match(/if \(host === 'world\.openfoodfacts\.org' && \/(.+?)\/\.test\(path\)\)/)[1]);
  for (const p of ['/api/v3/product/123', '/api/v3.5/product/123', '/api/v2/product/123.json', '/api/v0/product/1.json']) assert.ok(re.test(p), p);
  assert.ok(!re.test('/api/v3.x/product/1'));
});
