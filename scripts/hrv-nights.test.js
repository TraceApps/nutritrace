/**
 * #279: HRV from Health Connect.
 *
 * Health Connect keeps HeartRateVariabilityRmssd as single readings with a
 * time. A day's hrv_daily_rmssd is the average of the readings taken during
 * the night you woke up from that day, or, with none there, of the day's own
 * readings outside any other day's night. The cases in
 * scripts/fixtures/hrv-nights.json are shared with the Kotlin port the
 * background worker runs (HrvDerivationFixturesTest.kt is generated from
 * them) and were worked by hand.
 *
 * Then the foreground read (readDays / syncHealthConnect) against a fake
 * plugin that answers HRV the way the real one does: the record's Kotlin
 * toString(), since the plugin has no converter for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveHealthConnectHrv, localDate } from '../src/lib/sleep-sessions.js';
import { parseHrvMillis } from '../src/lib/health-connect-parsers.js';
import { readDays, syncHealthConnect, dayBounds } from '../src/lib/health-connect.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const { cases } = JSON.parse(read('./fixtures/hrv-nights.json'));

/** A fixture session as @devmaxime/capacitor-health-connect hands it to JS. */
const asPluginRecord = (s) => ({
  startTime: s.start,
  endTime: s.end,
  metadata: { id: s.id, dataOrigin: s.origin },
  stages: s.stages.map(([stage, startTime, endTime]) => ({ startTime, endTime, stage: 'SLEEP_STAGE_' + stage })),
});
const asSamples = (c) => c.samples.map(([t, v]) => ({ time: Date.parse(t), rmssd: v }));

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    assert.deepEqual(deriveHealthConnectHrv(c.sessions.map(asPluginRecord), asSamples(c), c.date, c.zone), c.expect);
    assert.deepEqual(
      deriveHealthConnectHrv([...c.sessions].reverse().map(asPluginRecord), asSamples(c).reverse(), c.date, c.zone),
      c.expect, 'records in reverse order');
  });
}

test('the fixtures cover the rule: night, fallback, other nights, overlap, rounding', () => {
  const names = cases.map(c => c.name).join('\n');
  for (const want of [/during the night/, /no sleep recorded/, /falls back/, /next night/, /nap/, /two apps/, /last minute/, /rounds up/, /nothing on the day/]) {
    assert.match(names, want);
  }
});

test('parseHrvMillis reads the plugin\'s toString() and object shapes', () => {
  const str = 'HeartRateVariabilityRmssdRecord(time=2026-11-03T02:00:00Z, zoneOffset=+01:00, heartRateVariabilityMillis=42.5, metadata=Metadata(id=abc, dataOrigin=DataOrigin(packageName=com.ouraring.oura)))';
  assert.equal(parseHrvMillis(str), 42.5);
  assert.equal(parseHrvMillis('HeartRateVariabilityRmssdRecord(time=..., heartRateVariabilityMillis=1.0E2, metadata=...)'), 100);
  assert.equal(parseHrvMillis({ heartRateVariabilityMillis: 38.2 }), 38.2);
  assert.equal(parseHrvMillis({ value: 31 }), 31);
  for (const bad of [null, undefined, '', 'heartRateVariabilityMillis=0.0', 'percentage=21.5%', {}, { heartRateVariabilityMillis: -3 }]) {
    assert.equal(parseHrvMillis(bad), null, JSON.stringify(bad));
  }
});

// ── The foreground read ─────────────────────────────────────────────────

