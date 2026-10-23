/**
 * Saving your profile (#269). Text checks over the screen and the Android
 * API layer; the browser's offline layer is exercised for real in
 * offline-storage-save.test.js.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const profile = read('../src/routes/Profile.svelte');
const en = JSON.parse(read('../src/i18n/en.json'));

// Every call the app makes through NtApi, by name. The proxy in lib/api.js
// answers a name a layer lacks with a rejected promise, so a missing one
// fails quietly, before any request: on Android that was every profile save.
function calledMethods() {
  const names = new Set();
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = `${dir}/${f}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(svelte|js)$/.test(f)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/\bNtApi\.([a-zA-Z_]\w*)\(/g)) names.add(m[1]);
      }
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  return names;
}

const defines = (src, name) => new RegExp(`^\\s+(async\\s+)?${name}\\s*\\(`, 'm').test(src);
// Named in a comment as an example, never called.
const NOT_CALLS = new Set(['foo']);

test('Android with a server answers every call the app makes, the profile save included', () => {
  const cached = read('../src/lib/api-cached.js');
  const missing = [...calledMethods()].filter(n => !NOT_CALLS.has(n) && !defines(cached, n));
  assert.deepEqual(missing, []);
  assert.match(cached, /async updateProfile\(data\) \{ return _coachingFetch\('PUT', '\/api\/auth\/profile', data\); \}/);
});

test('Android with no server answers every call the app makes there', () => {
  // Profile writes local settings in local mode and never asks the API.
  const LOCAL_ONLY_ELSEWHERE = new Set(['updateProfile']);
  const native = read('../src/lib/api-native.js');
  const missing = [...calledMethods()].filter(n => !NOT_CALLS.has(n) && !defines(native, n) && !LOCAL_ONLY_ELSEWHERE.has(n));
  assert.deepEqual(missing, []);
  assert.match(profile, /if \(_isLocal\) \{\s+\/\/ Write each field to its corresponding setting/);
});

test('a save kept for later keeps who is signed in', () => {
  // The queued answer carries only the fields sent; replacing the user with
  // it dropped the id and role.
  assert.match(profile, /if \(data\?\.user\) currentUser\.set\(\{ \.\.\.get\(currentUser\), \.\.\.data\.user \}\);/);
  assert.doesNotMatch(profile, /currentUser\.set\(data\.user\)/);
});

test('a failed save says why', () => {
  assert.match(profile, /e\?\.storage \? \$_\('profile\.errors\.not_kept'\)/);
  assert.match(profile, /e\?\.offline \? \$_\('profile\.errors\.needs_connection'\)/);
  assert.ok(en.profile.errors.not_kept && en.profile.errors.needs_connection);
});
