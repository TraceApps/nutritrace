/**
 * Garmin Health API integration — OAuth 1.0a
 *
 * Requires a Garmin Health API partnership (not a free developer program).
 * Submit a partnership request at: https://developer.garmin.com/health-api/overview/
 *
 * Credentials stored per-user in user_settings (multi-user) or app_config (single-user).
 */
import { Router } from 'express';
import { createHmac, randomBytes } from 'crypto';
import db from '../db.js';
import { wrap, logger } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : 0;

const GARMIN_BASE   = 'https://healthapi.garmin.com';
const GARMIN_OAUTH  = 'https://connectapi.garmin.com';

// ── Credential helpers ────────────────────────────────────────────────────────
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
  const row = db.prepare('SELECT * FROM garmin_tokens WHERE user_id = ?').get(userId);
  if (!row) return row;
  return { ...row, access_token: decrypt(row.access_token), access_secret: decrypt(row.access_secret) };
}

// ── OAuth 1.0a signing ────────────────────────────────────────────────────────
function _oauthSign(method, url, params, consumerSecret, tokenSecret = '') {
  // Collect, percent-encode, and sort all params
  const sorted = Object.entries(params)
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const base = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(sorted)].join('&');
  const key  = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  return createHmac('sha1', key).update(base).digest('base64');
}

function _oauthHeader(method, url, extraParams, consumerKey, consumerSecret, tokenKey = '', tokenSecret = '') {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');

  const params = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts,
    oauth_token:            tokenKey,
    oauth_version:          '1.0',
    ...extraParams,
  };
  if (!tokenKey) delete params.oauth_token;

  const sig = _oauthSign(method, url, params, consumerSecret, tokenSecret);
  params.oauth_signature = sig;

  const header = 'OAuth ' + Object.entries(params)
    .filter(([k]) => k.startsWith('oauth_'))
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(', ');

  return header;
}

