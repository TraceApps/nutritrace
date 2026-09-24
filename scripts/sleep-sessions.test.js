/**
 * #236: Health Connect sleep, multiple sessions per night.
 *
 * The fixtures in scripts/fixtures/sleep-sessions.json are shared with the
 * Kotlin port the background worker runs (SleepDataTest.kt is generated from
 * them), and their expected values were worked by hand, not taken from
 * either implementation. Here they run through the JS builder exactly as the
 * foreground sync feeds it: the plugin's record shape, with the plugin's
 * SLEEP_STAGE_* strings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveHealthConnectSleep, normalizeStage, NIGHT_GAP_MS } from '../src/lib/sleep-sessions.js';
import { deriveSleepQuality } from '../src/lib/sleep-quality.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const { cases } = JSON.parse(read('./fixtures/sleep-sessions.json'));

/** A fixture session as @devmaxime/capacitor-health-connect hands it to JS. */
const asPluginRecord = (s) => ({
  startTime: s.start,
  endTime: s.end,
  metadata: { id: s.id, dataOrigin: s.origin },
  stages: s.stages.map(([stage, startTime, endTime]) => ({ startTime, endTime, stage: 'SLEEP_STAGE_' + stage })),
});

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    assert.deepEqual(deriveHealthConnectSleep(c.sessions.map(asPluginRecord), c.date, c.zone), c.expect);
  });
}

test('the order Health Connect returns records in changes nothing', () => {
  const perms = (xs) => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]));
  let checked = 0;
  for (const c of cases.filter(c => c.sessions.length > 1)) {
    for (const p of perms(c.sessions)) {
      assert.deepEqual(deriveHealthConnectSleep(p.map(asPluginRecord), c.date, c.zone), c.expect, c.name);
      checked++;
    }
  }
  assert.ok(checked >= 20, `checked ${checked} orderings`);
});

test('stage names from every bridge map to one vocabulary', () => {
  for (const [raw, want] of [
    ['SLEEP_STAGE_DEEP', 'DEEP'], ['SLEEP_STAGE_REM', 'REM'], ['SLEEP_STAGE_LIGHT', 'LIGHT'],
    ['SLEEP_STAGE_AWAKE', 'AWAKE'], ['SLEEP_STAGE_AWAKE_IN_BED', 'AWAKE'],
    ['SLEEP_STAGE_OUT_OF_BED', 'OUT_OF_BED'], ['SLEEP_STAGE_SLEEPING', 'SLEEPING'], ['SLEEP_STAGE_UNKNOWN', 'UNKNOWN'],
    ['sleep_stage_deep', 'DEEP'], ['deep', 'DEEP'], ['Rem', 'REM'], ['STAGE_TYPE_LIGHT', 'LIGHT'],
    [5, 'DEEP'], [6, 'REM'], [4, 'LIGHT'], [1, 'AWAKE'], [7, 'AWAKE'], [3, 'OUT_OF_BED'], [2, 'SLEEPING'], [0, 'UNKNOWN'],
    [99, 'UNKNOWN'], [null, 'UNKNOWN'], [undefined, 'UNKNOWN'], ['', 'UNKNOWN'], ['nonsense', 'UNKNOWN'],
  ]) {
    assert.equal(normalizeStage(raw), want, `normalizeStage(${JSON.stringify(raw)})`);
  }
});

test('only canonical Wellness ids are ever written', () => {
  const wellness = read('../src/routes/Wellness.svelte');
  const canonical = new Set([...wellness.matchAll(/\{ id: '(sleep_[a-z_]+)'/g)].map(m => m[1]));
  const written = new Set(cases.flatMap(c => Object.keys(c.expect)));
  for (const id of written) assert.ok(canonical.has(id), `${id} has no Wellness card`);
  for (const old of ['sleep_awake_min', 'sleep_time_to_sound_min', 'sleep_sound_min', 'sleep_interruptions']) {
    assert.ok(!written.has(old), `${old} is a Health Connect-only name with no card`);
  }
});

test('the night gap is 3 hours', () => {
  assert.equal(NIGHT_GAP_MS, 3 * 60 * 60 * 1000);
});

test('the shared walk still reproduces the Google Health calibration nights', () => {
  // 2026-05-10 regression, from google-health.js: stages ending
  //   ... AWAKE:8m LIGHT:15m REM:1.5m LIGHT:33.5m
  // The 8-minute wake is mid-night, and Fitbit counted it as one 8-minute
  // interruption, not as the morning wake-up.
  const t0 = Date.UTC(2026, 4, 10, 0, 0);
  let t = t0;
  const seg = (type, min) => { const s = { type, startTime: new Date(t).toISOString(), endTime: new Date(t + min * 60e3).toISOString() }; t += min * 60e3; return s; };
  const night = [seg('LIGHT', 20), seg('DEEP', 45), seg('LIGHT', 60), seg('AWAKE', 8), seg('LIGHT', 15), seg('REM', 1.5), seg('LIGHT', 33.5)];
  const q = deriveSleepQuality(night);
  // The 8-minute AWAKE is also the FIRST awake block, which the walk treats
  // as settling in. Put a brief wake first so the 8 minutes is mid-night.
  t = t0;
  const night2 = [seg('LIGHT', 20), seg('AWAKE', 2), seg('DEEP', 45), seg('LIGHT', 60), seg('AWAKE', 8), seg('LIGHT', 15), seg('REM', 1.5), seg('LIGHT', 33.5)];
  const q2 = deriveSleepQuality(night2);
  assert.equal(q2.interruptionsMin, 8);
  assert.equal(q2.fullAwakenings, 1);
  assert.equal(q2.restlessnessMin, 2);
  assert.equal(q2.timeToSoundSleep, 22, 'first asleep to first DEEP');
  assert.equal(q.interruptionsMin, 0, 'as the first big wake, the same 8 minutes is settling in');
});

test('Google Health now calls the shared walk instead of its own copy', () => {
  const gh = read('../server/lib/google-health.js');
  assert.match(gh, /import \{ deriveSleepQuality \} from '\.\.\/\.\.\/src\/lib\/sleep-quality\.js';/);
  assert.match(gh, /deriveSleepQuality\(stageSegs\)/);
  assert.doesNotMatch(gh, /let lastAwakeBigIdx/, 'the inline walk is gone, so there is one copy');
});

test('the foreground sync reads the whole night and attributes it to the synced day', () => {
  const hc = read('../src/lib/health-connect.js');
  assert.match(hc, /export async function readTodayData\(dateStr\)/);
  assert.match(hc, /const metrics = await readTodayData\(dateStr\);/);
  assert.match(hc, /const sleepFrom = new Date\(now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\) - 1\)\.toISOString\(\);/);
  assert.match(hc, /deriveHealthConnectSleep\(records, dateStr \|\| localDate\(now\.getTime\(\)\)\)/);
  const sleepBlock = hc.slice(hc.indexOf('const sleepFrom'), hc.indexOf('// Exercise sessions'));
  assert.doesNotMatch(sleepBlock, /records\[records\.length - 1\]/, 'no more "keep the last record"');
});

test('the plugin patch that lets AWAKE_IN_BED through is in postinstall', () => {
  const pi = read('./postinstall.cjs');
  assert.match(pi, /7 -> "SLEEP_STAGE_AWAKE_IN_BED"/);
});
