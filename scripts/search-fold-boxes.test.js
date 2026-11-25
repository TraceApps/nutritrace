/**
 * The search boxes that compared lowercase text only (#346): the Foods tab's
 * own and shared foods, the coach plan picker, Trace's local-food match and
 * the meal slot a quick log picks. Each folds both sides now, so a name
 * typed without its accents still finds the row, and English matches as
 * before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fuzzyMatchFood } from '../src/lib/food-search-match.js';
import { foldText } from '../src/lib/search-text.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// quick-log.js pulls in the app's stores and Vite's import.meta.env, so the
// function is lifted out of its source and run on its own.
const resolveMealSlot = (() => {
  const src = read('../src/lib/quick-log.js');
  const start = src.indexOf('export function resolveMealSlot');
  const body = src.slice(start, src.indexOf('\n}\n', start) + 2).replace('export ', '');
  return new Function('foldText', `${body}\nreturn resolveMealSlot;`)(foldText);
})();

test('Foods search finds accented names typed without accents (#346)', () => {
  assert.ok(fuzzyMatchFood({ name: 'Champiñón' }, 'champinon'));
  assert.ok(fuzzyMatchFood({ name: 'Ají amarillo' }, 'aji'));
  assert.ok(fuzzyMatchFood({ name: 'Corazón de palmito' }, 'corazon de palmito'));
  assert.ok(fuzzyMatchFood({ name: 'Yogur', brand: 'Danone Élite' }, 'elite'));
  // Typing the accent still works.
  assert.ok(fuzzyMatchFood({ name: 'Champiñón' }, 'champiñón'));
  assert.ok(fuzzyMatchFood({ name: 'Champinon' }, 'champiñón'));
});

test('Foods search matches English exactly as before', () => {
  assert.ok(fuzzyMatchFood({ name: 'Whole Milk', brand: 'Horizon' }, 'milk horizon'));
  assert.ok(fuzzyMatchFood({ name: 'Banana' }, 'banan'));
  assert.ok(fuzzyMatchFood({ name: 'Chicken breast' }, 'chiken'));
  assert.ok(!fuzzyMatchFood({ name: 'Chicken breast' }, 'beef'));
  assert.ok(!fuzzyMatchFood({ name: 'Oat' }, 'oaf'));
  assert.ok(fuzzyMatchFood({ name: 'Anything' }, '   '));
});

test('a quick log finds its meal slot without the accent', () => {
  const slots = ['Petit-déjeuner', 'Déjeuner', 'Dîner', 'Collation'];
  assert.equal(resolveMealSlot('Dejeuner', slots), 1);
  assert.equal(resolveMealSlot('diner', slots), 2);
  assert.equal(resolveMealSlot('Déjeuner', slots), 1);
  assert.equal(resolveMealSlot('Lunch', ['Breakfast', 'Lunch', 'Dinner']), 1);
  assert.equal(resolveMealSlot('snack', ['Breakfast', 'Snack 1', 'Snack 2']), 1);
});

test('the coach plan picker and Trace fold what they compare', () => {
  const picker = read('../src/components/coaching/PlanItemPicker.svelte');
  assert.match(picker, /needle = foldText\(query\)\.trim\(\)/);
  assert.match(picker, /foldText\(`\$\{x\.name\} \$\{x\.brand \|\| ''\}`\)\.includes\(needle\)/);
  const trace = read('../src/components/ai/Trace.svelte');
  assert.match(trace, /const _norm = s => foldText\(s\)\.trim\(\);/);
  // The exact spelling wins first, so "Café" next to "Cafe" still logs straight away.
  assert.match(trace, /let exactLocal = \(localFoods \|\| \[\]\)\.filter\(f => _plain\(f\.name\) === qPlain\);\n\s+if \(!exactLocal\.length\) exactLocal = \(localFoods \|\| \[\]\)\.filter\(f => _norm\(f\.name\) === qNorm\);/);
  assert.doesNotMatch(read('../src/routes/Foods.svelte'), /function _fuzzyMatch/);
});

test('a quick log matches foods and meals by name without the accent', () => {
  const ql = read('../src/lib/quick-log.js');
  const food = ql.slice(ql.indexOf('async function _matchFood'), ql.indexOf('async function _matchMeal'));
  const meal = ql.slice(ql.indexOf('async function _matchMeal'));
  assert.match(food, /const ql = foldText\(query\);/);
  assert.match(food, /const n = foldText\(f\.name\);\n\s+const b = foldText\(f\.brand\);/);
  assert.doesNotMatch(food.slice(0, food.indexOf('out.candidates')), /toLowerCase/);
  assert.match(meal, /const ea = foldText\(a\.name\) === query \? 1 : 0;/);
});
