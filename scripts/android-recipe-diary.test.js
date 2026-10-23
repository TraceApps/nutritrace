import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { hydrateWithoutFoods } from '../src/lib/diary-hydration.js';
import { markCatalogItemUsed } from '../src/lib/catalog-kind.js';

const diaryStoreSrc = readFileSync(new URL('../src/stores/diary.js', import.meta.url), 'utf8');

test('recipe-only hydration resolves diary items instead of returning Promises', async () => {
  const recipe = {
    id: 41,
    is_recipe: 1,
    name: 'Vegetable curry',
    portion: 350,
    unit: 'g',
    nutrition: { calories: 420 },
  };

  const hydrated = await hydrateWithoutFoods([recipe], async item => item);

  assert.deepEqual(hydrated, [recipe]);
  assert.equal(hydrated[0] instanceof Promise, false);
});

test('recipe diary entries update meal usage rather than food usage', async () => {
  // The store counts the use through markCatalogItemUsed (#282), which,
  // when no kind is given, tells a recipe apart by is_recipe.
  assert.match(diaryStoreSrc, /markCatalogItemUsed\(NtApi, kind, item, targetDate\)/);
  const calls = [];
  const api = {
    markMealUsed: async id => { calls.push(['meal', id]); },
    markFoodUsed: async id => { calls.push(['food', id]); },
  };
  await markCatalogItemUsed(api, null, { id: 41, is_recipe: 1 }, '2026-10-21');
  await markCatalogItemUsed(api, null, { id: 7 }, '2026-10-21');
  assert.deepEqual(calls, [['meal', 41], ['food', 7]]);
});
