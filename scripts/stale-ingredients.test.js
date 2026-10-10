/**
 * A saved meal keeps logging a food that was deleted from the catalogue.
 *
 * Reported from a diagnostics log: adding one particular meal put the wrong
 * foods in the diary, and the only trace was POST /api/foods/7285/used
 * answering 404 while the other two ingredients answered 200. The meal's
 * saved ingredient list still pointed at a food that no longer existed, and
 * because name and nutrition are snapshotted onto each ingredient, the add
 * looked like it worked.
 *
 * These cover the detection and the two failure modes it must not have:
 * accusing a good ingredient, and going quiet when a write fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { staleIngredientNames } from '../src/lib/stale-ingredients.js';

const foods = readFileSync(new URL('../src/routes/Foods.svelte', import.meta.url), 'utf8');

const CATALOGUE = [
  [{ id: 7677, name: 'Chicken breast' }, { id: 7905, name: 'Rice' }],
  [], [],
];

test('an ingredient whose food is gone is named', () => {
  const items = [
    { id: 7677, name: 'Chicken breast' },
    { id: 7905, name: 'Rice' },
    { id: 7285, name: 'Olive oil' },
  ];
  assert.deepEqual(staleIngredientNames(items, CATALOGUE), ['Olive oil']);
});

test('a meal whose ingredients all resolve reports nothing', () => {
  const items = [{ id: 7677, name: 'Chicken breast' }, { id: 7905, name: 'Rice' }];
  assert.deepEqual(staleIngredientNames(items, CATALOGUE), []);
});

test('an empty or unloaded catalogue accuses nobody', () => {
  const items = [{ id: 7285, name: 'Olive oil' }];
  assert.deepEqual(staleIngredientNames(items, [[], [], []]), [], 'catalogue not loaded yet');
  assert.deepEqual(staleIngredientNames(items, []), [], 'no lists at all');
  assert.deepEqual(staleIngredientNames(items, [null, undefined]), [], 'lists that are not arrays');
});

test('an ingredient that never had a catalogue id is left alone', () => {
  // Open Food Facts / USDA / hand-typed ingredients carry no numeric id,
  // so there is nothing for them to have lost.
  const items = [
    { name: 'Olive oil' },
    { id: 'off-3017620422003', name: 'Nutella' },
    { id: null, name: 'Leftover soup' },
  ];
  assert.deepEqual(staleIngredientNames(items, CATALOGUE), []);
});

test("Android's local ids and the server's ids both count as a match", () => {
  // After a re-install the local rows are renumbered, so a meal saved on
  // another device holds the server id while the cache row holds both.
  const cache = [[{ id: 12, server_id: 7677, name: 'Chicken breast' }], [], []];
  assert.deepEqual(staleIngredientNames([{ id: 7677, name: 'Chicken breast' }], cache), [],
    'ingredient holds the server id, cache row holds it under server_id');
  assert.deepEqual(staleIngredientNames([{ id: 99, food_server_id: 7677, name: 'Chicken breast' }], cache), [],
    'ingredient holds a foreign local id plus the server id');
  assert.deepEqual(staleIngredientNames([{ id: 12, name: 'Chicken breast' }], cache), [],
    'ingredient holds the local id');
});

test('a recipe or meal used as an ingredient resolves against its own list', () => {
  const cat = [[{ id: 1, name: 'Rice' }], [{ id: 2200, name: 'Sofrito' }], [{ id: 2300, name: 'Ragu' }]];
  assert.deepEqual(staleIngredientNames([{ id: 2200, name: 'Sofrito' }, { id: 2300, name: 'Ragu' }], cat), []);
});

test('nothing is reported for a meal with no ingredients', () => {
  assert.deepEqual(staleIngredientNames([], CATALOGUE), []);
  assert.deepEqual(staleIngredientNames(null, CATALOGUE), []);
  assert.deepEqual(staleIngredientNames(undefined, CATALOGUE), []);
});

test('order follows the meal, and every stale ingredient is listed', () => {
  const items = [
    { id: 7285, name: 'Olive oil' },
    { id: 7677, name: 'Chicken breast' },
    { id: 7286, name: 'Butter' },
  ];
  assert.deepEqual(staleIngredientNames(items, CATALOGUE), ['Olive oil', 'Butter']);
});

test('a failed ingredient no longer aborts the rest of the meal', () => {
  const fn = foods.slice(foods.indexOf('async function _expandMealToDiary'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /for \(const item of meal\.items\) \{\s*try \{/,
    'each ingredient is attempted inside its own try');
  assert.match(body, /catch \(e\) \{[\s\S]*?failed\.push\(item\?\.name \|\| ''\)/,
    'a failure is recorded rather than thrown out of the loop');
});

test('a meal that logged nothing says so and stays put', () => {
  const fn = foods.slice(foods.indexOf('async function _expandMealToDiary'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /failed\.length === meal\.items\.length\) \{[\s\S]*?meal_none_added'\)\);\s*return;/,
    'total failure reports and returns before history.back()');
  assert.match(body, /meal_partly_added'/, 'a partial failure names what is missing');
});

test('the stale notice is skipped when the catalogue failed to load', () => {
  assert.match(foods, /function _staleIngredientNames\(meal\) \{\s*if \(loadError\) return \[\];/);
});
