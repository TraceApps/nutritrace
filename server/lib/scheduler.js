/**
 * scheduler.js — Server-side scheduled tasks
 *
 * Runs periodic checks for:
 * 1. Scheduled wellness sync (Fitbit/Garmin/Withings) per user settings
 * 2. Push notifications for time-based reminders (water, meal, weigh-in)
 * 3. Weekly summary on Sundays
 *
 * Checks every 15 minutes. Each user's schedule is read from user_settings.
 */

import db from '../db.js';
import { logger } from '../logger.js';

const _lastRun = {}; // userId_task → timestamp (dedup within window)

function _getUserSetting(userId, key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

/** Get current time in the user's timezone */
function _getUserLocalTime(userId) {
  const tz = _getUserSetting(userId, 'timezone');
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      }).formatToParts(new Date());
      const get = (type) => parts.find(p => p.type === type)?.value;
      return {
        hour: parseInt(get('hour')),
        minute: parseInt(get('minute')),
        day: parseInt(get('day')),
        weekday: new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }),
        dayOfWeek: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(
          new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
        ),
        dateStr: new Date().toLocaleDateString('sv-SE', { timeZone: tz }),
      };
    } catch {}
  }
  // Fallback: server time
  const now = new Date();
  return {
    hour: now.getHours(), minute: now.getMinutes(),
    day: now.getDate(), weekday: now.toLocaleDateString('en-US', { weekday: 'short' }),
    dayOfWeek: now.getDay(),
    dateStr: now.toISOString().slice(0, 10),
  };
}

function _isEnabled(userId, key) {
  const val = _getUserSetting(userId, key);
  return val === true || val === 'true';
}

function _dedupKey(userId, task) { return `${userId}_${task}`; }

function _ranRecently(userId, task, windowMs = 14 * 60 * 1000) {
  const key = _dedupKey(userId, task);
  const last = _lastRun[key];
  if (last && Date.now() - last < windowMs) return true;
  _lastRun[key] = Date.now();
  return false;
}

// ── Scheduled wellness sync ─────────────────────────────────────────────────

async function _syncWellness(userId) {
  const syncMode = _getUserSetting(userId, 'wellnessSyncMode');
  if (syncMode !== 'scheduled') return;

  const schedule = _getUserSetting(userId, 'wellnessSyncSchedule') || 'daily';
  const syncTime = _getUserSetting(userId, 'wellnessSyncTime') || '14:00';
  const [h, m] = syncTime.split(':').map(Number);
  const local = _getUserLocalTime(userId);

  // Check if we're within the 15-minute window of the scheduled time (in USER's timezone)
  const scheduledMin = h * 60 + m;
  const currentMin = local.hour * 60 + local.minute;
  const diff = currentMin - scheduledMin;

  let shouldSync = false;
  if (schedule === 'daily' && diff >= 0 && diff < 15) shouldSync = true;
  if (schedule === 'every6h' && local.hour % 6 === h % 6 && local.minute < 15) shouldSync = true;
  if (schedule === 'every12h' && local.hour % 12 === h % 12 && local.minute < 15) shouldSync = true;
  if (schedule === 'weekly' && local.dayOfWeek === 0 && diff >= 0 && diff < 15) shouldSync = true;

  if (!shouldSync) return;
  if (_ranRecently(userId, 'wellness_sync', 5 * 60 * 60 * 1000)) return; // 5h dedup for daily

  logger.info(`[scheduler] running scheduled wellness sync for user ${userId}`);

  // Import and run Fitbit sync
  try {
    const today = local.dateStr;

    // Fitbit sync
    const hasFitbit = db.prepare('SELECT 1 FROM fitbit_tokens WHERE user_id=?').get(userId);
    if (hasFitbit) {
      try {
        const { syncDate } = await import('../routes/fitbit.js');
        logger.info(`[scheduler] Fitbit sync for user ${userId} date ${today}`);
        const { metrics, errors } = await syncDate(userId, today);
        logger.info(`[scheduler] Fitbit sync done: ${Object.keys(metrics || {}).length} metrics, ${errors?.length || 0} errors`);
      } catch (e) {
        logger.warn(`[scheduler] Fitbit sync error for user ${userId}: ${e.message}`);
        try { const { alertSyncFailure } = await import('./push-notify.js'); alertSyncFailure(userId, `Scheduled Fitbit sync failed: ${e.message}`); } catch {}
      }
    }

    // Withings sync
    const hasWithings = db.prepare('SELECT 1 FROM withings_tokens WHERE user_id=?').get(userId);
    if (hasWithings) {
      try {
        const { syncRange } = await import('../routes/withings.js');
        logger.info(`[scheduler] Withings sync for user ${userId} date ${today}`);
        const result = await syncRange(userId, today, today);
        logger.info(`[scheduler] Withings sync done: ${result?.dates || 0} dates`);
      } catch (e) {
        logger.warn(`[scheduler] Withings sync error for user ${userId}: ${e.message}`);
        try { const { alertSyncFailure } = await import('./push-notify.js'); alertSyncFailure(userId, `Scheduled Withings sync failed: ${e.message}`); } catch {}
      }
    }

    // Garmin sync
    const hasGarmin = db.prepare('SELECT 1 FROM garmin_tokens WHERE user_id=?').get(userId);
    if (hasGarmin) {
      try {
        const { syncRange } = await import('../routes/garmin.js');
        logger.info(`[scheduler] Garmin sync for user ${userId} date ${today}`);
        const result = await syncRange(userId, today, today);
        logger.info(`[scheduler] Garmin sync done: ${result?.synced || 0} synced`);
      } catch (e) {
        logger.warn(`[scheduler] Garmin sync error for user ${userId}: ${e.message}`);
        try { const { alertSyncFailure } = await import('./push-notify.js'); alertSyncFailure(userId, `Scheduled Garmin sync failed: ${e.message}`); } catch {}
      }
    }
  } catch (e) {
    logger.warn(`[scheduler] wellness sync failed for user ${userId}: ${e.message}`);
  }
}

