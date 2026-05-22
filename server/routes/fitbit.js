import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import db from '../db.js';
import { wrap, logger } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// In single-user mode, use user_id = 0 (auto-increment users start at 1, so no collision)
const uid = req => userMgmtActive() ? req.user.id : 0;

// DB-backed PKCE helpers — survive server restarts during the OAuth redirect dance
function _pkceSet(state, userId, codeVerifier, isNative = false) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO oauth_state (state, user_id, provider, data, expires_at)
              VALUES (?, ?, 'fitbit', ?, ?)`).run(state, userId, JSON.stringify({ codeVerifier, isNative }), expiresAt);
  // Clean up any expired states
  db.prepare(`DELETE FROM oauth_state WHERE expires_at < datetime('now')`).run();
}
function _pkceGet(state) {
  const row = db.prepare(`SELECT * FROM oauth_state WHERE state = ? AND provider = 'fitbit'`).get(state);
  if (!row) return null;
  db.prepare(`DELETE FROM oauth_state WHERE state = ?`).run(state);
  if (row.expires_at < new Date().toISOString()) return null;
  const data = JSON.parse(row.data);
  return { codeVerifier: data.codeVerifier, userId: row.user_id, isNative: !!data.isNative };
}

// Pipe dispatcher — when the user has google_health_tokens, route sync
// calls through the new Google Health API path. This lets the existing
// /sync and /workouts/sync routes (and any other call site that imports
// _syncDate / _syncWorkouts) transparently use whichever pipe the user
// is on, with no other code changes.
async function _hasGoogleHealthTokens(userId) {
  return !!db.prepare('SELECT 1 FROM google_health_tokens WHERE user_id=?').get(userId);
}
async function _dispatchSyncDate(userId, dateStr) {
  if (await _hasGoogleHealthTokens(userId)) {
    const { syncDate: ghSyncDate } = await import('./google-health.js');
    return ghSyncDate(userId, dateStr);
  }
  return _syncDate(userId, dateStr);
}
async function _dispatchSyncWorkouts(userId, from, to) {
  if (await _hasGoogleHealthTokens(userId)) {
    const { syncWorkouts: ghSyncWorkouts } = await import('./google-health.js');
    return ghSyncWorkouts(userId, from, to);
  }
  return _syncWorkouts(userId, from, to);
}

// Read credential: user_settings first (multi-user), app_config fallback (single-user / migration)
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

import { encrypt, decrypt } from '../lib/token-crypto.js';

function _getTokens(userId) {
  const row = db.prepare('SELECT * FROM fitbit_tokens WHERE user_id = ?').get(userId);
  if (!row) return row;
  return { ...row, access_token: decrypt(row.access_token), refresh_token: decrypt(row.refresh_token) };
}

async function _refresh(userId) {
  const tokens = _getTokens(userId);
  if (!tokens) throw Object.assign(new Error('Not connected to Fitbit'), { status: 401 });

  const res = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${_userCfg('fitbit_client_id', userId)}:${_userCfg('fitbit_client_secret', userId)}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
  });

  if (!res.ok) {
    db.prepare('DELETE FROM fitbit_tokens WHERE user_id = ?').run(userId);
    throw Object.assign(new Error('Fitbit token revoked — please reconnect.'), { status: 401 });
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  db.prepare(`
    UPDATE fitbit_tokens SET access_token=?, refresh_token=?, expires_at=? WHERE user_id=?
  `).run(encrypt(data.access_token), encrypt(data.refresh_token), expiresAt, userId);
  return data.access_token;
}

async function _token(userId) {
  const tokens = _getTokens(userId);
  if (!tokens) throw Object.assign(new Error('Not connected to Fitbit'), { status: 401 });
  // Refresh if expiring within 5 minutes
  if (new Date(tokens.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    return _refresh(userId);
  }
  return tokens.access_token;
}

async function _get(userId, path) {
  let tok = await _token(userId);
  let res = await fetch(`https://api.fitbit.com${path}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (res.status === 401) {
    tok = await _refresh(userId);
    res = await fetch(`https://api.fitbit.com${path}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fitbit API ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

// ── GET /config — read user's own credentials (client_id + redirect_uri only, no secret) ──
router.get('/config', wrap((req, res) => {
  const u = uid(req);
  res.json({
    client_id:    _userCfg('fitbit_client_id',    u),
    redirect_uri: _userCfg('fitbit_redirect_uri', u),
  });
}));

// ── PUT /config — save user's own credentials ─────────────────────────────────
router.put('/config', wrap((req, res) => {
  const { client_id, client_secret, redirect_uri } = req.body;
  if (userMgmtActive() && req.user) {
    const save = db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
    db.transaction(() => {
      if (client_id     !== undefined) save.run(req.user.id, 'fitbit_client_id',     JSON.stringify(client_id));
      if (client_secret !== undefined) save.run(req.user.id, 'fitbit_client_secret', JSON.stringify(client_secret));
      if (redirect_uri  !== undefined) save.run(req.user.id, 'fitbit_redirect_uri',  JSON.stringify(redirect_uri));
    })();
  } else {
    const save = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)');
    db.transaction(() => {
      if (client_id     !== undefined) save.run('fitbit_client_id',     client_id);
      if (client_secret !== undefined) save.run('fitbit_client_secret', client_secret);
      if (redirect_uri  !== undefined) save.run('fitbit_redirect_uri',  redirect_uri);
    })();
  }
  res.json({ ok: true });
}));

// ── GET /status ──────────────────────────────────────────────────────────────
//
// Returns connected: true if the user has EITHER legacy fitbit_tokens OR
// the new google_health_tokens — the Wellness page UI uses this to decide
// whether to show the Fitbit sync button, sync state badges, etc. After
// the Google Health migration cutover, most users have google_health_tokens
// but no fitbit_tokens, so checking only the legacy table would hide the
// Fitbit UI even though the integration is fully working.
router.get('/status', wrap((req, res) => {
  const u = uid(req);
  const fitbitTokens = _getTokens(u);
  const ghTokens = db.prepare('SELECT 1 FROM google_health_tokens WHERE user_id=?').get(u);
  const clientId = _userCfg('fitbit_client_id', u) || _userCfg('google_health_client_id', u);
  const lastSync = db.prepare('SELECT MAX(synced_at) as ts FROM wellness_data WHERE user_id=? AND source=?').get(u, 'fitbit');
  res.json({
    connected:     !!(fitbitTokens || ghTokens),
    configured:    !!clientId,
    fitbitUserId:  fitbitTokens?.fitbit_user_id || null,
    expiresAt:     fitbitTokens?.expires_at     || null,
    lastSyncedAt:  lastSync?.ts                 || null,
  });
}));

// ── GET /authorize — returns Fitbit OAuth URL using PKCE ─────────────────────
router.get('/authorize', wrap((req, res) => {
  const u = uid(req);
  const clientId   = _userCfg('fitbit_client_id',    u);
  const redirectUri = _userCfg('fitbit_redirect_uri', u);
  if (!clientId || !redirectUri) {
    return res.status(400).json({ error: 'Fitbit client_id and redirect_uri must be configured in Settings → Wellness.' });
  }

  const codeVerifier  = randomBytes(64).toString('base64url').slice(0, 128);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state         = randomBytes(16).toString('hex');

  const isNativeOAuth = req.query.native === '1';
  _pkceSet(state, u, codeVerifier, isNativeOAuth);

  const url = new URL('https://www.fitbit.com/oauth2/authorize');
  url.searchParams.set('response_type',          'code');
  url.searchParams.set('client_id',              clientId);
  url.searchParams.set('redirect_uri',           redirectUri);
  url.searchParams.set('scope',                  'activity heartrate sleep oxygen_saturation respiratory_rate cardio_fitness temperature profile location');
  url.searchParams.set('code_challenge',         codeChallenge);
  url.searchParams.set('code_challenge_method',  'S256');
  url.searchParams.set('state',                  state);
  url.searchParams.set('expires_in',             '604800'); // 7-day token

  res.json({ url: url.toString() });
}));

// ── GET /callback — Fitbit redirects here after authorization ────────────────
router.get('/callback', wrap(async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?fitbit=error&msg=${encodeURIComponent(error)}#/wellness`);
  }

  const pkce = _pkceGet(state);
  if (!pkce) {
    return res.redirect('/?fitbit=error&msg=invalid_state#/wellness');
  }
  const _redir = (path) => pkce.isNative ? `nutritrace://callback${path}` : path;

  const clientId    = _userCfg('fitbit_client_id',     pkce.userId);
  const clientSecret = _userCfg('fitbit_client_secret', pkce.userId);
  const redirectUri  = _userCfg('fitbit_redirect_uri',  pkce.userId);

  const tokenRes = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      code_verifier: pkce.codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    return res.redirect(_redir(`/?fitbit=error&msg=${encodeURIComponent('Token exchange failed: ' + body.slice(0, 80))}#/wellness`));
  }

  const td = await tokenRes.json();
  const expiresAt = new Date(Date.now() + td.expires_in * 1000).toISOString();

  db.prepare(`
    INSERT INTO fitbit_tokens (user_id, access_token, refresh_token, expires_at, fitbit_user_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token   = excluded.access_token,
      refresh_token  = excluded.refresh_token,
      expires_at     = excluded.expires_at,
      fitbit_user_id = excluded.fitbit_user_id
  `).run(pkce.userId, encrypt(td.access_token), encrypt(td.refresh_token), expiresAt, td.user_id || null);

  res.redirect(_redir('/?fitbit=connected#/wellness'));
}));

