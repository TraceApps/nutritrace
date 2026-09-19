/**
 * Cronometer import. Fixtures follow the shape of a real "Export Food &
 * Recipe Entries" download (servings.csv) and the Daily Nutrition header a
 * user actually uploaded, with made-up food rows.
 *
 * Covers the bugs found against real exports: evening times saved as
 * morning (AM/PM ignored), zero-calorie supplements dropped because
 * Cronometer leaves Energy blank, and the Daily Nutrition export getting a
 * generic error that pointed at a menu option Cronometer had renamed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCronometer } from '../server/lib/nutrition-import/cronometer.js';
import { isZipBuffer } from '../server/lib/nutrition-import/common.js';

const MICRO = String.fromCharCode(0xB5);   // µ, as Cronometer writes it in headers
const EM_DASH = String.fromCharCode(8212);
const BOM = String.fromCharCode(0xFEFF);

const HEADER = [
  'Day', 'Time', 'Group', 'Food Name', 'Amount', 'Energy (kcal)', 'Caffeine (mg)', 'Water (g)',
  `B12 (Cobalamin) (${MICRO}g)`, 'Vitamin D (IU)', `Vitamin K (${MICRO}g)`, 'Magnesium (mg)', 'Sodium (mg)',
  'Carbs (g)', 'Fiber (g)', 'Sugars (g)', 'Fat (g)', 'Saturated (g)', 'Protein (g)', 'Category',
];
// One entry per interesting case. Energy is '' for the supplement, as Cronometer exports it.
const ROWS = [
  ['2026-09-08', '8:33 AM',  'Breakfast', 'Brazil Nuts, Unsalted', '2.00 each', '62.28', '0', '0.3', '0', '0', '0', '37.6', '0.3', '1.1', '0.7', '0.2', '6.3', '1.4', '1.4', 'Nuts and Seeds'],
  ['2026-09-08', '8:34 AM',  'Breakfast', 'Sunflower Seeds, Oil Roasted, Salted', '0.75 tbsp, whole pieces', '37.46', '0', '0.1', '0', '0', '0', '14.2', '25.6', '1.5', '0.7', '0.2', '3.3', '0.3', '1.3', 'Nuts and Seeds'],
  ['2026-09-08', '8:35 AM',  'Breakfast', 'D3 + K2 Softgels', '1.00 Liquid Veggie Softgel', '', '', '', '', '5000', '100', '', '', '', '', '', '', '', '', 'Supplements'],
  ['2026-09-08', '1:00 PM',  'Lunch',     'Chicken Breast, Roasted', '120.00 g', '198.00', '0', '78.0', '0.4', '6', '0', '34.8', '88.8', '0', '0', '0', '4.3', '1.2', '37.2', 'Poultry'],
  ['2026-09-08', '12:30 PM', 'Lunch',     'Apple, Raw', '1.00 medium', '94.64', '0', '156.0', '0', '0', '4.0', '9.1', '1.8', '25.1', '4.4', '18.9', '0.3', '0.1', '0.5', 'Fruits'],
  ['2026-09-08', '7:45 PM',  'Dinner',    'Salmon, Atlantic, Baked', '150.00 g', '309.00', '0', '97.0', '4.2', '526', '0.2', '46.5', '91.5', '0', '0', '0', '18.5', '3.7', '33.1', 'Fish'],
  ['2026-09-09', '12:05 AM', 'Snacks',    'Greek Yogurt, Plain', '170.00 g', '100.30', '0', '145.1', '1.3', '0', '0', '18.7', '61.2', '6.1', '0', '5.5', '0.7', '0.2', '17.3', 'Dairy'],
];
const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (header, rows, eol = '\n') => [header, ...rows].map(r => r.map(q).join(',')).join(eol) + eol;

test('a real-shaped Food & Recipe Entries export imports every row', () => {
  const out = parseCronometer(csv(HEADER, ROWS));
  assert.equal(out.length, ROWS.length);
  const nuts = out[0];
  assert.equal(nuts.date, '2026-09-08');
  assert.equal(nuts.mealLabel, 'Breakfast');
  assert.equal(nuts.name, 'Brazil Nuts, Unsalted');
  assert.equal(nuts.nutrition.calories, 62.28);
  assert.equal(nuts.nutrition.proteins, 1.4);
});

test('zero-calorie supplements are kept with their micronutrients (Energy is blank)', () => {
  const supp = parseCronometer(csv(HEADER, ROWS)).find(o => o.name === 'D3 + K2 Softgels');
  assert.ok(supp, 'supplement row must not be dropped');
  assert.equal(supp.nutrition.calories, 0);
  assert.equal(supp.nutrition['vitamin-d'], 5000);
  assert.equal(supp.nutrition['vitamin-k'], 100);
  assert.equal(supp.portion, 1);
  assert.equal(supp.unit, 'Liquid Veggie Softgel');
});

test('12-hour times keep AM/PM', () => {
  const byName = Object.fromEntries(parseCronometer(csv(HEADER, ROWS)).map(o => [o.name, o.time]));
  assert.equal(byName['Brazil Nuts, Unsalted'], '08:33');
  assert.equal(byName['Chicken Breast, Roasted'], '13:00');
  assert.equal(byName['Apple, Raw'], '12:30');
  assert.equal(byName['Salmon, Atlantic, Baked'], '19:45');
  assert.equal(byName['Greek Yogurt, Plain'], '00:05');
});

test('other time spellings, and values that are not times', () => {
  const t = (time) => parseCronometer(csv(HEADER, [[ROWS[0][0], time, ...ROWS[0].slice(2)]]))[0].time;
  assert.equal(t('20:15'), '20:15');
  assert.equal(t('20:15 PM'), '20:15');
  assert.equal(t('8:33am'), '08:33');
  assert.equal(t('8:33 p.m.'), '20:33');
  assert.equal(t('07:05'), '07:05');
  assert.equal(t(''), null);
  assert.equal(t('noon'), null);
  assert.equal(t('25:00'), null);
});

test('commas inside quoted food names and amounts', () => {
  const seeds = parseCronometer(csv(HEADER, ROWS)).find(o => o.name.startsWith('Sunflower'));
  assert.equal(seeds.name, 'Sunflower Seeds, Oil Roasted, Salted');
  assert.equal(seeds.portion, 0.75);
  assert.equal(seeds.unit, 'tbsp, whole pieces');
});

test('byte order mark and Windows line endings', () => {
  const out = parseCronometer(BOM + csv(HEADER, ROWS, '\r\n'));
  assert.equal(out.length, ROWS.length);
  assert.equal(out[0].date, '2026-09-08');
});

// The header a user uploaded from Cronometer's "Export Daily Nutrition"
// (dailysummary.csv), with "Include diary group rows" ticked.
const DAILY = 'Date,Group,Energy (kcal),Alcohol (g),Caffeine (mg),Oxalate (mg),Phytate (mg),Water (g),' +
  `B1 (Thiamine) (mg),B12 (Cobalamin) (${MICRO}g),Folate (${MICRO}g),Vitamin A (${MICRO}g),Calcium (mg),Iron (mg),` +
  'Net Carbs (g),Carbs (g),Fiber (g),Sugars (g),Fat (g),Protein (g),Completed';

test('the real Daily Nutrition column set imports, micronutrients included', () => {
  // DAILY is the header a user pasted from their own export. Values follow
  // its column order; Oxalate, Phytate and Completed have no NutriTrace
  // equivalent and are ignored rather than misfiled.
  const row = (group, kcal) => `9/4/2026,${group},${kcal},0,95,12,5,410,0.4,2.1,120,300,210,6.1,45,50,5,20,15,25,false`;
  const out = parseCronometer([DAILY, row('Breakfast', '400'), row('Total', '400')].join('\n'));
  assert.equal(out.length, 1, 'the Total row is dropped');
  const n = out[0].nutrition;
  assert.equal(out[0].mealLabel, 'Breakfast');
  assert.equal(n.calories, 400);
  assert.equal(n.b12, 2.1);
  assert.equal(n.b9, 120);
  assert.equal(n['vitamin-a'], 300);
  assert.equal(n.calcium, 210);
  assert.equal(n.iron, 6.1);
  assert.equal(n.carbohydrates, 50);
  assert.equal(n.caffeine, 95);
  assert.equal(n.proteins, 25);
  assert.equal(n.completed, undefined);
});

// Real structure from a user's "Export Daily Nutrition" with "Include diary
// group rows" ticked: dates in M/D/YYYY, one row per meal, a per-day Total
// row last, and an Uncategorized group for food logged outside a meal.
const DAILY_COLS = 'Date,Group,Energy (kcal),Carbs (g),Fat (g),Protein (g),Sodium (mg),Completed';
const dailyRow = (date, group, kcal, extra = '50,20,30,900,false') => `${date},${group},${kcal},${extra}`;
const DAILY_GROUPED = [
  DAILY_COLS,
  dailyRow('9/4/2026', 'Breakfast', '400'),
  dailyRow('9/4/2026', 'Lunch', '600'),
  dailyRow('9/4/2026', 'Dinner', '700'),
  dailyRow('9/4/2026', 'Snacks', '164'),
  dailyRow('9/4/2026', 'Total', '1864'),
  dailyRow('9/5/2026', 'Uncategorized', '250'),
  dailyRow('9/5/2026', 'Breakfast', '350'),
  dailyRow('9/5/2026', 'Total', '600'),
].join('\n') + '\n';

test('Daily Nutrition with group rows imports one entry per meal', () => {
  const out = parseCronometer(DAILY_GROUPED);
  assert.equal(out.length, 6, 'four meals on the 4th, two on the 5th, no Total rows');
  assert.deepEqual(out.map(o => o.date), ['2026-09-04', '2026-09-04', '2026-09-04', '2026-09-04', '2026-09-05', '2026-09-05']);
  assert.deepEqual(out.slice(0, 4).map(o => o.mealLabel), ['Breakfast', 'Lunch', 'Dinner', 'Snacks']);
  assert.equal(out[0].name, 'Cronometer total');
  assert.equal(out[0].unit, 'meal');
  assert.equal(out[0].nutrition.calories, 400);
  assert.equal(out[0].nutrition.proteins, 30);
  assert.equal(out[4].mealLabel, 'Uncategorized');
});

test('the day Total row is dropped so calories are not counted twice', () => {
  const out = parseCronometer(DAILY_GROUPED);
  const sep4 = out.filter(o => o.date === '2026-09-04').reduce((t, o) => t + o.nutrition.calories, 0);
  assert.equal(sep4, 1864, 'meals must add up to the day Total, not double it');
  assert.ok(!out.some(o => o.mealLabel.toLowerCase() === 'total'));
});

test('a total row is still found when it is not called "Total"', () => {
  // Same numbers, non-English label. The sum gives it away.
  const csv = DAILY_GROUPED.replace(/,Total,/g, ',Gesamt,');
  const out = parseCronometer(csv);
  assert.equal(out.length, 6);
  assert.ok(!out.some(o => /gesamt/i.test(o.mealLabel)), 'translated total must not be imported');
});

test('a single meal plus its total keeps the meal, not the total', () => {
  const csv = [DAILY_COLS, dailyRow('9/6/2026', 'Dinner', '800'), dailyRow('9/6/2026', 'Total', '800')].join('\n');
  const out = parseCronometer(csv);
  assert.equal(out.length, 1);
  assert.equal(out[0].mealLabel, 'Dinner');
});

test('Daily Nutrition without group rows imports one entry per day, in the first meal', () => {
  const csv = [
    'Date,Energy (kcal),Carbs (g),Fat (g),Protein (g),Completed',
    '9/4/2026,1864,200,60,120,true',
    '9/5/2026,600,50,20,30,false',
  ].join('\n');
  const out = parseCronometer(csv);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Cronometer daily total');
  assert.equal(out[0].mealIndex, 0, 'no Group column means the row is the whole day');
  assert.equal(out[0].unit, 'day');
  assert.equal(out[0].date, '2026-09-04');
  assert.equal(out[0].nutrition.calories, 1864);
});

test('day-first dates are detected rather than assumed to be month-first', () => {
  const csv = [
    DAILY_COLS,
    dailyRow('13/4/2026', 'Breakfast', '400'),   // 13 can only be a day
    dailyRow('13/4/2026', 'Total', '400'),
    dailyRow('9/4/2026', 'Breakfast', '500'),
    dailyRow('9/4/2026', 'Total', '500'),
  ].join('\n');
  const dates = parseCronometer(csv).map(o => o.date);
  assert.deepEqual(dates, ['2026-04-13', '2026-04-09'], 'one unambiguous row settles the whole file');
});

test('a Food & Recipe Entries export with no nutrition says which export to use', () => {
  const csv = 'Day,Time,Group,Food Name,Amount,Category\n' +
    '2026-09-10,12:46 PM,Lunch,"Gomez, Buffalo Chicken Turtle with Ranch",1.00 serving,Custom\n';
  assert.throws(() => parseCronometer(csv), (e) =>
    /no nutrition columns/.test(e.message) && /Daily Nutrition/.test(e.message) && /diary group rows/.test(e.message));
});

test('an unrelated CSV lists the columns it actually found', () => {
  assert.throws(() => parseCronometer('Weight,Body Fat,Waist\n80,20,85\n'), (e) =>
    /Food & Recipe Entries/.test(e.message) && /Daily Nutrition/.test(e.message) &&
    /found: Weight, Body Fat, Waist/.test(e.message));
});

test('error messages shown to users contain no em-dashes', () => {
  for (const text of ['Day,Food Name,Amount\n2026-09-10,Rice,1 cup\n', 'A,B\n1,2\n']) {
    try { parseCronometer(text); assert.fail('should throw'); }
    catch (e) { assert.ok(!e.message.includes(EM_DASH), e.message); }
  }
});

test('ZIP detection reads the bytes, not the file name', () => {
  assert.equal(isZipBuffer(Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])), true);
  assert.equal(isZipBuffer(Buffer.from([0x50, 0x4B, 0x05, 0x06, 0x00, 0x00])), true);
  // A CSV whose first column starts with "PK" is still a CSV.
  assert.equal(isZipBuffer(Buffer.from('PK_ID,Name\n1,Apple\n')), false);
  assert.equal(isZipBuffer(Buffer.from('Day,Time,Group\n')), false);
  assert.equal(isZipBuffer(Buffer.from('PK')), false);
  assert.equal(isZipBuffer(Buffer.alloc(0)), false);
  assert.equal(isZipBuffer(undefined), false);
});

test('the route can place a row in an explicit meal slot', () => {
  const route = readFileSync(new URL('../server/routes/nutrition-import.js', import.meta.url), 'utf8');
  assert.match(route, /canonical\.mealIndex != null/);
});

test('the upload route no longer looks at the file name', () => {
  const route = readFileSync(new URL('../server/routes/nutrition-import.js', import.meta.url), 'utf8');
  const extract = route.slice(route.indexOf('function _extractText'), route.indexOf('function _parse'));
  assert.match(extract, /isZipBuffer\(file\.buffer\)/);
  assert.doesNotMatch(extract, /originalname|endsWith\('\.zip'\)/);
});
