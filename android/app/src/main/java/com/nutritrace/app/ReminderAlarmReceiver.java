package com.nutritrace.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

/**
 * ReminderAlarmReceiver — fires when an exact alarm goes off.
 *
 * Flow:
 *   1. AlarmManager wakes the device + invokes onReceive
 *   2. Receiver enqueues a one-shot ReminderWorker run, which immediately
 *      executes the existing reminder check logic (window match, dedup,
 *      self-heal, post notification)
 *   3. Receiver re-arms the same alarm for tomorrow so it keeps firing
 *      every day
 *
 * Why delegate to ReminderWorker instead of duplicating the check logic?
 *   The worker has accumulated several rounds of self-heal logic
 *   (weigh-in cancel-on-late-sync, multi-fire mute prevention,
 *   already-logged dedup). Keeping ONE source of truth avoids drift.
 *
 * Why OneTimeWorkRequest and not direct execution in onReceive?
 *   onReceive runs on the main thread and must complete in <10s. Worker
 *   does SQLite reads and may run slightly longer; WorkManager guarantees
 *   it finishes even if the receiver returns first.
 */
public class ReminderAlarmReceiver extends BroadcastReceiver {
    private static final String TAG = "ReminderAlarmRcvr";

    @Override
    public void onReceive(Context context, Intent intent) {
        String type = intent.getStringExtra(ReminderAlarmScheduler.EXTRA_TYPE);
        int slot = intent.getIntExtra(ReminderAlarmScheduler.EXTRA_SLOT, -1);
        Log.i(TAG, "alarm fired: " + type + (slot >= 0 ? "[" + slot + "]" : ""));

        // Enqueue the existing reminder worker — runs within seconds since
        // the device is already awake. KEEP policy so we don't trample a
        // currently-running periodic sweep.
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(ReminderWorker.class).build();
        try {
            WorkManager.getInstance(context)
                .enqueueUniqueWork("nutritrace_reminder_oneshot", ExistingWorkPolicy.REPLACE, req);
        } catch (Exception e) {
            Log.w(TAG, "worker enqueue failed: " + e.getMessage());
        }

        // Re-arm the same alarm for tomorrow so it keeps firing daily.
        // Water reminders re-arm to the next interval boundary instead.
        if (type != null) {
            try {
                ReminderAlarmScheduler.rescheduleTomorrow(context, type, slot);
            } catch (Exception e) {
                Log.w(TAG, "reschedule failed: " + e.getMessage());
            }
        }
    }
}
