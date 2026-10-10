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

/**
 * Classify a unit as mass-side or volume-side. Used by the Add to Diary
 * sheet to surface the cross-system warning when the picked unit's system
 * doesn't match the food's nutrition_basis and density is unset.
 * Returns 'g' for mass units, 'ml' for volume units, null for opaque
 * (cup/piece/custom). Issues #69 + #70.
 */
export function unitSystem(unit) {
  if (!unit) return null;
  const u = String(unit).toLowerCase();
  if (u === 'g' || u === 'mg' || u === 'kg' || u === 'oz' || u === 'lb') return 'g';
  if (_VOLUME_UNITS.has(u)) return 'ml';
  return null;
}

// Short SI / labeling abbreviations that consumers read tightly against
// the number ("500g", "250ml", "100kcal"). Everything else — named
// serving units ("Nugget(s)", "slice", "cup", "tbsp"), custom user
// units — gets a space so it doesn't visually smash together
// ("8Nugget(s)" vs "8 Nugget(s)"). Matches FDA nutrition-label +
// MyFitnessPal / MacroFactor / Lose It consumer convention. Cronometer
// is the outlier that spaces everything; every other tracker in the
// space uses this mixed style.
const _NO_SPACE_UNITS = new Set([
  'g','mg','kg','ml','l','oz','lb','mcg','µg','kcal','kj','iu','%',
]);

/**
 * Format an amount + unit for display. Uses no separator for short SI
 * abbreviations (500g, 250ml, 100kcal) and a single space for word /
 * named units (8 Nugget(s), 1 cup, 3 slices). Bug #143 (@javydekoning).
 */
export function amountAndUnit(amount, unit) {
  const u = (unit || 'g').toString();
  const sep = _NO_SPACE_UNITS.has(u.toLowerCase()) ? '' : ' ';
  return `${amount}${sep}${u}`;
}

/** Lookup factor; returns null for unknown / non-convertible units. */
export function unitToGrams(unit) {
  if (!unit) return null;
  const f = UNIT_TO_G[String(unit).toLowerCase()];
  return typeof f === 'number' ? f : null;
}

/**
 * alt_units as an array, whatever shape it arrived in. The foods column
 * stores a JSON string. /api/foods parses it, but diary items hydrated from
 * that column (server and Android) carried the raw string, so a household
 * unit never resolved and 66 g of a food logged by the slice scaled as 66
 * slices (#237). Android already holds diary days with the string stored
 * in them, so this must accept it whatever hydration does now.
 * Returns null for anything that is not a list.
 */
