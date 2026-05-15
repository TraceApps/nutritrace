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

function _getUserSetting(userId, key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

// Persistent dedup — survives server restarts (stored in app_config)
const _dedupCache = {}; // in-memory cache to avoid DB reads on every tick
function _ranRecently(userId, task, windowMs = 14 * 60 * 1000) {
  const key = `_sched_${userId}_${task}`;
  // Check in-memory cache first
  if (_dedupCache[key] && Date.now() - _dedupCache[key] < windowMs) {
    logger.debug(`[scheduler] dedup HIT (memory) for ${key}, last=${new Date(_dedupCache[key]).toISOString()}`);
    return true;
  }
  // Check DB (cold start after restart)
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  const last = row?.value ? parseInt(row.value) : 0;
  if (last && Date.now() - last < windowMs) {
    logger.debug(`[scheduler] dedup HIT (db) for ${key}, last=${new Date(last).toISOString()}, age=${Math.round((Date.now()-last)/60000)}min`);
    _dedupCache[key] = last;
    return true;
  }
  // Not recent — mark as run
  const now = Date.now();
  _dedupCache[key] = now;
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(now));
  logger.info(`[scheduler] dedup MISS for ${key}, marking run at ${new Date(now).toISOString()}${last ? ', prev=' + new Date(last).toISOString() + ' age=' + Math.round((now-last)/3600000) + 'h' : ' (first run)'}`);
  return false;
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


// ── Scheduled wellness sync (per-device) ────────────────────────────────────

/** Check if a device should sync now based on its per-device settings */
function _shouldDeviceSync(userId, deviceKey, local) {
  const mode = _getUserSetting(userId, `${deviceKey}SyncMode`);
  if (mode !== 'scheduled') return false;

  const winStart = _getUserSetting(userId, `${deviceKey}SyncWindowStart`);
  const winEnd   = _getUserSetting(userId, `${deviceKey}SyncWindowEnd`);
  const interval = _getUserSetting(userId, `${deviceKey}SyncInterval`) ?? 1440;
  const curMin   = local.hour * 60 + local.minute;

  // Daily "Sync At" mode: windowStart set, windowEnd null → sync at a specific time
  if (interval >= 1440 && winStart && !winEnd) {
    const [sh, sm] = winStart.split(':').map(Number);
    const targetMin = sh * 60 + sm;
    const diff = curMin - targetMin;
    return diff >= 0 && diff < 15; // within 15-min window of target time
  }

  // Active window check — skip if outside the configured hours
  if (winStart && winEnd) {
    const [sh, sm] = winStart.split(':').map(Number);
    const [eh, em] = winEnd.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin   = eh * 60 + em;
    // Handle overnight windows (e.g., 22:00–06:00)
    if (startMin < endMin) {
      if (curMin < startMin || curMin >= endMin) return false;
    } else {
      if (curMin < startMin && curMin >= endMin) return false;
    }
  }

  // Interval-based: the dedup window handles timing — if we're in the active window
  // and haven't synced within the interval, sync now.
  return true;
}

/** Dedup window = device's sync interval (in ms). Falls back to legacy schedule or 24h. */
function _dedupWindow(userId, deviceKey) {
  // Per-device interval in minutes
  const interval = _getUserSetting(userId, `${deviceKey}SyncInterval`);
  if (interval && interval > 0) return (interval - 5) * 60 * 1000; // subtract 5min buffer

  // Legacy fallback
  const schedule = _getUserSetting(userId, 'wellnessSyncSchedule') ?? 'daily';
  if (schedule === 'every6h')  return 5   * 60 * 60 * 1000;
  if (schedule === 'every12h') return 11  * 60 * 60 * 1000;
  return 23 * 60 * 60 * 1000;
}

async function _syncWellness(userId) {
  const local = _getUserLocalTime(userId);
  const today = local.dateStr;

  /** Compute the sync "from" date using the user's configured sync range for a device */
  function _fromDate(deviceKey) {
    const range = _getUserSetting(userId, `${deviceKey}SyncRange`) ?? _getUserSetting(userId, 'wellnessSyncRange') ?? 7;
    const d = new Date(); d.setDate(d.getDate() - (range - 1));
    return d.toISOString().slice(0, 10);
  }

  // Fitbit — prefer the new Google Health pipe if the user has those tokens.
  // Falls back to the legacy fitbit.js path for users who haven't re-linked
  // yet. Both modules export the same syncDate/syncWorkouts signatures so
  // the rest of this block is unchanged.
  const hasGoogleHealth = db.prepare('SELECT 1 FROM google_health_tokens WHERE user_id=?').get(userId);
  const hasLegacyFitbit = db.prepare('SELECT 1 FROM fitbit_tokens WHERE user_id=?').get(userId);
  const hasFitbit = hasGoogleHealth || hasLegacyFitbit;
  const fitbitModulePath = hasGoogleHealth ? '../routes/google-health.js' : '../routes/fitbit.js';
  if (hasFitbit && _shouldDeviceSync(userId, 'fitbit', local)
      && !_ranRecently(userId, 'fitbit_sync', _dedupWindow(userId, 'fitbit'))) {
    const from = _fromDate('wellness'); // Fitbit uses shared wellnessSyncRange
    try {
      const { syncDate, syncWorkouts } = await import(fitbitModulePath);
      logger.info(`[scheduler] Fitbit sync for user ${userId}: ${from} → ${today}`);
      const start = new Date(from + 'T12:00:00');
      const end   = new Date(today + 'T12:00:00');
      let totalMetrics = 0, totalErrors = 0;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        try {
          const { metrics, errors } = await syncDate(userId, dateStr);
          totalMetrics += Object.keys(metrics || {}).length;
          totalErrors += (errors?.length || 0);
        } catch (e) {
          if (e.message?.includes('429')) { logger.warn(`[scheduler] Fitbit rate limited at ${dateStr}`); break; }
          totalErrors++;
        }
        if (d < end) await new Promise(r => setTimeout(r, 250));
      }
      logger.info(`[scheduler] Fitbit sync done: ${totalMetrics} metrics across ${from}→${today}, ${totalErrors} errors`);
      if (_getUserSetting(userId, 'workoutsEnabled')) {
        try {
          const wResult = await syncWorkouts(userId, from, today);
          logger.info(`[scheduler] Fitbit workouts synced: ${wResult?.synced || 0}`);
        } catch (we) {
          logger.debug(`[scheduler] Fitbit workout sync skipped: ${we.message}`);
        }
      }
    } catch (e) {
      logger.warn(`[scheduler] Fitbit sync error for user ${userId}: ${e.message}`);
      try { const { alertSyncFailure } = await import('./push-notify.js'); alertSyncFailure(userId, `Scheduled Fitbit sync failed: ${e.message}`); } catch {}
    }
  }

  // Withings
  const hasWithings = db.prepare('SELECT 1 FROM withings_tokens WHERE user_id=?').get(userId);
  if (hasWithings && _shouldDeviceSync(userId, 'withings', local)
      && !_ranRecently(userId, 'withings_sync', _dedupWindow(userId, 'withings'))) {
    const from = _fromDate('withings');
    try {
      const { syncRange } = await import('../routes/withings.js');
      logger.info(`[scheduler] Withings sync for user ${userId}: ${from} → ${today}`);
      const result = await syncRange(userId, from, today);
      logger.info(`[scheduler] Withings sync done: ${result?.dates || 0} dates`);
    } catch (e) {
      logger.warn(`[scheduler] Withings sync error for user ${userId}: ${e.message}`);
      try { const { alertSyncFailure } = await import('./push-notify.js'); alertSyncFailure(userId, `Scheduled Withings sync failed: ${e.message}`); } catch {}
    }
  }

  // Garmin
  const hasGarmin = db.prepare('SELECT 1 FROM garmin_tokens WHERE user_id=?').get(userId);
  if (hasGarmin && _shouldDeviceSync(userId, 'garmin', local)
      && !_ranRecently(userId, 'garmin_sync', _dedupWindow(userId, 'garmin'))) {
    const from = _fromDate('garmin');
    try {
      const { syncRange } = await import('../routes/garmin.js');
      logger.info(`[scheduler] Garmin sync for user ${userId}: ${from} → ${today}`);
      const result = await syncRange(userId, from, today);
      logger.info(`[scheduler] Garmin sync done: ${result?.synced || 0} synced`);
    } catch (e) {
      logger.warn(`[scheduler] Garmin sync error for user ${userId}: ${e.message}`);
      try { const { alertSyncFailure } = await import('./push-notify.js'); alertSyncFailure(userId, `Scheduled Garmin sync failed: ${e.message}`); } catch {}
    }
  }

  // ── Post-sync: goal + wellness alert checks (device-agnostic) ──────────
  // Read today's merged data from ALL sources and fire alerts/celebrations once.
  try {
    const todayMetrics = {};
    const rows = db.prepare(
      `SELECT metric_type, value FROM wellness_data WHERE user_id = ? AND date = ? ORDER BY source`
    ).all(userId, today);
    for (const r of rows) todayMetrics[r.metric_type] = r.value; // last source wins

    // Step goal
    if (todayMetrics.steps) {
      const goalRow = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(userId, 'goals');
      if (goalRow?.value) {
        try {
          const goals = JSON.parse(goalRow.value);
          const stepGoal = goals.steps?.min || goals.steps?.max;
          if (stepGoal) {
            const { notifyStepGoal } = await import('./push-notify.js');
            notifyStepGoal(userId, todayMetrics.steps, stepGoal);
          }
        } catch {}
      }
    }

    // Wellness alerts (HRV drop, sleep decline, RHR spike)
    if (todayMetrics.hrv_daily_rmssd || todayMetrics.sleep_score || todayMetrics.resting_hr) {
      try {
        const { _checkWellnessAlerts } = await import('../routes/fitbit.js');
        if (_checkWellnessAlerts) await _checkWellnessAlerts(userId, todayMetrics);
      } catch {}
    }
  } catch (e) {
    logger.debug(`[scheduler] post-sync alert check failed: ${e.message}`);
  }
}

