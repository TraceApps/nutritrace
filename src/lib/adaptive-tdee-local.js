/**
 * adaptive-tdee-local.js — client-side mirror of server/lib/adaptive-tdee.js.
 *
 * Used in Android standalone mode (no server). Reads from the same local
 * SQLite tables the rest of the app uses (`diary`, `wellness_data`, body_stats
 * JSON on diary rows), runs the identical linear-regression compute, and
 * returns the same shape as the server endpoint so Goals.svelte / Diary.svelte
 * don't have to know which path executed.
 *
 * Algorithm (same as server):
 *   1. Pull 35 days of daily intake (sum of diary.items calories) + daily
 *      weight (priority: wellness_data 'weight_kg', fallback to manual
 *      body_stats.weight with weight_unit conversion).
 *   2. Linearly interpolate weight gaps between known measurements.
 *   3. Require ≥21 valid days. Otherwise ready=false.
 *   4. slope_kg_per_day × 7700 kcal/kg = daily energy balance.
 *   5. tdee = avg_intake − balance.
 */

import { getDb, LOCAL_USER_ID } from './db-native.js';

const KCAL_PER_KG = 7700;
const LB_TO_KG = 1 / 2.20462;
const DEFAULT_WINDOW_DAYS = 35;
const MIN_VALID_DAYS = 21;

function _isoDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function _sumDailyIntake(itemsJson) {
  if (!itemsJson) return null;
  let items;
  try { items = typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson; } catch { return null; }
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const it of items) {
    const kcal = it?.nutrition?.calories ?? it?.calories ?? 0;
    const qty  = it?.quantity ?? 1;
    total += Number(kcal) * Number(qty);
  }
  return total > 0 ? total : null;
}

function _bodyStatsWeightKg(bodyStatsJson) {
  if (!bodyStatsJson) return null;
  let bs;
  try { bs = typeof bodyStatsJson === 'string' ? JSON.parse(bodyStatsJson) : bodyStatsJson; } catch { return null; }
  const raw = bs?.weight;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = bs.weight_unit || 'kg';
  return unit === 'lb' ? n * LB_TO_KG : n;
}

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
  for (const [, y] of points) {
    const yhat = slope * (points.indexOf([, y])) + intercept;
    ssRes += (y - yhat) ** 2;
    ssTot += (y - meanY) ** 2;
  }
  // Proper R²: re-loop with index
  ssRes = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i];
    const yhat = slope * x + intercept;
    ssRes += (y - yhat) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, r2 };
}

export async function computeAdaptiveTdeeLocal(opts = {}) {
  const windowDays = opts.windowDays || DEFAULT_WINDOW_DAYS;
  const minValid   = opts.minValidDays || MIN_VALID_DAYS;
  const startDate  = _isoDaysAgo(windowDays - 1);
  const endDate    = _isoDaysAgo(0);

  const db = await getDb();
  const diaryRes = await db.query(
    `SELECT date, items, body_stats FROM diary
     WHERE user_id = ? AND date >= ? AND date <= ?
     ORDER BY date ASC`,
    [LOCAL_USER_ID, startDate, endDate]
  );
  const wellRes = await db.query(
    `SELECT date, source, value FROM wellness_data
     WHERE user_id = ? AND metric_type = 'weight_kg'
       AND date >= ? AND date <= ? AND value > 0
     ORDER BY date ASC`,
    [LOCAL_USER_ID, startDate, endDate]
  );

  const PRIORITY = ['withings', 'fitbit', 'garmin', 'health_connect'];
  const wellnessByDate = new Map();
  for (const r of (wellRes?.values || [])) {
    const existing = wellnessByDate.get(r.date);
    if (!existing) { wellnessByDate.set(r.date, { value: r.value, source: r.source }); continue; }
    const newRank = PRIORITY.indexOf(r.source);
    const oldRank = PRIORITY.indexOf(existing.source);
    if (newRank !== -1 && (oldRank === -1 || newRank < oldRank)) {
      wellnessByDate.set(r.date, { value: r.value, source: r.source });
    }
  }

  const intakeByDate = new Map();
  const manualByDate = new Map();
  for (const r of (diaryRes?.values || [])) {
    const intake = _sumDailyIntake(r.items);
    if (intake != null) intakeByDate.set(r.date, intake);
    const w = _bodyStatsWeightKg(r.body_stats);
    if (w != null) manualByDate.set(r.date, w);
  }

  const series = [];
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

  // Linear interpolation between known weights
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

  const points = valid.map((s, i) => [i, s.weight]);
  const { slope, r2 } = _linReg(points);
  const slopeKgPerDay = slope;
  const dailyEnergyBalance = slopeKgPerDay * KCAL_PER_KG;
  const avgIntake = valid.reduce((sum, s) => sum + s.intake, 0) / valid.length;
  const tdee = avgIntake - dailyEnergyBalance;

  const coverage = daysAvailable / windowDays;
  const confidence = Math.max(0.5, Math.min(0.95, 0.5 * coverage + 0.5 * r2));
  const weightSource = usedWellness && usedManual ? 'mixed' : usedWellness ? 'wellness' : 'manual';

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
