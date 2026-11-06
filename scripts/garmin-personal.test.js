/**
 * Garmin Personal API connector (#279), against a local mock of Garmin's
 * Personal API built from its published schemas
 * (scripts/fixtures/garmin-personal-mock.mjs). Never touches the network.
 *
 * Covers: key exchange, token caching and early renewal, one retry on a
 * 401, a dead key, an account with no watch, every parser to its
 * metric_type and date (sleep by wake-up date), the 30-day backfill and the
 * short later window, re-sync dedupe, Disconnect, two accounts kept apart,
 * and the key never showing up in logs or API answers.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { startMock } from './fixtures/garmin-personal-mock.mjs';

const KEY_A = 'MOCKAAAA_clientid000000000000000000000000.11111111-2222-3333-4444-555555555555.secretpartaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.123456789';
const KEY_B = 'MOCKBBBB_clientid000000000000000000000000.66666666-7777-8888-9999-000000000000.secretpartbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.987654321';

// Everything the server prints, to check the key and tokens never appear.
const printed = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { printed.push(a.map(String).join(' ')); if (process.env.SHOW_LOGS) orig(...a); };
}
const stdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (c, ...r) => { printed.push(String(c)); return stdoutWrite(c, ...r); };
process.stderr.write = (c, ...r) => { printed.push(String(c)); return stderrWrite(c, ...r); };

let db = null, dir = null, server = null, base = null, mock = null, gp = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  mock = await startMock({ validKeys: [KEY_A, KEY_B] });
  process.env.GARMIN_PERSONAL_API_BASE = mock.url;
  process.env.LOG_LEVEL = 'debug';
  dir = mkdtempSync(join(tmpdir(), 'garmin-personal-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  gp = await import('../server/lib/garmin-personal.js');
  const express = req('express');
  const { default: garminRoutes } = await import('../server/routes/garmin.js');
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { r.user = { id: Number(r.headers['x-user']), role: 'user' }; next(); });
  app.use('/api/wellness/garmin', garminRoutes);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch (e) { if (process.env.SHOW_LOGS) stderrWrite(String(e?.stack) + '\n'); /* better-sqlite3 not built for this Node: the cases skip */ }
