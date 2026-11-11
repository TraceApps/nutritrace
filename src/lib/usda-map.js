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
 *
 * Energy has four ids. 1008 (kcal) and 1062 (kJ) are "Energy"; since
 * October 2020 Foundation foods no longer show 1008 and most give only
 * 2047 (Atwater General Factors, kcal) and 2048 (Atwater Specific Factors,
 * kcal), so reading 1008 alone saved them at 0 kcal. See USDA_ENERGY_IDS.
 */
import { Nutrition } from './nutrition.js';
import { parseAltUnits } from './units.js';

// USDA FoodData Central nutrient ID → our nutrition object key
export const USDA_NUTRIENT_MAP = {
  // Energy (1008 kcal, 2048 and 2047 kcal, 1062 kJ) is read by
  // USDA_ENERGY_IDS below, not here.
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
  1170: 'b5',              // mg (pantothenic acid)
  1009: 'starch',          // g
  1100: 'iodine',          // mcg
  1103: 'selenium',        // mcg
  1098: 'copper',          // mg
  1101: 'manganese',       // mg
  1180: 'choline',         // mg (Choline, total)
};

// USDA's energy ids, in the order calories are taken from: the first one
// the food has wins. All are kcal per 100 g; FoodData Central has no kJ
// for 2047 or 2048 (its nutrient list), and none for any food since
// October 2020 except the older 1062 rows.
//  - 1008 "Energy": every SR Legacy, Survey (FNDDS) and Branded food, and
//    Foundation foods from before October 2020.
//  - 2048 "Energy (Atwater Specific Factors)": the food's own factors from
//    USDA Handbook 74, the method behind SR Legacy's 1008 for single foods,
//    so a Foundation food reads like its SR Legacy counterpart.
//  - 2047 "Energy (Atwater General Factors)": the general factors, such as
//    4, 9 and 4 kcal per gram of protein, fat and carbohydrate. Every
//    Foundation food with 2048 has it too, and some have only this one.
//  - 1062 "Energy" in kJ, divided by 4.184, as Open Food Facts kJ-only
//    products are (off-map.js). No Foundation food has it without 1008.
// Sources: https://fdc.nal.usda.gov/Foundation_Foods_Documentation/
// ("Energy") and nutrient.csv in the Foundation Foods download,
// https://fdc.nal.usda.gov/download-datasets/
export const USDA_ENERGY_IDS = [1008, 2048, 2047];
export const USDA_KJ_ID = 1062;

export const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';

/** A FoodData Central name search, as the Foods page asks for it. No
 *  dataType filter: all of Branded, Foundation, SR Legacy and Survey. */
export function usdaSearchUrl(query, { page = 1, pageSize = 50, apiKey = '' } = {}) {
  return USDA_BASE + '/foods/search?query=' + encodeURIComponent(query) +
    '&pageSize=' + pageSize + '&pageNumber=' + page +
    '&api_key=' + encodeURIComponent(apiKey);
}

/** A barcode search: Branded only (only branded products have GTINs/UPCs). */
export function usdaBarcodeSearchUrl(barcode, apiKey = '') {
  return USDA_BASE + '/foods/search?query=' + encodeURIComponent(barcode) +
    '&dataType=Branded&pageSize=10&api_key=' + encodeURIComponent(apiKey);
}

/** One food by its FoodData Central id. */
export function usdaFoodUrl(fdcId, apiKey = '') {
  return USDA_BASE + '/food/' + encodeURIComponent(fdcId) +
    '?api_key=' + encodeURIComponent(apiKey);
}

/** The food in a barcode search whose UPC is the barcode, exactly or
 *  without its leading zeros; undefined when none is. */
export function usdaBarcodeMatch(foods, barcode) {
  const code = String(barcode || '');
  return (foods || []).find(f =>
    f.gtinUpc && (f.gtinUpc === code || f.gtinUpc === code.replace(/^0+/, ''))
  );
}

// USDA data-type priority (lower = higher quality, surface first).
// Foundation Foods are laboratory-analyzed staples like "Chicken, broiler,
// breast, meat only, roasted", the gold standard. SR Legacy is the classic
// USDA Standard Reference, well-established. Survey (FNDDS) is dietary
// composite data. Branded is manufacturer-submitted and dominates search
// volume but varies wildly in quality. Experimental is tiny research data.
// Unknown/null types sink to the bottom so newer/older records that lack
// the field don't push curated entries down.
export const USDA_TYPE_PRIORITY = {
  'Foundation':      1,
  'SR Legacy':       2,
  'Survey (FNDDS)':  3,
  'Branded':         4,
  'Experimental':    5,
};

// Re-rank USDA search results within each fetched page so the higher-quality
// tiers (Foundation, SR Legacy) surface above manufacturer-submitted Branded
// entries. USDA's server-side relevance is text-match based and doesn't
// consider tier quality, so a search for "chicken" returns 50 branded chicken
// products before the one curated Foundation entry. Keeps USDA's relevance
// for the initial page selection; re-orders within the batch.
export function rankUsdaResults(items) {
  if (!Array.isArray(items) || items.length < 2) return items;
  return items.slice().sort((a, b) => {
    const aP = USDA_TYPE_PRIORITY[a.dataType] || 99;
    const bP = USDA_TYPE_PRIORITY[b.dataType] || 99;
    return aP - bP;
  });
}

/** The fdcId in a food's barcode ("fdcId_2607245"), or null. */
export function usdaFdcId(barcode) {
  const m = /^fdcId_(\d+)$/.exec(String(barcode || '').trim());
  return m ? m[1] : null;
}

