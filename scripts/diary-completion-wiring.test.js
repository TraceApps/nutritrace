/**
 * Static-analysis tests for the #207 day-completion mark. Guards
 * against schema drift, missing endpoint, missing sync-push
 * preservation, missing badge on the WeekStrip, and the toggle button
 * being dropped from the Diary topbar-actions row.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serverDb    = readFileSync(new URL('../server/db.js',              import.meta.url), 'utf8');
const nativeDb    = readFileSync(new URL('../src/lib/db-native.js',      import.meta.url), 'utf8');
const diaryRoute  = readFileSync(new URL('../server/routes/diary.js',    import.meta.url), 'utf8');
const syncRoute   = readFileSync(new URL('../server/routes/sync.js',     import.meta.url), 'utf8');
const diaryStore  = readFileSync(new URL('../src/stores/diary.js',       import.meta.url), 'utf8');
const weekStrip   = readFileSync(new URL('../src/components/diary/WeekStrip.svelte', import.meta.url), 'utf8');
const diaryRoute2 = readFileSync(new URL('../src/routes/Diary.svelte',   import.meta.url), 'utf8');
const en          = readFileSync(new URL('../src/i18n/en.json',          import.meta.url), 'utf8');

// ── Schema ────────────────────────────────────────────────────────────────

test('#207: server diary table gets a completed_at column via migration', () => {
  assert.match(serverDb, /diary.*ADD COLUMN completed_at TEXT DEFAULT NULL/);
});

test('#207: native diary schema declares completed_at (or migrates it in)', () => {
  assert.match(nativeDb, /completed_at\s+TEXT/i);
  assert.match(nativeDb, /ALTER TABLE diary ADD COLUMN completed_at TEXT/);
});

// ── Endpoint ──────────────────────────────────────────────────────────────

test('#207: PUT /:date/completion endpoint exists on the diary router', () => {
  assert.match(diaryRoute, /router\.put\('\/:date\/completion'/);
});

test('#207: the endpoint updates completed_at and preserves first-mark timestamp', () => {
  assert.match(diaryRoute, /SET completed_at = datetime\('now'\)/);
  assert.match(diaryRoute, /completed_at = NULL/);
  assert.match(diaryRoute, /existing\.completed_at/);
});

test('#207: single-user + multi-user branches both handled', () => {
  assert.match(diaryRoute, /user_id IS NULL/);
  assert.match(diaryRoute, /user_id = \?/);
});

test('#207: empty-day GET response includes completed_at:null so the client is not undefined', () => {
  assert.match(diaryRoute, /completed_at:\s*null/);
});

// ── Sync-push preservation ────────────────────────────────────────────────

test('#207: sync-push carries completed_at into the diary upsert', () => {
  assert.match(syncRoute, /completed_at\s*=\s*excluded\.completed_at/);
});

test('#207: sync-push preserves existing completed_at when incoming is null (offline-clobber guard)', () => {
  // preserve-if-incoming-null: `incoming || existing`
  assert.match(syncRoute, /incomingCompletedAt\s*\|\|\s*\(existingRow\?\.completed_at/);
});

// ── Store + UI ────────────────────────────────────────────────────────────

test('#207: diary store exports setDayCompletion', () => {
  assert.match(diaryStore, /export async function setDayCompletion/);
  assert.match(diaryStore, /NtApi\.setDiaryCompletion/);
});

test('#207: WeekStrip renders a completion badge on completed days', () => {
  assert.match(weekStrip, /day\.completed/);
  assert.match(weekStrip, /ws-complete-mark/);
});

test('#207: Diary topbar-actions include a completion toggle button', () => {
  assert.match(diaryRoute2, /_toggleDayCompletion/);
  assert.match(diaryRoute2, /day-complete-on/);
  assert.match(diaryRoute2, /task_alt/);
});

test('#207: Diary imports setDayCompletion from the store', () => {
  assert.match(diaryRoute2, /setDayCompletion/);
});

// ── Discoverability + i18n ────────────────────────────────────────────────

test('#207: meal-reminder discoverability hint gated behind localStorage flag', () => {
  assert.match(diaryRoute2, /nt:dayCompletionMealTipShown/);
  assert.match(diaryRoute2, /notifMealReminders/);
});

// ── Companion surfaces (DatePicker badge, bedtime action, weekly summary,
//    Statistics KPI + tick marks) ──────────────────────────────────────────

test('#207: DatePicker accepts a completedDays Set and paints a badge', () => {
  const dp = readFileSync(new URL('../src/components/ui/DatePicker.svelte', import.meta.url), 'utf8');
  assert.match(dp, /export let completedDays/);
  assert.match(dp, /class:dp-complete=\{completedDays/);
  assert.match(dp, /\.dp-day\.dp-complete::after/);
});

test('#207: Diary passes completedDays into the DatePicker', () => {
  const diary = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
  assert.match(diary, /_refreshPickerCompletedDays/);
  assert.match(diary, /completedDays=\{pickerCompletedDays\}/);
});

test('#207: bedtime notification carries the Close today action + receiver exists', () => {
  const worker  = readFileSync(new URL('../android/app/src/main/java/com/nutritrace/app/ReminderWorker.java', import.meta.url), 'utf8');
  const receiver = readFileSync(new URL('../android/app/src/main/java/com/nutritrace/app/DiaryCompletionReceiver.java', import.meta.url), 'utf8');
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(worker,  /postBedtimeNotification/);
  assert.match(worker,  /isTodayCompleted/);
  assert.match(worker,  /DiaryCompletionReceiver\.ACTION_CLOSE_TODAY/);
  assert.match(receiver,/ACTION_CLOSE_TODAY/);
  assert.match(receiver,/UPDATE.*diary/i);
  assert.match(manifest,/DiaryCompletionReceiver/);
});

test('#207: weekly summary push + email include a completion line', () => {
  const push  = readFileSync(new URL('../server/lib/push-notify.js', import.meta.url), 'utf8');
  const email = readFileSync(new URL('../server/email.js', import.meta.url), 'utf8');
  assert.match(push,  /Marked complete/);
  assert.match(push,  /completed_at IS NOT NULL/);
  assert.match(email, /daysCompleted/);
  assert.match(email, /Days Marked Complete/);
});

test('#207: Statistics computes completionStats and renders the KPI', () => {
  const stats = readFileSync(new URL('../src/routes/Statistics.svelte', import.meta.url), 'utf8');
  assert.match(stats, /let completionStats/);
  assert.match(stats, /completedDatesSet/);
  assert.match(stats, /Marked complete/);
  assert.match(stats, /completionMarkerPlugin/);
});

test('#207: en.json carries the new day_complete strings + action labels', () => {
  const parsed = JSON.parse(en);
  const actions = parsed?.diary?.actions || {};
  const dc = parsed?.diary?.day_complete || {};
  assert.ok(actions.mark_day_complete,   'diary.actions.mark_day_complete missing');
  assert.ok(actions.unmark_day_complete, 'diary.actions.unmark_day_complete missing');
  assert.ok(dc.marked_toast,             'diary.day_complete.marked_toast missing');
  assert.ok(dc.unmarked_toast,           'diary.day_complete.unmarked_toast missing');
  assert.ok(dc.error_toast,              'diary.day_complete.error_toast missing');
  assert.ok(dc.meal_reminders_hint,      'diary.day_complete.meal_reminders_hint missing');
});
