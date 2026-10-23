// Sends a Foods page item's id to the endpoint for the kind it really is.
//
// #282: foods live in one table and meals (recipes included) in another,
// and each table numbers its rows on its own, so meal 1 and food 1 are
// different things. Sending a meal's id to the foods endpoint deleted (or
// counted a use of) whichever food had that number. The Foods page's
// deletes (detail pane, long-press menu, Select Multiple) and the usage
// count of what it logs go through here so the id always reaches its own
// table.

const KIND_BY_TAB = { foodList: 'food', meals: 'meal', recipes: 'recipe' };

/** The kind of item a Foods page tab lists ('foodList' | 'meals' | 'recipes'). */
export function catalogKindForTab(tab) {
  return KIND_BY_TAB[tab] || null;
}

/**
 * @param {{ deleteFood: Function, deleteMeal: Function }} api
 * @param {'food'|'meal'|'recipe'} kind
 * @param {number|string} id
 */
export function deleteCatalogItem(api, kind, id) {
  if (kind === 'food') return api.deleteFood(id);
  if (kind === 'meal' || kind === 'recipe') return api.deleteMeal(id);
  // Never guess: an unknown kind could reach the wrong table.
  return Promise.reject(new Error(`Unknown item kind: ${kind}`));
}

/**
 * Counts one use (Most Used, Recently Used) of what a diary item was logged
 * from. `kind` is what the caller knows it logged; without it, a recipe is
 * told apart by is_recipe and anything else counts as a food, which is all
 * a diary item can say about itself (a saved meal logged as one row looks
 * like a food).
 */
export function markCatalogItemUsed(api, kind, item, date) {
  const k = kind || (item?.is_recipe ? 'recipe' : 'food');
  if (k === 'food') return api.markFoodUsed(item.id, date);
  if (k === 'meal' || k === 'recipe') return api.markMealUsed(item.id, date);
  return Promise.reject(new Error(`Unknown item kind: ${k}`));
}

/**
 * Whether this device can count a use of what an item was logged from.
 * Someone else's shared item (or an ingredient of one, `shared`) carries the
 * server's id. The web sends it to the server, which is right. The Android
 * app reads an id as one of its own rows', so it would count a use of
 * whichever of the user's own rows has that number (#282); it skips these.
 */
export function countsUseHere(item, { native = false, shared = false } = {}) {
  if (typeof item?.id !== 'number') return false;
  if (native && (shared || item._shared_by != null)) return false;
  return true;
}
