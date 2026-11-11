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

// A sign-in problem is not fixed by waiting. Signing in loads the locks again.
export function envLocksShouldRetry(status) {
  return status !== 401 && status !== 403;
}

export function readCachedEnvLocks(storage) {
  try {
    const v = JSON.parse(storage.getItem(ENV_LOCKS_CACHE_KEY));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeCachedEnvLocks(storage, locks) {
  try {
    storage.setItem(ENV_LOCKS_CACHE_KEY, JSON.stringify(locks));
  } catch { /* storage full or blocked: the next start just waits for the server */ }
}
