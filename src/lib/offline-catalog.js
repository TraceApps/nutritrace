/** offline-catalog.js: filling the web app's offline copy of your foods, meals and recipes. */

/**
 * Fill this browser's copy of your foods, meals and recipes, so searching
 * them works offline without the Foods screen having been opened first (it
 * used to be the only thing that filled it). The same rows the Foods screen
 * keeps, so the copy never holds more than it would anyway. `api` is the
 * wrapped API (NtApi on the web), whose reads write the copy. Only online;
 * failures are left for the next load.
 */
export async function warmOfflineCatalog(api) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    await api.getFoods();
    await api.getMeals();
    await api.getRecipes();
    return true;
  } catch { return false; }
}
