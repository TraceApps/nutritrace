/**
 * The native Health Connect reader runs when the app comes to the front and
 * on Sync (#294). The worker (HealthConnectSyncWorker.kt) reads workouts,
 * floors and water, which the Capacitor plugin can't; without background
 * access it can read only while the app is in front, so the app runs it
 * once then, one at a time, next to its own read of today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runWorkerNow, syncHealthConnect } from '../src/lib/health-connect.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const plugin = read('../android/app/src/main/java/com/nutritrace/app/HealthBackgroundPlugin.kt');
const worker = read('../android/app/src/main/java/com/nutritrace/app/HealthConnectSyncWorker.kt');

test('runNow runs the worker once, unique, expedited where allowed', () => {
  assert.match(plugin, /fun runNow\(call: PluginCall\)/);
  assert.match(plugin, /OneTimeWorkRequestBuilder<HealthConnectSyncWorker>\(\)/);
  assert.match(plugin, /wm\.enqueueUniqueWork\(NOW_WORK, ExistingWorkPolicy\.KEEP, request\)/);
  assert.match(plugin, /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) \{\s*builder\.setExpedited\(OutOfQuotaPolicy\.RUN_AS_NON_EXPEDITED_WORK_REQUEST\)/,
    'expedited only on Android 12+, where it needs no foreground notification');
});

test('runNow skips while the worker runs or when it read recently', () => {
  assert.match(plugin, /getWorkInfosForUniqueWork\(WorkerScheduler\.HC_SYNC_WORK\)\.get\(\)\.any \{ it\.state == WorkInfo\.State\.RUNNING \}/);
  assert.match(plugin, /getWorkInfosForUniqueWork\(NOW_WORK\)\.get\(\)\.any \{ !it\.state\.isFinished \}/);
  assert.match(plugin, /ranWithin\(minAgeMs\) -> "recent"/);
  assert.match(plugin, /call\.data\.optLong\("minAgeMs", 60_000L\)/, 'read as a number, not getDouble');
});

test('it says when it finished and how much changed', () => {
  assert.match(plugin, /notifyListeners\("workerDone"/);
  assert.match(worker, /val out = workDataOf\(OUTPUT_CHANGED to changedRows\.size \+ changedWorkouts\.size\)/);
  assert.match(worker, /return Result\.success\(out\)/);
});

test('workouts the worker sends keep the server id, so the app does not send them again', () => {
  assert.match(worker, /put\("client_id", i\)/);
  assert.match(worker, /setWorkoutServerIds\(ctx, answer, changedWorkouts\)/);
  assert.match(worker, /UPDATE workouts SET server_id = \? WHERE user_id = \? AND source = \? AND source_id = \?/);
});

test('the app runs it on open, on coming back, and on Health Connect Sync', () => {
  const app = read('../src/App.svelte');
  assert.match(app, /if \(!DB\.getSetting\('healthConnectEnabled', false\)\) return;\s*import\('\.\/lib\/health-connect\.js'\)\.then\(m => m\.runWorkerNow\(\{ minAgeMs: 5 \* 60 \* 1000 \}\)\)/);
  assert.match(app, /runHcReader\(\);\s*import\('@capacitor\/app'\)\.then\(\(\{ App \}\) => App\.addListener\('resume', runHcReader\)\)/);
  const w = read('../src/routes/Wellness.svelte');
  assert.match(w, /runWorkerNow\(\{ minAgeMs: 30000 \}\);\s*await syncHealthConnect\(dateStr, \{ catchUp: true \}\);/);
  assert.match(w, /window\.addEventListener\('nt:hc-worker-done', _hcWorkerDoneHandler\)/);
  assert.match(read('../src/components/settings/SettingsWellness.svelte'), /runWorkerNow\(\{ minAgeMs: 30000 \}\);/);
});

test('off Android there is nothing to run', async () => {
  assert.deepEqual(await runWorkerNow(), { started: false, reason: 'unsupported' });
});

test('the foreground read never writes workouts, so only the worker imports them', async () => {
  const written = [];
  const db = {
    async dbUpsertWellness() {},
    async dbUpsertWorkoutLocal(w) { written.push(w); },
    async dbGetSyncMeta() { return null; },
    async dbSetSyncMeta() {},
  };
  const now = new Date(2026, 9, 22, 12);
  const session = { startTime: new Date(2026, 9, 22, 7).toISOString(), endTime: new Date(2026, 9, 22, 8).toISOString(), metadata: { id: 'run' } };
  const hc = {
    // The plugin's own names: exercise is ActivitySession there.
    async getGrantedPermissions() { return { read: ['Steps', 'ActivitySession'] }; },
    async aggregateRecords() { return { aggregates: [{ value: 0 }] }; },
    async readRecords({ type }) {
      if (type === 'ExerciseSession') return { records: [session] };
      return { records: [] };
    },
  };
  await syncHealthConnect('2026-10-22', { catchUp: true }, { hc, db, now, snapshot: async () => {} });
  // Unknown grants: the plugin rejects the ExerciseSession name.
  hc.getGrantedPermissions = async () => ({ read: [] });
  hc.readRecords = async ({ type }) => { if (type === 'ExerciseSession') throw new Error('Unexpected RecordType: ExerciseSession'); return { records: [] }; };
  await syncHealthConnect('2026-10-22', {}, { hc, db, now, snapshot: async () => {} });
  assert.deepEqual(written, []);
});
