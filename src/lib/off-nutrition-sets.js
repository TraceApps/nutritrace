/**
 * off-nutrition-sets.js: "as sold" values from Open Food Facts' new nutrition
 * format (#241).
 *
 * OFF now stores each product's values as sets (as sold, as prepared, from the
 * packaging, the manufacturer, an estimate...) and builds one "aggregated set"
 * from them, preferring "as prepared" when a product has both. Its older API
 * versions, including the v3 NutriTrace reads, are built from that aggregated
 * set only, so a product with both kinds of values looks "as prepared" only.
 * The sets themselves are only served by API v3.5 and later.
 *
 * asSoldNutriments() builds the aggregated set OFF would build if the product
 * had no "as prepared" values, and writes it out the way the older API does,
 * so the rest of NutriTrace reads it like any other product. Every step is a
 * port of OFF's own code (openfoodfacts-server, lib/ProductOpener):
 *   Nutrition.pm            sort_sets_by_priority, generate_nutrient_aggregated_set_from_sets,
 *                           set_nutrient_values, convert_nutrient_to_standard_unit,
 *                           convert_nutrient_to_100g, default_unit_for_nid
 *   Units.pm                unit_to_g, g_to_unit, unit_to_kcal, unit_to_kj, get_standard_unit
 *   ProductSchemaChanges.pm convert_schema_1003_to_1002_refactor_product_nutrition_schema,
 *                           _compute_nutrition_data_per_100g_and_per_serving_for_old_nutrition_schema
 * The one deliberate difference: a nutrient in a unit these tables don't know
 * is skipped rather than read as-is, so it is left blank instead of wrong.
 */

// taxonomies/units.txt: the English names and symbols of each unit, as
// [standard unit, conversion factor, names].
const _UNIT_ROWS = [
  ['%', 1, ['%', 'percent']],
  ['% dv', 1, ['% dv', '%dv', 'percent dv']],
  ['% vol', 1, ['% vol', '%vol', 'percent vol']],
  ['% vol (alcohol)', 1, ['% vol (alcohol)', 'percent vol (alcohol)']],
  ['g', 1e-06, ['mcg', 'mcgs', 'microgram', 'micrograms', 'µg']],
  ['g', 0.001, ['mg', 'mgs', 'milligram', 'milligrams']],
  ['g', 1, ['g', 'gr', 'gram', 'grams', 'grm', 'grs']],
  ['g', 28.349523125, ['onz', 'oz', 'ozs']],
  ['g', 453.59237, ['lb', 'lbs', 'pound', 'pounds']],
  ['g', 500, ['metric pound', 'metric pounds', 'metric-pound']],
  ['g', 1000, ['kg', 'kgr', 'kgs', 'kilo', 'kilogram', 'kilograms', 'kilos']],
  ['iu', 1, ['i.e', 'i.u', 'ie', 'international unit', 'iu', 'u.i', 'ui']],
  ['kj', 1, ['kilojoule', 'kilojoules', 'kj', 'kjs']],
  ['kj', 4.184, ['cal', 'calorie', 'calories', 'cals', 'kcal', 'kcals', 'kilocalorie', 'kilocalories']],
  ['ml', 1, ['milliliter', 'milliliters', 'ml', 'mls', 'pinch', 'pinches']],
  ['ml', 5, ['metric teaspoon']],
  ['ml', 10, ['centiliter', 'centiliters', 'cl', 'cls']],
  ['ml', 29.5735, ['fl oz', 'fl. oz', 'fl. oz.', 'fl.oz', 'fl.oz.', 'floz', 'fluid ounce', 'fluid ounces', 'oza']],
  ['ml', 30, ['dash', 'splash']],
  ['ml', 100, ['deciliter', 'deciliters', 'dl', 'dls']],
  ['ml', 240, ['cup', 'cups']],
  ['ml', 1000, ['l', 'liter', 'liters', 'ls']],
  ['ml', 3785.41, ['gal', 'gallon', 'gallons', 'gals']],
];
const _UNITS = new Map();
for (const [standard, factor, names] of _UNIT_ROWS) {
  for (const name of names) _UNITS.set(name, { standard, factor, kcal: name === 'kcal' });
}
const _unit = (unit) => (unit == null ? null : _UNITS.get(String(unit).toLowerCase()) || null);

