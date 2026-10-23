/**
 * #282: deleting a meal from the Foods page's desktop pane sent the meal's id
 * to DELETE /api/foods/:id, which hid whichever food had that number and left
 * the meal. Deletes on the Foods page now pick the endpoint by what the item
 * is. Unit checks of the picker, plus text checks of the wiring (no browser).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deleteCatalogItem, catalogKindForTab, markCatalogItemUsed, countsUseHere } from '../src/lib/catalog-kind.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const sheet = read('../src/components/ui/FoodDetailSheet.svelte');
const foods = read('../src/routes/Foods.svelte');
const confirmStore = read('../src/stores/confirmDialog.js');
const en = JSON.parse(read('../src/i18n/en.json'));

function fakeApi() {
  const calls = [];
  return {
    calls,
    deleteFood: async id => { calls.push(['food', id]); return { ok: true }; },
    deleteMeal: async id => { calls.push(['meal', id]); return { ok: true }; },
  };
}

test('a meal or recipe is deleted as a meal, a food as a food', async () => {
  for (const [kind, table] of [['food', 'food'], ['meal', 'meal'], ['recipe', 'meal']]) {
    const api = fakeApi();
    await deleteCatalogItem(api, kind, 1);
    assert.deepEqual(api.calls, [[table, 1]], kind);
  }
});

test('an unknown kind deletes nothing and fails', async () => {
  for (const kind of [undefined, null, '', 'foodList', 'meals']) {
    const api = fakeApi();
    await assert.rejects(deleteCatalogItem(api, kind, 1));
    assert.deepEqual(api.calls, [], String(kind));
  }
});

test('each Foods tab maps to the kind it lists', () => {
  assert.equal(catalogKindForTab('foodList'), 'food');
  assert.equal(catalogKindForTab('meals'), 'meal');
  assert.equal(catalogKindForTab('recipes'), 'recipe');
  assert.equal(catalogKindForTab('nope'), null);
});

test('the detail sheet deletes by its kind, never always as a food', () => {
  assert.match(sheet, /export let kind = 'food';/);
  assert.match(sheet, /await deleteCatalogItem\(NtApi, itemKind, target\.id\)/);
  assert.doesNotMatch(sheet, /NtApi\.deleteFood\(/);
});

test('the desktop pane tells the sheet what it shows', () => {
  const pane = foods.match(/<FoodDetailSheet\s+embedded=\{true\}[\s\S]*?\/>/);
  assert.ok(pane, 'pane FoodDetailSheet found');
  assert.match(pane[0], /kind=\{_paneKind\}/);
  assert.match(foods, /_paneKind = 'meal'; _paneFood = food;/);
  assert.match(foods, /_paneKind = 'recipe'; _paneFood = food;/);
  assert.match(foods, /_paneKind = 'food';\s+_paneFood = food;/);
});

test('every item put in the pane comes with its kind', () => {
  const sets = [...foods.matchAll(/([\s\S]{0,60})\b_paneFood = (?!null)/g)];
  assert.ok(sets.length >= 3);
  for (const m of sets) assert.match(m[1], /_paneKind = '(food|meal|recipe)';\s*$/, m[0]);
});

test("someone else's shared item offers no Delete in the sheet", () => {
  assert.match(sheet, /\$: _canDelete = !!_displayFood\?\.id && _displayFood\?\._shared_by == null;/);
  assert.match(sheet, /if \(!_canDelete\) return;/);
  const buttons = [...sheet.matchAll(/\{#if _canDelete\}\s*<button class="btn btn-secondary danger-btn"/g)];
  assert.equal(buttons.length, (sheet.match(/danger-btn"/g) || []).length, 'every Delete button is gated');
});

test('Select Multiple deletes each item by its kind too', () => {
  const fn = foods.match(/async function confirmBulkDelete\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(fn, /deleteCatalogItem\(NtApi, catalogKindForTab\(store\), id\)/);
});

test('the long-press Delete reports a failed delete instead of staying silent', () => {
  const fn = foods.match(/async function deleteItem\(item\) \{[\s\S]*?\n  \}/)[0];
  assert.match(fn, /deleteCatalogItem\(NtApi, catalogKindForTab\(currentStore\), item\.id\)/);
  assert.match(fn, /catch \(e\) \{\s+showError\(/);
  assert.ok(fn.indexOf('return;') < fn.indexOf("showSuccess("), 'no success toast after a failure');
});

test('the confirm dialog gets option names it understands, so the button says Delete', () => {
  const sig = confirmStore.match(/export function confirmDialog\(\{([\s\S]*?)\}\s*=/)[1];
  const accepted = [...sig.matchAll(/(\w+)\s*=/g)].map(m => m[1]);
  const call = sheet.match(/confirmDialog\(\{([\s\S]*?)\}\);/)[1];
  const passed = [...call.matchAll(/^\s*(\w+):/gm)].map(m => m[1]);
  for (const name of passed) assert.ok(accepted.includes(name), `confirmDialog does not take ${name}`);
  assert.ok(passed.includes('confirmText'));
});

test('meal and recipe wording exists in English', () => {
  const d = en.foods.detail;
  for (const k of ['delete_meal_aria', 'delete_meal_confirm_title', 'delete_meal_confirm_body', 'meal_deleted',
    'delete_recipe_aria', 'delete_recipe_confirm_title', 'delete_recipe_confirm_body', 'recipe_deleted']) {
    assert.equal(typeof d[k], 'string', k);
  }
  assert.match(d.delete_meal_confirm_title, /meal/);
  assert.match(d.delete_recipe_confirm_title, /recipe/);
});

// Add to Diary from the pane on a saved meal counted a use of the food that
// shared the meal's number (POST /api/foods/<mealId>/used).
const diaryStore = read('../src/stores/diary.js');

function usageApi() {
  const calls = [];
  return {
    calls,
    markFoodUsed: async (id, date) => { calls.push(['food', id, date]); return { ok: true }; },
    markMealUsed: async (id, date) => { calls.push(['meal', id, date]); return { ok: true }; },
  };
}

test("a logged meal or recipe counts a use of itself, a food of the food", async () => {
  const cases = [
    ['meal', { id: 1 }, 'meal'],
    ['recipe', { id: 1, is_recipe: 1 }, 'meal'],
    ['food', { id: 1 }, 'food'],
    // No kind given: what the diary item says about itself, as before.
    [null, { id: 1, is_recipe: 1 }, 'meal'],
    [null, { id: 1 }, 'food'],
  ];
  for (const [kind, item, table] of cases) {
    const api = usageApi();
    await markCatalogItemUsed(api, kind, item, '2026-10-21');
    assert.deepEqual(api.calls, [[table, 1, '2026-10-21']], `${kind} ${JSON.stringify(item)}`);
  }
  const api = usageApi();
  await assert.rejects(markCatalogItemUsed(api, 'meals', { id: 1 }));
  assert.deepEqual(api.calls, []);
});

test('the diary counts the use by the kind its caller logged', () => {
    assert.match(diaryStore, /markCatalogItemUsed\(NtApi, kind, item, targetDate\)\.catch\(/);
  assert.doesNotMatch(diaryStore, /NtApi\.markFoodUsed\(item\.id/);
});

test("the pane's Add to Diary says what it logs, on every path", () => {
  assert.match(sheet, /dispatch\('addToDiary', \{ food: _displayFood, meal, kind \}\)/);
  const onAdd = foods.match(/async function onDetailAddToDiary\(e\) \{[\s\S]*?\n  \}/)[0];
  assert.match(onAdd, /const kind = e\.detail\.kind \|\| 'food';/);
  assert.match(onAdd, /promptKind = kind;/);
  assert.match(onAdd, /addDiaryItem\(item, chosenMeal, undefined, \{ kind: savedKind \}\)/);
  const noNav = foods.match(/async function _addFoodToDiaryNoNav\(food, qty, kind = null\) \{[\s\S]*?\n  \}/)[0];
  assert.match(noNav, /addDiaryItem\(item, Number\(pickMeal\) \|\| 0, pickDate \|\| undefined, \{ kind \}\)/);
  assert.match(foods, /_addFoodToDiaryNoNav\(food, qty, kind\)/);
  assert.match(foods, /_addFoodToDiary\(food, parseDecimal\(promptServings\) \|\| 1, promptKind\)/);
  assert.match(foods, /_addFoodToDiary\(food, 1, pickedKind\)/);
  // Every item put in the quantity prompt says what it is.
  const sets = [...foods.matchAll(/\bpromptFood = (?!null)[^;]+;\n\s*(.*)/g)];
  assert.ok(sets.length >= 3);
  for (const m of sets) assert.match(m[1], /^promptKind = /, m[0]);
});

// In the Android app (server mode) a shared item's id is the server's, read
// as one of the phone's own rows: logging someone else's shared meal counted
// a use of the user's own meal with that number.
test("the phone doesn't count a use of someone else's shared item by its server id", () => {
  const shared = { id: 3, _shared_by: 'bob' };
  const own = { id: 3 };
  assert.equal(countsUseHere(shared, { native: true }), false);
  assert.equal(countsUseHere(own, { native: true, shared: true }), false, 'ingredient of a shared meal');
  assert.equal(countsUseHere(own, { native: true }), true);
  // The web's ids are the server's: a shared item is counted there.
  assert.equal(countsUseHere(shared, { native: false }), true);
  assert.equal(countsUseHere(own, { native: false, shared: true }), true);
  assert.equal(countsUseHere({ id: 'x' }, { native: false }), false);
  assert.equal(countsUseHere(null), false);
});

test('the diary asks countsUseHere before counting a use', () => {
  assert.match(diaryStore, /export async function addDiaryItem\(foodItem, meal, date, \{ kind = null, shared = false \} = \{\}\)/);
  assert.match(diaryStore, /if \(countsUseHere\(item, \{ native: isNative, shared \}\)\) \{\s+markCatalogItemUsed\(/);
});

// The pane's Add to Diary logged a saved meal as one row; everywhere else a
// saved meal is added (the Diary's pick mode), it logs its ingredients.
test('the pane logs a saved meal as its ingredients, like the Diary does, and a recipe as one row', () => {
  const onAdd = foods.match(/async function onDetailAddToDiary\(e\) \{[\s\S]*?\n  \}/)[0];
  const expand = onAdd.indexOf("if (kind === 'meal' && food.items && food.items.length > 0) {");
  assert.ok(expand > 0, 'meals with ingredients are expanded');
  assert.ok(expand < onAdd.indexOf('if ($diaryPromptQuantity)'), 'before the quantity prompt, as in pick mode');
  assert.match(onAdd, /await _expandMealToDiary\(food, \{ stay: true, shared: food\._shared_by != null \}\);\s+return;/);
  // Pick mode's own rule, which the pane follows.
  assert.match(foods, /if \(activeTab === 1 && food\.items && food\.items\.length > 0\) \{\s+await _expandMealToDiary\(food\);/);
});

test('adding from the pane stays on the Foods page and handles a shared meal', () => {
  const fn = foods.match(/async function _expandMealToDiary\(meal, \{ stay = false, shared = false \} = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, '_expandMealToDiary takes stay and shared');
  const body = fn[0];
  assert.match(body, /if \(!stay\) history\.back\(\);/);
  assert.doesNotMatch(body.replace('if (!stay) history.back();', ''), /history\.back\(\)/);
  assert.match(body, /countsUseHere\(meal, \{ native: isNative, shared \}\)/);
  assert.match(body, /markCatalogItemUsed\(NtApi, 'meal', meal, pickDate \|\| undefined\)/);
  assert.match(body, /pickDate \|\| undefined,\s+\{ shared \}\s+\);/);
  assert.match(body, /const stale = shared \? \[\] : _staleIngredientNames\(meal\);/);
});
