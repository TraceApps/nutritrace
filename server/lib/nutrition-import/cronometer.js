/**
 * Cronometer "Food & Recipe Entries" CSV adapter (downloads as servings.csv;
 * Cronometer's export menu used to call it "Servings").
 *
 * Header (verbatim, header-driven; column order may shift across versions):
 *   Day, Time, Group, Food Name, Amount, Energy (kcal), Caffeine (mg),
 *   Water (g), B1 (Thiamine) (mg), ..., Carbs (g), Fiber (g), ...,
 *   Fat (g), Cholesterol (mg), ..., Protein (g), ..., Category
 *
 * Verified column names are from the gocronometer Go module which scrapes
 * the same /export endpoint Cronometer's web UI uses.
 *
 * Quirks handled:
 *   - 70+ columns; some get added in newer versions (Allulose, Added Sugars).
 *     Parser is header-keyed, never positional.
 *   - `Amount` column is unstructured free text ("100 g", "1 cup", "1 medium banana (118 g)").
 *   - Both µ (U+00B5) and µ (U+03BC) appear in micronutrient column names across versions.
 *   - Energy is fixed kcal (Cronometer never exports kJ even when user prefs kJ).
 *   - `Group` is the meal name; user-renamable, defaults to Breakfast/Lunch/Dinner/Snacks.
 *   - `Time` is 12-hour with AM/PM and no leading zero ("8:33 AM", "1:00 PM").
 *   - `Energy` is blank, not 0, for zero-calorie entries (supplements, most
 *     spices). Those rows still carry micronutrients, so they are kept.
 */
import { parseCsv, getField, parseDate, parseNumber, splitAmount } from './common.js';

export function parseCronometer(text) {
  const { header, headerRaw, rows } = parseCsv(text);
  if (!header.length) throw new Error('Empty file');

  const hasFoodName = _hasH(header, 'food name') || _hasH(header, 'food');

  // Cronometer's Daily Nutrition export (dailysummary.csv) holds only totals:
  // Date, an optional Group column for per-meal totals, the nutrients, and
  // Completed. With no individual foods there is nothing to turn into diary
  // entries, and it is the export people most often grab by mistake, so name
  // it and point to the right one. Detected from the columns, never the
  // file name, so a renamed file gets the same help.
  if (!hasFoodName && _hasH(header, 'date') &&
      (_hasH(header, 'energy (kcal)') || _hasH(header, 'completed'))) {
    throw new Error("This is Cronometer's Daily Nutrition export, which only has daily totals. " +
      'NutriTrace imports your individual foods: in Cronometer, open Export Data and choose Export Food & Recipe Entries.');
  }

  const hasCore =
    _hasH(header, 'day') && hasFoodName &&
    (_hasH(header, 'energy (kcal)') || _hasH(header, 'energy'));
  if (!hasCore) {
    const seen = headerRaw.filter(Boolean).slice(0, 6).join(', ');
    throw new Error("This doesn't look like Cronometer's Food & Recipe Entries export. " +
      `Expected Day, Food Name and Energy (kcal) columns, but found: ${seen}${headerRaw.length > 6 ? ', ...' : ''}.`);
  }

  const out = [];
  for (const row of rows) {
    const dateStr = parseDate(getField(row, 'day'), 'auto');
    if (!dateStr) continue;
    const name = getField(row, 'food name', 'food');
    if (!name) continue;
    // Blank energy means a zero-calorie entry, not a broken row (see header).
    const calories = parseNumber(getField(row, 'energy (kcal)', 'energy')) ?? 0;

    // Cronometer's "Amount" field is the consumed amount ("750.00 g",
    // "1 cup"); the row's nutrition is the TOTAL for that consumption, not
    // per-100g and not per-serving. So the diary item should be a single
    // serving (quantity=1) with the parsed amount as a numeric `portion` +
    // separate `unit`. Setting quantity to the gram count would let
    // Nutrition.calculate multiply nutrition × grams (the bug behind
    // "NaNg · 722903 kcal" reports).
    const split = splitAmount(getField(row, 'amount'));

    const nutrition = { calories };
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
    // Vitamins (handle both µ encodings)
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

    out.push({
      date: dateStr,
      time: _normTime(getField(row, 'time')),
      mealLabel: getField(row, 'group') || '',
      name,
      brand: null, // Cronometer smashes brand into Food Name
      quantity: 1,
      portion: split.quantity,        // numeric — diary multiplies portion × quantity for display
      unit:    split.unit,            // unit string — "g", "cup", etc.
      nutrition,
      notes: null,
      sourceRow: row._rowNum,
    });
  }
  return out;
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