export function parseAltUnits(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

/**
 * Lookup grams-per-unit on a food-specific alt_units list. Used by
 * scaleFactor to turn "1 slice" into "35 g" for an OFF-imported bread.
 * Issues #69 + #70.
 *
 * `altUnits` is [{ abbr: 'slice', grams: 35 }, ...], or that list as the
 * JSON string the foods column stores (see parseAltUnits).
 * Returns null when not found or when the entry is malformed.
 */
function altUnitGrams(altUnits, unit) {
  const list = parseAltUnits(altUnits);
  if (!list || list.length === 0 || !unit) return null;
  const u = String(unit).toLowerCase();
  for (const r of list) {
    if (r && String(r.abbr || '').toLowerCase() === u) {
      const g = Number(r.grams);
      if (Number.isFinite(g) && g > 0) return g;
    }
  }
  return null;
}

/**
 * True when the unit is a base mass/volume unit we know the gram ratio of.
 * (Anything in UNIT_TO_G). Used to distinguish "slice/cookie/piece" from
 * "g/ml/cup" for the density-required check below.
 */
function isBaseUnit(unit) {
  return unitToGrams(unit) != null;
}

// Volume-system units in UNIT_TO_G. Anything not in this set is mass-side
// (g/mg/kg/oz/lb). Used by toCanonicalAmount to decide whether density is
// needed to bridge to the food's nutrition basis. Issues #69 + #70.
const _VOLUME_UNITS = new Set(['ml','l','tsp','tbsp','fl oz','cup']);

/**
 * Express (portion, unit) as a single number in the food's nutrition_basis
 * frame (g or ml).
 *
 * - When the unit and basis are in the same system → use UNIT_TO_G's
 *   table value directly. (For volume units, UNIT_TO_G's ratio is the
 *   water-blanket ml-per-unit, which is also the canonical-ml value.)
 * - When they cross systems → multiply or divide by density to bridge.
 *   No density → return null, signaling the caller to fall back to the
 *   1 ml ≈ 1 g approximation (existing behavior) OR to surface the warning.
 * - When the food has no basis → behave like the canonical UNIT_TO_G
 *   conversion (treat g and ml as fungible, preserving today's math).
 *
 * Issues #69 + #70.
 */
function toCanonicalAmount(portion, unit, food) {
  const baseG = unitToGrams(unit);
  if (baseG == null) return null; // opaque unit (cup/piece without table entry)
  const basis = food?.nutrition_basis;
  if (!basis) return portion * baseG; // existing 1ml=1g behavior

  const isVol = _VOLUME_UNITS.has(String(unit).toLowerCase());
  const sameSystem = (basis === 'g' && !isVol) || (basis === 'ml' && isVol);
  if (sameSystem) return portion * baseG;

  // Cross-system — needs density. baseG carries the water-blanket
  // approximation by default (mg=0.001, ml=1, tbsp=14.787, etc.). Density
  // re-scales to the food's actual ratio.
  const d = Number(food.density_g_ml);
  if (!Number.isFinite(d) || d <= 0) return null;
  if (basis === 'g'  && isVol)  return portion * baseG * d;   // ml→g
  if (basis === 'ml' && !isVol) return portion * baseG / d;   // g→ml
  return null;
}

/**
 * Compute the scaling factor between two (portion, unit) pairs.
 *
 * Resolution order (issues #69 + #70):
 *   1. Per-food alt_units row → grams for that specific portion (covers
 *      "1 slice", "1 cookie", "1 bottle"). Wins because it's the most
 *      explicit user signal.
 *   2. Base unit table (UNIT_TO_G) extended by density when present:
 *      both sides resolve to grams (or to the food's nutrition_basis when
 *      density bridges across systems). Covers the standard
 *      g/oz/lb/ml/l/tsp/tbsp/cup case plus the honey-tbsp-with-density case.
 *   3. Pure numeric ratio fallback (unchanged): for opaque units we can't
 *      convert (cup/piece/custom free-text without per-food data).
 *
 * `food` is optional — callers can omit it and get the original behavior.
 */
export function scaleFactor(origPortion, origUnit, newPortion, newUnit, food = null) {
  const op = parseFloat(origPortion);
  const np = parseFloat(newPortion);
  const origP = (Number.isFinite(op) && op > 0) ? op : 100;
  const newP  = (Number.isFinite(np) && np > 0) ? np : origP;

  // Tier 1: per-food alt_units (slice/cookie/bottle = X grams). Each side
  // independently resolves to grams via the alt list or the canonical
  // table. When both sides resolve in the food's nutrition_basis frame
  // (with density bridging if needed), we get an accurate ratio.
  const origAlt = food ? altUnitGrams(food.alt_units, origUnit) : null;
  const newAlt  = food ? altUnitGrams(food.alt_units, newUnit)  : null;

  // Helper: resolve a (portion, unit) pair to the food's canonical basis
  // amount. alt_units row (always grams) is consulted first; for a food
  // whose basis is 'ml', the alt_units grams convert to ml via density.
  // Returns null if conversion isn't possible (no density, opaque unit).
  function _resolve(portion, unit, altGrams) {
    if (altGrams != null) {
      const basis = food?.nutrition_basis;
      if (basis !== 'ml') return portion * altGrams; // basis g or unknown → use grams
      const d = Number(food.density_g_ml);
      if (Number.isFinite(d) && d > 0) return portion * altGrams / d; // g→ml
      return null; // can't bridge without density on a per-100-ml food
    }
    return toCanonicalAmount(portion, unit, food);
  }

  const origC = _resolve(origP, origUnit, origAlt);
  const newC  = _resolve(newP,  newUnit,  newAlt);
  if (origC != null && newC != null && origC > 0) {
    return newC / origC;
  }

  // Tier 3: fall back to pure numeric ratio (preserves existing behavior
  // for opaque units like "cup"/"piece" without per-food data, and for
  // cross-system picks on foods without density).
  return newP / origP;
}
