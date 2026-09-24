/**
 * stale-ingredients.js: which ingredients of a saved meal point at a food
 * that is no longer in the catalogue.
 *
 * A meal stores its ingredients as a snapshot (name, portion, unit,
 * nutrition), so expanding it into the diary keeps working even after the
 * source food is deleted. That is deliberate: editing or deleting a food
 * must never rewrite what was already logged. The cost is that a meal can
 * go on logging a food the user can no longer find or edit, and nothing
 * says so. The 404 on the usage bump is the only trace it leaves, and that
 * is swallowed.
 *
 * This finds those ingredients by name so the app can point at them.
 *
 * Both id shapes count on both sides. A PWA food row has no `server_id`
 * key and its `id` IS the server's id; an Android cache row carries a
 * local autoincrement `id` plus the server's id in `server_id`, and the
 * renumbering that follows a re-install means an ingredient saved on one
 * device can legitimately match either one. Accepting both is what keeps a
 * good ingredient from being accused.
 */

const _ids = (row) => [row?.id, row?.server_id, row?.food_server_id]
  .filter(v => typeof v === 'number');

/**
 * @param {Array} items        a meal's saved ingredients
 * @param {Array<Array>} catalogues  the lists an ingredient may belong to
 *                                   (foods, meals, recipes)
 * @returns {string[]} names of ingredients with no match, in meal order
 */
export function staleIngredientNames(items, catalogues) {
  if (!Array.isArray(items) || !items.length) return [];
  const lists = (catalogues || []).filter(Array.isArray);
  // No catalogue, no verdict. An empty or failed load must never read as
  // "every ingredient is missing", so the caller gets nothing to report.
  if (!lists.some(l => l.length)) return [];

  const known = new Set();
  for (const list of lists) for (const row of list) for (const id of _ids(row)) known.add(id);

  return items
    .filter(it => {
      const ids = _ids(it);
      // An ingredient with no numeric id at all (Open Food Facts, USDA,
      // hand-typed) was never linked to a catalogue row, so there is
      // nothing for it to have lost.
      return ids.length > 0 && !ids.some(id => known.has(id));
    })
    .map(it => it?.name)
    .filter(Boolean);
}