// DB-backed request token helpers — survive server restarts during the OAuth handshake
function _reqTokenSet(token, userId, secret, isNative = false) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO oauth_state (state, user_id, provider, data, expires_at)
              VALUES (?, ?, 'garmin', ?, ?)`).run(token, userId, JSON.stringify({ secret, isNative }), expiresAt);
  db.prepare(`DELETE FROM oauth_state WHERE expires_at < datetime('now')`).run();
}
function _reqTokenGet(token) {
  const row = db.prepare(`SELECT * FROM oauth_state WHERE state = ? AND provider = 'garmin'`).get(token);
  if (!row) return null;
  db.prepare(`DELETE FROM oauth_state WHERE state = ?`).run(token);
  if (row.expires_at < new Date().toISOString()) return null;
  const data = JSON.parse(row.data);
  return { secret: data.secret, userId: row.user_id, isNative: !!data.isNative };
}

// ── GET /config ────────────────────────────────────────────────────────────────
router.get('/config', wrap((req, res) => {
  const u = uid(req);
  res.json({
    consumer_key: _userCfg('garmin_consumer_key', u),
    redirect_uri: _userCfg('garmin_redirect_uri', u),
  });
}));

// ── PUT /config ────────────────────────────────────────────────────────────────
router.put('/config', wrap((req, res) => {
  const { consumer_key, consumer_secret, redirect_uri } = req.body;
  if (userMgmtActive() && req.user) {
    const save = db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
    db.transaction(() => {
      if (consumer_key    !== undefined) save.run(req.user.id, 'garmin_consumer_key',    JSON.stringify(consumer_key));
      if (consumer_secret !== undefined) save.run(req.user.id, 'garmin_consumer_secret', JSON.stringify(consumer_secret));
      if (redirect_uri    !== undefined) save.run(req.user.id, 'garmin_redirect_uri',    JSON.stringify(redirect_uri));
    })();
  } else {
    const save = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)');
    db.transaction(() => {
      if (consumer_key    !== undefined) save.run('garmin_consumer_key',    consumer_key);
      if (consumer_secret !== undefined) save.run('garmin_consumer_secret', consumer_secret);
      if (redirect_uri    !== undefined) save.run('garmin_redirect_uri',    redirect_uri);
    })();
  }
  res.json({ ok: true });
}));

// ── GET /status ────────────────────────────────────────────────────────────────
router.get('/status', wrap((req, res) => {
  const u = uid(req);
  const tokens = _getTokens(u);
  const consumerKey = _userCfg('garmin_consumer_key', u);
  const lastSync = db.prepare('SELECT MAX(synced_at) as ts FROM wellness_data WHERE user_id=? AND source=?').get(u, 'garmin');
  res.json({
    connected:    !!tokens,
    configured:   !!consumerKey,
    garminUserId: tokens?.garmin_user_id || null,
    lastSyncedAt: lastSync?.ts           || null,
  });
}));

// ── GET /authorize — step 1: get request token, redirect to Garmin ──────────
router.get('/authorize', wrap(async (req, res) => {
  const u           = uid(req);
  const consumerKey    = _userCfg('garmin_consumer_key',    u);
  const consumerSecret = _userCfg('garmin_consumer_secret', u);
  const redirectUri    = _userCfg('garmin_redirect_uri',    u);

  if (!consumerKey || !consumerSecret || !redirectUri) {
    return res.status(400).json({ error: 'Garmin consumer key, secret, and redirect URI must be configured in Settings → Wellness.' });
  }

  const reqTokenUrl = `${GARMIN_OAUTH}/oauth-service/oauth/request_token`;
  const authHeader  = _oauthHeader('POST', reqTokenUrl, { oauth_callback: redirectUri }, consumerKey, consumerSecret);

  const resp = await fetch(reqTokenUrl, {
    method:  'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return res.status(502).json({ error: `Garmin request token failed: ${body.slice(0, 120)}` });
  }

  const raw = await resp.text();
  const qs  = Object.fromEntries(new URLSearchParams(raw));
  const { oauth_token, oauth_token_secret } = qs;

  if (!oauth_token) return res.status(502).json({ error: 'No oauth_token in Garmin response' });

  _reqTokenSet(oauth_token, u, oauth_token_secret, req.query.native === '1');

  const authorizeUrl = `${GARMIN_OAUTH}/oauth-service/oauth/authorize?oauth_token=${encodeURIComponent(oauth_token)}`;
  res.json({ url: authorizeUrl });
}));

// ── GET /callback — step 2: exchange request token for access token ──────────
router.get('/callback', wrap(async (req, res) => {
  const { oauth_token, oauth_verifier, error } = req.query;

  if (error) return res.redirect(`/?garmin=error&msg=${encodeURIComponent(error)}#/wellness`);
  if (!oauth_token || !oauth_verifier) {
    return res.redirect('/?garmin=error&msg=missing_params#/wellness');
  }

  const stored = _reqTokenGet(oauth_token);
  if (!stored) {
    return res.redirect('/?garmin=error&msg=token_expired#/wellness');
  }
  const _redir = (path) => stored.isNative ? `nutritrace://callback${path}` : path;

  const u              = stored.userId;
  const consumerKey    = _userCfg('garmin_consumer_key',    u);
  const consumerSecret = _userCfg('garmin_consumer_secret', u);

  const accessTokenUrl = `${GARMIN_OAUTH}/oauth-service/oauth/access_token`;
  const authHeader = _oauthHeader(
    'POST', accessTokenUrl,
    { oauth_verifier },
    consumerKey, consumerSecret,
    oauth_token, stored.secret,
  );

  const resp = await fetch(accessTokenUrl, {
    method:  'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return res.redirect(_redir(`/?garmin=error&msg=${encodeURIComponent('Token exchange failed: ' + body.slice(0, 80))}#/wellness`));
  }

  const raw = await resp.text();
  const qs  = Object.fromEntries(new URLSearchParams(raw));
  const { oauth_token: accessToken, oauth_token_secret: accessSecret } = qs;

  if (!accessToken) return res.redirect(_redir('/?garmin=error&msg=no_access_token#/wellness'));

  db.prepare(`
    INSERT INTO garmin_tokens (user_id, access_token, access_secret, garmin_user_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token   = excluded.access_token,
      access_secret  = excluded.access_secret,
      garmin_user_id = excluded.garmin_user_id
  `).run(u, encrypt(accessToken), encrypt(accessSecret), qs.userId || null);

  res.redirect(_redir('/?garmin=connected#/wellness'));
}));

