package com.nutritrace.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * BootReceiver — re-arms reminder alarms after device reboot.
 *
 * Without this, all AlarmManager schedules are lost on reboot and
 * notifications stop firing entirely until the user opens NutriTrace.
 *
 * Also handles:
 *   - ACTION_TIME_CHANGED / ACTION_TIMEZONE_CHANGED: alarms fire at
 *     wall-clock times, so timezone/clock changes need re-scheduling
 *   - ACTION_MY_PACKAGE_REPLACED: when the app updates, all alarms are
 *     wiped and need to be re-armed
 *
 * Triggers WorkerScheduler.reschedule() too so the WorkManager safety
 * net stays alive across the same lifecycle events.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "NTBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        Log.i(TAG, "received: " + action);
        try {
            ReminderAlarmScheduler.scheduleAll(context);
            WorkerScheduler.reschedule(context);
        } catch (Exception e) {
            Log.w(TAG, "boot reschedule failed: " + e.getMessage());
        }
    }
}