test.after(async () => {
  server?.close(); await mock?.close();
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const skip = !db;
const user = (n) => Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(n + Math.random(), 'x').lastInsertRowid);
const api = async (u, method, path, body) => {
  const r = await fetch(base + '/api/wellness/garmin' + path, {
    method, headers: { 'x-user': String(u), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : null };
};
const rows = (u) => db.prepare(`SELECT date, metric_type, value FROM wellness_data WHERE user_id = ? AND source = 'garmin' ORDER BY date, metric_type`).all(u);
const val = (u, date, type) => db.prepare(`SELECT value FROM wellness_data WHERE user_id=? AND source='garmin' AND date=? AND metric_type=?`).get(u, date, type)?.value;
const dataCalls = () => mock.state.requests.filter(r => !r.path.startsWith('/personalapitoken'));
const tokenCalls = () => mock.state.requests.filter(r => r.path.startsWith('/personalapitoken'));
const today = new Date().toISOString().slice(0, 10);
const resetMock = () => { mock.state.requests.length = 0; mock.state.mode = 'watch'; mock.state.rejectNextData = 0; mock.state.status429 = false; mock.state.tokenTtlSec = 86400; mock.state.tokenFormat = 'raw'; };

// ── Parsers, straight from the schema shapes ────────────────────────────────

test('daily summaries map to the partner integration\'s metric names', { skip }, async () => {
  const { dailySummary } = await import('./fixtures/garmin-personal-mock.mjs');
  const d = dailySummary('2026-11-04');
  const out = gp.parseDailySummaries({ data: [d] })['2026-11-04'];
  assert.equal(out.steps, d.movement.steps.value);
  assert.equal(out.distance_km, Math.round(d.movement.steps.distanceInMeters / 10) / 100);
  assert.equal(out.floors, d.movement.floorsAscended.value);
  assert.equal(out.calories_out, d.calories.burnedTotal);
  assert.equal(out.active_calories, d.calories.burnedActive);
  assert.equal(out.resting_hr, d.heartRate.restingValue);
  assert.equal(out.max_hr, d.heartRate.maxValue);
  assert.equal(out.moderate_intensity_min, d.intensityMinutes.moderate);
  assert.equal(out.vigorous_intensity_min, d.intensityMinutes.vigorous);
  assert.equal(out.active_minutes, d.intensityMinutes.moderate + d.intensityMinutes.vigorous);
  assert.equal(out.stress_avg, d.stress.avgLevel);
  assert.equal(out.body_battery_high, d.bodyBattery.maxValue);
  assert.equal(out.body_battery_low, d.bodyBattery.minValue);
  assert.equal(out.spo2_avg, d.pulseOx.avgValue);
  // The day's resting calories are BMR so far, not a scale BMR: not stored.
  assert.equal(out.basal_metabolic_rate, undefined);
});

test('a day nothing was worn (no wellness or activity data) is not stored', { skip }, async () => {
  const { dailySummary } = await import('./fixtures/garmin-personal-mock.mjs');
  const worn = dailySummary('2026-11-04');
  const unworn = { ...dailySummary('2026-11-05'), includesWellnessData: false, includesActivityData: false };
  assert.deepEqual(Object.keys(gp.parseDailySummaries({ data: [worn, unworn] })), ['2026-11-04']);
  // Either flag on, or the flags missing: kept.
  assert.ok(gp.parseDailySummaries({ data: [{ ...unworn, includesActivityData: true }] })['2026-11-05']);
  const { includesWellnessData, includesActivityData, ...noFlags } = unworn;
  assert.ok(gp.parseDailySummaries({ data: [noFlags] })['2026-11-05']);
});

test('daily summaries skip missing and negative values (Garmin uses -1 / -2 for none)', { skip }, () => {
  const out = gp.parseDailySummaries({ data: [{ calendarDate: '2026-11-04', stress: { avgLevel: -1 }, movement: { steps: { value: 0 } }, heartRate: {} }] });
  assert.deepEqual(out, { '2026-11-04': { steps: 0 } });
  assert.deepEqual(gp.parseDailySummaries({ data: [] }), {});
  assert.deepEqual(gp.parseDailySummaries(null), {});
  assert.deepEqual(gp.parseDailySummaries({ data: [{ calendarDate: 'not-a-date', movement: { steps: { value: 5 } } }] }), {});
});

test('sleep is filed under the wake-up date, with stages, score and times', { skip }, async () => {
  const { sleepSummary } = await import('./fixtures/garmin-personal-mock.mjs');
  const n = sleepSummary('2026-11-04');
  const all = gp.parseSleep([n]);
  assert.deepEqual(Object.keys(all), ['2026-11-04']);
  const out = all['2026-11-04'];
  assert.equal(out.sleep_duration_min, Math.round(n.sleepTimeSeconds / 60));
  assert.equal(out.sleep_deep_min, Math.round(n.deepSleepSeconds / 60));
  assert.equal(out.sleep_light_min, Math.round(n.lightSleepSeconds / 60));
  assert.equal(out.sleep_rem_min, Math.round(n.remSleepSeconds / 60));
  assert.equal(out.sleep_wake_min, Math.round(n.awakeSleepSeconds / 60));
  assert.equal(out.sleep_score, n.sleepScores.overall.value);
  assert.equal(out.respiratory_rate, 14.6);
  const [sh, sm] = n.sleepStartTimestampLocal.slice(11, 16).split(':').map(Number);
  const [eh, em] = n.sleepEndTimestampLocal.slice(11, 16).split(':').map(Number);
  assert.equal(out.sleep_start_min, sh * 60 + sm);
  assert.equal(out.sleep_end_min, eh * 60 + em);
});

test('sleep: the wake-up date wins over calendarDate, and epoch-ms local times work', { skip }, () => {
  // Garmin's older shape: local times as epoch ms shifted to local time.
  const start = Date.UTC(2026, 10, 3, 23, 30), end = Date.UTC(2026, 10, 4, 7, 5);
  const out = gp.parseSleep([{ calendarDate: '2026-11-03', sleepTimeSeconds: 27000, sleepStartTimestampLocal: start, sleepEndTimestampLocal: end }]);
  assert.deepEqual(Object.keys(out), ['2026-11-04']);
  assert.equal(out['2026-11-04'].sleep_start_min, 23 * 60 + 30);
  assert.equal(out['2026-11-04'].sleep_end_min, 7 * 60 + 5);
  // No local end time: Garmin's calendarDate (its wake-up date) is used.
  assert.deepEqual(Object.keys(gp.parseSleep([{ calendarDate: '2026-11-02', sleepTimeSeconds: 3600 }])), ['2026-11-02']);
  // A night with no measured sleep is not a night.
  assert.deepEqual(gp.parseSleep([{ calendarDate: '2026-11-02', sleepTimeSeconds: 0, napTimeSeconds: 1200 }]), {});
});

test('HRV maps last night\'s average to hrv_daily_rmssd, never the weekly average', { skip }, async () => {
  const { hrvSummary } = await import('./fixtures/garmin-personal-mock.mjs');
  const h = hrvSummary('2026-11-04');
  assert.deepEqual(gp.parseHrv({ hrvSummaries: [h] }), { '2026-11-04': { hrv_daily_rmssd: h.lastNightAvg } });
  assert.deepEqual(gp.parseHrv({ hrvSummaries: [{ calendarDate: '2026-11-04', weeklyAvg: 50 }] }), {});
  assert.deepEqual(gp.parseHrv(null), {});   // 204 no data
});

test('weight and body composition map to the Withings / Health Connect names, grams to kg', { skip }, async () => {
  const { weightEntry } = await import('./fixtures/garmin-personal-mock.mjs');
  const w = weightEntry('2026-11-04', 0);
  const out = gp.parseWeight({ dailyWeightSummaries: [{ summaryDate: '2026-11-04', latestWeight: w }] })['2026-11-04'];
  assert.equal(out.weight_kg, 81.4);
  assert.equal(out.bmi, 24.6);
  assert.equal(out.body_fat_pct, 18.2);
  assert.equal(out.body_water_pct, 58.4);
  assert.equal(out.bone_mass_kg, 3.4);       // 3400 g
  assert.equal(out.muscle_mass_kg, 38.6);    // 38600 g
  assert.equal(out.visceral_fat, 7);
  assert.equal(out.metabolic_age, 31);
  // Weight in grams (Garmin's own app format) also lands as kg.
  const g = gp.parseWeight({ dailyWeightSummaries: [{ summaryDate: '2026-11-05', latestWeight: { weight: 80250 } }] });
  assert.equal(g['2026-11-05'].weight_kg, 80.25);
});

test('the sync window: 30 days first, then the last 3, longer when asked, never past a year', { skip }, () => {
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: false }), { from: '2026-10-08', to: '2026-11-06' });
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: true }), { from: '2026-11-04', to: '2026-11-06' });
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: true, from: '2026-10-01', to: '2026-11-06' }), { from: '2026-10-01', to: '2026-11-06' });
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: true, from: '2020-01-01' }).from, '2025-11-06');
  // The device's date is trusted within a day of the server's.
  assert.equal(gp.syncWindow({ today: '2026-11-06', backfilled: true, to: '2026-11-07' }).to, '2026-11-07');
  assert.equal(gp.syncWindow({ today: '2026-11-06', backfilled: true, to: '2027-01-01' }).to, '2026-11-07');
  assert.deepEqual(gp.chunkRange('2026-10-08', '2026-11-06', 28), [['2026-10-08', '2026-11-04'], ['2026-11-05', '2026-11-06']]);
  // Looking at an older day asks for that day and the two before it, no more.
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: true, from: '2026-10-01', to: '2026-10-01' }), { from: '2026-09-29', to: '2026-10-01' });
  // The first sync always reaches today, whatever day the page showed.
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: false, to: '2026-10-01' }), { from: '2026-10-08', to: '2026-11-06' });
  // After a gap it picks up from the last good sync, at most 30 days back.
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: true, lastSync: '2026-10-25' }), { from: '2026-10-24', to: '2026-11-06' });
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: true, lastSync: '2026-01-01' }), { from: '2026-10-08', to: '2026-11-06' });
  assert.deepEqual(gp.syncWindow({ today: '2026-11-06', backfilled: true, lastSync: '2026-11-06' }), { from: '2026-11-04', to: '2026-11-06' });
  assert.equal(gp.isDate('2026-02-30'), false);
  assert.equal(gp.isDate('2026-02-28'), true);
});

