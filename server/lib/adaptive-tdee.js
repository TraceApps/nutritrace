/**
 * adaptive-tdee.js — learn the user's true TDEE from weight trend × intake.
 *
 * Algorithm (the standard energy-balance approach used by MacroFactor, Macros+,
 * etc.):
 *
 *   tdee = avg_daily_intake − daily_energy_balance
 *   daily_energy_balance = weight_slope_kg_per_day × 7700 kcal/kg
 *
 * Energy density of body mass change is taken as 7700 kcal/kg (~3500 kcal/lb).
 * That number is conservative — adipose loss/gain is closer to 7700, but with
 * mixed lean+fat it varies. 7700 is the textbook value and what other
 * adaptive trackers cite.
 *
 * Inputs: 35 days of daily intake (sum of diary food calories) + daily weight
 * (from wellness scale priority, falling back to manual body_stats). Sparse
 * weights are linearly interpolated between known values. We don't
 * extrapolate at the edges — the first and last weight have to be real
 * measurements.
 *
 * Readiness gate: need ≥21 days where BOTH intake and weight are present
 * (after interpolation). 21 is enough signal to detect a real trend through
 * day-to-day noise without forcing 35 perfect days.
 */

import db from '../db.js';
import { logger } from '../logger.js';

const KCAL_PER_KG = 7700;
const LB_TO_KG = 1 / 2.20462;
const DEFAULT_WINDOW_DAYS = 35;
const MIN_VALID_DAYS = 21;

/** ISO date string for `daysAgo` days before today (UTC). */
function _isoDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Sum food calories for a single diary row's items[]. Activities live in a
 *  separate table so we don't need to filter them out here. */
function _sumDailyIntake(itemsJson) {
  if (!itemsJson) return null;
  let items;
  try { items = JSON.parse(itemsJson); } catch { return null; }
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const it of items) {
    const kcal = it?.nutrition?.calories ?? it?.calories ?? 0;
    const qty  = it?.quantity ?? 1;
    total += Number(kcal) * Number(qty);
  }
  return total > 0 ? total : null;
}

/** Read manual weight (kg) from a diary row's body_stats JSON. */
function _bodyStatsWeightKg(bodyStatsJson) {
  if (!bodyStatsJson) return null;
  let bs;
  try { bs = JSON.parse(bodyStatsJson); } catch { return null; }
  const raw = bs?.weight;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = bs.weight_unit || 'kg';
  return unit === 'lb' ? n * LB_TO_KG : n;
}

/** Linear regression on (x, y) pairs where x is the day index. Returns slope
 *  (units of y per day) and R² fit quality. */
