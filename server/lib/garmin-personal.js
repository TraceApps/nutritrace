/**
 * garmin-personal.js: Garmin Connect Personal API connector (#279).
 *
 * A second way to connect Garmin, next to the Health API partnership in
 * routes/garmin.js. Each person creates a Personal API key on Garmin Connect
 * (Settings > Personal API Key), pastes it into Settings > Wellness, and the
 * server pulls their own data. No partnership or approval needed.
 *
 * Auth (from Garmin's published Personal API docs):
 *   POST {host}/personalapitoken-service/personal-api/personal-api-key/token
 *     Authorization: ApiKey <key>   ->  body is a JWT (about 24 h, no refresh)
 *   GET  {host}/<data path>
 *     Authorization: Bearer <jwt>
 *
 * Rows are written with source 'garmin' and the same metric_type names the
 * partner integration writes, so every reader that understands Garmin
 * (Wellness, Statistics, Goals, calories out, adaptive TDEE, Readiness,
 * alerts, Trace, MCP, weekly email) works unchanged.
 *
 * Gentle on Garmin: four range endpoints per sync (daily summaries, sleep,
 * HRV, weight), no per-day loops, one sync per person at a time, and a short
 * gap between pulls. The key and the token are stored encrypted
 * (token-crypto.js) and never logged or returned by the API.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { encrypt, decrypt } from './token-crypto.js';

export const GARMIN_PERSONAL_HOSTS = {
  global: 'https://personal.connectapi.garmin.com',
  cn:     'https://personal.connectapi.garmin.cn',
};
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_EARLY_MS     = 10 * 60_000;    // new token this long before it ends
                                           // (half its life for a short one)
const BACKFILL_DAYS      = 30;             // first sync
const RECENT_DAYS        = 3;              // later syncs: late watch uploads land
const MAX_DAYS           = 366;
const MIN_GAP_MS         = 30_000;         // between two pulls for one person
export const EXPIRY_WARN_DAYS = 7;

// Per-call date limits. Garmin's docs say 1 year for daily summaries and
// 31 days for sleep; reported limits in practice are lower (180 and 28), so
// stay well inside both.
const CHUNK = { daily: 90, sleep: 28, hrv: 90, weight: 28 };

// Table: garmin_personal in server/db.js (key and token encrypted).

export class GarminPersonalError extends Error {
  /** code: bad_key | not_connected | rate_limited | timeout | unavailable | bad_response */
  constructor(code, status = null) {
    super(code + (status ? ` (${status})` : ''));
    this.code = code;
    this.httpStatus = status;
  }
}

/** Where requests go. GARMIN_PERSONAL_API_BASE points a test server at a mock. */
export function hostFor(region) {
  const override = process.env.GARMIN_PERSONAL_API_BASE;
  if (override) return override.replace(/\/+$/, '');
  return GARMIN_PERSONAL_HOSTS[region] || GARMIN_PERSONAL_HOSTS.global;
}

// ── Dates ────────────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;   // no Feb 30
}
export function shiftDay(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
/** [from, to] split into pieces of at most `size` days, both ends included. */
export function chunkRange(from, to, size) {
  const out = [];
  for (let s = from; s <= to; s = shiftDay(s, size)) {
    const e = shiftDay(s, size - 1);
    out.push([s, e < to ? e : to]);
  }
  return out;
}

/**
 * The days one sync asks Garmin for. The first sync (and the first after a
 * new key) backfills 30 days up to today. Later ones cover the last few days
 * of the day asked for, so a watch that uploads late still lands, reach back
 * to the last good sync (up to 30 days) after a gap, and take a longer range
 * when one is asked for, up to a year.
 */
export function syncWindow({ from, to, backfilled, lastSync = null, today = new Date().toISOString().slice(0, 10) }) {
  // The asking device's date when given (it knows the person's time zone);
  // never more than a day past the server's.
  const latest = shiftDay(today, 1);
  let end = isDate(to) ? to : today;
  if (end > latest) end = latest;
  let start;
  if (!backfilled) {
    if (end < today) end = today;
    start = shiftDay(end, -(BACKFILL_DAYS - 1));
  } else {
    start = shiftDay(end, -(RECENT_DAYS - 1));
    // After a gap (server down, key replaced), pick up from the last good sync.
    if (isDate(lastSync) && end >= shiftDay(today, -1)) {
      const resume = shiftDay(lastSync, -1);
      const floor = shiftDay(end, -(BACKFILL_DAYS - 1));
      if (resume < start) start = resume < floor ? floor : resume;
    }
  }
  if (isDate(from) && from < start) start = from;
  if (daysBetween(start, end) > MAX_DAYS - 1) start = shiftDay(end, -(MAX_DAYS - 1));
  return { from: start, to: end };
}

// ── Values ───────────────────────────────────────────────────────────────────
const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v
  : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) ? Number(v) : null;
