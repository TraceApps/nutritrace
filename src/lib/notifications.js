/**
 * notifications.js — Local notification scheduling for NutriTrace
 *
 * Handles water reminders, meal reminders, and goal celebrations.
 * Uses @capacitor/local-notifications on native, Notification API on PWA.
 */

import { isNative, resolveAssetUrl } from './platform.js';
import { LocalNotifications } from '@capacitor/local-notifications';

// Verbose notification logs gated on dev OR opt-in verbose mode
// (Settings → Diagnostics → Verbose diagnostic logging).
const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('nt:verboseLogging') === '1') console.log(...a); } catch {} };

function _getLN() {
  if (!isNative) return null;
  return LocalNotifications;
}

let _channelCreated = false;

/** Ensure the notification channel exists (Android requires this) */
async function _ensureChannel() {
  if (_channelCreated || !isNative) return;
  const LN = _getLN();
  if (!LN) return;
  try {
    await LN.createChannel({
      id: 'nutritrace',
      name: 'NutriTrace',
      description: 'NutriTrace notifications',
      importance: 4, // HIGH
      visibility: 1, // PUBLIC
      sound: 'default',
      vibration: true,
    });
    _channelCreated = true;
    _dlog('[notifications] channel created');
  } catch (e) {
    console.warn('[notifications] channel creation failed:', e.message);
  }
}

/** Request notification permission */
export async function requestPermission() {
  if (isNative) {
    const LN = _getLN();
    if (!LN) return false;
    const result = await LN.requestPermissions();
    return result.display === 'granted';
  }
  // PWA: use Notification API
  if ('Notification' in window) {
    const result = await Notification.requestPermission();
    return result === 'granted';
  }
  return false;
}

/** Check if notifications are permitted */
export async function checkPermission() {
  if (isNative) {
    const LN = _getLN();
    if (!LN) return false;
    const result = await LN.checkPermissions();
    return result.display === 'granted';
  }
  if ('Notification' in window) return Notification.permission === 'granted';
  return false;
}

/** Show an immediate notification */
export async function showNotification(title, body, id = null) {
  const notifId = id || (Math.floor(Math.random() * 100000) + 5000);
  if (isNative) {
    const LN = _getLN();
    if (!LN) { console.error('[notifications] LocalNotifications not available'); return; }
    // Check permission first
    const perm = await LN.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LN.requestPermissions();
      if (req.display !== 'granted') {
        console.warn('[notifications] permission denied');
        return;
      }
    }
    try {
      await LN.schedule({
        notifications: [{
          id: notifId,
          title,
          body,
        }]
      });
      _dlog(`[notifications] scheduled OK: "${title}" id=${notifId}`);
    } catch (e) {
      console.error('[notifications] schedule FAILED:', e);
    }
  } else if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: resolveAssetUrl('/icons/icon-192.png') });
  }
}

// ── Water reminders ─────────────────────────────────────────────────────────

// KILL SWITCH: Native WorkManager (ReminderWorker.java) handles meal/water/weigh-in
// reminders smartly by checking SQLite. Set to false to re-enable the JS-scheduled
// dumb fallback (fires regardless of diary state). See MEMORY: feedback_workmanager_reminders.
const _USE_NATIVE_WORKER = true;

/** Schedule repeating water reminders every `intervalMin` minutes, 8am–10pm daily */
export async function scheduleWaterReminders(intervalMin = 120) {
  if (!isNative) return;
  if (_USE_NATIVE_WORKER) { await cancelWaterReminders(); return; }
  const LN = _getLN();
  if (!LN) return;
  await cancelWaterReminders();

  // Create repeating daily notifications at fixed times within 8am-10pm
  const notifications = [];
  const startHour = 8, endHour = 22;
  let id = 1000;
  for (let min = startHour * 60; min < endHour * 60; min += intervalMin) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    // Schedule first occurrence today or tomorrow
    const at = new Date();
    at.setHours(h, m, 0, 0);
    if (at <= new Date()) at.setDate(at.getDate() + 1);
    notifications.push({
      id: id++,
      title: '💧 Hydration Reminder',
      body: 'Time to drink some water! Stay hydrated.',
      schedule: { at, every: 'day', allowWhileIdle: true },
    });
  }

  if (notifications.length) {
    await LN.schedule({ notifications });
    _dlog(`[notifications] scheduled ${notifications.length} repeating water reminders`);
  }
}

export async function cancelWaterReminders() {
  if (!isNative) return;
  const LN = _getLN();
  if (!LN) return;
  const pending = await LN.getPending();
  const ids = pending.notifications.filter(n => n.id >= 1000 && n.id < 2000).map(n => ({ id: n.id }));
  if (ids.length) await LN.cancel({ notifications: ids });
}

// ── Meal reminders ──────────────────────────────────────────────────────────

