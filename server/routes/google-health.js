/**
 * Google Health API routes — successor to Fitbit Web API (Sept 2026 cutoff).
 *
 * MVP scope: enough to prove OAuth + one data fetch end-to-end. Once verified,
 * the rest of the data-type adapters follow the same `dailyRollUp` pattern.
 *
 * Routes (all require auth, mounted at /api/wellness/google-health):
 *   GET    /config       — read user's client_id + redirect_uri (no secret)
 *   PUT    /config       — save client_id, client_secret, redirect_uri
 *   GET    /status       — connected, configured, googleUserId, expiresAt
 *   GET    /authorize    — return Google OAuth URL with PKCE (?native=1 for mobile)
 *   GET    /callback     — receive Google redirect, exchange code for tokens
 *   DELETE /disconnect   — revoke + clear tokens
 *   GET    /smoke-steps  — fetch today's steps via dailyRollUp (smoke test)
 *
 * Mirrors server/routes/fitbit.js intentionally — when this is stable we'll
 * either consolidate the two behind a shared OAuth helper or keep them
 * parallel until the Fitbit Web API shutoff.
 */
import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import {
  GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GOOGLE_HEALTH_SCOPES,
  getTokens, saveTokens, deleteTokens,
  getAccessToken, fetchIdentity,
  fetchDailySteps, fetchDailyDistance, fetchDailyFloors,
  fetchDailyActiveMinutes, fetchDailyCaloriesOut, fetchDailyActiveZoneMinutes,
  fetchDailyRestingHR, fetchDailyHRV, fetchDailySpO2,
  fetchDailySkinTempDelta, fetchDailyRespiratoryRate, fetchDailyVO2Max,
  fetchSleepForDate, fetchWorkoutsForDate,
  fetchProfile, fetchWeight, fetchHeight,
  syncDateGoogleHealth,
} from '../lib/google-health.js';
import { logger } from '../logger.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : 0;

