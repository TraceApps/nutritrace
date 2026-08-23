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

// Gated on dev OR opt-in verbose mode (Settings → Diagnostics → Verbose diagnostic logging).
const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('nt:verboseLogging') === '1') console.log(...a); } catch {} };

import { isNative } from './platform.js';
import { HealthConnect } from '@devmaxime/capacitor-health-connect';

function _getPlugin() {
  if (!isNative) return null;
  return HealthConnect;
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
 * Request read/write permissions from Health Connect.
 */
export async function requestPermissions() {
  const hc = _getPlugin();
  if (!hc) return { read: [], write: [] };
  try {
    // First check if permissions are already granted (avoids triggering crash-prone dialog)
    const existing = await getGrantedPermissions();
    if (existing.read?.length > 0) return existing;

    // Request permissions via Health Connect dialog
    let result;
    try {
      result = await hc.requestPermissions({
        read: ['Steps', 'Weight', 'SleepSession', 'HeartRate', 'ExerciseSession', 'BloodPressure', 'OxygenSaturation', 'BodyFat', 'RespiratoryRate', 'FloorsClimbed', 'Hydration', 'BoneMass', 'LeanBodyMass', 'BodyTemperature', 'BasalMetabolicRate', 'Vo2Max'],
        write: [],
      });
    } catch (e) {
      console.warn('[health-connect] Permission dialog failed:', e.message);
      result = { read: [], write: [] };
    }
    // Check if permissions were actually granted (singleTask launch mode can cause
    // the permission dialog to close immediately without user interaction)
    if (result.read?.length === 0) {
      // Fallback: open Health Connect app so user can grant permissions manually
      console.warn('[health-connect] Permission dialog failed — opening Health Connect app');
      try {
        const { App: CapApp } = await import('@capacitor/app');
        // Open Health Connect's permission management for our app
        window.open('market://details?id=com.google.android.apps.healthdata', '_system');
      } catch {}
      return { read: [], write: [] };
    }
    return result;
  } catch (e) {
    console.error('[health-connect] Permission request failed:', e);
    return { read: [], write: [] };
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

/**
 * Read today's health data from Health Connect.
 * Returns an object of wellness_data-compatible metrics.
 */
export async function readTodayData() {
  const hc = _getPlugin();
  if (!hc) return {};

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  // For cumulative aggregates (Steps, Distance, calories, floors, hydration),
  // use next-midnight as the end so Health Connect fully contains any
  // day-spanning source record (Samsung Health writes one 00:00-23:59 Steps
  // record per day and updates it in place). HC's aggregate math prorates
  // a partial-overlap window by `overlap/duration`, so ending at `now` gives
  // `9878 × elapsed_fraction` at 11:47 instead of the full 9878. Extending
  // to next-midnight makes the record fully contained → 100% counted. For
  // granular writers (Google Fit, Fitbit-to-HC, phone sensors, etc.) the
  // sum is identical because no records exist with future timestamps.
  // #93 reported by traebertthomas-cpu 2026-07-11.
  const startOfNextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  // Records-only endpoint (readRecords calls). Used for sleep, exercise
  // sessions, resting HR, weight, body comp, blood pressure, etc. —
  // readRecords doesn't proration-adjust, so `now` is fine here.
  const todayEnd = now.toISOString();

  const metrics = {};

  // Steps (aggregate for full day)
  try {
    const { aggregates } = await hc.aggregateRecords({
      start: todayStart, end: startOfNextDay,
      type: 'Steps', groupBy: 'day',
    });
    _dlog(`[health-connect] Steps aggregates:`, JSON.stringify(aggregates).slice(0, 200));
    if (aggregates.length > 0) metrics.steps = aggregates[0].value;
  } catch (e) { console.warn('[health-connect] Steps error:', e.message); }

  // Distance
  try {
    const { aggregates } = await hc.aggregateRecords({
      start: todayStart, end: startOfNextDay,
      type: 'Distance', groupBy: 'day',
    });
    if (aggregates.length > 0) metrics.distance_km = +(aggregates[0].value / 1000).toFixed(2);
  } catch {}

  // Total calories burned
  try {
    const { aggregates } = await hc.aggregateRecords({
      start: todayStart, end: startOfNextDay,
      type: 'TotalCaloriesBurned', groupBy: 'day',
    });
    if (aggregates.length > 0) metrics.calories_out = Math.round(aggregates[0].value);
  } catch {}

  // Active calories
  try {
    const { aggregates } = await hc.aggregateRecords({
      start: todayStart, end: startOfNextDay,
      type: 'ActiveCaloriesBurned', groupBy: 'day',
    });
    if (aggregates.length > 0) metrics.active_calories = Math.round(aggregates[0].value);
  } catch {}

  // Heart rate (aggregate)
  try {
    const { aggregates } = await hc.aggregateRecords({
      start: todayStart, end: todayEnd,
      type: 'HeartRate', groupBy: 'day',
    });
    if (aggregates.length > 0) metrics.avg_heart_rate = Math.round(aggregates[0].value);
  } catch {}

  // Resting heart rate
  try {
    const { records } = await hc.readRecords({
      start: todayStart, end: todayEnd,
      type: 'RestingHeartRate',
    });
    if (records.length > 0) {
      // Take the most recent reading
      const latest = records[records.length - 1];
      metrics.resting_hr = latest.beatsPerMinute || latest.value;
    }
  } catch {}

  // Weight
  try {
    const { records } = await hc.readRecords({
      start: todayStart, end: todayEnd,
      type: 'Weight',
    });
    _dlog(`[health-connect] Weight: ${records.length} records`);
    if (records.length > 0) {
      const latest = records[records.length - 1];
      _dlog(`[health-connect] Weight record type: ${typeof latest}`);
      _dlog(`[health-connect] Weight record FULL:`, JSON.stringify(latest).slice(0, 500));
      _dlog(`[health-connect] Weight record keys:`, typeof latest === 'object' ? Object.keys(latest) : 'N/A');
      let wkg = 0;
      if (typeof latest === 'string') {
        // Plugin may return Kotlin toString() — parse mass value from it
        const match = latest.match(/value=([\d.]+)/);
        if (match) wkg = parseFloat(match[1]);
        _dlog(`[health-connect] Weight parsed from string: ${wkg}`);
      } else {
        // Try every possible property path the plugin might use
        wkg = latest.weight?.inKilograms ?? latest.mass?.inKilograms ?? latest.value ?? 0;
        if (typeof wkg === 'object') wkg = wkg.inKilograms ?? wkg.value ?? 0;
        _dlog(`[health-connect] Weight from object: ${wkg} (weight=${JSON.stringify(latest.weight)}, mass=${JSON.stringify(latest.mass)}, value=${latest.value})`);
      }
      if (wkg > 0) metrics.weight_kg = +wkg.toFixed(1);
      _dlog(`[health-connect] Final weight_kg: ${metrics.weight_kg}`);
    }
  } catch (e) { console.warn('[health-connect] Weight error:', e.message); }

  // Sleep session (look back 24h for last night's sleep)
  try {
    const sleepStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { records } = await hc.readRecords({
      start: sleepStart, end: todayEnd,
      type: 'SleepSession',
    });
    _dlog(`[health-connect] Sleep: ${records.length} records`);
    if (records.length > 0) {
      const sleep = records[records.length - 1]; // Most recent session
      if (sleep.startTime && sleep.endTime) {
        const durMs = new Date(sleep.endTime) - new Date(sleep.startTime);
        metrics.sleep_duration_min = Math.round(durMs / 60000);
      }
      // Parse stages if available — also derive Sleep Quality sub-metrics
      // (Fitbit Public Preview Sleep Score) from the per-stage timeline so
      // they match the server-side compute when on Google Health.
      if (sleep.stages && Array.isArray(sleep.stages)) {
        let deep = 0, rem = 0, light = 0, awake = 0;
        // Stages sorted chronologically + normalized to { type, durMin }
        const segs = [...sleep.stages]
          .map(s => {
            const durMin = s.duration ? Math.round(s.duration / 60000)
                         : (s.startTime && s.endTime ? Math.round((new Date(s.endTime) - new Date(s.startTime)) / 60000) : 0);
            const t = String(s.stage || '').toLowerCase();
            return { type: t, durMin, startTime: s.startTime || null };
          })
          .sort((a, b) => (a.startTime && b.startTime) ? new Date(a.startTime) - new Date(b.startTime) : 0);
        for (const s of segs) {
          if (s.type === 'deep')  deep += s.durMin;
          else if (s.type === 'rem')   rem += s.durMin;
          else if (s.type === 'light') light += s.durMin;
          else if (s.type === 'awake') awake += s.durMin;
        }
        if (deep)  metrics.sleep_deep_min  = deep;
        if (rem)   metrics.sleep_rem_min   = rem;
        if (light) metrics.sleep_light_min = light;
        if (awake) metrics.sleep_awake_min = awake;

        // Time to Sound Sleep — minutes until first DEEP/REM segment
        let ttss = 0;
        for (const s of segs) {
          if (s.type === 'deep' || s.type === 'rem') break;
          ttss += s.durMin;
        }
        if (segs.some(s => s.type === 'deep' || s.type === 'rem')) {
          metrics.sleep_time_to_sound_min = ttss;
        }

        // Sound Sleep — DEEP + REM + LIGHT segments <5min (brief light = "sound")
        let sound = deep + rem;
        for (const s of segs) {
          if (s.type === 'light' && s.durMin < 5) sound += s.durMin;
        }
        if (sound > 0) metrics.sleep_sound_min = sound;

        // Restlessness — sum of AWAKE segments <5min (HC doesn't expose motion
        // data; this is an approximation, same as the server's GH compute)
        // Interruptions — count of AWAKE segments ≥5min
        let restlessness = 0;
        let interruptions = 0;
        for (const s of segs) {
          if (s.type !== 'awake') continue;
          if (s.durMin < 5) restlessness += s.durMin;
          else interruptions++;
        }
        if (restlessness > 0) metrics.sleep_restlessness_min = restlessness;
        metrics.sleep_interruptions = interruptions;
      }
    }
  } catch {}

  // Exercise sessions — sum duration for the active_minutes metric.
  // The permission dialog already requests ExerciseSession (line 64 above).
  // Previously this block read 'ActivitySession' which isn't a real HC type,
  // so it silently no-op'd on every device — Samsung Health writes
  // ExerciseSession records, and workouts never reached the wellness metric
  // OR the workouts table. Reported by traebertthomas-cpu (#91) with
  // confirmation that duplaja (#89) independently hit the same gap.
  try {
    const { records } = await hc.readRecords({
      start: todayStart, end: todayEnd,
      type: 'ExerciseSession',
    });
    if (records.length > 0) {
      let totalMin = 0;
      for (const r of records) {
        if (r.startTime && r.endTime) {
          totalMin += Math.round((new Date(r.endTime) - new Date(r.startTime)) / 60000);
        }
      }
      if (totalMin > 0) metrics.active_minutes = totalMin;
    }
  } catch {}

  // Blood pressure
  try {
    const { records } = await hc.readRecords({
      start: todayStart, end: todayEnd,
      type: 'BloodPressure',
    });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      if (typeof latest === 'string') {
        const sys = latest.match(/systolic=([\d.]+)/);
        const dia = latest.match(/diastolic=([\d.]+)/);
        if (sys) metrics.blood_pressure_systolic = Math.round(parseFloat(sys[1]));
        if (dia) metrics.blood_pressure_diastolic = Math.round(parseFloat(dia[1]));
      } else {
        if (latest.systolic?.inMillimetersOfMercury) metrics.blood_pressure_systolic = Math.round(latest.systolic.inMillimetersOfMercury);
        if (latest.diastolic?.inMillimetersOfMercury) metrics.blood_pressure_diastolic = Math.round(latest.diastolic.inMillimetersOfMercury);
      }
    }
  } catch (e) { _dlog(`[health-connect] BloodPressure read failed: ${e?.message}`); }

  // Oxygen saturation (SpO2)
  try {
    const { records } = await hc.readRecords({
      start: todayStart, end: todayEnd,
      type: 'OxygenSaturation',
    });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      if (typeof latest === 'string') {
        const match = latest.match(/percentage=([\d.]+)%/);
        if (match) metrics.spo2_avg = parseFloat(match[1]);
      } else {
        metrics.spo2_avg = latest.percentage?.value || latest.percentage || latest.value;
      }
    }
  } catch (e) { _dlog(`[health-connect] OxygenSaturation read failed: ${e?.message}`); }

  // Body fat percentage
  try {
    const { records } = await hc.readRecords({
      start: todayStart, end: todayEnd,
      type: 'BodyFat',
    });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      _dlog('[health-connect] BodyFat record:', JSON.stringify(latest).slice(0, 300));
      let pct = 0;
      if (typeof latest === 'string') {
        // Plugin returns raw Kotlin toString() — parse percentage from it
        const match = latest.match(/percentage=([\d.]+)%/);
        if (match) pct = parseFloat(match[1]);
      } else {
        pct = latest.percentage?.value ?? latest.percentage ?? latest.value ?? 0;
        if (typeof pct === 'object') pct = 0;
      }
      if (pct > 0) metrics.body_fat_pct = +pct.toFixed(1);
    }
  } catch (e) { console.warn('[health-connect] BodyFat error:', e.message); }

  // Respiratory rate
  try {
    const { records } = await hc.readRecords({
      start: todayStart, end: todayEnd,
      type: 'RespiratoryRate',
    });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      metrics.respiratory_rate = +(latest.rate || latest.value || 0).toFixed(1);
    }
  } catch (e) { _dlog(`[health-connect] RespiratoryRate read failed: ${e?.message}`); }

  // Floors climbed
  try {
    const { aggregates } = await hc.aggregateRecords({
      start: todayStart, end: startOfNextDay,
      type: 'FloorsClimbed', groupBy: 'day',
    });
    if (aggregates.length > 0) metrics.floors = Math.round(aggregates[0].value);
  } catch (e) { _dlog(`[health-connect] FloorsClimbed read failed: ${e?.message}`); }

  // Hydration
  try {
    const { aggregates } = await hc.aggregateRecords({
      start: todayStart, end: startOfNextDay,
      type: 'Hydration', groupBy: 'day',
    });
    if (aggregates.length > 0) metrics.water_ml = Math.round(aggregates[0].value * 1000); // liters to ml
  } catch (e) { _dlog(`[health-connect] Hydration read failed: ${e?.message}`); }

  // Bone mass
  try {
    const { records } = await hc.readRecords({ start: todayStart, end: todayEnd, type: 'BoneMass' });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      metrics.bone_mass_kg = +(latest.mass?.inKilograms || latest.value || 0).toFixed(2);
    }
  } catch (e) { _dlog(`[health-connect] BoneMass read failed: ${e?.message}`); }

  // Lean body mass
  try {
    const { records } = await hc.readRecords({ start: todayStart, end: todayEnd, type: 'LeanBodyMass' });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      metrics.lean_mass_kg = +(latest.mass?.inKilograms || latest.value || 0).toFixed(1);
    }
  } catch (e) { _dlog(`[health-connect] LeanBodyMass read failed: ${e?.message}`); }

  // Body temperature
  try {
    const { records } = await hc.readRecords({ start: todayStart, end: todayEnd, type: 'BodyTemperature' });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      metrics.body_temperature = +(latest.temperature?.inCelsius || latest.value || 0).toFixed(1);
    }
  } catch (e) { _dlog(`[health-connect] BodyTemperature read failed: ${e?.message}`); }

  // Basal metabolic rate
  try {
    const { records } = await hc.readRecords({ start: todayStart, end: todayEnd, type: 'BasalMetabolicRate' });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      metrics.basal_metabolic_rate = Math.round(latest.basalMetabolicRate?.inKilocaloriesPerDay || latest.value || 0);
    }
  } catch (e) { _dlog(`[health-connect] BasalMetabolicRate read failed: ${e?.message}`); }

  // VO2 Max
  try {
    const { records } = await hc.readRecords({ start: todayStart, end: todayEnd, type: 'Vo2Max' });
    if (records.length > 0) {
      const latest = records[records.length - 1];
      metrics.vo2_max = +(latest.vo2MillilitersPerMinuteKilogram || latest.value || 0).toFixed(1);
    }
  } catch (e) { _dlog(`[health-connect] Vo2Max read failed: ${e?.message}`); }

  return metrics;
}

