/**
 * LoseIt weekly food log CSV adapter.
 *
 * Headers (community-confirmed; LoseIt has not published an official schema):
 *   Date, Name, Type, Quantity, Units, Calories,
 *   Fat (g), Protein (g), Carbohydrates (g),
 *   Saturated Fat (g), Sugars (g), Fiber (g),
 *   Cholesterol (mg), Sodium (mg)
 *
 * Quirks handled:
 *   - LoseIt exports per WEEK from web (one CSV per click). Users will paste
 *     concatenated multi-week files; the adapter just reads rows linearly.
 *   - Date = M/D/YYYY (US locale, app is US-centric).
 *   - `Type` ∈ {Breakfast, Lunch, Dinner, Snacks} — fixed enum, not user-renamable.
 *   - `Quantity` + `Units` are SEPARATE columns (cleaner than MFP).
 *   - No micronutrients even on Premium.
 */
import { parseCsv, getField, parseDate, parseNumber } from './common.js';

// Lose It spells units out ("Grams", "Fluid Ounces"); the app uses symbols so
// the diary can convert and scale them. Other units ("Cup", "Serving") stay as named.
const UNIT_SYMBOLS = {
  gram: 'g', milligram: 'mg', kilogram: 'kg', ounce: 'oz', pound: 'lb',
  milliliter: 'ml', millilitre: 'ml', liter: 'l', litre: 'l',
  teaspoon: 'tsp', tablespoon: 'tbsp', 'fluid ounce': 'fl oz', cup: 'cup',
};

function _unit(raw) {
  const name = String(raw || '').trim();
  if (!name) return null;
  const key = name.toLowerCase().replace(/s$/, '');
  return UNIT_SYMBOLS[key] || name;
}

export function parseLoseit(text) {
  const { header, rows } = parseCsv(text);
  if (!header.length) throw new Error('Empty file');

  const hasCore =
    header.includes('date') &&
    header.includes('name') &&
    header.includes('type') &&
    header.includes('calories');
  if (!hasCore) {
    throw new Error('Does not look like a LoseIt food log export — expected Date + Name + Type + Calories columns');
  }

  const out = [];
  for (const row of rows) {
    const dateStr = parseDate(getField(row, 'date'), 'us');
    if (!dateStr) continue;
    const name = getField(row, 'name');
    if (!name) continue;
    const calories = parseNumber(getField(row, 'calories'));
    if (calories == null) continue;

    // Calories and nutrients are the totals for the logged amount, so the item is one
    // serving with the amount as its portion (as the other importers do).
    const amount = parseNumber(getField(row, 'quantity'));
    const unit = _unit(getField(row, 'units'));

    const nutrition = { calories };
    _n(nutrition, 'fat',           row, 'fat (g)');
    _n(nutrition, 'saturated-fat', row, 'saturated fat (g)');
    _n(nutrition, 'cholesterol',   row, 'cholesterol (mg)');
    _n(nutrition, 'sodium',        row, 'sodium (mg)');
    _n(nutrition, 'carbohydrates', row, 'carbohydrates (g)');
    _n(nutrition, 'fiber',         row, 'fiber (g)');
    _n(nutrition, 'sugars',        row, 'sugars (g)');
    _n(nutrition, 'proteins',      row, 'protein (g)');

    out.push({
      date: dateStr,
      time: null,
      mealLabel: getField(row, 'type') || '',
      name,
      brand: null,
      quantity: 1,
      portion: amount,
      unit,
      nutrition,
      notes: null,
      sourceRow: row._rowNum,
    });
  }
  return out;
}

function _n(target, outKey, row, sourceKey) {
  const n = parseNumber(getField(row, sourceKey));
  if (n != null) target[outKey] = n;
}
