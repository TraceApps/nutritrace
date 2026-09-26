/**
 * #241 follow-up: Open Food Facts products with no "as sold" values.
 *
 * They used to arrive as 0 kcal foods everywhere: shown as 0 kcal, saved as
 * 0 kcal, and logged by Trace as 0 kcal with a success message. Their "as
 * prepared" values are never used unasked, because what they are varies by
 * product (the fixtures are real OFF products): Nesquik's are the drink made
 * with milk, one formula's are the made-up milk, another's are the powder
 * typed into the wrong column, and one powder claims 1,127 kcal per 100 g.
 * The user chooses, seeing the number first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { offNutritionStatus, needsFullLookup, applyOffPrepared, MAX_KCAL_PER_100 } from '../src/lib/off-nutrition.js';
import { NUTRIMENTS, Nutrition } from '../src/lib/nutrition.js';
import { offProductName } from '../src/lib/off-name.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const IDS = NUTRIMENTS.map(n => n.id);
const { products: REAL } = JSON.parse(read('./fixtures/off-prepared-samples.json'));
const { product: BEANS } = JSON.parse(read('./fixtures/off-241-prepared-only.json'));

// The real mapper and registry, lifted out of api.js (which needs Vite to load).
function realApi() {
  const src = read('../src/lib/api.js');
  const sig = '  _mapOFFProduct(p, { full = false } = {}) {';
  const a = src.indexOf(sig), b = src.indexOf('\n  }\n', a);
  const t = src.indexOf('const _OFF_NUTRIENTS = [');
  const r = src.indexOf('const _OFF_INFO_MAX');
  assert.ok(a > 0 && t > 0 && r > 0, 'api.js still has the mapper, the table and the registry');
  const table = src.slice(t, src.indexOf('];', t) + 2);
  const registry = src.slice(r, src.indexOf('const API = {', r));
  const make = new Function('offProductName', '_getOffSearchLanguage', 'localStorage', 'Nutrition',
    `${table}\n${registry}\nreturn { map(p, full) { ${src.slice(a + sig.length, b)} }, info: (code) => _offInfo.get(String(code)) || null };`);
  return make(offProductName, () => 'en', { getItem: () => null }, Nutrition);
}

test('real products: each "as prepared" case is found and kept apart from the saved food', () => {
  const api = realApi();
  for (const [kind, p] of Object.entries(REAL)) {
    const m = api.map(p, true);
    assert.equal(m._offPreparedOnly, true, kind);
    assert.deepEqual(m._offPresent, [], `${kind}: no "as sold" values`);
    assert.equal(m.nutrition.calories, 0, `${kind}: the saved shape is unchanged, still 0 until the user chooses`);
    assert.ok(m._offPrepared && m._offPrepared.present.includes('calories'), `${kind}: its "as prepared" values are there to offer`);
    assert.ok(!Object.keys(m).some(k => k.startsWith('_off')), `${kind}: none of it is saved with a food`);
  }
  assert.equal(api.map(REAL.drink, true)._offPrepared.unit, 'ml', 'Nesquik is per 100 ml of drink');
  assert.equal(api.map(REAL.drink, true)._offPrepared.nutrition.calories, 72);
});

test('status: offered when plausible, refused when impossible, never for "as sold" products', () => {
  const api = realApi();
  const status = (p) => { const m = api.map(p, true); return offNutritionStatus(m, api.info(m.barcode)); };
  assert.equal(status(REAL.drink), 'prepared');
  assert.equal(status(REAL.formula_prepared), 'prepared');
  assert.equal(status(REAL.formula_powder_in_prepared), 'prepared', 'looks plausible, so it is offered with its number shown');
  assert.equal(status(REAL.impossible), 'implausible', `over ${MAX_KCAL_PER_100} kcal per 100 is never offered`);
  assert.equal(status(BEANS), 'prepared');
  const skyr = { code: '9100000007540', product_name: 'Skyr', nutriments: { 'energy-kcal_100g': 58, proteins_100g: 9.5 } };
  assert.equal(status(skyr), 'ok');
  assert.equal(status({ code: '1', product_name: 'Empty', nutriments: {} }), 'none');
});

test('a saved food, a food with no barcode, or an unknown product is never flagged', () => {
  const info = { present: [], preparedOnly: true, prepared: { present: ['calories'], nutrition: { calories: 72 } } };
  assert.equal(offNutritionStatus({ id: 7, barcode: '1' }, info), 'ok', 'the user\'s own food');
  assert.equal(offNutritionStatus({ barcode: '' }, info), 'ok');
  assert.equal(offNutritionStatus({ barcode: '1' }, null), 'ok', 'nothing known: nothing claimed');
  assert.equal(offNutritionStatus(null, info), 'ok');
});

test('a food with calories of its own is never flagged, whatever OFF says about that barcode', () => {
  // A USDA food can carry the same UPC as an OFF product with no values.
  const info = { present: [], preparedOnly: false, prepared: null };
  assert.equal(offNutritionStatus({ barcode: '1', nutrition: { calories: 120 } }, info), 'ok');
  assert.equal(offNutritionStatus({ barcode: '1', calories: 120 }, info), 'ok', 'the editor\'s flat shape too');
  assert.equal(offNutritionStatus({ barcode: '1', nutrition: { calories: 0 } }, info), 'none');
  assert.equal(offNutritionStatus({ barcode: '1' }, info), 'none', 'asked about the product alone, as Refresh does');
});

test('the registry: a full product lookup beats a search hit, never the other way round', () => {
  const api = realApi();
  const full = api.map(REAL.drink, true);
  assert.equal(api.info(full.barcode).full, true);
  // The same product as a search hit, which carries no "as prepared" values.
  api.map({ code: REAL.drink.code, product_name: 'Nesquik', nutriments: {} }, false);
  assert.equal(api.info(full.barcode).full, true, 'the thinner hit did not overwrite it');
  assert.ok(api.info(full.barcode).prepared, 'the "as prepared" values are still known');
  // A hit first, then the full product: the full one replaces it.
  const code = '4000000000001';
  api.map({ code, product_name: 'X', nutriments: {} }, false);
  assert.equal(needsFullLookup(api.info(code)), true, 'a hit with no values asks for the full product');
  api.map({ code, product_name: 'X', nutriments: { 'energy-kcal_100g': 50 } }, true);
  assert.equal(needsFullLookup(api.info(code)), false);
  assert.deepEqual(api.info(code).present, ['calories']);
});

test('using "as prepared" values: converted to the food, recorded in its notes, once', () => {
  const api = realApi();
  const m = api.map(BEANS, true);
  const info = api.info(m.barcode);
  const note = 'Nutrition values are "as prepared" (from Open Food Facts).';
  const food = { name: 'Kidney beans', barcode: m.barcode, portion: 252, unit: 'g', calories: 0, proteins: 0, notes: 'Organic' };
  const r = applyOffPrepared(food, info, IDS, note);
  assert.equal(r.reason, 'updated');
  assert.equal(r.food.calories, Math.round(101 * 2.52 * 100) / 100, 'per 100 g converted to the 252 g can');
  assert.equal(r.food.proteins, Math.round(8.2 * 2.52 * 100) / 100);
  assert.equal(r.food.notes, `Organic\n${note}`);
  assert.equal(applyOffPrepared(r.food, info, IDS, note).food.notes, `Organic\n${note}`, 'the note is not added twice');
  assert.equal(food.calories, 0, 'the food passed in is untouched');
});

test('every place an OFF product enters NutriTrace checks it', () => {
  const foods = read('../src/routes/Foods.svelte');
  assert.match(foods, /offStatus=\{_paneOffStatus\}/);
  assert.match(foods, /offStatus=\{_detailOffStatus\}/);
  assert.match(foods, /if \(pickMode && sourceHint === 'off' && activeTab === 0\s*&& offNutritionStatus\(food, API\.offNutritionInfo\(food\.barcode\)\) !== 'ok'\) \{\s*return openEditor\(food, 'foodList'\);/);

  const sheet = read('../src/components/ui/FoodDetailSheet.svelte');
  assert.equal((sheet.match(/disabled=\{offStatus !== 'ok'\}/g) || []).length, 2, 'both layouts disable Add to Diary');
  assert.match(sheet, /function onAddToDiaryTap\(\) \{\s*if \(offStatus !== 'ok'\) return;/);
  assert.match(sheet, /\$: energyChip = \(\(\) => \{\s*\/\/[^\n]*\n\s*if \(offStatus !== 'ok'\) return null;/, 'no "0 kcal" chip either');

  const editor = read('../src/routes/FoodEditor.svelte').replace(/\r/g, '');
  assert.match(editor, /_showOffNotice\(prefill\.barcode, info\);/, 'a new food from OFF says so on opening');
  assert.match(editor, /_showOffNotice\(food\.barcode, API\.offNutritionInfo\(food\.barcode\)\);/, 'and so does Refresh');
  assert.match(editor, /on:click=\{usePreparedValues\}/, 'the "as prepared" values need a tap');
  assert.match(editor, /if \(_offNotice\) \{\s*for \(const n of NUTRIMENTS\) if \(Number\(food\[n\.id\]\) === 0\) food\[n\.id\] = '';/, 'a new food with no values starts with empty fields, not zeros');
  assert.match(editor, /showSuccess\(changed\s*\? \$_\('food_editor\.toast\.off_prepared_used'[\s\S]*?: \$_\('food_editor\.toast\.off_up_to_date'\)\)/, 'using them again says it already matches');

  assert.match(foods, /\{#if source === 'off' && _offNoValues\(item\)\}\{\$_\('foods\.off_no_values_listed'\)\}/, 'All-mode results say "No values listed", not 0 kcal');
  assert.match(foods, /\{#if searchSource === 'off' && _offNoValues\(food\)\}\{\$_\('foods\.off_no_values_listed'\)\}/, 'and so do OFF results');
  const multi = foods.slice(foods.indexOf('async function confirmMultiAdd'));
  const gateAt = multi.indexOf('foods = await _resolveOffPicks(foods);');
  assert.ok(gateAt > 0 && gateAt < multi.indexOf('if ($diaryPromptQuantity)') && gateAt < multi.indexOf('_addFoodToDiaryNoNav'), 'ticked results are checked before either way of adding them');
  assert.match(sheet, /\$: energyChip = \(\(\) => \{[\s\S]{0,120}if \(offStatus !== 'ok'\) return null;/, 'no "0 kcal" chip on the sheet');
  const meal = read('../src/routes/MealEditor.svelte').replace(/\r/g, '');
  const persist = meal.slice(meal.indexOf('async function _maybePersistPickedFood'));
  const refuseAt = persist.indexOf("meal_editor.errors.off_no_values");
  assert.ok(refuseAt > 0, 'the meal editor refuses such an ingredient');
  assert.ok(refuseAt < persist.indexOf('NtApi.createFood'), 'before anything is saved');

  const trace = read('../src/components/ai/Trace.svelte');
  const off = trace.slice(trace.indexOf('if (pickedOff) {'));
  const stopAt = off.indexOf('no_nutrition: true');
  assert.ok(stopAt > 0, 'Trace stops for such a product');
  assert.ok(stopAt < off.indexOf('NtApi.createFood'), 'before it would have saved and logged it');

  const ql = read('../src/lib/quick-log.js');
  assert.match(ql, /let best = out\.candidates\.find\(usable\) \|\| offResults\[0\];/);
  assert.match(ql, /if \(m\.source === 'off' && !food\.id && offNutritionStatus\(food, API\.offNutritionInfo\(food\.barcode\)\) !== 'ok'\) continue;/);
  assert.match(read('../src/components/diary/SmartLogModal.svelte'), /smart_log\.off_no_values/);
  const modal = read('../src/components/diary/SmartLogModal.svelte');
  assert.match(modal, /Add \{matchedItems\.filter\(_loggable\)\.length\} to Diary/, 'the Add button counts only what will be logged');
});

test('Trace is told what no_nutrition means and not to force the food in', () => {
  const trace = read('../src/components/ai/Trace.svelte');
  assert.match(trace, /If the tool returns \\`no_nutrition\\`/);
  assert.match(read('../src/lib/aiChat.js'), /no_nutrition: true, food_name, as_prepared_only, message\}: Open Food Facts/);
});
