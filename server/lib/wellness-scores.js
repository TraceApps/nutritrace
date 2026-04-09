/**
 * wellness-scores.js — Server-side readiness & stress score snapshot.
 *
 * Called during Fitbit/Garmin sync to lock in today's scores.
 * Uses a fixed 30-day-from-today baseline matching the client-side Wellness.svelte formulas.
 * Only called for today's date — past days keep their already-stored scores.
 */
import db from '../db.js';
import { logger } from '../logger.js';

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

export function snapshotScores(userId, dateStr, { force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  // Skip if scores already exist for this date (unless force recalculating)
  if (!force) {
    const existing = db.prepare(
      `SELECT value FROM wellness_data WHERE user_id = ? AND date = ? AND source = 'fitbit' AND metric_type = 'readiness_score'`
    ).get(userId, dateStr);
    if (existing) {
      logger.debug(`[wellness] ${dateStr} snapshot skipped — already stored (readiness=${existing.value})`);
      return;
    }
  }

  // Load 30-day history from today — ALL sources (fitbit + garmin merged)
  const history = db.prepare(
    `SELECT date, metric_type, value, source FROM wellness_data
     WHERE user_id = ? AND date >= date(?, '-30 days') AND date < ?
     ORDER BY date`
  ).all(userId, today, today);

  // Group by date, merging sources (garmin priority, then fitbit)
  const byDate = {};
  for (const row of history) {
    byDate[row.date] ??= {};
    // Garmin overwrites fitbit for same metric (garmin is device-measured)
    if (byDate[row.date][row.metric_type] == null || row.source === 'garmin') {
      byDate[row.date][row.metric_type] = row.value;
    }
  }
  const days = Object.values(byDate);

  // Current date's values (merged across all sources)
  const dateRows = db.prepare(
    `SELECT metric_type, value, source FROM wellness_data WHERE user_id = ? AND date = ?`
  ).all(userId, dateStr);
  const dayData = {};
  for (const r of dateRows) {
    if (dayData[r.metric_type] == null || r.source === 'garmin') {
      dayData[r.metric_type] = r.value;
    }
  }

  const todayHrv = dayData.hrv_daily_rmssd;
  const todayRhr = dayData.resting_hr;
  const todaySleep = dayData.sleep_score;
  const todayCal = dayData.calories_out;

  if (todayHrv == null) return;

  const histHrv = days.map(d => d.hrv_daily_rmssd).filter(v => v != null);
  if (histHrv.length < 2) return;

  const hrvBaseline = _mean(histHrv);
  const rhrVals = [...days.map(d => d.resting_hr).filter(v => v != null), ...(todayRhr != null ? [todayRhr] : [])];
  const rhrBaseline = rhrVals.length >= 3 ? _mean(rhrVals) : null;

  // ── Readiness ─────────────────────────────────────────────────
  const hrvRatio = todayHrv / hrvBaseline;
  let hrv_score = hrvRatio >= 1.0 ? 65 + (hrvRatio - 1.0) * 100 : 65 - Math.sqrt(1.0 - hrvRatio) * 55;
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

  let readiness = (0.58 * hrv_score) + (0.22 * rhr_score) + (0.12 * sleepBase) - activity_penalty - interaction_penalty;
  readiness = Math.min(_clamp(Math.round(readiness), 1, 100), sleep_cap);

  // ── Stress ────────────────────────────────────────────────────
  function _rawStress(hrv, rhr, sleep) {
    const r = hrv / hrvBaseline;
    let h_s = 75 + (r - 1.0) * 120;
    h_s = _clamp(h_s, 0, 100);
    let r_s = 75;
    if (rhrBaseline != null && rhr != null) {
      r_s = 75 + (rhrBaseline / rhr - 1.0) * 80;
      r_s = _clamp(r_s, 0, 100);
    }
    const sl = sleep != null ? sleep : 75;
    return (0.35 * h_s) + (0.40 * sl) + (0.15 * r_s) + 4;
  }

  const todayRaw = _rawStress(todayHrv, todayRhr, todaySleep);
  const histStress = days.map(d => {
    if (d.hrv_daily_rmssd == null) return null;
    return _rawStress(d.hrv_daily_rmssd, d.resting_hr, d.sleep_score);
  }).filter(v => v != null);

  let stress;
  if (histStress.length >= 3) {
    const smoothed = _mean(histStress.slice(-7));
    stress = Math.round(0.50 * smoothed + 0.50 * todayRaw);
  } else {
    stress = Math.round(todayRaw);
  }
  stress = _clamp(stress, 1, 100);

  // Store scores — use 'fitbit' source so they appear in the same data stream
  const upsert = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
    VALUES (?, ?, 'fitbit', ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
      value = excluded.value, synced_at = excluded.synced_at
  `);
  upsert.run(userId, dateStr, 'readiness_score', readiness);
  upsert.run(userId, dateStr, 'stress_score', stress);
  logger.debug(`[wellness] ${dateStr} snapshot: readiness=${readiness} stress=${stress} (hrvBase=${hrvBaseline.toFixed(2)} rhrBase=${rhrBaseline?.toFixed(1) ?? 'null'} histDays=${days.length})`);
}
