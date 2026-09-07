/**
 * Tests for src/lib/goal-resolver.js. Guards against regression of #203
 * (Diary Remaining showed the weekly peak instead of the day's target
 * when "different target per weekday" was enabled).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGoalFor, resolveRangeGoal } from '../src/lib/goal-resolver.js';

// 2026-09-06 is a Sunday. Chosen deliberately: the bug report uses
// Sunday=2400 / Tuesday=2700 as the reproduction, and Sunday=0 is what
// getDay() returns.
const SUN = '2026-09-06';
const MON = '2026-09-07';
const TUE = '2026-09-08';

// ── resolveGoalFor: single-day resolver used by Diary ─────────────────────

test('resolveGoalFor: null / undefined goal returns null', () => {
  assert.equal(resolveGoalFor(null, SUN), null);
  assert.equal(resolveGoalFor(undefined, SUN), null);
});

test('resolveGoalFor: shared goal returns max (legacy: no sharedGoal field)', () => {
  // Legacy goals predate sharedGoal. Treat missing/undefined sharedGoal
  // as shared so pre-#203 users see no behavior change.
  assert.equal(resolveGoalFor({ max: 2000 }, SUN), 2000);
});

test('resolveGoalFor: sharedGoal === true returns max', () => {
  assert.equal(resolveGoalFor({ sharedGoal: true, max: 2000 }, SUN), 2000);
});

test('resolveGoalFor: shared goal falls back to min when max is null', () => {
  assert.equal(resolveGoalFor({ sharedGoal: true, max: null, min: 100 }, SUN), 100);
});

test('resolveGoalFor: per-weekday resolves days[weekday] for viewed date', () => {
  // Bug repro: Sunday=2400, Tuesday=2700, peak stored as max=2700.
  // Old code returned 2700 for every day; the fix reads days[0] for
  // Sunday and days[2] for Tuesday.
  const g = {
    sharedGoal: false,
    max: 2700,               // peak cached by saveGoal, misleading
    days: [2400, 0, 2700, 0, 0, 0, 0],
  };
  assert.equal(resolveGoalFor(g, SUN), 2400, 'Sunday');
  assert.equal(resolveGoalFor(g, TUE), 2700, 'Tuesday');
});

test('resolveGoalFor: per-weekday returns 0 as a valid explicit target', () => {
  // A user zeroing out a day (e.g. fast day) means "target 0", not
  // "fall through to max". null in the array is the "unset" sentinel.
  const g = {
    sharedGoal: false,
    max: 2000,
    days: [0, 2000, 2000, 2000, 2000, 2000, 2000],
  };
  assert.equal(resolveGoalFor(g, SUN), 0);
});

test('resolveGoalFor: per-weekday with null entry falls back to max', () => {
  const g = {
    sharedGoal: false,
    max: 2000,
    days: [null, 2000, 2000, 2000, 2000, 2000, 2000],
  };
  assert.equal(resolveGoalFor(g, SUN), 2000);
});

test('resolveGoalFor: per-weekday with malformed days array falls back to max', () => {
  // days must be exactly 7 entries. Anything else falls back so legacy
  // data with a corrupted array does not silently return undefined.
  assert.equal(resolveGoalFor({ sharedGoal: false, max: 2000, days: [] }, SUN), 2000);
  assert.equal(resolveGoalFor({ sharedGoal: false, max: 2000, days: [2400, 2500] }, SUN), 2000);
  assert.equal(resolveGoalFor({ sharedGoal: false, max: 2000 }, SUN), 2000);
});

test('resolveGoalFor: null dateStr falls back to max on per-weekday goal', () => {
  const g = { sharedGoal: false, max: 2700, days: [2400, 0, 2700, 0, 0, 0, 0] };
  assert.equal(resolveGoalFor(g, null), 2700);
  assert.equal(resolveGoalFor(g, ''), 2700);
  assert.equal(resolveGoalFor(g, undefined), 2700);
});

test('resolveGoalFor: bad date string falls back to max', () => {
  const g = { sharedGoal: false, max: 2700, days: [2400, 0, 2700, 0, 0, 0, 0] };
  assert.equal(resolveGoalFor(g, 'not-a-date'), 2700);
});

test('resolveGoalFor: weekday derives from local calendar', () => {
  // 2026-09-06 must resolve to Sunday (days[0]) regardless of TZ.
  // Parsing as `YYYY-MM-DDT00:00:00` is local midnight; getDay() reads
  // the local weekday. Cross-check by computing a JS Date the same way.
  const d = new Date('2026-09-06T00:00:00');
  assert.equal(d.getDay(), 0, 'sanity: 2026-09-06 local is Sunday');
  const g = { sharedGoal: false, max: 2500, days: [1111, 2222, 3333, 4444, 5555, 6666, 7777] };
  assert.equal(resolveGoalFor(g, '2026-09-06'), 1111, 'Sunday → days[0]');
  assert.equal(resolveGoalFor(g, '2026-09-07'), 2222, 'Monday → days[1]');
  assert.equal(resolveGoalFor(g, '2026-09-08'), 3333, 'Tuesday → days[2]');
  assert.equal(resolveGoalFor(g, '2026-09-12'), 7777, 'Saturday → days[6]');
});

// ── resolveRangeGoal: multi-day resolver used by Statistics ───────────────

test('resolveRangeGoal: shared goal returns max', () => {
  assert.equal(resolveRangeGoal({ max: 2000 }), 2000);
  assert.equal(resolveRangeGoal({ sharedGoal: true, max: 2000 }), 2000);
});

test('resolveRangeGoal: shared falls back to min', () => {
  assert.equal(resolveRangeGoal({ sharedGoal: true, max: null, min: 100 }), 100);
});

test('resolveRangeGoal: per-weekday returns average of non-zero days', () => {
  // Sun/Tue high, other days zero. Average of {2400, 2700} = 2550.
  const g = {
    sharedGoal: false,
    max: 2700,
    days: [2400, 0, 2700, 0, 0, 0, 0],
  };
  assert.equal(resolveRangeGoal(g), 2550);
});

test('resolveRangeGoal: per-weekday averages every populated day', () => {
  const g = {
    sharedGoal: false,
    max: 2700,
    days: [2000, 2000, 2000, 2000, 2000, 2500, 2500],
  };
  // (5 * 2000 + 2 * 2500) / 7 = 15000 / 7 ≈ 2142.857
  assert.equal(resolveRangeGoal(g), 15000 / 7);
});

test('resolveRangeGoal: per-weekday with all zeros falls back to max', () => {
  // If nothing in days is > 0, treat as "no per-day data" and fall back
  // so the chart still has SOMETHING to show instead of hiding the goal
  // line entirely.
  const g = { sharedGoal: false, max: 2000, days: [0, 0, 0, 0, 0, 0, 0] };
  assert.equal(resolveRangeGoal(g), 2000);
});

test('resolveRangeGoal: per-weekday with no days array falls back to max', () => {
  assert.equal(resolveRangeGoal({ sharedGoal: false, max: 2000 }), 2000);
});

test('resolveRangeGoal: null / undefined goal returns null', () => {
  assert.equal(resolveRangeGoal(null), null);
  assert.equal(resolveRangeGoal(undefined), null);
});

// ── Anti-regression on #203 exact scenario ────────────────────────────────

test('#203: bug scenario matches expected Diary target for each weekday', () => {
  // Exact numbers from the issue: Sunday 2400, Tuesday 2700, per-weekday
  // enabled. Every other day zero for brevity.
  const calories = {
    sharedGoal: false,
    max: 2700,   // peak cached by Goals.svelte
    min: undefined,
    days: [2400, 0, 2700, 0, 0, 0, 0],
  };
  // Reporter's expected Remaining on Sunday after 2296 kcal: 104.
  assert.equal(resolveGoalFor(calories, SUN) - 2296, 104);
  // Old (buggy) behavior would give 2700 - 2296 = 404.
  assert.notEqual((calories.max ?? calories.min) - 2296, 104);
});
