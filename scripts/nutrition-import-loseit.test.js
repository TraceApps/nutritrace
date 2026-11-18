/**
 * Lose It! food-log export. Calories and nutrients are the totals for the
 * logged amount (50 g of oats is 185 kcal), so the amount must not become the
 * serving count that the diary multiplies by.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoseit } from '../server/lib/nutrition-import/loseit.js';

const CSV = [
  'Date,Name,Icon,Type,Quantity,Units,Calories,Deleted,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)',
  '08/27/2025,Porridge Oats,Cereal,Breakfast,50.0,Grams,185,0,3.90,6,29.50,0.60,0.45,4.40,0,15',
].join('\n') + '\n';

test('the logged amount is the portion, not the number of servings', () => {
  const [item] = parseLoseit(CSV);
  assert.equal(item.quantity, 1);
  assert.equal(item.portion, 50);
  assert.equal(item.unit, 'Grams');
  assert.equal(item.nutrition.calories, 185);
});