// taxonomies/nutrients.txt: the nutrients whose values convert from IU or
// % of daily value, with the unit they convert to.
const _IU = { 'vitamin-a': 0.3, 'vitamin-d': 0.025, 'vitamin-d3': 0.025, 'vitamin-e': 0.666666666666667, 'vitamin-c': 0.05 };
const _DV = {
  'vitamin-a': 1500, 'vitamin-d': 20, 'vitamin-d3': 20, 'vitamin-e': 20, 'vitamin-k': 80, 'vitamin-c': 60,
  'vitamin-b1': 1.2, 'vitamin-b2': 1.7, 'vitamin-pp': 20, 'vitamin-b6': 2, 'vitamin-b9': 400, folates: 400,
  'vitamin-b12': 6, biotin: 300, 'pantothenic-acid': 10, potassium: 4700, chloride: 3400, calcium: 1300,
  phosphorus: 1000, iron: 18, magnesium: 400, zinc: 15, copper: 2, manganese: 2, selenium: 70, chromium: 120,
  molybdenum: 75, iodine: 150,
};
const _TAXONOMY_UNIT = {
  'vitamin-a': 'µg', 'vitamin-d': 'µg', 'vitamin-d3': 'µg', 'vitamin-e': 'mg', 'vitamin-k': 'µg', 'vitamin-c': 'mg',
  'vitamin-b1': 'mg', 'vitamin-b2': 'mg', 'vitamin-pp': 'mg', 'vitamin-b6': 'mg', 'vitamin-b9': 'µg', folates: 'µg',
  'vitamin-b12': 'µg', biotin: 'µg', 'pantothenic-acid': 'mg', potassium: 'mg', chloride: 'mg', calcium: 'mg',
  phosphorus: 'mg', iron: 'mg', magnesium: 'mg', zinc: 'mg', copper: 'mg', manganese: 'mg', selenium: 'µg',
  chromium: 'µg', molybdenum: 'µg', iodine: 'µg',
  alcohol: '% vol', acidity: '% vol', cocoa: '%', 'whole-grain': '%', moisture: '%', 'nova-group': '',
  'fruits-vegetables-nuts': '%', 'fruits-vegetables-nuts-dried': '%', 'fruits-vegetables-legumes': '%',
  'collagen-meat-protein-ratio': '%',
};
// Units that make a value the same whatever the quantity (a % or no unit).
const _sameForAnyQuantity = (nid) => {
  const unit = _TAXONOMY_UNIT[nid];
  return unit !== undefined && (unit === '' || unit.startsWith('%'));
};

// Nutrition.pm default_unit_for_nid
function _defaultUnit(nid) {
  const fixed = { 'energy-kj': 'kJ', 'energy-kcal': 'kcal', energy: 'kJ', alcohol: '% vol', 'water-hardness': 'mmol/l', ph: '' };
  if (nid in fixed) return fixed[nid];
  if (/^fruits/.test(nid) || /^collagen/.test(nid)) return '%';
  const unit = _TAXONOMY_UNIT[nid];
  if (unit === '%' || unit === '') return unit;
  return 'g';
}

// Units.pm unit_to_g / g_to_unit / unit_to_kcal / unit_to_kj. They return
// undefined for a unit they don't know (see the header).
function _unitToG(value, unit) {
  if (value == null) return value;
  const u = _unit(unit);
  if (!u) return undefined;
  if (u.kcal) return Math.trunc(value * 4.184 + 0.5);
  return value * u.factor;
}
function _gToUnit(value, unit) {
  if (value == null) return value;
  const u = _unit(unit);
  if (!u) return undefined;
  if (u.kcal) return Math.trunc(value / 4.184 + 0.5);
  return value / u.factor;
}
const _unitToKcal = (value, unit) => (value == null ? value : String(unit).toLowerCase() === 'kj' ? Math.trunc(value / 4.184 + 0.5) : value + 0);
const _unitToKj = (value, unit) => (value == null ? value : String(unit).toLowerCase() === 'kcal' ? Math.trunc(value * 4.184) : value + 0);

