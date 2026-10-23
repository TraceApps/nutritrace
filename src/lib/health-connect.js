/**
 * health-connect.js — Android Health Connect integration.
 *
 * Reads health data from Health Connect and maps to our wellness_data format.
 * Uses @devmaxime/capacitor-health-connect plugin.
 *
 * Available data types:
 * - Steps, Distance, Calories (active + total)
 * - Heart rate (avg, min, max), Resting heart rate
 * - Sleep sessions
 *
 * Verbose Health Connect logs are gated on dev — production users don't need
 * to see every record body in the console.
 * - Weight
 * - Activity/exercise sessions
 *
 * Data is stored locally in wellness_data with source='health_connect'.
 * When connected to a server, the sync engine pushes it up.
 */

// Gated on dev OR opt-in verbose mode (Settings, Diagnostics, Verbose diagnostic logging).
// import.meta.env is Vite-only; guard so node --test (which imports this
// module for the pure-helper tests) does not crash on module init.
const _viteEnv = (() => { try { return import.meta.env; } catch { return null; } })();
const _dlog = _viteEnv && _viteEnv.DEV
  ? console.log
  : (...a) => { try { if (typeof localStorage !== 'undefined' && localStorage.getItem('nt:verboseLogging') === '1') console.log(...a); } catch {} };

import { isNative } from './platform.js';
import { HealthConnect } from '@devmaxime/capacitor-health-connect';
import {
  parseMassKg,
  parsePercent,
  parseBmrKcalPerDay,
  parseTemperatureC,
  parseRespiratoryRate,
  parseVo2Max,
} from './health-connect-parsers.js';
import { deriveHealthConnectSleep, localDate } from './sleep-sessions.js';

function _getPlugin() {
  if (!isNative) return null;
  return HealthConnect;
}

/**
 * Every read permission NutriTrace actually consumes in readDays /
 * readExerciseSessions. The requestPermissions() flow
 * reconciles this list against what's already granted so newly-added
 * types (or types the user previously denied) get re-prompted instead
 * of being silently skipped when *any* other read is already granted.
 *
 * #204 bug context: this list used to be a hardcoded literal inside
 * requestPermissions() that was missing Distance / TotalCaloriesBurned /
 * ActiveCaloriesBurned / RestingHeartRate. The read code queried them
 * anyway (line ~140 onwards), so those types silently returned nothing
 * on every device. The manifest already declares the four missing HC
 * runtime permissions.
 */
export const DESIRED_READS = Object.freeze([
  'Steps',
  'Distance',
  'TotalCaloriesBurned',
  'ActiveCaloriesBurned',
  'HeartRate',
  'RestingHeartRate',
  'Weight',
  'SleepSession',
  'ExerciseSession',
  'BloodPressure',
  'OxygenSaturation',
  'BodyFat',
  'RespiratoryRate',
  'FloorsClimbed',
  'Hydration',
  'BoneMass',
  'LeanBodyMass',
  'BodyTemperature',
  'BasalMetabolicRate',
  'Vo2Max',
]);

/**
 * Compute which desired read permissions have not yet been granted.
 * Pure function so it can be unit-tested without the plugin.
 *
 * @param {string[]} desired  Desired read permission names.
 * @param {{read?: string[]}|null|undefined} granted  Plugin grants blob.
 * @returns {string[]} The subset of desired not present in granted.read.
 */
