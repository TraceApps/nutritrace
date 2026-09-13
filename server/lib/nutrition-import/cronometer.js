/**
 * Cronometer CSV adapter. Handles both exports that carry diary data.
 *
 * 1. "Export Food & Recipe Entries" (downloads as servings.csv)
 *      Day, Time, Group, Food Name, Amount, <nutrients...>, Category
 *    One row per food. The best import when the nutrients are present.
 *
 *    Cronometer has stopped including the nutrient columns in this export,
 *    at least on free accounts: measured on three separate accounts in
 *    August and September 2026, it arrives as just
 *      Day, Time, Group, Food Name, Amount, Category
 *    with no calories at all. Such a file cannot become diary entries, and
 *    importing it as zeros would be confidently wrong, so it is refused
 *    with a message pointing at the export that does have numbers.
 *
 * 2. "Export Daily Nutrition" (downloads as dailysummary.csv)
 *      Date, [Group,] <nutrients...>, Completed
 *    Totals only. With "Include diary group rows" ticked there is one row
 *    per meal plus a per-day `Total` row; without it, one row per day.
 *    Coarser than per-food, but on a free account it is the only export
 *    that carries nutrition at all.
 *
 * Quirks handled:
 *   - Header-keyed, never positional: column sets differ per export and
 *     gain new entries over time (Allulose, Added Sugars, Oxalate).
 *   - `Amount` is free text ("100 g", "1 cup", "1 medium banana (118 g)").
 *   - Both micro signs (U+00B5 and U+03BC) appear across versions.
 *   - `Time` is 12-hour with AM/PM and no leading zero ("8:33 AM").
 *   - `Energy` is blank, not 0, for zero-calorie entries (supplements,
 *     most spices). Those rows carry micronutrients, so they are kept.
 *   - Dates are the account's locale format, often M/D/YYYY, so the file
 *     is sampled to tell M/D from D/M rather than assuming.
 *   - `Group` is the meal name, user-renamable, and may be "Uncategorized".
 */
import {
  parseCsv, getField, parseDate, parseNumber, splitAmount, detectDateLocale,
} from './common.js';

const DAILY_TOTAL_NAME = 'Cronometer daily total';
const MEAL_TOTAL_NAME  = 'Cronometer total';

export function parseCronometer(text) {
  const { header, headerRaw, rows } = parseCsv(text);
  if (!header.length) throw new Error('Empty file');

  const hasFoodName = _hasH(header, 'food name') || _hasH(header, 'food');
  const hasEnergy   = _hasH(header, 'energy (kcal)') || _hasH(header, 'energy');
  const hasDay      = _hasH(header, 'day');
  const hasDate     = _hasH(header, 'date');

  if (hasFoodName && hasDay) {
    if (!hasEnergy) {
      throw new Error('This Food & Recipe Entries export lists your foods but has no nutrition columns, ' +
        'which is how Cronometer now exports it on some accounts. Use Export Daily Nutrition instead, ' +
        'with "Include diary group rows" ticked, to bring your totals per meal.');
    }
    return _parseServings(rows);
  }

  // Daily Nutrition: totals keyed by Date, no individual foods.
  if (!hasFoodName && (hasDate || hasDay) && (hasEnergy || _hasH(header, 'completed'))) {
    if (!hasEnergy) {
      throw new Error('This Daily Nutrition export has no Energy (kcal) column, so there are no numbers to import.');
    }
    return _parseDailySummary(rows, _hasH(header, 'group'));
  }

  const seen = headerRaw.filter(Boolean).slice(0, 6).join(', ');
  throw new Error("This doesn't look like a Cronometer export. Expected either Day and Food Name columns " +
    `(Export Food & Recipe Entries) or a Date column with nutrients (Export Daily Nutrition), but found: ${seen}` +
    `${headerRaw.length > 6 ? ', ...' : ''}.`);
}

// ── Food & Recipe Entries (one row per food) ─────────────────────────────

