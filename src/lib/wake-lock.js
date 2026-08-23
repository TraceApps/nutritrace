/**
 * Screen Wake Lock helper for long-running foreground operations
 * (AI chat, Scan Label extraction).
 *
 * Motivation (#157/#158): on Android WebView, an idle screen timeout
 * suspends the WebView and the in-flight fetch dies with no way to
 * recover the response. Holding a `screen` wake lock keeps the display
 * on for the duration of the request, which is the primary case the
 * user hits (self-hosted slow model, tap the screen to keep it awake).
 *
 * Deliberately does NOT keep the CPU awake or run in the background.
 * It only prevents the screen from turning off while the app is
 * foreground. Full background resilience needs a server-side job
 * queue (out of scope here).
 *
 * Uses the browser's Screen Wake Lock API (Chrome 84+, Android
 * WebView 84+). Silently no-ops when unavailable or denied — never
 * throws. Callers should treat it as a nice-to-have.
 *
 * Wake locks are auto-released when the document becomes hidden
 * (per spec). We re-acquire on `visibilitychange` if the caller is
 * still holding — matches user expectation ("I came back, keep it
 * on").
 */

// Each ticket represents one active caller. Multiple callers can
// hold at once (e.g. Trace chat + Scan Label). The underlying wake
// lock is released only when the last ticket goes.
const _tickets = new Set();
let _sentinel = null;
let _visListenerAttached = false;

async function _ensureSentinel() {
  if (_sentinel && !_sentinel.released) return;
  try {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      _sentinel = await navigator.wakeLock.request('screen');
    }
  } catch { /* denied or unsupported — silent, non-fatal */ }
}

function _attachVisListener() {
  if (_visListenerAttached || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && _tickets.size > 0) {
      // Re-acquire after the OS auto-released on hide.
      await _ensureSentinel();
    }
  });
  _visListenerAttached = true;
}

async function _releaseSentinelIfIdle() {
  if (_tickets.size === 0 && _sentinel) {
    try { await _sentinel.release(); } catch { /* noop */ }
    _sentinel = null;
  }
}

/**
 * Acquire a screen wake lock ticket. Returns a release function the
 * caller MUST call when done (in a `finally` block, ideally). Safe
 * to call multiple times; each returns its own release fn. Not
 * awaited — callers can await the returned function's promise but
 * don't need to.
 */
export async function acquireScreenWakeLock() {
  const ticket = Symbol('wake-lock-ticket');
  _tickets.add(ticket);
  _attachVisListener();
  await _ensureSentinel();
  return async function release() {
    if (!_tickets.has(ticket)) return; // already released
    _tickets.delete(ticket);
    await _releaseSentinelIfIdle();
  };
}
