/**
 * Tests for the reconciliation logic in src/lib/health-connect.js.
 * Guards against #204 regression: requestPermissions() must ask for
 * every DESIRED_READS name the user has not already granted, not
 * short-circuit as soon as `existing.read.length > 0`.
 *
 * The pure helper `computeMissingReads` is what enforces the delta.
 * We exercise it directly here (no plugin needed); the request flow
 * itself is tested indirectly through the helper because mocking
 * @devmaxime/capacitor-health-connect at import time is heavier than
 * the value it adds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESIRED_READS,
  computeMissingReads,
} from '../src/lib/health-connect.js';

// ── DESIRED_READS coverage ─────────────────────────────────────────────

test('DESIRED_READS contains every type the read code queries', () => {
  // These are the types readTodayData / readDateRange / readExerciseSessions
  // actually call hc.aggregateRecords / hc.readRecords with. If any drift
  // out of DESIRED_READS, the runtime permission for that type would
  // never be requested and syncs would silently return nothing.
  const readCode = [
    'Steps', 'Distance', 'TotalCaloriesBurned', 'ActiveCaloriesBurned',
    'HeartRate', 'RestingHeartRate', 'Weight', 'SleepSession',
    'ExerciseSession', 'BloodPressure', 'OxygenSaturation', 'BodyFat',
    'RespiratoryRate', 'FloorsClimbed', 'Hydration', 'BoneMass',
    'LeanBodyMass', 'BodyTemperature', 'BasalMetabolicRate', 'Vo2Max',
  ];
  for (const t of readCode) {
    assert.ok(DESIRED_READS.includes(t), `${t} missing from DESIRED_READS`);
  }
});

test('DESIRED_READS is frozen (guards against accidental mutation)', () => {
  assert.throws(() => { DESIRED_READS.push('BogusType'); });
});

// ── computeMissingReads: the #204 fix ─────────────────────────────────

test('computeMissingReads: fresh install returns every desired name', () => {
  const missing = computeMissingReads(DESIRED_READS, { read: [] });
  assert.deepEqual(missing, [...DESIRED_READS]);
});

test('computeMissingReads: everything granted returns empty', () => {
  const missing = computeMissingReads(DESIRED_READS, { read: [...DESIRED_READS] });
  assert.deepEqual(missing, []);
});

test('#204: some reads granted still asks for the rest', () => {
  // Reporter scenario: user granted Steps / Sleep / SpO2 only. Old code
  // returned early because existing.read.length > 0; NT never asked for
  // Heart Rate. With the fix, HeartRate (and every other ungranted
  // desired name) shows up in the missing list.
  const granted = { read: ['Steps', 'SleepSession', 'OxygenSaturation'] };
  const missing = computeMissingReads(DESIRED_READS, granted);
  assert.ok(missing.includes('HeartRate'), 'HeartRate must be in missing');
  assert.ok(missing.includes('RestingHeartRate'), 'RestingHeartRate too');
  assert.ok(!missing.includes('Steps'), 'Steps should not be re-requested');
  assert.ok(!missing.includes('SleepSession'));
  assert.ok(!missing.includes('OxygenSaturation'));
});

test('computeMissingReads: null / undefined / malformed grants blob', () => {
  // The plugin can return an empty object or throw; the getGrantedPermissions
  // wrapper returns { read: [], write: [] } on error but be defensive.
  assert.deepEqual(computeMissingReads(DESIRED_READS, null), [...DESIRED_READS]);
  assert.deepEqual(computeMissingReads(DESIRED_READS, undefined), [...DESIRED_READS]);
  assert.deepEqual(computeMissingReads(DESIRED_READS, {}), [...DESIRED_READS]);
  assert.deepEqual(computeMissingReads(DESIRED_READS, { read: null }), [...DESIRED_READS]);
  assert.deepEqual(computeMissingReads(DESIRED_READS, { read: 'nope' }), [...DESIRED_READS]);
});

test('computeMissingReads: skips duplicate desired entries', () => {
  const missing = computeMissingReads(
    ['HeartRate', 'HeartRate', 'Steps', 'HeartRate'],
    { read: ['Steps'] }
  );
  assert.deepEqual(missing, ['HeartRate']);
});

test('computeMissingReads: filters non-string desired entries', () => {
  const missing = computeMissingReads(
    ['Steps', null, undefined, '', 42, {}, 'HeartRate'],
    { read: ['Steps'] }
  );
  assert.deepEqual(missing, ['HeartRate']);
});

test('computeMissingReads: empty desired returns empty', () => {
  assert.deepEqual(computeMissingReads([], { read: ['Steps'] }), []);
  assert.deepEqual(computeMissingReads(null, { read: ['Steps'] }), []);
});

test('computeMissingReads: order preserved from desired input', () => {
  // Callers use the returned order to construct the plugin request. It
  // should not shuffle so the Health Connect system dialog keeps a
  // stable presentation order across builds.
  const missing = computeMissingReads(
    ['HeartRate', 'RestingHeartRate', 'Weight', 'Steps'],
    { read: ['Steps', 'Weight'] }
  );
  assert.deepEqual(missing, ['HeartRate', 'RestingHeartRate']);
});
