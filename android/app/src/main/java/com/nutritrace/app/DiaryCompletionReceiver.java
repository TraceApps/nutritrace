package com.nutritrace.app;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * DiaryCompletionReceiver: handles the "Close today" quick action on
 * the Bedtime notification (#207 companion). Marks today's diary row
 * completed_at = now, sync_status = pending, then dismisses the
 * notification that fired it. The next sync run pushes the mark up so
 * every other device sees the green check.
 *
 * Direct SQLite write into the same Capacitor DB the JS side uses
 * (nutritrace_localSQLite.db). Same access pattern ReminderWorker uses
 * for reads; here we open READWRITE.
 *
 * Not exported: only PendingIntents built inside this package can fire
 * it, so a malicious app on the device cannot forge a completion.
 */
public class DiaryCompletionReceiver extends BroadcastReceiver {
    private static final String TAG = "DiaryCompletionReceiver";
    private static final String DB_FILENAME = "nutritrace_localSQLite.db";
    public  static final String ACTION_CLOSE_TODAY = "com.nutritrace.app.action.CLOSE_TODAY";
    public  static final String EXTRA_NOTIFICATION_ID = "notification_id";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_CLOSE_TODAY.equals(intent.getAction())) return;

        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String nowIso = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());

        SQLiteDatabase db = null;
        try {
            File dbFile = context.getDatabasePath(DB_FILENAME);
            if (!dbFile.exists()) {
                Log.d(TAG, "DB not found; nothing to close");
                return;
            }
            db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);

            // Preserve the first-mark timestamp: only stamp completed_at
            // when the row is either absent or currently unmarked. Repeat
            // taps of the notification action are then idempotent.
            android.database.Cursor c = db.rawQuery(
                "SELECT id, completed_at FROM diary WHERE date = ? AND user_id = ?",
                new String[]{today, "1"}
            );
            try {
                if (c.moveToFirst()) {
                    long id = c.getLong(0);
                    String existing = c.isNull(1) ? null : c.getString(1);
                    if (existing == null || existing.isEmpty()) {
                        ContentValues cv = new ContentValues();
                        cv.put("completed_at", nowIso);
                        cv.put("updated_at", nowIso);
                        cv.put("sync_status", "pending");
                        db.update("diary", cv, "id = ?", new String[]{String.valueOf(id)});
                    }
                } else {
                    ContentValues cv = new ContentValues();
                    cv.put("user_id", 1);
                    cv.put("date", today);
                    cv.put("items", "[]");
                    cv.put("body_stats", "{}");
                    cv.put("water", "[]");
                    cv.put("completed_at", nowIso);
                    cv.put("updated_at", nowIso);
                    cv.put("sync_status", "pending");
                    db.insert("diary", null, cv);
                }
            } finally {
                c.close();
            }
        } catch (Exception e) {
            Log.w(TAG, "close-today write failed: " + e.getMessage());
        } finally {
            if (db != null) {
                try { db.close(); } catch (Exception ignored) {}
            }
        }

        // Dismiss the notification that fired the action so the user sees
        // an immediate acknowledgement instead of a stale card sitting on
        // the shade after the tap.
        int notifId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1);
        if (notifId != -1) {
            try {
                NotificationManagerCompat.from(context).cancel(notifId);
            } catch (Exception ignored) {}
        }
    }
}
