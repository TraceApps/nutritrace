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
import { readFileSync } from 'node:fs';
import {
  DESIRED_READS,
  computeMissingReads,
} from '../src/lib/health-connect.js';

// ── DESIRED_READS coverage ─────────────────────────────────────────────

test('DESIRED_READS contains every type the read code queries', () => {
  // These are the types readDays / readExerciseSessions
  // actually call hc.aggregateRecords / hc.readRecords with. If any drift
  // out of DESIRED_READS, the runtime permission for that type would
  // never be requested and syncs would silently return nothing.
  // Under the plugin's names: heart rate is HeartRateSeries, workouts are
  // ActivitySession (see the record type map test below).
  const readCode = [
    'Steps', 'Distance', 'TotalCaloriesBurned', 'ActiveCaloriesBurned',
    'HeartRateSeries', 'RestingHeartRate', 'HeartRateVariabilityRmssd', 'Weight', 'SleepSession',
    'ActivitySession', 'BloodPressure', 'OxygenSaturation', 'BodyFat',
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
  assert.ok(missing.includes('HeartRateSeries'), 'heart rate must be in missing');
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

// ── #279: names the plugin knows, and HRV ─────────────────────────────

// RECORDS_TYPE_NAME_MAP in androidx.health.connect:connect-client 1.1.0
// (impl/converters/datatype/RecordsTypeNameMap.kt), the map the plugin
// looks every requested name up in, and the names getGrantedPermissions
// answers with. A name outside it makes the plugin turn down the whole
// request ("Invalid records specified").
const RECORD_TYPE_NAMES = {
  ActiveCaloriesBurned: 'READ_ACTIVE_CALORIES_BURNED', ActivitySession: 'READ_EXERCISE',
  BasalMetabolicRate: 'READ_BASAL_METABOLIC_RATE', BloodPressure: 'READ_BLOOD_PRESSURE',
  BodyFat: 'READ_BODY_FAT', BodyTemperature: 'READ_BODY_TEMPERATURE', BoneMass: 'READ_BONE_MASS',
  Distance: 'READ_DISTANCE', FloorsClimbed: 'READ_FLOORS_CLIMBED', HeartRateSeries: 'READ_HEART_RATE',
  HeartRateVariabilityRmssd: 'READ_HEART_RATE_VARIABILITY', Hydration: 'READ_HYDRATION',
  LeanBodyMass: 'READ_LEAN_BODY_MASS', OxygenSaturation: 'READ_OXYGEN_SATURATION',
  RespiratoryRate: 'READ_RESPIRATORY_RATE', RestingHeartRate: 'READ_RESTING_HEART_RATE',
  SleepSession: 'READ_SLEEP', Steps: 'READ_STEPS', TotalCaloriesBurned: 'READ_TOTAL_CALORIES_BURNED',
  Vo2Max: 'READ_VO2_MAX', Weight: 'READ_WEIGHT',
};

test('#279: every name asked for is one the plugin knows, so one request asks for all', () => {
  for (const name of DESIRED_READS) {
    assert.ok(name in RECORD_TYPE_NAMES, `${name} is not in the record type map: the plugin turns the whole request down`);
  }
  assert.ok(!DESIRED_READS.includes('HeartRate'), 'the plugin calls it HeartRateSeries');
  assert.ok(!DESIRED_READS.includes('ExerciseSession'), 'the plugin calls it ActivitySession');
});

test('#279: a phone that allowed everything has nothing missing', () => {
  // What getGrantedPermissions answers with once every type is allowed.
  const granted = { read: Object.keys(RECORD_TYPE_NAMES), write: [] };
  assert.deepEqual(computeMissingReads(DESIRED_READS, granted), []);
});

test('#279: HRV is asked for, and the manifest and rationale list declare it', () => {
  assert.ok(DESIRED_READS.includes('HeartRateVariabilityRmssd'));
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  const rationale = read('../android/app/src/main/res/values/health_permissions.xml');
  for (const name of DESIRED_READS) {
    const perm = `android.permission.health.${RECORD_TYPE_NAMES[name]}`;
    assert.ok(manifest.includes(`<uses-permission android:name="${perm}" />`), `manifest lacks ${perm}`);
    assert.ok(rationale.includes(`<item>${perm}</item>`), `health_permissions.xml lacks ${perm}`);
  }
});

test('#279: someone who allowed everything before HRV is missing only HRV', () => {
  const before = Object.keys(RECORD_TYPE_NAMES).filter(n => n !== 'HeartRateVariabilityRmssd');
  assert.deepEqual(computeMissingReads(DESIRED_READS, { read: before }), ['HeartRateVariabilityRmssd']);
});