/** Schedule repeating daily meal reminders at specified times */
export async function scheduleMealReminders(times = ['08:00', '12:00', '18:00'], mealNames = ['Breakfast', 'Lunch', 'Dinner']) {
  if (!isNative) return;
  if (_USE_NATIVE_WORKER) { await cancelMealReminders(); return; }
  const LN = _getLN();
  if (!LN) return;
  await cancelMealReminders();

  const notifications = [];
  times.forEach((time, i) => {
    const [h, m] = time.split(':').map(Number);
    const at = new Date();
    at.setHours(h, m, 0, 0);
    if (at <= new Date()) at.setDate(at.getDate() + 1);
    notifications.push({
      id: 2000 + i,
      title: '🍽️ Meal Reminder',
      body: `Time to log your ${mealNames[i] || 'meal'}!`,
      schedule: { at, every: 'day', allowWhileIdle: true },
    });
  });

  if (notifications.length) {
    await LN.schedule({ notifications });
    _dlog(`[notifications] scheduled ${notifications.length} repeating meal reminders`);
  }
}

export async function cancelMealReminders() {
  if (!isNative) return;
  const LN = _getLN();
  if (!LN) return;
  const pending = await LN.getPending();
  const ids = pending.notifications.filter(n => n.id >= 2000 && n.id < 3000).map(n => ({ id: n.id }));
  if (ids.length) await LN.cancel({ notifications: ids });
}

// ── Unified notify — sends to all enabled delivery methods ──────────────────

