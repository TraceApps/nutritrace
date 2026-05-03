package com.nutritrace.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;

import java.io.File;
import java.util.Calendar;

/**
 * ReminderAlarmScheduler — schedules exact-time alarms for time-specific
 * reminders (meal times, weigh-in, bedtime, wind-down) using AlarmManager.
 *
 * Why AlarmManager and not just WorkManager?
 *   WorkManager guarantees execution within a window — Doze + App Standby
 *   stretch a "15-min" periodic worker to hours when the user hasn't
 *   foregrounded the app recently. AlarmManager.setExactAndAllowWhileIdle
 *   is the only Android primitive that fires at a specific time even under
 *   Doze, which is what users expect from "remind me at 8am."
 *
 * The existing ReminderWorker (15-min periodic) is kept as a safety-net
 * sweep in case an alarm is missed (rare — happens during phone reboot
 * before BootReceiver re-arms, or if exact-alarm permission is revoked).
 *
 * On Android 12+ (S), SCHEDULE_EXACT_ALARM is permission-protected.
 * canScheduleExactAlarms() must return true. If false, we fall back to
 * setAndAllowWhileIdle (inexact under Doze but still runs while idle).
 */
public class ReminderAlarmScheduler {
    private static final String TAG = "ReminderAlarmSched";
    private static final String DB_FILENAME = "nutritrace_localSQLite.db";

    // Stable request codes per reminder type so we can cancel/replace.
    // Keep these distinct from notification IDs in ReminderWorker (2000+/3000+/etc).
    private static final int REQ_MEAL_BASE      = 10000;  // +slotIndex
    private static final int REQ_WEIGH_IN       = 10100;
    private static final int REQ_BEDTIME        = 10200;
    private static final int REQ_WIND_DOWN      = 10201;
    private static final int REQ_WATER          = 10300;

    public static final String EXTRA_TYPE = "reminder_type";
    public static final String EXTRA_SLOT = "slot_index";

    public static final String TYPE_MEAL      = "meal";
    public static final String TYPE_WEIGH_IN  = "weigh_in";
    public static final String TYPE_BEDTIME   = "bedtime";
    public static final String TYPE_WIND_DOWN = "wind_down";
    public static final String TYPE_WATER     = "water";

