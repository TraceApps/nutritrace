/**
 * PR #305 (@librarian): a meal's macro split divided by the meal's listed
 * calories, while the day's split divides by protein + carbs + fat calories.
 * A day with one meal showed 68% protein on the meal and 70% on the day.
 * Both now use Nutrition.macroPercents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Nutrition } from '../src/lib/nutrition.js';

const diary = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');

test('meal totals use the same macro split as the day', () => {
  const body = diary.slice(diary.indexOf('function getMealTotals'), diary.indexOf('function getMealItems'));
  assert.match(body, /Nutrition\.macroPercents\(t\)/);
  assert.doesNotMatch(body, /\/ cal \* 100/);
});

test('macro split adds up even when listed calories differ from the macros', () => {
  // 50 g protein, 10 g carbs, 5 g fat = 285 macro kcal; label says 300 kcal.
  const mp = Nutrition.macroPercents({ calories: 300, proteins: 50, carbohydrates: 10, fat: 5 });
  assert.deepEqual(mp, { protein: 70, carbs: 14, fat: 16 });
});
