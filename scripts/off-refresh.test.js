/**
 * #241 (@fatman00): Refresh from OFF did not pick up a product edited on
 * Open Food Facts.
 *
 * Three things stood between the edit and the food:
 *  1. The refresh only filled empty fields, so it never changed a number.
 *  2. A local OFF mirror, if the server runs one, answers from a dump taken
 *     before the edit.
 *  3. This product's edit put every value in OFF's "as prepared" column, and
 *     NutriTrace reads the "as sold" one; a missing value also came back as 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOffRefresh } from '../src/lib/off-refresh.js';
import { NUTRIMENTS, Nutrition } from '../src/lib/nutrition.js';
import { offProductName } from '../src/lib/off-name.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const IDS = NUTRIMENTS.map(n => n.id);

// An OFF lookup result as api.js returns it: per 100 g, _offPresent non-enumerable.
function off(nutrition, { present = Object.keys(nutrition), preparedOnly = false, portion = 100, unit = 'g', ...rest } = {}) {
  const r = { name: 'Kidney beans', brand: 'Rema 1000', imgUrl: 'https://img/x.jpg', portion, unit, nutrition, ...rest };
  Object.defineProperty(r, '_offPresent', { value: present, enumerable: false });
  Object.defineProperty(r, '_offPreparedOnly', { value: preparedOnly, enumerable: false });
  return r;
}
const saved = { name: 'Kidney beans', brand: 'Rema 1000', portion: 100, unit: 'g', calories: 120, proteins: 7, fat: 0.5, fiber: 6 };

test('a value changed on OFF now changes in the food', () => {
  const { food, changed, reason } = applyOffRefresh(saved, off({ calories: 101, proteins: 8.2, fat: 0.7, fiber: 6 }), IDS);
  assert.equal(reason, 'updated');
  assert.equal(changed, 3);
  assert.equal(food.calories, 101);
  assert.equal(food.proteins, 8.2);
  assert.equal(food.fat, 0.7);
});

test('a value OFF does not have is left alone, never zeroed', () => {
  // OFF lacks fiber: the mapper reports 0 for it, but it is not in _offPresent.
  const { food } = applyOffRefresh(saved, off({ calories: 101, fiber: 0 }, { present: ['calories'] }), IDS);
  assert.equal(food.fiber, 6);
  assert.equal(food.calories, 101);
});

test('a real 0 on OFF does replace an old number', () => {
  const { food } = applyOffRefresh(saved, off({ fat: 0 }), IDS);
  assert.equal(food.fat, 0);
});

test('nothing changes when OFF already matches, whatever the number format', () => {
  const form = { ...saved, calories: '120', proteins: '7,0', fat: '0.5' };
  const r = applyOffRefresh(form, off({ calories: 120, proteins: 7, fat: 0.5 }), IDS);
  assert.equal(r.reason, 'up_to_date');
  assert.equal(r.changed, 0);
});

test('values are converted to the food\'s own portion', () => {
  assert.equal(applyOffRefresh({ ...saved, portion: 50 }, off({ calories: 101 }), IDS).food.calories, 50.5);
  assert.equal(applyOffRefresh({ ...saved, portion: 250, unit: 'ml' }, off({ calories: 40 }), IDS).food.calories, 100, '1 ml = 1 g, as elsewhere in the app');
  assert.equal(applyOffRefresh({ ...saved, portion: 1, unit: 'oz' }, off({ calories: 100 }), IDS).food.calories, 28.35);
  assert.equal(applyOffRefresh({ ...saved, portion: '1,5', unit: 'kg' }, off({ calories: 100 }), IDS).food.calories, 1500);
});

test('units that cannot be converted change nothing, and say why', () => {
  const r = applyOffRefresh({ ...saved, portion: 1, unit: 'slice' }, off({ calories: 101 }), IDS);
  assert.equal(r.reason, 'units_differ');
  assert.equal(r.food.calories, 120);
  const same = applyOffRefresh({ ...saved, portion: 1, unit: 'bar' }, off({ calories: 210 }, { portion: 1, unit: 'bar' }), IDS);
  assert.equal(same.food.calories, 210, 'the same household unit on both sides converts 1:1');
});

test('a product with only "as prepared" values changes nothing, and says so', () => {
  const r = applyOffRefresh(saved, off({ calories: 0, proteins: 0 }, { present: [], preparedOnly: true }), IDS);
  assert.equal(r.reason, 'prepared_only');
  for (const id of IDS) assert.equal(r.food[id], saved[id], `${id} untouched`);
});

test('a product with no nutrition at all changes nothing', () => {
  assert.equal(applyOffRefresh(saved, off({}, { present: [] }), IDS).reason, 'no_nutrition');
});

test('name, brand and photo only fill in when empty', () => {
  const renamed = { ...saved, name: 'Beans for chili' };
  const r = applyOffRefresh(renamed, off({ calories: 101 }), IDS);
  assert.equal(r.food.name, 'Beans for chili');
  assert.equal(r.food.imgUrl, 'https://img/x.jpg', 'an empty photo is filled');
  assert.equal(applyOffRefresh({ ...saved, name: '' }, off({}, { present: [] }), IDS).food.name, 'Kidney beans');
});

test('a food with no portion yet takes OFF\'s', () => {
  const r = applyOffRefresh({ name: 'x', portion: '', unit: '' }, off({ calories: 101 }), IDS);
  assert.equal(r.food.portion, 100);
  assert.equal(r.food.unit, 'g');
  assert.equal(r.food.calories, 101);
});

test('the food passed in is not modified', () => {
  const before = JSON.stringify(saved);
  applyOffRefresh(saved, off({ calories: 99 }), IDS);
  assert.equal(JSON.stringify(saved), before);
});

// The real mapper, run on the reported product. api.js needs Vite to load, so
// the method is lifted out of its source; if its shape changes this fails
// loudly rather than passing quietly.
function realMapper() {
  const src = read('../src/lib/api.js');
  const a = src.indexOf('  _mapOFFProduct(p) {');
  const b = src.indexOf('\n  }\n', a);
  const t = src.indexOf('const _OFF_NUTRIENTS = [');
  assert.ok(a > 0 && b > a && t > 0, 'api.js still has _mapOFFProduct and _OFF_NUTRIENTS');
  const table = src.slice(t, src.indexOf('];', t) + 2);
  const fn = new Function('p', 'offProductName', '_getOffSearchLanguage', 'localStorage', 'Nutrition', table + '\n' + src.slice(a + 21, b));
  return (p) => fn(p, offProductName, () => 'en', { getItem: () => null }, Nutrition);
}

test('the reported product: the mapper sees no as-sold values and flags "as prepared"', () => {
  const { product } = JSON.parse(read('./fixtures/off-241-prepared-only.json'));
  const mapped = realMapper()(product);
  assert.deepEqual(mapped._offPresent, []);
  assert.equal(mapped._offPreparedOnly, true);
  assert.equal(mapped.nutrition.calories, 0, 'which is exactly why a blind overwrite would have zeroed the food');
  assert.equal(applyOffRefresh(saved, mapped, IDS).reason, 'prepared_only');
});

test('the mapper marks what OFF has, and the marks are never saved with a food', () => {
  const mapped = realMapper()({ product_name: 'Test', nutriments: { 'energy-kcal_100g': 101, proteins_100g: 8.2, salt_100g: 0.5, fiber_100g: '', 'fat_100g': 3, fat_modifier: '~' } });
  assert.deepEqual([...mapped._offPresent].sort(), ['calories', 'proteins', 'salt', 'sodium']);
  assert.ok(!Object.keys(mapped).some(k => k.startsWith('_off')), 'non-enumerable: a spread or JSON never carries them');
  assert.equal(JSON.stringify(mapped).includes('_offPresent'), false);
});

test('Refresh from OFF asks OFF itself, past a local mirror, and uses the new rules', () => {
  const editor = read('../src/routes/FoodEditor.svelte');
  const fn = editor.slice(editor.indexOf('async function downloadFromOFF'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /API\.lookupBarcode\(food\.barcode, \{ live: true \}\)/);
  assert.match(body, /applyOffRefresh\(food, result, NUTRIMENTS\.map\(n => n\.id\)\)/);
  assert.doesNotMatch(body, /smart mode/, 'the fill-empty-only loop is gone');
});

test('only a live request skips the mirror, and never on an air-gapped server', () => {
  const proxy = read('../server/routes/proxy.js');
  assert.match(proxy, /const wantLive = req\.query\.live === '1' && !isLocalOffOnly\(\);/);
  assert.match(proxy, /if \(isLocalOffEnabled\(\) && isApiHost && !wantLive\) \{/);
  const api = read('../src/lib/api.js');
  assert.match(api, /\+ \(live \? '&live=1' : ''\)/, 'an ordinary lookup builds the same proxy URL as before');
  assert.match(api, /async lookupBarcode\(barcode, \{ live = false \} = \{\}\)/);
});

test('the salt and sodium "calculated" marks follow what OFF gave', () => {
  // OFF lists salt only: sodium is worked out from it, so sodium carries the mark.
  const saltOnly = off({ salt: 1, sodium: 400, _derived: { sodium: true, salt: false } }, { present: ['salt', 'sodium'] });
  assert.deepEqual(applyOffRefresh({ ...saved, _derived: {} }, saltOnly, IDS).food._derived, { salt: false, sodium: true });
  // OFF lists both: a stale mark from an earlier edit is cleared.
  const both = off({ salt: 1, sodium: 400, _derived: { sodium: false, salt: false } }, { present: ['salt', 'sodium'] });
  assert.deepEqual(applyOffRefresh({ ...saved, _derived: { salt: true } }, both, IDS).food._derived, { salt: false, sodium: false });
  // OFF has neither: the marks are left exactly as they were.
  assert.deepEqual(applyOffRefresh({ ...saved, _derived: { salt: true } }, off({ calories: 99 }), IDS).food._derived, { salt: true });
});

test('offline, Refresh from OFF says it needs a connection instead of "not found"', () => {
  const editor = read('../src/routes/FoodEditor.svelte');
  assert.match(editor, /import \{ offlineState \} from '\.\.\/lib\/offline-api\.js';/);
  const fn = editor.slice(editor.indexOf('async function downloadFromOFF'));
  const offlineAt = fn.indexOf("if ($offlineState.online === false) { showInfo($_('food_editor.toast.off_offline')); return; }");
  assert.ok(offlineAt > 0, 'the offline check is there');
  assert.ok(offlineAt < fn.indexOf('API.lookupBarcode'), 'and it runs before any lookup is attempted');
});
