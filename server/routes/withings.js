import { Router } from 'express';
import { randomBytes } from 'crypto';
import db from '../db.js';
import { wrap, logger } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : 0;

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
  const row = db.prepare('SELECT * FROM withings_tokens WHERE user_id = ?').get(userId);
  if (!row) return row;
  return { ...row, access_token: decrypt(row.access_token), refresh_token: decrypt(row.refresh_token) };
}

// DB-backed OAuth state helpers — survive server restarts during the redirect dance
function _stateSet(state, userId, isNative = false) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO oauth_state (state, user_id, provider, data, expires_at)
              VALUES (?, ?, 'withings', ?, ?)`).run(state, userId, JSON.stringify({ isNative }), expiresAt);
  db.prepare(`DELETE FROM oauth_state WHERE expires_at < datetime('now')`).run();
}
function _stateGet(state) {
  const row = db.prepare(`SELECT * FROM oauth_state WHERE state = ? AND provider = 'withings'`).get(state);
  if (!row) return null;
  db.prepare(`DELETE FROM oauth_state WHERE state = ?`).run(state);
  if (row.expires_at < new Date().toISOString()) return null;
  const data = row.data ? JSON.parse(row.data) : {};
  return { userId: row.user_id, isNative: !!data.isNative };
}

// Token refresh
async function _refresh(userId) {
  const tokens = _getTokens(userId);
  if (!tokens) throw Object.assign(new Error('Not connected to Withings'), { status: 401 });

  const res = await fetch('https://wbsapi.withings.net/v2/oauth2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'refresh_token',
      client_id: _userCfg('withings_client_id', userId),
      client_secret: _userCfg('withings_client_secret', userId),
      refresh_token: tokens.refresh_token,
    }),
  });
  const json = await res.json();
  if (json.status !== 0) {
    db.prepare('DELETE FROM withings_tokens WHERE user_id = ?').run(userId);
    throw Object.assign(new Error('Withings token revoked — please reconnect.'), { status: 401 });
  }
  const d = json.body;
  const expiresAt = new Date(Date.now() + d.expires_in * 1000).toISOString();
  db.prepare(`UPDATE withings_tokens SET access_token=?, refresh_token=?, expires_at=? WHERE user_id=?`)
    .run(encrypt(d.access_token), encrypt(d.refresh_token), expiresAt, userId);
  return d.access_token;
}

async function _token(userId) {
  const tokens = _getTokens(userId);
  if (!tokens) throw Object.assign(new Error('Not connected to Withings'), { status: 401 });
  if (new Date(tokens.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    return _refresh(userId);
  }
  return tokens.access_token;
}

// POST wrapper for Withings API (all data endpoints are POST)
async function _wPost(userId, endpoint, params) {
  const tok = await _token(userId);
  const res = await fetch(`https://wbsapi.withings.net${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${tok}`,
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Withings HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 0) {
    logger.error('[withings] API error response:', JSON.stringify(json));
    throw new Error(`Withings API error ${json.status}: ${json.error || ''}`);
  }
  return json.body;
}

// ── GET /config ────────────────────────────────────────────────────────────────
router.get('/config', wrap((req, res) => {
  const u = uid(req);
  res.json({
    client_id:    _userCfg('withings_client_id',    u),
    redirect_uri: _userCfg('withings_redirect_uri', u),
  });
}));

// ── PUT /config ────────────────────────────────────────────────────────────────
router.put('/config', wrap((req, res) => {
  const { client_id, client_secret, redirect_uri } = req.body;
  if (userMgmtActive() && req.user) {
    const save = db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
    db.transaction(() => {
      if (client_id     !== undefined) save.run(req.user.id, 'withings_client_id',     JSON.stringify(client_id));
      if (client_secret !== undefined) save.run(req.user.id, 'withings_client_secret', JSON.stringify(client_secret));
      if (redirect_uri  !== undefined) save.run(req.user.id, 'withings_redirect_uri',  JSON.stringify(redirect_uri));
    })();
  } else {
    const save = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)');
    db.transaction(() => {
      if (client_id     !== undefined) save.run('withings_client_id',     client_id);
      if (client_secret !== undefined) save.run('withings_client_secret', client_secret);
      if (redirect_uri  !== undefined) save.run('withings_redirect_uri',  redirect_uri);
    })();
  }
  res.json({ ok: true });
}));

