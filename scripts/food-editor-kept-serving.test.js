/**
 * #348: editing a food while adding it to the diary saved the amount typed
 * as the food's own serving, so the next log started from that day's
 * amount. The food now keeps the serving it opened with, nutrition rescaled
 * to it, and only the diary gets the amount typed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { keptServingOf, atKeptServing } from '../src/lib/kept-serving.js';

const editor = readFileSync(new URL('../src/routes/FoodEditor.svelte', import.meta.url), 'utf8');

const egg = { name: 'Huevo duro', portion: 231, unit: 'g', energy: 358.05,
  nutrition: { energy: 358.05, proteins: 29.1, _derived: { energy: true } } };

test("the reporter's case: 231 g typed, the food stays 100 g with the same values per gram", () => {
  const saved = atKeptServing(egg, { portion: 100, unit: 'g' });
  assert.equal(saved.portion, 100);
  assert.equal(saved.unit, 'g');
  assert.equal(saved.nutrition.energy, 155);
  assert.equal(saved.energy, 155, 'the flat field follows');
  assert.equal(saved.nutrition.proteins, 12.5974);
  assert.deepEqual(saved.nutrition._derived, { energy: true }, 'non-numbers kept as they are');
  assert.equal(egg.portion, 231, 'the typed item (what the diary gets) is untouched');
});

test('scaling turned off: what was typed for 231 g is stored per 100 g', () => {
  const typed = { ...egg, nutrition: { energy: 155 } };
  assert.equal(atKeptServing(typed, { portion: 100, unit: 'g' }).nutrition.energy, 67.0996);
});

test('a convertible unit change keeps the food in its own unit', () => {
  const saved = atKeptServing({ portion: 1, unit: 'oz', nutrition: { energy: 28.35 } }, { portion: 100, unit: 'g' });
  assert.equal(saved.unit, 'g');
  assert.equal(saved.portion, 100);
  assert.ok(Math.abs(saved.nutrition.energy - 100) < 0.01, String(saved.nutrition.energy));
});

test("a unit that can't be converted is saved as typed, never guessed", () => {
  const item = { portion: 1, unit: 'piece', nutrition: { energy: 70 } };
  assert.equal(atKeptServing(item, { portion: 100, unit: 'g' }), item);
  // With a piece size it converts.
  const sized = { ...item, alt_units: [{ abbr: 'piece', grams: 50 }] };
  assert.equal(atKeptServing(sized, { portion: 100, unit: 'g' }).nutrition.energy, 140);
});

test('grams to milliliters converts only through a density, never on the 1 ml = 1 g guess', () => {
  const honey = { portion: 15, unit: 'ml', nutrition: { energy: 64 } };
  assert.equal(atKeptServing(honey, { portion: 100, unit: 'g' }), honey);
  // A density alone isn't used without a basis (units.js), so still as typed.
  const densityOnly = { ...honey, density_g_ml: 1.42 };
  assert.equal(atKeptServing(densityOnly, { portion: 100, unit: 'g' }), densityOnly);
  // A basis with no density doesn't convert at all (canScale).
  const basisOnly = { ...honey, nutrition_basis: 'g' };
  assert.equal(atKeptServing(basisOnly, { portion: 100, unit: 'g' }), basisOnly);
  const dense = { ...honey, nutrition_basis: 'g', density_g_ml: 1.42 };
  const saved = atKeptServing(dense, { portion: 100, unit: 'g' });
  assert.equal(saved.unit, 'g');
  assert.ok(Math.abs(saved.nutrition.energy - 64 * 100 / (15 * 1.42)) < 0.01, String(saved.nutrition.energy));
  // Within one system it converts as before.
  assert.equal(atKeptServing({ portion: 1, unit: 'l', nutrition: { energy: 450 } }, { portion: 100, unit: 'ml' }).nutrition.energy, 45);
});

test('the editor is told about the diary on every open, so a backed-out one is not left behind', () => {
  const foods = readFileSync(new URL('../src/routes/Foods.svelte', import.meta.url), 'utf8');
  const open = foods.match(/function openEditor\(item, store\) \{[\s\S]*?\n  \}/)[0];
  assert.match(open, /editorState\.foodDiaryCtx = pickMode \? \{ date: pickDate, meal: pickMeal \} : null;/);
  assert.equal((foods.match(/editorState\.foodDiaryCtx =/g) || []).length, 1, 'set in one place only');
});

test('nothing kept, nothing changed, or no amount: saved as typed', () => {
  assert.equal(atKeptServing(egg, null), egg);
  const same = { ...egg, portion: 100 };
  assert.equal(atKeptServing(same, { portion: 100, unit: 'g' }), same);
  const empty = { ...egg, portion: '' };
  assert.equal(atKeptServing(empty, { portion: 100, unit: 'g' }), empty);
});

test('the kept serving: a food that came with one, not a bare scan or a blank form', () => {
  assert.deepEqual(keptServingOf({ portion: 100, unit: 'g' }), { portion: 100, unit: 'g' });
  assert.deepEqual(keptServingOf({ portion: '2,5', unit: 'cup' }), { portion: 2.5, unit: 'cup' });
  assert.deepEqual(keptServingOf({ portion: 30 }), { portion: 30, unit: 'g' });
  assert.equal(keptServingOf({ barcode: '123' }), null);
  assert.equal(keptServingOf(null), null);
});

test('the editor keeps the serving only when adding to the diary, and logs what was typed', () => {
  assert.match(editor, /_keptServing = keptServingOf\(editorState\.foodPrefill \|\| \(params && params\.id \? food : null\)\);/);
  // Taken before a draft is brought back, so a draft can't stand in for it.
  assert.ok(editor.indexOf('_keptServing = keptServingOf(') < editor.indexOf('const _draft = loadDraft(_draftKey);'));
  const save = editor.match(/async function save\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(save, /const toSave = ctx \? atKeptServing\(item, _keptServing\) : item;/);
  assert.match(save, /\.\.\.changes \} = toSave;/);
  assert.match(save, /NtApi\.createFood\(toSave\)/);
  assert.ok(save.indexOf('const ctx = editorState.foodDiaryCtx;') < save.indexOf('const toSave'));
  assert.match(save, /addDiaryItem\(\s+\{ \.\.\.item, portion: item\.portion \|\| 100, unit: item\.unit \|\| 'g' \}/);
});
