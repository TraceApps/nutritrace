/**
 * #349, #350: measurements sent through POST /api/v1/body-measurements, and
 * Withings body water. Against a scratch database and the real routes;
 * Withings' own servers are a stub (nothing leaves the machine).
 *
 * - /api/wellness/fitbit/data?sources=federation returns the API's rows
 *   alone, for screens that read them when Fitbit and Health Connect are off,
 *   and a device's value wins over the API's for the same metric and day.
 * - The API's weight goes into Body Stats when Mirror Wellness Weight to Body
 *   Stats is on, as for Health Connect and Garmin; a manual weight stays.
 * - Withings sends hydration in kg: it's stored as a percentage of the
 *   reading's weight, and readings already stored are turned into one once.
 *   Withings' weight goes into Body Stats with the same mirror setting.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { hydrationPct } from '../server/lib/withings-hydration.js';

let db = null, dir = null, server = null, base = null, encrypt = null;
const realFetch = globalThis.fetch;
let withingsGroups = [];
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'api-body-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  ({ encrypt } = await import('../server/lib/token-crypto.js'));
  const express = req('express');
  const { default: fitbitRoutes } = await import('../server/routes/fitbit.js');
  const { default: withingsRoutes } = await import('../server/routes/withings.js');
  const { default: bodyRoutes } = await import('../server/routes/api/v1/body-measurements.js');
  const app = express();
  app.use(express.json());
  // What requireAuth and the bearer middleware leave behind.
  app.use((r, _res, next) => {
    const id = Number(r.headers['x-user']);
    r.user = { id, role: 'admin' };
    r.apiUser = { id };
    r.apiToken = { scopes: ['write:body-measurements'] };
    next();
  });
  app.use('/api/wellness/fitbit', fitbitRoutes);
  app.use('/api/wellness/withings', withingsRoutes);
  app.use('/api/v1/body-measurements', bodyRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  // Withings' servers: answered here, never reached.
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('withings.net')) return realFetch(url, opts);
    const body = u.includes('/measure') ? { measuregrps: withingsGroups } : u.includes('getdevice') ? { devices: [] } : {};
    return new Response(JSON.stringify({ status: 0, body }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
} catch { /* better-sqlite3 not built for this Node: the cases skip */ }
test.after(() => { globalThis.fetch = realFetch; server?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

const user = (n) => Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(n + Math.random(), 'x').lastInsertRowid);
const get = async (u, path) => (await realFetch(`${base}${path}`, { headers: { 'x-user': String(u) } })).json();
const post = async (u, path, body) => realFetch(`${base}${path}`, { method: 'POST', headers: { 'x-user': String(u), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const wellness = (u, date, source, metric, value) => db.prepare(
  `INSERT INTO wellness_data (user_id, date, source, metric_type, value) VALUES (?, ?, ?, ?, ?)`).run(u, date, source, metric, value);
const bodyStats = (u, date) => JSON.parse(db.prepare('SELECT body_stats FROM diary WHERE user_id = ? AND date = ?').get(u, date)?.body_stats || '{}');

test('hydration in kg becomes a percentage of the same weight', () => {
  assert.equal(hydrationPct(44.1, 80), 55.1);
  assert.equal(hydrationPct(40, 72.5), 55.2);
  for (const [h, w] of [[44, null], [44, 0], [0, 80], [80, 80], [90, 80], ['x', 80]]) {
    assert.equal(hydrationPct(h, w), null, `${h} of ${w}`);
  }
});

test("sources=federation returns the API's measurements alone, and a device wins a tie", async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('src');
  wellness(me, '2026-11-20', 'federation', 'body_fat_pct', 21.3);
  wellness(me, '2026-11-20', 'federation', 'weight_kg', 80.4);
  wellness(me, '2026-11-20', 'fitbit', 'weight_kg', 80.9);
  wellness(me, '2026-11-20', 'fitbit', 'steps', 9000);
  const onlyApi = await get(me, '/api/wellness/fitbit/data?from=2026-11-19&to=2026-11-21&sources=federation');
  assert.deepEqual(onlyApi, { '2026-11-20': { body_fat_pct: 21.3, weight_kg: 80.4 } });
  const all = await get(me, '/api/wellness/fitbit/data?date=2026-11-20');
  assert.equal(all['2026-11-20'].weight_kg, 80.9, "Fitbit's weight wins over the API's");
  assert.equal(all['2026-11-20'].body_fat_pct, 21.3);
  assert.equal(all['2026-11-20'].steps, 9000);
  // An unknown source name is ignored rather than narrowing to nothing.
  assert.deepEqual(await get(me, '/api/wellness/fitbit/data?date=2026-11-20&sources=nope'), all);
});

test("the API's weight goes into Body Stats only with the mirror on, and never over a manual one", async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('mirror');
  const send = (date, weight) => post(me, '/api/v1/body-measurements', { measured_at: `${date}T07:00:00`, weight, body_fat: 21 });
  assert.equal((await send('2026-11-10', 79.9)).status, 201);
  assert.equal(bodyStats(me, '2026-11-10').weight, undefined, 'mirror off: Body Stats weight left alone');
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'mirrorWellnessWeight', 'true')`).run(me);
  await send('2026-11-11', 79.6);
  assert.equal(bodyStats(me, '2026-11-11').weight, 79.6);
  assert.equal(bodyStats(me, '2026-11-11').weight_unit, 'kg');
  db.prepare(`INSERT INTO diary (user_id, date, items, body_stats, water) VALUES (?, '2026-11-12', '[]', ?, '[]')`)
    .run(me, JSON.stringify({ weight: 170, weight_unit: 'lb' }));
  await send('2026-11-12', 79.4);
  assert.equal(bodyStats(me, '2026-11-12').weight, 170, 'manual weight stays');
  assert.equal(bodyStats(me, '2026-11-12').weight_unit, 'lb');
});

test('a Withings sync stores body water as a percentage, and its weight follows the mirror setting', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('withings');
  db.prepare(`INSERT INTO withings_tokens (user_id, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)`)
    .run(me, encrypt('a'), encrypt('r'), new Date(Date.now() + 86400000).toISOString());
  const ts = Math.floor(new Date('2026-11-18T07:00:00').getTime() / 1000);
  // Withings' shape: value x 10^unit. 80.0 kg, 21.5 %, hydration 44.1 kg.
  withingsGroups = [
    { grpid: 1, date: ts, deviceid: 'd', category: 1, measures: [
      { type: 1, value: 80000, unit: -3 }, { type: 6, value: 215, unit: -1 }, { type: 77, value: 44100, unit: -3 },
    ] },
    // Hydration alone in a later group: the day's weight goes with it.
    { grpid: 2, date: ts + 60, deviceid: 'd', category: 1, measures: [{ type: 77, value: 44500, unit: -3 }] },
  ];
  const res = await post(me, '/api/wellness/withings/sync', { date: '2026-11-18' });
  assert.equal(res.status, 200, await res.clone().text());
  const water = db.prepare(`SELECT value FROM wellness_data WHERE user_id = ? AND source = 'withings' AND metric_type = 'body_water_pct'`).get(me);
  assert.equal(water.value, 55.6, 'the latest reading, 44.5 kg of 80 kg');
  assert.equal(bodyStats(me, '2026-11-18').weight, undefined, 'mirror off: Body Stats weight left alone');
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'mirrorWellnessWeight', 'true')`).run(me);
  await post(me, '/api/wellness/withings/sync', { date: '2026-11-18' });
  assert.equal(bodyStats(me, '2026-11-18').weight, 80, "mirror on: Withings' weight in Body Stats");
  assert.equal(bodyStats(me, '2026-11-18').weight_unit, 'kg');
  withingsGroups = [];
});

