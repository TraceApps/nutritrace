package com.nutritrace.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.io.File;
import java.util.concurrent.TimeUnit;

/**
 * Centralized worker scheduling. Reads SQLite settings to decide which
 * workers should be enqueued and which should be cancelled. Called from
 * MainActivity on app start, and from ReminderWorker on every 15-min tick
 * so toggles in Settings take effect within 15 minutes without a reopen.
 */
public class WorkerScheduler {
    private static final String TAG = "WorkerScheduler";
    private static final String DB_FILENAME = "nutritrace_localSQLite.db";
    public static final String REMINDER_WORK = "nutritrace_reminders";
    public static final String HC_SYNC_WORK = "nutritrace_hc_sync";

    public static void reschedule(Context context) {
        // Reminder worker — always enqueued as a 15-min safety-net sweep.
        // The PRIMARY firing mechanism is now AlarmManager (see
        // ReminderAlarmScheduler) because WorkManager periodics get
        // throttled by Doze when the app hasn't been foregrounded recently.
        // Worker is the backup that catches missed alarms (e.g. between a
        // reboot and the first BootReceiver tick).
        enqueueReminderWorker(context);

        // Exact-time alarms — primary firing path for time-specific reminders.
        try {
            ReminderAlarmScheduler.scheduleAll(context);
        } catch (Exception e) {
            Log.w(TAG, "alarm reschedule failed: " + e.getMessage());
        }

        // HC sync worker — only enqueued when healthConnectEnabled = true
        boolean hcEnabled = readBoolSetting(context, "healthConnectEnabled");
        if (hcEnabled) {
            enqueueHcWorker(context);
        } else {
            WorkManager.getInstance(context).cancelUniqueWork(HC_SYNC_WORK);
            Log.d(TAG, "HC sync worker cancelled (disabled)");
        }
    }

    private static void enqueueReminderWorker(Context context) {
        // No setRequiresBatteryNotLow — reminders are lightweight and should
        // fire regardless of battery level. The previous constraint silently
        // suppressed every reminder when the user dropped below 15%.
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.NOT_REQUIRED)
            .build();

        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                ReminderWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build();

        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(
                REMINDER_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                request);
    }

    private static void enqueueHcWorker(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.NOT_REQUIRED)
            .setRequiresBatteryNotLow(true)
            .build();

        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                HealthConnectSyncWorker.class, 1, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build();

        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(
                HC_SYNC_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                request);
        Log.d(TAG, "HC sync worker enqueued (1h interval)");
    }

    /** Read a boolean setting from the JS app's SQLite user_settings table */
    private static boolean readBoolSetting(Context context, String key) {
        File dbFile = context.getDatabasePath(DB_FILENAME);
        if (!dbFile.exists()) return false;
        SQLiteDatabase db = null;
        Cursor c = null;
        try {
            db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            c = db.rawQuery(
                "SELECT value FROM user_settings WHERE key = ? LIMIT 1",
                new String[]{key});
            if (c.moveToFirst()) {
                String v = c.getString(0);
                if (v == null) return false;
                v = v.replace("\"", "").trim();
                return "true".equalsIgnoreCase(v) || "1".equals(v);
            }
        } catch (Exception e) {
            Log.w(TAG, "setting read failed for " + key + ": " + e.getMessage());
        } finally {
            if (c != null) c.close();
            if (db != null) db.close();
        }
        return false;
    }
}