function _getSetting(key, def) {
  // Read from localStorage directly (same as DB.getSetting but without circular import)
  const userId = localStorage.getItem('wl:userId');
  const storageKey = userId ? `wl_u${userId}_${key}` : `wl_${key}`;
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return def;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Send a notification through all enabled delivery methods.
 * @param {string} settingKey — which notification type to check (e.g. 'notifWellnessAlerts')
 * @param {string} title
 * @param {string} body
 * @param {number} priority — 1-10 for Gotify (5 = default)
 */
export async function notify(settingKey, title, body, priority = 5) {
  // Check if this notification type is enabled
  if (!_getSetting(settingKey, false)) return;

  // Local device notification
  if (_getSetting('notifLocalEnabled', true)) {
    await showNotification(title, body);
  }

  // Push service (Gotify / ntfy / Apprise)
  const pushService = _getSetting('notifPushService', 'none');
  if (pushService !== 'none') {
    try { await sendPush(pushService, title, body, priority); } catch (e) {
      console.warn(`[notify] ${pushService} push failed:`, e.message);
    }
  }
}

// ── Goal checking ───────────────────────────────────────────────────────────

// Track which goals we've already celebrated today to avoid repeats
// Persisted to localStorage so it survives app reloads/restarts
const _celebratedToday = new Set();

function _loadCelebrations() {
  try {
    const raw = localStorage.getItem('_celebratedToday');
    if (!raw) return;
    const obj = JSON.parse(raw);
    const key = new Date().toLocaleDateString('sv-SE');
    if (obj._date === key && Array.isArray(obj.keys)) {
      obj.keys.forEach(k => _celebratedToday.add(k));
      _celebratedToday._date = key;
    }
  } catch {}
}
_loadCelebrations();

function _persistCelebrations() {
  try {
    localStorage.setItem('_celebratedToday', JSON.stringify({
      _date: _celebratedToday._date,
      keys: Array.from(_celebratedToday).filter(k => k !== '_date'),
    }));
  } catch {}
}

/** Reset celebrations at midnight */
function _resetCelebrations() {
  const key = new Date().toLocaleDateString('sv-SE');
  if (_celebratedToday._date !== key) {
    _celebratedToday.clear();
    _celebratedToday._date = key;
    _persistCelebrations();
  }
}

const GOAL_LABELS = {
  calories: 'Calorie', proteins: 'Protein', carbohydrates: 'Carbs', fat: 'Fat',
  fiber: 'Fiber', sodium: 'Sodium', sugars: 'Sugar', 'saturated-fat': 'Saturated Fat',
  cholesterol: 'Cholesterol', potassium: 'Potassium', calcium: 'Calcium',
  iron: 'Iron', 'vitamin-c': 'Vitamin C', 'vitamin-a': 'Vitamin A',
  'vitamin-d': 'Vitamin D', water_ml: 'Water',
  sleep_duration_min: 'Sleep', steps: 'Steps', active_minutes: 'Active Minutes',
  distance_km: 'Distance', calories_out: 'Calories Burned',
};

const GOAL_UNITS = {
  calories: 'kcal', proteins: 'g', carbohydrates: 'g', fat: 'g',
  fiber: 'g', sodium: 'mg', sugars: 'g', 'saturated-fat': 'g',
  cholesterol: 'mg', potassium: 'mg', calcium: 'mg', iron: 'mg',
  'vitamin-c': 'mg', 'vitamin-a': 'mcg', 'vitamin-d': 'mcg',
  water_ml: 'ml', sleep_duration_min: 'min', steps: 'steps',
  active_minutes: 'min', distance_km: 'km', calories_out: 'kcal',
};

/**
 * Check all goals against current values and fire notifications for any that are met.
 * @param {Object} goals — the user's goals object { calories: { min, max }, proteins: { min }, ... }
 * @param {Object} values — current totals { calories: 1850, proteins: 120, ... }
 */
/** Ask the server to atomically claim this celebration. Returns true if this caller
 *  is the first to fire it today. Falls back to local-only dedup if the request fails. */
async function _claimCelebrationServer(key) {
  try {
    const { NtApi } = await import('./api.js');
    const res = await NtApi.post('/api/settings/claim-celebration', { key });
    return !!res?.fired;
  } catch {
    // Network error / native local mode — fall back to local-only dedup
    return true;
  }
}

export async function checkGoals(goals, values) {
  if (!goals || !values) return;
  _resetCelebrations();
  _dlog('[notifications] checkGoals:', { goals: Object.keys(goals), values: Object.keys(values) });

  for (const [key, goal] of Object.entries(goals)) {
    if (!goal) continue;
    const val = values[key];
    if (val == null) continue;

    const target = goal.min ?? goal.max;
    if (target == null) continue;

    const celebKey = `${key}_${new Date().toLocaleDateString('sv-SE')}`;
    if (_celebratedToday.has(celebKey)) { _dlog(`[notifications] ${key} already celebrated`); continue; }

    _dlog(`[notifications] checking ${key}: val=${val}, min=${goal.min}, max=${goal.max}`);

    // Goal celebration: hit min target OR reached max target
    if ((goal.min != null && val >= goal.min) || (goal.max != null && val >= goal.max)) {
      // Mark local first (fast), then claim server-side. If server says "already
      // fired", we skip — cross-device dedup.
      _celebratedToday.add(celebKey);
      _persistCelebrations();
      const serverClaimed = await _claimCelebrationServer(key);
      if (!serverClaimed) { _dlog(`[notifications] ${key} already celebrated on another device`); continue; }
      const label = GOAL_LABELS[key] || key;
      const unit = GOAL_UNITS[key] || '';
      const tgt = goal.min ?? goal.max;
      _dlog(`[notifications] FIRING goal celebration for ${key}: ${val} >= ${tgt}`);
      await notify('notifGoalCelebrations', '🎯 Goal Reached!',
        `You hit your ${label} goal: ${Math.round(val).toLocaleString()} ${unit} (target: ${Math.round(tgt).toLocaleString()})`, 5);
    }

    // Calorie goal specific
    if (key === 'calories' && goal.max != null && val >= goal.max) {
      if (!_celebratedToday.has('cal_max')) {
        _celebratedToday.add('cal_max');
        _persistCelebrations();
        const serverClaimed = await _claimCelebrationServer('cal_max');
        if (!serverClaimed) continue;
        await notify('notifCalorieGoal', '🔥 Calorie Target Reached',
          `You've hit ${Math.round(val).toLocaleString()} kcal — your daily target is ${Math.round(goal.max).toLocaleString()} kcal`, 6);
      }
    }
  }
}

/**
 * Check step goal after Fitbit/Garmin sync
 * @param {number} steps — today's step count
 * @param {number} goal — step goal
 */
export async function checkStepGoal(steps, goal) {
  if (!steps || !goal) return;
  _resetCelebrations();

  if (steps >= goal && !_celebratedToday.has('steps_hit')) {
    _celebratedToday.add('steps_hit');
    _persistCelebrations();
    const serverClaimed = await _claimCelebrationServer('steps_hit');
    if (!serverClaimed) return;
    await notify('notifStepGoal', '👟 Step Goal Reached!',
      `You've walked ${steps.toLocaleString()} steps — goal was ${goal.toLocaleString()}!`, 5);
  } else if (!_celebratedToday.has('steps_midday')) {
    const hour = new Date().getHours();
    if (hour >= 12 && hour <= 14 && steps < goal * 0.5) {
      _celebratedToday.add('steps_midday');
      _persistCelebrations();
      const serverClaimed = await _claimCelebrationServer('steps_midday');
      if (!serverClaimed) return;
      const remaining = goal - steps;
      await notify('notifStepGoal', '🚶 Step Goal Progress',
        `You're at ${steps.toLocaleString()} steps — ${remaining.toLocaleString()} to go!`, 4);
    }
  }
}

// ── Gotify push ─────────────────────────────────────────────────────────────

/** Send a notification via Gotify server */
/** Send push notification via the user's configured service */
export async function sendPush(service, title, message, priority = 5) {
  switch (service) {
    case 'gotify': {
      const url = _getSetting('gotifyUrl', '');
      const token = _getSetting('gotifyToken', '');
      return sendGotify(url, token, title, message, priority);
    }
    case 'ntfy': {
      const url = _getSetting('ntfyUrl', 'https://ntfy.sh');
      const topic = _getSetting('ntfyTopic', '');
      const token = _getSetting('ntfyToken', '');
      return sendNtfy(url, topic, token, title, message, priority);
    }
    case 'apprise': {
      const url = _getSetting('appriseUrl', '');
      const tag = _getSetting('appriseTag', '');
      return sendApprise(url, tag, title, message, priority);
    }
  }
}

export async function sendNtfy(url, topic, token, title, message, priority = 5) {
  if (!topic) throw new Error('ntfy topic required');
  const endpoint = `${(url || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
  const headers = { 'Title': title, 'Priority': String(Math.min(5, priority)) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  if (isNative) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const resp = await CapacitorHttp.post({ url: endpoint, headers, data: message });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`ntfy ${resp.status}`);
  } else {
    const { apiUrl } = await import('./platform.js');
    const csrf = localStorage.getItem('nt:csrf');
    // Proxy through server on PWA
    const res = await fetch(apiUrl('/api/settings/push-test'), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ service: 'ntfy', title, message, priority }),
    });
    if (!res.ok) throw new Error(`ntfy proxy ${res.status}`);
  }
}

export async function sendApprise(url, tag, title, message, priority = 5) {
  if (!url) throw new Error('Apprise URL required');
  const body = { title, body: message, type: priority >= 7 ? 'warning' : 'info' };
  if (tag) body.tag = tag;
  const endpoint = `${url.replace(/\/+$/, '')}/notify`;

  if (isNative) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const resp = await CapacitorHttp.post({ url: endpoint, headers: { 'Content-Type': 'application/json' }, data: body });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`Apprise ${resp.status}`);
  } else {
    const { apiUrl } = await import('./platform.js');
    const csrf = localStorage.getItem('nt:csrf');
    const res = await fetch(apiUrl('/api/settings/push-test'), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ service: 'apprise', title, message, priority }),
    });
    if (!res.ok) throw new Error(`Apprise proxy ${res.status}`);
  }
}

export async function sendGotify(url, token, title, message, priority = 5) {
  if (!url || !token) throw new Error('Gotify URL and token required');
  const endpoint = `${url.replace(/\/+$/, '')}/message?token=${encodeURIComponent(token)}`;

  if (isNative) {
    // Native: CapacitorHttp bypasses CORS — call Gotify directly
    const { CapacitorHttp } = await import('@capacitor/core');
    const resp = await CapacitorHttp.post({
      url: endpoint,
      headers: { 'Content-Type': 'application/json' },
      data: { title, message, priority },
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Gotify ${resp.status}`);
    }
  } else {
    // PWA: use server proxy to avoid CORS
    const { apiUrl } = await import('./platform.js');
    const csrf = localStorage.getItem('nt:csrf');
    const res = await fetch(apiUrl('/api/settings/push-test'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify({ service: 'gotify', title, message, priority }),
    });
    if (!res.ok) throw new Error(`Gotify proxy ${res.status}`);
  }
}