// ── GET /status ───────────────────────────────────────────────────────────────
router.get('/status', wrap((req, res) => {
  const u = uid(req);
  const tokens = _getTokens(u);
  const clientId = _userCfg('withings_client_id', u);
  const lastSync = db.prepare('SELECT MAX(synced_at) as ts FROM wellness_data WHERE user_id=? AND source=?').get(u, 'withings');
  res.json({
    connected:        !!tokens,
    configured:       !!clientId,
    withingsUserId:   tokens?.withings_user_id || null,
    expiresAt:        tokens?.expires_at       || null,
    lastSyncedAt:     lastSync?.ts             || null,
  });
}));

// ── GET /authorize ────────────────────────────────────────────────────────────
router.get('/authorize', wrap((req, res) => {
  const u = uid(req);
  const clientId    = _userCfg('withings_client_id',    u);
  const redirectUri = _userCfg('withings_redirect_uri', u);
  if (!clientId || !redirectUri) {
    return res.status(400).json({ error: 'Withings client_id and redirect_uri must be configured in Settings → Wellness.' });
  }
  const state = randomBytes(16).toString('hex');
  _stateSet(state, uid(req), req.query.native === '1');

  const url = 'https://account.withings.com/oauth2_user/authorize2?' + new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         'user.info,user.metrics,user.activity',
    state,
  });
  res.json({ url });
}));

// ── GET /callback ─────────────────────────────────────────────────────────────
router.get('/callback', wrap(async (req, res) => {
  const { code, state, error } = req.query;
  const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : '');
  const base = origin || '';

  if (error || !code) {
    return res.redirect(`/?withings=error&msg=${encodeURIComponent(error || 'No code')}#/wellness`);
  }

  const stored = _stateGet(state);
  if (!stored) {
    return res.redirect(`/?withings=error&msg=state_mismatch#/wellness`);
  }
  const _redir = (path) => stored.isNative ? `nutritrace://callback${path}` : path;

  const clientId     = _userCfg('withings_client_id',     stored.userId);
  const clientSecret = _userCfg('withings_client_secret', stored.userId);
  const redirectUri  = _userCfg('withings_redirect_uri',  stored.userId);

  const tokenRes = await fetch('https://wbsapi.withings.net/v2/oauth2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action:        'requesttoken',
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      redirect_uri:  redirectUri,
    }),
  });
  const json = await tokenRes.json();
  if (json.status !== 0) {
    return res.redirect(_redir(`/?withings=error&msg=${encodeURIComponent(json.error || 'Token exchange failed')}#/wellness`));
  }
  const d = json.body;
  const expiresAt = new Date(Date.now() + d.expires_in * 1000).toISOString();
  const userId = stored.userId;

  db.prepare(`
    INSERT INTO withings_tokens (user_id, access_token, refresh_token, expires_at, withings_user_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,
      expires_at=excluded.expires_at,
      withings_user_id=excluded.withings_user_id
  `).run(userId, encrypt(d.access_token), encrypt(d.refresh_token), expiresAt, String(d.userid || ''));

  res.redirect(_redir(`/?withings=connected#/wellness`));
}));

// ── Measurement type → metric mapping ────────────────────────────────────────
// Types that map to diary body_stats (auto-fill on sync if no manual entry)
const BODY_STAT_TYPES = {
  1:   { metric: 'weight_kg',     label: 'Weight',        toValue: v => v },       // kg
  6:   { metric: 'body_fat_pct',  label: 'Body Fat',      toValue: v => v },       // %
  76:  { metric: 'muscle_mass_kg',label: 'Muscle Mass',   toValue: v => v },       // kg
  88:  { metric: 'bone_mass_kg',  label: 'Bone Mass',     toValue: v => v },       // kg
  77:  { metric: 'body_water_pct',label: 'Body Water',    toValue: (v, grp) => {
    // Withings returns hydration in kg; convert to % using weight
    return v; // stored as raw value; UI can display either
  }},
};

