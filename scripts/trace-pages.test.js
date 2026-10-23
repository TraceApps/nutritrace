/**
 * Trace can go through the diary over many days and the whole meals library
 * (TraceApps/notetrace#34). get_diary read one date per call, so a month took
 * 31 calls and more steps than one answer had; get_meals stopped at 50 with
 * no way to the rest. Now get_diary reads a range (31 days a call, within a
 * size budget, saying where the rest starts) and get_meals comes a page at a
 * time, in one order on every device.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { diaryRange, emptyDiaryDay, mealsPage, DIARY_RANGE_BUDGET } from '../src/lib/trace-pages.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// A diary: pizza on the 3rd and 17th, something on every fourth day, nothing otherwise.
const logged = (date, food = 'Oats') => ({ date, meals: { Lunch: [{ name: food, calories: 300 }] }, totals: { calories: 300 }, body_stats: {}, water_ml: 0 });
const empty = (date) => ({ date, meals: {}, totals: null, body_stats: {}, water_ml: 0 });
const october = (date) => {
  const d = Number(date.slice(8));
  if (d === 3 || d === 17) return logged(date, 'Pizza');
  return d % 4 === 0 ? logged(date) : empty(date);
};

test('one date is what it always was', async () => {
  const day = logged('2026-10-03', 'Pizza');
  assert.equal(await diaryRange({ date: '2026-10-03' }, async () => day), day);
  assert.equal(await diaryRange({ date: '2026-10-03', to: '2026-10-03' }, async () => day), day);
});

test('a month in one call: the days with something logged, the empty ones counted', async () => {
  const asked = [];
  const r = await diaryRange({ date: '2026-10-01', to: '2026-10-31' }, async (d) => { asked.push(d); return october(d); });
  assert.equal(asked.length, 31);
  assert.deepEqual(r.days.filter((x) => x.meals.Lunch[0].name === 'Pizza').map((x) => x.date), ['2026-10-03', '2026-10-17']);
  assert.equal(r.days.length + r.days_with_nothing_logged, 31);
  assert.deepEqual([r.from, r.to, r.complete, r.next_from, r.more], ['2026-10-01', '2026-10-31', true, undefined, undefined]);
  // Water, body stats, notes and activity count as something logged.
  for (const day of [{ water_ml: 500 }, { body_stats: { weight: 180 } }, { day_notes: 'Slept badly' }, { activities: [{ name: 'Walk' }] }, { error: 'Could not load diary' }]) {
    assert.equal(emptyDiaryDay({ date: 'x', meals: {}, totals: null, body_stats: {}, water_ml: 0, ...day }), false, JSON.stringify(day));
  }
});

test('past 31 days or the size budget, next_from says where to go on, and going on covers every day once', async () => {
  const long = await diaryRange({ date: '2026-09-01', to: '2026-10-15' }, async (d) => logged(d));
  assert.equal(long.days.length, 31);
  assert.deepEqual([long.to, long.complete, long.next_from], ['2026-10-01', false, '2026-10-02']);
  assert.equal(long.more, 'This covers 2026-09-01 to 2026-10-01: call get_diary again with date 2026-10-02 and to 2026-10-15 for the rest.');
  // Big days: each answer stays within the budget, and the calls together cover every day once.
  const big = (d) => ({ ...logged(d), day_notes: 'n'.repeat(5000) });
  const seen = [];
  let args = { date: '2026-10-01', to: '2026-10-20' }, calls = 0;
  for (;;) {
    const r = await diaryRange(args, async (d) => big(d));
    calls++;
    assert.ok(JSON.stringify(r.days).length <= DIARY_RANGE_BUDGET, `${JSON.stringify(r.days).length}`);
    seen.push(...r.days.map((x) => x.date));
    if (r.complete) break;
    assert.equal(r.next_from, r.days.length ? _after(r.to) : r.next_from);
    args = { date: r.next_from, to: args.to };
  }
  assert.equal(seen.length, 20);
  assert.equal(new Set(seen).size, 20);
  assert.ok(calls >= 7, `${calls} calls`);
  // One day too big to share an answer still comes back, on its own.
  const huge = await diaryRange({ date: '2026-10-01', to: '2026-10-02' }, async (d) => ({ ...logged(d), day_notes: 'n'.repeat(40000) }));
  assert.deepEqual([huge.days.map((x) => x.date), huge.next_from], [['2026-10-01'], '2026-10-02']);
});
const _after = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

test('dates: month ends, leap days, clock changes, mistakes', async () => {
  const dates = async (date, to) => (await diaryRange({ date, to }, async (d) => logged(d))).days.map((x) => x.date);
  assert.deepEqual(await dates('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.deepEqual(await dates('2026-12-31', '2027-01-01'), ['2026-12-31', '2027-01-01']);
  assert.deepEqual(await dates('2026-03-07', '2026-03-09'), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(await dates('2026-10-31', '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.match((await diaryRange({ date: '2026-10-05', to: '2026-10-01' }, async () => ({}))).error, /on or after/);
  assert.match((await diaryRange({ date: '2026-02-30', to: '2026-03-02' }, async () => ({}))).error, /YYYY-MM-DD/);
  assert.match((await diaryRange({ date: 'last week', to: '2026-03-02' }, async () => ({}))).error, /YYYY-MM-DD/);
  // A day that fails to load says so, and the rest still come.
  const r = await diaryRange({ date: '2026-10-01', to: '2026-10-03' }, async (d) => { if (d === '2026-10-02') throw new Error('offline'); return logged(d); });
  assert.deepEqual(r.days.map((x) => [x.date, !!x.error]), [['2026-10-01', false], ['2026-10-02', true], ['2026-10-03', false]]);
});

test('the meals library a page at a time, in one order, every meal once', () => {
  // Out of order, with recipes mixed in and two meals of the same name.
  const lib = [];
  for (let i = 120; i >= 1; i--) lib.push({ id: i, name: `Meal ${String(i % 60).padStart(3, '0')}`, kind: i % 3 ? 'meal' : 'recipe' });
  const seen = [];
  let page = mealsPage(lib, {});
  assert.deepEqual([page.count, page.offset, page.returned, page.next_offset, page.complete], [120, 0, 50, 50, false]);
  assert.equal(page.more, 'This is 1 to 50 of 120: call get_meals again with offset 50 for the rest.');
  seen.push(...page.meals);
  while (!page.complete) { page = mealsPage(lib, { offset: page.next_offset }); seen.push(...page.meals); }
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen.map((m) => m.id)).size, 120);
  // Meals before recipes, by name, the same name by id.
  const kinds = seen.map((m) => m.kind);
  assert.equal(kinds.lastIndexOf('meal') < kinds.indexOf('recipe'), true);
  const twins = seen.filter((m) => m.name === 'Meal 001' && m.kind === 'meal').map((m) => m.id);
  assert.deepEqual(twins, [...twins].sort((a, b) => a - b));
  // Whatever order the device listed them in, the pages are the same.
  assert.deepEqual(mealsPage([...lib].reverse(), { offset: 50 }).meals.map((m) => m.id), mealsPage(lib, { offset: 50 }).meals.map((m) => m.id));
  // The name filter, past the end, and a page never over 50.
  const q = mealsPage([{ id: 1, name: 'Café latte', kind: 'meal' }, { id: 2, name: 'Oats', kind: 'meal' }], { query: 'cafe' });
  assert.deepEqual([q.count, q.meals.map((m) => m.id), q.complete], [1, [1], true]);
  assert.deepEqual(mealsPage(lib, { offset: 999 }).meals, []);
  assert.equal(mealsPage(lib, { limit: 500 }).returned, 50);
});

test('Trace has the range and the paging, and is told how to go through many days', () => {
  const ai = read('../src/lib/aiChat.js');
  const trace = read('../src/components/ai/Trace.svelte');
  assert.match(ai, /to: +\{ type: 'string', description: 'Optional last day of a range/);
  assert.match(ai, /offset: \{ type: 'integer', description: 'Where the page starts/);
  assert.match(trace, /case 'get_diary': return diaryRange\(args, async \(date\) =>/);
  assert.match(trace, /return mealsPage\(\[/);
  assert.match(trace, /To go through many days of the diary[^`]*get_diary's to \(31 days a call\)[^`]*Say whether you covered everything\./);
});
