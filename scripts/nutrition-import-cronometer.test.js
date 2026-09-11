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

test('the Daily Nutrition export gets a message naming the right export', () => {
  for (const header of [DAILY, DAILY.replace('Date,Group,', 'Date,')]) {
    const text = `${header}\n2026-09-08,Breakfast,512.3,0,95,0,0,410,0.4,2.1,120,300,210,6.1,50,48,12,20,31,false\n`;
    assert.throws(() => parseCronometer(text), (e) =>
      /Daily Nutrition export/.test(e.message) && /Export Food & Recipe Entries/.test(e.message));
  }
});

test('an unrelated CSV lists the columns it actually found', () => {
  assert.throws(() => parseCronometer('Weight,Body Fat,Waist\n80,20,85\n'), (e) =>
    /Food & Recipe Entries/.test(e.message) && /found: Weight, Body Fat, Waist/.test(e.message));
});

test('error messages shown to users contain no em-dashes', () => {
  for (const text of [`${DAILY}\n`, 'A,B\n1,2\n']) {
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

test('the upload route no longer looks at the file name', () => {
  const route = readFileSync(new URL('../server/routes/nutrition-import.js', import.meta.url), 'utf8');
  const extract = route.slice(route.indexOf('function _extractText'), route.indexOf('function _parse'));
  assert.match(extract, /isZipBuffer\(file\.buffer\)/);
  assert.doesNotMatch(extract, /originalname|endsWith\('\.zip'\)/);
});
