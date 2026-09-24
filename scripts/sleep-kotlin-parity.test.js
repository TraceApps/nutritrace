/**
 * #236: the foreground (JS) and background (Kotlin) Health Connect sleep
 * paths must store the same numbers from the same records.
 *
 * Node cannot run the Kotlin, so parity is enforced in two halves: the JS runs
 * scripts/fixtures/sleep-sessions.json in sleep-sessions.test.js, and the
 * Kotlin runs the same fixtures in a JUnit test generated from them
 * (`./gradlew :app:testDebugUnitTest`). This test makes sure that generated
 * file has not drifted from the fixtures, and that the worker really calls
 * the shared derivation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render, OUT } from './gen-sleep-kotlin-test.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const worker = read('../android/app/src/main/java/com/nutritrace/app/HealthConnectSyncWorker.kt');
const port = read('../android/app/src/main/java/com/nutritrace/app/SleepDerivation.kt');

test('the Kotlin fixture test is generated from the current fixtures', () => {
  assert.equal(readFileSync(OUT, 'utf8'), render(),
    'fixtures changed: run `node scripts/gen-sleep-kotlin-test.mjs` and commit the result');
});

test('every fixture case reaches the Kotlin test', () => {
  const { cases } = JSON.parse(read('./fixtures/sleep-sessions.json'));
  const kt = readFileSync(OUT, 'utf8');
  for (const c of cases) assert.ok(kt.includes(JSON.stringify(c.name).replace(/\$/g, '\\$')), c.name);
});

test('the worker hands every session to SleepDerivation', () => {
  const block = worker.slice(worker.indexOf('// Sleep: every session of the night'), worker.indexOf('// Body fat (latest)'));
  assert.match(block, /val sleepFrom = day\.minusDays\(1\)\.atStartOfDay\(zone\)\.toInstant\(\)/);
  assert.match(block, /out\.putAll\(SleepDerivation\.derive\(sessions, day\.toString\(\), zone\)\)/);
  assert.match(block, /origin = r\.metadata\.dataOrigin\.packageName/);
  assert.doesNotMatch(block, /lastOrNull\(\)/, 'no more "keep the last record"');
  assert.doesNotMatch(worker, /sleep_awake_min/, 'the non-canonical awake id is gone');
});

test('the port keeps the thresholds the JS uses', () => {
  assert.match(port, /const val NIGHT_GAP_MS = 3L \* 60L \* 60L \* 1000L/);
  assert.match(port, /val fullAwakeMin = 5\.0/);
  assert.match(port, /val briefLightMax = 5\.0/);
  assert.match(port, /val ttssSettlingCap = 10\.0/);
  const walk = read('../src/lib/sleep-quality.js');
  assert.match(walk, /const FULL_AWAKE_MIN = 5;/);
  assert.match(walk, /const BRIEF_LIGHT_MAX = 5;/);
  assert.match(walk, /const TTSS_SETTLING_CAP = 10;/);
});
