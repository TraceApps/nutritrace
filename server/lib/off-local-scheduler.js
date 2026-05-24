/**
 * off-local-scheduler.js — periodic refresh of the local OFF mirror.
 *
 * Reads the `off_local_refresh_interval` app_config row (off|daily|weekly|
 * monthly, default weekly) and triggers off-local.refreshNow() whenever the
 * mirror file's mtime is older than the interval. Tick runs every hour;
 * cheap because all it does is stat() the file and compare timestamps until
 * a refresh is actually due.
 *
 * Separate from the per-user scheduler in scheduler.js so the two have no
 * shared state and a bug in one can't stall the other.
 */
import fs from 'fs';
import db from '../db.js';
import { logger } from '../logger.js';
import { getDbPath, refreshNow, isLocalOffEnabled } from './off-local.js';

const TICK_MS = 60 * 60 * 1000;   // 1 hour
const DEFAULT_INTERVAL = 'weekly';

const INTERVAL_MS = {
  off:     null,                       // disabled
  daily:    1 * 24 * 60 * 60 * 1000,
  weekly:   7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export function getInterval() {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = 'off_local_refresh_interval'`).get();
  const v = (row?.value || DEFAULT_INTERVAL).toLowerCase();
  return Object.prototype.hasOwnProperty.call(INTERVAL_MS, v) ? v : DEFAULT_INTERVAL;
}

export function setInterval(value) {
  const v = String(value || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(INTERVAL_MS, v)) {
    throw new Error(`Invalid OFF refresh interval: ${value}. Use off|daily|weekly|monthly.`);
  }
  db.prepare(`INSERT INTO app_config (key, value) VALUES ('off_local_refresh_interval', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v);
  return v;
}

function _tick() {
  if (!isLocalOffEnabled()) return;
  const interval = getInterval();
  const window = INTERVAL_MS[interval];
  if (!window) return;                 // 'off' — user opted out of auto-refresh
  const p = getDbPath();
  if (!p) return;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch { return; }   // primeFromStartup handles missing-file pull
  const age = Date.now() - mtimeMs;
  if (age < window) return;
  logger.info(`[off-local-scheduler] mirror is ${(age / (24*60*60*1000)).toFixed(1)} days old (interval=${interval}); triggering refresh.`);
  refreshNow({ source: 'scheduled' }).catch(e => {
    logger.warn(`[off-local-scheduler] scheduled refresh failed: ${e.message}`);
  });
}

let _timer = null;
export function startOffLocalScheduler() {
  if (_timer) return;
  // Run once shortly after startup so an overdue mirror gets refreshed
  // without waiting a full hour. 30s gives the initial primeFromStartup
  // download (if any) time to start before we step on it.
  setTimeout(_tick, 30 * 1000);
  _timer = globalThis.setInterval(_tick, TICK_MS);
  logger.info(`[off-local-scheduler] running every ${TICK_MS / 60000} min (interval=${getInterval()})`);
}