// Types that go to wellness_data only
const WELLNESS_TYPES = {
  5:   'lean_mass_kg',
  8:   'fat_mass_kg',
  11:  'heart_pulse_bpm',
  91:  'pulse_wave_velocity',
  130: 'afib_result',             // Atrial fibrillation result (status code)
  155: 'vascular_age',            // Vascular Age (years)
  158: 'nerve_health_left_foot',  // Nerve Health Score Left Foot
  159: 'nerve_health_right_foot', // Nerve Health Score Right Foot
  168: 'extracellular_water_kg',
  169: 'intracellular_water_kg',
  170: 'visceral_fat_index',
  174: 'visceral_fat',
  196: 'eda_feet',                // Electrodermal Activity Feet
  197: 'eda_left_foot',           // Electrodermal Activity Left Foot
  198: 'eda_right_foot',          // Electrodermal Activity Right Foot
  226: 'basal_metabolic_rate',    // Basal Metabolic Rate (kcal/day)
  227: 'metabolic_age',           // Metabolic Age (years) — undocumented but confirmed from device
  229: 'electrochemical_skin_conductance', // Electrochemical Skin Conductance
  238: 'nerve_activity',          // legacy mapping kept
  239: 'nerve_health_score',      // Nerve Health Score (general)
};

// Segmental types: same type code appears 5× per measuregrp, one per body segment.
// Positional order (confirmed from device logs): Torso, Left Leg, Left Arm, Right Leg, Right Arm
const SEGMENTAL_TYPES = {
  173: { prefix: 'lean_mass',   parts: ['torso', 'left_leg', 'left_arm', 'right_leg', 'right_arm'] },
  175: { prefix: 'muscle_mass', parts: ['torso', 'left_leg', 'left_arm', 'right_leg', 'right_arm'] },
};

function _withingsValue(measure) {
  // Withings: actual_value = value * 10^unit
  return measure.value * Math.pow(10, measure.unit);
}

