/**
 * A recipe imported from CookTrace keeps CookTrace's nutrition rollup only
 * while its ingredients are the ones the rollup was worked out for, and a
 * save divides by the servings once (#343).
 *
 * The editor kept the rollup whenever the ingredient count was unchanged,
 * so changing an amount saved CookTrace's old values. And a recipe opened
 * from the catalog holds values per serving, which the save divided by the
 * servings again: re-saving a 4-serving recipe cut it to a quarter.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sourceRollup, recipeSaveNutrition, ingredientsKey } from '../src/lib/recipe-rollup.js';

const rice = { name: 'Rice', portion: 200, unit: 'g', quantity: 1, nutrition: { calories: 260 } };
const oil  = { name: 'Oil',  portion: 10,  unit: 'g', quantity: 1, nutrition: { calories: 90 } };
const items = [rice, oil];
// The editor's own sum of those ingredients.
const sum = list => ({ calories: list.reduce((s, it) => s + it.nutrition.calories, 0) });

test('a fresh import saves CookTrace\'s rollup per serving', () => {
  // CookTrace's rollup (density-aware) is 400 for the whole recipe; the editor's sum is 350.
  const rollup = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 400 }, items });
  const saved = recipeSaveNutrition({ rollup, items, totals: sum(items), yields: 4 });
  assert.equal(saved.calories, 100);
});

test('re-saving a recipe from the catalog keeps its values, not a quarter of them', () => {
  // Stored per serving: 100 of a 4-serving recipe.
  const rollup = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 100 }, items, servings: 4, perServing: true });
  assert.equal(rollup.total.calories, 400);
  assert.equal(recipeSaveNutrition({ rollup, items, totals: sum(items), yields: 4 }).calories, 100);
  // Saved again and again: still 100.
  const again = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 100 }, items: JSON.parse(JSON.stringify(items)), servings: 4, perServing: true });
  assert.equal(recipeSaveNutrition({ rollup: again, items, totals: sum(items), yields: 4 }).calories, 100);
});

test('changing the servings splits the same recipe differently', () => {
  const rollup = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 100 }, items, servings: 4, perServing: true });
  assert.equal(recipeSaveNutrition({ rollup, items, totals: sum(items), yields: 2 }).calories, 200);
});

test('a recipe saved before servings existed counts as one serving', () => {
  const rollup = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 400 }, items, servings: null, perServing: true });
  assert.equal(recipeSaveNutrition({ rollup, items, totals: sum(items), yields: 1 }).calories, 400);
});

test('#343: a changed amount saves the ingredients, not the old rollup', () => {
  const rollup = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 400 }, items, servings: 1, perServing: true });
  const edited = [{ ...rice, portion: 400, nutrition: { calories: 520 } }, oil];
  assert.equal(recipeSaveNutrition({ rollup, items: edited, totals: sum(edited), yields: 1 }).calories, 610);
  // And per serving, once.
  assert.equal(recipeSaveNutrition({ rollup, items: edited, totals: sum(edited), yields: 2 }).calories, 305);
});

test('adding, removing or swapping an ingredient saves the ingredients', () => {
  const rollup = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 400 }, items });
  const salt = { name: 'Salt', portion: 1, unit: 'g', quantity: 1, nutrition: { calories: 0 } };
  for (const list of [[rice, oil, salt], [rice], [rice, { ...oil, name: 'Butter', nutrition: { calories: 72 } }]]) {
    assert.equal(recipeSaveNutrition({ rollup, items: list, totals: sum(list), yields: 1 }).calories, sum(list).calories);
  }
});

test('reordering the ingredients keeps the rollup', () => {
  const rollup = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 400 }, items });
  assert.equal(recipeSaveNutrition({ rollup, items: [oil, rice], totals: sum(items), yields: 1 }).calories, 400);
});

test('an amount CookTrace could not convert, set here, saves the ingredients (#296)', () => {
  const rollup = sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 400 }, items });
  assert.equal(recipeSaveNutrition({ rollup, items, totals: sum(items), yields: 1, ctAmountFixed: true }).calories, 350);
});

test('no source, or a rollup with no values, saves the ingredients', () => {
  assert.equal(sourceRollup({ sourceApp: null, nutrition: { calories: 400 }, items }), null);
  assert.equal(sourceRollup({ sourceApp: 'cooktrace', nutrition: {}, items }), null);
  assert.equal(sourceRollup({ sourceApp: 'cooktrace', nutrition: { calories: 0 }, items }), null);
  assert.equal(recipeSaveNutrition({ rollup: null, items, totals: sum(items), yields: 2 }).calories, 175);
});

test('ingredients that went to the server and back still match', () => {
  const back = JSON.parse(JSON.stringify([{ ...rice, nutrition: { calories: 260.1 + 0.2 } }]));
  assert.deepEqual(ingredientsKey(back), ingredientsKey([{ ...rice, nutrition: { calories: 260.3 } }]));
});

test('the editor builds the rollup on open and on a CookTrace refresh', () => {
  const src = readFileSync(new URL('../src/routes/MealEditor.svelte', import.meta.url), 'utf8');
  // Opened: per serving when it came from the catalog (it has an id).
  assert.match(src, /_rollup = sourceRollup\(\{\s*sourceApp: meal\.source_app, nutrition: meal\.nutrition, items: meal\.items,\s*servings: meal\.servings, perServing: meal\.id != null,\s*\}\)/);
  // Refreshed from CookTrace: its new whole-recipe rollup, for its new ingredients.
  assert.match(src, /_rollup = sourceRollup\(\{ sourceApp: meal\.source_app, nutrition: mapped\.nutrition, items: meal\.items \}\)/);
  // A sync from another device, and discarding a restored draft, start again from the saved row.
  assert.match(src, /if \(isRecipe\) _rollup = sourceRollup\(\{ sourceApp: row\.source_app, nutrition: row\.nutrition, items: row\.items, servings: row\.servings, perServing: true \}\)/);
  assert.match(src, /_rollup = isRecipe \? sourceRollup\(\{ sourceApp: m\.source_app, nutrition: m\.nutrition, items: m\.items, servings: m\.servings, perServing: m\.id != null \}\) : null;/);
  assert.doesNotMatch(src, /_itemsMatchSourceCount/);
});