const nonNeg = (v) => { const n = num(v); return n != null && n >= 0 ? n : null; };
const positive = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };
const minutes = (sec) => { const n = nonNeg(sec); return n == null ? null : Math.round(n / 60); };
const round = (v, d) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
/** Masses: Garmin's docs say kilograms, its own app stores grams. Anything
 *  over 500 can't be a body weight, muscle or bone mass in kg, so it's grams. */
const kg = (v) => { const n = positive(v); if (n == null) return null; return round(n > 500 ? n / 1000 : n, 2); };

/**
 * Local wall clock from a Garmin "...Local" timestamp: an ISO string without
 * offset ("2023-10-09T06:41:00.0") or epoch milliseconds already shifted to
 * local time (Garmin's older shape). Returns { date, min } or null.
 */
export function localClock(v) {
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return { date: m[1], min: Number(m[2]) * 60 + Number(m[3]) };
    if (/^\d{10,}$/.test(v.trim())) v = Number(v);
    else return null;
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const d = new Date(v);
    return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  return null;
}

function put(out, date, metrics) {
  if (!isDate(date)) return;
  for (const [k, v] of Object.entries(metrics)) if (v != null) (out[date] ??= {})[k] = v;
}

// ── Parsers (shapes from Garmin's Personal API schemas) ─────────────────────

/** GET /usersummary-service/v2/dailysummaries -> { data: [UserDailySummaryV2DTO] } */
export function parseDailySummaries(body) {
  const out = {};
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    // A day nothing was worn: Garmin's own estimate (BMR calories, zero
    // steps) isn't a reading.
    if (d.includesWellnessData === false && d.includesActivityData === false) continue;
    const mv = d.movement || {}, cal = d.calories || {}, hr = d.heartRate || {};
    const im = d.intensityMinutes || {}, st = d.stress || {}, bb = d.bodyBattery || {};
    const moderate = nonNeg(im.moderate), vigorous = nonNeg(im.vigorous);
    const meters = nonNeg(mv.steps?.distanceInMeters);
    put(out, d.calendarDate, {
      steps:                  nonNeg(mv.steps?.value),
      distance_km:            meters == null ? null : round(meters / 1000, 2),
      floors:                 nonNeg(mv.floorsAscended?.value),
      calories_out:           positive(cal.burnedTotal),
      active_calories:        nonNeg(cal.burnedActive),
      resting_hr:             positive(hr.restingValue),
      max_hr:                 positive(hr.maxValue),
      moderate_intensity_min: moderate,
      vigorous_intensity_min: vigorous,
      active_minutes:         (moderate != null || vigorous != null) ? (moderate ?? 0) + (vigorous ?? 0) : null,
      stress_avg:             nonNeg(st.avgLevel),
      body_battery_high:      positive(bb.maxValue),
      body_battery_low:       positive(bb.minValue),
      spo2_avg:               positive(d.pulseOx?.avgValue),
    });
  }
  return out;
}

/** GET /sleep-service/sleep/dailySleepSummariesByDate -> [DailySleepDTO]
 *  Filed under the wake-up date, like every other sleep source. */
export function parseSleep(body) {
  const out = {};
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const start = localClock(n.sleepStartTimestampLocal);
    const end   = localClock(n.sleepEndTimestampLocal);
    const date  = end?.date || n.calendarDate;
    const duration = minutes(n.sleepTimeSeconds);
    if (!duration) continue;  // no measured night (naps only, or nothing)
    put(out, date, {
      sleep_duration_min: duration,
      sleep_deep_min:     minutes(n.deepSleepSeconds),
      sleep_light_min:    minutes(n.lightSleepSeconds),
      sleep_rem_min:      minutes(n.remSleepSeconds),
      sleep_wake_min:     minutes(n.awakeSleepSeconds),
      sleep_score:        nonNeg(n.sleepScores?.overall?.value),
      respiratory_rate:   positive(n.averageRespirationValue) == null ? null : round(positive(n.averageRespirationValue), 1),
      sleep_start_min:    start?.min ?? null,
      sleep_end_min:      end?.min ?? null,
      _spo2:              positive(n.averageSpO2Value) == null ? null : round(positive(n.averageSpO2Value), 1),
    });
  }
  return out;
}

