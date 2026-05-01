/**
 * MyFitnessPal "Meal Level Nutrition Details" CSV adapter.
 *
 * MFP delivers a ZIP via email (Premium-only as of 2026) containing several
 * CSVs: Exercise.csv, Measurements.csv, and the meal nutrition file
 * (commonly named "Nutritional Information.csv" or "Meal Level Nutrition
 * Details.csv" — name varies by export year). The route layer unzips and
 * picks the correct file before calling this adapter.
 *
 * Header (Premium, full):
 *   Date, Meal, Food, Note, Calories, Fat (g), Saturated Fat (g),
 *   Polyunsaturated Fat (g), Monounsaturated Fat (g), Trans Fat (g),
 *   Cholesterol (mg), Sodium (mg), Potassium (mg), Carbs (g), Fiber (g),
 *   Sugar (g), Protein (g), Vitamin A, Vitamin C, Calcium, Iron
 *
 * Quirks handled:
 *   - `Food` smashes brand+name with a literal comma inside quotes
 *     ("Trader Joe's, Greek Yogurt"). Brand is split off before the first
 *     comma when the name has the canonical "Brand, Name" shape.
 *   - Date format follows account locale — auto-detected.
 *   - `Meal` can be user-renamed on Premium ("Snacks" → "Pre-workout") so
 *     we keep the raw label and let the route's mealNames mapper handle it.
 *   - Header column presence varies by Premium tier — header-keyed parsing.
 */
import { parseCsv, getField, parseDate, detectDateLocale, parseNumber } from './common.js';

export function parseMfp(text) {
  const { header, rows } = parseCsv(text);
  if (!header.length) throw new Error('Empty file');

  const hasCore =
    header.includes('date') &&
    header.includes('meal') &&
    (header.includes('food') || header.includes('food name')) &&
    header.includes('calories');
  if (!hasCore) {
    throw new Error('Does not look like a MyFitnessPal meal-nutrition export — expected Date + Meal + Food + Calories columns');
  }

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