export function computeMissingReads(desired, granted) {
  const have = new Set(Array.isArray(granted?.read) ? granted.read : []);
  const seen = new Set();
  const out = [];
  for (const name of Array.isArray(desired) ? desired : []) {
    if (!name || typeof name !== 'string') continue;
    if (have.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Check if Health Connect is available on this device.
 * Returns 'Available' | 'NotSupported' | 'NotInstalled'
 */
export async function checkAvailability() {
  const hc = _getPlugin();
  if (!hc) return 'NotSupported';
  try {
    const { availability } = await hc.checkAvailability();
    return availability;
  } catch {
    return 'NotSupported';
  }
}

/**
 * Request the read permissions in DESIRED_READS that the user has not yet
 * granted. Falls back to per-name requests when the batch call is rejected
 * (the @devmaxime plugin refuses the whole batch if any name is missing
 * from its RECORDS_TYPE_NAME_MAP), so one bad name never blocks the rest.
 *
 * Returns the authoritative grants blob as of after the dialog, not the
 * plugin's return value from requestPermissions() (which can be stale
 * relative to what the user just tapped through). #204.
 *
 * Then, with any read granted, asks for background reads too
 * (requestBackgroundRead), so the hourly sync can read with the app closed.
 */
export async function requestPermissions() {
  const granted = await _requestRecordPermissions();
  if (granted.read?.length) await requestBackgroundRead();
  return granted;
}

async function _requestRecordPermissions() {
  const hc = _getPlugin();
  if (!hc) return { read: [], write: [] };
  try {
    const existing = await getGrantedPermissions();
    const missing = computeMissingReads(DESIRED_READS, existing);
    if (missing.length === 0) return existing;

    // Try the whole missing batch first (single system dialog is nicest
    // for the user). If the plugin rejects it (usually because one of
    // the names is not in the plugin's record-type map), fall back to
    // per-name requests so the unrelated names still get requested.
    let batchOk = false;
    try {
      await hc.requestPermissions({ read: missing, write: [] });
      batchOk = true;
    } catch (e) {
      console.warn('[health-connect] Batch permission request rejected, falling back per name:', e?.message);
    }
    if (!batchOk) {
      for (const name of missing) {
        try {
          await hc.requestPermissions({ read: [name], write: [] });
        } catch (e) {
          _dlog(`[health-connect] Skipping unsupported read permission "${name}": ${e?.message}`);
        }
      }
    }

    // Re-query grants so callers see what the OS actually has now (the
    // plugin's requestPermissions return value can lag behind singleTask
    // launch-mode dialog dismissal).
    const after = await getGrantedPermissions();
    if (!after.read || after.read.length === 0) {
      // No reads at all: probably the dialog was dismissed. Push the
      // user to Health Connect so they can grant manually.
      console.warn('[health-connect] No read permissions granted after dialog, opening Health Connect');
      try {
        window.open('market://details?id=com.google.android.apps.healthdata', '_system');
      } catch {}
      return { read: [], write: [] };
    }
    return after;
  } catch (e) {
    console.error('[health-connect] Permission request failed:', e);
    return { read: [], write: [] };
  }
}

// ── Reading in the background (#294) ──────────────────────────────────
//
// Health Connect answers reads only while the app is in front unless the
// user allows reading in the background (developer.android.com, Health
// Connect, "Read data"). The hourly background sync needs it to read with
// the app closed; without it the sync reads while the app is open, as
// before. HealthBackgroundPlugin.kt asks for it, since the Capacitor
// Health Connect plugin can only ask for record types.

// A Capacitor plugin proxy answers every property, `then` included, so an
// async function must never return one: awaiting it calls then() on the
// native side and fails. It travels in an object.
let _bgPlugin = null;
async function _background() {
  if (!isNative) return null;
  if (!_bgPlugin) {
    const { registerPlugin } = await import('@capacitor/core');
    _bgPlugin = registerPlugin('HealthBackground');
  }
  return { plugin: _bgPlugin };
}

/**
 * { available, granted }: whether this phone's Health Connect can read in
 * the background, and whether the user allowed it. Both false off Android,
 * or on an app build without the native side.
 */
export async function getBackgroundReadStatus() {
  try {
    const bg = await _background();
    if (!bg) return { available: false, granted: false };
    const s = await bg.plugin.status();
    return { available: !!s?.available, granted: !!s?.granted };
  } catch {
    return { available: false, granted: false };
  }
}

/**
 * Ask for background reads with Health Connect's own screen, when the phone
 * supports it and it isn't allowed yet. Returns the status afterwards.
 */
export async function requestBackgroundRead() {
  try {
    const bg = await _background();
    if (!bg) return { available: false, granted: false };
    const s = await bg.plugin.request();
    return { available: !!s?.available, granted: !!s?.granted };
  } catch (e) {
    console.warn('[health-connect] background read request failed:', e?.message);
    return getBackgroundReadStatus();
  }
}

// ── Running the native reader now ──────────────────────────────────────
//
// The background worker (HealthConnectSyncWorker.kt) reads with the SDK and
// gets what the Capacitor plugin can't: workouts, floors and water. Without
// background access it can only read while the app is in front, so the app
// runs it once when it comes to the front and on Health Connect Sync, next
// to its own read of today. The native side runs one at a time and skips a
// run when the worker is running or read less than minAgeMs ago. When it
// finishes, 'nt:hc-worker-done' { changed } goes out on window.

let _doneListening = false;

/** Run the worker once now. Resolves { started, reason? }. */
export async function runWorkerNow({ minAgeMs = 60000 } = {}) {
  try {
    const bg = await _background();
    if (!bg) return { started: false, reason: 'unsupported' };
    if (!_doneListening) {
      _doneListening = true;
      await bg.plugin.addListener('workerDone', detail => {
        try { window.dispatchEvent(new CustomEvent('nt:hc-worker-done', { detail })); } catch {}
      });
    }
    const r = await bg.plugin.runNow({ minAgeMs });
    return { started: !!r?.started, reason: r?.reason };
  } catch (e) {
    _dlog(`[health-connect] worker run failed: ${e?.message}`);
    return { started: false, reason: 'error' };
  }
}

/**
 * Check which permissions are currently granted.
 */
export async function getGrantedPermissions() {
  const hc = _getPlugin();
  if (!hc) return { read: [], write: [] };
  try {
    return await hc.getGrantedPermissions();
  } catch {
    return { read: [], write: [] };
  }
}

// ── Which days a sync reads (#294) ──────────────────────────────────────
//
// Health Connect keeps history, and other apps write into it late: a watch
// that syncs the next morning, a night of sleep edited a day after, a
// phone that was off. A sync that only read today never saw any of it.
//
// Android's guide (developer.android.com, Health Connect, "Synchronize
// data") recommends a changes token per record type. The Capacitor plugin
// this path uses (@devmaxime/capacitor-health-connect 1.1.0) has no
// getChangesToken/getChanges, and a deleted record comes back from that
// API as an id with no date, so the day it belonged to can't be found
// without keeping every record id. The same guide's fallback for an
// expired token is to read the last 30 days again and keep what's new;
// that is what a catch-up does, over a smaller window:
//
//  - The 30-second sync reads one day: the one asked for (today).
//  - A full sync (app start, resume, Sync) also reads the last 7 days, at
//    most once an hour, and the background worker does the same.
//  - The first catch-up reads 30 days, all Health Connect lets an app read
//    from before it was given access ("Read data": "up to 30 days prior to
//    when any permission was first granted"). After the app was away for
//    longer than a week, a catch-up reads back to the last day it covered,
//    up to 30 days.
//
// Only a value that changed is marked to send (dbUpsertWellness), so
// reading a day again costs the server nothing.

/** Days of history Health Connect lets an app read without the history permission. */
export const HC_HISTORY_DAYS = 30;
/** A catch-up always reads at least this many days, today included. */
export const HC_CATCH_UP_DAYS = 7;
/** A catch-up runs at most this often. */
export const HC_CATCH_UP_EVERY_MS = 60 * 60 * 1000;

const _DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD plus n calendar days. */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, both included, oldest first. */
export function dayList(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length <= 366; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The first day a catch-up reads. The last 7 days; back to `lastDay` (the
 * day of the last finished catch-up) when that is older; never more than
 * 30 days. No catch-up yet: 30 days.
 */
export function catchUpFrom(today, lastDay) {
  const oldest = addDays(today, -(HC_HISTORY_DAYS - 1));
  const recent = addDays(today, -(HC_CATCH_UP_DAYS - 1));
  if (!_DAY_RE.test(lastDay || '')) return oldest;
  const from = lastDay < recent ? lastDay : recent;
  return from < oldest ? oldest : from;
}

/** Whether a catch-up is due, `lastAt` being when the last one ran. */
export function catchUpDue(lastAt, nowMs) {
  const t = Date.parse(lastAt || '');
  return !Number.isFinite(t) || t > nowMs || nowMs - t >= HC_CATCH_UP_EVERY_MS;
}

/**
 * One local day as instants: midnight to the next midnight. Aggregates use
 * the whole day, not "now": Health Connect prorates a record that only
 * partly overlaps the window, so Samsung Health's one 00:00-23:59 Steps
 * record per day, updated in place, counted 9878 x elapsed fraction at
 * 11:47 instead of 9878 (#93, traebertthomas-cpu). Writers with smaller
 * records give the same sum, since nothing is recorded in the future.
 */
export function dayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    start: new Date(y, m - 1, d).toISOString(),
    end: new Date(y, m - 1, d + 1).toISOString(),
  };
}

/**
 * When a point record (weight, resting heart rate, SpO2...) was taken, in
 * ms. The plugin sends Weight and RestingHeartRate as objects with `time`;
 * the other types arrive as the Kotlin toString(), "BodyFatRecord(time=
 * 2026-10-20T07:00:00Z, zoneOffset=..., percentage=...)". Null if unknown.
 */
export function recordTimeMs(rec) {
  let t = null;
  if (rec && typeof rec === 'object') t = rec.time ?? rec.startTime ?? null;
  else if (typeof rec === 'string') t = rec.match(/\btime=([0-9T:.\-]+Z)/)?.[1] ?? null;
  const ms = Date.parse(t || '');
  return Number.isFinite(ms) ? ms : null;
}

/** Runs of consecutive days, from a sorted list. */
function _runs(sorted) {
  const runs = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[last.length - 1], 1) === d) last.push(d);
    else runs.push([d]);
  }
  return runs;
}