/**
 * Read a date range of health data. Returns { [date]: { metrics } }.
 */
export async function readDateRange(startDate, endDate) {
  const hc = _getPlugin();
  if (!hc) return {};

  const start = new Date(startDate + 'T00:00:00').toISOString();
  const end = new Date(endDate + 'T23:59:59').toISOString();
  const result = {};

  // Steps by day
  try {
    const { aggregates } = await hc.aggregateRecords({
      start, end, type: 'Steps', groupBy: 'day',
    });
    for (const a of aggregates) {
      const date = a.startTime.slice(0, 10);
      result[date] = result[date] || {};
      result[date].steps = a.value;
    }
  } catch {}

  // Distance by day
  try {
    const { aggregates } = await hc.aggregateRecords({
      start, end, type: 'Distance', groupBy: 'day',
    });
    for (const a of aggregates) {
      const date = a.startTime.slice(0, 10);
      result[date] = result[date] || {};
      result[date].distance_km = +(a.value / 1000).toFixed(2);
    }
  } catch {}

  // Calories by day
  try {
    const { aggregates } = await hc.aggregateRecords({
      start, end, type: 'TotalCaloriesBurned', groupBy: 'day',
    });
    for (const a of aggregates) {
      const date = a.startTime.slice(0, 10);
      result[date] = result[date] || {};
      result[date].calories_out = Math.round(a.value);
    }
  } catch {}

  // Heart rate by day
  try {
    const { aggregates } = await hc.aggregateRecords({
      start, end, type: 'HeartRate', groupBy: 'day',
    });
    for (const a of aggregates) {
      const date = a.startTime.slice(0, 10);
      result[date] = result[date] || {};
      result[date].avg_heart_rate = Math.round(a.value);
    }
  } catch {}

  return result;
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
export async function readExerciseSessions(fromIso, toIso) {
  const hc = _getPlugin();
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
 * Sync Health Connect data to local wellness_data DB.
 * Called during sync cycle when Health Connect is enabled.
 */
export async function syncHealthConnect(dateStr) {
  const metrics = await readTodayData();
  const { dbUpsertWellness, dbUpsertWorkoutLocal } = await import('./db-native.js');

  for (const [type, value] of Object.entries(metrics)) {
    if (value != null) {
      await dbUpsertWellness(dateStr, 'health_connect', type, value);
    }
  }

  // ExerciseSession → local workouts. Reads the same date window
  // readTodayData used so a manual sync captures today's exercise. The push
  // path (sync.js) will send these upstream on the next cycle; a locally-
  // authored workout has server_id=NULL until the push confirms.
  let workoutCount = 0;
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayEnd = now.toISOString();
    const sessions = await readExerciseSessions(todayStart, todayEnd);
    for (const w of sessions) {
      try {
        await dbUpsertWorkoutLocal(w);
        workoutCount++;
      } catch (e) {
        _dlog(`[health-connect] workout upsert failed for ${w.source_id}: ${e?.message}`);
      }
    }
  } catch (e) {
    _dlog(`[health-connect] ExerciseSession sync failed: ${e?.message}`);
  }

  // Snapshot derived scores (Readiness + Resilience pillars) into the same
  // local wellness_data table — mirrors what server/lib/wellness-scores.js
  // does after a Fitbit/Garmin/Google Health sync. Without this, the Wellness
  // page Resilience card stays blank in Android local-only mode.
  try {
    const { snapshotScoresLocal } = await import('./wellness-scores-local.js');
    await snapshotScoresLocal(dateStr);
  } catch (e) {
    _dlog(`[health-connect] snapshot failed: ${e?.message}`);
  }

  _dlog(`[health-connect] Synced ${Object.keys(metrics).length} metrics + ${workoutCount} workouts for ${dateStr}`);
  return metrics;
}