    /**
     * Schedule alarms for every reminder enabled in user_settings.
     * Idempotent — replaces existing alarms (FLAG_UPDATE_CURRENT).
     * Called from MainActivity startup, BootReceiver, and after a reminder
     * fires (to re-arm tomorrow).
     */
    public static void scheduleAll(Context context) {
        File dbFile = context.getDatabasePath(DB_FILENAME);
        if (!dbFile.exists()) {
            Log.d(TAG, "DB not found — nothing to schedule");
            return;
        }

        SQLiteDatabase db = null;
        try {
            db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);

            // Meal reminders
            if (getBoolSetting(db, "notifMealReminders")) {
                JSONArray times = getArraySetting(db, "notifMealTimes");
                if (times != null) {
                    for (int i = 0; i < times.length(); i++) {
                        try {
                            scheduleMealAlarm(context, i, times.getString(i));
                        } catch (Exception e) {
                            Log.w(TAG, "meal " + i + " schedule failed: " + e.getMessage());
                        }
                    }
                }
            } else {
                cancelMealAlarms(context);
            }

            // Weigh-in
            if (getBoolSetting(db, "notifWeighIn")) {
                String time = getStringSetting(db, "notifWeighInTime", "07:00");
                scheduleAlarm(context, REQ_WEIGH_IN, TYPE_WEIGH_IN, -1, parseTimeToTodayCal(time));
            } else {
                cancelAlarm(context, REQ_WEIGH_IN, TYPE_WEIGH_IN);
            }

            // Bedtime + optional wind-down
            if (getBoolSetting(db, "notifBedtime")) {
                String bedtime = getStringSetting(db, "notifBedtimeTime", "22:30");
                Calendar bedCal = parseTimeToTodayCal(bedtime);
                scheduleAlarm(context, REQ_BEDTIME, TYPE_BEDTIME, -1, bedCal);

                if (getBoolSetting(db, "notifBedtimeWindDown")) {
                    int windMin = (int) getIntSetting(db, "notifBedtimeWindDownMin", 30);
                    Calendar windCal = (Calendar) bedCal.clone();
                    windCal.add(Calendar.MINUTE, -windMin);
                    if (windCal.before(Calendar.getInstance())) windCal.add(Calendar.DAY_OF_YEAR, 1);
                    scheduleAlarm(context, REQ_WIND_DOWN, TYPE_WIND_DOWN, -1, windCal);
                } else {
                    cancelAlarm(context, REQ_WIND_DOWN, TYPE_WIND_DOWN);
                }
            } else {
                cancelAlarm(context, REQ_BEDTIME, TYPE_BEDTIME);
                cancelAlarm(context, REQ_WIND_DOWN, TYPE_WIND_DOWN);
            }

            // Water reminders — interval-based (next interval boundary)
            if (getBoolSetting(db, "notifWaterReminders")) {
                int interval = (int) getIntSetting(db, "notifWaterInterval", 120);
                scheduleNextWaterAlarm(context, interval);
            } else {
                cancelAlarm(context, REQ_WATER, TYPE_WATER);
            }
        } catch (Exception e) {
            Log.w(TAG, "scheduleAll failed: " + e.getMessage());
        } finally {
            if (db != null) db.close();
        }
    }

    /** Re-arm tomorrow's alarm for a fired reminder type. Called from receiver. */
    public static void rescheduleTomorrow(Context context, String type, int slot) {
        File dbFile = context.getDatabasePath(DB_FILENAME);
        if (!dbFile.exists()) return;
        SQLiteDatabase db = null;
        try {
            db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);

            switch (type) {
                case TYPE_MEAL: {
                    JSONArray times = getArraySetting(db, "notifMealTimes");
                    if (times != null && slot >= 0 && slot < times.length()) {
                        Calendar cal = parseTimeToTodayCal(times.getString(slot));
                        cal.add(Calendar.DAY_OF_YEAR, 1);
                        scheduleAlarm(context, REQ_MEAL_BASE + slot, TYPE_MEAL, slot, cal);
                    }
                    break;
                }
                case TYPE_WEIGH_IN: {
                    String time = getStringSetting(db, "notifWeighInTime", "07:00");
                    Calendar cal = parseTimeToTodayCal(time);
                    cal.add(Calendar.DAY_OF_YEAR, 1);
                    scheduleAlarm(context, REQ_WEIGH_IN, TYPE_WEIGH_IN, -1, cal);
                    break;
                }
                case TYPE_BEDTIME: {
                    String bedtime = getStringSetting(db, "notifBedtimeTime", "22:30");
                    Calendar cal = parseTimeToTodayCal(bedtime);
                    cal.add(Calendar.DAY_OF_YEAR, 1);
                    scheduleAlarm(context, REQ_BEDTIME, TYPE_BEDTIME, -1, cal);
                    break;
                }
                case TYPE_WIND_DOWN: {
                    String bedtime = getStringSetting(db, "notifBedtimeTime", "22:30");
                    int windMin = (int) getIntSetting(db, "notifBedtimeWindDownMin", 30);
                    Calendar cal = parseTimeToTodayCal(bedtime);
                    cal.add(Calendar.MINUTE, -windMin);
                    cal.add(Calendar.DAY_OF_YEAR, 1);
                    scheduleAlarm(context, REQ_WIND_DOWN, TYPE_WIND_DOWN, -1, cal);
                    break;
                }
                case TYPE_WATER: {
                    int interval = (int) getIntSetting(db, "notifWaterInterval", 120);
                    scheduleNextWaterAlarm(context, interval);
                    break;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "rescheduleTomorrow failed: " + e.getMessage());
        } finally {
            if (db != null) db.close();
        }
    }

    private static void scheduleMealAlarm(Context context, int slotIndex, String time) {
        Calendar cal = parseTimeToTodayCal(time);
        scheduleAlarm(context, REQ_MEAL_BASE + slotIndex, TYPE_MEAL, slotIndex, cal);
    }

    private static void scheduleNextWaterAlarm(Context context, int intervalMin) {
        // Find next interval boundary between 08:00 and 22:00 today (or
        // tomorrow's 08:00 if past 22:00).
        Calendar now = Calendar.getInstance();
        int currentMin = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        int startMin = 8 * 60;
        int endMin = 22 * 60;

        Calendar target = (Calendar) now.clone();
        target.set(Calendar.SECOND, 0);
        target.set(Calendar.MILLISECOND, 0);

        if (currentMin < startMin) {
            target.set(Calendar.HOUR_OF_DAY, 8);
            target.set(Calendar.MINUTE, 0);
        } else if (currentMin >= endMin) {
            target.add(Calendar.DAY_OF_YEAR, 1);
            target.set(Calendar.HOUR_OF_DAY, 8);
            target.set(Calendar.MINUTE, 0);
        } else {
            int sinceStart = currentMin - startMin;
            int nextSlot = ((sinceStart / intervalMin) + 1) * intervalMin;
            int targetMin = startMin + nextSlot;
            if (targetMin >= endMin) {
                target.add(Calendar.DAY_OF_YEAR, 1);
                target.set(Calendar.HOUR_OF_DAY, 8);
                target.set(Calendar.MINUTE, 0);
            } else {
                target.set(Calendar.HOUR_OF_DAY, targetMin / 60);
                target.set(Calendar.MINUTE, targetMin % 60);
            }
        }

        scheduleAlarm(context, REQ_WATER, TYPE_WATER, -1, target);
    }

    private static void scheduleAlarm(Context context, int requestCode, String type, int slot, Calendar when) {
        // If "today's" target time has already passed, push to tomorrow so
        // we never schedule alarms in the past.
        if (when.before(Calendar.getInstance())) {
            when.add(Calendar.DAY_OF_YEAR, 1);
        }

        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            Log.w(TAG, "AlarmManager unavailable");
            return;
        }

        Intent intent = new Intent(context, ReminderAlarmReceiver.class);
        intent.setAction("com.nutritrace.app.REMINDER_FIRE." + requestCode);
        intent.putExtra(EXTRA_TYPE, type);
        intent.putExtra(EXTRA_SLOT, slot);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent pi = PendingIntent.getBroadcast(context, requestCode, intent, flags);

        long triggerMs = when.getTimeInMillis();

        // Android 12+ requires SCHEDULE_EXACT_ALARM permission for
        // setExactAndAllowWhileIdle. Fall back to setAndAllowWhileIdle if denied.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
                Log.d(TAG, "scheduled EXACT " + type + (slot >= 0 ? "[" + slot + "]" : "") + " at " + when.getTime());
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
                Log.w(TAG, "exact alarm denied — using inexact " + type + " at " + when.getTime());
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
            Log.d(TAG, "scheduled EXACT " + type + " at " + when.getTime());
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, triggerMs, pi);
            Log.d(TAG, "scheduled exact (legacy) " + type + " at " + when.getTime());
        }
    }

    private static void cancelAlarm(Context context, int requestCode, String type) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent intent = new Intent(context, ReminderAlarmReceiver.class);
        intent.setAction("com.nutritrace.app.REMINDER_FIRE." + requestCode);
        int flags = PendingIntent.FLAG_NO_CREATE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(context, requestCode, intent, flags);
        if (pi != null) {
            am.cancel(pi);
            pi.cancel();
            Log.d(TAG, "cancelled " + type);
        }
    }

    /** Cancel up to 16 meal-slot alarms — covers any reasonable slot count. */
    private static void cancelMealAlarms(Context context) {
        for (int i = 0; i < 16; i++) cancelAlarm(context, REQ_MEAL_BASE + i, TYPE_MEAL + "[" + i + "]");
    }

    private static Calendar parseTimeToTodayCal(String hhmm) {
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        try {
            String[] parts = hhmm.split(":");
            cal.set(Calendar.HOUR_OF_DAY, Integer.parseInt(parts[0]));
            cal.set(Calendar.MINUTE, Integer.parseInt(parts[1]));
        } catch (Exception e) {
            cal.set(Calendar.HOUR_OF_DAY, 8);
            cal.set(Calendar.MINUTE, 0);
        }
        return cal;
    }

    // ── Settings helpers (mirror ReminderWorker's read pattern) ─────────────

    private static String getRawSetting(SQLiteDatabase db, String key) {
        Cursor c = null;
        try {
            c = db.rawQuery("SELECT value FROM user_settings WHERE key = ? LIMIT 1",
                new String[]{key});
            if (c.moveToFirst()) return c.getString(0);
        } catch (Exception e) {
            // table may not exist yet
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    private static boolean getBoolSetting(SQLiteDatabase db, String key) {
        String v = getRawSetting(db, key);
        if (v == null) return false;
        v = v.replace("\"", "").trim();
        return "true".equalsIgnoreCase(v) || "1".equals(v);
    }

    private static long getIntSetting(SQLiteDatabase db, String key, long def) {
        String v = getRawSetting(db, key);
        if (v == null) return def;
        try { return Long.parseLong(v.replace("\"", "").trim()); }
        catch (Exception e) { return def; }
    }

    private static String getStringSetting(SQLiteDatabase db, String key, String def) {
        String v = getRawSetting(db, key);
        if (v == null) return def;
        return v.replace("\"", "").trim();
    }

    private static JSONArray getArraySetting(SQLiteDatabase db, String key) {
        String v = getRawSetting(db, key);
        if (v == null) return null;
        try { return new JSONArray(v); }
        catch (Exception e) { return null; }
    }
}