test('token reading: raw, quoted, or inside an object; junk is refused', { skip }, async () => {
  const { makeJwt } = await import('./fixtures/garmin-personal-mock.mjs');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt(exp);
  assert.equal(gp.readToken(jwt).expiresAt, exp * 1000);
  assert.equal(gp.readToken(JSON.stringify(jwt)).token, jwt);
  assert.equal(gp.readToken(JSON.stringify({ access_token: jwt })).token, jwt);
  assert.equal(gp.readToken('<html>oops</html>'), null);
  assert.equal(gp.readToken(''), null);
});

// ── The whole flow through the routes and the mock ──────────────────────────

test('a wrong key is turned down right away with a plain answer, and nothing is stored', { skip }, async () => {
  resetMock();
  const u = user('wrong');
  const r = await api(u, 'POST', '/personal/connect', { api_key: 'NOTAKEY_but_long_enough_to_try.1234' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'bad_key');
  assert.match(r.json.error, /did not accept this key/);
  assert.equal(gp.getRow(u), null);
  const fmt = await api(u, 'POST', '/personal/connect', { api_key: 'short' });
  assert.equal(fmt.status, 400);
  assert.equal(fmt.json.code, 'bad_format');
  const spaces = await api(u, 'POST', '/personal/connect', { api_key: 'has a space in the middle of it ok' });
  assert.equal(spaces.json.code, 'bad_format');
  assert.equal(tokenCalls().length, 1, 'only the plausible key went to Garmin');
});

test('connect stores the key and token encrypted, status never shows either', { skip }, async () => {
  resetMock();
  const u = user('conn');
  const r = await api(u, 'POST', '/personal/connect', { api_key: '  ' + KEY_A + '\n', key_expires_at: '2027-11-01' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.personal.connected, true);
  assert.equal(r.json.personal.keyExpiresAt, '2027-11-01');
  assert.equal(tokenCalls().length, 1);
  assert.equal(tokenCalls()[0].auth, 'ApiKey ' + KEY_A, 'trimmed key sent as ApiKey');
  const row = db.prepare('SELECT * FROM garmin_personal WHERE user_id = ?').get(u);
  assert.match(row.api_key, /^enc:v1:/);
  assert.match(row.access_token, /^enc:v1:/);
  assert.ok(!row.api_key.includes(KEY_A.slice(0, 20)));
  const st = await api(u, 'GET', '/status');
  assert.equal(st.json.connected, true);
  assert.equal(st.json.mode, 'personal');
  assert.ok(!st.text.includes(KEY_A) && !st.text.includes('MOCKAAAA'), 'no key in status');
  assert.ok(!/eyJ[A-Za-z0-9_-]+\./.test(st.text), 'no token in status');
});

test('first sync backfills 30 days in a handful of range calls, every metric lands', { skip }, async () => {
  resetMock();
  const u = user('backfill');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  mock.state.requests.length = 0;
  const r = await api(u, 'POST', '/sync', { from: today, to: today, force: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.mode, 'personal');
  assert.equal(r.json.from, gp.shiftDay(today, -29));
  assert.equal(r.json.to, today);
  assert.equal(r.json.synced, 30);
  assert.deepEqual(r.json.errors, []);
  // daily 1 + sleep 2 (28-day pieces) + hrv 1 + weight 2, and the cached token
  assert.equal(dataCalls().length, 6, dataCalls().map(c => c.path + c.query).join('\n'));
  assert.equal(tokenCalls().length, 0, 'the token from Connect is reused');
  assert.ok(dataCalls().every(c => /^Bearer eyJ/.test(c.auth)));
  assert.ok(!dataCalls().some(c => /\/\d{4}-\d{2}-\d{2}$/.test(c.path) && c.path.includes('dailyHeartRate')), 'no per-day loops');
  const types = new Set(rows(u).map(r => r.metric_type));
  for (const t of ['steps', 'distance_km', 'floors', 'calories_out', 'active_calories', 'resting_hr', 'max_hr',
    'moderate_intensity_min', 'vigorous_intensity_min', 'active_minutes', 'stress_avg', 'body_battery_high',
    'body_battery_low', 'spo2_avg', 'sleep_duration_min', 'sleep_deep_min', 'sleep_light_min', 'sleep_rem_min',
    'sleep_wake_min', 'sleep_score', 'respiratory_rate', 'sleep_start_min', 'sleep_end_min', 'hrv_daily_rmssd',
    'weight_kg', 'bmi', 'body_fat_pct', 'body_water_pct', 'bone_mass_kg', 'muscle_mass_kg', 'visceral_fat', 'metabolic_age']) {
    assert.ok(types.has(t), `${t} stored`);
  }
  assert.ok(rows(u).every(r => r.date >= gp.shiftDay(today, -29) && r.date <= today));
  const st = await api(u, 'GET', '/status');
  assert.equal(st.json.personal.backfilled, true);
  assert.equal(st.json.hasWeight, true);
  assert.ok(st.json.personal.lastSyncAt);
  assert.ok(st.json.lastSyncedAt);
});

test('a re-sync updates in place, no duplicates, and later syncs ask for the last 3 days', { skip }, async () => {
  resetMock();
  const u = user('resync');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  await api(u, 'POST', '/sync', { to: today, force: true });
  const before = rows(u).length;
  db.prepare(`UPDATE wellness_data SET value = 1 WHERE user_id = ? AND metric_type = 'steps' AND date = ?`).run(u, today);
  mock.state.requests.length = 0;
  const r = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(r.json.from, gp.shiftDay(today, -2));
  assert.equal(r.json.synced, 3);
  assert.equal(rows(u).length, before, 'same rows, updated');
  assert.ok(val(u, today, 'steps') > 1, 'late upload overwrote the stale value');
  assert.equal(dataCalls().length, 4, 'one call per endpoint');
  const dups = db.prepare(`SELECT COUNT(*) c FROM (SELECT date, metric_type FROM wellness_data WHERE user_id=? GROUP BY date, metric_type HAVING COUNT(*) > 1)`).get(u).c;
  assert.equal(dups, 0);
});

test('syncs right after each other wait (gentle on Garmin), and two at once share one pull', { skip }, async () => {
  resetMock();
  const u = user('gentle');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  mock.state.requests.length = 0;
  const [a, b] = await Promise.all([api(u, 'POST', '/sync', { to: today }), api(u, 'POST', '/sync', { to: today })]);
  assert.equal(a.json.synced, 30);
  assert.equal(b.json.synced, 30);
  assert.equal(dataCalls().length, 6, 'one pull for both');
  const c = await api(u, 'POST', '/sync', { to: today });
  assert.equal(c.json.skipped, 'recent');
  assert.equal(dataCalls().length, 6);
});

test('the token is cached until shortly before it ends, then renewed', { skip }, async () => {
  resetMock();
  const u = user('cache');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  const renew = Date.parse(gp.getRow(u).token_expires_at);
  assert.ok(Math.abs(renew - (Date.now() + 86400_000 - 10 * 60_000)) < 60_000, 'renewed 10 minutes before a day-long token ends');
  mock.state.requests.length = 0;
  await api(u, 'POST', '/sync', { to: today, force: true });
  await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(tokenCalls().length, 0, 'a day-long token is reused');
  db.prepare('UPDATE garmin_personal SET token_expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), u);
  await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(tokenCalls().length, 1, 'renewed once when due');
  // A short token (its key ends soon) is used for half its life, not refetched per call.
  mock.state.tokenTtlSec = 5 * 60;
  db.prepare('UPDATE garmin_personal SET token_expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), u);
  mock.state.requests.length = 0;
  await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(tokenCalls().length, 1);
  assert.equal(gp.renewAt(10_000_000 + 300_000, 10_000_000), 10_000_000 + 150_000);
});

test('a 401 on data gets one new token and one retry, not more', { skip }, async () => {
  resetMock();
  const u = user('retry');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  await api(u, 'POST', '/sync', { to: today, force: true });
  mock.state.requests.length = 0;
  mock.state.rejectNextData = 1;
  const r = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.errors, []);
  assert.equal(tokenCalls().length, 1, 'one new token');
  assert.equal(dataCalls().length, 5, 'the rejected call ran twice');
  // Two 401s in a row on the same call: that endpoint fails, the rest go on.
  mock.state.requests.length = 0;
  mock.state.rejectNextData = 2;
  const r2 = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.errors.length, 1);
  assert.match(r2.json.errors[0], /^daily: unavailable \(401\)/);
  assert.equal(gp.getRow(u).state, 'ok', 'the key itself still works');
});

test('a dead key: marked as needing a new key, no more calls, a plain message', { skip }, async () => {
  resetMock();
  const u = user('dead');
  const key = 'MOCKDEAD_clientid000000000000000000000000.dead.key.1';
  mock.state.validKeys.add(key);
  await api(u, 'POST', '/personal/connect', { api_key: key });
  mock.state.validKeys.delete(key);          // deleted on Garmin Connect, or expired
  mock.state.liveTokens.clear();             // its tokens stop too
  mock.state.requests.length = 0;
  const r = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'bad_key');
  assert.match(r.json.error, /no longer accepts your Personal API key/);
  assert.equal(gp.getRow(u).state, 'needs_key');
  assert.equal(gp.getRow(u).access_token, null);
  const calls = mock.state.requests.length;
  assert.equal(calls, 2, 'one data call, one token try');
  const again = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(again.status, 409);
  assert.equal(mock.state.requests.length, calls, 'stops retrying');
  const st = await api(u, 'GET', '/status');
  assert.equal(st.json.connected, false);
  assert.equal(st.json.personal.state, 'needs_key');
  // A new key brings it back.
  const fresh = await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  assert.equal(fresh.status, 200);
  assert.equal(gp.getRow(u).state, 'ok');
});

test('an account with no watch is a normal, calm state', { skip }, async () => {
  resetMock();
  mock.state.mode = 'empty';
  const u = user('empty');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  const r = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.synced, 0);
  assert.deepEqual(r.json.errors, []);
  assert.equal(rows(u).length, 0);
  const st = await api(u, 'GET', '/status');
  assert.equal(st.json.connected, true);
  assert.equal(st.json.personal.lastError, null);
  assert.ok(st.json.personal.lastSyncAt, 'synced, just nothing yet');
  assert.equal(st.json.lastSyncedAt, null);
});

test('Garmin throttling stops the sync without marking the key dead', { skip }, async () => {
  resetMock();
  const u = user('429');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  mock.state.status429 = true;
  mock.state.requests.length = 0;
  const r = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(r.status, 429);
  assert.equal(r.json.code, 'rate_limited');
  assert.equal(dataCalls().length, 1, 'stops at the first throttled call');
  assert.equal(gp.getRow(u).state, 'ok');
  assert.equal(gp.getRow(u).last_error, 'rate_limited');
});

test('a timeout or unreachable Garmin is an error with a plain message, never a hang', { skip }, async () => {
  const u = user('down');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  const saved = process.env.GARMIN_PERSONAL_API_BASE;
  process.env.GARMIN_PERSONAL_API_BASE = 'http://127.0.0.1:9';   // nothing listens
  try {
    db.prepare('UPDATE garmin_personal SET token_expires_at = ? WHERE user_id = ?').run(new Date(0).toISOString(), u);
    const r = await api(u, 'POST', '/sync', { to: today, force: true });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'unavailable');
    assert.equal(gp.getRow(u).state, 'ok');
    const c = await api(user('down2'), 'POST', '/personal/connect', { api_key: KEY_A });
    assert.equal(c.status, 502);
  } finally { process.env.GARMIN_PERSONAL_API_BASE = saved; }
  const src = readFileSync(new URL('../server/lib/garmin-personal.js', import.meta.url), 'utf8');
  assert.match(src, /AbortSignal\.timeout\(requestTimeoutMs\)/, 'every request has a deadline');
});