// Daily totals. `sum`: a day that isn't 24 hours (clock change) comes back
// from the plugin as two buckets, and both belong to the day. `perm` is the
// name the plugin reports the permission under (getGrantedPermissions uses
// AndroidX's record type names, where heart rate is HeartRateSeries).
// These five are all the plugin aggregates; it answers FloorsClimbed and
// Hydration with no buckets, so the foreground sync never had them (the
// background worker reads them with the SDK).
const AGGREGATES = [
  { type: 'Steps',                perm: 'Steps',                key: 'steps',           sum: true, conv: v => v },
  { type: 'Distance',             perm: 'Distance',             key: 'distance_km',     sum: true, conv: v => +(v / 1000).toFixed(2) },
  { type: 'TotalCaloriesBurned',  perm: 'TotalCaloriesBurned',  key: 'calories_out',    sum: true, conv: v => Math.round(v) },
  { type: 'ActiveCaloriesBurned', perm: 'ActiveCaloriesBurned', key: 'active_calories', sum: true, conv: v => Math.round(v) },
  { type: 'HeartRate',            perm: 'HeartRateSeries',      key: 'avg_heart_rate',  sum: false, conv: v => Math.round(v) },
];

// The plugin can't read a type its name map doesn't have ("Unexpected
// RecordType": ExerciseSession is ActivitySession there). That read never
// worked here, so it isn't counted as a failed read.
const _unreadable = e => /Unexpected RecordType/i.test(String(e?.message || e));

