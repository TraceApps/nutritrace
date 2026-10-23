/**
 * Native code reads the local database read-write, and a failed read is
 * never a setting. After the app was stopped mid-write, a read-only
 * connection failed with SQLITE_READONLY_ROLLBACK (a hot journal it can't
 * roll back); WorkerScheduler took that for "Health Connect off" and
 * cancelled the hourly sync, and the alarm scheduler cancelled reminders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../android/app/src/main/java/com/nutritrace/app/', import.meta.url);
const read = f => readFileSync(new URL(f, DIR), 'utf8');

test('no native code opens the local database read-only', () => {
  for (const f of readdirSync(DIR).filter(f => /\.(java|kt)$/.test(f))) {
    assert.doesNotMatch(read(f), /OPEN_READONLY/, f);
  }
  assert.match(read('LocalDb.java'), /SQLiteDatabase\.OPEN_READWRITE/);
});

test('WorkerScheduler cancels the Health Connect sync only when the setting reads off', () => {
  const s = read('WorkerScheduler.java');
  assert.match(s, /static Boolean readBoolSetting\(Context context, String key\)/);
  assert.match(s, /if \(hcEnabled == null\) \{\s*Log\.w\(TAG, "HC sync worker left as it is/);
  assert.match(s, /if \(LocalDb\.isMissingTable\(e\)\) return false;[\s\S]{0,120}return null;/);
});

test('reminder setting reads pass errors up instead of reading them as unset', () => {
  for (const f of ['ReminderAlarmScheduler.java', 'ReminderWorker.java']) {
    assert.match(read(f), /catch \(RuntimeException e\) \{[\s\S]{0,260}if \(!LocalDb\.isMissingTable\(e\)\) throw e;/, f);
  }
});