// ── PKCE state helpers (provider='google_health' in oauth_state table) ──────
function _pkceSet(state, userId, codeVerifier, isNative = false) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO oauth_state (state, user_id, provider, data, expires_at)
              VALUES (?, ?, 'google_health', ?, ?)`)
    .run(state, userId, JSON.stringify({ codeVerifier, isNative }), expiresAt);
  db.prepare(`DELETE FROM oauth_state WHERE expires_at < datetime('now')`).run();
}
function _pkceGet(state) {
  const row = db.prepare(`SELECT * FROM oauth_state WHERE state = ? AND provider = 'google_health'`).get(state);
  if (!row) return null;
  db.prepare(`DELETE FROM oauth_state WHERE state = ?`).run(state);
  if (row.expires_at < new Date().toISOString()) return null;
  const data = JSON.parse(row.data);
  return { codeVerifier: data.codeVerifier, userId: row.user_id, isNative: !!data.isNative };
}

// ── Per-user credential lookup (matches fitbit.js _userCfg pattern) ────────
function _userCfg(key, userId) {
  if (userMgmtActive() && userId != null && userId !== 0) {
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
    if (row?.value != null && row.value !== '' && row.value !== '""') {
      try { return JSON.parse(row.value) || ''; } catch { return row.value; }
    }
  }
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row?.value || '';
}

// ── GET /config ─────────────────────────────────────────────────────────────
router.get('/config', wrap((req, res) => {
  const u = uid(req);
  res.json({
    client_id:    _userCfg('google_health_client_id',    u),
    redirect_uri: _userCfg('google_health_redirect_uri', u),
  });
}));

// ── PUT /config ─────────────────────────────────────────────────────────────
router.put('/config', wrap((req, res) => {
  const { client_id, client_secret, redirect_uri } = req.body;
  if (userMgmtActive() && req.user) {
    const save = db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
    db.transaction(() => {
      if (client_id     !== undefined) save.run(req.user.id, 'google_health_client_id',     JSON.stringify(client_id));
      if (client_secret !== undefined) save.run(req.user.id, 'google_health_client_secret', JSON.stringify(client_secret));
      if (redirect_uri  !== undefined) save.run(req.user.id, 'google_health_redirect_uri',  JSON.stringify(redirect_uri));
    })();
  } else {
    const save = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)');
    db.transaction(() => {
      if (client_id     !== undefined) save.run('google_health_client_id',     client_id);
      if (client_secret !== undefined) save.run('google_health_client_secret', client_secret);
      if (redirect_uri  !== undefined) save.run('google_health_redirect_uri',  redirect_uri);
    })();
  }
  res.json({ ok: true });
}));

// ── GET /status ─────────────────────────────────────────────────────────────
router.get('/status', wrap((req, res) => {
  const u = uid(req);
  const tokens = getTokens(u);
  const clientId = _userCfg('google_health_client_id', u);
  res.json({
    connected:      !!tokens,
    configured:     !!clientId,
    googleUserId:   tokens?.google_user_id || null,
    fitbitUserId:   tokens?.fitbit_user_id || null,  // legacy bridge for cross-ref
    expiresAt:      tokens?.expires_at     || null,
  });
}));

// ── GET /authorize ──────────────────────────────────────────────────────────
router.get('/authorize', wrap((req, res) => {
  const u = uid(req);
  const clientId    = _userCfg('google_health_client_id',    u);
  const redirectUri = _userCfg('google_health_redirect_uri', u);
  if (!clientId || !redirectUri) {
    return res.status(400).json({
      error: 'Google Health client_id and redirect_uri must be configured in Settings → Wellness.',
    });
  }

  const codeVerifier  = randomBytes(64).toString('base64url').slice(0, 128);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state         = randomBytes(16).toString('hex');

  const isNativeOAuth = req.query.native === '1';
  _pkceSet(state, u, codeVerifier, isNativeOAuth);

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('response_type',         'code');
  url.searchParams.set('client_id',             clientId);
  url.searchParams.set('redirect_uri',          redirectUri);
  url.searchParams.set('scope',                 GOOGLE_HEALTH_SCOPES.join(' '));
  url.searchParams.set('code_challenge',        codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state',                 state);
  // access_type=offline + prompt=consent → ensures we receive a refresh_token
  // even on subsequent authorizations.
  url.searchParams.set('access_type',           'offline');
  url.searchParams.set('prompt',                'consent');

  res.json({ url: url.toString() });
}));

// ── GET /callback ───────────────────────────────────────────────────────────
router.get('/callback', wrap(async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?google_health=error&msg=${encodeURIComponent(error)}#/wellness`);
  }

  const pkce = _pkceGet(state);
  if (!pkce) {
    return res.redirect('/?google_health=error&msg=invalid_state#/wellness');
  }
  const _redir = (path) => pkce.isNative ? `nutritrace://callback${path}` : path;

  const clientId     = _userCfg('google_health_client_id',     pkce.userId);
  const clientSecret = _userCfg('google_health_client_secret', pkce.userId);
  const redirectUri  = _userCfg('google_health_redirect_uri',  pkce.userId);

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      client_id:     clientId,
      client_secret: clientSecret,
      code_verifier: pkce.codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    return res.redirect(_redir(`/?google_health=error&msg=${encodeURIComponent('Token exchange failed: ' + body.slice(0, 120))}#/wellness`));
  }

  const td = await tokenRes.json();
  const expiresAt = new Date(Date.now() + (td.expires_in || 3600) * 1000).toISOString();

  // Best-effort identity fetch — gives us google_user_id and (if migrated)
  // the legacy Fitbit encodedId for cross-referencing existing data.
  let googleUserId = null;
  let fitbitUserId = null;
  try {
    const identity = await fetchIdentity(td.access_token);
    googleUserId = identity?.googleUserId || identity?.userId || null;
    fitbitUserId = identity?.fitbitUserId || identity?.fitbitEncodedId || null;
  } catch { /* identity lookup failed — continue with token storage */ }

  saveTokens(pkce.userId, {
    access_token:   td.access_token,
    refresh_token:  td.refresh_token,
    expires_at:     expiresAt,
    google_user_id: googleUserId,
    fitbit_user_id: fitbitUserId,
  });

  // Fire-and-forget: immediately sync today so the user sees data on the
  // Wellness page they're about to land on. Don't block the redirect on it.
  const today = new Date().toISOString().slice(0, 10);
  syncDate(pkce.userId, today).catch(e => logger.warn(`[google-health] post-callback sync failed: ${e.message}`));

  res.redirect(_redir('/?google_health=connected#/wellness'));
}));

// ── DELETE /disconnect ──────────────────────────────────────────────────────
router.delete('/disconnect', wrap(async (req, res) => {
  const u = uid(req);
  const tokens = getTokens(u);
  if (tokens?.access_token) {
    // Best-effort revoke on Google's side. Don't fail the disconnect if the
    // revoke call errors — the local clear below is the source of truth.
    try {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokens.access_token)}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch { /* ignore */ }
  }
  deleteTokens(u);
  res.json({ ok: true });
}));

