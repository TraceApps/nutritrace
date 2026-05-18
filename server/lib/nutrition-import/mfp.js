/**
 * MyFitnessPal CSV adapter — two supported export shapes.
 *
 * MFP's Reports → Export flow (free + Premium, accessible at
 * https://www.myfitnesspal.com/reports/export) emails the user a file
 * after they pick a date range and click Export. The current export
 * shape is the "Nutrition-Summary" CSV, where rows are aggregated PER
 * MEAL PER DAY — no individual food breakdown — with these headers:
 *
 *   Date, Meal, Calories, Fat (g), Saturated Fat, Polyunsaturated Fat,
 *   Monounsaturated Fat, Trans Fat, Cholesterol, Sodium (mg), Potassium,
 *   Carbohydrates (g), Fiber, Sugar, Protein (g), Vitamin A, Vitamin C,
 *   Calcium, Iron, Note
 *
 * Note that the Summary export DROPS the unit suffix on most fields —
 * "Saturated Fat" instead of "Saturated Fat (g)" — so field lookups
 * tolerate both shapes.
 *
 * Older MFP exports (Premium "Meal Level Nutrition Details", year-
 * dependent, may still surface in some Privacy Center ZIPs) included a
 * Food column with per-food rows. The legacy parser kept around for
 * users who have those files. Detection is by presence of the Food
 * column on the header.
 *
 * What gets imported:
 *   - Summary path: one synthesized entry per meal-day, name =
 *     "<Meal> (MFP summary)", brand = "MyFitnessPal", aggregated
 *     macros + minerals preserved. Vitamins A/C/Calcium/Iron come as
 *     %DV and are skipped (not gram-equivalent).
 *   - Meal-level path: per-food rows with name + optional brand parsed
 *     from the "Brand, Name" convention, same nutrient set.
 *
 * Both paths emit the same { date, mealLabel, name, brand, nutrition,
 * notes, sourceRow } shape so the route layer treats them uniformly.
 */
import { parseCsv, getField, parseDate, detectDateLocale, parseNumber } from './common.js';

export function parseMfp(text) {
  const { header, rows } = parseCsv(text);
  if (!header.length) throw new Error('Empty file');

  const hasDate     = header.includes('date');
  const hasMeal     = header.includes('meal');
  const hasFood     = header.includes('food') || header.includes('food name');
  const hasCalories = header.includes('calories');

  // Two MFP export shapes are supported:
  //   - "Meal Level Nutrition Details" (Premium ZIP, per-food rows; has a
  //     Food column we use for name + brand)
  //   - "Nutrition-Summary" (Reports → Export, per-meal aggregated rows; no
  //     Food column, just Date+Meal+totals)
  // Detect which we're looking at and dispatch.
  if (!hasDate || !hasMeal || !hasCalories) {
    throw new Error(`Does not look like a MyFitnessPal export — expected Date + Meal + Calories columns, got: [${header.join(', ')}]`);
  }
  if (hasFood) return _parseMealLevel(rows);
  return _parseSummary(rows);
}

function _parseMealLevel(rows) {
  const dateLocale = detectDateLocale(rows.map(r => getField(r, 'date')));
  const out = [];

  for (const row of rows) {
    const dateStr = parseDate(getField(row, 'date'), dateLocale);
    if (!dateStr) continue;
    const foodRaw = getField(row, 'food', 'food name');
    if (!foodRaw) continue;
    const calories = parseNumber(getField(row, 'calories'));
    if (calories == null) continue;

    const { brand, name } = _splitBrandName(foodRaw);

    const nutrition = { calories };
    _n(nutrition, 'fat',                  row, 'fat (g)');
    _n(nutrition, 'saturated-fat',        row, 'saturated fat (g)');
    _n(nutrition, 'polyunsaturated-fat',  row, 'polyunsaturated fat (g)');
    _n(nutrition, 'monounsaturated-fat',  row, 'monounsaturated fat (g)');
    _n(nutrition, 'trans-fat',            row, 'trans fat (g)');
    _n(nutrition, 'cholesterol',          row, 'cholesterol (mg)');
    _n(nutrition, 'sodium',               row, 'sodium (mg)');
    _n(nutrition, 'potassium',            row, 'potassium (mg)');
    _n(nutrition, 'carbohydrates',        row, 'carbs (g)');
    _n(nutrition, 'fiber',                row, 'fiber (g)');
    _n(nutrition, 'sugars',               row, 'sugar (g)', 'sugars (g)');
    _n(nutrition, 'proteins',             row, 'protein (g)');
    // Vitamin A / C / Calcium / Iron come as %DV (no unit suffix in header) —
    // skip importing them; they're not gram-equivalent and would mislead.

    out.push({
      date: dateStr,
      time: null,
      mealLabel: getField(row, 'meal') || '',
      name,
      brand,
      quantity: 1, // MFP doesn't separate quantity; servings are baked into the row
      portion: null,
      nutrition,
      notes: getField(row, 'note', 'notes') || null,
      sourceRow: row._rowNum,
    });
  }
  return out;
}