/** GET /hrv-service/hrv/daily/{from}/{to} -> { hrvSummaries: [...] } (204 when none) */
export function parseHrv(body) {
  const out = {};
  for (const h of (Array.isArray(body?.hrvSummaries) ? body.hrvSummaries : [])) {
    if (!h || typeof h !== 'object') continue;
    put(out, h.calendarDate, { hrv_daily_rmssd: positive(h.lastNightAvg) });
  }
  return out;
}

/** GET /weight-service/weight/range/{from}/{to} -> WeightRangeDTO */
export function parseWeight(body) {
  const out = {};
  for (const s of (Array.isArray(body?.dailyWeightSummaries) ? body.dailyWeightSummaries : [])) {
    const w = s?.latestWeight;
    if (!w || typeof w !== 'object') continue;
    const bodyFat = positive(w.bodyFat), water = positive(w.bodyWater);
    put(out, s.summaryDate || w.calendarDate, {
      weight_kg:      kg(w.weight),
      bmi:            positive(w.bmi) == null ? null : round(positive(w.bmi), 1),
      body_fat_pct:   bodyFat != null && bodyFat <= 100 ? round(bodyFat, 1) : null,
      body_water_pct: water != null && water <= 100 ? round(water, 1) : null,
      muscle_mass_kg: kg(w.muscleMass),
      bone_mass_kg:   kg(w.boneMass),
      visceral_fat:   positive(w.visceralFat),
      metabolic_age:  positive(w.metabolicAge),
    });
  }
  return out;
}

// ── Storage ──────────────────────────────────────────────────────────────────
export function getRow(userId) {
  return db.prepare('SELECT * FROM garmin_personal WHERE user_id = ?').get(userId) || null;
}

/** What Settings may see. Never the key or the token. */
export function publicStatus(row, now = Date.now()) {
  if (!row) return null;
  let keyDaysLeft = null;
  if (row.key_expires_at && isDate(row.key_expires_at)) {
    keyDaysLeft = daysBetween(new Date(now).toISOString().slice(0, 10), row.key_expires_at);
  }
  return {
    connected:     row.state === 'ok',
    state:         row.state,             // 'ok' | 'needs_key'
    keyExpired:    keyDaysLeft != null && keyDaysLeft < 0,
    region:        row.region,
    keyExpiresAt:  row.key_expires_at || null,
    keyDaysLeft,
    keyExpiringSoon: keyDaysLeft != null && keyDaysLeft >= 0 && keyDaysLeft <= EXPIRY_WARN_DAYS,
    lastSyncAt:    row.last_sync_at ? row.last_sync_at.replace(' ', 'T') + 'Z' : null,
    lastError:     row.last_error || null,
    backfilled:    !!row.backfilled_at,
    connectedAt:   row.created_at ? row.created_at.replace(' ', 'T') + 'Z' : null,
  };
}

/** Basic sanity on a pasted key; Garmin decides whether it's real. */
export function cleanKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length < 16 || key.length > 4096) return null;
  if (!/^[\x21-\x7e]+$/.test(key)) return null;   // printable, no spaces
  return key;
}

export function cleanRegion(r) {
  return r === 'cn' ? 'cn' : 'global';
}

export function cleanExpiry(v) {
  if (v == null || v === '') return null;
  return isDate(v) ? v : undefined;   // undefined = invalid
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
let requestTimeoutMs = REQUEST_TIMEOUT_MS;
/** Tests only: a shorter deadline. */
export function _setRequestTimeoutForTests(ms) { requestTimeoutMs = ms || REQUEST_TIMEOUT_MS; }

async function _fetch(url, init) {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new GarminPersonalError('timeout');
    throw new GarminPersonalError('unavailable');
  }
}

/** The JWT out of the token response: a bare string, a quoted string, or an object holding one. */
export function readToken(text) {
  let t = String(text || '').trim();
  if (t.startsWith('"')) { try { t = JSON.parse(t); } catch { /* keep */ } }
  else if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      t = o.access_token || o.accessToken || o.token || o.jwt || '';
    } catch { t = ''; }
  }
  t = typeof t === 'string' ? t.trim() : '';
  const parts = t.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  let exp = null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (Number.isFinite(claims?.exp)) exp = claims.exp * 1000;
  } catch { /* opaque payload: assume the documented 24 h */ }
  return { token: t, expiresAt: exp ?? Date.now() + 23 * 3600_000 };
}