/** Test Gotify connection */
export async function testGotify(url, token) {
  try {
    await sendGotify(url, token, 'NutriTrace', 'Test notification — Gotify is connected!', 5);
    return true;
  } catch {
    return false;
  }
}

// ── Weigh-in reminder scheduling ────────────────────────────────────────────

export async function scheduleWeighInReminder(timeStr = '07:00') {
  if (!isNative) return;
  if (_USE_NATIVE_WORKER) { await cancelWeighInReminder(); return; }
  const LN = _getLN();
  if (!LN) return;
  await cancelWeighInReminder();

  const [h, m] = timeStr.split(':').map(Number);
  const at = new Date();
  at.setHours(h, m, 0, 0);
  if (at <= new Date()) at.setDate(at.getDate() + 1);

  await LN.schedule({ notifications: [{
    id: 4000,
    title: '⚖️ Weigh-in Reminder',
    body: 'Time to step on the scale!',
    schedule: { at, every: 'day', allowWhileIdle: true },
    channelId: 'nutritrace',
  }]});
  _dlog(`[notifications] scheduled repeating weigh-in reminder at ${timeStr}`);
}

export async function cancelWeighInReminder() {
  if (!isNative) return;
  const LN = _getLN();
  if (!LN) return;
  const pending = await LN.getPending();
  const ids = pending.notifications.filter(n => n.id >= 4000 && n.id < 5000).map(n => ({ id: n.id }));
  if (ids.length) await LN.cancel({ notifications: ids });
}
