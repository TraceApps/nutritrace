/**
 * diary-helpers.js — shared transformations for diary item arrays.
 *
 * Used by both `routes/diary.js` (single-date + list endpoints) and
 * `routes/sync.js` (native pull endpoint) so the same image-resolution logic
 * runs everywhere diary items are returned to clients.
 *
 * Why imgUrl is LIVE-RESOLVED instead of trusted from the snapshot
 * ──────────────────────────────────────────────────────────────────
 * Diary items snapshot every field of the food at log time, including
 * imgUrl. Snapshot semantics are CORRECT for fields like name, brand, and
 * macros: a 100 kcal serving you ate last week should stay 100 kcal even if
 * the food row gets edited later (history protection). But snapshot
 * semantics are WRONG for imgUrl — the user always wants to see the food's
 * current image, not a frozen path that might:
 *   - point at a file that no longer exists (boot migrations renamed it,
 *     manual cleanup, etc.)
 *   - have been corrupted by a buggy Capacitor-cache strip function
 *     (which historically prepended `/uploads/` to OFF source basenames
 *     like 'front.en.6.400.jpg' → cross-pollination across foods)
 *   - reference a food id that got reshuffled when the foods table was
 *     restored or re-imported
 *
 * So this helper IGNORES the snapshot imgUrl entirely and overwrites it
 * with a live lookup against the current foods (and meals) tables, by id +
 * name first, falling back to name only. If nothing matches, imgUrl is set
 * to '' and the client renders a placeholder icon.
 *
 * DO NOT revert this back to snapshot semantics — it caused months of
 * "wrong image" / "broken image" bug reports. The strip-write-time hygiene
 * in src/lib/api-cached.js and src/stores/diary.js is now defensive only;
 * this read-time live-resolve is the actual safety net.
 */
import db from '../db.js';

const _norm = s => String(s || '').trim().toLowerCase();

/**
 * Live-resolve each diary item's imgUrl from the current foods/meals tables.
 *
 * Routing: a diary item with `is_recipe` truthy is looked up against the
 * meals table ONLY (recipes are meals with is_recipe=1). Anything else is
 * looked up against the foods table ONLY. Mixing the two pools caused
 * "Chicken Soup recipe pulled the image from a food named Chicken Soup",
 * which is the bug being fixed.
 *
 * Within each pool, lookup order is:
 *  1. id + name match (strongest signal; survives unless the foods table
 *     was rebuilt and ids reshuffled)
 *  2. name + brand match (foods only; disambiguates between e.g. multiple
 *     "Fat Free Milk" entries from different brands)
 *  3. name only (last resort; first-inserted-row wins when the user has
 *     duplicates with no brand to tie-break)
 *  4. empty string (renders placeholder)
 *
 * Wrapped in try/catch so a query error never breaks the calling
 * endpoint — falls through to returning items unchanged.
 */
export function freshenItemImages(items) {
  if (!Array.isArray(items) || !items.length) return items;
  try {
    const foods = db.prepare(
      `SELECT id, name, brand, img_url FROM foods WHERE deleted_at IS NULL AND img_url IS NOT NULL AND img_url != '' ORDER BY id ASC`
    ).all();
    const meals = db.prepare(
      `SELECT id, name, img_url FROM meals WHERE deleted_at IS NULL AND img_url IS NOT NULL AND img_url != '' ORDER BY id ASC`
    ).all();

    // Foods: three lookup tiers.
    const foodByIdName = new Map();
    const foodByNameBrand = new Map();
    const foodByName = new Map();
    for (const r of foods) {
      foodByIdName.set(`${r.id}|${_norm(r.name)}`, r.img_url);
      foodByNameBrand.set(`${_norm(r.name)}|${_norm(r.brand)}`, r.img_url);
      // First-inserted wins for the name-only fallback (ORDER BY id ASC + setIfAbsent).
      if (!foodByName.has(_norm(r.name))) foodByName.set(_norm(r.name), r.img_url);
    }
    // Meals: two lookup tiers (no brand on meals/recipes).
    const mealByIdName = new Map();
    const mealByName = new Map();
    for (const r of meals) {
      mealByIdName.set(`${r.id}|${_norm(r.name)}`, r.img_url);
      if (!mealByName.has(_norm(r.name))) mealByName.set(_norm(r.name), r.img_url);
    }

    return items.map(it => {
      const name = _norm(it.name);
      const brand = _norm(it.brand);
      const idKey = `${it.id}|${name}`;
      let live;
      if (it.is_recipe) {
        live = mealByIdName.get(idKey) || mealByName.get(name) || '';
      } else {
        live = foodByIdName.get(idKey)
          || foodByNameBrand.get(`${name}|${brand}`)
          || foodByName.get(name)
          || '';
      }
      return { ...it, imgUrl: live };
    });
  } catch {
    return items;
  }
}