// A set's per quantity in g (or ml). A unit it doesn't know, or none, reads
// as-is, as unit_to_g does: OFF has sets per "67" with no unit, meaning grams.
const _perToG = (quantity, unit) => (_unit(unit) ? _unitToG(quantity, unit) : quantity + 0);

// Nutrition.pm convert_nutrient_to_standard_unit. False when the unit is unknown.
function _toStandardUnit(nutrient, nid) {
  const standard = _defaultUnit(nid);
  if (standard === nutrient.unit) return true;
  const upper = String(nutrient.unit ?? '').toUpperCase();
  if (upper === 'IU' && _IU[nid] !== undefined) {
    if (nutrient.value != null) nutrient.value *= _IU[nid];
    nutrient.unit = _TAXONOMY_UNIT[nid];
  } else if (upper === '% DV' && _DV[nid] !== undefined) {
    if (nutrient.value != null) nutrient.value *= _DV[nid] / 100;
    nutrient.unit = _TAXONOMY_UNIT[nid];
  }
  if (standard === 'kcal') nutrient.value = _unitToKcal(nutrient.value, nutrient.unit);
  else if (standard === 'kJ') nutrient.value = _unitToKj(nutrient.value, nutrient.unit);
  else {
    if (nutrient.value != null && !_unit(nutrient.unit)) return false;
    nutrient.value = _unitToG(nutrient.value, nutrient.unit);
  }
  nutrient.unit = standard;
  return true;
}

// Nutrition.pm convert_nutrient_to_100g. False when the unit is unknown.
function _to100(nutrient, per, perQuantity, perUnit, wantedPer) {
  if (per === wantedPer) return true;
  const factor = _gToUnit(_perToG(perQuantity, perUnit), wantedPer === '100g' ? 'g' : 'ml');
  if (factor === undefined || !factor) return false;
  // Perl reads a missing value as 0 here, and so does the older API.
  nutrient.value = ((nutrient.value ?? 0) * 100) / factor;
  return true;
}

const _PREPARATION = { prepared: 0, as_sold: 1 };
const _SOURCE = { manufacturer: 0, packaging: 1, usda: 2, estimate: 3 };
const _PER = { '100g': 0, '100ml': 1, '1l': 2, '1kg': 3, serving: 4 };
const _rank = (table, fallback) => (key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback);
const _prep = _rank(_PREPARATION, 2), _src = _rank(_SOURCE, 4), _per = _rank(_PER, 5);

// Nutrition.pm generate_nutrient_aggregated_set_from_sets + set_nutrient_values
function _aggregate(sets) {
  const sorted = sets
    .map((set, index) => ({ set, index }))
    .sort((a, b) => (_prep(a.set.preparation) - _prep(b.set.preparation))
      || (_src(a.set.source) - _src(b.set.source))
      || (_per(a.set.per) - _per(b.set.per)))
    .filter(({ set }) => set.per_quantity != null && set.per_quantity !== '')
    .filter(({ set }) => {
      return _perToG(Number(set.per_quantity), set.per_unit) >= 5;
    });
  const agg = { nutrients: {} };
  if (!sorted.length) return agg;
  agg.preparation = sorted[0].set.preparation;
  const standard = _unit(sorted[0].set.per_unit)?.standard;
  if (standard === undefined || standard === 'g') agg.per = '100g';
  else if (standard === 'ml') agg.per = '100ml';
  for (const { set } of sorted) {
    if (set.preparation !== agg.preparation || !set.nutrients || typeof set.nutrients !== 'object' || Array.isArray(set.nutrients)) continue;
    for (const nid of Object.keys(set.nutrients).sort()) {
      if (nid === 'energy' || nid in agg.nutrients) continue;
      const source = set.nutrients[nid];
      if (!source || typeof source !== 'object') continue;
      const nutrient = { ...source };
      delete nutrient.value_string;
      if (nutrient.value == null && nutrient.value_computed != null) {
        nutrient.value = nutrient.value_computed;
        delete nutrient.value_computed;
        nutrient.modifier ??= '~';
      }
      if (nutrient.value != null) nutrient.value = Number(nutrient.value);
      const ok = (nutrient.value == null || Number.isFinite(nutrient.value))
        && _toStandardUnit(nutrient, nid)
        && _to100(nutrient, set.per, Number(set.per_quantity), set.per_unit, agg.per);
      // Taken or not, the nutrient is settled by this set, as in OFF: a
      // lower-priority set never fills it in.
      agg.nutrients[nid] = ok ? { ...nutrient, source: set.source } : { skipped: true };
    }
    const kj = agg.nutrients['energy-kj'], kcal = agg.nutrients['energy-kcal'];
    if (kj && !kj.skipped && kj.value !== undefined) agg.nutrients.energy = { ...kj };
    else if (kcal && !kcal.skipped && kcal.value !== undefined) {
      const energy = { ...kcal };
      _toStandardUnit(energy, 'energy');
      agg.nutrients.energy = energy;
    }
  }
  return agg;
}