function _dateFromUnix(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// ── Sync measurements for a date range ────────────────────────────────────────
async function _syncRange(userId, fromDate, toDate) {
  // Use local midnight → end-of-day timestamps
  const startTs = Math.floor(new Date(fromDate + 'T00:00:00').getTime() / 1000);
  const endTs   = Math.floor(new Date(toDate   + 'T23:59:59').getTime() / 1000);

  let body;
  try {
    // Do NOT pass meastype — Withings only accepts a single integer there,
    // comma-separated lists silently return 0 results. Fetch all category-1
    // measurements and filter by type in JS using BODY_STAT_TYPES / WELLNESS_TYPES.
    body = await _wPost(userId, '/measure', {
      action:    'getmeas',
      category:  1,
      startdate: startTs,
      enddate:   endTs,
    });
  } catch (err) {
    // Log full error for debugging; re-throw so the caller surfaces it
    logger.error('[withings] /measure failed:', err.message);
    throw err;
  }

  const grps = body.measuregrps || [];
  logger.debug(`[withings] /measure returned ${grps.length} groups for ${fromDate}→${toDate} (ts ${startTs}→${endTs})`);

  // Get device model names (GET endpoint, not POST)
  let deviceModels = {};
  try {
    const tok = await _token(userId);
    const devRes = await fetch('https://wbsapi.withings.net/v2/user?action=getdevice', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const devJson = await devRes.json();
    for (const d of devJson.body?.devices || []) {
      deviceModels[d.deviceid] = d.model_id ? `Withings ${d.model}` : (d.model || 'Withings');
    }
  } catch { /* device list optional */ }

  // Use single user_id value — 0 for single-user (never null, to match read queries)
  const uid = userId ?? 0;

  // Group measurements by date
  const byDate = {};
  for (const grp of grps) {
    const date = _dateFromUnix(grp.date);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({ grp, deviceModel: deviceModels[grp.deviceid] || 'Withings' });
  }

  // Delete-then-reinsert strategy: wipe the ENTIRE date range upfront so that
  // measurements deleted in the Withings app (which return no data for that date)
  // are also removed locally. Only wipe once, before any inserts.
  db.prepare(
    `DELETE FROM wellness_data WHERE user_id = ? AND source = 'withings' AND date >= ? AND date <= ?`
  ).run(uid, fromDate, toDate);

  const insertWellness = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, device_model, synced_at)
    VALUES (?, ?, 'withings', ?, ?, ?, datetime('now'))
  `);

  for (const [date, entries] of Object.entries(byDate)) {
    // Collect the most recent value per metric across all measurement groups for this date.
    // Withings may return multiple weigh-ins per day; we keep the latest (highest grp.date ts).
    const latestByMetric = {}; // metricKey → { value, deviceModel, ts }
    const bodyStatUpdates = {};

    for (const { grp, deviceModel } of entries) {
      const segCounts = {}; // per-type position counter, reset per grp

      for (const measure of grp.measures) {
        const type = measure.type;
        const value = _withingsValue(measure);
        if (type === 227) logger.debug(`[withings] metabolic_age raw: value=${measure.value} unit=${measure.unit} → ${value} (date: ${date})`);

        if (SEGMENTAL_TYPES[type]) {
          const seg = SEGMENTAL_TYPES[type];
          const idx = segCounts[type] ?? 0;
          segCounts[type] = idx + 1;
          if (idx < seg.parts.length) {
            const metricKey = `${seg.prefix}_${seg.parts[idx]}_kg`;
            if (!latestByMetric[metricKey] || grp.date > latestByMetric[metricKey].ts) {
              latestByMetric[metricKey] = { value, deviceModel, ts: grp.date };
            }
          }
        } else {
          const metricKey = BODY_STAT_TYPES[type]?.metric || WELLNESS_TYPES[type];
          if (metricKey) {
            if (!latestByMetric[metricKey] || grp.date > latestByMetric[metricKey].ts) {
              latestByMetric[metricKey] = { value, deviceModel, ts: grp.date };
            }
          } else {
            logger.debug(`[withings] unmapped type ${type} = ${value} (date: ${date})`);
          }
        }

        if (BODY_STAT_TYPES[type]) {
          const stat = BODY_STAT_TYPES[type];
          if (!bodyStatUpdates[stat.metric] || grp.date > (bodyStatUpdates[stat.metric]._ts || 0)) {
            bodyStatUpdates[stat.metric] = { value, _ts: grp.date };
          }
        }
      }
    }

    for (const [metricKey, { value, deviceModel }] of Object.entries(latestByMetric)) {
      insertWellness.run(uid, date, metricKey, value, deviceModel);
    }

    if (Object.keys(bodyStatUpdates).length > 0) {
      _mergeDiaryBodyStats(uid, date, bodyStatUpdates);
    }
  }

  const dates = Object.keys(byDate).length;
  logger.debug(`[withings] stored data for ${dates} date(s)`);

  // ── ECG recordings (requires user.cardiovascular scope) ──────────────────────
  try {
    const tok = await _token(userId);
    const ecgRes = await fetch(
      `https://wbsapi.withings.net/v2/heart?action=list&startdate=${startTs}&enddate=${endTs}`,
      { headers: { Authorization: `Bearer ${tok}` } }
    );
    const ecgJson = await ecgRes.json();
    if (ecgJson.status === 0) {
      // Group ECG readings by date; keep latest heart_rate, flag afib if any recording shows it
      const ecgByDate = {};
      for (const rec of (ecgJson.body?.series || [])) {
        const date = _dateFromUnix(rec.timestamp);
        if (!date) continue;
        if (!ecgByDate[date]) ecgByDate[date] = { heart_rate: null, afib: 0, ts: 0 };
        if (rec.timestamp > ecgByDate[date].ts) {
          ecgByDate[date].ts = rec.timestamp;
          if (rec.heart_rate != null) ecgByDate[date].heart_rate = rec.heart_rate;
        }
        if (rec.ecg?.afib === 1) ecgByDate[date].afib = 1;
      }
      db.transaction(() => {
        for (const [date, { heart_rate, afib }] of Object.entries(ecgByDate)) {
          if (heart_rate != null) insertWellness.run(uid, date, 'ecg_heart_rate', heart_rate, 'Withings');
          insertWellness.run(uid, date, 'ecg_afib', afib, 'Withings');
        }
      })();
    }
  } catch { /* ECG is optional — user may not have cardiovascular scope yet */ }

  return { synced: dates, dates };
}

