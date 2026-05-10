/**
 * log-capture.js — in-memory ring buffer + optional persistent file logging.
 *
 * Always-on:
 *   - Wraps console.{log,info,warn,error,debug} so everything that goes to
 *     the browser console is also captured in a ring buffer the user can
 *     view + copy via Settings → Diagnostics → View diagnostic logs.
 *   - Catches uncaught errors + unhandled promise rejections.
 *   - On native + uncaught error, writes a crash report file (last buffer +
 *     context) to Capacitor Filesystem at `crashes/crash-<ts>.log`. Survives
 *     app restart so the user can share it from the next session.
 *
 * Diagnostic mode (verbose):
 *   - Toggle via Settings. Persists in localStorage as `nt:verboseLogging`.
 *   - When ON, the file-local `_dlog` helpers in sync.js / settings.js /
 *     notifications.js / health-connect.js etc. start logging (they
 *     normally only run in dev builds).
 *   - When ON on native: also batches the buffer to disk daily at
 *     `logs/nutritrace-YYYY-MM-DD.log`. User exports the file via
 *     Settings → Diagnostics → "Share log file". Daily rotation, last 7
 *     days kept. Survives crashes — one of the main reasons we persist.
 *
 * Buffer size: 1000 lines when verbose, 500 otherwise. Verbose mode
 * generates significantly more log volume so a bigger buffer prevents
 * the actual error from rolling out before the user can capture it.
 *
 * IMPORTED FIRST in src/main.js so the wrappers are installed before any
 * other module logs anything.
 */

const MAX_LINES_DEFAULT = 500;
const MAX_LINES_VERBOSE = 1000;
const buffer = [];

function _stringify(arg) {
  if (arg == null) return String(arg);
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function _maxLines() {
  return _verbose ? MAX_LINES_VERBOSE : MAX_LINES_DEFAULT;
}

function _push(level, args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const text = Array.from(args).map(_stringify).join(' ');
  const line = `[${ts}] [${level.toUpperCase()}] ${text}`;
  buffer.push(line);
  const cap = _maxLines();
  if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
  if (_verbose && _isNative) _enqueueFileWrite(line);
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
    _writeCrashReport({ kind: 'uncaught error', message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    _push('error', ['[unhandled rejection]', _stringify(e.reason)]);
    _writeCrashReport({ kind: 'unhandled rejection', message: _stringify(e.reason), stack: e.reason?.stack });
  });
}

// ── Header line generator ──────────────────────────────────────────────────
//
// Every exported log file / crash report leads with a self-describing
// header so the recipient can tell version + platform + mode without
// having to ask the user. Pure best-effort — failures fall back to
// "unknown" rather than throwing.
// Stored at module load — main.js calls setAppVersion() after importing
// version.js, since a top-level import here would create a small circular
// dependency (log-capture is itself imported first in main.js).
let _appVersion = 'unknown';
export function setAppVersion(v) { if (v) _appVersion = v; }

function _buildHeader() {
  let mode = 'unknown';
  let server = '';
  try {
    if (_isNative) {
      const url = localStorage.getItem('nt:lastServerUrl') || '';
      mode = url ? 'native (server)' : 'native (local)';
      if (url) server = url;
    } else {
      mode = 'web (PWA)';
    }
  } catch {}
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const lines = [
    `NutriTrace ${_appVersion} · ${mode} · ${new Date().toISOString()}`,
  ];
  if (server) lines.push(`Server: ${server}`);
  if (ua) lines.push(`User agent: ${ua}`);
  lines.push('─'.repeat(60));
  return lines.join('\n') + '\n';
}

// ── State ──────────────────────────────────────────────────────────────────
let _verbose = (() => {
  try { return localStorage.getItem('nt:verboseLogging') === '1'; } catch { return false; }
})();
const _isNative = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();

// ── Persistent file logging (native + diagnostic mode only) ───────────────
const LOG_DIR = 'logs';
const CRASH_DIR = 'crashes';
const LOG_RETENTION_DAYS = 7;
const CRASH_RETENTION_FILES = 5;
const FILE_FLUSH_INTERVAL_MS = 2000;

let _writeQueue = [];
let _writeTimer = null;

function _todayLogPath() {
  return `${LOG_DIR}/nutritrace-${new Date().toISOString().slice(0, 10)}.log`;
}

function _enqueueFileWrite(line) {
  _writeQueue.push(line);
  if (_writeTimer) return;
  _writeTimer = setTimeout(_flushWriteQueue, FILE_FLUSH_INTERVAL_MS);
}

async function _flushWriteQueue() {
  _writeTimer = null;
  if (!_writeQueue.length) return;
  const text = _writeQueue.join('\n') + '\n';
  _writeQueue = [];
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const path = _todayLogPath();
    try {
      await Filesystem.appendFile({
        path,
        data: text,
        directory: Directory.Data,
        encoding: 'utf8',
      });
    } catch {
      // First write of the day — ensure dir + create with header
      try { await Filesystem.mkdir({ path: LOG_DIR, directory: Directory.Data, recursive: true }); } catch {}
      await Filesystem.writeFile({
        path,
        data: _buildHeader() + text,
        directory: Directory.Data,
        encoding: 'utf8',
      });
    }
  } catch {
    // Filesystem not ready or plugin unavailable — drop silently.
  }
}

