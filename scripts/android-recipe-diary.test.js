import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { hydrateWithoutFoods } from '../src/lib/diary-hydration.js';

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

test('recipe diary entries update meal usage rather than food usage', () => {
  assert.match(
    diaryStoreSrc,
    /item\.is_recipe\s*\?\s*NtApi\.markMealUsed\(item\.id,\s*targetDate\)\s*:\s*NtApi\.markFoodUsed\(item\.id,\s*targetDate\)/,
  );
});