// Perl rounds to n significant digits on the exact binary value, an exact
// tie going to the even digit (C's printf); JS toPrecision rounds a tie up.
function _perlSig(x, n) {
  if (!Number.isFinite(x) || x === 0 || Math.abs(x) >= 1e21) return x;
  const exact = Math.abs(x).toFixed(100);
  const digits = exact.replace('.', '');
  const first = digits.search(/[1-9]/);
  const exponent = exact.indexOf('.') - 1 - first;
  let head = BigInt(digits.slice(first, first + n).padEnd(n, '0'));
  const rest = digits.slice(first + n);
  const above = rest[0] > '5' || (rest[0] === '5' && /[1-9]/.test(rest.slice(1)));
  const tie = rest[0] === '5' && !/[1-9]/.test(rest.slice(1));
  if (above || (tie && head % 2n === 1n)) head += 1n;
  return Math.sign(x) * Number(`${head}e${exponent - n + 1}`);
}
// OFF's JSON writes numbers with 15 significant digits (Perl's %.15g).
const _json = (v) => (typeof v === 'number' ? _perlSig(v, 15) : v);
// Perl's sprintf("%.2e", x) + 0, for the per-serving values.
const _sprintf2e = (x) => _perlSig(x, 3);

/**
 * The product's "as sold" values in the older API's shape, from a v3.5
 * product's nutrition.input_sets: { nutriments, per }, or null when it has no
 * usable "as sold" set. `servingQuantity` is the product's serving_quantity,
 * used for the per-serving values like the older API.
 */
export function asSoldNutriments(nutrition, servingQuantity) {
  const sets = nutrition?.input_sets;
  if (!Array.isArray(sets)) return null;
  const asSold = sets.filter(s => s && typeof s === 'object' && s.preparation === 'as_sold');
  if (!asSold.length) return null;
  const agg = _aggregate(asSold);
  if (agg.preparation !== 'as_sold') return null;
  // ProductSchemaChanges.pm convert_schema_1003_to_1002 (the as-sold branch)
  // then _compute_nutrition_data_per_100g_and_per_serving_for_old_nutrition_schema.
  const nutriments = {};
  const serving = Number(servingQuantity);
  let any = false;
  for (const [nid, nutrient] of Object.entries(agg.nutrients)) {
    if (nutrient.skipped) continue;
    const source = nutrient.source ?? 'unknown';
    if (source === 'estimate' && nid !== 'added-sugars') continue;
    // OFF stores the aggregated set with 15 digits, then converts the stored
    // numbers, so per-serving values come from the 15-digit value. (A product
    // last saved before OFF's new format builds the set as it is read, at full
    // precision, so its per-serving values can differ in the last digit.)
    const stored = nutrient.value == null ? nutrient.value : _json(nutrient.value);
    const value = stored == null ? 0 : stored;
    nutriments[nid] = stored;
    nutriments[nid + '_100g'] = value;
    nutriments[nid + '_unit'] = nutrient.unit;
    if (nutrient.modifier != null) nutriments[nid + '_modifier'] = nutrient.modifier;
    if (_sameForAnyQuantity(nid)) nutriments[nid + '_serving'] = value;
    else if (Number.isFinite(serving) && serving > 0) {
      nutriments[nid + '_serving'] = _sprintf2e(value / 100 * serving);
    }
    any = true;
  }
  // The older API reads a missing per as 100 g.
  return any ? { nutriments, per: agg.per ?? '100g' } : null;
}
