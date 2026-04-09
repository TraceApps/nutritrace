/**
 * push-notify.js — Server-side push notifications via Gotify, ntfy, or Apprise
 *
 * Reads the user's push service config from user_settings.
 * Called from Fitbit/Garmin/Withings sync routes when events occur.
 */

import db from '../db.js';
import { logger } from '../logger.js';

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

export function alertWellness(userId, message) {
  return pushNotify(userId, 'notifWellnessAlerts', '⚠️ Wellness Alert', message, 7);
}

export function notifyWorkout(userId, message) {
  return pushNotify(userId, 'notifWorkoutSummary', '🏋️ Workout Complete', message, 5);
}

export function alertSyncFailure(userId, message) {
  return pushNotify(userId, 'notifSyncFailures', '🔄 Sync Issue', message, 8);
}

export function notifyStepGoal(userId, steps, goal) {
  if (steps >= goal) {
    return pushNotify(userId, 'notifStepGoal', '👟 Step Goal Reached!',
      `${steps.toLocaleString()} steps — goal was ${goal.toLocaleString()}!`, 5);
  }
  const hour = new Date().getHours();
  if (hour >= 12 && hour <= 14 && steps < goal * 0.5) {
    return pushNotify(userId, 'notifStepGoal', '🚶 Step Goal Progress',
      `${steps.toLocaleString()} steps so far — ${(goal - steps).toLocaleString()} to go!`, 4);
  }
}

export function notifyCalorieGoal(userId, calories, goal) {
  return pushNotify(userId, 'notifCalorieGoal', '🔥 Calorie Target Reached',
    `${Math.round(calories).toLocaleString()} kcal — daily target is ${Math.round(goal).toLocaleString()} kcal`, 5);
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

  const parts = [];
  if (m.steps) parts.push(`Avg steps: ${Math.round(m.steps).toLocaleString()}`);
  if (m.calories_out) parts.push(`Avg cal burned: ${Math.round(m.calories_out).toLocaleString()}`);
  if (m.sleep_duration_min) {
    const h = Math.floor(m.sleep_duration_min / 60);
    const min = Math.round(m.sleep_duration_min % 60);
    parts.push(`Avg sleep: ${h}h ${min}m`);
  }

  if (parts.length) {
    return pushNotify(userId, 'notifWeeklySummary', '📊 Weekly Summary', parts.join('\n'), 4);
  }
}
