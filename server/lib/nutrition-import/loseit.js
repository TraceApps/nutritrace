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

    const quantity = parseNumber(getField(row, 'quantity')) ?? 1;
    const unit = getField(row, 'units') || null;

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
      quantity,
      portion: unit ? `${quantity} ${unit}` : null,
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
