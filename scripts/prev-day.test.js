/**
 * #280 (@fatman00): Yesterday's Meals (Foods, adding to a day) offers the
 * meals of the day before the day being added to. It counted back from
 * today, so adding to tomorrow offered the meals of the day before today.
 * Smart Log's "same as yesterday" counts the same way, from the day it
 * logs to (today, the only day Trace opens it for). The Android app's own
 * run is in scripts/android-sync.test.js.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dayBefore, dayName } from '../src/lib/prev-day.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const at = (day, h = 9) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00`);

test('the day before the day being logged to, whatever today is', () => {
  const now = at('2026-10-16');
  assert.equal(dayBefore('2026-10-17', now), '2026-10-16', 'adding to tomorrow: today');
  assert.equal(dayBefore('2026-10-16', now), '2026-10-15', 'adding to today: yesterday');
  assert.equal(dayBefore('2026-03-01', now), '2026-02-28');
  assert.equal(dayBefore('2024-03-01', now), '2024-02-29');
  assert.equal(dayBefore('2027-01-01', now), '2026-12-31');
  // Clocks change overnight in many places on these days.
  assert.equal(dayBefore('2026-03-09', now), '2026-03-08');
  assert.equal(dayBefore('2026-11-02', now), '2026-11-01');
  assert.equal(dayBefore('2026-03-30', now), '2026-03-29');
  for (const none of [undefined, null, '', 'nonsense']) assert.equal(dayBefore(none, now), '2026-10-15', `no day (${none}): today's`);
  assert.equal(dayBefore(undefined, at('2026-10-16', 0)), '2026-10-15', 'just after midnight');
  assert.equal(dayBefore(undefined, at('2026-10-16', 23)), '2026-10-15', 'just before');
});

test('the section names the day its meals come from', () => {
  const now = at('2026-10-16'); // a Friday
  assert.deepEqual(dayName('2026-10-15', now), { kind: 'yesterday' });
  assert.deepEqual(dayName('2026-10-16', now), { kind: 'today' });
  const weekday = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
  assert.deepEqual(dayName('2026-10-17', now), { kind: 'weekday', name: weekday('2026-10-17') });
  assert.deepEqual(dayName('2026-10-10', now), { kind: 'weekday', name: weekday('2026-10-10') }, 'six days back');
  assert.deepEqual(dayName('2026-10-22', now), { kind: 'weekday', name: weekday('2026-10-22') }, 'six days on');
  assert.deepEqual(dayName('2026-10-09', now), { kind: 'date', day: '2026-10-09' }, 'a week back: a date');
  assert.deepEqual(dayName('2026-10-23', now), { kind: 'date', day: '2026-10-23' });
});

test("Foods and Smart Log count back from the day they're adding to", () => {
  const foods = read('../src/routes/Foods.svelte');
  assert.match(foods, /\$: \{ if \(pickMode\) loadYesterdayMeals\(pickDate\); \}/, 'again when the day changes');
  assert.match(foods, /async function loadYesterdayMeals\(target = pickDate\) \{[\s\S]*?const yStr = dayBefore\(target\);/);
  assert.doesNotMatch(foods, /yDate\.setDate\(yDate\.getDate\(\) - 1\)/);
  assert.match(foods, /<span class="meal-section-label">\{_ySectionLabel\}<\/span>/);
  assert.match(foods, /\$_\('foods\.prev_day\.sheet_title'/);
  assert.doesNotMatch(foods, /title="Add to today"/, 'its add button names no day');
  assert.match(foods, /title=\{\$_\('foods\.prev_day\.add_title'\)\}/);
  assert.match(read('../src/routes/Diary.svelte'), /push\('\/foods\?pick=1&meal=' \+ mealSlot \+ '&date=' \+ \$currentDate\);/, 'Replace says which day too');
  assert.doesNotMatch(read('../src/routes/Diary.svelte'), /push\('\/foods\?pick=1&meal=' \+ mealSlot\);/);
  const ql = read('../src/lib/quick-log.js');
  assert.match(ql, /if \(kind === 'yesterday'\) return _matchYesterday\(parsedItem, date\);/);
  assert.match(ql, /const yDateStr = dayBefore\(date\);/);
  assert.match(read('../src/components/diary/SmartLogModal.svelte'), /await matchItems\(parsed\.items, \{ date \}\)/);
  const trace = read('../src/components/ai/Trace.svelte');
  assert.match(trace, /smartLogDate = localDateStr\(\);\s*const matches = await matchItems\(parsed\.items, \{ date: smartLogDate \}\);/);
  assert.match(trace, /date=\{smartLogDate \|\| localDateStr\(\)\}/, 'it logs to the day it matched against');
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.deepEqual(Object.keys(en.foods.prev_day), ['section_yesterday', 'section_from', 'yesterday', 'today', 'sheet_title', 'add_title', 'add_aria']);
});
