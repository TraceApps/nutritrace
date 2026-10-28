/**
 * #283 (@fatman00): Select Multiple can copy its items to another day (and
 * meal) and move them to another meal, and the Copy sheet can repeat a copy
 * for the next N days (one item, a meal, or a selection).
 * #267 (@jsapede): Move can change the day too, Add to Diary on the Foods
 * page asks which day, and every day choice has Yesterday / Today /
 * Tomorrow chips (one DayPicker everywhere).
 *
 * The pure helpers (src/lib/diary-copy.js, src/lib/day-label.js), then the
 * real diary store (src/stores/diary.js) over an in-memory NtApi with the
 * two calls every transport has (getDiaryDate / saveDiaryDate: the server,
 * the browser's offline queue, Android's local database), then the wiring.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  REPEAT_MAX_DAYS, clampRepeat, repeatDates, foodServerIdFor, copyOfDiaryItem,
  moveItemsToMeal, copyToDays, copyOutcome,
} from '../src/lib/diary-copy.js';
import { todayIso, shiftDay, relativeDay, plainDay, dayValues } from '../src/lib/day-label.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const EMDASH = String.fromCharCode(0x2014);
const withTz = (tz, fn) => {
  const was = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};

// ── Days ────────────────────────────────────────────────────────────────────

test('repeat days: the chosen day, then each of the next N', () => {
  assert.deepEqual(repeatDates('2026-10-29', 0), ['2026-10-29']);
  assert.deepEqual(repeatDates('2026-10-29'), ['2026-10-29']);
  assert.deepEqual(repeatDates('2026-10-29', 3), ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(repeatDates('2026-12-30', 3), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.deepEqual(repeatDates('2028-02-27', 2), ['2028-02-27', '2028-02-28', '2028-02-29']);
  assert.deepEqual(repeatDates('2026-02-27', 2), ['2026-02-27', '2026-02-28', '2026-03-01']);
  for (const bad of [undefined, null, '', 'tomorrow', '2026-1-2']) assert.deepEqual(repeatDates(bad, 3), [], String(bad));
});

test('repeat goes up to 14 days and never below off', () => {
  assert.equal(REPEAT_MAX_DAYS, 14);
  assert.equal(repeatDates('2026-10-29', 99).length, 15);
  assert.equal(repeatDates('2026-10-29', 99).at(-1), '2026-11-12');
  assert.deepEqual([clampRepeat(-1), clampRepeat('x'), clampRepeat(2.7), clampRepeat(15), clampRepeat('3')], [0, 0, 2, 14, 3]);
});

test('repeat days and day chips across clock changes, in zones that have them', () => {
  const cases = [
    ['America/New_York', '2026-03-07', ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']],
    ['America/New_York', '2026-10-31', ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']],
    ['Europe/London', '2026-03-28', ['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']],
    ['Europe/London', '2026-10-24', ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']],
    ['Australia/Sydney', '2026-04-04', ['2026-04-04', '2026-04-05', '2026-04-06', '2026-04-07']],
    ['America/Santiago', '2026-09-05', ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']],
    ['Pacific/Auckland', '2026-09-26', ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']],
  ];
  for (const [tz, start, want] of cases) {
    withTz(tz, () => {
      assert.deepEqual(repeatDates(start, 3), want, `${tz} from ${start}`);
      assert.equal(shiftDay(want[2], -1), want[1], `${tz} back over the change`);
      assert.equal(shiftDay(want[1], 1), want[2], `${tz} forward over the change`);
      // Just after midnight on the day the clocks change.
      const [y, m, d] = want[1].split('-').map(Number);
      const now = new Date(y, m - 1, d, 0, 30);
      assert.equal(todayIso(now), want[1]);
      assert.equal(relativeDay(want[0], now), 'yesterday', tz);
      assert.equal(relativeDay(want[2], now), 'tomorrow', tz);
    });
  }
});

test('naming a day next to today', () => {
  const now = new Date(2026, 9, 28, 9);
  assert.equal(relativeDay('2026-10-27', now), 'yesterday');
  assert.equal(relativeDay('2026-10-28', now), 'today');
  assert.equal(relativeDay('2026-10-29', now), 'tomorrow');
  assert.equal(relativeDay('2026-10-30', now), 'other');
  assert.equal(relativeDay('2026-09-28', now), 'other');
  assert.equal(relativeDay('2025-12-31', new Date(2026, 0, 1, 23, 59)), 'yesterday', 'over a new year');
  assert.equal(plainDay('2026-10-29', 'en-US'), 'Thu, Oct 29');
  assert.equal(plainDay('nonsense', 'en-US'), 'nonsense');
  assert.deepEqual(dayValues('2026-10-30', { now, lang: 'en-US' }), { rel: 'other', day: 'Fri, Oct 30' });
  assert.equal(shiftDay('', 1), '');
});

// ── One copy of one item ────────────────────────────────────────────────────

test('a copied item drops its row and id, gets a new uuid and its meal', () => {
  const item = { _i: 4, id: 12, uuid: 'old', meal: 2, name: 'Oats', quantity: 40, unit: 'g',
    nutrition: { calories: 150 }, food_server_id: 12, notes: 'n', imgUrl: '/uploads/a.jpg', addedAt: 'then' };
  const c = copyOfDiaryItem(item, null, { uuid: 'new', now: 'now' });
  assert.equal('_i' in c, false);
  assert.equal('id' in c, false);
  assert.deepEqual(c, { uuid: 'new', meal: 2, name: 'Oats', quantity: 40, unit: 'g',
    nutrition: { calories: 150 }, food_server_id: 12, notes: 'n', imgUrl: '/uploads/a.jpg', addedAt: 'now' });
  assert.equal(copyOfDiaryItem(item, 0, { uuid: 'x', now: 'n' }).meal, 0, 'a chosen meal wins, 0 included');
  assert.equal(copyOfDiaryItem({ ...item, meal: undefined }, null, { uuid: 'x', now: 'n' }).meal, 0, 'no meal is the first');
  assert.equal(item.uuid, 'old', 'the original is untouched');
});

test('Quick Calories and split recipes copy whole', () => {
  const quick = { _i: 0, uuid: 'q', type: 'quick_calories', name: 'Quick Calories', nutrition: { calories: 200, proteins: 5 }, meal: 3 };
  assert.deepEqual(copyOfDiaryItem(quick, null, { uuid: 'q2', now: 'n' }),
    { type: 'quick_calories', name: 'Quick Calories', nutrition: { calories: 200, proteins: 5 }, meal: 3, uuid: 'q2', addedAt: 'n', food_server_id: null });
  const split = { _i: 1, uuid: 's', name: 'Chili', is_recipe: 1, _splitItems: [{ name: 'Beans' }], meal: 1, food_server_id: 9 };
  assert.deepEqual(copyOfDiaryItem(split, 2, { uuid: 's2', now: 'n' })._splitItems, [{ name: 'Beans' }]);
});

test('which food a copy came from follows addDiaryItem', () => {
  assert.equal(foodServerIdFor({ food_server_id: 7 }), 7);
  assert.equal(foodServerIdFor({ food_server_id: null, id: 3 }), null, 'logged again: keeps its own, even null');
  assert.equal(foodServerIdFor({ server_id: 5, food_server_id: 7 }), 5, 'Android food row');
  assert.equal(foodServerIdFor({ id: 3 }), 3, 'browser food row');
  assert.equal(foodServerIdFor({ id: 'temp-1' }), null);
  assert.equal(foodServerIdFor({}), null);
});

// ── Move within a day ───────────────────────────────────────────────────────

test('move: the picked rows go to the meal, the rest stay where they were', () => {
  const items = [{ name: 'a', meal: 0 }, { name: 'b', meal: 1 }, { name: 'c', meal: 2 }, { name: 'd' }];
  const { items: out, moved } = moveItemsToMeal(items, [0, 1, 3], 1, 'now');
  assert.equal(moved, 2, 'b was already in meal 1');
  assert.deepEqual(out.map(i => [i.name, i.meal]), [['a', 1], ['b', 1], ['c', 2], ['d', 1]]);
  assert.equal(out[1], items[1], 'an item already there is left as it was');
  assert.equal(out[0].updatedAt, 'now');
  assert.equal(items[0].meal, 0, 'the original list is untouched');
  assert.equal(moveItemsToMeal(items, [], 2, 'now').moved, 0);
});

// ── Several days, and what the toast says ───────────────────────────────────

test('copyToDays: one day failing does not stop the others', async () => {
  const seen = [];
  const r = await copyToDays(['d1', 'd2', 'd3'], async d => { seen.push(d); if (d === 'd2') throw new Error('Server said no'); return 3; });
  assert.deepEqual(seen, ['d1', 'd2', 'd3']);
  assert.deepEqual(r.copied, ['d1', 'd3']);
  assert.deepEqual(r.failed.map(f => [f.date, f.error.message]), [['d2', 'Server said no']]);
  assert.equal(r.items, 3);
  assert.equal(r.nothing, false);
  const none = await copyToDays(['d1', 'd2'], async () => 0);
  assert.equal(none.nothing, true);
  assert.deepEqual(none.copied, []);
});

test('the toast never says copied when a day failed', () => {
  const fmt = d => `<${d}>`;
  const err = new Error('offline');
  let o = copyOutcome({ copied: ['a', 'c'], failed: [{ date: 'b', error: err }, { date: 'd', error: err }], items: 2 }, { meal: 'Lunch', fmt });
  assert.equal(o.level, 'error');
  assert.equal(o.key, 'diary.copy.toast_partial');
  assert.deepEqual(o.values, { n: 2, done: 2, total: 4, failed: '<b>; <d>' });
  o = copyOutcome({ copied: [], failed: [{ date: 'b', error: err }], items: 0 }, { meal: 'Lunch', fmt });
  assert.deepEqual(o, { level: 'error', key: 'diary.copy.toast_failed_reason', values: { error: 'offline' } });
  o = copyOutcome({ copied: [], failed: [{ date: 'b', error: {} }], items: 0 }, { meal: 'Lunch', fmt });
  assert.equal(o.key, 'diary.copy.toast_failed');
  o = copyOutcome({ copied: [], failed: [], items: 0, nothing: true }, {});
  assert.deepEqual([o.level, o.key], ['info', 'diary.copy.toast_nothing']);
});

test('the toast names the meal and day, or the run of days', () => {
  const fmt = d => `<${d}>`;
  const rel = d => (d === 't' ? 'tomorrow' : 'other');
  const ok = (copied, opts) => copyOutcome({ copied, failed: [], items: 2 }, { fmt, rel, ...opts });
  assert.deepEqual(ok(['t'], { meal: 'Lunch' }), { level: 'success', key: 'diary.copy.toast_day_meal', values: { n: 2, meal: 'Lunch', rel: 'tomorrow', day: '<t>' } });
  assert.deepEqual(ok(['x'], { meal: 'Lunch' }).values, { n: 2, meal: 'Lunch', rel: 'other', day: '<x>' });
  assert.deepEqual(ok(['t'], { keepMeals: true }), { level: 'success', key: 'diary.copy.toast_day', values: { n: 2, rel: 'tomorrow', day: '<t>' } });
  assert.deepEqual(ok(['a', 'b', 'c'], { meal: 'Dinner' }), { level: 'success', key: 'diary.copy.toast_days_meal', values: { n: 2, meal: 'Dinner', days: 3, from: '<a>', to: '<c>' } });
  assert.equal(ok(['a', 'b'], { keepMeals: true }).key, 'diary.copy.toast_days');
});

test('every new key is in en.json, US English, no em dashes, Title Case labels', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  const { copy, move, day_picker: dp, actions } = en.diary;
  for (const k of ['title_selection', 'keep_meals', 'repeat', 'repeat_off', 'repeat_value', 'fewer_days', 'more_days', 'repeat_hint',
    'toast_day_meal', 'toast_day', 'toast_days_meal', 'toast_days', 'toast_partial', 'toast_failed',
    'toast_failed_reason', 'toast_nothing']) assert.equal(typeof copy[k], 'string', `copy.${k}`);
  for (const k of ['title', 'title_selection', 'moved', 'already_there', 'failed', 'failed_reason', 'both_days']) assert.equal(typeof move[k], 'string', `move.${k}`);
  assert.equal(dp.tomorrow, 'Tomorrow');
  assert.equal(en.diary.day_complete.status.yesterday, 'Yesterday');
  assert.equal(en.diary.day_complete.status.today, 'Today');
  assert.match(en.foods.detail.added_to_day, /\{rel, select, yesterday \{yesterday's \{meal\}\}/);
  assert.match(copy.toast_partial, /\{done\}.*\{total\}.*\{failed\}/);
  assert.equal(actions.copy_selected, 'Copy Selected');
  assert.equal(actions.move_selected, 'Move Selected');
  assert.equal(copy.keep_meals, "Keep Each Item's Meal");
  const all = [...Object.values(copy), ...Object.values(move), ...Object.values(dp), en.foods.detail.added_to_day, en.foods.detail.adding_to_day];
  for (const v of all) assert.ok(!v.includes(EMDASH), `no em dashes: ${v}`);
});

// ── The diary store, over an in-memory API ─────────────────────────────────

const storeUrl = new URL('../src/stores/diary.js', import.meta.url);
// A save for today runs the goal check, which imports modules this rig doesn't stub; it logs and carries on.
console.debug = () => {};
async function loadStore() {
  const days = new Map();
  const failOn = new Set();      // a save to this day throws, nothing written
  const lostAnswer = new Set();  // a save to this day is written, then throws
  const failReadOn = new Set();
  let failAfter = Infinity;      // every save after this many throws
  const saves = [];
  const api = {
    async getDiaryDate(date) {
      if (failReadOn.has(date)) throw new Error(`could not read ${date}`);
      return structuredClone(days.get(date) || { date, items: [], body_stats: {}, water: [] });
    },
    async saveDiaryDate(date, data) {
      saves.push({ date, data: structuredClone(data) });
      if (failOn.has(date) || saves.length > failAfter) throw new Error(`could not save ${date}`);
      // The server's per-day merge: items by uuid, tombstones remove.
      const prior = days.get(date)?.items || [];
      const sent = data.items || [];
      const gone = new Set(data.deleted_uuids?.items || []);
      const sentIds = new Set(sent.map(it => it.uuid).filter(Boolean));
      const sentRows = new Set(sent.map(it => JSON.stringify(it)));
      // A row with no uuid that isn't sent back stays (the real merge gives it one and keeps it).
      const kept = prior.filter(it => (it.uuid ? !gone.has(it.uuid) && !sentIds.has(it.uuid) : !sentRows.has(JSON.stringify(it))));
      const day = { ...structuredClone(data), items: [...kept, ...structuredClone(sent)].filter(it => !gone.has(it.uuid)), date };
      delete day.deleted_uuids;
      days.set(date, day);
      if (lostAnswer.has(date)) throw new Error(`no answer from ${date}`);
      return structuredClone(day);
    },
  };
  globalThis.__ntCopyTest = { api, used: [] };
  // Specifiers in double quotes: encodeURIComponent leaves ' alone.
  const stub = (body) => JSON.stringify(`data:text/javascript,${encodeURIComponent(body)}`);
  const swaps = {
    "'svelte/store'": JSON.stringify(import.meta.resolve('svelte/store')),
    // Stub modules are cached by URL across tests, so each reads the current rig.
    "'../lib/api.js'": stub('export const NtApi = new Proxy({}, { get: (_, k) => globalThis.__ntCopyTest.api[k] });'),
    "'../lib/nutrition.js'": stub('export const Nutrition = { sum: () => ({}), calculate: () => ({}) };'),
    "'../lib/db.js'": stub(`export const DB = { getSetting: (k, d) => d };
      export function localDateStr(d = new Date()) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }`),
    "'../lib/platform.js'": stub('export const isNative = false; export const resolveAssetUrl = u => u;'),
    "'../lib/item-source.js'": stub('export const itemSourceRef = () => null;'),
    "'../lib/catalog-kind.js'": stub('export const countsUseHere = () => true; export const markCatalogItemUsed = async (api, kind, item, date) => { globalThis.__ntCopyTest.used.push(date); };'),
    "'../lib/diary-copy.js'": JSON.stringify(String(new URL('../src/lib/diary-copy.js', import.meta.url))),
  };
  let src = readFileSync(storeUrl, 'utf8');
  for (const [from, to] of Object.entries(swaps)) {
    assert.ok(src.includes(`from ${from}`), `diary.js still imports ${from}`);
    src = src.split(`from ${from}`).join(`from ${to}`);
  }
  const store = await import(`data:text/javascript,${encodeURIComponent(src)}#${Math.random()}`);
  const get = (s) => { let v; s.subscribe(x => v = x)(); return v; };
  return { store, days, failOn, lostAnswer, failReadOn, saves, get, failAfterSaves: n => { failAfter = saves.length + n; } };
}

const VIEW = '2026-10-28';
const seedView = (days) => days.set(VIEW, {
  date: VIEW, body_stats: {}, water: [], notes: 'keep me',
  items: [
    { uuid: 'u0', id: 11, food_server_id: 11, meal: 0, name: 'Oats', quantity: 40, unit: 'g', nutrition: { calories: 150 } },
    { uuid: 'u1', id: 12, food_server_id: 12, meal: 0, name: 'Milk', quantity: 200, unit: 'ml', nutrition: { calories: 90 } },
    { uuid: 'u2', type: 'quick_calories', meal: 1, name: 'Quick Calories', nutrition: { calories: 300 } },
    { uuid: 'u3', id: 13, food_server_id: 13, meal: 2, name: 'Rice', quantity: 150, unit: 'g', nutrition: { calories: 200 } },
  ],
});
async function viewing() {
  const rig = await loadStore();
  seedView(rig.days);
  rig.store.currentDate.set(VIEW);
  await rig.store.loadEntry(VIEW);
  rig.rows = (...idx) => rig.get(rig.store.currentEntry).items.map((it, i) => ({ ...it, _i: i })).filter(it => idx.includes(it._i));
  return rig;
}
const names = (days, d) => (days.get(d)?.items || []).map(it => `${it.name}@${it.meal}`);

test('selection copy across meals, each to its own meal, for 3 days', async () => {
  const { store, days, rows } = await viewing();
  days.set('2026-10-30', { date: '2026-10-30', items: [{ uuid: 'there', meal: 2, name: 'Already' }], body_stats: {}, water: [], notes: 'theirs' });
  const dates = repeatDates('2026-10-29', 2);
  const r = await store.copyItemsToDates(rows(0, 2, 3), dates, null);
  assert.deepEqual(r.copied, dates);
  assert.deepEqual(r.failed, []);
  assert.equal(r.items, 3);
  const uuids = new Set();
  for (const d of dates) {
    const its = days.get(d).items.filter(it => it.uuid !== 'there');
    assert.deepEqual(its.map(it => [it.name, it.meal]), [['Oats', 0], ['Quick Calories', 1], ['Rice', 2]], d);
    for (const it of its) {
      assert.equal('_i' in it, false);
      assert.equal('id' in it, false, 'ids are dropped, as Copy drops them');
      assert.ok(!['u0', 'u2', 'u3'].includes(it.uuid));
      uuids.add(it.uuid);
    }
  }
  assert.equal(uuids.size, 9, 'every copy on every day is its own item');
  assert.equal(days.get('2026-10-30').items[0].uuid, 'there', 'what the day had stays');
  assert.equal(days.get('2026-10-30').notes, 'theirs');
  assert.equal(days.get(VIEW).items.length, 4, 'the day copied from is unchanged');
});

test('selection copy into one meal; onto the same day it is not copied again', async () => {
  const { store, days, get, rows } = await viewing();
  const r = await store.copyItemsToDates(rows(1, 3), repeatDates(VIEW, 2), 1);
  assert.equal(r.copied.length, 3);
  const view = days.get(VIEW).items;
  assert.equal(view.length, 6, '4 before, 2 copies, not 4');
  assert.deepEqual(view.slice(4).map(it => [it.name, it.meal]), [['Milk', 1], ['Rice', 1]]);
  assert.equal(get(store.currentEntry).items.length, 6, 'the viewed day shows its copies at once');
  for (const d of ['2026-10-29', '2026-10-30']) assert.equal(days.get(d).items.length, 2, d);
});

test('meal copy repeated: read once, so copying onto its own day does not grow the next days', async () => {
  const { store, days } = await viewing();
  const r = await store.copyMealToDates(0, repeatDates(VIEW, 3), 0);
  assert.equal(r.copied.length, 4);
  assert.equal(r.items, 2);
  assert.equal(days.get(VIEW).items.filter(it => it.meal === 0).length, 4);
  for (const d of repeatDates('2026-10-29', 2)) assert.deepEqual(days.get(d).items.map(it => it.name), ['Oats', 'Milk'], d);
  const empty = await store.copyMealToDates(5, ['2026-11-05'], 0);
  assert.equal(empty.nothing, true);
  assert.equal(days.has('2026-11-05'), false, 'an empty meal writes nothing');
});

test('a day that fails is reported, the others keep their copies', async () => {
  const { store, days, failOn, rows } = await viewing();
  failOn.add('2026-10-30');
  const dates = repeatDates('2026-10-29', 2);
  const r = await store.copyItemsToDates(rows(0), dates, null);
  assert.deepEqual(r.copied, ['2026-10-29', '2026-10-31']);
  assert.deepEqual(r.failed.map(f => f.date), ['2026-10-30']);
  assert.equal(days.has('2026-10-30'), false);
  const o = copyOutcome(r, { keepMeals: true });
  assert.equal(o.level, 'error');
  assert.deepEqual(o.values, { n: 1, done: 2, total: 3, failed: '2026-10-30' });
});

test('move selected within the day: across meals to one meal', async () => {
  const { store, days, get } = await viewing();
  const n = await store.moveDiaryItemsToMeal([0, 2, 3], 2);
  assert.equal(n, 2, 'Rice was already in meal 2');
  assert.deepEqual(days.get(VIEW).items.map(it => [it.uuid, it.meal]), [['u0', 2], ['u1', 0], ['u2', 2], ['u3', 2]]);
  assert.equal(days.get(VIEW).notes, 'keep me');
  assert.deepEqual(get(store.currentEntry).items.map(it => it.meal), [2, 0, 2, 2]);
  assert.equal(await store.moveDiaryItemsToMeal([0], 2), 0, 'nothing to move: nothing saved');
  const same = await store.moveDiaryItemsToDate([1], VIEW, 3);
  assert.deepEqual(same, { moved: 1, status: 'ok', error: null }, 'the viewed day: the same in-day move');
  assert.equal(days.get(VIEW).items.length, 4);
});

test('move to another day: written there first, then removed here, nothing else touched', async () => {
  const { store, days, get, saves } = await viewing();
  days.set('2026-10-27', { date: '2026-10-27', items: [{ uuid: 'y', meal: 2, name: 'Pasta' }], body_stats: {}, water: [], notes: 'yday' });
  const r = await store.moveDiaryItemsToDate([0, 2], '2026-10-27', 2);
  assert.deepEqual(r, { moved: 2, status: 'ok', error: null });
  assert.deepEqual(saves.map(s => s.date), ['2026-10-27', VIEW], 'the other day is saved first');
  assert.deepEqual(names(days, '2026-10-27'), ['Pasta@2', 'Oats@2', 'Quick Calories@2']);
  assert.equal(days.get('2026-10-27').notes, 'yday');
  assert.deepEqual(names(days, VIEW), ['Milk@0', 'Rice@2']);
  assert.deepEqual(saves[1].data.deleted_uuids.items, ['u0', 'u2'], 'removed the way Delete removes');
  assert.deepEqual(get(store.currentEntry).items.map(it => it.name), ['Milk', 'Rice']);
  const moved = days.get('2026-10-27').items.slice(1);
  assert.ok(moved.every(it => !['u0', 'u2'].includes(it.uuid)), 'new uuids on the new day');
  assert.equal(moved[0].food_server_id, 11, 'the rest of the item stays');
  assert.equal(moved[0].quantity, 40);
});

test('move to another day: removed by uuid from the day as saved now, not the rows shown', async () => {
  const { store, days } = await viewing();
  // Another device changed the day after it was shown here.
  const d = days.get(VIEW);
  days.set(VIEW, { ...d, items: [{ uuid: 'other', meal: 3, name: 'Tea' }, ...d.items.slice(1).reverse(), d.items[0]] });
  const r = await store.moveDiaryItemsToDate([0], '2026-10-29', 1);
  assert.equal(r.status, 'ok');
  assert.deepEqual(names(days, '2026-10-29'), ['Oats@1']);
  assert.deepEqual(names(days, VIEW).sort(), ['Milk@0', 'Quick Calories@1', 'Rice@2', 'Tea@3']);
});

test('move to another day: a row with no uuid the server keeps is reported on both days', async () => {
  const { store, days, get } = await viewing();
  const d = days.get(VIEW);
  days.set(VIEW, { ...d, items: [{ name: 'Old', meal: 0, addedAt: 'a' }, ...d.items] });
  await store.loadEntry(VIEW);
  assert.equal(get(store.currentEntry).items[0].name, 'Old');
  const r = await store.moveDiaryItemsToDate([0], '2026-10-29', 1);
  assert.equal(r.status, 'both', 'never says moved while it is still here');
  assert.deepEqual(names(days, '2026-10-29'), ['Old@1']);
});

test('move to another day: a twin sharing the uuid is not deleted with it', async () => {
  const { store, days, saves } = await viewing();
  const d = days.get(VIEW);
  days.set(VIEW, { ...d, items: [...d.items, { ...d.items[0], name: 'Oats', meal: 1 }] });
  await store.loadEntry(VIEW);
  const r = await store.moveDiaryItemsToDate([0], '2026-10-29', 2);
  assert.notEqual(r.status, 'failed');
  assert.ok(!saves.at(-1).data.deleted_uuids.items.includes('u0'), 'the shared uuid is not sent as deleted');
  assert.ok(names(days, VIEW).includes('Oats@1'), 'the twin stays');
  assert.deepEqual(names(days, '2026-10-29'), ['Oats@2']);
});

test('move to another day: if that day cannot be written, nothing is removed', async () => {
  const { store, days, failOn } = await viewing();
  failOn.add('2026-10-29');
  const r = await store.moveDiaryItemsToDate([0, 1], '2026-10-29', 0);
  assert.equal(r.status, 'failed');
  assert.equal(r.moved, 0);
  assert.match(r.error.message, /could not save 2026-10-29/);
  assert.equal(days.has('2026-10-29'), false);
  assert.equal(days.get(VIEW).items.length, 4, 'every item still here');
});

test('move to another day: if removing here fails, the copies there are taken back', async () => {
  const { store, days, failOn } = await viewing();
  failOn.add(VIEW);
  const r = await store.moveDiaryItemsToDate([3], '2026-10-29', 1);
  assert.equal(r.status, 'failed');
  assert.deepEqual(names(days, '2026-10-29'), [], 'not on both days');
  assert.equal(days.get(VIEW).items.length, 4, 'still here, once');
});

test('move to another day: if neither the removal nor the take-back work, it says both days have them', async () => {
  const { store, days, failAfterSaves } = await viewing();
  failAfterSaves(1); // the write to the other day works, every save after fails
  const r = await store.moveDiaryItemsToDate([3], '2026-10-29', 1);
  assert.equal(r.status, 'both');
  assert.deepEqual(names(days, '2026-10-29'), ['Rice@1']);
  assert.equal(days.get(VIEW).items.length, 4, 'never on neither day');
});

test('move to another day: a removal whose answer was lost is checked, never undone blindly', async () => {
  const { store, days, lostAnswer, get } = await viewing();
  lostAnswer.add(VIEW);
  const r = await store.moveDiaryItemsToDate([3], '2026-10-29', 1);
  assert.deepEqual(r, { moved: 1, status: 'ok', error: null });
  assert.deepEqual(names(days, '2026-10-29'), ['Rice@1'], 'kept there: the removal here did go through');
  assert.deepEqual(names(days, VIEW), ['Oats@0', 'Milk@0', 'Quick Calories@1']);
  assert.equal(get(store.currentEntry).items.length, 3);
});

test('move to another day: if it cannot be told, both days keep them (never neither)', async () => {
  const { store, days, failOn, failReadOn } = await viewing();
  failOn.add(VIEW);
  const pending = store.moveDiaryItemsToDate([3], '2026-10-29', 1);
  failReadOn.add(VIEW); // the check after the failed removal can't read this day
  const r = await pending;
  assert.equal(r.status, 'both');
  assert.deepEqual(names(days, '2026-10-29'), ['Rice@1']);
  assert.equal(days.get(VIEW).items.length, 4);
});

test('single item Copy is unchanged, and a selection copy matches it item for item', async () => {
  const { store, days, get } = await viewing();
  const actionItem = { ...get(store.currentEntry).items[1], _i: 1 };
  // Exactly what Diary's Copy does for one item.
  const { _i, id, ...rest } = actionItem;
  await store.addDiaryItem(rest, 3, '2026-11-02');
  await store.copyItemsToDates([actionItem], ['2026-11-03'], 3);
  const one = days.get('2026-11-02').items[0];
  const sel = days.get('2026-11-03').items[0];
  const strip = ({ uuid, addedAt, ...x }) => x;
  assert.deepEqual(strip(sel), strip(one));
  assert.equal(one.meal, 3);
  assert.equal(one.food_server_id, 12);
  assert.equal('id' in one, false);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('Diary: Move and Copy next to Delete, Keep Each Item\'s Meal, repeat for every mode', () => {
  const diary = read('../src/routes/Diary.svelte');
  const bar = diary.slice(diary.indexOf('class="diary-topbar-actions"'), diary.indexOf('{:else}', diary.indexOf('class="diary-topbar-actions"')));
  const order = ['cancel_selection', 'move_selected', 'copy_selected', 'delete_selected'].map(k => bar.indexOf(`diary.actions.${k}`));
  assert.ok(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]), 'Cancel, Move, Copy, Delete');
  assert.match(diary, /copyMode = 'selection';\s*copyDate = localDateStr\(\);\s*copyMeal = -1;/);
  assert.match(diary, /<option value=\{-1\}>\{\$_\('diary\.copy\.keep_meals'\)\}<\/option>/);
  assert.match(diary, /const dates = repeatDates\(copyDate, copyRepeat\);/);
  assert.equal((diary.match(/^ +copyRepeat = 0;$/gm) || []).length, 3, 'every way into the sheet starts with repeat off');
  assert.match(diary, /const \{ _i, id, \.\.\.rest \} = actionItem;\s*result = await copyToDays\(dates, d => addDiaryItem\(rest, targetMeal, d\)/,
    'one item is still copied with addDiaryItem, once per day');
  // After Copy or Move, Select Multiple ends (unless nothing happened).
  assert.match(diary, /if \(copyMode === 'selection'\) exitSelectMode\(\);/);
  assert.match(diary, /if \(await _moveRows\(\[\.\.\.selectedItems\], moveDate \|\| \$currentDate, to\)\) exitSelectMode\(\);/);
  // Another day's rows aren't this selection.
  assert.match(diary, /\$: if \(\$currentDate !== _selectDate\) \{ _selectDate = \$currentDate; if \(selectMode\) exitSelectMode\(\); \}/);
});

test('one DayPicker everywhere a day is chosen; Move starts on the viewed day', () => {
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /<DayPicker bind:value=\{copyDate\}/, 'Copy sheet');
  assert.equal((diary.match(/<DayPicker bind:value=\{moveDate\}/g) || []).length, 2, 'Move one item, Move a selection');
  assert.match(diary, /function _openMove\(setter\) \{\s*moveDate = \$currentDate;/);
  assert.equal((diary.match(/_openMove\(\(\) => show(MoveToMeal|MoveSelected) = true\)/g) || []).length, 2);
  // Same day: the single move is the update it always was.
  assert.match(diary, /const date = moveDate \|\| \$currentDate;[\s\S]*?if \(date === \$currentDate\) \{[\s\S]*?await updateDiaryItem\(actionItem\._i, \{ meal: mealIdx \}\);/);

  const sheet = read('../src/components/ui/FoodDetailSheet.svelte');
  assert.match(sheet, /_addDay = \$diaryDate \|\| localDateStr\(\);\s*_mealPickerOpen = true;/, 'starts on the Diary\'s day');
  assert.match(sheet, /<DayPicker bind:value=\{_addDay\} \/>/);
  assert.match(sheet, /dispatch\('addToDiary', \{ food: _displayFood, meal, kind, date: _addDay/);

  const picker = read('../src/components/ui/DayPicker.svelte');
  assert.match(picker, /diary\.day_complete\.status\.yesterday[\s\S]*diary\.day_complete\.status\.today[\s\S]*diary\.day_picker\.tomorrow/);
  assert.match(picker, /class:on=\{value === c\.day\}/, 'the chip for the picked date lights, or none');
  assert.match(picker, /<DateInput bind:value pickerLayer=\{130\} ariaLabel=/, 'its calendar opens above an action sheet (120)');
  assert.match(read('../src/components/ui/Sheet.svelte'), /style=\{layer != null \? `z-index:\$\{layer\}` : null\}/);
  assert.match(read('../src/components/ui/ActionSheet.svelte'), /<slot name="header" \/>/);
});

test('a second tap on a closing action sheet does nothing; the selection follows its items', () => {
  assert.match(read('../src/components/ui/ActionSheet.svelte'), /const pick {5}= \(a\) => \{ if \(!open\) return; open = false;/);
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /async function moveItemToMeal\(e\) \{[\s\S]*?_selBusy\) return;/, 'one move at a time');
  assert.match(diary, /function _followSelection\(ent\) \{[\s\S]*?if \(it\?\.uuid && want\.has\(it\.uuid\)\) next\.add\(i\);/);
  assert.match(diary, /disabled=\{selectedItems\.size === 0 \|\| _selBusy\}\s*on:click=\{\(\) => showMultiDeleteDialog = true\}/);
});

test('Foods: Add to Diary logs to the picked day on every path, pick mode untouched', () => {
  const foods = read('../src/routes/Foods.svelte');
  const fn = foods.slice(foods.indexOf('async function onDetailAddToDiary'), foods.indexOf('function openMealEditor'));
  assert.match(fn, /const day = e\.detail\.date \|\| \$diaryDate \|\| localDateStr\(\);/);
  assert.match(fn, /pickDate = day;/, 'a saved meal and the quantity sheet log to pickDate');
  assert.doesNotMatch(fn, /pickDate = localDateStr\(\)/, 'no longer today regardless');
  assert.match(fn, /await addDiaryItem\(item, chosenMeal, day, \{ kind: savedKind \}\);/, 'the no-prompt add');
  assert.match(fn, /showSuccess\(_addedToMsg\('foods\.detail\.added_to_day'\)\)/);
  // The add sheet: in pick mode it goes back to the Diary as before.
  const add = foods.slice(foods.indexOf('async function _addFoodToDiary('), foods.indexOf('function toggleSelect'));
  assert.match(add, /if \(!pickMode\) \{[\s\S]*?showSuccess\(_addedToMsg\('foods\.detail\.added_to_day'\)\);\s*return;\s*\}[\s\S]*history\.back\(\);/);
  assert.match(foods, /\$: pickDate  = params\.date;/, 'pick mode keeps the Diary\'s date from the link');
  // From the Diary's + (pick mode) the sheet names no day, as before; from a
  // food's sheet, or a shortcut's add screen (#278), it does.
  assert.match(foods, /\{#if \(!pickMode \|\| viaShortcut\) && showQtyPrompt\}[\s\S]*?foods\.detail\.adding_to_day/);
});
