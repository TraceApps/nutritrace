/**
 * units.js — small NutriTrace unit catalog.
 *
 * Stored value is the short abbreviation ("g", "tsp", etc). The
 * <UnitPicker> shows full name + abbr in the popover. Anything not
 * in this list is still accepted as free text and stored as-is; it
 * just won't get mass-based nutrition scaling.
 *
 * `UNIT_TO_G` is the mass-conversion table the nutrition scaler
 * uses. Units that aren't in this map (cup, tbsp, piece, etc.) are
 * intentionally density-dependent — we can't convert them to grams
 * without per-food knowledge, so nutrition for those scales by the
 * portion number only (the current pre-fix behavior).
 */

export const UNIT_GROUPS = [
  {
    label: 'Mass — Metric',
    units: [
      { abbr: 'g',  full: 'gram' },
      { abbr: 'mg', full: 'milligram' },
      { abbr: 'kg', full: 'kilogram' },
    ],
  },
  {
    label: 'Mass — US',
    units: [
      { abbr: 'oz', full: 'ounce' },
      { abbr: 'lb', full: 'pound' },
    ],
  },
  {
    label: 'Volume — Metric',
    units: [
      { abbr: 'ml', full: 'milliliter' },
      { abbr: 'l',  full: 'liter' },
    ],
  },
  {
    label: 'Volume — US',
    units: [
      { abbr: 'tsp',   full: 'teaspoon' },
      { abbr: 'tbsp',  full: 'tablespoon' },
      { abbr: 'fl oz', full: 'fluid ounce' },
      { abbr: 'cup',   full: 'cup' },
    ],
  },
  {
    label: 'Count',
    units: [
      { abbr: 'piece', full: 'piece' },
      { abbr: 'slice', full: 'slice' },
    ],
  },
];

/**
 * Grams-per-unit conversion table for the mass-convertible units.
 *
 * ml -> g uses the water-equivalent approximation (1 ml ≈ 1 g). It's
 * exact for water, close for milk/juice, wrong for oil/honey. This
 * matches what every other tracker (MFP/Cronometer/LoseIt) does and
 * is what users intuitively expect when scaling liquids.
 *
 * cup / tbsp / tsp / piece / slice / serving are intentionally
 * omitted — those are food-specific and can't be reduced to grams
 * without per-food density data we don't have.
 */
export const UNIT_TO_G = {
  // Mass — exact
  g:    1,
  mg:   0.001,
  kg:   1000,
  oz:   28.3495,
  lb:   453.592,
  // Volume — water-blanket bridge (1 ml ≈ 1 g). Right for water,
  // close for milk/juice, wrong for oil/honey. Matches MFP/Cronometer/LoseIt.
  ml:   1,
  l:    1000,
  tsp:  4.929,    // US teaspoon
  tbsp: 14.787,   // US tablespoon
  'fl oz': 29.574,
  cup:  236.588,
};

/**
 * Merge user-defined custom units into the built-in catalog as a
 * "Custom" group pinned at the top of the popover. customs is an
 * array of { abbr, full } entries from the customUnits setting.
 * Customs are NOT in UNIT_TO_G — picking one falls back to the pure
 * portion ratio in scaleFactor().
 */
export function unitGroupsWithCustoms(customs) {
  const list = Array.isArray(customs) ? customs.filter(c => c && c.abbr) : [];
  if (list.length === 0) return UNIT_GROUPS;
  return [
    { label: 'Custom', units: list.map(c => ({ abbr: c.abbr, full: c.full || c.abbr })) },
    ...UNIT_GROUPS,
  ];
}

/**
 * True when both units are mass-convertible. Callers use this to
 * decide whether nutrition can be scaled across a unit change.
 */
export function isMassConvertible(unit) {
  if (!unit) return false;
  return Object.prototype.hasOwnProperty.call(UNIT_TO_G, String(unit).toLowerCase());
}

/** Lookup factor; returns null for unknown / non-convertible units. */
export function unitToGrams(unit) {
  if (!unit) return null;
  const f = UNIT_TO_G[String(unit).toLowerCase()];
  return typeof f === 'number' ? f : null;
}

/**
 * Compute the scaling factor between two (portion, unit) pairs.
 *
 * When BOTH units are mass-convertible: scale by mass ratio
 *   factor = (newPortion * gramsPerNewUnit) / (origPortion * gramsPerOrigUnit)
 *
 * When either side isn't mass-convertible (cup, piece, tbsp, custom
 * free-text, etc.): fall back to the pure numeric ratio
 *   factor = newPortion / origPortion
 *
 * This preserves the pre-fix behavior for opaque "1 piece" /
 * "1 serving" units while adding correct conversion for the
 * g/oz/lb/ml/l class.
 */
export function scaleFactor(origPortion, origUnit, newPortion, newUnit) {
  const op = parseFloat(origPortion);
  const np = parseFloat(newPortion);
  const origP = (Number.isFinite(op) && op > 0) ? op : 100;
  const newP  = (Number.isFinite(np) && np > 0) ? np : origP;
  const og = unitToGrams(origUnit);
  const ng = unitToGrams(newUnit);
  if (og != null && ng != null) {
    return (newP * ng) / (origP * og);
  }
  return newP / origP;
}
