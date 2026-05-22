/**
 * push-notify.js — Server-side push notifications via Gotify, ntfy, or Apprise
 *
 * Reads the user's push service config from user_settings.
 * Called from Fitbit/Garmin/Withings sync routes when events occur.
 */

import db from '../db.js';
import { logger } from '../logger.js';

// Cleanup stale dedup keys older than 7 days (runs once at module load)
// Key format: _goal_<userId>_<type>_<YYYY-MM-DD> — extract date suffix
try {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT key FROM app_config WHERE key LIKE '_celeb_%' OR key LIKE '_goal_%'`).all();
  const stale = rows.filter(r => {
    const m = r.key.match(/_(\d{4}-\d{2}-\d{2})$/);
    return m && m[1] < sevenDaysAgo;
  });
  if (stale.length > 0) {
    const del = db.prepare('DELETE FROM app_config WHERE key = ?');
    for (const r of stale) del.run(r.key);
    logger.debug(`[push] cleaned up ${stale.length} stale dedup keys`);
  }
} catch (e) {
  logger.debug(`[push] dedup cleanup failed: ${e.message}`);
}

function _getUserSetting(userId, key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row?.value) return '';
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _isEnabled(userId, key) {
  const val = _getUserSetting(userId, key);
  return val === true || val === 'true';
}

// ── Push dispatch — routes to the user's configured service ─────────────────

async function _pushToService(userId, title, message, priority = 5) {
  const service = _getUserSetting(userId, 'notifPushService');
  if (!service || service === 'none') return;

  try {
    switch (service) {
      case 'gotify':  return await _pushGotify(userId, title, message, priority);
      case 'ntfy':    return await _pushNtfy(userId, title, message, priority);
      case 'apprise': return await _pushApprise(userId, title, message, priority);
    }
  } catch (e) {
    logger.warn(`[push] ${service} failed for user ${userId}: ${e.message}`);
  }
}

// ── Gotify ──────────────────────────────────────────────────────────────────

async function _pushGotify(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'gotifyUrl');
  const token = _getUserSetting(userId, 'gotifyToken');
  if (!url || !token) return;

  const res = await fetch(`${url.replace(/\/+$/, '')}/message?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `NutriTrace — ${title}`, message, priority }),
  });
  if (!res.ok) throw new Error(`Gotify ${res.status}`);
  logger.debug(`[push] gotify: "${title}" → user ${userId}`);
}

// ── ntfy ────────────────────────────────────────────────────────────────────

async function _pushNtfy(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'ntfyUrl') || 'https://ntfy.sh';
  const topic = _getUserSetting(userId, 'ntfyTopic');
  const token = _getUserSetting(userId, 'ntfyToken');
  if (!topic) return;

  const headers = { 'Title': `NutriTrace — ${title}`, 'Priority': String(Math.min(5, priority)) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  logger.debug(`[push] ntfy: "${title}" → user ${userId}`);
}

// ── Apprise ─────────────────────────────────────────────────────────────────

async function _pushApprise(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'appriseUrl');
  const tag = _getUserSetting(userId, 'appriseTag');
  if (!url) return;

  const body = { title: `NutriTrace — ${title}`, body: message, type: priority >= 7 ? 'warning' : 'info' };
  if (tag) body.tag = tag;

  const res = await fetch(`${url.replace(/\/+$/, '')}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apprise ${res.status}`);
  logger.debug(`[push] apprise: "${title}" → user ${userId}`);
}

// ── Public API — same interface for all callers ─────────────────────────────

export async function pushNotify(userId, settingKey, title, message, priority = 5) {
  if (!_isEnabled(userId, settingKey)) return;
  return _pushToService(userId, title, message, priority);
}

// Persistent per-day dedup — prevents the same notification firing multiple times
// for the same event on the same day (e.g., steps hit goal → every Fitbit sync would
// re-fire without this). Stored in app_config so it survives server restarts.
// Unified dedup key format — shared between server push-notify AND client
// claim-celebration endpoint. Uses _celeb_ prefix so both paths check
// the same keys and prevent duplicate notifications across all sources.
function _firedToday(userId, key) {
  const today = new Date().toISOString().slice(0, 10);
  const dbKey = `_celeb_${userId}_${key}_${today}`;
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(dbKey);
  if (row?.value) return true;
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(dbKey, '1');
  return false;
}

