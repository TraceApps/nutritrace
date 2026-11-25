/**
 * #349: on the Android phone, measurements sent through
 * POST /api/v1/body-measurements arrive with every other wellness row in a
 * sync pull, source 'federation'. Wellness > Body reads the day from the
 * phone's database (server mode or not) and asked for the devices' rows
 * only; and with no server (the app's own database answering every
 * request, api-native.js), the charts that read a scale asked for Fitbit
 * and Health Connect rows only. Whether there are API measurements at all
 * is now answered by the phone's database first, so it holds offline.
 * Runs the app's own db-native.js, api-native.js and api-body.js on SQLite
 * (scripts/fixtures/native-sync), as a phone.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

let ready = false;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  await import('./fixtures/native-sync/register.mjs');
  ready = true;
} catch { /* better-sqlite3 not built for this Node: the cases skip */ }

test("the phone's answer has the API's measurements, with a device winning a tie", async (t) => {
  if (!ready) return t.skip('better-sqlite3 is not built for this Node');
  const { dbUpsertWellnessFromServer, dbGetWellnessGrouped } = await import('../src/lib/db-native.js');
  const { NtApiNative } = await import('../src/lib/api-native.js');
  // As a sync pull hands them over (routes/sync.js: every source).
  const row = (source, metric_type, value) => dbUpsertWellnessFromServer({ date: '2026-11-25', source, metric_type, value, metadata: '{}', synced_at: '2026-11-25 07:00:00' });
  await row('federation', 'weight_kg', 80.4);
  await row('federation', 'body_fat_pct', 21.3);
  await row('federation', 'body_water_pct', 55.2);
  await row('health_connect', 'weight_kg', 80.9);
  await row('health_connect', 'steps', 9000);

  const all = await NtApiNative.get('/api/wellness/fitbit/data?date=2026-11-25');
  assert.deepEqual(all['2026-11-25'], { weight_kg: 80.9, body_fat_pct: 21.3, body_water_pct: 55.2, steps: 9000 },
    "Health Connect's weight wins; the API's body fat and water are there");
  const api = await NtApiNative.get('/api/wellness/fitbit/data?from=2026-11-24&to=2026-11-26&sources=federation');
  assert.deepEqual(api, { '2026-11-25': { weight_kg: 80.4, body_fat_pct: 21.3, body_water_pct: 55.2 } });
  // What Wellness > Body reads for the day.
  assert.deepEqual((await dbGetWellnessGrouped('2026-11-25', '2026-11-25', 'federation'))['2026-11-25'],
    { weight_kg: 80.4, body_fat_pct: 21.3, body_water_pct: 55.2 });
});

test("offline, the phone's own database says there are API measurements", async (t) => {
  if (!ready) return t.skip('better-sqlite3 is not built for this Node');
  const { apiBodyData, refreshApiBodyData } = await import('../src/lib/api-body.js');
  const { get } = await import('svelte/store');
  apiBodyData.set(false);
  const offline = { get: async () => { throw new Error('offline'); } };
  await refreshApiBodyData(offline, { native: true, now: new Date(2026, 10, 25) });
  assert.equal(get(apiBodyData), true, 'from the rows the last sync brought down');
});
