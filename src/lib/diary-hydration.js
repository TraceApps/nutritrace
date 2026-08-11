/**
 * Resolve recipe split children when no food rows need database hydration.
 *
 * The child hydrator is async because split children can recursively require
 * food lookups. Always await every result before the diary image pass reads
 * item fields; returning the raw `map()` result would expose Promises instead
 * of diary items for recipe-only days.
 */
export function hydrateWithoutFoods(items, hydrateSplitChildren) {
  return Promise.all(items.map(hydrateSplitChildren));
}