// Hash a message so we can dedup on content (for wellness alerts — different messages
// for HRV drop vs sleep decline should both fire, but same one shouldn't repeat)
function _msgHash(msg) {
  let h = 0;
  for (let i = 0; i < msg.length; i++) h = ((h << 5) - h + msg.charCodeAt(i)) | 0;
  return String(h);
}

export function alertWellness(userId, message) {
  // Dedup per message content per day — different alerts fire, same one doesn't repeat
  if (_firedToday(userId, `wellness_${_msgHash(message)}`)) return;
  return pushNotify(userId, 'notifWellnessAlerts', '⚠️ Wellness Alert', message, 7);
}

export function notifyWorkout(userId, message) {
  // Dedup per message — new workouts have unique names/durations/calories, same
  // workout re-syncing won't re-fire
  if (_firedToday(userId, `workout_${_msgHash(message)}`)) return;
  return pushNotify(userId, 'notifWorkoutSummary', '🏋️ Workout Complete', message, 5);
}

export function alertSyncFailure(userId, message) {
  // Dedup per service per day — if Fitbit keeps failing, alert once per day, not every tick
  const service = message.match(/^Scheduled (\w+) sync/i)?.[1]?.toLowerCase() || 'sync';
  if (_firedToday(userId, `syncfail_${service}`)) return;
  return pushNotify(userId, 'notifSyncFailures', '🔄 Sync Issue', message, 8);
}

// Key names match client-side notifications.js exactly so dedup is shared
export function notifyStepGoal(userId, steps, goal) {
  if (steps >= goal) {
    if (_firedToday(userId, 'steps_hit')) return;
    return pushNotify(userId, 'notifStepGoal', '👟 Step Goal Reached!',
      `${steps.toLocaleString()} steps — goal was ${goal.toLocaleString()}!`, 5);
  }
  const hour = new Date().getHours();
  if (hour >= 12 && hour <= 14 && steps < goal * 0.5) {
    if (_firedToday(userId, 'steps_midday')) return;
    return pushNotify(userId, 'notifStepGoal', '🚶 Step Goal Progress',
      `${steps.toLocaleString()} steps so far — ${(goal - steps).toLocaleString()} to go!`, 4);
  }
}

export async function sendWeeklySummary(userId) {
  const rows = db.prepare(
    `SELECT metric_type, AVG(value) as avg FROM wellness_data
     WHERE user_id=? AND source='fitbit' AND date >= date('now','-7 days')
     AND metric_type IN ('steps','calories_out','sleep_duration_min')
     GROUP BY metric_type`
  ).all(userId);

  const m = {};
  for (const r of rows) m[r.metric_type] = r.avg;

  let energyUnit = 'kcal';
  try {
    const euRow = db.prepare(`SELECT value FROM user_settings WHERE user_id=? AND key='energyUnit'`).get(userId);
    energyUnit = JSON.parse(euRow?.value || '"kcal"') || 'kcal';
  } catch {}
  const _isKj = energyUnit === 'kJ';

  const parts = [];
  if (m.steps) parts.push(`Avg steps: ${Math.round(m.steps).toLocaleString()}`);
  if (m.calories_out) {
    const v = _isKj ? Math.round(m.calories_out * 4.184) : Math.round(m.calories_out);
    parts.push(`Avg ${_isKj ? 'energy' : 'cal'} burned: ${v.toLocaleString()} ${_isKj ? 'kJ' : 'kcal'}`);
  }
  if (m.sleep_duration_min) {
    const h = Math.floor(m.sleep_duration_min / 60);
    const min = Math.round(m.sleep_duration_min % 60);
    parts.push(`Avg sleep: ${h}h ${min}m`);
  }

  if (parts.length) {
    return pushNotify(userId, 'notifWeeklySummary', '📊 Weekly Summary', parts.join('\n'), 4);
  }
}
