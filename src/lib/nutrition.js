/**
 * nutrition.js - Nutriment definitions and calculation utilities
 */
// Ordered to match US Nutrition Facts label for easy manual entry.
// `dv` is the FDA Daily Value (DV%) reference amount. `bold` flags
// top-level macro rows (Total Fat, Cholesterol, Sodium, Total Carbohydrate,
// Protein) that render bold on the Nutrition Facts label. Both used by
// the shared NutritionFactsBox component (mirrors CookTrace).
const NUTRIMENTS = [
  // Energy
  { id: 'calories',      label: 'Calories',      unit: 'kcal', category: 'energy',  default: true,  bold: true,  dv: null },
  { id: 'kilojoules',    label: 'Kilojoules',    unit: 'kJ',   category: 'energy',  default: false, bold: false, dv: null },
  // Total Fat + sub-rows. `subOf` indicates the indented sub-row position
  // on the FDA Nutrition Facts label (Saturated Fat / Trans Fat / etc. are
  // indented under Total Fat). The FoodEditor renders these with extra
  // padding-left so the parent-child relationship is visible at a glance.
  { id: 'fat',                 label: 'Fat',                 unit: 'g',    category: 'macro',   default: true,  bold: true,  dv: 78 },
  { id: 'saturated-fat',       label: 'Saturated Fat',       unit: 'g',    category: 'macro',   default: true,  bold: false, dv: 20,   subOf: 'fat' },
  { id: 'trans-fat',           label: 'Trans Fat',           unit: 'g',    category: 'macro',   default: false, bold: false, dv: null, subOf: 'fat' },
  { id: 'polyunsaturated-fat', label: 'Polyunsaturated Fat', unit: 'g',    category: 'macro',   default: false, bold: false, dv: null, subOf: 'fat' },
  { id: 'monounsaturated-fat', label: 'Monounsaturated Fat', unit: 'g',    category: 'macro',   default: false, bold: false, dv: null, subOf: 'fat' },
  // Cholesterol & Sodium
  { id: 'cholesterol',   label: 'Cholesterol',   unit: 'mg',   category: 'other',   default: false, bold: true,  dv: 300 },
  { id: 'sodium',        label: 'Sodium',        unit: 'mg',   category: 'mineral', default: true,  bold: true,  dv: 2300 },
  { id: 'salt',          label: 'Salt',          unit: 'g',    category: 'macro',   default: false, bold: false, dv: null },
  // Total Carbohydrate + sub-rows
  { id: 'carbohydrates', label: 'Carbs',         unit: 'g',    category: 'macro',   default: true,  bold: true,  dv: 275 },
  { id: 'fiber',         label: 'Fiber',         unit: 'g',    category: 'macro',   default: true,  bold: false, dv: 28,   subOf: 'carbohydrates' },
  { id: 'sugars',        label: 'Sugars',        unit: 'g',    category: 'macro',   default: true,  bold: false, dv: null, subOf: 'carbohydrates' },
  { id: 'added-sugars',  label: 'Added Sugars',  unit: 'g',    category: 'macro',   default: true,  bold: false, dv: 50,   subOf: 'sugars' },
  // Protein
  { id: 'proteins',      label: 'Protein',       unit: 'g',    category: 'macro',   default: true,  bold: true,  dv: 50 },
  // Vitamins & Minerals (Nutrition Facts order)
  { id: 'vitamin-d',     label: 'Vitamin D',     unit: 'µg',  category: 'vitamin', default: true,  bold: false, dv: 20 },
  { id: 'calcium',       label: 'Calcium',       unit: 'mg',   category: 'mineral', default: true,  bold: false, dv: 1300 },
  { id: 'iron',          label: 'Iron',          unit: 'mg',   category: 'mineral', default: true,  bold: false, dv: 18 },
  { id: 'potassium',     label: 'Potassium',     unit: 'mg',   category: 'mineral', default: true,  bold: false, dv: 4700 },
  // Additional vitamins
  { id: 'vitamin-a',     label: 'Vitamin A',     unit: 'µg',  category: 'vitamin', default: false, bold: false, dv: 900 },
  { id: 'vitamin-c',     label: 'Vitamin C',     unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 90 },
  { id: 'vitamin-e',     label: 'Vitamin E',     unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 15 },
  { id: 'vitamin-k',     label: 'Vitamin K',     unit: 'µg',  category: 'vitamin', default: false, bold: false, dv: 120 },
  { id: 'b1',            label: 'Vitamin B1',    unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 1.2 },
  { id: 'b2',            label: 'Vitamin B2',    unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 1.3 },
  { id: 'b3',            label: 'Vitamin B3',    unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 16 },
  { id: 'b6',            label: 'Vitamin B6',    unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 1.7 },
  { id: 'b9',            label: 'Folate (B9)',   unit: 'µg',  category: 'vitamin', default: false, bold: false, dv: 400 },
  { id: 'b12',           label: 'Vitamin B12',   unit: 'µg',  category: 'vitamin', default: false, bold: false, dv: 2.4 },
  { id: 'magnesium',     label: 'Magnesium',     unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 420 },
  { id: 'zinc',          label: 'Zinc',          unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 11 },
  { id: 'phosphorus',    label: 'Phosphorus',    unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 1250 },
  // Other
  { id: 'caffeine',      label: 'Caffeine',      unit: 'mg',   category: 'other',   default: false, bold: false, dv: null },
  { id: 'alcohol',       label: 'Alcohol',       unit: 'g',    category: 'other',   default: false, bold: false, dv: null },
];

