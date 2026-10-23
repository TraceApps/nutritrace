/**
 * Health Connect background reads (#294). Without
 * READ_HEALTH_DATA_IN_BACKGROUND, Health Connect answers reads only while
 * the app is in front, so the hourly worker read nothing with the app
 * closed. developer.android.com, Health Connect, "Read data": declare the
 * permission, check FEATURE_READ_HEALTH_DATA_IN_BACKGROUND, request it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getBackgroundReadStatus, requestBackgroundRead } from '../src/lib/health-connect.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PERM = 'android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND';

test('the manifest declares the background-read permission', () => {
  const m = read('../android/app/src/main/AndroidManifest.xml');
  assert.ok(m.includes(`<uses-permission android:name="${PERM}" />`));
  assert.ok(read('../android/app/src/main/res/values/health_permissions.xml').includes(`<item>${PERM}</item>`),
    'listed with the other Health Connect permissions too');
});

test('the native side checks the feature and asks for the permission', () => {
  const kt = read('../android/app/src/main/java/com/nutritrace/app/HealthBackgroundPlugin.kt');
  assert.match(kt, /@CapacitorPlugin\(name = "HealthBackground"\)/);
  assert.match(kt, /HealthConnectFeatures\.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND/);
  assert.match(kt, /HealthPermission\.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND/);
  assert.match(kt, /createRequestPermissionResultContract\(\)/);
  assert.match(read('../android/app/src/main/java/com/nutritrace/app/MainActivity.java'),
    /registerPlugin\(HealthBackgroundPlugin\.class\);\s*super\.onCreate/, 'registered before the bridge starts');
});

test('asking for Health Connect access asks for background reads too', () => {
  const hc = read('../src/lib/health-connect.js');
  const fn = hc.slice(hc.indexOf('export async function requestPermissions()'), hc.indexOf('async function _requestRecordPermissions()'));
  assert.match(fn, /const granted = await _requestRecordPermissions\(\);/);
  assert.match(fn, /if \(granted\.read\?\.length\) await requestBackgroundRead\(\);/);
  assert.match(hc, /registerPlugin\('HealthBackground'\)/);
  // A plugin proxy returned from an async function is awaited as a thenable
  // and fails on Android ("HealthBackground.then() is not implemented").
  assert.match(hc, /return \{ plugin: _bgPlugin \};/);
  assert.doesNotMatch(hc, /return _bgPlugin;/);
});

test('off Android there is nothing to ask and nothing breaks', async () => {
  assert.deepEqual(await getBackgroundReadStatus(), { available: false, granted: false });
  assert.deepEqual(await requestBackgroundRead(), { available: false, granted: false });
});

test('Settings says plainly when the hourly sync can only read with the app open, with a way to allow it', () => {
  const s = read('../src/components/settings/SettingsWellness.svelte');
  assert.match(s, /hcBackground = await getBackgroundReadStatus\(\);/);
  assert.match(s, /\{#if hcBackground && !hcBackground\.granted\}/);
  assert.match(s, /hcBackground\.available \? \$_\('settings_wellness\.hc\.bg_read_off'\) : \$_\('settings_wellness\.hc\.bg_read_unsupported'\)/);
  assert.match(s, /on:click=\{allowHcBackground\}/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['bg_read_off', 'bg_read_unsupported', 'bg_read_allow']) {
    assert.ok(en.settings_wellness.hc[k], `en.json settings_wellness.hc.${k}`);
  }
});

test('the worker keeps working without it and says why it read nothing', () => {
  const w = read('../android/app/src/main/java/com/nutritrace/app/HealthConnectSyncWorker.kt');
  assert.match(w, /if \(!granted\.contains\(HealthBackgroundPlugin\.PERMISSION\)\)/);
});