/** Swap an API key for an access token. Throws bad_key when Garmin says no. */
export async function exchangeKey(apiKey, region) {
  const res = await _fetch(hostFor(region) + TOKEN_PATH, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${apiKey}`, Accept: 'application/json, text/plain' },
  });
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) throw new GarminPersonalError('bad_key', res.status);
  if (res.status === 429) throw new GarminPersonalError('rate_limited', 429);
  if (!res.ok) throw new GarminPersonalError('unavailable', res.status);
  const tok = readToken(text);
  if (!tok) throw new GarminPersonalError('bad_response', res.status);
  return tok;
}

// Writes after a Garmin call name the key they were made with (its stored
// ciphertext), so a key replaced meanwhile is never touched by the old one's
// answer.
function _markNeedsKey(userId, keyCipher) {
  db.prepare(`UPDATE garmin_personal SET state = 'needs_key', access_token = NULL, token_expires_at = NULL,
              last_error = 'bad_key' WHERE user_id = ? AND api_key = ?`).run(userId, keyCipher);
}

/** When to swap a token for a new one: ten minutes before it ends, or
 *  halfway for a short one (a token never outlives its key, so the last
 *  day's tokens can be short). Stored as token_expires_at. */
export function renewAt(expiresAt, now = Date.now()) {
  return expiresAt - Math.min(TOKEN_EARLY_MS, Math.max(0, (expiresAt - now) / 2));
}

function _saveToken(userId, keyCipher, tok) {
  db.prepare('UPDATE garmin_personal SET access_token = ?, token_expires_at = ? WHERE user_id = ? AND api_key = ?')
    .run(encrypt(tok.token), new Date(renewAt(tok.expiresAt)).toISOString(), userId, keyCipher);
}

/** A token good for at least ten more minutes: the stored one, or a new one. */
async function _token(userId, { fresh = false, keyCipher = null } = {}) {
  const row = getRow(userId);
  if (!row) throw new GarminPersonalError('not_connected');
  if (keyCipher && row.api_key !== keyCipher) throw new GarminPersonalError('not_connected');   // replaced mid-sync
  if (row.state !== 'ok') throw new GarminPersonalError('bad_key');
  if (!fresh && row.access_token && row.token_expires_at && Date.parse(row.token_expires_at) > Date.now()) {
    const t = decrypt(row.access_token);
    if (t) return t;
  }
  const key = decrypt(row.api_key);
  if (!key) { _markNeedsKey(userId, row.api_key); throw new GarminPersonalError('bad_key'); }  // server key changed
  try {
    const tok = await exchangeKey(key, row.region);
    _saveToken(userId, row.api_key, tok);
    return tok.token;
  } catch (e) {
    if (e.code === 'bad_key') _markNeedsKey(userId, row.api_key);
    throw e;
  }
}

/** Authenticated GET. On a 401 gets one new token and tries once more. */
export async function apiGet(userId, path, query = null, keyCipher = null) {
  const region = getRow(userId)?.region;
  const url = hostFor(region) + path + (query ? '?' + new URLSearchParams(query).toString() : '');
  let token = await _token(userId, { keyCipher });
  for (let attempt = 0; ; attempt++) {
    const res = await _fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (res.status === 401 && attempt === 0) {
      try { await res.body?.cancel(); } catch {}
      token = await _token(userId, { fresh: true, keyCipher });
      continue;
    }
    if (res.status === 204) { try { await res.body?.cancel(); } catch {} return null; }
    if (res.status === 429) { try { await res.body?.cancel(); } catch {} throw new GarminPersonalError('rate_limited', 429); }
    if (!res.ok) { try { await res.body?.cancel(); } catch {} throw new GarminPersonalError('unavailable', res.status); }
    const text = await res.text().catch(() => '');
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new GarminPersonalError('bad_response', res.status); }
  }
}

// ── Connect / disconnect ─────────────────────────────────────────────────────

/** Check the key with Garmin right away, then store it. Throws GarminPersonalError. */
export async function connect(userId, { apiKey, region, keyExpiresAt }) {
  const tok = await exchangeKey(apiKey, region);
  db.prepare(`
    INSERT INTO garmin_personal (user_id, api_key, region, access_token, token_expires_at, key_expires_at, state,
                                 last_error, last_attempt_at, last_sync_at, backfilled_at, expiry_notice, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL, NULL, NULL, NULL, NULL, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      api_key = excluded.api_key, region = excluded.region, access_token = excluded.access_token,
      token_expires_at = excluded.token_expires_at, key_expires_at = excluded.key_expires_at,
      state = 'ok', last_error = NULL, last_attempt_at = NULL, expiry_notice = NULL, created_at = datetime('now'),
      backfilled_at = NULL   -- a new key (maybe another Garmin account) gets the 30-day backfill again
  `).run(userId, encrypt(apiKey), region, encrypt(tok.token), new Date(renewAt(tok.expiresAt)).toISOString(), keyExpiresAt ?? null);
  return getRow(userId);
}

export function setKeyExpiry(userId, keyExpiresAt) {
  return db.prepare('UPDATE garmin_personal SET key_expires_at = ?, expiry_notice = NULL WHERE user_id = ?')
    .run(keyExpiresAt ?? null, userId).changes > 0;
}

/** Deletes the stored key and token. Synced readings stay, like every other source. */
export function disconnect(userId) {
  _inflight.delete(userId);
  return db.prepare('DELETE FROM garmin_personal WHERE user_id = ?').run(userId).changes > 0;
}

// ── Sync ─────────────────────────────────────────────────────────────────────
const _inflight = new Map();

const STEPS = [
  { name: 'daily',  chunk: CHUNK.daily,  parse: parseDailySummaries,
    req: (f, t) => ['/usersummary-service/v2/dailysummaries', { startDate: f, endDate: t }] },
  { name: 'sleep',  chunk: CHUNK.sleep,  parse: parseSleep,
    req: (f, t) => ['/sleep-service/sleep/dailySleepSummariesByDate', { startDate: f, endDate: t }] },
  { name: 'hrv',    chunk: CHUNK.hrv,    parse: parseHrv,
    req: (f, t) => [`/hrv-service/hrv/daily/${f}/${t}`, null] },
  { name: 'weight', chunk: CHUNK.weight, parse: parseWeight,
    req: (f, t) => [`/weight-service/weight/range/${f}/${t}`, null] },
];

/**
 * Pull a window from Garmin and upsert it. Resolves to
 * { synced (days with data), metrics, from, to, errors, skipped? }.
 * Never rejects for an empty account: no watch is a normal state.
 */
export function syncPersonal(userId, opts = {}) {
  const running = _inflight.get(userId);
  if (running) return running;
  const p = _sync(userId, opts).finally(() => { if (_inflight.get(userId) === p) _inflight.delete(userId); });
  _inflight.set(userId, p);
  return p;
}

async function _sync(userId, { from, to, force = false, today } = {}) {
  const row = getRow(userId);
  if (!row) throw new GarminPersonalError('not_connected');
  if (row.state !== 'ok') throw new GarminPersonalError('bad_key');
  const since = row.last_attempt_at ? Date.now() - Date.parse(row.last_attempt_at) : Infinity;
  if (!force && since < MIN_GAP_MS) {
    return { synced: 0, metrics: 0, skipped: 'recent', errors: [] };
  }
  db.prepare('UPDATE garmin_personal SET last_attempt_at = ? WHERE user_id = ?').run(new Date().toISOString(), userId);

  const keyCipher = row.api_key;
  const lastSync = row.last_sync_at ? row.last_sync_at.slice(0, 10) : null;
  const win = syncWindow({ from, to, backfilled: !!row.backfilled_at, lastSync, today });
  const byDate = {};
  const errors = [];
  let okSteps = 0;
  let fatal = null, lastErr = null;
  for (const step of STEPS) {
    if (fatal) break;
    try {
      for (const [f, t] of chunkRange(win.from, win.to, step.chunk)) {
        const [path, query] = step.req(f, t);
        const body = await apiGet(userId, path, query, keyCipher);
        const parsed = step.parse(body);
        for (const [date, m] of Object.entries(parsed)) {
          if (date < win.from || date > win.to) continue;
          put(byDate, date, m);
        }
      }
      okSteps++;
    } catch (e) {
      const code = e instanceof GarminPersonalError ? e.code : 'unavailable';
      lastErr = e instanceof GarminPersonalError ? e : new GarminPersonalError('unavailable');
      errors.push(`${step.name}: ${e instanceof GarminPersonalError ? e.message : 'failed'}`);
      logger.warn(`[garmin-personal] user ${userId} ${step.name} ${win.from}..${win.to}: ${e instanceof GarminPersonalError ? e.message : 'request failed'}`);
      if (code === 'bad_key' || code === 'rate_limited' || code === 'not_connected') fatal = e;
    }
  }

  // Overnight SpO2 when the day's summary has none.
  for (const day of Object.values(byDate)) {
    if (day._spo2 != null && day.spo2_avg == null) day.spo2_avg = day._spo2;
    delete day._spo2;
  }

  const upsert = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
    VALUES (?, ?, 'garmin', ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
      value = excluded.value, synced_at = excluded.synced_at
  `);
  let metrics = 0;
  const dates = Object.keys(byDate).filter(d => Object.keys(byDate[d]).length).sort();
  if (getRow(userId)?.api_key === keyCipher) {  // not disconnected or replaced while the requests ran
    db.transaction(() => {
      for (const date of dates) {
        for (const [type, value] of Object.entries(byDate[date])) { upsert.run(userId, date, type, value); metrics++; }
      }
    })();
  }

  if (okSteps > 0) {
    db.prepare(`UPDATE garmin_personal SET last_sync_at = datetime('now'),
                backfilled_at = COALESCE(backfilled_at, CASE WHEN ? THEN datetime('now') END),
                last_error = ? WHERE user_id = ? AND state = 'ok' AND api_key = ?`)
      .run(okSteps === STEPS.length ? 1 : 0, errors.length ? (fatal?.code || 'partial') : null, userId, keyCipher);
  } else if (fatal?.code !== 'bad_key') {
    const code = fatal?.code || lastErr?.code || 'unavailable';
    db.prepare(`UPDATE garmin_personal SET last_error = ? WHERE user_id = ? AND state = 'ok' AND api_key = ?`).run(code, userId, keyCipher);
  }

  // Weight into the diary when the person turned that mirror on (#200).
  if (dates.some(d => byDate[d].weight_kg != null)) {
    try {
      const { mirrorWeightToBodyStats } = await import('./wellness-mirror.js');
      for (const d of dates) if (byDate[d].weight_kg != null) mirrorWeightToBodyStats(userId || null, d, byDate[d].weight_kg);
    } catch (e) { logger.debug('[garmin-personal] weight mirror skipped: ' + e.message); }
  }

  // Lock in today's Readiness and stress like the other sources do.
  const serverToday = new Date().toISOString().slice(0, 10);
  const scoreDay = win.to <= serverToday ? win.to : serverToday;
  if (dates.length && scoreDay >= win.from) {
    try {
      const { snapshotScores } = await import('./wellness-scores.js');
      snapshotScores(userId, scoreDay);
    } catch (e) { logger.debug('[garmin-personal] snapshot skipped: ' + e.message); }
  }

  // Nothing at all came back: say why. Some of it did: the rest is in errors.
  if (okSteps === 0 && (fatal || lastErr)) throw fatal || lastErr;
  return { synced: dates.length, metrics, from: win.from, to: win.to, errors };
}

// ── Key expiry notices ───────────────────────────────────────────────────────

/**
 * Once when the key is a week from ending, once when it has ended, and once
 * when Garmin turns it down. Uses the sync-failure notification setting.
 */
export async function checkKeyNotices(userId, now = Date.now()) {
  const row = getRow(userId);
  if (!row) return null;
  const st = publicStatus(row, now);
  let stage = null, title = null, message = null;
  if (row.state === 'needs_key') {
    stage = 'dead'; title = 'Garmin Key Stopped Working';
    message = 'Garmin no longer accepts your Personal API key, so Garmin sync has stopped. Create a new key on Garmin Connect and paste it in Settings > Wellness > Garmin.';
  } else if (st.keyDaysLeft != null && st.keyDaysLeft < 0) {
    stage = 'expired'; title = 'Garmin Key Expired';
    message = 'The expiry date of your Garmin Personal API key has passed. When Garmin stops accepting it, Garmin sync stops: create a new key on Garmin Connect and paste it in Settings > Wellness > Garmin.';
  } else if (st.keyExpiringSoon) {
    stage = 'soon'; title = 'Garmin Key Expiring';
    message = `Your Garmin Personal API key expires in ${st.keyDaysLeft} day${st.keyDaysLeft === 1 ? '' : 's'}. Create a new key on Garmin Connect and paste it in Settings > Wellness > Garmin to keep syncing.`;
  }
  if (!stage || row.expiry_notice === stage) return null;
  db.prepare('UPDATE garmin_personal SET expiry_notice = ? WHERE user_id = ?').run(stage, userId);
  try {
    const { pushNotify } = await import('./push-notify.js');
    await pushNotify(userId, 'notifSyncFailures', title, message, 8);
  } catch (e) { logger.debug('[garmin-personal] notice not sent: ' + e.message); }
  return stage;
}