function _linReg(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssRes = 0, ssTot = 0;
  for (const [x, y] of points) {
    const yhat = slope * x + intercept;
    ssRes += (y - yhat) ** 2;
    ssTot += (y - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, r2 };
}

/**
 * Compute the adaptive TDEE for a user.
 *
 * @returns {{
 *   ready: boolean,
 *   daysAvailable: number,
 *   daysRequired: number,
 *   windowDays: number,
 *   tdee: number|null,
 *   trendKgPerWeek: number|null,
 *   confidence: number|null,
 *   weightSource: 'wellness'|'manual'|'mixed'|null,
 *   computedAt: string,
 * }}
 */
export function computeAdaptiveTdee(userId, opts = {}) {
  const windowDays = opts.windowDays || DEFAULT_WINDOW_DAYS;
  const minValid   = opts.minValidDays || MIN_VALID_DAYS;
  const startDate  = _isoDaysAgo(windowDays - 1);
  const endDate    = _isoDaysAgo(0);

  // --- Diary: intake + manual weight ---
  const diaryRows = db.prepare(
    `SELECT date, items, body_stats FROM diary
     WHERE user_id = ? AND date >= ? AND date <= ?
     ORDER BY date ASC`
  ).all(userId, startDate, endDate);

  // --- Wellness: scale weight, priority: withings > fitbit > garmin > health_connect ---
  const wellRows = db.prepare(
    `SELECT date, source, value FROM wellness_data
     WHERE user_id = ? AND metric_type = 'weight_kg'
       AND date >= ? AND date <= ? AND value > 0
     ORDER BY date ASC`
  ).all(userId, startDate, endDate);

  const WELLNESS_PRIORITY = ['withings', 'fitbit', 'garmin', 'health_connect'];
  const wellnessByDate = new Map(); // date → { value, source }
  for (const r of wellRows) {
    const existing = wellnessByDate.get(r.date);
    if (!existing) { wellnessByDate.set(r.date, { value: r.value, source: r.source }); continue; }
    const newRank = WELLNESS_PRIORITY.indexOf(r.source);
    const oldRank = WELLNESS_PRIORITY.indexOf(existing.source);
    if (newRank !== -1 && (oldRank === -1 || newRank < oldRank)) {
      wellnessByDate.set(r.date, { value: r.value, source: r.source });
    }
  }

  // --- Build dense series, day-by-day, from windowDays ago to today ---
  const intakeByDate = new Map();
  const manualByDate = new Map();
  for (const r of diaryRows) {
    const intake = _sumDailyIntake(r.items);
    if (intake != null) intakeByDate.set(r.date, intake);
    const w = _bodyStatsWeightKg(r.body_stats);
    if (w != null) manualByDate.set(r.date, w);
  }

  const series = []; // [{ date, intake, weight, weightSource }]
  let usedWellness = false, usedManual = false;
  for (let i = 0; i < windowDays; i++) {
    const date = _isoDaysAgo(windowDays - 1 - i);
    const intake = intakeByDate.get(date) ?? null;
    let weight = null, weightSource = null;
    const wellness = wellnessByDate.get(date);
    if (wellness) { weight = wellness.value; weightSource = 'wellness'; usedWellness = true; }
    else if (manualByDate.has(date)) { weight = manualByDate.get(date); weightSource = 'manual'; usedManual = true; }
    series.push({ date, intake, weight, weightSource });
  }

  // --- Linearly interpolate missing weights between known values ---
  // Don't extrapolate at the edges — first and last weight must be real.
  const knownIdxs = series.map((s, i) => s.weight != null ? i : -1).filter(i => i >= 0);
  if (knownIdxs.length >= 2) {
    for (let k = 0; k < knownIdxs.length - 1; k++) {
      const aIdx = knownIdxs[k];
      const bIdx = knownIdxs[k + 1];
      if (bIdx - aIdx <= 1) continue;
      const aW = series[aIdx].weight;
      const bW = series[bIdx].weight;
      for (let i = aIdx + 1; i < bIdx; i++) {
        const t = (i - aIdx) / (bIdx - aIdx);
        series[i].weight = aW + (bW - aW) * t;
        series[i].weightSource = 'interpolated';
      }
    }
  }

  // --- Filter to days with both intake AND weight ---
  const valid = series.filter(s => s.intake != null && s.weight != null);
  const daysAvailable = valid.length;

  if (daysAvailable < minValid) {
    return {
      ready: false,
      daysAvailable,
      daysRequired: minValid,
      windowDays,
      tdee: null,
      trendKgPerWeek: null,
      confidence: null,
      weightSource: null,
      computedAt: new Date().toISOString(),
    };
  }

  // --- Linear regression on weight ---
  const points = valid.map((s, i) => [i, s.weight]);
  const { slope, r2 } = _linReg(points);
  const slopeKgPerDay = slope;
  const dailyEnergyBalance = slopeKgPerDay * KCAL_PER_KG;

  // --- Average intake on valid days ---
  const avgIntake = valid.reduce((sum, s) => sum + s.intake, 0) / valid.length;
  const tdee = avgIntake - dailyEnergyBalance;

  // --- Confidence: blend coverage % and R² fit quality ---
  const coverage = daysAvailable / windowDays;
  const confidence = Math.max(0.5, Math.min(0.95, 0.5 * coverage + 0.5 * r2));

  const weightSource = usedWellness && usedManual ? 'mixed' : usedWellness ? 'wellness' : 'manual';

  logger.debug(
    `[adaptive-tdee] user=${userId} window=${windowDays} valid=${daysAvailable} ` +
    `avgIntake=${Math.round(avgIntake)} slope=${slopeKgPerDay.toFixed(4)}kg/d ` +
    `balance=${Math.round(dailyEnergyBalance)}kcal tdee=${Math.round(tdee)} ` +
    `r2=${r2.toFixed(2)} conf=${confidence.toFixed(2)}`
  );

  return {
    ready: true,
    daysAvailable,
    daysRequired: minValid,
    windowDays,
    tdee: Math.round(tdee),
    trendKgPerWeek: Math.round(slopeKgPerDay * 7 * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    weightSource,
    computedAt: new Date().toISOString(),
  };
}
