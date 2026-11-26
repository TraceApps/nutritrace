// #348: the food editor opened while adding to the diary. The serving typed
// there is what was eaten, not the food's own serving, so the food keeps the
// serving it opened with, its nutrition rescaled to it, and only the diary
// gets the amount typed.
import { canScale, scaleFactor, unitSystem } from './units.js';
import { parseDecimal } from './decimal-input.js';

// The serving the editor opened with: a saved food's, or one that came from
// Open Food Facts, USDA or Mealie. Null for a food typed in from scratch.
export function keptServingOf(prefill) {
  const portion = parseDecimal(prefill?.portion);
  if (!(portion > 0)) return null;
  return { portion, unit: prefill.unit || 'g' };
}

// The food to save: `item` (as typed) moved to the kept serving. As typed
// when nothing is kept, nothing changed, or the units don't convert.
export function atKeptServing(item, kept) {
  if (!kept) return item;
  const portion = parseDecimal(item.portion);
  const unit = item.unit || 'g';
  if (!(portion > 0)) return item;
  if (portion === kept.portion && unit === kept.unit) return item;
  if (!canScale(unit, kept.unit, item)) return item;
  // Grams to milliliters (or back) on a food with no nutrition basis is the
  // 1 ml = 1 g stand-in, a guess: saved as typed rather than rewritten on it.
  // With a basis, canScale already needs a density for it.
  const a = unitSystem(unit), b = unitSystem(kept.unit);
  if (a && b && a !== b && !item.nutrition_basis) return item;
  const factor = scaleFactor(portion, unit, kept.portion, kept.unit, item);
  const round = v => Math.round(v * factor * 10000) / 10000;
  const nutrition = {};
  for (const [k, v] of Object.entries(item.nutrition || {})) {
    nutrition[k] = typeof v === 'number' ? round(v) : v;
  }
  const out = { ...item, portion: kept.portion, unit: kept.unit, nutrition };
  // The editor's flat fields too, so nothing reads the typed amount's values.
  for (const k of Object.keys(nutrition)) {
    if (typeof nutrition[k] === 'number' && k in item) out[k] = nutrition[k];
  }
  return out;
}
