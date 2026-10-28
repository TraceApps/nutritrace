/**
 * The right-hand column of the Nutrition Facts label (#297, @fatman00).
 *
 * 'dv'     % Daily Value, the FDA label as it has always read (default).
 * 'per100' The amount in 100 g, or 100 ml for a food measured by volume,
 *          so foods with different serving sizes can be compared.
 *
 * One column at a time. The setting is the synced user pref
 * 'nutritionFactsColumn' (stores/settings.js).
 */
export const FACTS_COLUMN_DEFAULT = 'dv';
export const FACTS_COLUMNS = ['dv', 'per100'];

export function factsColumn(v) {
  return FACTS_COLUMNS.includes(v) ? v : FACTS_COLUMN_DEFAULT;
}

/**
 * A per-serving value scaled to 100 g / 100 ml. `base` is the serving as
 * { amount, basis } from servingInBase / itemsInBase (lib/units.js); null
 * when the serving can't be weighed, and then so is the answer.
 */
export function per100(value, base) {
  if (value == null || value === '' || !base) return null;
  const v = Number(value);
  const a = Number(base.amount);
  if (!Number.isFinite(v) || !Number.isFinite(a) || a <= 0) return null;
  return v * 100 / a;
}