/**
 * Nutrition-Summary export (from MFP Reports → Export). Rows are aggregated
 * per meal per day — no individual food breakdown — so we synthesize a
 * single entry per row labeled with the meal name, preserving the totals.
 * Column headers in this format drop the unit suffix on most fields
 * (e.g. "Saturated Fat" not "Saturated Fat (g)"), so the field lookups
 * tolerate both shapes.
 */
function _parseSummary(rows) {
  const dateLocale = detectDateLocale(rows.map(r => getField(r, 'date')));
  const out = [];

  for (const row of rows) {
    const dateStr = parseDate(getField(row, 'date'), dateLocale);
    if (!dateStr) continue;
    const calories = parseNumber(getField(row, 'calories'));
    if (calories == null) continue;
    const mealLabel = getField(row, 'meal') || '';

    const nutrition = { calories };
    _n(nutrition, 'fat',                  row, 'fat (g)', 'fat');
    _n(nutrition, 'saturated-fat',        row, 'saturated fat (g)', 'saturated fat');
    _n(nutrition, 'polyunsaturated-fat',  row, 'polyunsaturated fat (g)', 'polyunsaturated fat');
    _n(nutrition, 'monounsaturated-fat',  row, 'monounsaturated fat (g)', 'monounsaturated fat');
    _n(nutrition, 'trans-fat',            row, 'trans fat (g)', 'trans fat');
    _n(nutrition, 'cholesterol',          row, 'cholesterol (mg)', 'cholesterol');
    _n(nutrition, 'sodium',               row, 'sodium (mg)', 'sodium');
    _n(nutrition, 'potassium',            row, 'potassium (mg)', 'potassium');
    _n(nutrition, 'carbohydrates',        row, 'carbs (g)', 'carbohydrates (g)', 'carbohydrates');
    _n(nutrition, 'fiber',                row, 'fiber (g)', 'fiber');
    _n(nutrition, 'sugars',               row, 'sugar (g)', 'sugars (g)', 'sugar', 'sugars');
    _n(nutrition, 'proteins',             row, 'protein (g)', 'protein');

    out.push({
      date: dateStr,
      time: null,
      mealLabel,
      name: mealLabel ? `${mealLabel} (MFP summary)` : 'MFP summary',
      brand: 'MyFitnessPal',
      quantity: 1,
      portion: null,
      nutrition,
      notes: getField(row, 'note', 'notes') || null,
      sourceRow: row._rowNum,
    });
  }
  return out;
}

/**
 * Pick the meal-nutrition CSV from a list of filenames inside an MFP zip.
 * MFP has used "Nutritional Information.csv" and "Meal Level Nutrition
 * Details.csv" across export years — match liberally.
 */
export function pickMealCsv(filenames) {
  const candidates = filenames.filter(f =>
    f.toLowerCase().endsWith('.csv') &&
    (/nutrition/i.test(f) || /meal/i.test(f))
  );
  // Prefer "Meal Level" wording when present (current export variant)
  const preferred = candidates.find(f => /meal\s*level/i.test(f));
  return preferred || candidates[0] || null;
}

function _splitBrandName(raw) {
  const s = String(raw).trim();
  // MFP convention: "Brand, Name" — brand is the segment before the FIRST comma
  // when the name has 2+ comma-separated segments and the first looks like a brand
  // (capitalized, ≤30 chars). If unambiguous, return {brand: null, name: raw}.
  const commaIdx = s.indexOf(',');
  if (commaIdx < 0) return { brand: null, name: s };
  const head = s.slice(0, commaIdx).trim();
  const tail = s.slice(commaIdx + 1).trim();
  if (!head || !tail) return { brand: null, name: s };
  if (head.length > 30) return { brand: null, name: s };
  return { brand: head, name: tail };
}

function _n(target, outKey, row, ...sourceKeys) {
  for (const k of sourceKeys) {
    const n = parseNumber(getField(row, k));
    if (n != null) { target[outKey] = n; return; }
  }
}
