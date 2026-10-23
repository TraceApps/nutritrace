/**
 * usda-map.js: turns a USDA FoodData Central food into a NutriTrace food.
 *
 * FoodData Central gives every nutrient per 100 g (or 100 ml) of food, for
 * every data type: the search's `value`, the detail's `amount`, Branded
 * included. For Branded foods USDA works those out from the label's
 * per-serving numbers itself, and `servingSize` is only a note of what the
 * label's serving was. The values were once scaled by 100 / servingSize as if
 * they were per serving, which saved a 13 g snack at 7.7 times its real
 * energy (#290). Sources:
 * https://fdc.nal.usda.gov/GBFPD_Documentation ("USDA standardizes the
 * reported values by calculating nutrient values per 100 grams") and
 * https://fdc.nal.usda.gov/docs/Download_Field_Descriptions_Oct2020.pdf
 * (food_nutrient amount: "Amount of the nutrient per 100g of food").
 */
import { Nutrition } from './nutrition.js';

// USDA FoodData Central nutrient ID → our nutrition object key
export const USDA_NUTRIENT_MAP = {
  1008: 'calories',        // Energy kcal
  1062: 'kilojoules',      // Energy kJ
  1003: 'proteins',
  1004: 'fat',
  1258: 'saturated-fat',
  1257: 'trans-fat',
  1292: 'monounsaturated-fat',
  1293: 'polyunsaturated-fat',
  1005: 'carbohydrates',
  2000: 'sugars',
  1235: 'added-sugars',
  1079: 'fiber',
  1093: 'sodium',          // mg
  1253: 'cholesterol',     // mg
  1087: 'calcium',         // mg
  1089: 'iron',            // mg
  1092: 'potassium',       // mg
  1090: 'magnesium',       // mg
  1095: 'zinc',            // mg
  1091: 'phosphorus',      // mg
  1162: 'vitamin-c',       // mg
  1106: 'vitamin-a',       // mcg
  1114: 'vitamin-d',       // mcg
  1109: 'vitamin-e',       // mg
  1185: 'vitamin-k',       // mcg
  1165: 'b1',              // mg
  1166: 'b2',              // mg
  1167: 'b3',              // mg
  1175: 'b6',              // mg
  1177: 'b9',              // mcg (folate)
  1178: 'b12',             // mcg
};

/** The fdcId in a food's barcode ("fdcId_2607245"), or null. */
export function usdaFdcId(barcode) {
  const m = /^fdcId_(\d+)$/.exec(String(barcode || '').trim());
  return m ? m[1] : null;
}

/**
 * One FoodData Central food, from /foods/search or /food/{fdcId}, as a food
 * per 100 g (or 100 ml). Like an OFF lookup, it carries a non-enumerable
 * `_offPresent` listing the nutrients USDA actually has, so Refresh from
 * USDA can reuse Refresh from OFF's rules (off-refresh.js).
 */
export function mapUsdaFood(item) {
  const nutrition = {};

  for (const fn of (item.foodNutrients || [])) {
    // Search API returns nutrientId directly; detail API nests it under fn.nutrient.id
    const nid = fn.nutrientId || (fn.nutrient && fn.nutrient.id);
    const key = USDA_NUTRIENT_MAP[nid];
    // Search API uses fn.value; the detail API uses fn.amount. Both per 100 g.
    const raw = fn.value != null ? fn.value : fn.amount;
    if (key && raw != null) {
      nutrition[key] = Math.round(raw * 10000) / 10000;
    }
  }
  const present = new Set(Object.keys(nutrition));

  // Derive kJ from kcal if kJ nutrient not present (Android does same conversion)
  if (nutrition.calories && !nutrition.kilojoules) {
    nutrition.kilojoules = Math.round(nutrition.calories * 4.184 * 10) / 10;
    present.add('kilojoules');
  }

  // Derive salt from sodium (or vice versa) via the regulatory factor.
  // Sets `_derived.salt` so the food editor can render the calculator icon.
  Nutrition.deriveSodiumSalt(nutrition);
  if (present.has('sodium') || present.has('salt')) { present.add('sodium'); present.add('salt'); }

  // USDA "Carbohydrate, by difference" includes fiber: subtract to match OFF net-carbs
  if (nutrition.carbohydrates != null && nutrition.fiber != null) {
    let corrected = nutrition.carbohydrates - nutrition.fiber;
    // Floor at sugars value (can't be less than sugars)
    if (corrected < (nutrition.sugars || 0)) corrected = nutrition.sugars || 0;
    nutrition.carbohydrates = Math.round(corrected * 10000) / 10000;
  }

  // Branded liquids are per 100 ml. USDA writes the unit as "ml" or "MLT".
  const rawUnit = (item.servingSizeUnit || 'g').toLowerCase();
  const unit = (rawUnit === 'ml' || rawUnit === 'mlt') ? 'ml' : 'g';

  const mapped = {
    name:      (item.description || '').trim(),
    brand:     (item.brandOwner || item.brandName || '').trim(),
    // Use fdcId_ prefix as barcode (matches Android; lets food editor link to USDA page)
    barcode:   item.fdcId ? 'fdcId_' + item.fdcId : (item.gtinUpc || ''),
    unit,
    portion:   100,
    quantity:  1,
    imgUrl: '',
    dateTime:  new Date().toISOString(),
    categories: [],
    nutrition,
    // USDA's `dataType` distinguishes the source database. Feeds both the
    // in-page result sort (curated tiers first) and the small badge that
    // renders next to each USDA result row so users can pick informed.
    // Values seen from USDA: 'Foundation' (highest curated quality),
    // 'SR Legacy' (established), 'Survey (FNDDS)' (derived dietary
    // composite), 'Branded' (brand-submitted, quality varies wildly),
    // 'Experimental' (research; tiny). Null for old imports that lack it.
    dataType:  item.dataType || null,
    _source:   'usda',
  };
  Object.defineProperty(mapped, '_offPresent', { value: [...present], enumerable: false });
  return mapped;
}
