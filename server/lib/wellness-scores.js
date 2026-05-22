/**
 * wellness-scores.js — Server-side readiness + Resilience score snapshot.
 *
 * Called during Fitbit / Garmin / Google Health sync to lock in today's scores.
 * Uses a fixed 30-day-from-today baseline matching the client-side Wellness.svelte formulas.
 * Only called for today's date — past days keep their already-stored scores.
 */
import db from '../db.js';
import { logger } from '../logger.js';

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

export function snapshotScores(userId, dateStr, { force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  // Skip if scores already exist for this date (unless force recalculating).
  // Both readiness AND resilience_category must be present — otherwise the
  // snapshot needs to run to fill in the missing one. This lets a code-level
  // schema change (adding a new metric to the snapshot, e.g. Resilience)
  // back-fill on the next sync for days that previously only had readiness.
  //
  // ALSO re-run if sleep_score was updated AFTER the snapshot landed. The
  // readiness formula uses today's sleep_score as `sleepBase`; Google Health
  // can return 503 on sleep_duration during the first morning fetch, then
  // succeed on the next tick. Without this check, the snapshot would lock in
  // sleepBase=75 (the null-fallback) even though a real value lands minutes
  // later. Same pattern bit calibration on 2026-05-12 and 2026-05-22 — both
  // days the actual readiness couldn't be validated against the formula
  // because the snapshot was stuck on stale sleep input.
  if (!force) {
    const existing = db.prepare(
      `SELECT metric_type, synced_at FROM wellness_data
        WHERE user_id = ? AND date = ? AND source = 'fitbit'
          AND metric_type IN ('readiness_score', 'resilience_category')`
    ).all(userId, dateStr);
    const types = new Set(existing.map(r => r.metric_type));
    if (types.has('readiness_score') && types.has('resilience_category')) {
      const oldestSnapshotAt = existing.map(r => r.synced_at).sort()[0];
      const sleepRow = db.prepare(
        `SELECT synced_at FROM wellness_data
          WHERE user_id = ? AND date = ? AND metric_type = 'sleep_score'`
      ).get(userId, dateStr);
      const sleepFresherThanSnapshot = sleepRow && sleepRow.synced_at > oldestSnapshotAt;
      if (!sleepFresherThanSnapshot) {
        logger.debug(`[wellness] ${dateStr} snapshot skipped — already stored`);
        return;
      }
      logger.info(`[wellness] ${dateStr} snapshot re-running — sleep_score updated since last snapshot (${oldestSnapshotAt} → ${sleepRow.synced_at})`);
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
  let hrv_score = hrvRatio >= 1.0 ? 65 + Math.pow(hrvRatio - 1.0, 0.7) * 80 : 65 - Math.sqrt(1.0 - hrvRatio) * 55;
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

  // ── Resilience ────────────────────────────────────────────────
  // Three-pillar replacement for the numeric stress score, mirroring the
  // structure Fitbit's Stress Management Score used internally before they
  // renamed it to Resilience and dropped the 0–100 number for an Optimal /
  // Balanced / Low bucket. Pillar weights (30 / 40 / 30) and rough
  // bucketing thresholds taken from the public Fitbit help docs.
  //
  // V2 thresholds — bumped Optimal to >=82 after the ACWR redesign
  // (2026-05-09 Fitbit Balanced) gave us raw 80, which under v1 would
  // have rounded up to Optimal. Two-point shift on the Optimal cutoff
  // is the smallest tuning that puts a one-pillar-maxed-but-mediocre-
  // elsewhere day correctly at Balanced. Low cutoff held steady.
  //   raw >= 82 → Optimal
  //   raw 70–81 → Balanced
  //   raw <  70 → Low
  //
  //   1. Physical Calmness (0–30): HRV ratio + RHR delta vs 30-day baseline.
  //   2. Activity Balance (0–40): bell curve around the user's daily step
  //      and active-minute goals — both undershoot AND overshoot subtract.
  //   3. Sleep Patterns (0–30): last night's sleep score + 7-day rolling
  //      reservoir (avg duration vs goal).
  let calmness = 21;
  if (hrvRatio != null) {
    calmness = 21 + (hrvRatio - 1.0) * 45;
  }
  if (rhrBaseline != null && todayRhr != null) {
    const rhrDelta = rhrBaseline - todayRhr;
    calmness += _clamp(rhrDelta * 0.5, -5, 5);
  }
  calmness = _clamp(Math.round(calmness), 0, 30);

  // Activity balance — Acute-to-Chronic Workload Ratio (ACWR), the model
  // Fitbit's own help docs cite for their Stress Management Exertion
  // Balance pillar. Compares the recent 7-day load against the rolling
  // 28-day load. Ratios near 1.0 are a balanced sustainable load; ratios
  // below 1 are recovery / detraining; ratios above 1 are overreaching.
  //
  // Load proxy: steps + active_minutes * 100. Fitbit's TRIMP model uses
  // HR-during-activity which Google Health doesn't expose to us, but
  // step count + active-minute weighting tracks the right shape (volume +
  // intensity).
  //
  // Score curve (0–40):
  //   ACWR <  0.5: severe undertraining → 15 (deconditioning concern)
  //   ACWR 0.5–0.8: recovery / taper      → 38 (good for resilience)
  //   ACWR 0.8–1.3: balanced load         → 40 (peak)
  //   ACWR 1.3–1.5: slightly overreaching → 32
  //   ACWR 1.5–2.0: overreaching          → 20
  //   ACWR >  2.0: injury risk            → 8
  //
  // Falls back to a yesterday-vs-target heuristic when there isn't enough
  // history yet (need 5 acute days + 14 chronic days for ACWR to be
  // meaningful — these thresholds match the sports-science literature).
  const _load = d => (d.steps || 0) + (d.active_minutes || 0) * 100;
  const acuteDays   = days.slice(-7).filter(d => d.steps != null || d.active_minutes != null);
  const chronicDays = days.slice(-28).filter(d => d.steps != null || d.active_minutes != null);

  let activity, acwr = null;
  if (acuteDays.length >= 5 && chronicDays.length >= 14) {
    const acuteLoad   = _mean(acuteDays.map(_load));
    const chronicLoad = _mean(chronicDays.map(_load));
    acwr = chronicLoad > 0 ? _clamp(acuteLoad / chronicLoad, 0.3, 2.5) : 1.0;
    if      (acwr <  0.5) activity = 15;
    else if (acwr <  0.8) activity = 38;
    else if (acwr <= 1.3) activity = 40;
    else if (acwr <= 1.5) activity = 32;
    else if (acwr <= 2.0) activity = 20;
    else                   activity = 8;
  } else {
    // Fallback for short-history users: yesterday's load vs 8000 step
    // baseline, with an asymmetric curve that doesn't crush rest days.
    const yesterday    = days.length > 0 ? days[days.length - 1] : null;
    const yesterdayLoad = yesterday ? _load(yesterday) : null;
    if (yesterdayLoad != null) {
      const baselineLoad = 8000 + 30 * 100; // ≈ 11000 (matches default goals)
      const ratio = yesterdayLoad / baselineLoad;
      if      (ratio < 0.3) activity = 25; // very low, gentle penalty
      else if (ratio < 0.7) activity = 35; // moderate-low, near peak
      else if (ratio <= 1.3) activity = 40; // balanced
      else if (ratio <= 1.7) activity = 30;
      else                    activity = 18;
    } else {
      activity = 20; // truly unknown, neutral
    }
  }
  activity = _clamp(Math.round(activity), 0, 40);

  // Sleep patterns — last night's sleep score scaled to 30 + reservoir adj.
  let sleepPattern = todaySleep != null ? todaySleep * 0.30 : 21;
  const sleepGoalMinRow = db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'sleepGoalMin'`).get(userId);
  const sleepGoalMin    = sleepGoalMinRow ? (parseInt(sleepGoalMinRow.value, 10) || 480) : 480; // default 8h
  const sleepDur7       = days.slice(-7).map(d => d.sleep_duration_min).filter(v => v != null);
  if (sleepDur7.length >= 3 && sleepGoalMin > 0) {
    const avgDur = _mean(sleepDur7);
    const reservoirAdj = _clamp((avgDur / sleepGoalMin - 1.0) * 25, -5, 5);
    sleepPattern += reservoirAdj;
  }
  sleepPattern = _clamp(Math.round(sleepPattern), 0, 30);

  const resilienceRaw      = calmness + activity + sleepPattern;
  const resilienceCategory = resilienceRaw >= 82 ? 'Optimal' : resilienceRaw >= 70 ? 'Balanced' : 'Low';

  // Store scores — use 'fitbit' source so they appear in the same data stream
  const upsert = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
    VALUES (?, ?, 'fitbit', ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
      value = excluded.value, synced_at = excluded.synced_at
  `);
  upsert.run(userId, dateStr, 'readiness_score',  readiness);
  upsert.run(userId, dateStr, 'resilience_score', resilienceRaw);
  // Categorical metric stored as a sentinel-numeric (1=Low, 2=Balanced, 3=Optimal)
  // so it round-trips through the same INTEGER value column without schema
  // changes. Wellness.svelte maps it back to a string at render time.
  const categoryNum = resilienceCategory === 'Optimal' ? 3 : resilienceCategory === 'Balanced' ? 2 : 1;
  upsert.run(userId, dateStr, 'resilience_category',  categoryNum);
  upsert.run(userId, dateStr, 'resilience_calmness',  calmness);
  upsert.run(userId, dateStr, 'resilience_activity', activity);
  upsert.run(userId, dateStr, 'resilience_sleep',     sleepPattern);

  logger.debug(`[wellness] ${dateStr} snapshot: readiness=${readiness} resilience=${resilienceCategory}/${resilienceRaw} (calm=${calmness} activity=${activity}${acwr != null ? ` acwr=${acwr.toFixed(2)}` : ''} sleep=${sleepPattern}) | hrvBase=${hrvBaseline.toFixed(2)} rhrBase=${rhrBaseline?.toFixed(1) ?? 'null'} histDays=${days.length}`);
  // Readiness component breakdown — mirrors the client-side [readiness]
  // console JSON block so calibration data is fully captured in server
  // logs without needing to also paste browser console output.
  logger.debug(`[wellness] ${dateStr} readiness components: hrvRatio=${hrvRatio.toFixed(3)} hrv_score=${hrv_score.toFixed(1)} rhr_score=${rhr_score.toFixed(1)} sleepBase=${sleepBase} activity_pen=${activity_penalty.toFixed(1)} interaction_pen=${interaction_penalty.toFixed(1)} → readiness=${readiness}`);
}