test('a Garmin that never answers times out instead of holding the sync', { skip }, async () => {
  const http = await import('node:http');
  const hung = http.createServer(() => { /* never answers */ });
  await new Promise(r => hung.listen(0, '127.0.0.1', r));
  const saved = process.env.GARMIN_PERSONAL_API_BASE;
  process.env.GARMIN_PERSONAL_API_BASE = `http://127.0.0.1:${hung.address().port}`;
  gp._setRequestTimeoutForTests(300);
  try {
    const t0 = Date.now();
    const c = await api(user('hung'), 'POST', '/personal/connect', { api_key: KEY_A });
    assert.equal(c.status, 504);
    assert.equal(c.json.code, 'timeout');
    assert.ok(Date.now() - t0 < 5000);
  } finally {
    gp._setRequestTimeoutForTests(0);
    process.env.GARMIN_PERSONAL_API_BASE = saved;
    hung.closeAllConnections?.(); await new Promise(r => hung.close(r));
  }
});

test('Sync All Now (forceSync) and the schedule run the Personal API key', { skip }, async () => {
  resetMock();
  const u = user('force');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  const { forceSync } = await import('../server/lib/scheduler.js');
  const r = await forceSync(u);
  assert.equal(r.garmin, true);
  assert.ok(rows(u).length > 0, 'readings landed');
  db.prepare(`UPDATE garmin_personal SET state = 'needs_key' WHERE user_id = ?`).run(u);
  mock.state.requests.length = 0;
  const r2 = await forceSync(u);
  assert.equal(r2.garmin, false, 'a dead key is not tried');
  assert.equal(mock.state.requests.length, 0);
});