// ── Helper: sync a single date, return { metrics, errors } ───────────────────
async function _syncDate(u, dateStr) {
  const metrics = {};
  const errors  = [];

  // Activities (steps, distance, floors, active minutes, calories)
  try {
    const d = await _get(u, `/1/user/-/activities/date/${dateStr}.json`);
    const s = d.summary || {};
    metrics.steps          = s.steps ?? null;
    metrics.distance_km    = s.distances?.find(x => x.activity === 'total')?.distance ?? null;
    metrics.floors         = s.floors ?? null;
    metrics.active_minutes = ((s.fairlyActiveMinutes ?? 0) + (s.veryActiveMinutes ?? 0)) || null;
    metrics.calories_out   = s.caloriesOut ?? null;
  } catch (e) { errors.push('activities: ' + e.message); }

  // Sleep
  try {
    const d = await _get(u, `/1.2/user/-/sleep/date/${dateStr}.json`);
    const main = (d.sleep || []).find(s => s.isMainSleep) || d.sleep?.[0];
    if (main) {
      metrics.sleep_duration_min = main.minutesAsleep ?? null;
      metrics.sleep_efficiency   = main.efficiency    ?? null;
      const stg = main.levels?.summary;
      metrics.sleep_deep_min  = stg?.deep?.minutes  ?? null;
      metrics.sleep_light_min = stg?.light?.minutes ?? null;
      metrics.sleep_rem_min   = stg?.rem?.minutes   ?? null;
      metrics.sleep_wake_min  = stg?.wake?.minutes  ?? null;
      // Sleep timing for chronotype — Fitbit returns local time strings e.g. "2024-01-15T22:30:00.000"
      if (main.startTime) {
        const [, hh, mm] = main.startTime.match(/T(\d{2}):(\d{2})/) || [];
        if (hh != null) metrics.sleep_start_min = parseInt(hh) * 60 + parseInt(mm);
      }
      if (main.endTime) {
        const [, hh, mm] = main.endTime.match(/T(\d{2}):(\d{2})/) || [];
        if (hh != null) metrics.sleep_end_min = parseInt(hh) * 60 + parseInt(mm);
      }
    }
  } catch (e) { errors.push('sleep: ' + e.message); }

  // Resting heart rate
  try {
    const d = await _get(u, `/1/user/-/activities/heart/date/${dateStr}/1d.json`);
    metrics.resting_hr = d['activities-heart']?.[0]?.value?.restingHeartRate ?? null;
  } catch (e) { errors.push('heart: ' + e.message); }

  // HRV
  try {
    const d = await _get(u, `/1/user/-/hrv/date/${dateStr}.json`);
    metrics.hrv_daily_rmssd = d.hrv?.[0]?.value?.dailyRmssd ?? null;
  } catch (e) { errors.push('hrv: ' + e.message); }

  // SpO2
  try {
    const d = await _get(u, `/1/user/-/spo2/date/${dateStr}.json`);
    metrics.spo2_avg = d.value?.avg ?? null;
  } catch (e) { errors.push('spo2: ' + e.message); }

  // Skin temperature variation (Pixel Watch / Fitbit Sense/Versa 3+ only)
  try {
    const d = await _get(u, `/1/user/-/temp/skin/date/${dateStr}.json`);
    metrics.skin_temp_variation = d.tempSkin?.[0]?.value?.nightlyRelative ?? null;
  } catch (e) { errors.push('skin_temp: ' + e.message); }

  // Breathing rate
  try {
    const d = await _get(u, `/1/user/-/br/date/${dateStr}.json`);
    metrics.respiratory_rate = d.br?.[0]?.value?.breathingRate ?? null;
  } catch (e) { errors.push('breathing: ' + e.message); }

  // Active Zone Minutes
  try {
    const d = await _get(u, `/1/user/-/activities/active-zone-minutes/date/${dateStr}/1d.json`);
    metrics.active_zone_minutes = d['activities-active-zone-minutes']?.[0]?.value?.activeZoneMinutes ?? null;
  } catch (e) { errors.push('azm: ' + e.message); }

  // Cardio Fitness Score (Fitbit returns a range string like "39-43")
  // Store midpoint as vo2_max (numeric, used for charting/goals) and raw
  // range string as vo2_max_range (used for display)
  try {
    const d = await _get(u, `/1/user/-/cardioscore/date/${dateStr}.json`);
    const raw = d['cardioScore']?.[0]?.value?.vo2Max ?? null;
    if (typeof raw === 'number') {
      metrics.vo2_max = raw;
    } else if (typeof raw === 'string' && raw.includes('-')) {
      const [lo, hi] = raw.split('-').map(Number);
      metrics.vo2_max       = (lo + hi) / 2;
      metrics.vo2_max_range = raw.trim(); // e.g. "39-43"
    } else {
      metrics.vo2_max = raw != null ? Number(raw) : null;
    }
  } catch (e) { errors.push('vo2max: ' + e.message); }

  // Sleep Score — not in public Fitbit API; estimated from sleep components.
  // Formula: Duration (0-30) + Quality/deep+REM% (0-40) + QualBonus for >35% (0-8)
  //        + SpO2 restoration (0-15) + HRV (0-15) + Efficiency bonus (0-3)
  // Duration target: 455min (~7.5h) — Fitbit is generous with 7+ hours.
  // SpO2 null default: 11 (Fitbit doesn't penalize missing SpO2 heavily).
  // Efficiency bonus: rewards high sleep efficiency (>85%) up to 3 pts.
  if (metrics.sleep_duration_min != null) {
    const dur  = metrics.sleep_duration_min;
    const deep = metrics.sleep_deep_min ?? 0;
    const rem  = metrics.sleep_rem_min  ?? 0;
    const spo2 = metrics.spo2_avg;
    const hrv  = metrics.hrv_daily_rmssd;
    const eff  = metrics.sleep_efficiency ?? null;
    const durPts     = Math.min(30, (dur / 440) * 30);
    const deepRemPct = dur > 0 ? (deep + rem) / dur : 0;
    const qualPts    = Math.min(40, deepRemPct / 0.25 * 40);
    const qualBonus  = Math.min(6, Math.max(0, (deepRemPct - 0.35) / 0.15 * 6));
    const spo2Pts    = spo2 != null ? Math.min(15, Math.max(0, (spo2 - 87) / 9 * 15)) : 11;
    const hrvPts     = hrv  != null ? Math.min(12, Math.max(0, (hrv  -  5) / 45 * 12)) : 8;
    const effPts     = eff  != null ? Math.min(3, Math.max(0, (eff - 85) * 0.3)) : 0;
    metrics.sleep_score = Math.min(100, Math.round(durPts + qualPts + qualBonus + spo2Pts + hrvPts + effPts));
    logger.debug(`[fitbit] sleep_score ${dateStr}: dur=${dur}m deep=${deep}m rem=${rem}m spo2=${spo2} hrv=${hrv} eff=${eff} → ${durPts.toFixed(1)}+${qualPts.toFixed(1)}+${qualBonus.toFixed(1)}+${spo2Pts.toFixed(1)}+${hrvPts.toFixed(1)}+${effPts.toFixed(1)}=${metrics.sleep_score}`);
  }

  // Upsert all metrics
  const upsert = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
    VALUES (?, ?, 'fitbit', ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
      value = excluded.value, synced_at = excluded.synced_at
  `);
  db.transaction(() => {
    for (const [type, value] of Object.entries(metrics)) {
      if (value != null) upsert.run(u, dateStr, type, value);
    }
  })();

  logger.debug(`[fitbit] ${dateStr} readiness inputs: hrv=${metrics.hrv_daily_rmssd} rhr=${metrics.resting_hr} sleep=${metrics.sleep_score} cal=${metrics.calories_out} sleep_eff=${metrics.sleep_efficiency}`);

  // Snapshot readiness + stress only for today (past days keep their locked-in scores)
  const todayDate = new Date().toISOString().slice(0, 10);
  if (dateStr === todayDate) {
    const { snapshotScores } = await import('../lib/wellness-scores.js');
    snapshotScores(u, dateStr);
  }

  if (errors.length) logger.warn(`[fitbit] sync errors for ${dateStr}:`, errors);
  return { metrics, errors };
}


// ── Gotify wellness alerts ────────────────────────────────────────────────────
async function _checkWellnessAlerts(userId, metrics) {
  try {
    const { alertWellness } = await import('../lib/push-notify.js');
    const alerts = [];

    // HRV drop: check if today's HRV is 20%+ below 7-day average
    if (metrics.hrv_daily_rmssd != null) {
      const rows = db.prepare(
        `SELECT value FROM wellness_data WHERE user_id=? AND source='fitbit' AND metric_type='hrv_daily_rmssd' AND date >= date('now','-7 days') AND date < date('now')`
      ).all(userId);
      if (rows.length >= 3) {
        const avg = rows.reduce((s, r) => s + r.value, 0) / rows.length;
        if (metrics.hrv_daily_rmssd < avg * 0.8) {
          alerts.push(`HRV dropped to ${metrics.hrv_daily_rmssd.toFixed(1)}ms (7-day avg: ${avg.toFixed(1)}ms). Consider extra rest today.`);
        }
      }
    }

    // Sleep score trending down 3 days in a row
    if (metrics.sleep_score != null) {
      const rows = db.prepare(
        `SELECT value FROM wellness_data WHERE user_id=? AND source='fitbit' AND metric_type='sleep_score' AND date >= date('now','-3 days') AND date <= date('now') ORDER BY date`
      ).all(userId);
      if (rows.length >= 3 && rows.every((r, i) => i === 0 || r.value < rows[i-1].value)) {
        alerts.push(`Sleep score has declined 3 days in a row (${rows.map(r => Math.round(r.value)).join(' → ')}). Prioritize sleep tonight.`);
      }
    }

    // Resting HR spike: 5+ bpm above 7-day average
    if (metrics.resting_hr != null) {
      const rows = db.prepare(
        `SELECT value FROM wellness_data WHERE user_id=? AND source='fitbit' AND metric_type='resting_hr' AND date >= date('now','-7 days') AND date < date('now')`
      ).all(userId);
      if (rows.length >= 3) {
        const avg = rows.reduce((s, r) => s + r.value, 0) / rows.length;
        if (metrics.resting_hr > avg + 5) {
          alerts.push(`Resting HR elevated at ${Math.round(metrics.resting_hr)} bpm (7-day avg: ${Math.round(avg)} bpm). Could indicate stress, illness, or poor recovery.`);
        }
      }
    }

    for (const msg of alerts) {
      await alertWellness(userId, msg);
    }
  } catch (e) {
    logger.debug(`[gotify] wellness alert check failed: ${e.message}`);
  }
}

// ── POST /sync — fetch Fitbit metrics for a date or date range ────────────────
// Body: { date? } for single day  OR  { from, to } for a range
// Rate limit: Fitbit allows 150 req/hr (6 req/day → max 25 days/hr).
// For range syncs we delay 250ms between days; on 429 we stop early.
router.post('/sync', wrap(async (req, res) => {
  const u = uid(req);
  const today = new Date().toISOString().slice(0, 10);

  const { from, to } = req.body;

  // Single-day mode
  if (!from || !to) {
    const dateStr = req.body.date || today;
    const { metrics, errors } = await _dispatchSyncDate(u, dateStr);
    // Gotify: wellness alerts + step goal for today's data
    if (dateStr === today && metrics) {
      _checkWellnessAlerts(u, metrics).catch(() => {});
      if (metrics.steps) {
        import('../lib/push-notify.js').then(({ notifyStepGoal }) => {
          // Read step goal from user settings
          const goalRow = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(u, 'goals');
          if (goalRow?.value) {
            try {
              const goals = JSON.parse(goalRow.value);
              const stepGoal = goals.steps?.min || goals.steps?.max;
              if (stepGoal) notifyStepGoal(u, metrics.steps, stepGoal);
            } catch {}
          }
        }).catch(() => {});
      }
    }
    return res.json({ ok: true, date: dateStr, metrics, errors });
  }

  // Range mode — iterate from → to inclusive
  const start = new Date(from + 'T12:00:00');
  const end   = new Date(to   + 'T12:00:00');
  if (isNaN(start) || isNaN(end) || start > end) {
    return res.status(400).json({ error: 'Invalid date range' });
  }
  // Cap at 365 days to prevent accidental multi-year syncs
  const dayDiff = Math.round((end - start) / 86400000);
  if (dayDiff > 365) return res.status(400).json({ error: 'Range cannot exceed 365 days' });

  const results = { synced: 0, errors: [], rateLimited: false };
  const cur = new Date(start);

  while (cur <= end) {
    const ds = cur.toISOString().slice(0, 10);
    try {
      const { errors } = await _dispatchSyncDate(u, ds);
      results.synced++;
      if (errors.length) results.errors.push({ date: ds, errors });
    } catch (e) {
      if (e.message?.includes('429')) {
        results.rateLimited = true;
        break;
      }
      results.errors.push({ date: ds, errors: [e.message] });
      // Gotify: sync failure
      import('../lib/push-notify.js').then(({ alertSyncFailure }) => {
        alertSyncFailure(u, `Fitbit sync failed for ${ds}: ${e.message}`);
      }).catch(() => {});
    }
    cur.setDate(cur.getDate() + 1);
    if (cur <= end) await new Promise(r => setTimeout(r, 250)); // throttle
  }

  // Weekly summary on Sundays
  if (new Date().getDay() === 0) {
    import('../lib/push-notify.js').then(({ sendWeeklySummary }) => {
      sendWeeklySummary(u).catch(() => {});
    }).catch(() => {});
  }

  res.json({ ok: true, from, to, ...results });
}));

// Recalculate sleep score from stored raw components for a given date
function _recalcSleep(userId, dateStr) {
  const rows = db.prepare(
    `SELECT metric_type, value FROM wellness_data WHERE user_id = ? AND date = ? AND source = 'fitbit'`
  ).all(userId, dateStr);
  const m = {};
  for (const r of rows) m[r.metric_type] = r.value;

  if (m.sleep_duration_min == null) return null;
  const dur  = m.sleep_duration_min;
  const deep = m.sleep_deep_min ?? 0;
  const rem  = m.sleep_rem_min  ?? 0;
  const spo2 = m.spo2_avg ?? null;
  const hrv  = m.hrv_daily_rmssd ?? null;
  const eff  = m.sleep_efficiency ?? null;
  const durPts     = Math.min(30, (dur / 440) * 30);
  const deepRemPct = dur > 0 ? (deep + rem) / dur : 0;
  const qualPts    = Math.min(40, deepRemPct / 0.25 * 40);
  const qualBonus  = Math.min(8, Math.max(0, (deepRemPct - 0.35) / 0.15 * 8));
  const spo2Pts    = spo2 != null ? Math.min(15, Math.max(0, (spo2 - 87) / 9 * 15)) : 11;
  const hrvPts     = hrv  != null ? Math.min(15, Math.max(0, (hrv  -  5) / 45 * 15)) : 10;
  const effPts     = eff  != null ? Math.min(3, Math.max(0, (eff - 85) * 0.3)) : 0;
  const score = Math.min(100, Math.round(durPts + qualPts + qualBonus + spo2Pts + hrvPts + effPts));

  const upsert = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
    VALUES (?, ?, 'fitbit', 'sleep_score', ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET value = excluded.value, synced_at = excluded.synced_at
  `);
  upsert.run(userId, dateStr, score);
  return score;
}