function _parseWeight(latest) {
  let wkg = 0;
  if (typeof latest === 'string') {
    // Plugin may return Kotlin toString(); parse the mass value from it
    const match = latest.match(/value=([\d.]+)/);
    if (match) wkg = parseFloat(match[1]);
  } else {
    // Try every property path the plugin might use
    wkg = latest.weight?.inKilograms ?? latest.mass?.inKilograms ?? latest.value ?? 0;
    if (typeof wkg === 'object') wkg = wkg.inKilograms ?? wkg.value ?? 0;
  }
  return wkg > 0 ? { weight_kg: +wkg.toFixed(1) } : {};
}

function _parseBloodPressure(latest) {
  const out = {};
  if (typeof latest === 'string') {
    const sys = latest.match(/systolic=([\d.]+)/);
    const dia = latest.match(/diastolic=([\d.]+)/);
    if (sys) out.blood_pressure_systolic = Math.round(parseFloat(sys[1]));
    if (dia) out.blood_pressure_diastolic = Math.round(parseFloat(dia[1]));
  } else {
    if (latest.systolic?.inMillimetersOfMercury) out.blood_pressure_systolic = Math.round(latest.systolic.inMillimetersOfMercury);
    if (latest.diastolic?.inMillimetersOfMercury) out.blood_pressure_diastolic = Math.round(latest.diastolic.inMillimetersOfMercury);
  }
  return out;
}