test('Withings body water already stored is turned into a percentage once', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const me = user('migrate');
  wellness(me, '2026-10-01', 'withings', 'weight_kg', 80);
  wellness(me, '2026-10-01', 'withings', 'body_water_pct', 44.1);
  wellness(me, '2026-10-05', 'withings', 'body_water_pct', 44.5);      // weight 4 days before: used
  wellness(me, '2026-10-20', 'withings', 'body_water_pct', 43.9);      // nearest weight 19 days off: left
  wellness(me, '2026-10-01', 'federation', 'body_water_pct', 55);      // the API's: a percentage already
  db.prepare(`UPDATE wellness_data SET synced_at = '2026-10-01 00:00:00' WHERE user_id = ?`).run(me);
  db.prepare(`DELETE FROM app_config WHERE key = 'withings_hydration_pct_v1'`).run();
  // db.js runs its one-time passes as it opens: open it again.
  const again = (await import('../server/db.js?again')).default;
  const val = (date, src) => db.prepare(`SELECT value, synced_at FROM wellness_data WHERE user_id = ? AND date = ? AND source = ? AND metric_type = 'body_water_pct'`).get(me, date, src);
  assert.equal(val('2026-10-01', 'withings').value, 55.1);
  assert.notEqual(val('2026-10-01', 'withings').synced_at, '2026-10-01 00:00:00', 'phones pull the corrected value');
  assert.equal(val('2026-10-05', 'withings').value, 55.6);
  assert.equal(val('2026-10-20', 'withings').value, 43.9);
  assert.equal(val('2026-10-01', 'federation').value, 55);
  // Once only.
  const third = (await import('../server/db.js?third')).default;
  assert.equal(val('2026-10-01', 'withings').value, 55.1);
  again.close(); third.close();
});
