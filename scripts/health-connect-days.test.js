/**
 * Health Connect past days (#294). The sync used to read today only and
 * wrote what it read under whatever day it was given, so a night or a
 * day of steps that reached Health Connect late never reached NutriTrace,
 * and Wellness had to refuse Sync on a past day (#161).
 *
 * Here: the catch-up window (shared with the Kotlin worker through
 * fixtures/hc-catch-up.json), the per-day read against a fake plugin that
 * behaves like Health Connect (prorates a record that only partly overlaps
 * an aggregate window), and syncHealthConnect end to end against a fake
 * local database with the same "only a changed value is pending" rule as
 * dbUpsertWellness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  catchUpFrom, catchUpDue, addDays, dayList, dayBounds, recordTimeMs,
  readDays, syncHealthConnect, HC_HISTORY_DAYS,
} from '../src/lib/health-connect.js';
import { localDate } from '../src/lib/sleep-sessions.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const fx = JSON.parse(read('./fixtures/hc-catch-up.json'));

// ── Window ──────────────────────────────────────────────────────────────

for (const c of fx.from) {
  test(`catchUpFrom: ${c.name}`, () => {
    assert.equal(catchUpFrom(c.today, c.lastDay), c.expect);
  });
}
for (const c of fx.due) {
  test(`catchUpDue: ${c.name}`, () => {
    assert.equal(catchUpDue(c.lastAt, Date.parse(c.now)), c.expect);
  });
}

test('the Kotlin worker runs the same cases', () => {
  const kt = read('../android/app/src/test/java/com/nutritrace/app/HealthConnectDaysTest.kt');
  for (const c of fx.from) {
    const last = c.lastDay == null ? 'null' : `"${c.lastDay}"`;
    assert.ok(kt.includes(`from("${c.today}", ${last}, "${c.expect}")`), `missing Kotlin case: ${c.name}`);
  }
  for (const c of fx.due) {
    const last = c.lastAt == null ? 'null' : `"${c.lastAt}"`;
    assert.ok(kt.includes(`due(${last}, "${c.now}", ${c.expect})`), `missing Kotlin case: ${c.name}`);
  }
});

test('dayList and addDays walk calendar days', () => {
  assert.deepEqual(dayList('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dayList('2026-10-22', '2026-10-22').length, 1);
});

test('a day is local midnight to the next local midnight (#93)', () => {
  const { start, end } = dayBounds('2026-10-20');
  assert.equal(start, new Date(2026, 9, 20).toISOString());
  assert.equal(end, new Date(2026, 9, 21).toISOString());
});

test('recordTimeMs reads objects and the Kotlin toString() form', () => {
  assert.equal(recordTimeMs({ time: '2026-10-20T07:00:00Z' }), Date.parse('2026-10-20T07:00:00Z'));
  assert.equal(recordTimeMs('BodyFatRecord(time=2026-10-20T07:00:00.123Z, zoneOffset=+02:00, percentage=21.5%, metadata=Metadata(...))'),
    Date.parse('2026-10-20T07:00:00.123Z'));
  assert.equal(recordTimeMs('ExerciseSessionRecord(startTime=2026-10-20T07:00:00Z)'), null, 'startTime is not a point time');
  assert.equal(recordTimeMs('percentage=21.5%'), null);
});

// ── A fake Health Connect ───────────────────────────────────────────────

/** Local noon/time of a day as ms (the device zone, like the app). */
const at = (day, h, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const iso = ms => new Date(ms).toISOString();

function fakeHc(store) {
  const calls = [];
  return {
    calls,
    // The plugin's names (AndroidX's record type map): HeartRateSeries,
    // ActivitySession.
    async getGrantedPermissions() { return { read: store.granted || ['Steps', 'SleepSession', 'Weight', 'HeartRateSeries', 'ActivitySession'], write: [] }; },
    async aggregateRecords({ start, end, type }) {
      calls.push({ op: 'aggregate', type, start, end });
      if (store.failAgg === type) return { aggregates: [] }; // the plugin swallows the error
      const s = Date.parse(start), e = Date.parse(end);
      // The plugin answers in 24-hour buckets from `start`.
      const out = [];
      for (let b = s; b < e; b += 86400000) {
        const be = Math.min(b + 86400000, e);
        let v = 0;
        for (const r of store[type] || []) {
          const ov = Math.min(be, r.end) - Math.max(b, r.start);
          if (ov > 0) v += r.value * ov / (r.end - r.start); // HC prorates a partial overlap
        }
        out.push({ startTime: iso(b), endTime: iso(be), value: v });
      }
      return { aggregates: out };
    },
    async readRecords({ start, end, type }) {
      calls.push({ op: 'read', type, start, end });
      if (store.failRead === type) throw new Error('quota');
      const s = Date.parse(start), e = Date.parse(end);
      const recs = (store.records?.[type] || []).filter(r => {
        const rs = Date.parse(r.time || r.startTime), re = Date.parse(r.endTime || r.time);
        return re >= s && rs < e;
      });
      return { records: recs };
    },
  };
}

const steps = (day, value) => ({ start: at(day, 0), end: at(day, 23, 59), value }); // Samsung: one record per day
const night = (id, wakeDay, hours) => ({
  startTime: iso(at(wakeDay, 7) - hours * 3600000), endTime: iso(at(wakeDay, 7)),
  metadata: { id, dataOrigin: 'com.sec.android.app.shealth' }, stages: [],
});

const NOW = at('2026-10-22', 11, 47);
const TODAY = localDate(NOW);

function seed() {
  return {
    Steps: [steps('2026-10-18', 4000), steps('2026-10-19', 9000), steps('2026-10-20', 12000), steps(TODAY, 9878)],
    records: {
      SleepSession: [night('n19', '2026-10-19', 7), night('n20', '2026-10-20', 6.5), night('n22', TODAY, 8)],
      Weight: [
        { time: iso(at('2026-10-19', 7)), value: 80.04 },
        { time: iso(at('2026-10-19', 21)), value: 80.46 },
        { time: iso(at('2026-10-20', 7)), value: 79.9 },
      ],
      ExerciseSession: [
        { startTime: iso(at('2026-10-19', 18)), endTime: iso(at('2026-10-19', 18, 45)), exerciseType: 'RUNNING', metadata: { id: 'run19' } },
      ],
    },
  };
}

// ── The per-day read ────────────────────────────────────────────────────

test('readDays puts each day under its own date', async () => {
  const hc = fakeHc(seed());
  const { byDay, failed } = await readDays(hc, ['2026-10-18', '2026-10-19', '2026-10-20', TODAY], { now: new Date(NOW) });
  assert.equal(failed, 0);
  assert.equal(byDay['2026-10-18'].steps, 4000);
  assert.equal(byDay['2026-10-19'].steps, 9000);
  assert.equal(byDay['2026-10-20'].steps, 12000);
  assert.equal(byDay[TODAY].steps, 9878, 'whole-day window: Samsung\'s day record is not prorated at 11:47 (#93)');
  assert.equal(byDay['2026-10-19'].sleep_duration_min, 420, 'a night goes to the day you woke up');
  assert.equal(byDay['2026-10-20'].sleep_duration_min, 390);
  assert.equal(byDay[TODAY].sleep_duration_min, 480);
  assert.equal(byDay['2026-10-18'].sleep_duration_min, undefined);
  assert.equal(byDay['2026-10-19'].weight_kg, 80.5, 'the day\'s latest reading');
  assert.equal(byDay['2026-10-20'].weight_kg, 79.9);
  assert.equal(byDay['2026-10-19'].active_minutes, 45);
  assert.equal(byDay['2026-10-20'].active_minutes, undefined);
});

test('readDays: totals use midnight to the next midnight, records one read per type', async () => {
  const hc = fakeHc(seed());
  const days = dayList('2026-10-16', TODAY);
  await readDays(hc, days, { now: new Date(NOW) });
  const agg = hc.calls.filter(c => c.op === 'aggregate' && c.type === 'Steps');
  assert.equal(agg.length, days.length);
  for (const [i, d] of days.entries()) {
    assert.deepEqual([agg[i].start, agg[i].end], [dayBounds(d).start, dayBounds(d).end]);
  }
  const weightReads = hc.calls.filter(c => c.op === 'read' && c.type === 'Weight');
  assert.equal(weightReads.length, 1, 'one read for the whole window');
  assert.equal(weightReads[0].end, iso(NOW), 'records up to now');
  const sleep = hc.calls.find(c => c.type === 'SleepSession');
  assert.equal(sleep.start, dayBounds('2026-10-15').start, 'sleep opens the evening before the first day');
});

test('readDays: a past day with nothing recorded gets no 0, today keeps it', async () => {
  const s = seed();
  s.Steps = s.Steps.filter(r => r.start < at(TODAY, 0));
  const { byDay } = await readDays(fakeHc(s), ['2026-10-17', TODAY], { now: new Date(NOW) });
  assert.equal(byDay['2026-10-17'].steps, undefined, 'the plugin says 0 for no data');
  assert.equal(byDay[TODAY].steps, 0, 'today as before');
});

test('readDays: a day the clocks change on (25 hours) counts its whole total', async () => {
  // In a zone with daylight saving, 2026-11-01 is 25 hours long and the
  // plugin answers in two buckets; both are that day's.
  const s = { Steps: [steps('2026-11-01', 7000)] };
  const { byDay } = await readDays(fakeHc(s), ['2026-11-01'], { now: new Date(at('2026-11-03', 9)) });
  assert.equal(byDay['2026-11-01'].steps, 7000);
});

test('readDays: a type the user did not grant is not read and not a failure', async () => {
  const s = seed(); s.granted = ['Steps'];
  const hc = fakeHc(s);
  const { byDay, failed } = await readDays(hc, [TODAY], { now: new Date(NOW), granted: new Set(s.granted) });
  assert.equal(failed, 0);
  assert.equal(byDay[TODAY].steps, 9878);
  assert.ok(!hc.calls.some(c => c.type === 'SleepSession'));
});

// ── End to end: syncHealthConnect against a fake local database ─────────

function fakeDb() {
  const rows = new Map(); // date|metric -> { value, pending }
  const meta = new Map();
  const workouts = new Map();
  return {
    rows, meta, workouts,
    // Same rule as db-native.js dbUpsertWellness: a new row is pending, an
    // existing one only when its value changed.
    async dbUpsertWellness(date, source, metric, value) {
      const k = `${date}|${metric}`;
      const cur = rows.get(k);
      if (!cur || cur.value !== value) rows.set(k, { value, pending: true });
    },
    async dbUpsertWorkoutLocal(w) { workouts.set(w.source_id, w); },
    async dbGetSyncMeta(k) { return meta.get(k) ?? null; },
    async dbSetSyncMeta(k, v) { meta.set(k, v); },
    pending() { return [...rows].filter(([, r]) => r.pending).map(([k]) => k); },
    markSynced() { for (const r of rows.values()) r.pending = false; },
    value(date, metric) { return rows.get(`${date}|${metric}`)?.value; },
  };
}

test('syncHealthConnect: first catch-up fills the past days, each under its own date', async () => {
  const db = fakeDb();
  const hc = fakeHc(seed());
  await syncHealthConnect(TODAY, { catchUp: true }, { hc, db, now: new Date(NOW), snapshot: async () => {} });
  assert.equal(db.value('2026-10-18', 'steps'), 4000);
  assert.equal(db.value('2026-10-19', 'steps'), 9000);
  assert.equal(db.value('2026-10-19', 'sleep_duration_min'), 420);
  assert.equal(db.value('2026-10-20', 'sleep_duration_min'), 390);
  assert.equal(db.value(TODAY, 'steps'), 9878);
  assert.equal(db.value(TODAY, 'avg_heart_rate'), 0, 'heart rate is granted as HeartRateSeries and still read');
  const aggDays = hc.calls.filter(c => c.op === 'aggregate' && c.type === 'Steps').length;
  assert.equal(aggDays, HC_HISTORY_DAYS, 'the first catch-up reads 30 days');
  assert.equal(db.meta.get('hc_catchup_day'), TODAY);
  assert.equal(db.meta.get('hc_catchup_at'), iso(NOW));
});

test('syncHealthConnect: a second sync with nothing new marks nothing to send', async () => {
  const db = fakeDb();
  const deps = { hc: fakeHc(seed()), db, now: new Date(NOW), snapshot: async () => {} };
  await syncHealthConnect(TODAY, { catchUp: true }, deps);
  assert.ok(db.pending().length > 0);
  db.markSynced();
  // An hour later, a full sync catches up again (7 days): nothing changed.
  const later = { ...deps, hc: fakeHc(seed()), now: new Date(NOW + 61 * 60000) };
  await syncHealthConnect(TODAY, { catchUp: true }, later);
  assert.equal(later.hc.calls.filter(c => c.op === 'aggregate' && c.type === 'Steps').length, 7);
  assert.deepEqual(db.pending(), []);
});

test('syncHealthConnect: the 30-second sync reads today only, and a catch-up waits an hour', async () => {
  const db = fakeDb();
  db.meta.set('hc_catchup_at', iso(NOW - 10 * 60000));
  db.meta.set('hc_catchup_day', TODAY);
  const quiet = fakeHc(seed());
  await syncHealthConnect(TODAY, { catchUp: false }, { hc: quiet, db, now: new Date(NOW), snapshot: async () => {} });
  const full = fakeHc(seed());
  await syncHealthConnect(TODAY, { catchUp: true }, { hc: full, db, now: new Date(NOW), snapshot: async () => {} });
  for (const hc of [quiet, full]) {
    const days = new Set(hc.calls.filter(c => c.op === 'aggregate').map(c => c.start));
    assert.deepEqual([...days], [dayBounds(TODAY).start]);
  }
  assert.equal(db.value('2026-10-19', 'steps'), undefined);
});

test('syncHealthConnect: a later edit to a past day is picked up, and only it is sent', async () => {
  const db = fakeDb();
  const s = seed();
  await syncHealthConnect(TODAY, { catchUp: true }, { hc: fakeHc(s), db, now: new Date(NOW), snapshot: async () => {} });
  db.markSynced();
  // Another app edits the night of the 20th and adds steps on the 19th.
  s.records.SleepSession[1] = night('n20', '2026-10-20', 7.5);
  s.Steps[1] = steps('2026-10-19', 9500);
  // Seen from that day's Sync on Wellness, with no catch-up due:
  db.meta.set('hc_catchup_at', iso(NOW));
  await syncHealthConnect('2026-10-20', { catchUp: true }, { hc: fakeHc(s), db, now: new Date(NOW + 60000), snapshot: async () => {} });
  assert.equal(db.value('2026-10-20', 'sleep_duration_min'), 450);
  assert.deepEqual(db.pending(), ['2026-10-20|sleep_duration_min']);
  assert.equal(db.value(TODAY, 'sleep_duration_min'), 480, 'today keeps its own night');
  // The next catch-up picks up the 19th too.
  await syncHealthConnect(TODAY, { catchUp: true }, { hc: fakeHc(s), db, now: new Date(NOW + 62 * 60000), snapshot: async () => {} });
  assert.deepEqual(db.pending().sort(), ['2026-10-19|steps', '2026-10-20|sleep_duration_min']);
});

test('syncHealthConnect: a failed read keeps the last catch-up day, so it is tried again', async () => {
  const db = fakeDb();
  db.meta.set('hc_catchup_day', '2026-10-10');
  const s = seed(); s.failRead = 'Weight';
  await syncHealthConnect(TODAY, { catchUp: true }, { hc: fakeHc(s), db, now: new Date(NOW), snapshot: async () => {} });
  assert.equal(db.meta.get('hc_catchup_day'), '2026-10-10');
  assert.equal(db.meta.get('hc_catchup_at'), iso(NOW), 'but not again for an hour');
});

test('syncHealthConnect: scores are snapshotted for the day asked for only (their baseline ends today)', async () => {
  const db = fakeDb();
  const snapped = [];
  await syncHealthConnect(TODAY, { catchUp: true }, { hc: fakeHc(seed()), db, now: new Date(NOW), snapshot: async d => snapped.push(d) });
  await syncHealthConnect('2026-10-19', {}, { hc: fakeHc(seed()), db, now: new Date(NOW), snapshot: async d => snapped.push(d) });
  assert.deepEqual(snapped, [TODAY, '2026-10-19']);
});

test('syncHealthConnect: a total the plugin answers with no buckets is a failed read', async () => {
  const db = fakeDb();
  db.meta.set('hc_catchup_day', '2026-10-10');
  const s = seed(); s.failAgg = 'Steps';
  await syncHealthConnect(TODAY, { catchUp: true }, { hc: fakeHc(s), db, now: new Date(NOW), snapshot: async () => {} });
  assert.equal(db.meta.get('hc_catchup_day'), '2026-10-10', 'tried again from the same day');
  assert.equal(db.value('2026-10-19', 'steps'), undefined, 'nothing stored for it');
});

test('syncHealthConnect: the plugin cannot read ExerciseSession; that is not a failure', async () => {
  const db = fakeDb();
  const s = seed();
  const hc = fakeHc(s);
  const read = hc.readRecords;
  hc.readRecords = async o => { if (o.type === 'ExerciseSession') throw new Error('Unexpected RecordType: ExerciseSession'); return read(o); };
  hc.getGrantedPermissions = async () => ({ read: [] }); // unknown grants: everything is tried
  await syncHealthConnect(TODAY, { catchUp: true }, { hc, db, now: new Date(NOW), snapshot: async () => {} });
  assert.equal(db.meta.get('hc_catchup_day'), TODAY);
});

test('syncHealthConnect: two at once run one after the other, and the second finds the catch-up done', async () => {
  const db = fakeDb();
  const a = fakeHc(seed()), b = fakeHc(seed());
  await Promise.all([
    syncHealthConnect(TODAY, { catchUp: true }, { hc: a, db, now: new Date(NOW), snapshot: async () => {} }),
    syncHealthConnect(TODAY, { catchUp: true }, { hc: b, db, now: new Date(NOW), snapshot: async () => {} }),
  ]);
  const days = hc => new Set(hc.calls.filter(c => c.op === 'aggregate').map(c => c.start)).size;
  assert.equal(days(a), HC_HISTORY_DAYS);
  assert.equal(days(b), 1);
});

// ── Callers ─────────────────────────────────────────────────────────────

test('Wellness syncs the day on screen, past days included (#161 guard gone)', () => {
  const w = read('../src/routes/Wellness.svelte');
  const fn = w.slice(w.indexOf('async function syncHealthConnectManual'), w.indexOf('hcSyncing = true;', w.indexOf('async function syncHealthConnectManual')));
  assert.doesNotMatch(fn, /if \(!isToday\) return;/);
  assert.match(w, /await syncHealthConnect\(dateStr, \{ catchUp: true \}\);/);
  assert.match(w, /\{#if \$healthConnectEnabled && isNative\}\n\s*<button class="wl-sync-icon-btn"/);
});

test('full syncs catch up, the 30-second sync does not', () => {
  assert.match(read('../src/lib/sync.js'), /await syncHealthConnect\(today, \{ catchUp: !silent \}\);/);
  assert.match(read('../src/components/settings/SettingsWellness.svelte'), /await syncHealthConnect\(today, \{ catchUp: true \}\);/);
});

test('the background worker reads per day and sends only what changed', () => {
  const kt = read('../android/app/src/main/java/com/nutritrace/app/HealthConnectSyncWorker.kt');
  assert.match(kt, /HealthConnectDays\.catchUpDue\(/);
  assert.match(kt, /HealthConnectDays\.catchUpFrom\(/);
  assert.match(kt, /SleepDerivation\.derive\(sessions, d\.toString\(\), zone\)/);
  assert.match(kt, /WHERE wellness_data\.value IS NOT excluded\.value/);
  assert.match(kt, /if \(changedRows\.isEmpty\(\) && changedWorkouts\.isEmpty\(\)\)/);
  assert.match(kt, /pushToServer\(base!!, authToken, changedRows, changedWorkouts\)/);
});