const _one = (key, parse, digits) => rec => {
  const v = parse(rec);
  if (v == null) return {};
  return { [key]: digits == null ? Math.round(v) : +v.toFixed(digits) };
};

// The latest record of each day. #206: the shared parsers return null on a
// shape they can't read, and the key is left out rather than stored as 0.
const POINT_READS = [
  { type: 'RestingHeartRate',   parse: rec => ({ resting_hr: rec?.beatsPerMinute || rec?.value }) },
  { type: 'Weight',             parse: _parseWeight },
  { type: 'BloodPressure',      parse: _parseBloodPressure },
  { type: 'OxygenSaturation',   parse: _one('spo2_avg', parsePercent, 1) },
  { type: 'BodyFat',            parse: _one('body_fat_pct', parsePercent, 1) },
  { type: 'RespiratoryRate',    parse: _one('respiratory_rate', parseRespiratoryRate, 1) },
  { type: 'BoneMass',           parse: _one('bone_mass_kg', parseMassKg, 2) },
  // Not muscle_mass_kg: Health Connect has no muscle mass record type.
  { type: 'LeanBodyMass',       parse: _one('lean_mass_kg', parseMassKg, 1) },
  { type: 'BodyTemperature',    parse: _one('body_temperature', parseTemperatureC, 1) },
  // Watts in the string form; parseBmrKcalPerDay converts (#206).
  { type: 'BasalMetabolicRate', parse: _one('basal_metabolic_rate', parseBmrKcalPerDay, null) },
  { type: 'Vo2Max',             parse: _one('vo2_max', parseVo2Max, 1) },
];

/**
 * Read Health Connect for `days` (YYYY-MM-DD, device time zone). Returns
 * { byDay: { [day]: metrics }, failed } where `failed` counts reads that
 * threw. Each day's values belong to that day: totals over its own
 * midnight-to-midnight, the latest reading taken that day, and the night
 * you woke up from that day.
 *
 * `granted` (a Set of the plugin's permission names) skips types without
 * permission, so a type the user left off isn't a failure. The plugin
 * answers a failed total with no buckets rather than an error, so a granted
 * total that comes back without all of its buckets counts as failed. A total of 0 is kept for today,
 * as it always was; on a past day the plugin's 0 means nothing was recorded
 * (it sends 0 for "no data"), and it is left out, as the worker does.
 */
