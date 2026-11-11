/**
 * Trace logged a food in a unit other than the food's own (1 cup, 4 tbsp)
 * with the per-100 g values still attached, so 4 tbsp of peanut butter came
 * out as 653 kcal and 1 cup of almond milk as 13 kcal. The diary item and the
 * number Trace reported were also computed differently.
 *
 * nutritionForPortion re-bases the food to the portion eaten with the same
 * scaleFactor the Diary edit sheet uses, and Trace reports that same number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nutritionForPortion } from '../src/lib/units.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const peanutButter = { name: 'Peanut Butter', portion: 100, unit: 'g', nutrition: { calories: 653, proteins: 23.1, fat: 55.6 } };
const almondMilk   = { name: 'Almond milk',   portion: 100, unit: 'g', nutrition: { calories: 13, proteins: 0.5, fat: 1.1 } };
const banana       = { name: 'Banana',         portion: 100, unit: 'g', nutrition: { calories: 90.5, proteins: 1.06 } };

test('4 tbsp of a per-100 g peanut butter is about 386 kcal, not 653', () => {
  const n = nutritionForPortion(peanutButter, 4, 'tbsp');
  assert.ok(Math.abs(n.calories - 653 * (4 * 14.787) / 100) < 1e-6);
  assert.equal(Math.round(n.calories), 386);
});

test('1 cup of per-100 g almond milk is about 31 kcal, not 13', () => {
  assert.equal(Math.round(nutritionForPortion(almondMilk, 1, 'cup').calories), 31);
});

test('the same portion as the food keeps its values', () => {
  assert.equal(nutritionForPortion(banana, 100, 'g').calories, 90.5);
});

test('grams scale linearly', () => {
  assert.equal(Math.round(nutritionForPortion(banana, 200, 'g').calories), 181);
});

test('every nutrient scales together, and string values are read', () => {
  const food = { portion: 100, unit: 'g', nutrition: { calories: '13', proteins: '0.5' } };
  const n = nutritionForPortion(food, 240, 'ml');
  const f = 240 / 100;
  assert.ok(Math.abs(n.calories - 13 * f) < 1e-9);
  assert.ok(Math.abs(n.proteins - 0.5 * f) < 1e-9);
});

test('the food record is not mutated', () => {
  const food = { portion: 100, unit: 'g', nutrition: { calories: 653 } };
  nutritionForPortion(food, 4, 'tbsp');
  assert.equal(food.nutrition.calories, 653);
});

test('a food with no nutrition comes back as it was', () => {
  assert.equal(nutritionForPortion({ portion: 100, unit: 'g', nutrition: null }, 2, 'g'), null);
  assert.equal(nutritionForPortion(null, 2, 'g'), undefined);
});

test('Trace no longer reports kcal with the portion ratio', () => {
  const src = read('../src/components/ai/Trace.svelte');
  assert.equal(src.includes('item.portion / (food.portion'), false);
  assert.equal(src.includes('item.portion / (saved.portion'), false);
  assert.equal(src.split('nutritionForPortion(').length - 1, 3);
});