test('a new key gets the 30-day backfill again', { skip }, async () => {
  resetMock();
  const u = user('rekey');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  await api(u, 'POST', '/sync', { to: today, force: true });
  db.prepare(`UPDATE garmin_personal SET state = 'needs_key' WHERE user_id = ?`).run(u);
  const r = await api(u, 'POST', '/personal/connect', { api_key: KEY_B });
  assert.equal(r.status, 200);
  assert.equal(r.json.personal.backfilled, false);
  const s = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(s.json.from, gp.shiftDay(today, -29), 'the days the old key missed are pulled');
});

test('a sync still running with the old key never marks or overwrites a replaced key', { skip }, async () => {
  resetMock();
  const u = user('race');
  const oldKey = 'MOCKOLD0_clientid000000000000000000000000.old.key.1';
  mock.state.validKeys.add(oldKey);
  await api(u, 'POST', '/personal/connect', { api_key: oldKey });
  // Old key revoked; its token too, so the next call has to swap the key.
  mock.state.validKeys.delete(oldKey);
  mock.state.liveTokens.clear();
  // Hold the old key's token exchange until the person has replaced the key.
  let release;
  const gate = new Promise(r => { release = r; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/personal-api-key/token') && String(init?.headers?.Authorization) === 'ApiKey ' + oldKey) await gate;
    return realFetch(url, init);
  };
  try {
    const running = api(u, 'POST', '/sync', { to: today, force: true });
    await new Promise(r => setTimeout(r, 150));
    const rep = await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
    assert.equal(rep.status, 200);
    release();
    await running;
  } finally { globalThis.fetch = realFetch; }
  const row = gp.getRow(u);
  assert.equal(row.state, 'ok', 'the new key is not marked dead by the old one');
  assert.ok(row.access_token, 'the new key keeps its token');
  const s = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.errors, []);
});

