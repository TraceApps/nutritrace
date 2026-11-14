/**
 * #279: wearable calories burned were synced (Garmin, Fitbit, Health
 * Connect) but Statistics had no chart for them. The kJ handling for it
 * already existed but compared an id no chart used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('Statistics charts Calories Burned from calories_out', () => {
  const s = read('../src/routes/Statistics.svelte');
  assert.match(s, /value: 'wl_calories'[^\n]*apiField: 'calories_out'/);
  assert.match(s, /metric === 'wl_calories' && \$energyUnit === 'kJ'\) raw = Math\.round/);
  assert.doesNotMatch(s, /metric === 'calories_out'/);
  assert.match(s, /m === 'wl_calories'\) return true/); // today counts as incomplete
});

test('the metric order list, Goals and Wellness know the new chart', () => {
  assert.match(read('../src/routes/settings/Statistics.svelte'), /key:'wl_calories', label:'Calories Burned'/);
  assert.match(read('../src/routes/Goals.svelte'), /calories_out:\s+'wl_calories'/);
  assert.match(read('../src/routes/Wellness.svelte'), /calories_out:\s+'wl_calories'/);
});