// ── Push reminders (water, meal, weigh-in) ──────────────────────────────────

async function _pushReminders(userId) {
  const pushService = _getUserSetting(userId, 'notifPushService');
  if (!pushService || pushService === 'none') return;

  const { pushNotify } = await import('./push-notify.js');
  const local = _getUserLocalTime(userId);
  const currentMin = local.hour * 60 + local.minute;

  // Water reminders — skip if already hit water goal today
  if (_isEnabled(userId, 'notifWaterReminders')) {
    const interval = _getUserSetting(userId, 'notifWaterInterval') || 120;
    const startMin = 8 * 60, endMin = 22 * 60;
    if (currentMin >= startMin && currentMin < endMin) {
      const minSinceStart = currentMin - startMin;
      if (minSinceStart % interval < 15 && !_ranRecently(userId, `water_${Math.floor(minSinceStart / interval)}`, interval * 60 * 1000)) {
        // Check if water goal already met
        let skipWater = false;
        try {
          const waterGoal = _getUserSetting(userId, 'waterGoalMl') || 0;
          if (waterGoal > 0) {
            const today = local.dateStr;
            const uCond = userId === 0 ? '(user_id IS NULL OR user_id = 0)' : 'user_id = ?';
            const uArgs = userId === 0 ? [today] : [today, userId];
            const row = db.prepare(`SELECT water FROM diary WHERE date = ? AND ${uCond} AND deleted_at IS NULL`).get(...uArgs);
            if (row?.water) {
              const waterTotal = JSON.parse(row.water).reduce((s, l) => s + (l.amount || 0), 0);
              if (waterTotal >= waterGoal) skipWater = true;
            }
          }
        } catch {}
        if (!skipWater) {
          await pushNotify(userId, 'notifWaterReminders', '💧 Hydration Reminder', 'Time to drink some water! Stay hydrated.', 4);
        }
      }
    }
  }

  // Meal reminders — only if that meal slot is empty for today
  if (_isEnabled(userId, 'notifMealReminders')) {
    const times = _getUserSetting(userId, 'notifMealTimes');
    // mealNames is OPTIONAL — if missing/shorter than times, fall back to generic
    // "meal" rather than lying with stale defaults like "Dinner" when the user has
    // restructured their meal slots.
    const mealNames = _getUserSetting(userId, 'mealNames') || [];
   if (times && times.length > 0) {
    const today = local.dateStr;
    // Check diary for today — try user-specific first, then fallback to NULL user_id (single-user mode)
    let diaryItems = [];
    try {
      let row;
      if (userId === 0) {
        row = db.prepare(`SELECT items FROM diary WHERE date = ? AND (user_id IS NULL OR user_id = 0) AND deleted_at IS NULL`).get(today);
      } else {
        row = db.prepare(`SELECT items FROM diary WHERE date = ? AND user_id = ? AND deleted_at IS NULL`).get(today, userId);
        // Fallback: also check NULL user_id rows (diary created before user management was enabled)
        if (!row) row = db.prepare(`SELECT items FROM diary WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL`).get(today);
      }
      if (row?.items) diaryItems = JSON.parse(row.items);
      logger.info(`[scheduler] meal check: user=${userId} date=${today} items=${diaryItems.length} meals=[${diaryItems.map(i => i.meal ?? 0)}] found=${!!row}`);
    } catch (e) { logger.info(`[scheduler] meal diary check error: ${e.message}`); }

    times.forEach((time, i) => {
      const [th, tm] = time.split(':').map(Number);
      const targetMin = th * 60 + tm;
      if (currentMin >= targetMin && currentMin < targetMin + 15 && !_ranRecently(userId, `meal_${i}`)) {
        // Skip if this meal slot already has items logged
        // Check both numeric meal index AND string (some clients may store as string)
        const mealHasItems = diaryItems.some(item => {
          const mealIdx = item.meal != null ? Number(item.meal) : 0;
          return mealIdx === i;
        });
        const mealLabel = mealNames[i] || 'meal';
        logger.info(`[scheduler] meal ${i} (${mealLabel}): hasItems=${mealHasItems}, time=${time}, currentMin=${currentMin}, targetMin=${targetMin}`);
        if (!mealHasItems) {
          pushNotify(userId, 'notifMealReminders', '🍽️ Meal Reminder', `Time to log your ${mealLabel}!`, 4);
        } else {
          logger.info(`[scheduler] skipping meal ${i} reminder — already logged`);
        }
      }
    });
   } // end if (times && times.length > 0)
  }

  // Weigh-in reminder
  if (_isEnabled(userId, 'notifWeighIn')) {
    const time = _getUserSetting(userId, 'notifWeighInTime') || '07:00';
    const [th, tm] = time.split(':').map(Number);
    const targetMin = th * 60 + tm;
    if (currentMin >= targetMin && currentMin < targetMin + 15 && !_ranRecently(userId, 'weighin')) {
      await pushNotify(userId, 'notifWeighIn', '⚖️ Weigh-in Reminder', 'Time to step on the scale!', 4);
    }
  }

  // Weekly summary (Sunday)
  if (_isEnabled(userId, 'notifWeeklySummary') && local.dayOfWeek === 0 && local.hour >= 9 && local.hour < 10 && !_ranRecently(userId, 'weekly', 6 * 24 * 60 * 60 * 1000)) {
    const { sendWeeklySummary } = await import('./push-notify.js');
    await sendWeeklySummary(userId);
  }
}

