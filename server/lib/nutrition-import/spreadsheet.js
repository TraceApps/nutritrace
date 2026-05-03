/**
 * Raw spreadsheet adapter — accepts liberal column naming so users with
 * homegrown CSVs can import without reformatting.
 *
 * Required columns: Date, Name (or Food/Item/Food Name), Calories (or kcal/Energy)
 * Recommended:      Meal (or Type/Category/Group)
 * Optional:         Brand, Quantity, Unit, Time, Notes,
 *                   Carbs (g), Fat (g), Protein (g), Fiber (g), Sugar (g),
 *                   Sodium (mg), Saturated Fat (g)
 *
 * See public/templates/nutrition-import-template.csv for the canonical shape.
 */
import {
  parseCsv, getField, parseDate, detectDateLocale,
  parseNumber, splitAmount, kJtoKcal,
} from './common.js';

export function parseSpreadsheet(text) {
  const { header, rows } = parseCsv(text);
  if (!header.length) throw new Error('Empty file');
  if (!_hasRequiredColumns(header)) {
    throw new Error('Missing required columns: need Date, a name (Name/Food/Item), and energy (Calories/kcal/Energy)');
  }

  const dateLocale = detectDateLocale(rows.map(r => getField(r, 'date', 'day')));
  const out = [];

  for (const row of rows) {
    const dateStr = parseDate(getField(row, 'date', 'day'), dateLocale);
    if (!dateStr) continue;

    const name = getField(row, 'name', 'food', 'food name', 'item', 'description');
    if (!name) continue;

    // Energy — accept kcal or kJ
    let calories = parseNumber(getField(row, 'calories', 'kcal', 'energy', 'energy (kcal)'));
    if (calories == null) {
      const kj = parseNumber(getField(row, 'kj', 'kilojoules', 'energy (kj)'));
      if (kj != null) calories = kJtoKcal(kj);
    }
    if (calories == null) continue;

    // Quantity / portion
    let quantity = parseNumber(getField(row, 'quantity', 'qty', 'servings', 'amount'));
    let unit = getField(row, 'unit', 'units', 'serving unit') || null;
    // Fallback: parse "Amount" or "Servings" as combined quantity+unit
    if (quantity == null) {
      const combined = getField(row, 'amount', 'serving', 'portion');
      if (combined) {
        const split = splitAmount(combined);
        quantity = split.quantity;
        if (!unit) unit = split.unit;
      }
    }
    if (quantity == null) quantity = 1;

    const nutrition = { calories };
    _maybeNum(nutrition, 'fat',                  getField(row, 'fat (g)', 'fat', 'total fat (g)', 'total fat'));
    _maybeNum(nutrition, 'saturated-fat',        getField(row, 'saturated fat (g)', 'saturated fat', 'sat fat (g)', 'sat fat'));
    _maybeNum(nutrition, 'trans-fat',            getField(row, 'trans fat (g)', 'trans fat'));
    _maybeNum(nutrition, 'polyunsaturated-fat',  getField(row, 'polyunsaturated fat (g)', 'polyunsaturated fat', 'polyunsaturated (g)'));
    _maybeNum(nutrition, 'monounsaturated-fat',  getField(row, 'monounsaturated fat (g)', 'monounsaturated fat', 'monounsaturated (g)'));
    _maybeNum(nutrition, 'cholesterol',          getField(row, 'cholesterol (mg)', 'cholesterol'));
    _maybeNum(nutrition, 'sodium',               getField(row, 'sodium (mg)', 'sodium'));
    _maybeNum(nutrition, 'carbohydrates',        getField(row, 'carbs (g)', 'carbohydrates (g)', 'carbohydrate (g)', 'carbs', 'carbohydrates', 'carbohydrate'));
    _maybeNum(nutrition, 'fiber',                getField(row, 'fiber (g)', 'fiber', 'dietary fiber (g)', 'dietary fiber'));
    _maybeNum(nutrition, 'sugars',               getField(row, 'sugar (g)', 'sugars (g)', 'sugar', 'sugars'));
    _maybeNum(nutrition, 'added-sugars',         getField(row, 'added sugars (g)', 'added sugars'));
    _maybeNum(nutrition, 'proteins',             getField(row, 'protein (g)', 'proteins (g)', 'protein', 'proteins'));
    _maybeNum(nutrition, 'potassium',            getField(row, 'potassium (mg)', 'potassium'));
    _maybeNum(nutrition, 'calcium',              getField(row, 'calcium (mg)', 'calcium'));
    _maybeNum(nutrition, 'iron',                 getField(row, 'iron (mg)', 'iron'));
    _maybeNum(nutrition, 'caffeine',             getField(row, 'caffeine (mg)', 'caffeine'));

    // Each spreadsheet row is one consumed item; nutrition columns are the
    // TOTAL for that consumption. quantity stays at 1 so diary's
    // Nutrition.calculate doesn't multiply (which would inflate calories).
    // The parsed numeric quantity becomes `portion`, with `unit` separate.
    out.push({
      date: dateStr,
      time: _normalizeTime(getField(row, 'time')),
      mealLabel: getField(row, 'meal', 'type', 'category', 'group') || '',
      name,
      brand: getField(row, 'brand', 'manufacturer') || null,
      quantity: 1,
      portion: Number.isFinite(quantity) ? quantity : null,
      unit,
      nutrition,
      notes: getField(row, 'notes', 'note', 'comment') || null,
      sourceRow: row._rowNum,
    });
  }

  return out;
}

function _hasRequiredColumns(header) {
  const has = (...syns) => syns.some(s => header.includes(s));
  const hasDate = has('date', 'day');
  const hasName = has('name', 'food', 'food name', 'item', 'description');
  const hasEnergy = has('calories', 'kcal', 'energy', 'energy (kcal)', 'kj', 'kilojoules', 'energy (kj)');
  return hasDate && hasName && hasEnergy;
}

function _maybeNum(target, key, raw) {
  const n = parseNumber(raw);
  if (n != null) target[key] = n;
}

function _normalizeTime(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
