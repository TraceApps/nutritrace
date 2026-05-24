/**
 * Google Health API client + OAuth helpers.
 *
 * Mirrors the manual-OAuth pattern used by server/routes/fitbit.js so the
 * surface area of the migration is minimal. If Google's support boundary
 * turns out to require their official OAuth client library, swap _refresh()
 * and the token-exchange call in routes/google-health.js — everything else
 * (storage, encryption, scheduler integration) stays the same.
 *
 * Google Health API base: https://health.googleapis.com/v4
 * OAuth endpoints:
 *   - Auth:    https://accounts.google.com/o/oauth2/v2/auth
 *   - Token:   https://oauth2.googleapis.com/token
 *   - Revoke:  https://oauth2.googleapis.com/revoke
 *
 * Sept 2026 cutoff for legacy Fitbit Web API. See memory:
 * project_nutritrace_google_health.md for the full migration plan.
 */
import db from '../db.js';
import { encrypt, decrypt } from './token-crypto.js';

export const GOOGLE_HEALTH_BASE = 'https://health.googleapis.com/v4';
export const GOOGLE_AUTH_URL    = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL   = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL  = 'https://oauth2.googleapis.com/revoke';

// Read-only scopes — covers everything NutriTrace surfaces today. Google's
// OAuth screen lets the user consent to a subset; we ask for the full set.
export const GOOGLE_HEALTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.location.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
];

// ── Token storage ─────────────────────────────────────────────────────────

export function getTokens(userId) {
  const row = db.prepare('SELECT * FROM google_health_tokens WHERE user_id = ?').get(userId);
  if (!row) return null;
  return { ...row, access_token: decrypt(row.access_token), refresh_token: decrypt(row.refresh_token) };
}

export function saveTokens(userId, { access_token, refresh_token, expires_at, google_user_id, fitbit_user_id }) {
  db.prepare(`
    INSERT INTO google_health_tokens (user_id, access_token, refresh_token, expires_at, google_user_id, fitbit_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token   = excluded.access_token,
      refresh_token  = excluded.refresh_token,
      expires_at     = excluded.expires_at,
      google_user_id = excluded.google_user_id,
      fitbit_user_id = excluded.fitbit_user_id
  `).run(
    userId,
    encrypt(access_token),
    encrypt(refresh_token),
    expires_at,
    google_user_id || null,
    fitbit_user_id || null,
  );
}

export function deleteTokens(userId) {
  db.prepare('DELETE FROM google_health_tokens WHERE user_id = ?').run(userId);
}