// Default visible set — matches NUTRIMENTS rows flagged default:true.
// Used by the NutritionFactsBox component when the user hasn't customized
// their visibleNutriments setting yet.
export const DEFAULT_VISIBLE_NUTRIMENT_IDS = NUTRIMENTS.filter(n => n.default).map(n => n.id);

/** Compute a value's % Daily Value, or null if no DV is defined / value
 *  is invalid. Mirrors CookTrace's helper so the shared NutritionFactsBox
 *  renders the same %DV column across both apps. */
export function dvPercent(nut, value) {
  if (!nut || !nut.dv || value == null || value === '') return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  return Math.round((v / nut.dv) * 100);
}

/** True if the given nutriment id was auto-derived on the saved object
 *  (e.g. sodium derived from salt). NutriTrace doesn't currently set
 *  the `_derived` flag, so this always returns false — kept for parity
 *  with CookTrace's NutritionFactsBox so the component can be ported
 *  byte-for-byte without divergence. */
export function isDerived(nutrition, id) {
  return !!(nutrition && nutrition._derived && nutrition._derived[id]);
}

/** "Calories" or "Energy" — the row label used in the Nutrition Facts
 *  box. EU/AU users on kJ see "Energy". */
export function energyLabel(unit) {
  return unit === 'kJ' ? 'Energy' : 'Calories';
}

/** "kcal" or "kJ" — the unit suffix shown next to the value. */
export function energyUnitSuffix(unit) {
  return unit === 'kJ' ? 'kJ' : 'kcal';
}

// Sodium ↔ salt regulatory conversion. NaCl is sodium (23) + chloride (35.5)
// = 58.5; sodium is 23/58.5 ≈ 39.3% of salt by mass. The EU labeling standard
// uses the rounded factor 2.5 (or its inverse 0.4), which matches what's
// printed on packaging. NutriTrace stores sodium in mg and salt in g, so the
// effective factor is 400 (sodium_mg = salt_g × 400; salt_g = sodium_mg / 400).
//
// Derived values are flagged via `nutrition._derived` so the UI can render a
// calculator icon next to the field. The flag is cleared automatically when
// the user manually edits the value.
const SODIUM_MG_PER_SALT_G = 400;

function _isPresent(v) {
  return v != null && v !== '' && Number(v) > 0;
}

/**
 * Mutates `nutrition` to fill in whichever of (sodium, salt) is missing,
 * deriving from the present one via the regulatory factor. If both are
 * present, no change. Sets `nutrition._derived.sodium` or `_derived.salt`
 * to true on the field that was filled in.
 *
 * Returns the same nutrition object (mutated) for convenient chaining.
 */
function deriveSodiumSalt(nutrition) {
  if (!nutrition || typeof nutrition !== 'object') return nutrition;
  const hasSodium = _isPresent(nutrition.sodium);
  const hasSalt   = _isPresent(nutrition.salt);
  if (hasSodium === hasSalt) return nutrition; // both or neither — leave alone

  if (!nutrition._derived || typeof nutrition._derived !== 'object') {
    nutrition._derived = {};
  }
  if (hasSodium && !hasSalt) {
    nutrition.salt = Math.round((Number(nutrition.sodium) / SODIUM_MG_PER_SALT_G) * 1000) / 1000;
    nutrition._derived.salt = true;
    nutrition._derived.sodium = false;
  } else if (hasSalt && !hasSodium) {
    nutrition.sodium = Math.round(Number(nutrition.salt) * SODIUM_MG_PER_SALT_G * 10) / 10;
    nutrition._derived.sodium = true;
    nutrition._derived.salt = false;
  }
  return nutrition;
}