// USDA portions -> alt_units rows (#289), from a /food/{fdcId} detail's
// foodPortions or a Survey search hit's foodMeasures. The label lives in a
// different field per data type:
//   SR Legacy: modifier "large" / "cup, chopped", measureUnit "undetermined"
//   Foundation: measureUnit.name "cup" (+ optional modifier "chopped")
//   Survey: portionDescription / disseminationText "1 egg", "1/2 cup"; its
//     modifier is a numeric food code, not a label
// grams is per ONE unit: gramWeight / amount, where a Survey row's amount is
// the number its text starts with ("1/2 cup" = 120 g -> cup = 240). Survey's
// "Quantity not specified" (USDA's typical portion) becomes "serving", unless
// another unit weighs the same (fried egg: serving = 1 egg = 55 g).
// Dropped: Foundation's RACC row and Survey's "guideline amount per ..."
// rows (reference amounts, not units anyone picks); bare mass units like
// "oz", which scaleFactor already converts; duplicates. Volume rows stay:
// "1 cup" of cooked rice is 174 g, not the 240 g a water-based cup gives.
// Returns null when nothing usable is left, matching OFF's altUnits.
const USDA_BARE_MASS = new Set(['g', 'mg', 'kg', 'oz', 'lb']);
export function usdaPortionsToAltUnits(portions) {
  if (!Array.isArray(portions)) return null;
  const rows = [];
  const seen = new Set();
  for (const p of portions) {
    const grams = Number(p && p.gramWeight);
    if (!Number.isFinite(grams) || grams <= 0) continue;
    const unitName = String((p.measureUnit && p.measureUnit.name) || p.measureUnitName || '').trim();
    if (unitName === 'RACC') continue;
    const modifier = String(p.modifier || '').trim();
    let label;
    let amount = Number(p.amount);
    if (unitName && unitName !== 'undetermined') {
      label = modifier ? unitName + ', ' + modifier : unitName;
    } else if (modifier && !/^\d/.test(modifier)) {
      label = modifier;
    } else {
      const text = String(p.portionDescription || p.disseminationText || '');
      const m = text.match(/^\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*/);
      if (m && !(amount > 0)) amount = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
      label = m ? text.slice(m[0].length) : text;
    }
    if (!(amount > 0)) amount = 1;
    label = label.trim().toLowerCase();
    if (label === 'quantity not specified') label = 'serving';
    if (!label || /^guideline amount/.test(label) || seen.has(label)) continue;
    if (USDA_BARE_MASS.has(label)) continue;
    seen.add(label);
    rows.push({ abbr: label, grams: Math.round(grams / amount * 10) / 10 });
  }
  const serving = rows.find(r => r.abbr === 'serving');
  const out = serving && rows.some(r => r !== serving && r.grams === serving.grams)
    ? rows.filter(r => r !== serving) : rows;
  return out.length ? out : null;
}

/**
 * What Refresh from USDA does to a food's units (#289): every row the food
 * has stays as it is, then each USDA unit it doesn't have yet is added. A
 * unit it already has keeps its grams, which the user may have corrected.
 * Nothing records which rows came from USDA, so one removed by hand comes
 * back on the next refresh.
 * @returns {{ alt_units: object[]|null, added: number }} alt_units is
 *   `current` itself when nothing was added.
 */
export function mergeUsdaAltUnits(current, usdaUnits) {
  const own = parseAltUnits(current) || [];
  const have = new Set(own.map(r => String((r && r.abbr) || '').trim().toLowerCase()));
  const extra = (usdaUnits || []).filter(r => !have.has(r.abbr));
  if (!extra.length) return { alt_units: current, added: 0 };
  return { alt_units: [...own, ...extra], added: extra.length };
}

/**
 * One FoodData Central food, from /foods/search or /food/{fdcId}, as a food
 * per 100 g (or 100 ml). Like an OFF lookup, it carries a non-enumerable
 * `_offPresent` listing the nutrients USDA actually has, so Refresh from
 * USDA can reuse Refresh from OFF's rules (off-refresh.js).
 */
export function mapUsdaFood(item) {
  const nutrition = {};
  const energy = {};

  for (const fn of (item.foodNutrients || [])) {
    // Search API returns nutrientId directly; detail API nests it under fn.nutrient.id
    const nid = fn.nutrientId || (fn.nutrient && fn.nutrient.id);
    const key = USDA_NUTRIENT_MAP[nid];
    // Search API uses fn.value; the detail API uses fn.amount. Both per 100 g.
    const raw = fn.value != null ? fn.value : fn.amount;
    if (raw == null || !Number.isFinite(Number(raw))) continue;
    if (key) {
      nutrition[key] = Math.round(raw * 10000) / 10000;
    } else if (Number(nid) === USDA_KJ_ID || USDA_ENERGY_IDS.includes(Number(nid))) {
      energy[Number(nid)] = Number(raw);
    }
  }
  const kcalId = USDA_ENERGY_IDS.find(id => energy[id] != null);
  if (kcalId != null) {
    nutrition.calories = Math.round(energy[kcalId] * 10000) / 10000;
  } else if (energy[USDA_KJ_ID] != null) {
    nutrition.calories = Math.round(energy[USDA_KJ_ID] / 4.184 * 10) / 10;
  }
  if (energy[USDA_KJ_ID] != null) {
    nutrition.kilojoules = Math.round(energy[USDA_KJ_ID] * 10000) / 10000;
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
    // Household units (#289). Survey search hits carry them as
    // foodMeasures; SR Legacy and Foundation ones only in the detail
    // (lookupFdcId), which Foods fetches when one is picked.
    alt_units: usdaPortionsToAltUnits(item.foodPortions || item.foodMeasures),
    _source:   'usda',
  };
  Object.defineProperty(mapped, '_offPresent', { value: [...present], enumerable: false });
  return mapped;
}