function _mergeDiaryBodyStats(userId, date, updates) {
  // Diary uses user_id = NULL for single-user (consistent with diary route)
  // wellness_data uses 0 for single-user — convert here
  const u = (userId === 0 || userId == null) ? null : userId;

  const row = u == null
    ? db.prepare('SELECT body_stats FROM diary WHERE date = ? AND user_id IS NULL').get(date)
    : db.prepare('SELECT body_stats FROM diary WHERE date = ? AND user_id = ?').get(date, u);

  const existing = JSON.parse(row?.body_stats || '{}');

  let changed = false;
  for (const [key, { value }] of Object.entries(updates)) {
    // Only fill if no existing value — don't overwrite manual entries
    if (existing[key] == null) {
      existing[key] = value;
      changed = true;
    }
  }

  if (!changed) return;

  if (u == null) {
    db.prepare(`
      INSERT INTO diary (date, items, body_stats, water, updated_at)
      VALUES (?, '[]', ?, '[]', datetime('now'))
      ON CONFLICT(date, user_id) DO UPDATE SET
        body_stats=excluded.body_stats, updated_at=excluded.updated_at
    `).run(date, JSON.stringify(existing));
  } else {
    db.prepare(`
      INSERT INTO diary (user_id, date, items, body_stats, water, updated_at)
      VALUES (?, ?, '[]', ?, '[]', datetime('now'))
      ON CONFLICT(date, user_id) DO UPDATE SET
        body_stats=excluded.body_stats, updated_at=excluded.updated_at
    `).run(u, date, JSON.stringify(existing));
  }
}

// ── POST /sync ────────────────────────────────────────────────────────────────
router.post('/sync', wrap(async (req, res) => {
  const u = uid(req);
  let { date, from, to } = req.body;
  if (!date && !from) date = new Date().toISOString().slice(0, 10);
  if (date && !from) { from = date; to = date; }

  const result = await _syncRange(u, from, to);
  res.json({ ok: true, ...result });
}));

// ── GET /data ─────────────────────────────────────────────────────────────────
router.get('/data', wrap((req, res) => {
  const u = uid(req);
  const { date, from, to, metric } = req.query;

  let rows;
  const uCond = (u === 0 || u == null) ? 'user_id IS NULL OR user_id = 0' : 'user_id = ?';
  const uArgs = (u === 0 || u == null) ? [] : [u];

  if (date) {
    rows = db.prepare(`SELECT * FROM wellness_data WHERE (${uCond}) AND date = ? AND source = 'withings'${metric ? ' AND metric_type = ?' : ''} ORDER BY date`)
      .all(...uArgs, date, ...(metric ? [metric] : []));
  } else if (from && to) {
    rows = db.prepare(`SELECT * FROM wellness_data WHERE (${uCond}) AND date >= ? AND date <= ? AND source = 'withings'${metric ? ' AND metric_type = ?' : ''} ORDER BY date`)
      .all(...uArgs, from, to, ...(metric ? [metric] : []));
  } else {
    rows = db.prepare(`SELECT * FROM wellness_data WHERE (${uCond}) AND source = 'withings'${metric ? ' AND metric_type = ?' : ''} ORDER BY date`)
      .all(...uArgs, ...(metric ? [metric] : []));
  }

  // Group by date → metric_type
  const out = {};
  for (const r of rows) {
    if (!out[r.date]) out[r.date] = {};
    out[r.date][r.metric_type] = { value: r.value, device_model: r.device_model };
  }
  res.json(out);
}));

// ── DELETE /disconnect ────────────────────────────────────────────────────────
router.delete('/disconnect', wrap(async (req, res) => {
  const u = uid(req);
  db.prepare('DELETE FROM withings_tokens WHERE user_id = ?').run(u);
  res.json({ ok: true });
}));

export { _syncRange as syncRange };
export default router;