// ── GET /smoke-steps — kept for backward compat; just steps ────────────────
router.get('/smoke-steps', wrap(async (req, res) => {
  const u = uid(req);
  const clientId     = _userCfg('google_health_client_id',     u);
  const clientSecret = _userCfg('google_health_client_secret', u);
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Not configured' });
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const accessToken = await getAccessToken(u, clientId, clientSecret);
    const result = await fetchDailySteps(accessToken, date);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}));

// ── POST /sync — write a date or range to wellness_data table ──────────────
//
// Body: { date: 'YYYY-MM-DD' } for one day, or { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } for a range.
// Writes are tagged source='fitbit' (transparent migration — the Wellness page
// shows the same data labelled the same way). Existing rows are upserted,
// missing values are skipped (not nulled).
router.post('/sync', wrap(async (req, res) => {
  const u = uid(req);
  const clientId     = _userCfg('google_health_client_id',     u);
  const clientSecret = _userCfg('google_health_client_secret', u);
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Not configured' });

  let dates = [];
  if (req.body.date) {
    dates = [req.body.date];
  } else if (req.body.from && req.body.to) {
    const from = new Date(`${req.body.from}T00:00:00Z`);
    const to   = new Date(`${req.body.to  }T00:00:00Z`);
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
  } else {
    return res.status(400).json({ error: 'Provide { date } or { from, to }' });
  }

  const results = {};
  for (const date of dates) {
    try {
      const metrics = await syncDateGoogleHealth(db, u, date, clientId, clientSecret, logger);
      results[date] = { ok: true, count: Object.keys(metrics).length, metrics };
    } catch (e) {
      results[date] = { ok: false, error: e.message };
    }
  }
  res.json({ ok: true, dates: dates.length, results });
}));

// ── GET /test-all — run every data-type adapter for a date and report ──────
//
// MVP test scaffold: runs each adapter independently, isolates failures so
// one broken metric doesn't stop the others, returns a per-metric result
// object so the UI can render a pass/fail table. Once everything is green
// we wire these into the actual sync loop.
router.get('/test-all', wrap(async (req, res) => {
  const u = uid(req);
  const clientId     = _userCfg('google_health_client_id',     u);
  const clientSecret = _userCfg('google_health_client_secret', u);
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Not configured' });
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  let accessToken;
  try {
    accessToken = await getAccessToken(u, clientId, clientSecret);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Token unavailable: ' + e.message });
  }

  // Each entry: [key, label, async function returning adapter result]
  const tests = [
    ['steps',                'Steps',                  () => fetchDailySteps(accessToken, date)],
    ['distance_km',          'Distance (km)',          () => fetchDailyDistance(accessToken, date)],
    ['floors',               'Floors',                 () => fetchDailyFloors(accessToken, date)],
    ['active_minutes',       'Active minutes (mod+vig)', () => fetchDailyActiveMinutes(accessToken, date)],
    ['calories_out',         'Calories burned',        () => fetchDailyCaloriesOut(accessToken, date)],
    ['active_zone_minutes',  'Active zone minutes',    () => fetchDailyActiveZoneMinutes(accessToken, date)],
    ['resting_hr',           'Resting heart rate',     () => fetchDailyRestingHR(accessToken, date)],
    ['hrv_daily_rmssd',      'HRV (daily RMSSD)',      () => fetchDailyHRV(accessToken, date)],
    ['spo2_avg',             'SpO2 (daily avg)',       () => fetchDailySpO2(accessToken, date)],
    ['skin_temp_variation',  'Skin temp variation',    () => fetchDailySkinTempDelta(accessToken, date)],
    ['respiratory_rate',     'Respiratory rate',       () => fetchDailyRespiratoryRate(accessToken, date)],
    ['vo2_max',              'VO2 max',                () => fetchDailyVO2Max(accessToken, date)],
    ['sleep',                'Sleep',                  () => fetchSleepForDate(accessToken, date)],
    ['workouts',             'Workouts',               () => fetchWorkoutsForDate(accessToken, date)],
    ['profile',              'Profile',                () => fetchProfile(accessToken)],
    ['weight',               'Weight (most recent)',   () => fetchWeight(accessToken)],
    ['height',               'Height (most recent)',   () => fetchHeight(accessToken)],
    ['identity',             'Identity bridge',        () => fetchIdentity(accessToken)],
  ];

  const results = {};
  await Promise.all(tests.map(async ([key, label, fn]) => {
    try {
      results[key] = { label, ok: true, result: await fn() };
    } catch (e) {
      results[key] = { label, ok: false, error: e.message };
    }
  }));

  res.json({ ok: true, date, results });
}));

