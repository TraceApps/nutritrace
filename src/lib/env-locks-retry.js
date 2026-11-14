/**
 * Retry rules for the startup env-locks request (App.svelte).
 *
 * Trace's button shows only when the server reports AI as on, and that answer
 * comes from one request at startup. If the request failed (the server was
 * restarting, or the phone was off the tailnet), the button stayed hidden for
 * the whole session. So the request is retried, and the last answer is kept
 * so a cold start with no connection still shows the button.
 */

const RETRY_MS = [2000, 5000, 15000, 30000, 60000];

export const ENV_LOCKS_CACHE_KEY = 'nt:envLocks';

export function envLocksRetryDelay(attempt) {
  return RETRY_MS[Math.min(Math.max(0, attempt), RETRY_MS.length - 1)];
}

// Only what waiting can fix: no connection (0), a server error, a timeout or
// too many requests. A sign-in problem is fixed by signing in, which loads the
// locks again; any other refusal answers the same next time.
export function envLocksShouldRetry(status) {
  return status === 0 || status >= 500 || status === 408 || status === 429;
}

// One saved answer per server: the Android app can point at another server.
export function envLocksCacheKey(server = '') {
  return server ? `${ENV_LOCKS_CACHE_KEY}:${server}` : ENV_LOCKS_CACHE_KEY;
}

export function readCachedEnvLocks(storage, server = '') {
  try {
    const v = JSON.parse(storage.getItem(envLocksCacheKey(server)));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// lifttrace_connected belongs to whoever is signed in, so it isn't kept: the
// rest is the server's and the same for every account on it.
export function writeCachedEnvLocks(storage, locks, server = '') {
  try {
    const { lifttrace_connected, ...serverWide } = locks || {};
    storage.setItem(envLocksCacheKey(server), JSON.stringify(serverWide));
  } catch { /* storage full or blocked: the next start just waits for the server */ }
}