test('Connect is rate limited per person (each try is a call to Garmin)', { skip }, async () => {
  const u = user('limit');
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await api(u, 'POST', '/personal/connect', { api_key: 'NOTAKEY_but_long_enough_to_try.' + i })).status);
  assert.deepEqual(codes, [400, 400, 400, 400, 400, 400, 429]);
});

test('a key waiting to be replaced reads as not connected, even with partner tokens saved', { skip }, async () => {
  resetMock();
  const u = user('mixed');
  db.prepare('INSERT INTO garmin_tokens (user_id, access_token, access_secret) VALUES (?, ?, ?)').run(u, 'x', 'y');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  db.prepare(`UPDATE garmin_personal SET state = 'needs_key' WHERE user_id = ?`).run(u);
  const st = (await api(u, 'GET', '/status')).json;
  assert.equal(st.connected, false);
  assert.equal(st.mode, 'personal');
  assert.equal(st.partnerConnected, true);
});

test('two accounts keep their own key, token and readings', { skip }, async () => {
  resetMock();
  const a = user('a'), b = user('b');
  await api(a, 'POST', '/personal/connect', { api_key: KEY_A });
  await api(b, 'POST', '/personal/connect', { api_key: KEY_B });
  mock.state.requests.length = 0;
  await api(a, 'POST', '/sync', { to: today, force: true });
  const aAuth = new Set(dataCalls().map(c => c.auth));
  mock.state.requests.length = 0;
  await api(b, 'POST', '/sync', { to: today, force: true });
  const bAuth = new Set(dataCalls().map(c => c.auth));
  assert.equal(aAuth.size, 1); assert.equal(bAuth.size, 1);
  assert.notDeepEqual([...aAuth], [...bAuth], 'each account calls with its own token');
  assert.ok(rows(a).length > 0 && rows(b).length > 0);
  await api(a, 'DELETE', '/personal');
  assert.equal(gp.getRow(a), null);
  assert.ok(gp.getRow(b), 'b still connected');
  const stB = await api(b, 'GET', '/status');
  assert.equal(stB.json.mode, 'personal');
  const stA = await api(a, 'GET', '/status');
  assert.equal(stA.json.mode, null);
  assert.equal(stA.json.connected, false);
});

