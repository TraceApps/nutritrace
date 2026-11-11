/**
 * The Trace button depends on the startup env-locks request. A failed request
 * used to hide the button for the whole session (no retry, no cache).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  envLocksRetryDelay, envLocksShouldRetry, readCachedEnvLocks, writeCachedEnvLocks, ENV_LOCKS_CACHE_KEY,
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
  assert.deepEqual(readCachedEnvLocks(s), locks);
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

test('App.svelte retries, reloads on coming back online, and caches the answer', () => {
  const app = read('../src/App.svelte');
  assert.match(app, /setTimeout\(loadEnvLocks, envLocksRetryDelay\(/);
  assert.match(app, /if \(!envLocksShouldRetry\(status\)\) return;/);
  assert.match(app, /addEventListener\('online', \(\) => \{ if \(!_envLocksLoaded\) loadEnvLocks\(\); \}\)/);
  assert.match(app, /writeCachedEnvLocks\(localStorage, locks\)/);
  assert.match(app, /readCachedEnvLocks\(localStorage\)/);
});
