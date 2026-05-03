package com.nutritrace.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;

/**
 * ReminderWorker — periodic background worker that checks the local SQLite
 * database and posts smart notifications without requiring the app to be open.
 *
 * Battery-conscious design:
 *  - Network constraint NONE (local DB only)
 *  - Read-only DB access
 *  - Returns immediately if no relevant time window or already-logged
 *  - Single worker handles water + meal + weigh-in
 *
 * Reads from the same SQLite database the JS app uses
 * (capacitor-community/sqlite stores it as <name>SQLite.db in databases dir).
 */
public class ReminderWorker extends Worker {
    private static final String TAG = "ReminderWorker";
    private static final String DB_FILENAME = "nutritrace_localSQLite.db";
    private static final String CHANNEL_ID = "nutritrace_reminders";

    public ReminderWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            File dbFile = getApplicationContext().getDatabasePath(DB_FILENAME);
            if (!dbFile.exists()) {
                Log.d(TAG, "DB not found at " + dbFile.getAbsolutePath() + " — skipping");
                return Result.success();
            }

            SQLiteDatabase db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            try {
                runChecks(db);
            } finally {
                db.close();
            }
            // Re-evaluate which workers should be enqueued/cancelled so Settings
            // toggles (e.g. enabling Health Connect) take effect within 15 min.
            WorkerScheduler.reschedule(getApplicationContext());
            return Result.success();
        } catch (Exception e) {
            Log.w(TAG, "worker failed: " + e.getMessage());
            return Result.success(); // never retry-spam
        }
    }

    private void runChecks(SQLiteDatabase db) {
        Calendar now = Calendar.getInstance();
        int currentMin = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        String today = String.format(java.util.Locale.US, "%04d-%02d-%02d",
            now.get(Calendar.YEAR), now.get(Calendar.MONTH) + 1, now.get(Calendar.DAY_OF_MONTH));

        // Check meal reminders
        if (getBoolSetting(db, "notifMealReminders")) {
            checkMealReminders(db, currentMin, today);
        }

        // Check water reminders
        if (getBoolSetting(db, "notifWaterReminders")) {
            checkWaterReminders(db, currentMin, today);
        }

        // Check weigh-in reminder
        if (getBoolSetting(db, "notifWeighIn")) {
            checkWeighInReminder(db, currentMin, today);
        }

        // Check bedtime reminder
        if (getBoolSetting(db, "notifBedtime")) {
            checkBedtimeReminder(db, currentMin, today);
        }
    }

    // ── Meal reminders ─────────────────────────────────────────────────────
    private void checkMealReminders(SQLiteDatabase db, int currentMin, String today) {
        JSONArray times = getArraySetting(db, "notifMealTimes");
        if (times == null || times.length() == 0) return; // no times configured → nothing to do
        // mealNames is OPTIONAL — if missing or shorter than times, fall back to a
        // generic "meal" label rather than lying with stale defaults like "Dinner"
        // when the user has restructured their meal slots.
        JSONArray names = getArraySetting(db, "mealNames");

        Set<Integer> loggedSlots = getLoggedMealSlots(db, today);

        for (int i = 0; i < times.length(); i++) {
            try {
                String time = times.getString(i);
                String[] hm = time.split(":");
                int targetMin = Integer.parseInt(hm[0]) * 60 + Integer.parseInt(hm[1]);
                // Within 15-min window of target time?
                if (currentMin < targetMin || currentMin >= targetMin + 15) continue;
                // Already logged?
                if (loggedSlots.contains(i)) {
                    Log.d(TAG, "skipping meal " + i + " — already logged");
                    continue;
                }
                // Use the user's meal name if available at this index, else generic
                String mealName = (names != null && i < names.length()) ? names.getString(i) : "meal";
                postNotification(2000 + i, "🍽️ Meal Reminder",
                    "Time to log your " + mealName + "!");
            } catch (Exception e) {
                Log.w(TAG, "meal " + i + " check failed: " + e.getMessage());
            }
        }
    }

    private Set<Integer> getLoggedMealSlots(SQLiteDatabase db, String today) {
        Set<Integer> slots = new HashSet<>();
        Cursor c = null;
        try {
            c = db.rawQuery(
                "SELECT items FROM diary WHERE date = ? AND deleted_at IS NULL",
                new String[]{today});
            if (c.moveToFirst()) {
                String itemsJson = c.getString(0);
                if (itemsJson != null && !itemsJson.isEmpty()) {
                    JSONArray items = new JSONArray(itemsJson);
                    for (int i = 0; i < items.length(); i++) {
                        JSONObject item = items.getJSONObject(i);
                        slots.add(item.optInt("meal", 0));
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "diary read failed: " + e.getMessage());
        } finally {
            if (c != null) c.close();
        }
        return slots;
    }

    // ── Water reminders ────────────────────────────────────────────────────
    private void checkWaterReminders(SQLiteDatabase db, int currentMin, String today) {
        int interval = (int) getIntSetting(db, "notifWaterInterval", 120);
        int startMin = 8 * 60;  // 08:00
        int endMin = 22 * 60;   // 22:00
        if (currentMin < startMin || currentMin >= endMin) return;

        int minSinceStart = currentMin - startMin;
        // Only fire near interval boundaries (within 15 min window)
        if (minSinceStart % interval >= 15) return;

        // Skip if water goal already met
        long waterGoal = getIntSetting(db, "waterGoalMl", 0);
        if (waterGoal > 0) {
            long waterTotal = getWaterTotal(db, today);
            if (waterTotal >= waterGoal) {
                Log.d(TAG, "skipping water reminder — goal met (" + waterTotal + "/" + waterGoal + ")");
                return;
            }
        }

        // Use intervalIdx as the notification ID so each interval slot fires only once
        int intervalIdx = minSinceStart / interval;
        postNotification(3000 + intervalIdx, "💧 Hydration Reminder",
            "Time to drink some water! Stay hydrated.");
    }

    private long getWaterTotal(SQLiteDatabase db, String today) {
        Cursor c = null;
        long total = 0;
        try {
            c = db.rawQuery(
                "SELECT water FROM diary WHERE date = ? AND deleted_at IS NULL",
                new String[]{today});
            if (c.moveToFirst()) {
                String waterJson = c.getString(0);
                if (waterJson != null && !waterJson.isEmpty()) {
                    JSONArray logs = new JSONArray(waterJson);
                    for (int i = 0; i < logs.length(); i++) {
                        total += logs.getJSONObject(i).optLong("amount", 0);
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "water read failed: " + e.getMessage());
        } finally {
            if (c != null) c.close();
        }
        return total;
    }

    // ── Weigh-in reminder ──────────────────────────────────────────────────
    private void checkWeighInReminder(SQLiteDatabase db, int currentMin, String today) {
        String time = getStringSetting(db, "notifWeighInTime", "07:00");
        try {
            String[] hm = time.split(":");
            int targetMin = Integer.parseInt(hm[0]) * 60 + Integer.parseInt(hm[1]);
            if (currentMin < targetMin || currentMin >= targetMin + 15) return;

            String weighCheck = describeWeightToday(db, today);

            // Self-heal: if a previous tick fired the notification but the weight
            // has since arrived (Withings/HC sync, manual entry), pull it from
            // the tray. This was the original v0.39.27 bug — first tick fires
            // before sync, later tick sees the data but the notification stays.
            if (weighCheck != null) {
                Log.i(TAG, "skipping weigh-in for " + today + " — " + weighCheck);
                cancelNotification(4000);
                return;
            }

            // Once-per-day dedup: avoid the multi-fire pattern that triggers
            // Android's "noisy" mute when WorkManager's 15-min ticks land
            // multiple times inside the reminder window.
            SharedPreferences prefs = getApplicationContext()
                .getSharedPreferences("nt_reminder_state", Context.MODE_PRIVATE);
            if (today.equals(prefs.getString("weighin_fired", null))) {
                Log.d(TAG, "skipping weigh-in for " + today + " — already fired today");
                return;
            }

            // Staleness gate: if the device is server-connected but local sync
            // is stale (> 1 hour), the local DB may not reflect a weight that
            // the server already knows about. Defer to the server scheduler's
            // push reminder. Local-only devices have no last_sync_at row, so
            // this gate doesn't apply to them.
            Long lastSyncMs = readLastSyncMs(db);
            if (lastSyncMs != null && (System.currentTimeMillis() - lastSyncMs) > 60 * 60 * 1000L) {
                Log.i(TAG, "skipping weigh-in for " + today + " — local sync stale; server will fire if needed");
                return;
            }

            Log.i(TAG, "firing weigh-in for " + today + " — no weight found");
            prefs.edit().putString("weighin_fired", today).apply();
            postNotification(4000, "⚖️ Weigh-in Reminder", "Time to step on the scale!");
        } catch (Exception e) {
            Log.w(TAG, "weigh-in check failed: " + e.getMessage());
        }
    }

    /**
     * Read sync_meta.last_sync_at as epoch ms. Returns null if no sync has
     * ever happened (local-only device) or the value can't be parsed.
     */
    private Long readLastSyncMs(SQLiteDatabase db) {
        Cursor c = null;
        try {
            c = db.rawQuery("SELECT value FROM sync_meta WHERE key = 'last_sync_at'", null);
            if (c.moveToFirst()) {
                String ts = c.getString(0);
                if (ts != null && !ts.isEmpty()) {
                    java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat(
                        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
                    sdf.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
                    return sdf.parse(ts).getTime();
                }
            }
        } catch (Exception e) {
            // sync_meta table doesn't exist (very old install) or value malformed
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    /** Cancel a previously-posted notification by ID (best-effort). */
    private void cancelNotification(int id) {
        try {
            NotificationManagerCompat.from(getApplicationContext()).cancel(id);
        } catch (Exception e) {
            Log.w(TAG, "cancelNotification(" + id + ") failed: " + e.getMessage());
        }
    }

    /**
     * Describe where today's weight was found, or null if not found.
     * Checks diary.body_stats.weight then wellness_data.weight_kg.
     */
    private String describeWeightToday(SQLiteDatabase db, String today) {
        // Manual diary entry
        Cursor c = null;
        try {
            c = db.rawQuery(
                "SELECT body_stats FROM diary WHERE date = ? AND deleted_at IS NULL",
                new String[]{today});
            if (c.moveToFirst()) {
                String bsJson = c.getString(0);
                if (bsJson != null && !bsJson.isEmpty()) {
                    JSONObject bs = new JSONObject(bsJson);
                    double w = bs.optDouble("weight", 0);
                    if (w > 0) return "diary.body_stats.weight=" + w;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "body_stats read failed: " + e.getMessage());
        } finally {
            if (c != null) c.close();
        }
        // Synced from scale (Withings, Health Connect, etc.)
        c = null;
        try {
            c = db.rawQuery(
                "SELECT value FROM wellness_data WHERE date = ? AND metric_type = 'weight_kg' AND value > 0 LIMIT 1",
                new String[]{today});
            if (c.moveToFirst()) return "wellness_data.weight_kg=" + c.getDouble(0);
        } catch (Exception e) {
            Log.w(TAG, "wellness_data read failed: " + e.getMessage());
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    // ── Bedtime reminder (+ optional wind-down) ────────────────────────────
    private void checkBedtimeReminder(SQLiteDatabase db, int currentMin, String today) {
        String bedtime = getStringSetting(db, "notifBedtimeTime", "22:30");
        try {
            String[] hm = bedtime.split(":");
            int bedtimeMin = Integer.parseInt(hm[0]) * 60 + Integer.parseInt(hm[1]);
            boolean windDownEnabled = getBoolSetting(db, "notifBedtimeWindDown");
            int windDownMin = (int) getIntSetting(db, "notifBedtimeWindDownMin", 30);
            boolean smart = getBoolSetting(db, "notifBedtimeSmart") || (getRawSetting(db, "notifBedtimeSmart") == null); // default true
            long sleepGoal = 480;
            try {
                String goalsJson = getRawSetting(db, "goals");
                if (goalsJson != null) {
                    JSONObject goals = new JSONObject(goalsJson);
                    JSONObject sg = goals.optJSONObject("sleep_duration_min");
                    if (sg != null) sleepGoal = sg.optLong("min", sg.optLong("max", 480));
                }
            } catch (Exception ignored) {}
            double goalHours = Math.round(sleepGoal / 60.0 * 10) / 10.0;

            // Build message — smart variant reads yesterday's sleep
            String msg = "Aim for " + goalHours + "h tonight — time to wind down.";
            if (smart) {
                String yesterday = yesterdayDateStr(today);
                long lastSleep = getSleepDuration(db, yesterday);
                if (lastSleep > 0) {
                    double lastH = Math.round(lastSleep / 60.0 * 10) / 10.0;
                    if (lastSleep < sleepGoal - 60) {
                        msg = "You slept " + lastH + "h last night — prioritize an earlier bedtime tonight.";
                    } else if (lastSleep >= sleepGoal) {
                        msg = "Great " + lastH + "h last night — keep it up with another " + goalHours + "h tonight.";
                    }
                }
            }

            // Main bedtime reminder
            if (currentMin >= bedtimeMin && currentMin < bedtimeMin + 15) {
                postNotification(5000, "🌙 Bedtime Reminder", msg);
            }

            // Wind-down pre-reminder
            if (windDownEnabled) {
                int windDownTarget = bedtimeMin - windDownMin;
                if (windDownTarget >= 0 && currentMin >= windDownTarget && currentMin < windDownTarget + 15) {
                    postNotification(5001, "🌙 Wind Down",
                        "Bedtime in " + windDownMin + " min — start winding down. " + msg);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "bedtime check failed: " + e.getMessage());
        }
    }

    private String yesterdayDateStr(String today) {
        try {
            java.text.SimpleDateFormat fmt = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US);
            java.util.Date d = fmt.parse(today);
            long ms = d.getTime() - 86400000L;
            return fmt.format(new java.util.Date(ms));
        } catch (Exception e) {
            return today;
        }
    }

    private long getSleepDuration(SQLiteDatabase db, String date) {
        Cursor c = null;
        try {
            c = db.rawQuery(
                "SELECT value FROM wellness_data WHERE date = ? AND metric_type = 'sleep_duration_min' ORDER BY source LIMIT 1",
                new String[]{date});
            if (c.moveToFirst()) return (long) c.getDouble(0);
        } catch (Exception e) {
            Log.w(TAG, "sleep read failed: " + e.getMessage());
        } finally {
            if (c != null) c.close();
        }
        return 0;
    }

    // ── Settings helpers ───────────────────────────────────────────────────
    private String getRawSetting(SQLiteDatabase db, String key) {
        Cursor c = null;
        try {
            c = db.rawQuery("SELECT value FROM user_settings WHERE key = ? LIMIT 1",
                new String[]{key});
            if (c.moveToFirst()) return c.getString(0);
        } catch (Exception e) {
            // table may not exist yet on first launch
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    private boolean getBoolSetting(SQLiteDatabase db, String key) {
        String v = getRawSetting(db, key);
        if (v == null) return false;
        v = v.replace("\"", "").trim();
        return "true".equalsIgnoreCase(v) || "1".equals(v);
    }

    private long getIntSetting(SQLiteDatabase db, String key, long def) {
        String v = getRawSetting(db, key);
        if (v == null) return def;
        try { return Long.parseLong(v.replace("\"", "").trim()); }
        catch (Exception e) { return def; }
    }

    private String getStringSetting(SQLiteDatabase db, String key, String def) {
        String v = getRawSetting(db, key);
        if (v == null) return def;
        return v.replace("\"", "").trim();
    }

    private JSONArray getArraySetting(SQLiteDatabase db, String key) {
        String v = getRawSetting(db, key);
        if (v == null) return null;
        try { return new JSONArray(v); }
        catch (Exception e) { return null; }
    }

    // ── Notification posting ───────────────────────────────────────────────
    private void postNotification(int id, String title, String body) {
        Context ctx = getApplicationContext();
        ensureChannel(ctx);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(ctx).notify(id, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "notify denied: " + e.getMessage());
        }
    }

    private void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "NutriTrace Reminders",
                    NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("Meal, water, and weigh-in reminders");
                nm.createNotificationChannel(channel);
            }
        }
    }
}