test('Disconnect deletes the stored key and token; readings stay', { skip }, async () => {
  resetMock();
  const u = user('disc');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A });
  await api(u, 'POST', '/sync', { to: today, force: true });
  const kept = rows(u).length;
  const r = await api(u, 'DELETE', '/disconnect');
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM garmin_personal WHERE user_id = ?').get(u).c, 0);
  assert.equal(rows(u).length, kept);
  const s = await api(u, 'POST', '/sync', { to: today, force: true });
  assert.notEqual(s.json?.mode, 'personal', 'no personal sync after disconnect');
});

test('key expiry: days left, a warning a week out, a notice once per stage', { skip }, async () => {
  const u = user('expiry');
  await api(u, 'POST', '/personal/connect', { api_key: KEY_A, key_expires_at: gp.shiftDay(today, 5) });
  let st = (await api(u, 'GET', '/status')).json.personal;
  assert.equal(st.keyDaysLeft, 5);
  assert.equal(st.keyExpiringSoon, true);
  assert.equal(await gp.checkKeyNotices(u), 'soon');
  assert.equal(await gp.checkKeyNotices(u), null, 'once');
  const bad = await api(u, 'PUT', '/personal', { key_expires_at: 'tomorrow' });
  assert.equal(bad.status, 400);
  await api(u, 'PUT', '/personal', { key_expires_at: gp.shiftDay(today, -1) });
  st = (await api(u, 'GET', '/status')).json.personal;
  assert.equal(st.keyExpired, true);
  assert.equal(await gp.checkKeyNotices(u), 'expired');
  await api(u, 'PUT', '/personal', { key_expires_at: gp.shiftDay(today, 200) });
  st = (await api(u, 'GET', '/status')).json.personal;
  assert.equal(st.keyExpiringSoon, false);
  assert.equal(await gp.checkKeyNotices(u), null);
  db.prepare(`UPDATE garmin_personal SET state = 'needs_key' WHERE user_id = ?`).run(u);
  assert.equal(await gp.checkKeyNotices(u), 'dead');
});