// ── Drop-in replacements for fitbit.js exports ─────────────────────────────
//
// scheduler.js (and any other call site) imports { syncDate, syncWorkouts }
// from './routes/fitbit.js'. We mirror those exports here so the scheduler
// can dispatch to either module based on which tokens the user has —
// google_health_tokens (new pipe) vs fitbit_tokens (legacy) — without any
// other changes to the calling code. Same signatures, same return shapes.

/** Sync one day's metrics for a user via the Google Health API.
 *  Same signature + return shape as fitbit.js's syncDate() so scheduler.js
 *  can swap modules transparently. */
export async function syncDate(userId, dateStr) {
  const clientId     = _userCfg('google_health_client_id',     userId);
  const clientSecret = _userCfg('google_health_client_secret', userId);
  if (!clientId || !clientSecret) {
    return { metrics: {}, errors: ['Google Health credentials not configured'] };
  }
  try {
    const metrics = await syncDateGoogleHealth(db, userId, dateStr, clientId, clientSecret, logger);
    // Snapshot readiness + resilience for today only — past days keep the
    // scores they had when they were locked in. The legacy fitbit.js sync
    // path does this inline; we mirror it here so users on the Google
    // Health pipe get the same downstream computed scores.
    const todayDate = new Date().toISOString().slice(0, 10);
    if (dateStr === todayDate) {
      try {
        const { snapshotScores } = await import('../lib/wellness-scores.js');
        snapshotScores(userId, dateStr);
      } catch (e) {
        logger.warn(`[google-health] snapshotScores failed for ${dateStr}: ${e.message}`);
      }
    }
    return { metrics, errors: [] };
  } catch (e) {
    return { metrics: {}, errors: [e.message] };
  }
}

/** Sync workouts (exercises) over a date range via the Google Health API.
 *  Mirrors fitbit.js's syncWorkouts() signature/return shape. Iterates the
 *  range one day at a time, fetches that day's exercises, upserts to the
 *  shared workouts table with source='fitbit' for visual continuity. */