const Nutrition = {
  deriveSodiumSalt,
  SODIUM_MG_PER_SALT_G,
  calculate(item) {
    if (!item) return {};
    // Split-recipe items: when a diary recipe has been "split" into its
    // ingredients (Cronometer-style explode), the item's authoritative
    // nutrition is the sum of its child ingredients, not its cached
    // top-level nutrition. The recipe identity (name + image) stays on the
    // parent for display but the math comes from the children.
    if (Array.isArray(item._splitItems) && item._splitItems.length > 0) {
      return Nutrition.sum(item._splitItems.map(c => Nutrition.calculate(c)));
    }
    const quantity = parseFloat(item.quantity) || 1;
    const factor = quantity; // nutrition values are per serving; quantity = number of servings
    const result = {};
    if (item.nutrition && typeof item.nutrition === 'object' && Object.keys(item.nutrition).length > 0) {
      // Nested structure (API foods and properly-saved FoodEditor items)
      for (const [key, val] of Object.entries(item.nutrition)) {
        if (key === '_derived') continue; // metadata, not a numeric value
        result[key] = (parseFloat(val) || 0) * factor;
      }
    } else {
      // Flat structure (legacy locally-created items)
      for (const n of NUTRIMENTS) {
        const v = item[n.id];
        if (v !== undefined && v !== '' && v !== null) {
          result[n.id] = (parseFloat(v) || 0) * factor;
        }
      }
      // Handle calories_kcal alias from old save format
      if (item.calories_kcal !== undefined && result.calories === undefined) {
        result.calories = (parseFloat(item.calories_kcal) || 0) * factor;
      }
    }
    // Fill in whichever of (sodium, salt) is missing so meals that sum across
    // ingredients produce consistent totals. The flag is stripped from the
    // result since transient calculations don't carry derivation metadata.
    deriveSodiumSalt(result);
    delete result._derived;
    return result;
  },

  sum(nutritionArray) {
    const result = {};
    for (const n of nutritionArray) {
      if (!n) continue;
      for (const [key, val] of Object.entries(n)) {
        result[key] = (result[key] || 0) + (parseFloat(val) || 0);
      }
    }
    return result;
  },

  macroPercents(nutrition) {
    if (!nutrition) return { fat: 0, carbs: 0, protein: 0 };
    const fatKcal = (nutrition.fat || 0) * 9;
    const carbKcal = (nutrition.carbohydrates || 0) * 4;
    const protKcal = (nutrition.proteins || 0) * 4;
    const total = fatKcal + carbKcal + protKcal;
    if (total === 0) return { fat: 0, carbs: 0, protein: 0 };
    return {
      fat: Math.round((fatKcal / total) * 100),
      carbs: Math.round((carbKcal / total) * 100),
      protein: Math.round((protKcal / total) * 100)
    };
  },

  kcalToKj(kcal) { return (parseFloat(kcal) || 0) * 4.184; },
  kjToKcal(kj)   { return (parseFloat(kj) || 0) / 4.184; },

  /** Format a kcal value for display in the user's chosen energy unit.
   *  Internal storage is always kcal; this is purely a display-layer
   *  conversion.
   *
   *  Returns { value, unit } so templates can format their own numbers
   *  (with commas, leading symbols, etc.) while still picking up the
   *  right unit label.
   *
   *  Example:
   *    const e = Nutrition.displayEnergy(2000, $energyUnit);
   *    `${e.value.toLocaleString()} ${e.unit}`   // "2,000 kcal" or "8,368 kJ"
   */
  displayEnergy(kcal, unit) {
    const n = parseFloat(kcal) || 0;
    if (unit === 'kJ') return { value: Math.round(n * 4.184), unit: 'kJ' };
    return { value: Math.round(n), unit: 'kcal' };
  },

  calculateTDEE({ gender, age, height_cm, weight_kg, activity }) {
    const h = parseFloat(height_cm) || 170;
    const wt = parseFloat(weight_kg) || 70;
    const a = parseInt(age) || 30;
    const bmr = (h * 6.25) + (wt * 9.99) - (a * 4.92) + (gender === 'male' ? 5 : -161);
    const mult = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 }[activity] || 1.2;
    return Math.round(bmr * mult);
  },

  getAll() {
    const custom = DB.getSetting('customNutriments', []);
    return [...NUTRIMENTS, ...custom];
  },

  getVisible() {
    const hidden = DB.getSetting('hiddenNutriments', []);
    const custom = DB.getSetting('customNutriments', []);
    return [...NUTRIMENTS, ...custom].filter(n => !hidden.includes(n.id));
  },

  getById(id) {
    const custom = DB.getSetting('customNutriments', []);
    return [...NUTRIMENTS, ...custom].find(n => n.id === id) || null;
  },

  format(value, decimals) {
    const v = parseFloat(value) || 0;
    const d = decimals !== undefined ? decimals : (v < 10 ? 1 : 0);
    return v.toFixed(d);
  },

  parseExpression(expr) {
    try {
      const clean = String(expr).replace(/[^0-9+\-*/.()]/g, '');
      // eslint-disable-next-line no-new-func
      const result = Function('"use strict"; return (' + clean + ')')();
      return isFinite(result) ? result : 0;
    } catch(e) {
      return parseFloat(expr) || 0;
    }
  }
};

export { NUTRIMENTS, Nutrition };
