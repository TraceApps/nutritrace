/**
 * off-nutrition.js: can NutriTrace use an Open Food Facts product's values (#241)?
 *
 * The OFF mapper turns every missing value into 0, so a product with no "as
 * sold" values used to arrive as a 0 kcal food: shown as 0 kcal, saved as
 * 0 kcal, and logged by Trace as 0 kcal with a success message. Over half
 * of OFF's chocolate drink powders are like that, because they list only
 * "as prepared" values.
 *
 * "As prepared" values are never used unasked. For a drink powder they
 * describe the finished drink made with milk, not the powder you weigh (a
 * 20 g scoop of Nesquik read as 14 kcal instead of about 75), and for baby
 * formula the column often holds the powder's own values typed in the wrong
 * place. NutriTrace cannot tell which it is, so the user chooses, seeing the
 * number first.
 */
import { applyOffRefresh } from './off-refresh.js';

/** Nothing edible is above this: pure fat is 900 kcal per 100 g. Above it is
 *  a typo, usually a kJ figure typed as kcal. */
export const MAX_KCAL_PER_100 = 900;

/**
 * What an OFF product offers, from API.offNutritionInfo(barcode).
 *   'ok'          it has "as sold" values; or it is a saved food, carries
 *                 calories of its own, or is not known to have come from
 *                 OFF, so there is nothing to say
 *   'prepared'    no "as sold" values, plausible "as prepared" ones to offer
 *   'implausible' no "as sold" values, "as prepared" ones that cannot be right
 *   'none'        no values at all, as far as OFF has told us
 */
export function offNutritionStatus(food, info) {
  if (!food || typeof food.id === 'number' || !food.barcode || !info) return 'ok';
  // A food that carries calories of its own is never flagged. The registry is
  // keyed by barcode, and a USDA food can share a UPC with an OFF product that
  // has no values; that food's own numbers are real and must stand.
  const ownKcal = Number(food.nutrition?.calories ?? food.calories);
  if (Number.isFinite(ownKcal) && ownKcal > 0) return 'ok';
  if (Array.isArray(info.present) && info.present.length) return 'ok';
  const prepared = info.prepared;
  if (prepared && Array.isArray(prepared.present) && prepared.present.length) {
    const kcal = Number(prepared.nutrition?.calories) || 0;
    return kcal > MAX_KCAL_PER_100 ? 'implausible' : 'prepared';
  }
  return 'none';
}

/** Whether a search hit's status could change with the full product lookup:
 *  search results leave out "as prepared" values. */
export function needsFullLookup(info) {
  return !!info && !info.full && !(Array.isArray(info.present) && info.present.length);
}

/**
 * The user chose to use a product's "as prepared" values. Converted to the
 * food's portion like any refresh, and a note records where they came from,
 * so the food never passes for "as sold" later.
 */
export function applyOffPrepared(food, info, nutrientIds, noteText) {
  const prepared = info?.prepared;
  const off = {
    portion: prepared?.portion ?? 100,
    unit: prepared?.unit ?? 'g',
    nutrition: prepared?.nutrition ?? {},
  };
  Object.defineProperty(off, '_offPresent', { value: prepared?.present ?? [], enumerable: false });
  const result = applyOffRefresh(food, off, nutrientIds);
  if (result.reason === 'updated' || result.reason === 'up_to_date') {
    const notes = String(result.food.notes || '');
    if (noteText && !notes.includes(noteText)) {
      result.food.notes = notes.trim() ? `${notes.trim()}\n${noteText}` : noteText;
    }
  }
  return result;
}