// ── Authenticated Garmin API GET ──────────────────────────────────────────────
async function _garminGet(u, path, queryParams = {}) {
  const tokens      = _getTokens(u);
  if (!tokens) throw Object.assign(new Error('Not connected to Garmin'), { status: 401 });

  const consumerKey    = _userCfg('garmin_consumer_key',    u);
  const consumerSecret = _userCfg('garmin_consumer_secret', u);

  const url = `${GARMIN_BASE}${path}`;
  const authHeader = _oauthHeader(
    'GET', url,
    queryParams,
    consumerKey, consumerSecret,
    tokens.access_token, tokens.access_secret,
  );

  const qs  = new URLSearchParams(queryParams).toString();
  const res = await fetch(qs ? `${url}?${qs}` : url, {
    headers: { Authorization: authHeader },
  });

  if (res.status === 401) {
    db.prepare('DELETE FROM garmin_tokens WHERE user_id = ?').run(u);
    throw Object.assign(new Error('Garmin token revoked — please reconnect.'), { status: 401 });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Garmin API ${res.status}: ${body.slice(0, 120)}`);
  }

  return res.json();
}

// ── Sync a date range ─────────────────────────────────────────────────────────
async function _syncRange(u, fromDate, toDate) {
  const startEpoch = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const endEpoch   = Math.floor(new Date(toDate   + 'T23:59:59Z').getTime() / 1000);

  const upsert = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
    VALUES (?, ?, 'garmin', ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
      value = excluded.value, synced_at = excluded.synced_at
  `);

  const errors = [];
  let synced = 0;

  // ── Dailies: steps, distance, calories, active minutes ─────────────────────
  try {
    const data = await _garminGet(u, '/wellness-api/rest/dailies', {
      uploadStartTimeInSeconds: startEpoch,
      uploadEndTimeInSeconds:   endEpoch,
    });
    db.transaction(() => {
      for (const day of (data.dailies || [])) {
        const date = day.calendarDate || _epochToDate(day.startTimeInSeconds);
        if (!date) continue;
        const m = {
          steps:          day.totalSteps,
          active_minutes: day.activeTimeInSeconds != null ? Math.round(day.activeTimeInSeconds / 60) : null,
          calories_out:   day.totalKilocalories,
          distance_km:    day.totalDistanceInMeters != null ? +(day.totalDistanceInMeters / 1000).toFixed(2) : null,
          floors:         day.floorsClimbed,
          max_hr:                day.maxHeartRate ?? null,
          body_battery_high:     day.bodyBatteryHighestValue,
          body_battery_low:      day.bodyBatteryLowestValue,
          stress_avg:            day.averageStressLevel,
          moderate_intensity_min: day.moderateIntensityMinutes ?? null,
          vigorous_intensity_min: day.vigorousIntensityMinutes ?? null,
        };
        for (const [type, value] of Object.entries(m)) {
          if (value != null && value >= 0) upsert.run(u, date, type, value);
        }
        synced++;
      }
    })();
  } catch (e) { errors.push('dailies: ' + e.message); }

  // ── Sleep ──────────────────────────────────────────────────────────────────
  try {
    const data = await _garminGet(u, '/wellness-api/rest/sleeps', {
      uploadStartTimeInSeconds: startEpoch,
      uploadEndTimeInSeconds:   endEpoch,
    });
    db.transaction(() => {
      for (const night of (data.sleeps || [])) {
        const date = night.calendarDate || _epochToDate(night.startTimeInSeconds);
        if (!date) continue;
        // Sleep timing — convert UTC epoch + local offset to minutes past midnight
        const offset = night.startTimeOffsetInSeconds ?? 0;
        let sleep_start_min = null, sleep_end_min = null;
        if (night.startTimeInSeconds != null) {
          const localStart = new Date((night.startTimeInSeconds + offset) * 1000);
          sleep_start_min = localStart.getUTCHours() * 60 + localStart.getUTCMinutes();
        }
        if (night.startTimeInSeconds != null && night.durationInSeconds != null) {
          const localEnd = new Date((night.startTimeInSeconds + offset + night.durationInSeconds) * 1000);
          sleep_end_min = localEnd.getUTCHours() * 60 + localEnd.getUTCMinutes();
        }
        const m = {
          sleep_duration_min: night.durationInSeconds  != null ? Math.round(night.durationInSeconds / 60) : null,
          sleep_deep_min:     night.deepSleepDurationInSeconds  != null ? Math.round(night.deepSleepDurationInSeconds / 60)  : null,
          sleep_light_min:    night.lightSleepDurationInSeconds != null ? Math.round(night.lightSleepDurationInSeconds / 60) : null,
          sleep_rem_min:      night.remSleepInSeconds  != null ? Math.round(night.remSleepInSeconds / 60) : null,
          sleep_wake_min:     night.awakeDurationInSeconds  != null ? Math.round(night.awakeDurationInSeconds / 60) : null,
          respiratory_rate:   night.averageRespirationValue ?? null,
          sleep_score:        night.sleepScores?.overallSleepScore ?? night.overallSleepScore ?? null,
          sleep_start_min,
          sleep_end_min,
        };
        for (const [type, value] of Object.entries(m)) {
          if (value != null) upsert.run(u, date, type, value);
        }
      }
    })();
  } catch (e) { errors.push('sleep: ' + e.message); }

  // ── Heart Rate ─────────────────────────────────────────────────────────────
  try {
    const cur = new Date(fromDate + 'T12:00:00Z');
    const end = new Date(toDate   + 'T12:00:00Z');
    while (cur <= end) {
      const date = cur.toISOString().slice(0, 10);
      try {
        const data = await _garminGet(u, `/wellness-api/rest/dailyHeartRate/${date}`);
        if (data?.heartRateSummary?.restingHeartRate) {
          upsert.run(u, date, 'resting_hr', data.heartRateSummary.restingHeartRate);
        }
      } catch { /* per-day errors are silently skipped */ }
      cur.setDate(cur.getDate() + 1);
      if (cur <= end) await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) { errors.push('heartrate: ' + e.message); }

  // ── HRV ───────────────────────────────────────────────────────────────────
  try {
    const data = await _garminGet(u, '/wellness-api/rest/hrv', {
      uploadStartTimeInSeconds: startEpoch,
      uploadEndTimeInSeconds:   endEpoch,
    });
    db.transaction(() => {
      for (const entry of (data.hrv || [])) {
        const date = entry.calendarDate;
        if (!date) continue;
        if (entry.weekly_avg != null)    upsert.run(u, date, 'hrv_daily_rmssd', entry.weekly_avg);
        if (entry.lastNight  != null)    upsert.run(u, date, 'hrv_daily_rmssd', entry.lastNight);
      }
    })();
  } catch (e) { errors.push('hrv: ' + e.message); }

  // ── Pulse Ox (SpO2) ────────────────────────────────────────────────────────
  try {
    const data = await _garminGet(u, '/wellness-api/rest/pulseOx', {
      uploadStartTimeInSeconds: startEpoch,
      uploadEndTimeInSeconds:   endEpoch,
    });
    db.transaction(() => {
      for (const entry of (data.pulseOx || [])) {
        const date = entry.calendarDate || _epochToDate(entry.startTimeInSeconds);
        if (!date) continue;
        if (entry.averageSpo2 != null) upsert.run(u, date, 'spo2_avg', entry.averageSpo2);
      }
    })();
  } catch (e) { errors.push('pulseox: ' + e.message); }

  // Snapshot readiness + stress for today only (past days keep locked-in scores)
  const todayDate = new Date().toISOString().slice(0, 10);
  if (todayDate >= fromDate && todayDate <= toDate) {
    try {
      const { snapshotScores } = await import('../lib/wellness-scores.js');
      snapshotScores(u, todayDate);
    } catch (e) { logger.warn('[garmin] snapshot failed:', e.message); }
  }

  return { synced, errors };
}

function _epochToDate(epochSeconds) {
  if (!epochSeconds) return null;
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

// ── POST /sync ────────────────────────────────────────────────────────────────
router.post('/sync', wrap(async (req, res) => {
  const u = uid(req);
  const today = new Date().toISOString().slice(0, 10);
  let { date, from, to } = req.body;
  if (!from) { from = date || today; to = date || today; }

  const start = new Date(from + 'T12:00:00Z');
  const end   = new Date(to   + 'T12:00:00Z');
  if (isNaN(start) || isNaN(end) || start > end) {
    return res.status(400).json({ error: 'Invalid date range' });
  }
  const dayDiff = Math.round((end - start) / 86400000);
  if (dayDiff > 365) return res.status(400).json({ error: 'Range cannot exceed 365 days' });

  const result = await _syncRange(u, from, to);
  res.json({ ok: true, from, to, ...result });
}));

// ── GET /data ─────────────────────────────────────────────────────────────────
router.get('/data', wrap((req, res) => {
  const u = uid(req);
  const { date, from, to } = req.query;
  let rows;
  if (date) {
    rows = db.prepare('SELECT * FROM wellness_data WHERE user_id=? AND date=? AND source=?').all(u, date, 'garmin');
  } else {
    const start = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const end   = to   || new Date().toISOString().slice(0, 10);
    rows = db.prepare('SELECT * FROM wellness_data WHERE user_id=? AND date>=? AND date<=? AND source=? ORDER BY date').all(u, start, end, 'garmin');
  }
  const byDate = {};
  for (const row of rows) {
    byDate[row.date] ??= {};
    byDate[row.date][row.metric_type] = row.value;
  }
  res.json(byDate);
}));

// ── DELETE /disconnect ────────────────────────────────────────────────────────
router.delete('/disconnect', wrap((req, res) => {
  db.prepare('DELETE FROM garmin_tokens WHERE user_id=?').run(uid(req));
  res.json({ ok: true });
}));

export { _syncRange as syncRange };
export default router;