export async function refreshTokens(userId, clientId, clientSecret) {
  const tokens = getTokens(userId);
  if (!tokens) throw new Error('No Google Health tokens stored for user');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${txt}`);
  }
  const data = await res.json();

  const newRefresh = data.refresh_token || tokens.refresh_token;
  const expiresAt  = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

  saveTokens(userId, {
    access_token:   data.access_token,
    refresh_token:  newRefresh,
    expires_at:     expiresAt,
    google_user_id: tokens.google_user_id,
    fitbit_user_id: tokens.fitbit_user_id,
  });
  return data.access_token;
}

export async function getAccessToken(userId, clientId, clientSecret) {
  const tokens = getTokens(userId);
  if (!tokens) throw new Error('No Google Health tokens stored for user');
  const expiresAt = new Date(tokens.expires_at).getTime();
  if (Date.now() >= expiresAt - 5 * 60 * 1000) {
    return refreshTokens(userId, clientId, clientSecret);
  }
  return tokens.access_token;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

export async function ghGet(accessToken, path) {
  const url = `${GOOGLE_HEALTH_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google Health GET ${path} failed (${res.status}): ${txt}`);
  }
  return res.json();
}

export async function ghPost(accessToken, path, body) {
  const url = `${GOOGLE_HEALTH_BASE}${path}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google Health POST ${path} failed (${res.status}): ${txt}`);
  }
  return res.json();
}

// ── Date helpers ───────────────────────────────────────────────────────────

/** YYYY-MM-DD → CivilDateTime { date: { year, month, day } } */
function _civilDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { date: { year: y, month: m, day: d } };
}
/** Add one day to a YYYY-MM-DD string (UTC). */
function _nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
/** Compare a Google Date {year, month, day} object to a YYYY-MM-DD string. */
function _dateMatches(googleDate, dateStr) {
  if (!googleDate) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  return googleDate.year === y && googleDate.month === m && googleDate.day === d;
}

// ── Generic dailyRollUp helper ────────────────────────────────────────────
//
// Most NutriTrace metrics use a one-day rollup. This helper performs the
// POST and returns the first (and only) rollupDataPoint, or null if the
// response was empty. valueExtractor: function(point) -> { value, ... }
// or null if the field couldn't be extracted.
//
async function _runDailyRollUp(accessToken, slug, dateStr, valueExtractor) {
  const data = await ghPost(accessToken, `/users/me/dataTypes/${slug}/dataPoints:dailyRollUp`, {
    range: {
      start: _civilDate(dateStr),
      end:   _civilDate(_nextDay(dateStr)),
    },
    windowSizeDays: 1,
  });
  const point = (data?.rollupDataPoints || [])[0];
  if (!point) return { value: null, date: dateStr, note: 'No rollupDataPoints returned', rawResponse: data };
  const v = valueExtractor(point);
  if (v == null || v.value == null || !Number.isFinite(v.value)) {
    return { value: null, date: dateStr, note: 'Field missing or non-numeric on rollup point', rawResponse: data };
  }
  return { ...v, date: dateStr };
}

/** YYYY-MM-DD of the day before */
function _prevDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
/** Format a Google Date {y,m,d} as YYYY-MM-DD for human-readable notes */
function _fmtDate(g) {
  if (!g) return null;
  return `${g.year}-${String(g.month).padStart(2, '0')}-${String(g.day).padStart(2, '0')}`;
}

/**
 * List dataPoints across multiple pages until we either hit `maxPages`,
 * accumulate `maxPoints` items, run out of nextPageToken, or `shouldStop`
 * returns true. Returns the merged dataPoints array + the last raw response
 * (for debug). Google caps the actual page size lower than what we ask for
 * — observed default ~12 for sleep — so pagination is the only way to
 * cover historical dates.
 */
async function _listAllPages(accessToken, slug, { pageSize = 100, maxPages = 10, maxPoints = 1000, shouldStop = null } = {}) {
  let url = `/users/me/dataTypes/${slug}/dataPoints?pageSize=${pageSize}`;
  const all = [];
  let lastResponse = null;
  for (let i = 0; i < maxPages; i++) {
    const data = await ghGet(accessToken, url);
    lastResponse = data;
    const points = data?.dataPoints || [];
    all.push(...points);
    if (shouldStop && shouldStop(all)) break;
    if (all.length >= maxPoints) break;
    const tok = data?.nextPageToken;
    if (!tok) break;
    url = `/users/me/dataTypes/${slug}/dataPoints?pageSize=${pageSize}&pageToken=${encodeURIComponent(tok)}`;
  }
  return { points: all, lastResponse };
}

// ── Generic list-and-find-by-date helper ───────────────────────────────────
//
// For daily-* slugs (already one-per-day) we use list rather than rollUp.
// Paginates through up to `maxPages` of results until we find a date match
// or run out. Sleep-derived metrics (SpO2, skin temp) sometimes get tagged
// with the previous day's date by Google (when the sleep started the night
// before the wake-up day), so we accept either.
//
async function _findDailyDataPoint(accessToken, slug, dateStr, valueExtractor, opts = {}) {
  const { pageSize = 100, maxPages = 5, allowPreviousDay = false } = opts;
  const prevStr = _prevDay(dateStr);
  const { points, lastResponse } = await _listAllPages(accessToken, slug, { pageSize, maxPages });
  const seen = [];
  for (const p of points) {
    const v = valueExtractor(p);
    if (!v) continue;
    if (_dateMatches(v.date, dateStr) || (allowPreviousDay && _dateMatches(v.date, prevStr))) {
      return { ...v, matchedDate: _fmtDate(v.date), date: dateStr };
    }
    seen.push(_fmtDate(v.date));
  }
  const recent = seen.slice(0, 5).filter(Boolean).join(', ');
  const target = allowPreviousDay ? `${dateStr} or ${prevStr}` : dateStr;
  return {
    value: null,
    date: dateStr,
    note: `No matching data point for ${target} in ${points.length} points across up to ${maxPages} pages` +
          (recent ? ` (recent: ${recent})` : ''),
    rawResponse: lastResponse,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-data-type adapters. Each returns either:
//   { value, date, ...extras }      on success
//   { value: null, date, note, rawResponse }   on miss
// Throws on transport / 4xx / 5xx errors.
// ─────────────────────────────────────────────────────────────────────────

// 1a. Steps — dailyRollUp on `steps`. Value at .steps.countSum (string int).
export async function fetchDailySteps(accessToken, dateStr) {
  return _runDailyRollUp(accessToken, 'steps', dateStr, p => {
    const n = parseInt(p?.steps?.countSum, 10);
    return Number.isFinite(n) ? { value: n, count: n } : null; // keep `count` alias for the existing /smoke-steps caller
  });
}

// 1b. Distance — dailyRollUp on `distance`. millimetersSum (string int) → km.
export async function fetchDailyDistance(accessToken, dateStr) {
  return _runDailyRollUp(accessToken, 'distance', dateStr, p => {
    const mm = parseInt(p?.distance?.millimetersSum, 10);
    return Number.isFinite(mm) ? { value: mm / 1_000_000 } : null;
  });
}

// 1c. Floors — dailyRollUp on `floors`. countSum (string int).
export async function fetchDailyFloors(accessToken, dateStr) {
  return _runDailyRollUp(accessToken, 'floors', dateStr, p => {
    const n = parseInt(p?.floors?.countSum, 10);
    return Number.isFinite(n) ? { value: n } : null;
  });
}

// 1d. Active minutes — dailyRollUp on `active-minutes`.
//   Sum the entries where activityLevel ∈ {MODERATE, VIGOROUS}
//   to mirror Fitbit's fairlyActive + veryActive.
export async function fetchDailyActiveMinutes(accessToken, dateStr) {
  return _runDailyRollUp(accessToken, 'active-minutes', dateStr, p => {
    const rows = p?.activeMinutes?.activeMinutesRollupByActivityLevel || [];
    let sum = 0;
    for (const r of rows) {
      if (r.activityLevel === 'MODERATE' || r.activityLevel === 'VIGOROUS') {
        sum += parseInt(r.activeMinutesSum, 10) || 0;
      }
    }
    return rows.length ? { value: sum, levels: rows } : null;
  });
}

// 1e. Total calories — dailyRollUp on `total-calories`. kcalSum (number).
export async function fetchDailyCaloriesOut(accessToken, dateStr) {
  return _runDailyRollUp(accessToken, 'total-calories', dateStr, p => {
    const n = Number(p?.totalCalories?.kcalSum);
    return Number.isFinite(n) ? { value: n } : null;
  });
}

// 8. Active zone minutes — dailyRollUp. Sum 3 zones (already weighted).
export async function fetchDailyActiveZoneMinutes(accessToken, dateStr) {
  return _runDailyRollUp(accessToken, 'active-zone-minutes', dateStr, p => {
    const z = p?.activeZoneMinutes;
    if (!z) return null;
    const sum = (parseInt(z.sumInFatBurnHeartZone, 10) || 0) +
                (parseInt(z.sumInCardioHeartZone,  10) || 0) +
                (parseInt(z.sumInPeakHeartZone,    10) || 0);
    return { value: sum, zones: z };
  });
}

// 3. Resting heart rate — list `daily-resting-heart-rate`.
export async function fetchDailyRestingHR(accessToken, dateStr) {
  return _findDailyDataPoint(accessToken, 'daily-resting-heart-rate', dateStr, p => {
    const r = p?.dailyRestingHeartRate;
    if (!r) return null;
    const bpm = parseInt(r.beatsPerMinute, 10);
    return Number.isFinite(bpm) ? { value: bpm, date: r.date } : null;
  });
}

// 4. HRV — list `daily-heart-rate-variability`. averageHeartRateVariabilityMilliseconds.
export async function fetchDailyHRV(accessToken, dateStr) {
  return _findDailyDataPoint(accessToken, 'daily-heart-rate-variability', dateStr, p => {
    const r = p?.dailyHeartRateVariability;
    if (!r) return null;
    const ms = Number(r.averageHeartRateVariabilityMilliseconds);
    return Number.isFinite(ms) ? { value: ms, date: r.date } : null;
  });
}

// 5. SpO2 — list `daily-oxygen-saturation`. averagePercentage.
//   Sleep-derived: allow previous day match (Fitbit attributes to wake-up
//   date, Google may attribute to sleep-start date which is night before).
export async function fetchDailySpO2(accessToken, dateStr) {
  return _findDailyDataPoint(accessToken, 'daily-oxygen-saturation', dateStr, p => {
    const r = p?.dailyOxygenSaturation;
    if (!r) return null;
    const pct = Number(r.averagePercentage);
    return Number.isFinite(pct) ? { value: pct, date: r.date } : null;
  }, { allowPreviousDay: true });
}

// 6. Skin temp variation — list `daily-sleep-temperature-derivations`.
//   Compute as nightlyTemperatureCelsius − baselineTemperatureCelsius
//   to match Fitbit's `nightlyRelative` shape. Same sleep-derived
//   previous-day tolerance as SpO2.
export async function fetchDailySkinTempDelta(accessToken, dateStr) {
  return _findDailyDataPoint(accessToken, 'daily-sleep-temperature-derivations', dateStr, p => {
    const r = p?.dailySleepTemperatureDerivations;
    if (!r) return null;
    const nightly  = Number(r.nightlyTemperatureCelsius);
    const baseline = Number(r.baselineTemperatureCelsius);
    if (!Number.isFinite(nightly) || !Number.isFinite(baseline)) return null;
    return { value: +(nightly - baseline).toFixed(2), date: r.date, nightly, baseline };
  }, { allowPreviousDay: true });
}

// 7. Respiratory rate — list `daily-respiratory-rate`.
export async function fetchDailyRespiratoryRate(accessToken, dateStr) {
  return _findDailyDataPoint(accessToken, 'daily-respiratory-rate', dateStr, p => {
    const r = p?.dailyRespiratoryRate;
    if (!r) return null;
    const bpm = Number(r.breathsPerMinute);
    return Number.isFinite(bpm) ? { value: bpm, date: r.date } : null;
  });
}

// 9. VO2 max (Fitbit's "Cardio Fitness Score").
//   Google Health has three related slugs:
//     - daily-vo2-max  — daily aggregate (what we'd ideally use)
//     - vo2-max        — individual measurements
//     - run-vo2-max    — derived from runs only
//   Try them in order. Returns the first hit + which slug it came from
//   so we can see where Fitbit is actually publishing the data.
export async function fetchDailyVO2Max(accessToken, dateStr) {
  const slugsToTry = [
    {
      slug: 'daily-vo2-max',
      extract: p => {
        const r = p?.dailyVo2Max;
        if (!r) return null;
        const v = Number(r.vo2Max);
        return Number.isFinite(v) ? { value: v, date: r.date, cardioFitnessLevel: r.cardioFitnessLevel } : null;
      },
    },
    {
      slug: 'vo2-max',
      // Single-shot measurements — `vo2-max` data points carry a `sampleTime`
      // (CivilDateTime) rather than a `.date`, so derive a Date {y,m,d} from
      // sampleTime.civilTime.date for matching.
      extract: p => {
        const r = p?.vo2Max;
        if (!r) return null;
        const v = Number(r.vo2Max ?? r.value);
        const date = r.sampleTime?.civilTime?.date;
        return Number.isFinite(v) ? { value: v, date } : null;
      },
    },
    {
      slug: 'run-vo2-max',
      // Note: this data type uses the field name `runVo2Max` (not `vo2Max`)
      // per the v4 schema. The other two slugs use `vo2Max`.
      extract: p => {
        const r = p?.runVo2Max;
        if (!r) return null;
        const v = Number(r.runVo2Max ?? r.vo2Max);
        const date = r.sampleTime?.civilTime?.date;
        return Number.isFinite(v) ? { value: v, date } : null;
      },
    },
  ];
  const triedNotes = [];
  for (const { slug, extract } of slugsToTry) {
    const result = await _findDailyDataPoint(accessToken, slug, dateStr, extract, { allowPreviousDay: true });
    if (result.value != null) return { ...result, source: slug };
    triedNotes.push(`${slug}: ${result.note}`);
  }
  return {
    value: null,
    date: dateStr,
    note: `Tried 3 VO2 max slugs, no data on any. ${triedNotes.join(' || ')}`,
  };
}

// 2. Sleep — `sleep` cannot be rolled up. List recent sleep sessions and
//   pick the main one whose civilStartTime falls on the previous calendar
//   day (typical "last night's sleep" attribution: sleep starting on
//   day-1 is owned by day's report).
//
// Fallback efficiency is computed since Google does not ship one:
//   efficiency = minutesAsleep / minutesInSleepPeriod * 100.
/** Try every shape the docs / examples have suggested for sleep interval
 *  timestamps. Returns { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
 *  with whichever resolved successfully (others null). UTC-only — local
 *  timezone correction is up to the caller if needed. */
function _resolveSleepDates(point) {
  const s = point?.sleep;
  // Source A: nested civilStartTime/civilEndTime under sleep.interval
  let startDate = _fmtDate(s?.interval?.civilStartTime?.date);
  let endDate   = _fmtDate(s?.interval?.civilEndTime?.date);
  // Source B: same fields but on the top-level dataPoint (some Google APIs
  // put interval at the DataPoint level rather than nested in the value)
  if (!startDate) startDate = _fmtDate(point?.interval?.civilStartTime?.date);
  if (!endDate)   endDate   = _fmtDate(point?.interval?.civilEndTime?.date);
  // Source C: RFC3339 strings (sleep.interval.startTime / endTime). Slice
  // the date portion. Note: this is UTC, so for users far west it could be
  // off by one — that's why we also accept civil dates above when present.
  if (!startDate) startDate = (s?.interval?.startTime || point?.interval?.startTime || '').slice(0, 10) || null;
  if (!endDate)   endDate   = (s?.interval?.endTime   || point?.interval?.endTime   || '').slice(0, 10) || null;
  // Source D: sleep.startTime / endTime directly (some shapes flatten it)
  if (!startDate) startDate = (s?.startTime || '').slice(0, 10) || null;
  if (!endDate)   endDate   = (s?.endTime   || '').slice(0, 10) || null;
  return { startDate, endDate };
}

export async function fetchSleepForDate(accessToken, dateStr) {
  // Paginate up to 5 pages — Google caps actual page size lower than the
  // pageSize hint (observed default ~12 for sleep), so a single request
  // only reaches back about 2 weeks of real history. 5 pages covers ~2-3
  // months which is plenty for any backfill we'd reasonably do.
  const { points, lastResponse: data } = await _listAllPages(accessToken, 'sleep', { pageSize: 100, maxPages: 5 });
  const prevStr = _prevDay(dateStr);
  // Two pools so we can prefer end-date matches over start-date-only matches.
  // End-date match (sleep ENDED on dateStr) is the unambiguous "this is today's
  // sleep" signal — it's the typical overnight session crossing midnight.
  // Start-date match (sleep STARTED yesterday) is a fallback for cases where
  // endDate isn't returned, but on its own it can also catch yesterday's
  // *daytime* sessions (afternoon naps, sleep that ended yesterday too) and
  // misattribute them to today when last night's overnight session hasn't been
  // pushed by Google yet. Always pick from `endMatches` first; only drop to
  // `startMatches` when there are no end-date matches at all.
  const endMatches   = [];
  const startMatches = [];
  const seenDates = [];
  for (const p of points) {
    const s = p?.sleep;
    if (!s) continue;
    const { startDate, endDate } = _resolveSleepDates(p);
    seenDates.push(`start=${startDate || 'null'} end=${endDate || 'null'}`);
    const matchEnd   = endDate   && (endDate   === dateStr);
    const matchStart = startDate && (startDate === dateStr || startDate === prevStr);
    if (!matchEnd && !matchStart) continue;
    // Stage-summed asleep time (LIGHT+DEEP+REM) is what we report as duration,
    // so it's the correct field to dedupe-by-longest on.
    const sStages = s.summary?.stagesSummary || [];
    const sm = (t) => parseInt(sStages.find(x => x.type === t)?.minutes, 10) || 0;
    const dur = sm('LIGHT') + sm('DEEP') + sm('REM');
    if (matchEnd) {
      endMatches.push({ ...s, _dur: dur, _matched: 'end' });
    } else if (matchStart) {
      // Only accept a start-date-only match when endDate is missing OR the
      // session crosses into today (endDate >= dateStr). Excludes pure
      // same-day sessions (yesterday-afternoon naps) that would otherwise
      // get falsely attributed to today's report.
      if (!endDate || endDate >= dateStr) {
        startMatches.push({ ...s, _dur: dur, _matched: 'start' });
      }
    }
  }
  const pool = endMatches.length ? endMatches : startMatches;
  let best = null;
  for (const c of pool) {
    if (!best || c._dur > (best._dur || 0)) best = c;
  }
  if (!best) {
    // Show the date range we covered so we can tell whether the target was
    // simply outside the lookback window vs a real attribution mismatch.
    const allEnds = seenDates.map(s => s.replace(/.*end=/, '').split(' ')[0]).filter(d => d && d !== 'null').sort();
    const earliest = allEnds[0];
    const latest   = allEnds[allEnds.length - 1];
    return {
      value: null,
      date: dateStr,
      note: `No sleep session attributed to ${dateStr} ` +
            `(searched ${points.length} dataPoints, end-dates ${earliest || '?'} → ${latest || '?'})`,
      rawResponse: data,
    };
  }

  const summary = best.summary || {};
  const stages  = summary.stagesSummary || [];
  const stageMinutes = (type) => parseInt(stages.find(s => s.type === type)?.minutes, 10) || 0;

  const deep  = stageMinutes('DEEP');
  const light = stageMinutes('LIGHT');
  const rem   = stageMinutes('REM');
  const wake  = stageMinutes('AWAKE');

  // Derive total sleep from stages (LIGHT + DEEP + REM, excluding AWAKE) —
  // matches what Fitbit's app displays as "Time asleep". Google's
  // summary.minutesAsleep field has been observed to differ from this sum
  // on real responses (reports a higher value, possibly including some
  // awake intervals despite the docs claim that it excludes them). The
  // stage sum is the authoritative source per the FDA-style sleep
  // breakdown the user sees in the Fitbit app.
  const minutesAsleep = light + deep + rem;

  // Sleep period = total time in bed (sum of all stages including AWAKE).
  // Google ships minutesInSleepPeriod; fall back to summing all stages if
  // missing. Used to derive efficiency.
  const minutesInPeriod = parseInt(summary.minutesInSleepPeriod, 10) || (light + deep + rem + wake);

  const efficiency = (minutesAsleep > 0 && minutesInPeriod > 0)
    ? Math.round(minutesAsleep / minutesInPeriod * 100)
    : null;

  const cs = best.interval?.civilStartTime?.time;
  const ce = best.interval?.civilEndTime?.time;
  const startMin = cs ? (cs.hours || 0) * 60 + (cs.minutes || 0) : null;
  const endMin   = ce ? (ce.hours || 0) * 60 + (ce.minutes || 0) : null;

  // Sleep Quality sub-metrics (Fitbit Public Preview Sleep Score redesign).
  // Derived by walking the segment-level `stages[]` array. GH's summary
  // fields do not carry these directly (verified via raw dumps on
  // 2026-05-06 and 2026-05-07).
  //
  // GH puts segment timestamps at the TOP level of each stage object as
  // `startTime` / `endTime` strings (RFC3339), NOT nested under `interval`.
  //
  //   - Time to Sound Sleep (min): from first asleep stage to first DEEP.
  //     Validated exact on 2026-05-07 (11 min, matched Fitbit app).
  //
  //   - Interruptions (min) + Full Awakenings (count): mid-night AWAKE
  //     events >= 5 min, EXCLUDING the FIRST AWAKE block (settling in)
  //     AND the LAST AWAKE block (morning wake-up event). Both gates are
  //     conditional on the block being >= 5 min — a brief 3-min AWAKE at
  //     either end stays counted (matches Fitbit's behavior on 2026-05-06,
  //     where the only AWAKE was 3.5 min and Fitbit credited it as
  //     restlessness, not as a "settling-in" period).
  //
  //   - Restlessness (min): sum of AWAKE segment durations < 5 min, with
  //     the same first/last gates. APPROXIMATION ONLY — Fitbit's app
  //     value comes from raw actigraphy / movement data that GH does not
  //     expose in the sleep dataPoint (verified 2026-05-07: Fitbit shows
  //     10 min restlessness, but no AWAKE segment in the GH response is
  //     under 5 min, so the segment-level derivation has no signal).
  //
  //   - Sound Sleep (min): DEEP + REM + brief LIGHT segments (<5 min).
  //     Calibration on 3 ground-truth days (May 7/8/9) shows DEEP+REM
  //     alone is consistently 5–8 min below Fitbit on long nights but
  //     ~30 min off on short nights, while adding short-LIGHT
  //     interludes brings May 8/9 within 5 min and May 7 within 23 min.
  //     Mean abs error ~10 min vs longest-contiguous-block which
  //     consistently overshot by ~2x. Brief LIGHT < 5 min appears to
  //     count as "sound" because it represents micro-arousals between
  //     stable sleep blocks, not real waking.
  const googleMinutesAsleep = parseInt(summary.minutesAsleep, 10) || null;

  // First pass — find the index of the AWAKE >= 5 min that's the actual
  // morning wake-up event (so the main walk can skip it instead of
  // counting it as an interruption). The wake-up event is the LAST big
  // AWAKE block that's at or near the end of the sleep period, i.e.
  // followed by negligible (< 5 min) sleep. Mid-night AWAKE blocks have
  // substantial sleep after them and are real interruptions, not wake-ups.
  //
  // 2026-05-10 caught a regression: stages ended with
  //   ... AWAKE:8m LIGHT:15m REM:1.5m LIGHT:33.5m
  // The AWAKE:8m is mid-night (50 min of sleep follows) but the previous
  // logic treated it as the wake-up because it was the last AWAKE >= 5min.
  // Fitbit correctly counted it as an interruption (8m / 1 moment).
  const stageSegs = best.stages || [];
  const FULL_AWAKE_MIN = 5;
  let lastAwakeBigIdx = -1;
  for (let i = stageSegs.length - 1; i >= 0; i--) {
    const seg = stageSegs[i];
    if (seg.type !== 'AWAKE' || !seg.startTime || !seg.endTime) continue;
    const dm = (new Date(seg.endTime) - new Date(seg.startTime)) / 60000;
    if (!Number.isFinite(dm) || dm < FULL_AWAKE_MIN) continue;
    // Sum sleep stages immediately following this AWAKE up to the next
    // AWAKE (or end of array). If < 5 min, this is the wake-up event.
    let postSleepMin = 0;
    for (let j = i + 1; j < stageSegs.length; j++) {
      const s2 = stageSegs[j];
      if (s2.type === 'AWAKE') break;
      if (!s2.startTime || !s2.endTime) continue;
      const dm2 = (new Date(s2.endTime) - new Date(s2.startTime)) / 60000;
      if (Number.isFinite(dm2)) postSleepMin += dm2;
    }
    if (postSleepMin < FULL_AWAKE_MIN) {
      lastAwakeBigIdx = i;
      break;
    }
    // Otherwise keep scanning earlier — there may be a later "true" wake-up
    // farther back, or no wake-up event at all (every big AWAKE counts).
  }

  const BRIEF_LIGHT_MAX = 5; // LIGHT segments < 5 min count toward Sound Sleep
  let interruptionsMin = 0;
  let fullAwakenings   = 0;
  let restlessnessMin  = 0;
  let firstAsleepStart = null;
  let firstDeepStart   = null;
  let soundSleepRaw    = 0;
  let firstAwakeSeen   = false;
  for (let i = 0; i < stageSegs.length; i++) {
    const seg = stageSegs[i];
    const s = seg.startTime;
    const e = seg.endTime;
    if (!s || !e) continue;
    const durMin = (new Date(e) - new Date(s)) / 60000;
    if (!Number.isFinite(durMin)) continue;
    if (seg.type === 'AWAKE') {
      // First AWAKE >= 5 min: settling-in period, credit to Time to Sound Sleep.
      if (!firstAwakeSeen) {
        firstAwakeSeen = true;
        if (durMin >= FULL_AWAKE_MIN) continue;
      }
      // Last AWAKE >= 5 min: morning wake-up event, exclude.
      if (i === lastAwakeBigIdx) continue;
      if (durMin >= FULL_AWAKE_MIN) {
        interruptionsMin += Math.round(durMin);
        fullAwakenings++;
      } else {
        // Floor so 3.5 → 3, matching Fitbit display.
        restlessnessMin += Math.floor(durMin);
      }
    } else if (seg.type === 'DEEP' || seg.type === 'REM') {
      soundSleepRaw += durMin;
      if (firstAsleepStart == null) firstAsleepStart = new Date(s).getTime();
      if (seg.type === 'DEEP' && firstDeepStart == null) firstDeepStart = new Date(s).getTime();
    } else if (seg.type === 'LIGHT') {
      if (firstAsleepStart == null) firstAsleepStart = new Date(s).getTime();
      // Brief LIGHT < 5 min counts as part of "sound" sleep — micro-arousal
      // between stable blocks rather than a meaningful waking event.
      if (durMin < BRIEF_LIGHT_MAX) soundSleepRaw += durMin;
    }
  }
  const timeToSoundSleep = (firstAsleepStart != null && firstDeepStart != null && firstDeepStart > firstAsleepStart)
    ? Math.round((firstDeepStart - firstAsleepStart) / 60000)
    : null;
  const soundSleepMin = soundSleepRaw > 0 ? Math.round(soundSleepRaw) : null;

  return {
    value: minutesAsleep,
    date: dateStr,
    duration_min:    minutesAsleep,
    efficiency,
    deep_min:    deep,
    light_min:   light,
    rem_min:     rem,
    wake_min:    wake,
    start_min:   startMin,
    end_min:     endMin,
    type:        best.type,
    googleMinutesAsleep,
    // Sleep Quality sub-metrics — emitted as their own metric_types in
    // the upsert so the Wellness UI can render them as standalone tiles.
    restlessness_min:        restlessnessMin  || null,
    interruptions_min:       interruptionsMin || null,
    full_awakenings:         fullAwakenings   || null,
    // Field name kept as time_to_fall_asleep_min for metric_type stability;
    // the value is Fitbit's "Time to Sound Sleep" (first asleep → first DEEP).
    time_to_fall_asleep_min: timeToSoundSleep,
    sound_sleep_min:         soundSleepMin,
    // _diag — calibration log payload. Strip once Sound Sleep + Restlessness
    // derivations match the Fitbit app within ±5 across at least 5
    // consecutive nights, which they currently don't.
    _diag: {
      stagesCompact: stageSegs.map(seg => {
        const dm = (seg.startTime && seg.endTime)
          ? (new Date(seg.endTime) - new Date(seg.startTime)) / 60000
          : null;
        return `${seg.type || '?'}:${dm != null ? dm.toFixed(1) : '?'}m`;
      }).join(' '),
      restlessnessMin,
      interruptionsMin,
      fullAwakenings,
      timeToSoundSleep,
      soundSleepMin,
    },
  };
}

// 10a. Workout list — list `exercise` and filter to those whose civilStartTime
//   matches dateStr. Returns count + brief summaries (skipping GPS/TCX).
export async function fetchWorkoutsForDate(accessToken, dateStr) {
  const data = await ghGet(accessToken, '/users/me/dataTypes/exercise/dataPoints?pageSize=30');
  const points = data?.dataPoints || [];
  const todays = [];
  for (const p of points) {
    const e = p?.exercise;
    if (!e) continue;
    const startDate = e.interval?.civilStartTime?.date;
    if (_dateMatches(startDate, dateStr)) {
      todays.push({
        name:           e.displayName,
        type:           e.exerciseType,
        startTime:      e.interval?.startTime,
        durationActive: e.activeDuration,
        distanceKm:     e.metricsSummary?.distanceMillimeters
                          ? +(e.metricsSummary.distanceMillimeters / 1_000_000).toFixed(2) : null,
        caloriesKcal:   e.metricsSummary?.caloriesKcal ?? null,
        avgHr:          parseInt(e.metricsSummary?.averageHeartRateBeatsPerMinute, 10) || null,
        steps:          parseInt(e.metricsSummary?.steps, 10) || null,
      });
    }
  }
  return { value: todays.length, date: dateStr, workouts: todays };
}

// 11. Profile — getProfile returns name/age/strides only. NO DOB/gender.
export async function fetchProfile(accessToken) {
  return ghGet(accessToken, '/users/me/profile');
}

// 11. Weight — list `weight`. Most-recent value, in kg.
export async function fetchWeight(accessToken) {
  const data = await ghGet(accessToken, '/users/me/dataTypes/weight/dataPoints?pageSize=5');
  const point = (data?.dataPoints || [])[0];
  const grams = parseInt(point?.weight?.weightGrams, 10);
  if (!Number.isFinite(grams)) return { value: null, note: 'No weight points', rawResponse: data };
  return {
    value: +(grams / 1000).toFixed(2),
    sampledAt: point?.weight?.sampleTime?.physicalTime || null,
  };
}

// 11. Height — list `height`. Most-recent value, in cm.
export async function fetchHeight(accessToken) {
  const data = await ghGet(accessToken, '/users/me/dataTypes/height/dataPoints?pageSize=5');
  const point = (data?.dataPoints || [])[0];
  const mm = parseInt(point?.height?.heightMillimeters, 10);
  if (!Number.isFinite(mm)) return { value: null, note: 'No height points', rawResponse: data };
  return {
    value: +(mm / 10).toFixed(1),
    sampledAt: point?.height?.sampleTime?.physicalTime || null,
  };
}

// users.getIdentity — bridges Google's user ID to the legacy Fitbit
// encodedId (when the user has migrated their Fitbit account to Google).
export async function fetchIdentity(accessToken) {
  return ghGet(accessToken, '/users/me/identity');
}

// ─────────────────────────────────────────────────────────────────────────
// Production sync: pull every metric for one date and upsert to wellness_data.
//
// Design decisions:
//  - Writes with source='fitbit' (NOT 'google_health'). The data is the
//    same data Fitbit Web API returned; only the API pipe changed.
//    Keeping the tag stable means existing wellness charts, calibration
//    logs, scoring, and Trace AI prompts continue to work unchanged.
//  - Sleep score is computed here from the same components Fitbit's old
//    sync used (dur/deep/rem/spo2/hrv/eff). Matches the formula in
//    server/routes/fitbit.js _syncDate() so the calibration log stays
//    consistent across the API swap.
//  - Misses (no data on a metric for a given date) are SKIPPED, not
//    written as null. That mirrors the legacy Fitbit sync behavior and
//    avoids overwriting a real value with a null on a partial-sync day.
// ─────────────────────────────────────────────────────────────────────────
export async function syncDateGoogleHealth(db, userId, dateStr, clientId, clientSecret, logger) {
  const accessToken = await getAccessToken(userId, clientId, clientSecret);
  const metrics = {};

  // Helper: run an adapter, write its value if present
  async function pull(key, fn) {
    try {
      const r = await fn(accessToken, dateStr);
      if (r && r.value != null) metrics[key] = r.value;
      return r;
    } catch (e) {
      if (logger) logger.warn(`[google-health] sync ${key} ${dateStr} failed: ${e.message}`);
      return null;
    }
  }

  // Daily-summary metrics (fast, parallel-safe)
  await Promise.all([
    pull('steps',                fetchDailySteps),
    pull('distance_km',          fetchDailyDistance),
    pull('floors',               fetchDailyFloors),
    pull('active_minutes',       fetchDailyActiveMinutes),
    pull('calories_out',         fetchDailyCaloriesOut),
    pull('active_zone_minutes',  fetchDailyActiveZoneMinutes),
    pull('resting_hr',           fetchDailyRestingHR),
    pull('hrv_daily_rmssd',      fetchDailyHRV),
    pull('spo2_avg',             fetchDailySpO2),
    pull('skin_temp_variation',  fetchDailySkinTempDelta),
    pull('respiratory_rate',     fetchDailyRespiratoryRate),
    pull('vo2_max',              fetchDailyVO2Max),
  ]);

  // VO2 max range string for the Wellness page tile. Legacy Fitbit's API
  // returned a range like "39-43" directly; Google Health returns a single
  // number. Synthesize the same ±2 5-point band Fitbit publishes (e.g.
  // value 42 → "40-44") so the tile reads identically across pipes.
  // Skipped entirely when vo2_max is null — empty tile is preferable to
  // a stale carry-forward.
  if (metrics.vo2_max != null) {
    const v = Number(metrics.vo2_max);
    if (Number.isFinite(v)) {
      metrics.vo2_max_range = `${Math.round(v - 2)}-${Math.round(v + 2)}`;
    }
  }

  // Sleep needs a richer extraction — pull and unpack the sub-fields
  const sleep = await pull('sleep_duration_min', fetchSleepForDate);
  if (sleep && sleep.value != null) {
    if (sleep.efficiency  != null) metrics.sleep_efficiency  = sleep.efficiency;
    if (sleep.deep_min    != null) metrics.sleep_deep_min    = sleep.deep_min;
    if (sleep.light_min   != null) metrics.sleep_light_min   = sleep.light_min;
    if (sleep.rem_min     != null) metrics.sleep_rem_min     = sleep.rem_min;
    if (sleep.wake_min    != null) metrics.sleep_wake_min    = sleep.wake_min;
    if (sleep.start_min   != null) metrics.sleep_start_min   = sleep.start_min;
    if (sleep.end_min     != null) metrics.sleep_end_min     = sleep.end_min;
    // Sleep Quality (Fitbit Public Preview Sleep Score redesign)
    if (sleep.restlessness_min        != null) metrics.sleep_restlessness_min        = sleep.restlessness_min;
    if (sleep.interruptions_min       != null) metrics.sleep_interruptions_min       = sleep.interruptions_min;
    if (sleep.full_awakenings         != null) metrics.sleep_full_awakenings         = sleep.full_awakenings;
    if (sleep.time_to_fall_asleep_min != null) metrics.sleep_time_to_fall_asleep_min = sleep.time_to_fall_asleep_min;
    if (sleep.sound_sleep_min         != null) metrics.sleep_sound_sleep_min         = sleep.sound_sleep_min;
    // Calibration log — one line per sync with derived Sleep Quality
    // values + the per-segment stage breakdown so we can compare against
    // what Fitbit's app shows. Useful while Sound Sleep + Restlessness
    // are still being tuned. Strip once they're dialed in.
    if (logger && sleep._diag) {
      logger.info(`[google-health] sleep quality ${dateStr}: rest=${sleep._diag.restlessnessMin}m int=${sleep._diag.interruptionsMin}m/${sleep._diag.fullAwakenings} ttss=${sleep._diag.timeToSoundSleep}m sound=${sleep._diag.soundSleepMin}m | stages: ${sleep._diag.stagesCompact}`);
    }
  }

  // Sleep score — computed locally from the same components the legacy
  // Fitbit sync used. Formula matches fitbit.js _syncDate so calibration
  // numbers stay comparable across the API swap. (See
  // reference_fitbit_scores.md for the running tally / formula version.)
  if (metrics.sleep_duration_min != null) {
    const dur  = metrics.sleep_duration_min;
    const deep = metrics.sleep_deep_min ?? 0;
    const rem  = metrics.sleep_rem_min  ?? 0;
    const spo2 = metrics.spo2_avg;
    const hrv  = metrics.hrv_daily_rmssd;
    const eff  = metrics.sleep_efficiency ?? null;
    // Duration scoring is piecewise. Above 6h (360m) the original linear
    // dur/440*30 holds and matches Fitbit's actual within ±1. Below 6h
    // Fitbit penalizes total sleep more aggressively than linear implies,
    // so the model needs a steeper ramp in that regime to match.
    let durPts;
    if (dur >= 440)      durPts = 30;
    else if (dur >= 360) durPts = (dur / 440) * 30;
    else                 durPts = Math.max(0, 6 + ((dur - 240) / 120) * 18.5);

    // deepRemPct cap on short nights. The qualPts + qualBonus components
    // reward high deep+rem ratios assuming the night was full length where
    // >35% deep+rem reads as genuinely excellent recovery. On a 4-5h night
    // deep+rem can easily hit 45-55% (deep is deep regardless of total
    // duration) but Fitbit's actual score doesn't reward that — it reads
    // as compressed/disrupted sleep. After the duration piecewise above
    // landed, nine ground-truth nights (May 7, 12, 14, 17, 20, 21, 22, 23,
    // 24) still overshot by mean +5.22. May 22 (dur=321, ratio 0.53) was
    // the worst at +8; May 23 (dur=259, ratio 0.45) was +5. Capping the
    // ratio at 0.40 below 360m and 0.35 below 300m attacks both: May 22
    // drops to +4, May 23 to +1, while the moderate-ratio short nights
    // (May 7/12/17 with ratios 0.30-0.37) are unaffected because they
    // never hit the cap. Longer nights also unaffected.
    const deepRemPctRaw = (deep + rem) / dur;
    let deepRemPct = deepRemPctRaw;
    if (dur < 300)      deepRemPct = Math.min(deepRemPctRaw, 0.35);
    else if (dur < 360) deepRemPct = Math.min(deepRemPctRaw, 0.40);
    const qualPts  = Math.min(40, deepRemPct / 0.25 * 40);
    const qualBonus = Math.min(6, Math.max(0, (deepRemPct - 0.35) / 0.15 * 6));
    const spo2Pts = spo2 != null ? Math.min(15, Math.max(0, (spo2 - 87) / 9 * 15)) : 11;
    const hrvPts  = hrv  != null ? Math.min(12, Math.max(0, (hrv  - 5)  / 45 * 12)) : 8;
    const effPts  = eff  != null ? Math.min(3,  Math.max(0, (eff  - 85) * 0.3))    : 0;
    metrics.sleep_score = Math.min(100, Math.round(durPts + qualPts + qualBonus + spo2Pts + hrvPts + effPts));
    if (logger) logger.debug(`[google-health] sleep_score ${dateStr}: dur=${dur}m deep=${deep}m rem=${rem}m spo2=${spo2} hrv=${hrv} eff=${eff} → ${metrics.sleep_score}`);
  }

  // Upsert — same shape as legacy Fitbit sync, source='fitbit' for visual
  // continuity on the Wellness page.
  const upsert = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
    VALUES (?, ?, 'fitbit', ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
      value = excluded.value, synced_at = excluded.synced_at
  `);
  db.transaction(() => {
    for (const [type, value] of Object.entries(metrics)) {
      if (value != null) upsert.run(userId, dateStr, type, value);
    }
  })();

  return metrics;
}