// ── POST /recalculate — force recalculate today's sleep, readiness, stress ───
// Used during formula tuning — overwrites stored scores with new constants.
router.post('/recalculate', wrap(async (req, res) => {
  const u = uid(req);
  const today = new Date().toISOString().slice(0, 10);
  const { snapshotScores } = await import('../lib/wellness-scores.js');

  // Recalculate all three scores for today
  const sleep = _recalcSleep(u, today);
  snapshotScores(u, today, { force: true });

  const scores = db.prepare(
    `SELECT metric_type, value FROM wellness_data WHERE user_id = ? AND date = ? AND source = 'fitbit' AND metric_type IN ('sleep_score', 'readiness_score', 'stress_score')`
  ).all(u, today);
  const result = {};
  for (const s of scores) result[s.metric_type] = s.value;
  res.json({ ok: true, date: today, ...result });
}));

// ── POST /seed-scores — store actual Fitbit values for calibration ──
// Writes to *_actual metric_types (not the calculated *_score) so that
// routine syncs don't overwrite them. The Wellness UI prefers *_actual
// for display when present, and the stress/readiness chains prefer them
// for history. Once the formulas are dialed in and seeding stops, the
// *_actual rows roll off the 30-day stress window naturally and the
// system transitions to using calc only — no flag flip needed.
router.post('/seed-scores', wrap(async (req, res) => {
  const u = uid(req);
  const {
    date, sleep_score, readiness_score, stress_score,
    sleep_duration_min,
    sleep_deep_min, sleep_rem_min, sleep_light_min, sleep_wake_min,
    clear,
  } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });

  // `clear: true` wipes every *_actual row for the date. Lets the user
  // undo a seed without DB access — after this, the next sync's synced
  // values are what the Wellness card displays.
  if (clear) {
    const types = [
      'sleep_score_actual', 'readiness_score_actual', 'stress_score_actual',
      'sleep_duration_min_actual',
      'sleep_deep_min_actual', 'sleep_rem_min_actual',
      'sleep_light_min_actual', 'sleep_wake_min_actual',
    ];
    const placeholders = types.map(() => '?').join(',');
    const result = db.prepare(
      `DELETE FROM wellness_data WHERE user_id = ? AND date = ? AND source = 'fitbit' AND metric_type IN (${placeholders})`
    ).run(u, date, ...types);
    logger.info(`[fitbit] cleared ${result.changes} actual rows for ${date}`);
    return res.json({ ok: true, date, cleared: result.changes });
  }

  // If stage minutes are provided but no explicit total, derive duration
  // from LIGHT + DEEP + REM (excluding AWAKE) — matches Fitbit's "Time
  // asleep" definition.
  const haveStages = sleep_deep_min != null || sleep_rem_min != null || sleep_light_min != null;
  const derivedDuration = haveStages
    ? (Number(sleep_light_min) || 0) + (Number(sleep_deep_min) || 0) + (Number(sleep_rem_min) || 0)
    : null;
  const finalDuration = sleep_duration_min != null ? sleep_duration_min : derivedDuration;

  const upsert = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
    VALUES (?, ?, 'fitbit', ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
      value = excluded.value, synced_at = excluded.synced_at
  `);
  db.transaction(() => {
    if (sleep_score != null)     upsert.run(u, date, 'sleep_score_actual',        sleep_score);
    if (readiness_score != null) upsert.run(u, date, 'readiness_score_actual',    readiness_score);
    if (stress_score != null)    upsert.run(u, date, 'stress_score_actual',       stress_score);
    // Sleep duration + stage overrides. Google Health's stages sometimes
    // sum higher than what the Fitbit app shows; seeding *_actual values
    // makes Wellness display match the app exactly while leaving the raw
    // synced rows untouched (stress / readiness chains keep using calc).
    if (finalDuration != null)   upsert.run(u, date, 'sleep_duration_min_actual', finalDuration);
    if (sleep_deep_min != null)  upsert.run(u, date, 'sleep_deep_min_actual',     sleep_deep_min);
    if (sleep_rem_min != null)   upsert.run(u, date, 'sleep_rem_min_actual',      sleep_rem_min);
    if (sleep_light_min != null) upsert.run(u, date, 'sleep_light_min_actual',    sleep_light_min);
    if (sleep_wake_min != null)  upsert.run(u, date, 'sleep_wake_min_actual',     sleep_wake_min);
  })();

  logger.info(`[fitbit] seeded actual values for ${date}: sleep=${sleep_score} readiness=${readiness_score} stress=${stress_score} dur=${finalDuration} stages=${sleep_deep_min}/${sleep_rem_min}/${sleep_light_min}/${sleep_wake_min}`);
  res.json({
    ok: true, date,
    sleep_score, readiness_score, stress_score,
    sleep_duration_min: finalDuration,
    sleep_deep_min, sleep_rem_min, sleep_light_min, sleep_wake_min,
  });
}));

// ── GET /data — return stored wellness data ───────────────────────────────────
// Returns both Fitbit (server-side OAuth) and Health Connect (pushed up from
// the Android app, see #23 / rc.22-23) rows. HC is treated as an Android-side
// data source for the same metric tiles; merging here keeps the web Wellness
// page source-agnostic without needing a separate endpoint.
//
// Order matters: HC rows are emitted LAST so they OVERWRITE any same-metric
// Fitbit row in the per-date map. Rationale: if the user has both enabled,
// they explicitly chose HC on their device, so HC is the more authoritative
// source for that day.
router.get('/data', wrap((req, res) => {
  const u = uid(req);
  const { date, from, to } = req.query;

  const orderHcLast = `ORDER BY CASE source WHEN 'health_connect' THEN 2 ELSE 1 END`;
  let rows;
  if (date) {
    rows = db.prepare(
      `SELECT * FROM wellness_data WHERE user_id=? AND date=? AND source IN ('fitbit', 'health_connect') ${orderHcLast}`
    ).all(u, date);
  } else {
    const start = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const end   = to   || new Date().toISOString().slice(0, 10);
    rows = db.prepare(
      `SELECT * FROM wellness_data WHERE user_id=? AND date>=? AND date<=? AND source IN ('fitbit', 'health_connect') ORDER BY date, CASE source WHEN 'health_connect' THEN 2 ELSE 1 END`
    ).all(u, start, end);
  }

  // Group by date → { [date]: { [metric_type]: value } }
  const byDate = {};
  for (const row of rows) {
    byDate[row.date] ??= {};
    byDate[row.date][row.metric_type] = row.value;
  }
  res.json(byDate);
}));

// ── GET /workouts — return stored workouts for a date or range ────────────────
router.get('/workouts', wrap((req, res) => {
  const u = uid(req);
  const { date, from, to } = req.query;
  let rows;
  if (date) {
    rows = db.prepare('SELECT * FROM workouts WHERE user_id=? AND date=? ORDER BY start_time DESC').all(u, date);
  } else {
    const start = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const end = to || new Date().toISOString().slice(0, 10);
    rows = db.prepare('SELECT * FROM workouts WHERE user_id=? AND date>=? AND date<=? ORDER BY date DESC, start_time DESC').all(u, start, end);
  }
  // Parse gps_data JSON, omit from list view for efficiency if not requested
  const includeGps = req.query.gps === '1';
  res.json(rows.map(r => ({
    ...r,
    gps_data: includeGps && r.gps_data ? JSON.parse(r.gps_data) : undefined,
    has_gps: !!r.has_gps,
  })));
}));

// ── GET /workouts/:id — single workout with GPS data ──────────────────────────
router.get('/workouts/:id', wrap((req, res) => {
  const u = uid(req);
  const row = db.prepare('SELECT * FROM workouts WHERE id=? AND user_id=?').get(req.params.id, u);
  if (!row) return res.status(404).json({ error: 'Workout not found' });
  res.json({ ...row, gps_data: row.gps_data ? JSON.parse(row.gps_data) : null, has_gps: !!row.has_gps });
}));

// ── Workout sync (shared by route handler + scheduler) ────────────────────────
async function _syncWorkouts(userId, from, to) {
  const afterDate = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const beforeDate = to || new Date().toISOString().slice(0, 10);
  const u = userId;

  // Fetch activity log list — use raw text parsing to preserve logId precision
  // (Fitbit logIds exceed Number.MAX_SAFE_INTEGER, JSON.parse loses last digits)
  logger.info(`[fitbit] fetching activity logs for user ${u}: ${afterDate} → ${beforeDate}`);
  let tok = await _token(u);
  let actRes = await fetch(`https://api.fitbit.com/1/user/-/activities/list.json?afterDate=${afterDate}&sort=asc&offset=0&limit=100`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (actRes.status === 401) {
    tok = await _refresh(u);
    actRes = await fetch(`https://api.fitbit.com/1/user/-/activities/list.json?afterDate=${afterDate}&sort=asc&offset=0&limit=100`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
  }
  if (!actRes.ok) throw new Error(`Fitbit activity list ${actRes.status}`);
  const rawText = await actRes.text();
  // Extract logId values as strings BEFORE JSON.parse corrupts them
  const logIdMap = {};
  for (const m of rawText.matchAll(/"logId"\s*:\s*(\d+)/g)) {
    logIdMap[m[1]] = m[1]; // store exact string
  }
  const data = JSON.parse(rawText);
  // Restore precise logId strings (JSON.parse rounded them)
  for (const a of (data.activities || [])) {
    const imprecise = String(a.logId);
    // Find the original logId that rounds to this value
    for (const exact of Object.keys(logIdMap)) {
      if (String(Number(exact)) === imprecise) { a._exactLogId = exact; break; }
    }
  }
  logger.info(`[fitbit] Fitbit returned ${(data.activities || []).length} activities`);
  if ((data.activities || []).length > 0) {
    logger.debug(`[fitbit] first activity logId: parsed=${data.activities[0].logId} exact=${data.activities[0]._exactLogId}`);
  }
  const activities = (data.activities || []).filter(a => {
    const d = (a.startDate || a.originalStartTime?.slice(0, 10) || '');
    return d >= afterDate && d <= beforeDate;
  });

  const upsert = db.prepare(`
    INSERT INTO workouts (user_id, source, source_id, date, activity_type, activity_name, start_time, duration_ms, distance_km, calories, avg_hr, max_hr, steps, has_gps, updated_at)
    VALUES (?, 'fitbit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, source, source_id) DO UPDATE SET
      activity_type=excluded.activity_type, activity_name=excluded.activity_name,
      start_time=excluded.start_time, duration_ms=excluded.duration_ms,
      distance_km=excluded.distance_km, calories=excluded.calories,
      avg_hr=excluded.avg_hr, max_hr=excluded.max_hr, steps=excluded.steps,
      has_gps=MAX(has_gps, excluded.has_gps), updated_at=excluded.updated_at
  `);

  // First pass: upsert workouts with placeholder max_hr, then fetch actual peak HR
  const workoutRows = [];
  let synced = 0;
  db.transaction(() => {
    for (const a of activities) {
      const logId = a._exactLogId || String(a.logId);
      const date = a.startDate || a.originalStartTime?.slice(0, 10) || '';
      const activityName = a.activityName || a.name || 'Unknown';
      const activityType = (a.activityTypeId || '').toString();
      const startTime = a.originalStartTime || a.startTime || '';
      const durationMs = a.activeDuration || a.duration || 0;
      const distanceKm = a.distance != null ? a.distance * (a.distanceUnit === 'Mile' ? 1.60934 : 1) : null;
      const calories = a.calories || 0;
      const avgHr = a.averageHeartRate || null;
      const steps = a.steps || null;
      const hasGps = a.hasGps ? 1 : 0;

      upsert.run(u, logId, date, activityType, activityName, startTime, durationMs, distanceKm, calories, avgHr, null, steps, hasGps);
      workoutRows.push({ logId, date, startTime, durationMs });
      synced++;
    }
  })();

  // Second pass: fetch actual peak HR from intraday heart rate data per workout
  const updateMaxHr = db.prepare(`UPDATE workouts SET max_hr = ? WHERE user_id = ? AND source = 'fitbit' AND source_id = ?`);
  for (const w of workoutRows) {
    try {
      // Parse HH:mm directly from ISO string to preserve the activity's local time
      // (Fitbit's startTime includes timezone offset; the date+time portion IS local)
      // Format: "2026-04-05T20:57:00.000-04:00" → date=2026-04-05, time=20:57
      const m = w.startTime.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
      if (!m) { logger.warn(`[fitbit] cannot parse startTime: ${w.startTime}`); continue; }
      const localDate = m[1];
      const startMinTotal = parseInt(m[2]) * 60 + parseInt(m[3]);
      const endMinTotal = startMinTotal + Math.ceil(w.durationMs / 60000);
      const pad = n => String(n).padStart(2, '0');
      const startHHMM = `${pad(Math.floor(startMinTotal / 60))}:${pad(startMinTotal % 60)}`;
      // Cap at 23:59 if activity crosses midnight (rare; intraday endpoint is per-day)
      const endHour = Math.min(23, Math.floor(endMinTotal / 60));
      const endMin = endHour === 23 && endMinTotal / 60 > 23 ? 59 : (endMinTotal % 60);
      const endHHMM = `${pad(endHour)}:${pad(endMin)}`;
      logger.info(`[fitbit] peak HR fetch: workout ${w.logId} date=${localDate} ${startHHMM}-${endHHMM}`);
      const hrData = await _get(u, `/1/user/-/activities/heart/date/${localDate}/1d/1min/time/${startHHMM}/${endHHMM}.json`);
      const dataset = hrData?.['activities-heart-intraday']?.dataset || [];
      if (dataset.length > 0) {
        const peakHr = Math.max(...dataset.map(p => p.value));
        logger.info(`[fitbit] peak HR for ${w.logId}: ${peakHr} bpm (${dataset.length} samples)`);
        if (peakHr > 0) updateMaxHr.run(peakHr, u, w.logId);
      } else {
        logger.warn(`[fitbit] no intraday HR data for ${w.logId}`);
      }
    } catch (e) {
      logger.warn(`[fitbit] peak HR fetch failed for ${w.logId}: ${e.message}`);
    }
  }

  // Clean up duplicate workouts from logId precision issue — keep the entry with
  // the correct (exact) source_id, delete any older entries with the same
  // date+start_time+activity that have a different (imprecise) source_id.
  try {
    const dupes = db.prepare(`
      SELECT w1.id FROM workouts w1
      INNER JOIN workouts w2 ON w1.user_id = w2.user_id AND w1.source = w2.source
        AND w1.date = w2.date AND w1.start_time = w2.start_time
        AND w1.activity_name = w2.activity_name AND w1.id != w2.id
        AND w1.source_id != w2.source_id
      WHERE w1.user_id = ? AND w1.gps_data IS NULL AND w2.gps_data IS NOT NULL
    `).all(u);
    if (dupes.length === 0) {
      // No GPS-based distinction — just keep the newer one (higher id)
      const dupes2 = db.prepare(`
        SELECT w1.id FROM workouts w1
        INNER JOIN workouts w2 ON w1.user_id = w2.user_id AND w1.source = w2.source
          AND w1.date = w2.date AND w1.start_time = w2.start_time
          AND w1.activity_name = w2.activity_name AND w1.id < w2.id
          AND w1.source_id != w2.source_id
        WHERE w1.user_id = ?
      `).all(u);
      if (dupes2.length > 0) {
        const del = db.prepare('DELETE FROM workouts WHERE id = ?');
        for (const d of dupes2) del.run(d.id);
        logger.info(`[fitbit] cleaned up ${dupes2.length} duplicate workouts (logId precision fix)`);
      }
    } else {
      const del = db.prepare('DELETE FROM workouts WHERE id = ?');
      for (const d of dupes) del.run(d.id);
      logger.info(`[fitbit] cleaned up ${dupes.length} duplicate workouts (kept entries with GPS data)`);
    }
  } catch (e) {
    logger.debug(`[fitbit] duplicate cleanup skipped: ${e.message}`);
  }

  logger.info(`[fitbit] synced ${synced} workouts for user ${u} (${afterDate} → ${beforeDate})`);

  // Gotify: workout summary for newly synced workouts
  if (synced > 0) {
    try {
      const { notifyWorkout } = await import('../lib/push-notify.js');
      let _isKj = false;
      try {
        const euRow = db.prepare(`SELECT value FROM user_settings WHERE user_id=? AND key='energyUnit'`).get(u);
        _isKj = (JSON.parse(euRow?.value || '"kcal"') || 'kcal') === 'kJ';
      } catch {}
      for (const a of activities.slice(-3)) { // last 3 max
        const dur = Math.round((a.activeDuration || 0) / 60000);
        const dist = a.distance != null ? `${(a.distance * (a.distanceUnit === 'Mile' ? 1.60934 : 1)).toFixed(1)} km` : '';
        const cal = a.calories || 0;
        const calStr = cal ? `${_isKj ? Math.round(cal * 4.184) : cal} ${_isKj ? 'kJ' : 'kcal'}` : '';
        const name = a.activityName || 'Workout';
        notifyWorkout(u, `${name}: ${dur} min${dist ? ', ' + dist : ''}${calStr ? ', ' + calStr : ''}`);
      }
    } catch {}
  }

  return { ok: true, synced, total: activities.length };
}

router.post('/workouts/sync', wrap(async (req, res) => {
  const result = await _dispatchSyncWorkouts(uid(req), req.body.from, req.body.to);
  res.json(result);
}));

// ── POST /workouts/:sourceId/gps — fetch TCX GPS data for a specific workout ──
router.post('/workouts/:sourceId/gps', wrap(async (req, res) => {
  const u = uid(req);
  const { sourceId } = req.params;

  // Check if we already have GPS data cached
  const existing = db.prepare('SELECT gps_data FROM workouts WHERE user_id=? AND source=? AND source_id=?').get(u, 'fitbit', sourceId);
  if (existing?.gps_data) {
    return res.json({ ok: true, cached: true, gps_data: JSON.parse(existing.gps_data) });
  }

  // Pipe-aware TCX fetch — Google Health users go through
  // dataPoints:exportExerciseTcx; legacy users hit the Fitbit Web API.
  // Both return TCX XML which the parser below handles identically.
  let tcxText;
  if (await _hasGoogleHealthTokens(u)) {
    const { getAccessToken: ghToken } = await import('../lib/google-health.js');
    const ghClientId     = _userCfg('google_health_client_id',     u);
    const ghClientSecret = _userCfg('google_health_client_secret', u);
    if (!ghClientId || !ghClientSecret) {
      return res.status(400).json({ error: 'Google Health not configured' });
    }
    const accessToken = await ghToken(u, ghClientId, ghClientSecret);
    const ghRes = await fetch(
      `https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints/${sourceId}:exportExerciseTcx`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    );
    if (!ghRes.ok) {
      const body = await ghRes.text().catch(() => '');
      return res.status(ghRes.status).json({ error: `Google Health TCX fetch failed: ${ghRes.status} ${body.slice(0, 120)}` });
    }
    const data = await ghRes.json();
    tcxText = data?.tcxData || '';
  } else {
    let tok = await _token(u);
    let tcxRes = await fetch(`https://api.fitbit.com/1/user/-/activities/${sourceId}.tcx?includePartialTCX=true`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (tcxRes.status === 401) {
      tok = await _refresh(u);
      tcxRes = await fetch(`https://api.fitbit.com/1/user/-/activities/${sourceId}.tcx?includePartialTCX=true`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
    }
    if (!tcxRes.ok) {
      return res.status(tcxRes.status).json({ error: `Fitbit TCX fetch failed: ${tcxRes.status}` });
    }
    tcxText = await tcxRes.text();
  }

  // Parse TCX XML → extract trackpoints with lat/lng/hr/time
  const points = [];
  const trackpointRegex = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/g;
  let match;
  while ((match = trackpointRegex.exec(tcxText)) !== null) {
    const block = match[1];
    const lat = block.match(/<LatitudeDegrees>([\d.-]+)<\/LatitudeDegrees>/)?.[1];
    const lng = block.match(/<LongitudeDegrees>([\d.-]+)<\/LongitudeDegrees>/)?.[1];
    const hr = block.match(/<HeartRateBpm>[\s\S]*?<Value>(\d+)<\/Value>/)?.[1];
    const time = block.match(/<Time>([^<]+)<\/Time>/)?.[1];
    const alt = block.match(/<AltitudeMeters>([\d.-]+)<\/AltitudeMeters>/)?.[1];

    if (lat && lng) {
      points.push({
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        hr: hr ? parseInt(hr) : null,
        alt: alt ? parseFloat(alt) : null,
        time: time || null,
      });
    }
  }

  if (points.length === 0) {
    return res.json({ ok: true, gps_data: null, message: 'No GPS data in TCX' });
  }

  // Cache GPS data in the workouts table
  const gpsJson = JSON.stringify(points);
  db.prepare('UPDATE workouts SET gps_data=?, has_gps=1, updated_at=datetime(\'now\') WHERE user_id=? AND source=? AND source_id=?')
    .run(gpsJson, u, 'fitbit', sourceId);

  logger.info(`[fitbit] cached ${points.length} GPS points for workout ${sourceId}`);
  res.json({ ok: true, gps_data: points, count: points.length });
}));

// ── DELETE /disconnect ────────────────────────────────────────────────────────
router.delete('/disconnect', wrap((req, res) => {
  db.prepare('DELETE FROM fitbit_tokens WHERE user_id=?').run(uid(req));
  res.json({ ok: true });
}));

export { _syncDate as syncDate, _syncWorkouts as syncWorkouts, _checkWellnessAlerts };
export default router;