export async function syncWorkouts(userId, from, to) {
  const clientId     = _userCfg('google_health_client_id',     userId);
  const clientSecret = _userCfg('google_health_client_secret', userId);
  if (!clientId || !clientSecret) return { ok: false, synced: 0, total: 0, error: 'Not configured' };

  const accessToken = await getAccessToken(userId, clientId, clientSecret);

  // Iterate dates inclusive
  const start = new Date(`${from}T00:00:00Z`);
  const end   = new Date(`${to  }T00:00:00Z`);
  const dates = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  const upsert = db.prepare(`
    INSERT INTO workouts (user_id, source, source_id, date, activity_type, activity_name, start_time, duration_ms, distance_km, calories, avg_hr, max_hr, steps, has_gps, updated_at)
    VALUES (?, 'fitbit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, source, source_id) DO UPDATE SET
      date          = excluded.date,
      activity_type = excluded.activity_type,
      activity_name = excluded.activity_name,
      start_time    = excluded.start_time,
      duration_ms   = excluded.duration_ms,
      distance_km   = excluded.distance_km,
      calories      = excluded.calories,
      avg_hr        = excluded.avg_hr,
      max_hr        = excluded.max_hr,
      steps         = excluded.steps,
      has_gps       = excluded.has_gps,
      updated_at    = excluded.updated_at
  `);

  let synced = 0, total = 0;
  for (const dateStr of dates) {
    try {
      const data = await fetch(`https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints?pageSize=100`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
      }).then(r => r.json());
      const points = data?.dataPoints || [];
      // Read the user's IANA timezone (set by App.svelte on first mount
      // via Intl.DateTimeFormat().resolvedOptions().timeZone). Used as the
      // fallback when the workout's startTime is UTC-only (Z-suffixed) and
      // civilStartTime.date isn't trustworthy. Empty string falls through
      // to server-local, which is correct only if the server runs in the
      // user's TZ.
      const userTz = _userCfg('timezone', userId) || '';
      for (const p of points) {
        const e = p?.exercise;
        if (!e) continue;
        // Derive the workout's local calendar date. Three sources, in
        // order of trustworthiness:
        //   1. Explicit `+/-HH:MM` offset in startTime — date portion IS
        //      the wall-clock local date at that offset.
        //   2. UTC instant + user's IANA timezone — convert via
        //      Intl.DateTimeFormat to derive the local calendar date.
        //   3. civilStartTime.date — Google says this is "local of
        //      device" but it's been observed UTC-biased for evening
        //      workouts crossing midnight UTC.
        const startTimeStr = e.interval?.startTime || '';
        let localStr = null;
        let dateSource = null;
        if (startTimeStr) {
          const m = startTimeStr.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
          if (m && m[2] && m[2] !== 'Z') {
            // Has explicit offset → date portion is wall-clock local
            localStr = m[1];
            dateSource = 'startTime-offset';
          } else if (m && m[2] === 'Z' && userTz) {
            // UTC instant + user TZ → derive local date via Intl
            try {
              localStr = new Intl.DateTimeFormat('sv-SE', { timeZone: userTz })
                .format(new Date(startTimeStr));
              dateSource = `userTz=${userTz}`;
            } catch {}
          }
        }
        const civilDate = e.interval?.civilStartTime?.date;
        const civilStr = civilDate
          ? `${civilDate.year}-${String(civilDate.month).padStart(2,'0')}-${String(civilDate.day).padStart(2,'0')}`
          : null;
        const startStr = localStr || civilStr || startTimeStr.slice(0, 10);
        if (!dateSource && civilStr) dateSource = 'civilStartTime';

        // Quieter post-confirmation: only log when the resolution falls
        // through to the raw startTime slice (no offset, no userTz, no
        // civilStartTime) — that's the unreliable case we want to spot.
        // Verified 2026-05-06 against real probe data: Google returns
        // Z-suffixed startTime + null civilStartTime, so the user-TZ
        // branch is the dominant path.
        if (!dateSource) {
          logger.info(`[google-health] workout date fallback — startTime=${startTimeStr} (no offset, no userTz, no civilStartTime) → ${startStr}`);
        }

        if (startStr !== dateStr) continue;
        total++;
        const sourceId = (p.name || '').split('/').pop() || `${e.interval?.startTime || ''}`;
        const startTime = e.interval?.startTime || null;
        const durationSeconds = parseInt(String(e.activeDuration || '').replace(/s$/, ''), 10);
        const durationMs = Number.isFinite(durationSeconds) ? durationSeconds * 1000 : null;
        const distanceKm = e.metricsSummary?.distanceMillimeters
          ? +(e.metricsSummary.distanceMillimeters / 1_000_000).toFixed(3) : null;
        const calories = e.metricsSummary?.caloriesKcal != null ? Math.round(e.metricsSummary.caloriesKcal) : null;
        const avgHr = parseInt(e.metricsSummary?.averageHeartRateBeatsPerMinute, 10) || null;
        // Peak HR isn't on Exercise.metricsSummary in the v4 schema. Roll up
        // `heart-rate` over the workout's interval and read beatsPerMinuteMax.
        // Best-effort — failures (no HR data, transient errors) just leave
        // max_hr null so the legacy code paths gracefully hide the field.
        let maxHr = null;
        try {
          if (e.interval?.startTime && e.interval?.endTime) {
            const hrRollup = await fetch(
              'https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints:rollUp',
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type':  'application/json',
                  'Accept':        'application/json',
                },
                body: JSON.stringify({
                  range: { startTime: e.interval.startTime, endTime: e.interval.endTime },
                  windowSize: '86400s', // single window covering the whole workout
                }),
              }
            ).then(r => r.json());
            const point = (hrRollup?.rollupDataPoints || [])[0];
            const max = parseInt(point?.heartRate?.beatsPerMinuteMax, 10);
            if (Number.isFinite(max)) maxHr = max;
          }
        } catch (err) {
          logger.debug(`[google-health] peak HR fetch failed for workout ${dateStr}: ${err.message}`);
        }
        const steps = parseInt(e.metricsSummary?.steps, 10) || null;
        const hasGps = e.exerciseMetadata?.hasGps ? 1 : 0;
        upsert.run(userId, sourceId, dateStr, e.exerciseType || null, e.displayName || null,
          startTime, durationMs, distanceKm, calories, avgHr, maxHr, steps, hasGps);
        synced++;
      }
    } catch (err) {
      logger.warn(`[google-health] workout sync ${dateStr} failed: ${err.message}`);
    }
  }
  return { ok: true, synced, total };
}

// Re-export from fitbit.js — alerts logic operates on metric values, not
// on the API source, so it works for either pipe.
export { _checkWellnessAlerts } from './fitbit.js';

export default router;
