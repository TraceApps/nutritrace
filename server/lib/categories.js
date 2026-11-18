/**
 * A food, meal or recipe's categories (#332). The app lets you pick several;
 * they're kept as a JSON list in `categories`. Foods also keep `category`,
 * the first of them: older Android apps, the public API, MCP and exports
 * read and send that one alone. Meals and recipes had no category column
 * at all, so what the Meal editor picked was never kept.
 *
 * A save that sends `categories` (this app) sets the list. One that sends
 * only `category` (an older app, or an API client) changes the first and
 * keeps the others it can't see; an empty one clears them, as that app
 * shows none left. One that sends neither leaves them as they are.
 */
import { cleanCategories, storedCategories } from '../../src/lib/categories.js';

export { cleanCategories, storedCategories };

const _has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/**
 * What a save sets, as stored: { categories: JSON text or null, category }
 * (`category` only matters for foods), or null when it sets nothing.
 */
export function categoriesFromSave(body, existing) {
  let list;
  if (_has(body, 'categories')) {
    list = cleanCategories(body.categories);
  } else if (_has(body, 'category')) {
    const was = storedCategories(existing);
    const first = cleanCategories(body.category)[0];
    if (!first) list = [];
    else if (first === was[0]) list = was;
    else list = [first, ...was.slice(1).filter(c => c !== first)];
  } else {
    return null;
  }
  return { categories: list.length ? JSON.stringify(list) : null, category: list[0] ?? null };
}

/** The list as it goes out on a row (a parsed array, never null). */
export function categoriesOut(row) {
  return storedCategories(row);
}