test('single-user mode keeps its key on user 0 and new accounts claim it', { skip }, () => {
  const src = readFileSync(new URL('../server/lib/claim-anonymous-data.js', import.meta.url), 'utf8');
  assert.match(src.slice(src.indexOf('CLAIM_ZERO'), src.indexOf('CLAIM_BOTH')), /'garmin_personal'/);
  assert.match(src.slice(src.indexOf('NO_CASCADE_TABLES')), /'garmin_personal'/, 'deleting an account deletes its key');
});

test('the key is not in the full backup, and never in plain text at rest', { skip }, () => {
  const backup = readFileSync(new URL('../server/routes/full-backup.js', import.meta.url), 'utf8');
  const dump = backup.slice(backup.indexOf('function dumpDatabase'));
  assert.doesNotMatch(dump, /FROM garmin_personal/);
  for (const r of db.prepare('SELECT api_key, access_token FROM garmin_personal').all()) {
    assert.match(r.api_key, /^enc:v1:/);
    if (r.access_token) assert.match(r.access_token, /^enc:v1:/);
  }
});

test('the scheduler uses the Personal API key when connected and skips a dead key', { skip }, () => {
  const src = readFileSync(new URL('../server/lib/scheduler.js', import.meta.url), 'utf8');
  assert.match(src, /SELECT state FROM garmin_personal WHERE user_id=\?/);
  assert.match(src, /garminPersonal\.state === 'ok'/);
  assert.match(src, /syncGarmin\(userId, from, today\)/);
  assert.match(src, /checkKeyNotices\(userId\)/);
});

test('no key or token was ever printed', { skip }, () => {
  const all = printed.join('\n');
  for (const k of [KEY_A, KEY_B, 'MOCKAAAA', 'MOCKBBBB', 'MOCKDEAD']) assert.ok(!all.includes(k), `${k.slice(0, 8)} printed`);
  assert.ok(!/eyJhbGciOiJSUzI1NiIs/.test(all), 'a token was printed');
  assert.ok(printed.some(l => l.includes('[garmin-personal]')), 'the connector did log (so the check is real)');
});