function _parseServings(rows) {
  const locale = detectDateLocale(rows.map(r => getField(r, 'day')));
  const out = [];
  for (const row of rows) {
    const dateStr = parseDate(getField(row, 'day'), locale);
    if (!dateStr) continue;
    const name = getField(row, 'food name', 'food');
    if (!name) continue;

    // Cronometer's "Amount" is the consumed amount ("750.00 g", "1 cup") and
    // the row's nutrition is the TOTAL for that consumption, not per 100 g and
    // not per serving. So the diary item is a single serving (quantity 1) with
    // the amount as a numeric portion plus a separate unit. Using the gram
    // count as quantity would let Nutrition.calculate multiply nutrition by
    // grams (the bug behind the "NaNg / 722903 kcal" reports).
    const split = splitAmount(getField(row, 'amount'));

    out.push({
      date: dateStr,
      time: _normTime(getField(row, 'time')),
      mealLabel: getField(row, 'group') || '',
      name,
      brand: null, // Cronometer puts the brand inside Food Name
      quantity: 1,
      portion: split.quantity,
      unit:    split.unit,
      nutrition: _nutritionFrom(row),
      notes: null,
      sourceRow: row._rowNum,
    });
  }
  return out;
}

// ── Daily Nutrition (totals per meal, or per day) ────────────────────────

function _parseDailySummary(rows, hasGroup) {
  const locale = detectDateLocale(rows.map(r => getField(r, 'date', 'day')));

  // Keep file order within each date: Cronometer writes the day's Total last.
  const byDate = new Map();
  for (const row of rows) {
    const dateStr = parseDate(getField(row, 'date', 'day'), locale);
    if (!dateStr) continue;
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    byDate.get(dateStr).push(row);
  }

  const out = [];
  for (const [dateStr, dateRows] of byDate) {
    const keep = hasGroup ? _withoutDayTotal(dateRows) : dateRows;
    for (const row of keep) {
      const group = hasGroup ? getField(row, 'group') : '';
      out.push({
        date: dateStr,
        time: null,
        // No Group column means the row is the whole day. It still has to go
        // somewhere, so it goes in the first meal where it reads as a header
        // for the day rather than being buried at the bottom.
        mealLabel: group,
        ...(hasGroup ? {} : { mealIndex: 0 }),
        name: hasGroup ? MEAL_TOTAL_NAME : DAILY_TOTAL_NAME,
        brand: null,
        quantity: 1,
        portion: 1,
        unit: hasGroup ? 'meal' : 'day',
        nutrition: _nutritionFrom(row),
        notes: null,
        sourceRow: row._rowNum,
      });
    }
  }
  return out;
}

/**
 * Drop the day's total row so its calories are not counted twice alongside
 * the per-meal rows it sums.
 *
 * Cronometer labels it "Total", but only in English, and a mislabelled or
 * translated total would silently double someone's day. So the label is
 * tried first, then the shape of the numbers: a last row that equals the
 * sum of the rows above it is the total, whatever it is called.
 */
function _withoutDayTotal(dateRows) {
  const labelled = dateRows.filter(r => /^total$/i.test(getField(r, 'group')));
  if (labelled.length) return dateRows.filter(r => !labelled.includes(r));
  if (dateRows.length < 2) return dateRows;

  const kcal = (r) => parseNumber(getField(r, 'energy (kcal)', 'energy')) ?? 0;
  const last = dateRows[dateRows.length - 1];
  const rest = dateRows.slice(0, -1);
  const sum  = rest.reduce((t, r) => t + kcal(r), 0);
  const lastKcal = kcal(last);
  const tolerance = Math.max(1, sum * 0.01);
  if (sum > 0 && Math.abs(lastKcal - sum) <= tolerance) return rest;
  return dateRows;
}

// ── Shared ───────────────────────────────────────────────────────────────

