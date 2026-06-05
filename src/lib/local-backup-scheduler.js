/**
 * local-backup-scheduler.js — fire scheduled local backups while the
 * NutriTrace app is open in local Android mode.
 *
 * Local mode has no server-side scheduler (there's no server), and a
 * background WorkManager job would need native Java + a JS bridge. For
 * v1, a JS-side tick that runs while the app is in the foreground is the
 * right scope. Users open the app at least once a day to log meals; the
 * tick fires on app open + every 5 minutes + on visibilitychange, so a
 * "daily" schedule lands within minutes of the first time the user opens
 * the app after the scheduled time.
 *
 * Storage:
 *   - Auto backups: Documents/nutritrace-backups/nutritrace-backup-auto-<ts>.zip
 *   - Manual backups: Documents/nutritrace-backups/nutritrace-backup-<ts>.zip
 *   - Retention prunes only the auto-prefixed ones, so the user's manual
 *     archives are never touched by the scheduler.
 *
 * Settings: localBackupSchedule / Time / Retention / LastRun / LastError
 * (see stores/settings.js).
 */
import { isNative, getNativeMode } from './platform.js';
import {
  localBackupSchedule, localBackupTime, localBackupRetention,
  localBackupLastRun, localBackupLastError,
} from '../stores/settings.js';

// Interval-since-last-run gate. Mirrors server-side semantics so the
// daily/weekly/monthly behavior is consistent across the two modes.
const INTERVAL_MS = {
  daily:   22 * 60 * 60 * 1000,        // 22h (DST + tick buffer)
  weekly:  6.5 * 24 * 60 * 60 * 1000,  // 6.5 days
  monthly: 28 * 24 * 60 * 60 * 1000,   // 28 days
};

// Auto backup filename prefix so retention prune only touches auto-saved
// archives, leaving the user's manual exports alone.
const AUTO_PREFIX = 'nutritrace-backup-auto-';
const BACKUP_DIR  = 'nutritrace-backups';

// Tick cadence — every 5 min while the app is open. Cheap (just reads
// settings + does a time comparison) and gives the scheduler reasonable
// granularity without burning battery.
const TICK_MS = 5 * 60 * 1000;

let _timer = null;
let _running = false; // re-entrancy guard so a slow backup doesn't double-fire

function _isLocalMode() {
  return !!(isNative && getNativeMode() === 'local');
}

/** Start the JS-side scheduler. Idempotent — calling again does nothing
 *  if a timer is already running. Safe to call from App.svelte on mount
 *  regardless of mode; the tick itself no-ops in non-local-mode. */
export function startLocalBackupScheduler() {
  if (_timer) return;
  if (!_isLocalMode()) return;
  // First check fires soon (in case we just opened the app after the
  // scheduled time has passed); subsequent checks every TICK_MS.
  setTimeout(_tick, 5_000);
  _timer = setInterval(_tick, TICK_MS);
  // Also check on tab/app-foreground events so users who background +
  // foreground without a tick interval landing get a check immediately.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', _onVisibility);
  }
}

/** Stop the scheduler (e.g. on app destroy or mode switch). */
export function stopLocalBackupScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _onVisibility);
  }
}

function _onVisibility() {
  if (document.visibilityState === 'visible') {
    setTimeout(_tick, 1_000); // small debounce; let the app settle
  }
}

async function _tick() {
  if (_running) return;
  if (!_isLocalMode()) return;

  const schedule = localBackupSchedule.get();
  if (schedule === 'off') return;
  const intervalMs = INTERVAL_MS[schedule];
  if (!intervalMs) return;

  const timeStr = localBackupTime.get() || '03:00';
  const [hh, mm] = String(timeStr).split(':').map(n => parseInt(n, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;

  const now = new Date();
  const scheduledMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0).getTime();
  if (now.getTime() < scheduledMs) return; // not yet scheduled time today

  const last = localBackupLastRun.get();
  if (last) {
    const lastMs = new Date(last).getTime();
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < intervalMs) return;
  }

  await _runAutoBackup();
}

async function _runAutoBackup() {
  if (_running) return;
  _running = true;
  try {
    const { exportLocalBackup } = await import('./local-backup.js');
    const blob = await exportLocalBackup({ onProgress: () => {} });
    const filename = `${AUTO_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
    await _writeBackupFile(filename, blob);
    await _pruneAutoBackups(parseInt(localBackupRetention.get(), 10) || 7);
    localBackupLastRun.set(new Date().toISOString());
    localBackupLastError.set('');
    console.log(`[local-backup] auto-backup saved: ${filename}`);
  } catch (e) {
    const msg = e?.message || String(e);
    localBackupLastError.set(msg);
    console.warn(`[local-backup] auto-backup failed: ${msg}`);
  } finally {
    _running = false;
  }
}

/** Write a blob as a base64-encoded file via Capacitor Filesystem. Uses
 *  the same Documents/nutritrace-backups/ path the manual export
 *  function uses, so manual + auto archives sit alongside each other. */
async function _writeBackupFile(filename, blob) {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  await Filesystem.mkdir({ path: BACKUP_DIR, directory: Directory.Documents, recursive: true }).catch(() => {});
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  // Chunked base64 encode to avoid the stack overflow when
  // String.fromCharCode.apply is given a huge array directly.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  await Filesystem.writeFile({
    path: `${BACKUP_DIR}/${filename}`,
    data: b64,
    directory: Directory.Documents,
  });
}

/** Delete auto-prefixed ZIPs beyond the retention limit, oldest first.
 *  Manual exports (which use a different filename prefix) are never
 *  touched. */
async function _pruneAutoBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || 7));
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  try {
    const list = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Documents });
    const autos = (list.files || [])
      .filter(f => f.name && f.name.startsWith(AUTO_PREFIX) && f.name.endsWith('.zip'))
      .sort((a, b) => (b.name || '').localeCompare(a.name || '')); // newest first (timestamp in filename)
    const toDelete = autos.slice(keep);
    for (const f of toDelete) {
      try {
        await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${f.name}`, directory: Directory.Documents });
      } catch (e) {
        console.warn(`[local-backup] prune failed for ${f.name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[local-backup] prune list failed: ${e.message}`);
  }
}

/** Trigger an auto-backup now, bypassing the schedule check. Used by the
 *  Settings UI's "Run now" button if/when we add one — keeps the same
 *  filename prefix + retention behavior as the scheduled path. */
export async function runLocalBackupNow() {
  if (!_isLocalMode()) throw new Error('Not in local mode');
  await _runAutoBackup();
}
