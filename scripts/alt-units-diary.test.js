/**
 * #237 (@herver1971): editing a diary entry from a household unit ("slice")
 * to grams multiplied instead of converting. 1 slice of a 241 kcal/100 g
 * bread (slice = 54.7 g) switched to 66 g showed ~8,700 kcal, not 159.
 *
 * The foods column stores alt_units as a JSON string. /api/foods parses it,
 * but diary items are hydrated straight from the column (server and
 * Android), so the scaler got a string, found no "slice", and fell back to
 * 66 / 1. Android also stores synced diary days with the string inside them,
 * so the scaler has to accept the string whatever hydration does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scaleFactor, parseAltUnits } from '../src/lib/units.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const SLICE = [{ abbr: 'slice', grams: 54.7 }];
const breadString = { nutrition_basis: 'g', alt_units: JSON.stringify(SLICE) };
const breadArray  = { nutrition_basis: 'g', alt_units: SLICE };
const KCAL_PER_100G = 241;
const kcalFor = (factor) => (KCAL_PER_100G * 54.7 / 100) * factor; // entry logged as 1 slice

// The reporter's test, as submitted.
test('alt_units as a JSON string converts a household unit to grams', () => {
  assert.ok(Math.abs(scaleFactor(1, 'slice', 66, 'g', breadString) - 66 / 54.7) < 1e-9);
});

test("the reporter's numbers: 1 slice switched to 66 g is 159 kcal, not ~8,700", () => {
  assert.equal(Math.round(kcalFor(scaleFactor(1, 'slice', 66, 'g', breadString))), 159);
  assert.equal(Math.round(kcalFor(scaleFactor(1, 'slice', 66, 'g', breadArray))), 159);
});

test('the other direction too: grams to slices', () => {
  assert.ok(Math.abs(scaleFactor(109.4, 'g', 1, 'slice', breadString) - 54.7 / 109.4) < 1e-9);
  assert.ok(Math.abs(scaleFactor(2, 'slice', 1, 'slice', breadString) - 0.5) < 1e-9);
});

test('string and array shapes give the same answer everywhere', () => {
  let seed = 237;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const UNITS = ['g', 'kg', 'oz', 'ml', 'cup', 'tbsp', 'slice', 'cookie', 'piece', 'serving', 'SLICE'];
  for (let i = 0; i < 5000; i++) {
    const alt = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
      ({ abbr: pick(['slice', 'cookie', 'piece']), grams: Math.round(rnd() * 20000) / 100 }));
    const base = { nutrition_basis: pick(['g', 'ml']), density_g_ml: rnd() < 0.5 ? 1.03 : undefined };
    const args = [Math.round(rnd() * 5000) / 10 || 1, pick(UNITS), Math.round(rnd() * 5000) / 10 || 1, pick(UNITS)];
    const a = scaleFactor(...args, { ...base, alt_units: alt });
    const s = scaleFactor(...args, { ...base, alt_units: JSON.stringify(alt) });
    assert.ok(a === s || (Number.isNaN(a) && Number.isNaN(s)), `${JSON.stringify(args)} ${JSON.stringify(alt)}: ${a} vs ${s}`);
  }
});

test('a malformed or non-list value behaves exactly like no household units', () => {
  for (const bad of ['', 'not json', '{"abbr":"slice","grams":54.7}', 'null', '"slice"', '42', null, undefined, {}, 7]) {
    const food = { nutrition_basis: 'g', alt_units: bad };
    const none = { nutrition_basis: 'g', alt_units: null };
    const got = scaleFactor(1, 'slice', 66, 'g', food);
    const want = scaleFactor(1, 'slice', 66, 'g', none);
    assert.ok(got === want || (Number.isNaN(got) && Number.isNaN(want)), `alt_units=${JSON.stringify(bad)}`);
  }
});

test('parseAltUnits returns a list or null, never throws', () => {
  assert.deepEqual(parseAltUnits(SLICE), SLICE);
  assert.deepEqual(parseAltUnits(JSON.stringify(SLICE)), SLICE);
  assert.deepEqual(parseAltUnits('[]'), []);
  for (const v of ['', 'not json', '{}', 'null', '"x"', null, undefined, {}, 3]) assert.equal(parseAltUnits(v), null, JSON.stringify(v));
});

test('the server hands diary items the array, as /api/foods does', () => {
  const h = read('../server/lib/diary-helpers.js');
  assert.match(h, /const v = k === 'alt_units' \? _altUnitsArray\(src\[k\]\) : src\[k\];/);
  assert.match(h, /function _altUnitsArray\(v\) \{/);
  assert.doesNotMatch(h, /from '\.\.\/\.\.\/src\//, 'the server image does not ship src/lib/units.js');
});

test('Android hydration hands back the array too', () => {
  const n = read('../src/lib/db-native.js');
  assert.match(n, /import \{ parseAltUnits \} from '\.\/units\.js';/);
  assert.match(n, /const v = k === 'alt_units' \? parseAltUnits\(src\[k\]\) : src\[k\];/);
});

test('both the edit preview and the save go through the scaler with the item', () => {
  const d = read('../src/routes/Diary.svelte');
  const calls = d.match(/_unitScaleFactor\(origPortion, origUnit, newPortion, editUnit, editItem\)/g) || [];
  assert.equal(calls.length, 2, 'the live preview and the saved change');
});