// ── Push reminders (water, meal, weigh-in) ──────────────────────────────────

// ── Fasting recurring schedule ───────────────────────────────────────────
// Mirror of the client-side checkScheduleAndStart in stores/fasting.js so
// connected users get auto-started fasts even if the app is closed.
// Idempotency comes from the user_settings.fastingScheduleLastFired key
// (YYYY-MM-DD); we update it after a successful start.
function _setUserSetting(userId, key, value) {
  if (userId == null) return;
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(userId, key, JSON.stringify(value));
}

function _checkFastingSchedule(userId) {
  if (userId == null || userId === 0) return; // skip single-user mode
  try {
    if (_getUserSetting(userId, 'fastingEnabled') !== true) return;
    if (_getUserSetting(userId, 'fastingScheduleEnabled') !== true) return;
    const todayStr = new Date().toISOString().slice(0, 10);
    if (_getUserSetting(userId, 'fastingScheduleLastFired') === todayStr) return;
    const days = _getUserSetting(userId, 'fastingScheduleDays') || [0,1,2,3,4,5,6];
    const dow = new Date().getDay();
    if (!Array.isArray(days) || !days.includes(dow)) return;
    const time = _getUserSetting(userId, 'fastingScheduleTime') || '20:00';
    const [hh, mm] = String(time).split(':').map(n => parseInt(n) || 0);
    const scheduled = new Date(); scheduled.setHours(hh, mm, 0, 0);
    if (Date.now() < scheduled.getTime()) return;
    // 4-hour grace window — if user opens late we don't backdate a fast
    if (Date.now() - scheduled.getTime() > 4 * 3600 * 1000) {
      _setUserSetting(userId, 'fastingScheduleLastFired', todayStr);
      return;
    }
    // Block double-start
    const active = db.prepare(
      `SELECT id FROM fasts WHERE user_id = ? AND end_at IS NULL AND deleted_at IS NULL LIMIT 1`
    ).get(userId);
    if (active) return;
    const goal = Number(_getUserSetting(userId, 'fastingScheduleGoal')) || 16;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO fasts (user_id, start_at, goal_hours) VALUES (?, ?, ?)`)
      .run(userId, now, goal);
    _setUserSetting(userId, 'fastingScheduleLastFired', todayStr);
    logger.info(`[scheduler] auto-started ${goal}h fast for user ${userId} (schedule)`);
  } catch (e) {
    logger.debug(`[scheduler] fasting schedule check error for ${userId}: ${e.message}`);
  }
}

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
            let row = db.prepare(`SELECT water FROM diary WHERE date = ? AND ${uCond} AND deleted_at IS NULL`).get(...uArgs);
            // Multi-user fallback: also check NULL user_id (pre-auth diary rows)
            if (!row && userId !== 0) {
              row = db.prepare(`SELECT water FROM diary WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL`).get(today);
            }
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

  // Weigh-in reminder — skip if already weighed in today (diary.body_stats OR wellness_data)
  if (_isEnabled(userId, 'notifWeighIn')) {
    const time = _getUserSetting(userId, 'notifWeighInTime') || '07:00';
    const [th, tm] = time.split(':').map(Number);
    const targetMin = th * 60 + tm;
    if (currentMin >= targetMin && currentMin < targetMin + 15 && !_ranRecently(userId, 'weighin')) {
      // Check if weight already logged today (either manual diary entry or synced from scale)
      const today = local.dateStr;
      let alreadyWeighed = false;
      let checkInfo = 'no match';
      try {
        // Manual diary entry — handle user_id match + NULL fallback (pre-auth rows)
        const uCond = userId === 0 ? '(user_id IS NULL OR user_id = 0)' : 'user_id = ?';
        const uArgs = userId === 0 ? [today] : [today, userId];
        let diaryRow = db.prepare(`SELECT body_stats FROM diary WHERE date = ? AND ${uCond} AND deleted_at IS NULL`).get(...uArgs);
        if (!diaryRow && userId !== 0) {
          diaryRow = db.prepare(`SELECT body_stats FROM diary WHERE date = ? AND user_id IS NULL AND deleted_at IS NULL`).get(today);
        }
        if (diaryRow?.body_stats) {
          const bs = JSON.parse(diaryRow.body_stats);
          if (bs.weight != null && bs.weight > 0) { alreadyWeighed = true; checkInfo = `diary.body_stats.weight=${bs.weight}`; }
        }
        // Synced from scale (Withings, Health Connect, etc.) — same user_id handling as diary
        if (!alreadyWeighed) {
          let wRow = db.prepare(`SELECT value FROM wellness_data WHERE date = ? AND ${uCond} AND metric_type = 'weight_kg' AND value > 0 LIMIT 1`).get(...uArgs);
          if (!wRow && userId !== 0) {
            wRow = db.prepare(`SELECT value FROM wellness_data WHERE date = ? AND user_id IS NULL AND metric_type = 'weight_kg' AND value > 0 LIMIT 1`).get(today);
          }
          if (wRow) { alreadyWeighed = true; checkInfo = `wellness_data.weight_kg=${wRow.value}`; }
        }
      } catch (e) { logger.debug(`[scheduler] weigh-in check error: ${e.message}`); }

      if (alreadyWeighed) {
        logger.info(`[scheduler] skipping weigh-in reminder for user=${userId} date=${today} — ${checkInfo}`);
      } else {
        logger.info(`[scheduler] firing weigh-in reminder for user=${userId} date=${today} — no weight found`);
        await pushNotify(userId, 'notifWeighIn', '⚖️ Weigh-in Reminder', 'Time to step on the scale!', 4);
      }
    }
  }

  // Bedtime reminder (+ optional wind-down pre-reminder)
  if (_isEnabled(userId, 'notifBedtime')) {
    const bedtime = _getUserSetting(userId, 'notifBedtimeTime') || '22:30';
    const [bh, bm] = bedtime.split(':').map(Number);
    const bedtimeMin = bh * 60 + bm;
    const windDownEnabled = _isEnabled(userId, 'notifBedtimeWindDown');
    const windDownMin = _getUserSetting(userId, 'notifBedtimeWindDownMin') || 30;
    const smart = _getUserSetting(userId, 'notifBedtimeSmart') !== false;
    const sleepGoalMinutes = (() => {
      const goalRow = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(userId, 'goals');
      if (goalRow?.value) {
        try {
          const g = JSON.parse(goalRow.value);
          return g.sleep_duration_min?.min || g.sleep_duration_min?.max || 480;
        } catch { return 480; }
      }
      return 480;
    })();
    const goalHours = Math.round(sleepGoalMinutes / 60 * 10) / 10;

    // Build the reminder message (smart variant looks at last night's sleep)
    let msg = `Aim for ${goalHours}h tonight — time to wind down.`;
    if (smart) {
      try {
        const yesterday = (() => {
          const d = new Date(local.dateStr + 'T12:00:00');
          d.setDate(d.getDate() - 1);
          return d.toISOString().slice(0, 10);
        })();
        const row = db.prepare(
          `SELECT value FROM wellness_data WHERE user_id=? AND date=? AND metric_type='sleep_duration_min' ORDER BY source LIMIT 1`
        ).get(userId, yesterday);
        if (row?.value) {
          const lastH = Math.round(row.value / 60 * 10) / 10;
          if (row.value < sleepGoalMinutes - 60) {
            msg = `You slept ${lastH}h last night — prioritize an earlier bedtime tonight.`;
          } else if (row.value >= sleepGoalMinutes) {
            msg = `Great ${lastH}h last night — keep it up with another ${goalHours}h tonight.`;
          }
        }
      } catch {}
    }

    // Main bedtime reminder
    if (currentMin >= bedtimeMin && currentMin < bedtimeMin + 15 && !_ranRecently(userId, 'bedtime')) {
      await pushNotify(userId, 'notifBedtime', '🌙 Bedtime Reminder', msg, 4);
    }

    // Wind-down pre-reminder
    if (windDownEnabled) {
      const windDownTarget = bedtimeMin - windDownMin;
      if (windDownTarget >= 0 && currentMin >= windDownTarget && currentMin < windDownTarget + 15
          && !_ranRecently(userId, 'bedtime_winddown')) {
        await pushNotify(userId, 'notifBedtime', '🌙 Wind Down',
          `Bedtime in ${windDownMin} min — start winding down. ${msg}`, 4);
      }
    }
  }

  // Weekly summary — user-configurable day + time
  // Dedup check is AFTER the day/hour gate so the timestamp only burns when we actually send
  if (_isEnabled(userId, 'notifWeeklySummary')) {
    const summaryDay  = _getUserSetting(userId, 'weeklySummaryDay')  ?? 0;    // 0=Sun default
    const summaryTime = _getUserSetting(userId, 'weeklySummaryTime') ?? '09:00';
    const [targetHour] = summaryTime.split(':').map(Number);
    logger.debug(`[scheduler] weekly check: user=${userId} dow=${local.dayOfWeek} target=${summaryDay} hour=${local.hour} targetHour=${targetHour}`);
    if (local.dayOfWeek === summaryDay && local.hour >= targetHour && local.hour < targetHour + 1
        && !_ranRecently(userId, 'weekly', 6 * 24 * 60 * 60 * 1000)) {
      logger.info(`[scheduler] SENDING weekly summary for user ${userId}`);
      // Push notification
      const { sendWeeklySummary } = await import('./push-notify.js');
      await sendWeeklySummary(userId);
      // Email digest (if SMTP configured + user has an email on file)
      try {
        const { sendWeeklySummaryEmail } = await import('../email.js');
        const origin = db.prepare(`SELECT value FROM app_config WHERE key='app_url'`).get()?.value
          || 'http://localhost:3001';
        await sendWeeklySummaryEmail(userId, origin);
      } catch (e) {
        logger.debug(`[scheduler] weekly email skipped for user ${userId}: ${e.message}`);
      }
    }
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
        _checkFastingSchedule(userId);
      } catch (e) {
        logger.debug(`[scheduler] error for user ${userId}: ${e.message}`);
      }
    }

    // Housekeeping — remove invite tokens that are past their expiry. The
    // GET /api/auth/invites endpoint already filters them out of the list,
    // but rows sit in the table indefinitely otherwise. Cheap to clean up
    // here every 15 minutes.
    try {
      const r = db.prepare(`DELETE FROM invite_tokens WHERE expires_at <= datetime('now') OR used = 1`).run();
      if (r.changes > 0) logger.debug(`[scheduler] purged ${r.changes} expired/used invite tokens`);
    } catch (e) {
      logger.debug(`[scheduler] invite cleanup error: ${e.message}`);
    }
  } catch (e) {
    logger.debug(`[scheduler] tick error: ${e.message}`);
  }
}

/** Force sync all connected services for a user — bypasses schedule check */
export async function forceSync(userId) {
  logger.info(`[scheduler] forced sync for user ${userId}`);
  const today = new Date().toISOString().slice(0, 10);

  // Same dispatch logic as the periodic tick above: prefer the new Google
  // Health pipe when the user has those tokens, fall back to legacy fitbit.
  const hasGH = db.prepare('SELECT 1 FROM google_health_tokens WHERE user_id=?').get(userId);
  const hasLegFitbit = db.prepare('SELECT 1 FROM fitbit_tokens WHERE user_id=?').get(userId);
  const hasFitbit = hasGH || hasLegFitbit;
  if (hasFitbit) {
    try {
      const modulePath = hasGH ? '../routes/google-health.js' : '../routes/fitbit.js';
      const { syncDate } = await import(modulePath);
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
