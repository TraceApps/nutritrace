/**
 * The Trace button depends on the startup env-locks request. A failed request
 * used to hide the button for the whole session (no retry, no cache).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  envLocksRetryDelay, envLocksShouldRetry, readCachedEnvLocks, writeCachedEnvLocks, ENV_LOCKS_CACHE_KEY, envLocksCacheKey,
} from '../src/lib/env-locks-retry.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _m: m,
  };
}

test('retry waits grow, then stay at one minute', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map(envLocksRetryDelay),
    [2000, 5000, 15000, 30000, 60000, 60000, 60000],
  );
  assert.equal(envLocksRetryDelay(-3), 2000);
});

test('network failures and server errors are retried', () => {
  assert.equal(envLocksShouldRetry(0), true);
  assert.equal(envLocksShouldRetry(500), true);
  assert.equal(envLocksShouldRetry(503), true);
});

test('sign-in failures are not retried; signing in loads the locks again', () => {
  assert.equal(envLocksShouldRetry(401), false);
  assert.equal(envLocksShouldRetry(403), false);
});

test('the last answer is kept and read back for a cold start offline', () => {
  const s = memoryStorage();
  const locks = { smtp: false, ai: true, ai_enabled: true, off_local: false, off_local_only: false, oidc_provider_ids: [], lifttrace_connected: false };
  writeCachedEnvLocks(s, locks);
  assert.ok(s._m.has(ENV_LOCKS_CACHE_KEY));
  const { lifttrace_connected, ...serverWide } = locks;
  assert.deepEqual(readCachedEnvLocks(s), serverWide);
});

test('a missing, broken or non-object cache reads as nothing', () => {
  assert.equal(readCachedEnvLocks(memoryStorage()), null);
  assert.equal(readCachedEnvLocks(memoryStorage({ [ENV_LOCKS_CACHE_KEY]: '{not json' })), null);
  assert.equal(readCachedEnvLocks(memoryStorage({ [ENV_LOCKS_CACHE_KEY]: '[1,2]' })), null);
  assert.equal(readCachedEnvLocks(memoryStorage({ [ENV_LOCKS_CACHE_KEY]: 'null' })), null);
});

test('a storage that throws does not break the app', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.equal(readCachedEnvLocks(broken), null);
  assert.doesNotThrow(() => writeCachedEnvLocks(broken, { ai: true }));
});

test('a refusal waiting cannot fix is not retried', () => {
  for (const st of [400, 404, 405, 410]) assert.equal(envLocksShouldRetry(st), false, String(st));
  assert.equal(envLocksShouldRetry(408), true);
  assert.equal(envLocksShouldRetry(429), true);
});

test('each server keeps its own answer', () => {
  const s = memoryStorage();
  writeCachedEnvLocks(s, { ai: true, ai_enabled: true }, 'https://home.example');
  assert.equal(readCachedEnvLocks(s, 'https://other.example'), null);
  assert.equal(readCachedEnvLocks(s), null);
  assert.deepEqual(readCachedEnvLocks(s, 'https://home.example'), { ai: true, ai_enabled: true });
  assert.equal(envLocksCacheKey(), ENV_LOCKS_CACHE_KEY);
});

test('App.svelte retries only in view, reloads on coming back, and caches the answer', () => {
  const app = read('../src/App.svelte');
  assert.match(app, /setTimeout\(loadEnvLocks, envLocksRetryDelay\(/);
  assert.match(app, /if \(!envLocksShouldRetry\(status\) \|\| document\.hidden\) return;\s*clearTimeout\(_envLocksTimer\);/);
  assert.match(app, /addEventListener\('online', \(\) => \{ if \(_envLocksWanted\(\)\) loadEnvLocks\(\); \}\)/);
  assert.match(app, /writeCachedEnvLocks\(localStorage, locks, _envLocksServer\(\)\)/);
  // the saved answer is used only when signed in, so Trace never shows on the sign-in page
  assert.match(app, /if \(!\(\$userMgmtActive && !\$currentUser\)\) \{\s*const cachedLocks = readCachedEnvLocks\(localStorage, _envLocksServer\(\)\);/);
});

test("one account's LiftTrace link isn't kept for the next to sign in", () => {
  const s = memoryStorage();
  writeCachedEnvLocks(s, { ai: true, ai_enabled: true, lifttrace_connected: true });
  assert.deepEqual(readCachedEnvLocks(s), { ai: true, ai_enabled: true });
});