function _nutritionFrom(row) {
  // Blank energy means a zero-calorie entry, not a broken row.
  const nutrition = { calories: parseNumber(getField(row, 'energy (kcal)', 'energy')) ?? 0 };
  _norm(nutrition, 'fat',                  row, 'fat (g)');
  _norm(nutrition, 'saturated-fat',        row, 'saturated (g)', 'saturated fat (g)');
  _norm(nutrition, 'trans-fat',            row, 'trans-fats (g)', 'trans fat (g)');
  _norm(nutrition, 'monounsaturated-fat',  row, 'monounsaturated (g)');
  _norm(nutrition, 'polyunsaturated-fat',  row, 'polyunsaturated (g)');
  _norm(nutrition, 'cholesterol',          row, 'cholesterol (mg)');
  _norm(nutrition, 'sodium',               row, 'sodium (mg)');
  _norm(nutrition, 'potassium',            row, 'potassium (mg)');
  _norm(nutrition, 'carbohydrates',        row, 'carbs (g)');
  _norm(nutrition, 'fiber',                row, 'fiber (g)');
  _norm(nutrition, 'sugars',               row, 'sugars (g)');
  _norm(nutrition, 'added-sugars',         row, 'added sugars (g)');
  _norm(nutrition, 'proteins',             row, 'protein (g)');
  _norm(nutrition, 'calcium',              row, 'calcium (mg)');
  _norm(nutrition, 'iron',                 row, 'iron (mg)');
  _norm(nutrition, 'magnesium',            row, 'magnesium (mg)');
  _norm(nutrition, 'phosphorus',           row, 'phosphorus (mg)');
  _norm(nutrition, 'zinc',                 row, 'zinc (mg)');
  _norm(nutrition, 'caffeine',             row, 'caffeine (mg)');
  _norm(nutrition, 'alcohol',              row, 'alcohol (g)');
  // Vitamins (handle both micro-sign encodings)
  _norm(nutrition, 'vitamin-a',            row, 'vitamin a (iu)', 'vitamin a (µg)', 'vitamin a (μg)');
  _norm(nutrition, 'vitamin-c',            row, 'vitamin c (mg)');
  _norm(nutrition, 'vitamin-d',            row, 'vitamin d (iu)', 'vitamin d (µg)', 'vitamin d (μg)');
  _norm(nutrition, 'vitamin-e',            row, 'vitamin e (mg)');
  _norm(nutrition, 'vitamin-k',            row, 'vitamin k (µg)', 'vitamin k (μg)');
  _norm(nutrition, 'b1',                   row, 'b1 (thiamine) (mg)');
  _norm(nutrition, 'b2',                   row, 'b2 (riboflavin) (mg)');
  _norm(nutrition, 'b3',                   row, 'b3 (niacin) (mg)');
  _norm(nutrition, 'b6',                   row, 'b6 (pyridoxine) (mg)');
  _norm(nutrition, 'b9',                   row, 'folate (µg)', 'folate (μg)');
  _norm(nutrition, 'b12',                  row, 'b12 (cobalamin) (µg)', 'b12 (cobalamin) (μg)');
  return nutrition;
}

function _hasH(header, key) {
  return header.includes(key.toLowerCase());
}

function _norm(target, outKey, row, ...sourceKeys) {
  for (const k of sourceKeys) {
    const n = parseNumber(getField(row, k));
    if (n != null) { target[outKey] = n; return; }
  }
}

// Accepts "8:33 AM", "1:00 PM", "12:05 AM", "8:33am", "8:33 a.m." and 24-hour
// "20:15". AM/PM is applied only to 1-12 o'clock, so an already-24-hour value
// that also carries a marker ("20:15 PM") is left as 20:15.
function _normTime(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:([AaPp])\.?[Mm]\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const meridiem = m[3] ? m[3].toLowerCase() : null;
  if (meridiem && h >= 1 && h <= 12) h = (h % 12) + (meridiem === 'p' ? 12 : 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
