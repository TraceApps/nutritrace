/**
 * wellness-scores-local.js — client-side mirror of server/lib/wellness-scores.js.
 *
 * Computes readiness + Resilience (Optimal / Balanced / Low) from the local
 * wellness_data table so Android local-only mode (Health Connect) gets the
 * same score cards as server-connected users. Same 30-day baseline, same
 * pillar weights and thresholds as the server lib — port not a fork, so
 * numbers match when the same inputs are available.
 *
 * Called from syncHealthConnect() after HC metrics are written into the
 * local wellness_data table.
 */

import { getDb, LOCAL_USER_ID, dbUpsertWellness } from './db-native.js';

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

export async function snapshotScoresLocal(dateStr, { force = false } = {}) {
  const db = await getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Skip if already snapshotted (unless forced)
  if (!force) {
    const r = await db.query(
      `SELECT metric_type FROM wellness_data
        WHERE user_id = ? AND date = ?
          AND metric_type IN ('readiness_score', 'resilience_category')`,
      [LOCAL_USER_ID, dateStr]
    );
    const types = new Set((r?.values || []).map(x => x.metric_type));
    if (types.has('readiness_score') && types.has('resilience_category')) return;
  }

  // 30-day history (all sources, garmin > others priority for duplicates)
  const histRes = await db.query(
    `SELECT date, metric_type, value, source FROM wellness_data
     WHERE user_id = ? AND date >= date(?, '-30 days') AND date < ?
     ORDER BY date`,
    [LOCAL_USER_ID, today, today]
  );
  const byDate = {};
  for (const row of (histRes?.values || [])) {
    byDate[row.date] ??= {};
    if (byDate[row.date][row.metric_type] == null || row.source === 'garmin') {
      byDate[row.date][row.metric_type] = row.value;
    }
  }
  const days = Object.values(byDate);

  // Current date's metrics
  const dayRes = await db.query(
    `SELECT metric_type, value, source FROM wellness_data WHERE user_id = ? AND date = ?`,
    [LOCAL_USER_ID, dateStr]
  );
  const dayData = {};
  for (const r of (dayRes?.values || [])) {
    if (dayData[r.metric_type] == null || r.source === 'garmin') {
      dayData[r.metric_type] = r.value;
    }
  }

  const todayHrv   = dayData.hrv_daily_rmssd;
  const todayRhr   = dayData.resting_hr;
  const todaySleep = dayData.sleep_score;
  const todayCal   = dayData.calories_out;

  if (todayHrv == null) return; // no HRV → no Resilience compute

  const histHrv = days.map(d => d.hrv_daily_rmssd).filter(v => v != null);
  if (histHrv.length < 2) return;

  const hrvBaseline = _mean(histHrv);
  const rhrVals    = [...days.map(d => d.resting_hr).filter(v => v != null), ...(todayRhr != null ? [todayRhr] : [])];
  const rhrBaseline = rhrVals.length >= 3 ? _mean(rhrVals) : null;

  // ── Readiness ──────────────────────────────────────────────────────────
  const hrvRatio = todayHrv / hrvBaseline;
  let hrv_score = hrvRatio >= 1.0
    ? 65 + Math.pow(hrvRatio - 1.0, 0.7) * 80
    : 65 - Math.sqrt(1.0 - hrvRatio) * 55;
  hrv_score = _clamp(hrv_score, 0, 100);

  let rhr_score = 59;
  if (rhrBaseline != null && todayRhr != null) {
    rhr_score = 59 + (rhrBaseline / todayRhr - 1.0) * 110;
    rhr_score = _clamp(rhr_score, 0, 100);
  }

  const sleepBase = todaySleep != null ? todaySleep : 75;
  const sleep_cap = (todaySleep != null && todaySleep < 50) ? 65 : 100;

  const calHistory7 = days.slice(-7).map(d => d.calories_out).filter(v => v != null);
  let activity_penalty = 0;
  if (calHistory7.length >= 3 && todayCal != null) {
    const calMean = _mean(calHistory7);
    const spikeRatio = todayCal / calMean;
    if (spikeRatio > 1.25) activity_penalty += (spikeRatio - 1.25) * 40;
    const daysAbove = days.slice(-3).filter(d => d.calories_out != null && d.calories_out > calMean * 1.1).length;
    activity_penalty += daysAbove * 3;
    activity_penalty = _clamp(activity_penalty, 0, 20);
  }

  let interaction_penalty = 0;
  if (hrvRatio < 1.0 && rhrBaseline != null && todayRhr != null && todayRhr > rhrBaseline) {
    interaction_penalty = (1.0 - hrvRatio) * (todayRhr - rhrBaseline) * 35;
    interaction_penalty = _clamp(interaction_penalty, 0, 10);
  }

  let readiness = (0.75 * hrv_score) + (0.05 * rhr_score) + (0.12 * sleepBase) + 4 - activity_penalty - interaction_penalty;
  readiness = Math.min(_clamp(Math.round(readiness), 1, 100), sleep_cap);

  // ── Resilience (3 pillars: Physical Calmness 30 + Activity Balance 40 + Sleep Patterns 30) ──
  let calmness = 21;
  if (hrvRatio != null) calmness = 21 + (hrvRatio - 1.0) * 45;
  if (rhrBaseline != null && todayRhr != null) {
    calmness += _clamp((rhrBaseline - todayRhr) * 0.5, -5, 5);
  }
  calmness = _clamp(Math.round(calmness), 0, 30);

  // Activity Balance — ACWR (acute 7-day / chronic 28-day) load ratio
  const _load = d => (d.steps || 0) + (d.active_minutes || 0) * 100;
  const acuteDays   = days.slice(-7).filter(d => d.steps != null || d.active_minutes != null);
  const chronicDays = days.slice(-28).filter(d => d.steps != null || d.active_minutes != null);

  let activity;
  if (acuteDays.length >= 5 && chronicDays.length >= 14) {
    const acuteLoad   = _mean(acuteDays.map(_load));
    const chronicLoad = _mean(chronicDays.map(_load));
    const acwr = chronicLoad > 0 ? _clamp(acuteLoad / chronicLoad, 0.3, 2.5) : 1.0;
    if      (acwr <  0.5) activity = 15;
    else if (acwr <  0.8) activity = 38;
    else if (acwr <= 1.3) activity = 40;
    else if (acwr <= 1.5) activity = 32;
    else if (acwr <= 2.0) activity = 20;
    else                   activity = 8;
  } else {
    const yesterday = days.length > 0 ? days[days.length - 1] : null;
    const yLoad = yesterday ? _load(yesterday) : null;
    if (yLoad != null) {
      const ratio = yLoad / (8000 + 30 * 100); // ≈ 11000 default goals
      if      (ratio < 0.3) activity = 25;
      else if (ratio < 0.7) activity = 35;
      else if (ratio <= 1.3) activity = 40;
      else if (ratio <= 1.7) activity = 30;
      else                    activity = 18;
    } else {
      activity = 20;
    }
  }
  activity = _clamp(Math.round(activity), 0, 40);

  // Sleep Patterns — last night's sleep score + 7-day reservoir
  let sleepPattern = todaySleep != null ? todaySleep * 0.30 : 21;
  const sgRow = await db.query(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'sleepGoalMin'`, [LOCAL_USER_ID]);
  const sgRaw = (sgRow?.values || [])[0]?.value;
  const sleepGoalMin = sgRaw ? (parseInt(JSON.parse(sgRaw) || sgRaw, 10) || 480) : 480;
  const sleepDur7 = days.slice(-7).map(d => d.sleep_duration_min).filter(v => v != null);
  if (sleepDur7.length >= 3 && sleepGoalMin > 0) {
    const avgDur = _mean(sleepDur7);
    sleepPattern += _clamp((avgDur / sleepGoalMin - 1.0) * 25, -5, 5);
  }
  sleepPattern = _clamp(Math.round(sleepPattern), 0, 30);

  const resilienceRaw      = calmness + activity + sleepPattern;
  const resilienceCategory = resilienceRaw >= 82 ? 'Optimal' : resilienceRaw >= 70 ? 'Balanced' : 'Low';
  const categoryNum        = resilienceCategory === 'Optimal' ? 3 : resilienceCategory === 'Balanced' ? 2 : 1;

  // Write back as source='health_connect' so the values join the same data
  // stream the Wellness page already reads.
  await dbUpsertWellness(dateStr, 'health_connect', 'readiness_score',     readiness);
  await dbUpsertWellness(dateStr, 'health_connect', 'resilience_score',    resilienceRaw);
  await dbUpsertWellness(dateStr, 'health_connect', 'resilience_category', categoryNum);
  await dbUpsertWellness(dateStr, 'health_connect', 'resilience_calmness', calmness);
  await dbUpsertWellness(dateStr, 'health_connect', 'resilience_activity', activity);
  await dbUpsertWellness(dateStr, 'health_connect', 'resilience_sleep',    sleepPattern);
}
