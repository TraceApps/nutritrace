/**
 * log-capture.js — in-memory ring buffer of console.* output.
 *
 * Wraps console.{log,info,warn,error,debug} so everything that goes to the
 * browser console is also captured in a buffer the user can view + copy
 * via Settings → Diagnostics → View diagnostic logs.
 *
 * Buffer is 500 lines (a few minutes of normal activity), small enough to
 * fit in a clipboard. No PII filtering — the user is the one viewing it
 * and copying it; we trust them to redact before sharing.
 *
 * Verbose mode: when localStorage `nt:verboseLogging === '1'`, the
 * file-local `_dlog` helpers in sync.js / settings.js / notifications.js /
 * health-connect.js etc. start logging too (they normally only run in dev
 * builds). Lets users grab high-detail logs while reproducing a bug,
 * without forcing verbose logging on everyone all the time.
 *
 * IMPORTED FIRST in src/main.js so the wrappers are installed before any
 * other module logs anything.
 */

const MAX_LINES = 500;
const buffer = [];

function _stringify(arg) {
  if (arg == null) return String(arg);
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function _push(level, args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const text = Array.from(args).map(_stringify).join(' ');
  buffer.push(`[${ts}] [${level.toUpperCase()}] ${text}`);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
}

// Wrap console methods. Original behavior is preserved — devtools sees them too.
const _orig = {};
['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
  _orig[level] = console[level].bind(console);
  console[level] = (...args) => {
    try { _push(level, args); } catch {}
    _orig[level](...args);
  };
});

// Catch uncaught errors + unhandled promise rejections — these are the
// most useful entries to have in a bug report.
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    _push('error', ['[uncaught]', e.message, 'at', `${e.filename || ''}:${e.lineno || 0}`]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    _push('error', ['[unhandled rejection]', _stringify(e.reason)]);
  });
}

/** Returns the captured log lines as an array (most recent last). */
export function getLogBuffer() {
  return buffer.slice();
}

/** Returns the buffer joined into a single text blob (suitable for clipboard / download). */
export function getLogBufferText() {
  return buffer.join('\n');
}

/** Wipe the buffer. */
export function clearLogBuffer() {
  buffer.length = 0;
}

/** True when verbose-mode flag is set in localStorage. */
export function isVerboseLogging() {
  try { return localStorage.getItem('nt:verboseLogging') === '1'; } catch { return false; }
}

/** Toggle verbose mode. Persists across reloads. */
export function setVerboseLogging(on) {
  try {
    if (on) localStorage.setItem('nt:verboseLogging', '1');
    else    localStorage.removeItem('nt:verboseLogging');
  } catch {}
}