export async function readDays(hc, days, { now = new Date(), granted = null } = {}) {
  const sorted = [...new Set(days)].filter(d => _DAY_RE.test(d)).sort();
  const byDay = {};
  let failed = 0;
  if (!hc || !sorted.length) return { byDay, failed };
  for (const d of sorted) byDay[d] = {};
  const can = type => !granted || granted.has(type);
  const nowMs = now.getTime();
  const today = localDate(nowMs);

  // Totals, one window per day.
  for (const d of sorted) {
    const { start, end } = dayBounds(d);
    if (Date.parse(start) > nowMs) continue;
    // One bucket per 24 hours from midnight: two on a 25-hour day.
    const buckets = Math.ceil((Date.parse(end) - Date.parse(start)) / 86400000);
    for (const a of AGGREGATES) {
      if (!can(a.perm)) continue;
      try {
        const { aggregates } = await hc.aggregateRecords({ start, end, type: a.type, groupBy: 'day' });
        if (!aggregates || aggregates.length < buckets) {
          failed++;
          _dlog(`[health-connect] ${a.type} total for ${d} came back incomplete`);
          continue;
        }
        const raw = a.sum
          ? aggregates.reduce((t, x) => t + (Number(x.value) || 0), 0)
          : Number(aggregates[0].value);
        if (!Number.isFinite(raw)) continue;
        const v = a.conv(raw);
        if (v === 0 && d !== today) continue;
        byDay[d][a.key] = v;
        if (a.type === 'Steps') _dlog(`[health-connect] ${d} Steps aggregates:`, JSON.stringify(aggregates).slice(0, 200));
      } catch (e) {
        failed++;
        _dlog(`[health-connect] ${a.type} aggregate failed for ${d}: ${e?.message}`);
      }
    }
  }

  // Records: one read per type for each run of consecutive days.
  for (const run of _runs(sorted)) {
    const start = dayBounds(run[0]).start;
    const runEnd = dayBounds(run[run.length - 1]).end;
    if (Date.parse(start) > nowMs) continue;
    const end = Date.parse(runEnd) < nowMs ? runEnd : now.toISOString();
    const inRun = new Set(run);

    for (const p of POINT_READS) {
      if (!can(p.type)) continue;
      try {
        const { records } = await hc.readRecords({ start, end, type: p.type });
        const latest = {};
        (records || []).forEach(rec => {
          const ms = recordTimeMs(rec);
          // A record with no readable time can only be placed when one day
          // was read; the last one returned wins, as it always did.
          const day = ms != null ? localDate(ms) : (run.length === 1 ? run[0] : null);
          if (!day || !inRun.has(day)) return;
          const prev = latest[day];
          if (!prev || (ms ?? -Infinity) >= (prev.ms ?? -Infinity)) latest[day] = { rec, ms };
        });
        for (const [day, { rec }] of Object.entries(latest)) {
          for (const [k, v] of Object.entries(p.parse(rec) || {})) {
            if (v != null && v !== '' && Number.isFinite(Number(v))) byDay[day][k] = Number(v);
          }
        }
      } catch (e) {
        if (!_unreadable(e)) failed++;
        _dlog(`[health-connect] ${p.type} read failed: ${e?.message}`);
      }
    }

    // Sleep: every session of each night, not just the last one (#236). A
    // night can be several records (Samsung Health splits it wherever you
    // woke), and more than one app can write the same night.
    // deriveHealthConnectSleep picks the night that ended on the day, removes
    // overlap, and writes the canonical Wellness ids. The background worker
    // runs a Kotlin port of the same code, so both paths store the same
    // numbers. The read opens at midnight the day before the first day, so
    // a night that began that evening is read whole.
    if (can('SleepSession')) {
      try {
        const sleepFrom = dayBounds(addDays(run[0], -1)).start;
        const { records } = await hc.readRecords({ start: sleepFrom, end, type: 'SleepSession' });
        for (const day of run) Object.assign(byDay[day], deriveHealthConnectSleep(records || [], day));
        _dlog(`[health-connect] Sleep: ${records?.length || 0} records for ${run[0]}..${run[run.length - 1]}`);
      } catch (e) {
        failed++;
        console.warn('[health-connect] Sleep error:', e?.message);
      }
    }

    // Exercise sessions: their minutes, by the day each one started, go to
    // active_minutes. The same sessions become workouts in syncHealthConnect.
    if (can('ExerciseSession')) {
      try {
        const { records } = await hc.readRecords({ start, end, type: 'ExerciseSession' });
        const mins = {};
        for (const r of records || []) {
          const s = Date.parse(r?.startTime || ''), e = Date.parse(r?.endTime || '');
          if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
          const day = localDate(s);
          if (!inRun.has(day)) continue;
          mins[day] = (mins[day] || 0) + Math.round((e - s) / 60000);
        }
        for (const [day, m] of Object.entries(mins)) if (m > 0) byDay[day].active_minutes = m;
      } catch (e) {
        if (!_unreadable(e)) failed++;
        _dlog(`[health-connect] ExerciseSession read failed: ${e?.message}`);
      }
    }
  }

  return { byDay, failed };
}

/**
 * Read Health Connect ExerciseSession records for a date range and map each
 * one to a workout row compatible with the local `workouts` table.
 *
 * Per-session calories are derived by aggregating TotalCaloriesBurned over
 * the session's time range — ExerciseSessionRecord itself doesn't carry an
 * energy field (Health Connect models energy as separate CaloriesBurned
 * records with their own time ranges). TotalCaloriesBurned works on Samsung
 * devices where ActiveCaloriesBurned aggregates to 0 (#91 observation).
 *
 * source_id = metadata.id (stable HC UUID from the plugin). Falls back to
 * a composite key if metadata.id is empty (defensive; the plugin sets it in
 * practice).
 */
