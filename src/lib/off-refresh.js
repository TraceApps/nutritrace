/**
 * off-refresh.js: what Refresh from OFF does to a food in the editor (#241).
 *
 * It used to fill only empty fields, so once a food had numbers a refresh
 * could never change them, and it still said it had refreshed. It now brings
 * the food's nutrition up to what Open Food Facts has today:
 *
 *  - Only nutrients OFF actually has are touched. The OFF mapper turns a
 *    missing value into 0 (see _offPresent in api.js), and writing that 0
 *    over a real number would be worse than doing nothing.
 *  - Values are converted to the food's own portion. OFF's are per 100 g (or
 *    per serving), and a food kept per 50 g would otherwise double. When the
 *    two units cannot be converted (a food kept per "slice", say), nothing
 *    changes and the caller says why.
 *  - Name, brand and photo still only fill in when empty: you may have
 *    renamed the food on purpose, and those are not the facts that changed.
 *
 * Nothing is saved here. The editor shows the result and the user decides
 * whether to Save, as before.
 */
import { parseDecimal } from './decimal-input.js';
import { unitToGrams } from './units.js';

/** How much of OFF's amount the food's portion is, or null if not convertible. */
function _portionFactor(foodPortion, foodUnit, offPortion, offUnit) {
  const fp = parseDecimal(foodPortion);
  const op = parseDecimal(offPortion);
  if (!(op > 0) || !(fp > 0)) return null;
  const fu = String(foodUnit || 'g').trim().toLowerCase();
  const ou = String(offUnit || 'g').trim().toLowerCase();
  const fg = unitToGrams(fu);
  const og = unitToGrams(ou);
  // Both in the app's gram table (mass, and volume at 1 ml = 1 g, the
  // convention the rest of the app uses).
  if (fg != null && og != null) return (fp * fg) / (op * og);
  if (fu === ou) return fp / op;
  return null;
}

function _same(current, next) {
  const x = parseDecimal(current);
  if (!Number.isFinite(x)) return false;
  return Math.abs(x - next) <= Math.max(0.005, Math.abs(next) * 1e-9);
}

/**
 * @param {object} food         the editor's food (nutrient values keyed by id)
 * @param {object} off          API.lookupBarcode's result, carrying _offPresent
 * @param {string[]} nutrientIds the ids to consider (NUTRIMENTS)
 * @returns {{ food: object, changed: number, reason: string }}
 *   reason: 'updated' | 'up_to_date' | 'prepared_only' | 'no_nutrition' | 'units_differ'
 */
export function applyOffRefresh(food, off, nutrientIds) {
  const next = { ...food };
  if (!next.name && off.name)     next.name  = off.name;
  if (!next.brand && off.brand)   next.brand = off.brand;
  if (!next.imgUrl && off.imgUrl) next.imgUrl = off.imgUrl;

  const present = new Set(off._offPresent || []);
  if (!present.size) {
    return { food: next, changed: 0, reason: off._offPreparedOnly ? 'prepared_only' : 'no_nutrition' };
  }

  // A food with no portion yet takes OFF's, so its numbers mean something.
  if (!(parseDecimal(next.portion) > 0)) {
    next.portion = off.portion;
    next.unit = off.unit;
  }
  const factor = _portionFactor(next.portion, next.unit, off.portion, off.unit);
  if (factor == null) return { food: next, changed: 0, reason: 'units_differ' };

  let changed = 0;
  for (const id of nutrientIds) {
    if (!present.has(id)) continue;
    const raw = Number(off.nutrition?.[id]);
    if (!Number.isFinite(raw)) continue;
    const value = factor === 1 ? raw : Math.round(raw * factor * 100) / 100;
    if (!_same(next[id], value)) {
      next[id] = value;
      changed++;
    }
  }
  // The calculator icon on salt or sodium marks a value worked out from the
  // other. After a refresh both are whatever OFF gave, so the marks follow
  // OFF's: on where OFF only had one of the two, off otherwise. Left as it
  // was, a mark could claim a value is calculated when OFF now lists it.
  if (present.has('salt') || present.has('sodium')) {
    const d = off.nutrition?._derived || {};
    next._derived = { ...(next._derived || {}), salt: !!d.salt, sodium: !!d.sodium };
  }
  return { food: next, changed, reason: changed ? 'updated' : 'up_to_date' };
}
