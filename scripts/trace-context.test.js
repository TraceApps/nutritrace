/**
 * #288 (@jsapede): a diary that couldn't be read went into Trace's prompt as
 * "No food logged today yet.", so the model said nothing was logged without
 * calling get_diary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diaryContextText, waterContextText, DIARY_UNREADABLE } from '../src/lib/trace-context.js';

test('a diary that could not be read says so and asks for get_diary', () => {
  assert.equal(diaryContextText(null), DIARY_UNREADABLE);
  assert.match(DIARY_UNREADABLE, /couldn't be read/);
  assert.match(DIARY_UNREADABLE, /Call get_diary for today/);
  assert.doesNotMatch(DIARY_UNREADABLE, /No food logged/);
  assert.match(waterContextText(null), /^Unknown/);
});

test('an empty day is still an empty day', () => {
  const empty = { date: '2026-10-27', items: [], body_stats: {}, water: [] };
  assert.equal(diaryContextText(empty), 'No food logged today yet.');
  assert.equal(waterContextText(empty), 'None logged');
});

test('a logged day lists totals and meals as before', () => {
  const day = { items: [
    { name: 'Oats', portion: 50, unit: 'g', meal: 0, nutrition: { calories: 190, proteins: 6.5, carbohydrates: 33, fat: 3.5 } },
    { name: 'Apple', portion: 1, unit: 'piece', meal: 3, nutrition: { calories: 95, proteins: 0.5, carbohydrates: 25, fat: 0.3 } },
  ], water: [{ amount: 500 }, { amount: 250 }] };
  const text = diaryContextText(day, { mealNames: ['Breakfast', 'Lunch', 'Dinner', 'Snacks'], energyUnit: 'kcal' });
  assert.match(text, /^Totals: \d+ kcal, \d+g protein, \d+g carbs, \d+g fat\.\n/);
  assert.match(text, /Breakfast: Oats \(50g\)\n/);
  assert.match(text, /Snacks: Apple \(1piece\)\n/);
  assert.equal(waterContextText(day), '0.75 L (750 ml)');
});

test('Trace builds its prompt lines from these helpers', () => {
  const src = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
  assert.match(src, /const diaryText = diaryContextText\(entry, \{ mealNames: mNames, energyUnit: eUnit \}\);/);
  assert.match(src, /const waterText = waterContextText\(entry\);/);
  assert.match(src, /getDiaryDate\(today\)\.catch\(\(\) => null\)/);
});
