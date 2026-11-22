/**
 * recipe-rollup.js: when a recipe saved in the meal editor keeps the
 * nutrition its source app worked out (CookTrace today), and when it
 * counts its own ingredients instead.
 *
 * CookTrace converts units by density ("2 cups flour" to grams), which the
 * editor's own sum can't, so its rollup is kept while the ingredients are
 * the ones it was worked out for. Change an amount, add, remove or swap an
 * ingredient and the rollup no longer describes the recipe: the editor's
 * sum is saved instead (#343). Reordering changes nothing.
 *
 * A rollup is kept as the whole recipe. A recipe opened from the catalog
 * stores values per serving, so it is multiplied back by the servings it
 * was saved with, and each save divides by the servings once (re-saving a
 * 4-serving recipe used to divide its values by 4 again).
 */

function _num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// One ingredient as the rollup sees it: what it is and how much. Values
// are rounded so a number that went to the server and back still matches.
function _key(it) {
  const round = v => Math.round(_num(v) * 1e6) / 1e6;
  const nutrition = it?.nutrition && typeof it.nutrition === 'object'
    ? Object.keys(it.nutrition).filter(k => k !== '_derived').sort().map(k => [k, round(it.nutrition[k])])
    : [];
  return JSON.stringify([
    String(it?.name ?? ''), round(it?.portion), String(it?.unit ?? ''), round(it?.quantity ?? 1), nutrition,
  ]);
}

/** The ingredients, in a form that ignores their order. */
export function ingredientsKey(items) {
  return (Array.isArray(items) ? items : []).map(_key).sort();
}

/**
 * The source's rollup as whole-recipe values plus the ingredients it
 * belongs to, or null when there is none to keep (no source, or no value
 * above zero). `perServing`: the values are per serving (a recipe loaded
 * from the catalog), so they are multiplied by `servings` (unset counts
 * as 1). Otherwise they are already the whole recipe (a fresh import).
 */
export function sourceRollup({ sourceApp, nutrition, items, servings = null, perServing = false } = {}) {
  if (!sourceApp || !nutrition || typeof nutrition !== 'object') return null;
  if (!Object.values(nutrition).some(v => _num(v) > 0)) return null;
  const times = perServing ? Math.max(1, parseInt(servings) || 1) : 1;
  const total = {};
  for (const [k, v] of Object.entries(nutrition)) {
    if (k === '_derived') continue;
    total[k] = _num(v) * times;
  }
  return { total, items: ingredientsKey(items) };
}

/**
 * The per-serving nutrition a recipe saves: the rollup while its
 * ingredients are unchanged (and no amount CookTrace couldn't convert was
 * set here since, #296), else the editor's own sum. Both are divided by
 * `yields` once.
 */
export function recipeSaveNutrition({ rollup, items, totals, yields = 1, ctAmountFixed = false } = {}) {
  const div = Math.max(1, parseInt(yields) || 1);
  const keep = rollup && !ctAmountFixed
    && JSON.stringify(ingredientsKey(items)) === JSON.stringify(rollup.items);
  const source = keep ? rollup.total : (totals || {});
  return Object.fromEntries(Object.entries(source).map(([k, v]) => [k, _num(v) / div]));
}