export async function readExerciseSessions(fromIso, toIso, hc = _getPlugin()) {
  if (!hc) return [];

  let sessions = [];
  try {
    const { records } = await hc.readRecords({
      start: fromIso, end: toIso, type: 'ExerciseSession',
    });
    sessions = records || [];
  } catch (e) {
    _dlog(`[health-connect] ExerciseSession read failed: ${e?.message}`);
    return [];
  }

  const workouts = [];
  for (const s of sessions) {
    if (!s.startTime || !s.endTime) continue;

    // Prefer the plugin's metadata.id (stable HC UUID); fall back to a
    // composite key if absent so repeated reads still dedupe correctly.
    const stableId = s.metadata?.id
      || `${s.startTime}|${s.endTime}|${s.exerciseTypeId ?? s.exerciseType ?? 'unknown'}`;

    // Per-session calories. aggregateRecords time-prorates day-spanning
    // records (Samsung Health writes one 00:00-23:59 TotalCaloriesBurned
    // record per day), so a 45-min session would receive its proportional
    // slice of the daily total, which is not the actual session burn.
    // Use readRecords + a duration filter instead: drop any record whose
    // span is >4x the session or >6h (day-blob records) and sum the rest.
    // If nothing granular exists, return null and let the server fall back
    // to its METs estimate rather than log a wrong number. #93.
    let calories = null;
    try {
      const sessionMs = new Date(s.endTime).getTime() - new Date(s.startTime).getTime();
      const maxRecordMs = Math.min(sessionMs * 4, 6 * 60 * 60 * 1000);
      const { records } = await hc.readRecords({
        start: s.startTime, end: s.endTime, type: 'TotalCaloriesBurned',
      });
      const granular = (records || []).filter(r => {
        const dur = new Date(r.endTime).getTime() - new Date(r.startTime).getTime();
        return dur > 0 && dur <= maxRecordMs;
      });
      if (granular.length) {
        const sumKcal = granular.reduce((acc, r) => {
          const kcal = r.energy?.inKilocalories
            ?? (r.energy?.inCalories != null ? r.energy.inCalories / 1000 : null)
            ?? r.energyKcal
            ?? 0;
          return acc + kcal;
        }, 0);
        if (sumKcal > 0) calories = Math.round(sumKcal);
      }
    } catch {}

    // Local calendar date for the session — start with the zone offset the
    // record carries; fall back to a UTC-instant + local-zone conversion.
    // Mirrors the ladder google-health.js uses server-side.
    let localDate = null;
    const startTimeStr = String(s.startTime || '');
    const m = startTimeStr.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (m && m[2] && m[2] !== 'Z') {
      localDate = m[1]; // wall-clock local date from the offset
    } else {
      try {
        localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          .format(new Date(s.startTime));
      } catch {
        // Last resort: substring the ISO string
        localDate = startTimeStr.slice(0, 10) || null;
      }
    }
    if (!localDate) continue;

    const durationMs = Math.max(0, new Date(s.endTime) - new Date(s.startTime));

    workouts.push({
      source: 'health_connect',
      source_id: String(stableId),
      date: localDate,
      activity_type: s.exerciseType || (s.exerciseTypeId != null ? String(s.exerciseTypeId) : null),
      activity_name: s.title || s.exerciseType || 'Exercise',
      start_time: s.startTime,
      duration_ms: durationMs,
      distance_km: null,      // ExerciseRoute not exposed by the plugin's converter today
      calories,
      avg_hr: null,           // populate from separate HR record if a future PR wants it
      max_hr: null,
      steps: null,
      has_gps: 0,
    });
  }
  return workouts;
}

/**
 * Read Health Connect into the local wellness_data table, each day's values
 * under that day (#294). Reads `dateStr` (the day the caller shows, today
 * by default) and, with `catchUp` and when one is due, the catch-up window
 * (see catchUpFrom). Only values that changed are marked to send.
 * Returns the metrics read for `dateStr`.
 *
 * `deps` is for tests: { hc, db, now, snapshot }.
 *
 * One at a time: opening the app runs a sync while Wellness may start its
 * own, and the second then finds the catch-up done instead of reading the
 * same days again.
 */