const at = (day, h, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const iso = ms => new Date(ms).toISOString();
const hrvRec = (ms, v) => `HeartRateVariabilityRmssdRecord(time=${iso(ms)}, zoneOffset=null, heartRateVariabilityMillis=${v}, metadata=Metadata(id=h${ms}))`;
const night = (id, wakeDay, hours) => ({
  startTime: iso(at(wakeDay, 7) - hours * 3600000), endTime: iso(at(wakeDay, 7)),
  metadata: { id, dataOrigin: 'com.ouraring.oura' }, stages: [],
});

const NOW = at('2026-11-03', 11, 30);
const TODAY = localDate(NOW);
const GRANTED = ['Steps', 'SleepSession', 'HeartRateVariabilityRmssd'];

function fakeHc({ granted = GRANTED, failRead = null } = {}) {
  const calls = [];
  const records = {
    SleepSession: [night('n02', '2026-11-02', 8), night('n03', TODAY, 7)],
    HeartRateVariabilityRmssd: [
      hrvRec(at('2026-11-02', 3), 40), hrvRec(at('2026-11-02', 5), 44), // night of the 2nd
      hrvRec(at('2026-11-02', 18), 25),                                   // the 2nd, awake
      hrvRec(at('2026-11-03', 2), 50), hrvRec(at('2026-11-03', 4), 52.5), // night of the 3rd
      hrvRec(at('2026-11-01', 15), 33),                                   // the 1st: no night
    ],
  };
  return {
    calls,
    async getGrantedPermissions() { return { read: granted, write: [] }; },
    async aggregateRecords({ start, end }) {
      const out = [];
      for (let b = Date.parse(start); b < Date.parse(end); b += 86400000) out.push({ startTime: iso(b), endTime: iso(b + 86400000), value: 0 });
      return { aggregates: out };
    },
    async readRecords({ start, end, type }) {
      calls.push({ type, start, end });
      if (failRead === type) throw new Error('quota');
      if (type === 'HeartRateVariabilityRmssd' && !granted.includes(type)) {
        throw new Error(`Permission not granted for record type: ${type}`);
      }
      const s = Date.parse(start), e = Date.parse(end);
      return {
        records: (records[type] || []).filter(r => {
          const t = typeof r === 'string' ? Date.parse(r.match(/time=([^,]+)/)[1]) : Date.parse(r.endTime);
          return t >= s && t < e;
        }),
      };
    },
  };
}

test('readDays: each day gets its night\'s HRV, a day with no night its own readings', async () => {
  const hc = fakeHc();
  const { byDay, failed } = await readDays(hc, ['2026-11-01', '2026-11-02', TODAY], { now: new Date(NOW), granted: new Set(GRANTED) });
  assert.equal(failed, 0);
  assert.equal(byDay['2026-11-02'].hrv_daily_rmssd, 42, 'the night of the 2nd, not the evening reading');
  assert.equal(byDay[TODAY].hrv_daily_rmssd, 51.3, 'the night of the 3rd: 50 and 52.5');
  assert.equal(byDay['2026-11-01'].hrv_daily_rmssd, 33, 'no night: the day\'s reading');
  const hrvReads = hc.calls.filter(c => c.type === 'HeartRateVariabilityRmssd');
  assert.equal(hrvReads.length, 1, 'one read for the whole window');
  assert.equal(hrvReads[0].start, dayBounds('2026-10-31').start, 'from the evening before the first day, like sleep');
});

test('readDays: someone who declined HRV syncs as before, with no failed read', async () => {
  const granted = ['Steps', 'SleepSession'];
  const hc = fakeHc({ granted });
  const { byDay, failed } = await readDays(hc, [TODAY], { now: new Date(NOW), granted: new Set(granted) });
  assert.equal(failed, 0, 'a type left off is not a failure, so the catch-up still counts');
  assert.equal(byDay[TODAY].hrv_daily_rmssd, undefined);
  assert.equal(byDay[TODAY].sleep_duration_min, 420, 'sleep still read');
  assert.ok(!hc.calls.some(c => c.type === 'HeartRateVariabilityRmssd'), 'HRV not even asked for');
});

test('readDays: HRV without sleep allowed uses the day\'s readings', async () => {
  const granted = ['Steps', 'HeartRateVariabilityRmssd'];
  const { byDay, failed } = await readDays(fakeHc({ granted }), ['2026-11-02'], { now: new Date(NOW), granted: new Set(granted) });
  assert.equal(failed, 0);
  assert.equal(byDay['2026-11-02'].hrv_daily_rmssd, 36.3, 'all three readings of the 2nd: 40, 44, 25');
});

test('readDays: a failed sleep read stores no HRV rather than a different number', async () => {
  const { byDay, failed } = await readDays(fakeHc({ failRead: 'SleepSession' }), [TODAY], { now: new Date(NOW), granted: new Set(GRANTED) });
  assert.equal(failed, 1);
  assert.equal(byDay[TODAY].hrv_daily_rmssd, undefined);
});

test('readDays: a failed HRV read counts as failed, so the catch-up runs again', async () => {
  const { byDay, failed } = await readDays(fakeHc({ failRead: 'HeartRateVariabilityRmssd' }), [TODAY], { now: new Date(NOW), granted: new Set(GRANTED) });
  assert.equal(failed, 1);
  assert.equal(byDay[TODAY].sleep_duration_min, 420);
});

test('syncHealthConnect: the first catch-up backfills HRV as health_connect', async () => {
  const written = [];
  const meta = new Map();
  const db = {
    async dbUpsertWellness(date, source, metric, value) { written.push({ date, source, metric, value }); },
    async dbUpsertWorkoutLocal() {},
    async dbGetSyncMeta(k) { return meta.get(k) ?? null; },
    async dbSetSyncMeta(k, v) { meta.set(k, v); },
  };
  await syncHealthConnect(TODAY, { catchUp: true }, { hc: fakeHc(), db, now: new Date(NOW), snapshot: async () => {} });
  const hrv = written.filter(w => w.metric === 'hrv_daily_rmssd');
  assert.deepEqual(hrv.map(w => [w.date, w.source, w.value]).sort(), [
    ['2026-11-01', 'health_connect', 33],
    ['2026-11-02', 'health_connect', 42],
    [TODAY, 'health_connect', 51.3],
  ]);
  assert.equal(meta.get('hc_catchup_day'), TODAY, 'every read worked');
});

test('the worker reads HRV with the same rule', () => {
  const worker = read('../android/app/src/main/java/com/nutritrace/app/HealthConnectSyncWorker.kt');
  assert.match(worker, /import androidx\.health\.connect\.client\.records\.HeartRateVariabilityRmssdRecord/);
  assert.match(worker, /if \(nights != null && has\(HeartRateVariabilityRmssdRecord::class\)\) attempt\("HeartRateVariability"\)/);
  assert.match(worker, /val hrvFrom = dayStart\(days\.first\(\)\.minusDays\(1\)\)/);
  assert.match(worker, /SleepDerivation\.deriveHrv\(nights, samples, d\.toString\(\), zone\)/);
  assert.match(worker, /sleepSessions = sessions/);
});

test('syncHealthConnect: today\'s scores are worked out again on each sync, a past day\'s are not', async () => {
  const calls = [];
  const db = {
    async dbUpsertWellness() {}, async dbUpsertWorkoutLocal() {},
    async dbGetSyncMeta() { return null; }, async dbSetSyncMeta() {},
  };
  const snapshot = async (d, opts) => { calls.push([d, !!opts?.force]); };
  await syncHealthConnect(TODAY, {}, { hc: fakeHc(), db, now: new Date(NOW), snapshot });
  await syncHealthConnect('2026-11-02', {}, { hc: fakeHc(), db, now: new Date(NOW), snapshot });
  assert.deepEqual(calls, [[TODAY, true], ['2026-11-02', false]],
    'HRV for today can arrive in parts; the first score must not stay all day');
});
