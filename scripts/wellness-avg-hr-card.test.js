/**
 * Test for #205 fix: avg_heart_rate must have an ALL_METRICS entry in
 * the 'heart' group so a Wellness card renders when the local DB has
 * a positive avg_heart_rate observation.
 *
 * ALL_METRICS is defined inline inside src/routes/Wellness.svelte
 * rather than exported from a lib file, so this test scrapes the raw
 * source instead of importing. It's a light guard against future
 * cleanups accidentally dropping the entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const wellness = readFileSync(
  path.resolve(process.cwd(), 'src/routes/Wellness.svelte'),
  'utf8'
);

test('#205: ALL_METRICS registers an avg_heart_rate entry', () => {
  // Find the specific ALL_METRICS entry for avg_heart_rate. Look for
  // an id: 'avg_heart_rate' object literal in the heart group.
  const entryRegex = /\{\s*id:\s*['"]avg_heart_rate['"][^}]*group:\s*['"]heart['"][^}]*\}/;
  assert.ok(entryRegex.test(wellness),
    'avg_heart_rate must have an ALL_METRICS entry in the heart group');
});

test('#205: avg_heart_rate card is distinct from resting_hr', () => {
  // Both entries must exist as separate lines. Reporter explicitly
  // asked they remain distinct (Avg HR is any-time average, Resting
  // HR is fully-at-rest).
  const rhrRegex = /id:\s*['"]resting_hr['"]/;
  const avgRegex = /id:\s*['"]avg_heart_rate['"]/;
  assert.ok(rhrRegex.test(wellness), 'resting_hr must still be present');
  assert.ok(avgRegex.test(wellness), 'avg_heart_rate must be present');
});

test('#205: avg_heart_rate declares a source so isSourceEnabled can gate it', () => {
  // Without a `sources: [...]` array the card would be permanently
  // hidden by isSourceEnabled. Reporter wants it visible under the
  // Fitbit family (which Health Connect flows through) and Garmin.
  const block = wellness.match(/\{\s*id:\s*['"]avg_heart_rate['"][^}]*\}/);
  assert.ok(block, 'avg_heart_rate entry not found');
  assert.match(block[0], /sources:\s*\[[^\]]*['"]fitbit['"]/,
    'avg_heart_rate must include the fitbit source (covers Health Connect)');
});
