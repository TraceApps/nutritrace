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
import java.util.TimeZone;

/**
 * DiaryCompletionReceiver: handles the "Close today" quick action on
 * the Bedtime notification (#207 companion). Marks today's diary row
 * complete and queues the mark in diary_completion_ops, as a tap in the
 * app does (src/lib/api-cached.js setDiaryCompletion, db-native.js
 * dbQueueCompletionOp), then dismisses the notification that fired it.
 * The app's next sync sends the queued mark through the completion call
 * with when it was made (the diary push never carries marks, so a mark
 * written only on the row never reached the server and the next pull
 * took it away). Times are UTC, as the app writes them: completed_at as
 * now, the op's `at` set by the server clock offset the app keeps in
 * sync_meta (`+00:00`, already on the server's clock) when it has one.
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

        long nowMs = System.currentTimeMillis();
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(nowMs));
        String nowIso = utc(nowMs) + "Z";

        SQLiteDatabase db = null;
        try {
            File dbFile = context.getDatabasePath(DB_FILENAME);
            if (!dbFile.exists()) {
                Log.d(TAG, "DB not found; nothing to close");
                return;
            }
            db = SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
            db.beginTransactionNonExclusive();
            boolean marked = false;

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
                        marked = true;
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
                    marked = true;
                }
            } finally {
                c.close();
            }
            // Queued only when signed in to a server: in local-only mode the
            // app's own taps queue nothing either, and a mark left waiting
            // would be sent on a later connect over what was chosen since.
            if (marked && signedIn(db)) {
                ContentValues op = new ContentValues();
                op.put("user_id", 1);
                op.put("date", today);
                op.putNull("slot");
                op.put("completed", 1);
                op.put("at", markTime(db, nowMs, nowIso));
                // An app updated but not opened since has no queue yet: the
                // mark still shows here, as before.
                try { db.insertOrThrow("diary_completion_ops", null, op); }
                catch (Exception e) { Log.w(TAG, "close-today mark not queued: " + e.getMessage()); }
            }
            db.setTransactionSuccessful();
        } catch (Exception e) {
            Log.w(TAG, "close-today write failed: " + e.getMessage());
        } finally {
            if (db != null) {
                try { if (db.inTransaction()) db.endTransaction(); } catch (Exception ignored) {}
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

    /** A time in UTC, as "yyyy-MM-dd'T'HH:mm:ss.SSS" (the zone added by the caller). */
    private static String utc(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    /** Signed in to a server: the app mirrors its server and sign-in here (platform.js). */
    private static boolean signedIn(SQLiteDatabase db) {
        android.database.Cursor c = null;
        try {
            c = db.rawQuery("SELECT COUNT(*) FROM sync_meta WHERE key IN ('server_url', 'auth_token') AND value IS NOT NULL AND value != ''", null);
            return c.moveToFirst() && c.getInt(0) == 2;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.close();
        }
    }

    /**
     * When the mark was made, as the app's _editNow (db-native.js): on the
     * server's clock ("+00:00") when the app has learned its offset, else
     * this phone's ("Z"), which the server sets right by the push's clock.
     */
    private static String markTime(SQLiteDatabase db, long nowMs, String nowIso) {
        android.database.Cursor c = null;
        try {
            c = db.rawQuery("SELECT value FROM sync_meta WHERE key = 'clock_offset_ms'", null);
            if (c.moveToFirst() && !c.isNull(0)) {
                long offset = Math.round(Double.parseDouble(c.getString(0)));
                return utc(nowMs + offset) + "+00:00";
            }
        } catch (Exception ignored) {
            // No offset learned yet (or no sync_meta): this phone's time.
        } finally {
            if (c != null) c.close();
        }
        return nowIso;
    }
}