let _hcQueue = Promise.resolve();
export function syncHealthConnect(dateStr, opts = {}, deps = null) {
  const run = _hcQueue.then(() => _syncHealthConnect(dateStr, opts, deps));
  _hcQueue = run.catch(() => {});
  return run;
}

async function _syncHealthConnect(dateStr, { catchUp = false } = {}, deps = null) {
  const hc = deps ? deps.hc : _getPlugin();
  if (!hc) return {};
  const db = deps?.db ?? await import('./db-native.js');
  const now = deps?.now ?? new Date();
  const today = localDate(now.getTime());
  const day = _DAY_RE.test(dateStr || '') ? dateStr : today;

  const days = new Set([day]);
  let caughtUp = false;
  if (catchUp) {
    let lastAt = null, lastDay = null;
    try {
      lastAt = await db.dbGetSyncMeta('hc_catchup_at');
      lastDay = await db.dbGetSyncMeta('hc_catchup_day');
    } catch {}
    if (catchUpDue(lastAt, now.getTime())) {
      for (const d of dayList(catchUpFrom(today, lastDay), today)) days.add(d);
      caughtUp = true;
    }
  }

  // Only types the user granted: one left off isn't a failed read. An empty
  // answer (the plugin failed to say) reads everything, as before.
  let granted = null;
  try {
    const g = await hc.getGrantedPermissions();
    if (Array.isArray(g?.read) && g.read.length) granted = new Set(g.read);
  } catch {}

  const { byDay, failed } = await readDays(hc, [...days], { now, granted });
  const daysWithValues = [];
  for (const [d, metrics] of Object.entries(byDay)) {
    let n = 0;
    for (const [type, value] of Object.entries(metrics)) {
      if (value != null) { await db.dbUpsertWellness(d, 'health_connect', type, value); n++; }
    }
    if (n) daysWithValues.push(d);
  }

  // ExerciseSession -> local workouts, over the same days. Keyed by the
  // Health Connect record id (dbUpsertWorkoutLocal), so a session read again
  // updates its row instead of adding one. The push path (sync.js) sends a
  // workout up until the server confirms it (server_id).
  let workoutCount = 0;
  if (!granted || granted.has('ExerciseSession')) {
    for (const run of _runs([...days].sort())) {
      const start = dayBounds(run[0]).start;
      const runEnd = dayBounds(run[run.length - 1]).end;
      if (Date.parse(start) > now.getTime()) continue;
      const end = Date.parse(runEnd) < now.getTime() ? runEnd : now.toISOString();
      const inRun = new Set(run);
      const sessions = await readExerciseSessions(start, end, hc);
      for (const w of sessions) {
        if (!inRun.has(w.date)) continue;
        try {
          await db.dbUpsertWorkoutLocal(w);
          workoutCount++;
        } catch (e) {
          _dlog(`[health-connect] workout upsert failed for ${w.source_id}: ${e?.message}`);
        }
      }
    }
  }

  // Snapshot derived scores (Readiness + Resilience pillars) into the same
  // local wellness_data table, as server/lib/wellness-scores.js does after a
  // Fitbit/Garmin/Google Health sync. Without this, the Wellness page
  // Resilience card stays blank in Android local-only mode. For the day
  // asked for only, as before: its baseline is the 30 days before today, so
  // it would be wrong for a day caught up in the past.
  try {
    const snapshot = deps?.snapshot ?? (await import('./wellness-scores-local.js')).snapshotScoresLocal;
    await snapshot(day);
  } catch (e) {
    _dlog(`[health-connect] snapshot failed: ${e?.message}`);
  }

  // The window is stamped when it was read, so the next one is an hour
  // away; its last day only when every read worked, so a failed read is
  // tried again from the same day.
  if (caughtUp) {
    try {
      await db.dbSetSyncMeta('hc_catchup_at', now.toISOString());
      if (!failed) await db.dbSetSyncMeta('hc_catchup_day', today);
    } catch {}
  }

  _dlog(`[health-connect] Synced ${days.size} day(s) for ${day}: ${daysWithValues.length} with values, ${workoutCount} workouts, ${failed} failed reads`);
  return byDay[day] || {};
}