// ── Main tick — called every 15 minutes ─────────────────────────────────────

async function _tick() {
  try {
    // Get all users (or single user if no user management)
    const users = db.prepare('SELECT id FROM users').all();
    const userIds = users.length ? users.map(u => u.id) : [0];

    for (const userId of userIds) {
      try {
        await _pushReminders(userId);
        await _syncWellness(userId);
      } catch (e) {
        logger.debug(`[scheduler] error for user ${userId}: ${e.message}`);
      }
    }
  } catch (e) {
    logger.debug(`[scheduler] tick error: ${e.message}`);
  }
}

/** Force sync all connected services for a user — bypasses schedule check */
export async function forceSync(userId) {
  logger.info(`[scheduler] forced sync for user ${userId}`);
  const today = new Date().toISOString().slice(0, 10);

  const hasFitbit = db.prepare('SELECT 1 FROM fitbit_tokens WHERE user_id=?').get(userId);
  if (hasFitbit) {
    try {
      const { syncDate } = await import('../routes/fitbit.js');
      logger.info(`[scheduler] forced Fitbit sync for user ${userId}`);
      const { metrics, errors } = await syncDate(userId, today);
      logger.info(`[scheduler] Fitbit sync done: ${Object.keys(metrics || {}).length} metrics`);
    } catch (e) { logger.warn(`[scheduler] Fitbit error: ${e.message}`); }
  }

  const hasWithings = db.prepare('SELECT 1 FROM withings_tokens WHERE user_id=?').get(userId);
  if (hasWithings) {
    try {
      const { syncRange } = await import('../routes/withings.js');
      logger.info(`[scheduler] forced Withings sync for user ${userId}`);
      await syncRange(userId, today, today);
      logger.info(`[scheduler] Withings sync done`);
    } catch (e) { logger.warn(`[scheduler] Withings error: ${e.message}`); }
  }

  const hasGarmin = db.prepare('SELECT 1 FROM garmin_tokens WHERE user_id=?').get(userId);
  if (hasGarmin) {
    try {
      const { syncRange } = await import('../routes/garmin.js');
      logger.info(`[scheduler] forced Garmin sync for user ${userId}`);
      await syncRange(userId, today, today);
      logger.info(`[scheduler] Garmin sync done`);
    } catch (e) { logger.warn(`[scheduler] Garmin error: ${e.message}`); }
  }

  return { fitbit: !!hasFitbit, withings: !!hasWithings, garmin: !!hasGarmin };
}

/** Start the scheduler — call once at server startup */
export function startScheduler() {
  logger.info('[scheduler] started (15-minute interval)');
  // Run first tick after 30 seconds (let server fully boot)
  setTimeout(_tick, 30000);
  // Then every 15 minutes
  setInterval(_tick, 15 * 60 * 1000);
}
