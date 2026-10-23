package com.nutritrace.app;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;

import java.io.File;

/**
 * Opens the app's local database (the JS side's Capacitor SQLite file) for
 * the native workers, schedulers and receivers.
 *
 * Always read-write, even just to read: when the app was stopped in the
 * middle of a write, SQLite leaves a "hot" journal that has to be rolled
 * back before anything can be read, and a read-only connection can't do
 * that. It fails with SQLITE_READONLY_ROLLBACK, and WorkerScheduler took
 * that failure for "Health Connect is off" and cancelled the hourly sync;
 * the alarm scheduler likewise cancelled every reminder.
 *
 * A failed read is an error, never a setting: callers leave what is
 * scheduled as it is when reading fails.
 */
public final class LocalDb {
    public static final String FILENAME = "nutritrace_localSQLite.db";

    private LocalDb() {}

    /** The database, or null when the app hasn't created it yet. Throws when it can't be opened. */
    public static SQLiteDatabase open(Context context) {
        File file = context.getDatabasePath(FILENAME);
        if (!file.exists()) return null;
        return SQLiteDatabase.openDatabase(file.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE);
    }

    /**
     * Whether a read failed only because the settings table isn't there yet
     * (the app's first launch), which is the same as the setting being unset.
     */
    public static boolean isMissingTable(Exception e) {
        String m = e.getMessage();
        return m != null && m.contains("no such table");
    }
}