async function _pruneOldLogFiles() {
  if (!_isNative) return;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const list = await Filesystem.readdir({ path: LOG_DIR, directory: Directory.Data }).catch(() => null);
    if (!list?.files) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of list.files) {
      const mtime = f.mtime || 0;
      if (mtime && mtime < cutoff) {
        await Filesystem.deleteFile({ path: `${LOG_DIR}/${f.name}`, directory: Directory.Data }).catch(() => {});
      }
    }
  } catch {}
}

async function _pruneOldCrashFiles() {
  if (!_isNative) return;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const list = await Filesystem.readdir({ path: CRASH_DIR, directory: Directory.Data }).catch(() => null);
    if (!list?.files) return;
    // Keep newest CRASH_RETENTION_FILES, delete older.
    const sorted = list.files
      .filter(f => f.name?.endsWith('.log'))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    for (const f of sorted.slice(CRASH_RETENTION_FILES)) {
      await Filesystem.deleteFile({ path: `${CRASH_DIR}/${f.name}`, directory: Directory.Data }).catch(() => {});
    }
  } catch {}
}

async function _writeCrashReport(detail) {
  if (!_isNative) return;
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = `${CRASH_DIR}/crash-${ts}.log`;
    const body = [
      _buildHeader(),
      `--- CRASH ---`,
      `Kind: ${detail.kind}`,
      `Message: ${detail.message}`,
      detail.source ? `Source: ${detail.source}:${detail.line || 0}:${detail.col || 0}` : '',
      detail.stack ? `Stack:\n${detail.stack}` : '',
      ``,
      `--- LAST ${buffer.length} BUFFER LINES ---`,
      buffer.join('\n'),
    ].filter(Boolean).join('\n');
    try { await Filesystem.mkdir({ path: CRASH_DIR, directory: Directory.Data, recursive: true }); } catch {}
    await Filesystem.writeFile({
      path,
      data: body,
      directory: Directory.Data,
      encoding: 'utf8',
    });
    try { localStorage.setItem('nt:lastCrashFile', path); } catch {}
    _pruneOldCrashFiles();
  } catch {}
}

// Trigger initial cleanup on first verbose-mode use to keep file count bounded.
if (_verbose && _isNative) {
  _pruneOldLogFiles();
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Returns the buffer joined into a single text blob with header — suitable for clipboard / download. */
export function getLogBufferText() {
  return _buildHeader() + buffer.join('\n');
}

/** Wipe the buffer. */
export function clearLogBuffer() {
  buffer.length = 0;
}

/** True when verbose / diagnostic-mode flag is set in localStorage. */
export function isVerboseLogging() {
  return _verbose;
}

/** Toggle verbose / diagnostic mode. Persists across reloads. Triggers cleanup of old files when enabled. */
export function setVerboseLogging(on) {
  _verbose = !!on;
  try {
    if (on) localStorage.setItem('nt:verboseLogging', '1');
    else    localStorage.removeItem('nt:verboseLogging');
  } catch {}
  if (on && _isNative) _pruneOldLogFiles();
}

/** Returns the path to today's log file (Filesystem-relative), or null on web. */
export async function getLogFilePath() {
  if (!_isNative) return null;
  await _flushWriteQueue();
  return _todayLogPath();
}

/** Returns { uri, path } for today's log file via Filesystem.getUri, or null. */
export async function getLogFileUri() {
  if (!_isNative) return null;
  try {
    await _flushWriteQueue();
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const path = _todayLogPath();
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
    return { uri, path };
  } catch {
    return null;
  }
}

/** Returns { uri, path } for the most recent crash report, or null. */
export async function getLastCrashFileUri() {
  if (!_isNative) return null;
  try {
    const path = localStorage.getItem('nt:lastCrashFile');
    if (!path) return null;
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    // Verify file still exists.
    try { await Filesystem.stat({ path, directory: Directory.Data }); }
    catch { localStorage.removeItem('nt:lastCrashFile'); return null; }
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
    return { uri, path };
  } catch {
    return null;
  }
}

/** Whether a crash report is available to share. Synchronous best-effort check. */
export function hasCrashReport() {
  try { return !!localStorage.getItem('nt:lastCrashFile'); } catch { return false; }
}

/** Forget the latest crash report after the user shares or dismisses it. */
export function clearCrashReport() {
  try { localStorage.removeItem('nt:lastCrashFile'); } catch {}
}
