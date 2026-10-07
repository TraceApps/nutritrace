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

// Only rows the diary's owner may read fill in its items: their own, ones
// shared with them (the same rule as lib/sharing.js canRead and GET
// /api/foods/:id), and the ingredients of a meal or recipe shared with
// them, which GET /api/meals/:id already hands them. These used to look
// across every account, so an item could pick up another account's
// category, barcode, units or photo. userId null (user management off)
// reads everything, as the routes do. One query each, not one per row.
const READABLE_MEAL = `(m.user_id IS NULL OR m.user_id = @u OR m.visibility = 'group'
  OR (m.visibility = 'specific' AND EXISTS (SELECT 1 FROM meal_shares ms WHERE ms.meal_id = m.id AND ms.user_id = @u)))`;
const READABLE_FOOD = `(f.user_id IS NULL OR f.user_id = @u OR f.visibility = 'group'
  OR (f.visibility = 'specific' AND EXISTS (SELECT 1 FROM food_shares fs WHERE fs.food_id = f.id AND fs.user_id = @u))
  OR f.id IN (SELECT CAST(COALESCE(json_extract(j.value, '$.food_server_id'), json_extract(j.value, '$.id')) AS INTEGER)
                FROM meals m, json_each(CASE WHEN json_valid(m.items) THEN m.items ELSE '[]' END) j
               WHERE m.deleted_at IS NULL AND j.type = 'object' AND ${READABLE_MEAL}))`;
const foodScope = userId => (userId == null ? { sql: '1', args: {} } : { sql: READABLE_FOOD, args: { u: userId } });
const mealScope = userId => (userId == null ? { sql: '1', args: {} } : { sql: READABLE_MEAL, args: { u: userId } });

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
/**
 * Re-attach the source food's safe-to-refresh render-time fields to each
 * diary item, using `food_server_id ?? id` as the key. Runs alongside
 * freshenItemImages — same read-time-only pattern, same fail-open safety.
 *
 * Why this exists (issue #125): stored diary items USED to snapshot every
 * field of the source food (recipe ingredients, alt_units, category,
 * barcode, etc.) on every log. Days accumulated hundreds of KB per item;
 * PUT /api/diary tripped the 5 MB body-parser limit for users logging
 * recipes repeatedly. Fix: store only the history-protected minimum
 * (name, brand, nutrition, portion, unit, quantity, notes) plus the id
 * keys, and live-resolve everything else on read.
 *
 * What gets re-attached (foods): nutrition_basis, alt_units, density_g_ml,
 * category, barcode — the fields the edit sheet + unit scaler read.
 * NAME/BRAND/NUTRITION/PORTION/UNIT/QUANTITY/NOTES stay from the snapshot
 * (history protection). imgUrl stays owned by freshenItemImages.
 *
 * For recipe items (`is_recipe` truthy): meals table has none of these
 * fields, so the meal lookup is a no-op — splitRecipeItem falls back to
 * NtApi.getMeal(recipeId) on demand for ingredient data.
 */
// #237: the foods column stores alt_units as a JSON string. Hand diary items
// the same array /api/foods returns (routes/foods.js parses it the same way),
// or the diary's unit scaler cannot find a household unit and "66 g" of a
// food logged by the slice scales as 66 slices. src/lib/units.js has the
// client-side twin (parseAltUnits); it is not imported here because the
// server image only ships the src/lib files its Dockerfile names.
function _altUnitsArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

const HYDRATE_FIELDS = ['nutrition_basis', 'alt_units', 'density_g_ml', 'category', 'barcode'];
// The food an item came from. food_server_id null (the key there, the
// value null) is an item the phone logged before its food reached the
// server: its id is the phone's own, not a server id, so it names no food
// here. The phone fills food_server_id in once the food goes up.
const _foodKey = it => (it.food_server_id === null ? null : (it.food_server_id ?? it.id));
export function hydrateItems(items, userId = null) {
  if (!Array.isArray(items) || !items.length) return items;
  try {
    // Collect ids we need to look up. Recipe items skip the foods query.
    const foodIds = new Set();
    for (const it of items) {
      if (it && !it.is_recipe) {
        const id = _foodKey(it);
        if (typeof id === 'number') foodIds.add(id);
      }
    }
    if (!foodIds.size) return items;
    const scope = foodScope(userId);
    const rows = db.prepare(
      `SELECT f.id, f.nutrition_basis, f.alt_units, f.density_g_ml, f.category, f.barcode
       FROM foods f WHERE f.id IN (SELECT value FROM json_each(@ids)) AND f.deleted_at IS NULL AND ${scope.sql}`
    ).all({ ...scope.args, ids: JSON.stringify(Array.from(foodIds)) });
    const byId = new Map(rows.map(r => [r.id, r]));
    return items.map(it => {
      if (!it || it.is_recipe) return _hydrateSplitChildren(it, userId);
      const id = _foodKey(it);
      const src = typeof id === 'number' ? byId.get(id) : null;
      if (!src) return _hydrateSplitChildren(it, userId);
      const out = { ...it };
      for (const k of HYDRATE_FIELDS) {
        if (src[k] == null || it[k] != null) continue;
        const v = k === 'alt_units' ? _altUnitsArray(src[k]) : src[k];
        if (v != null) out[k] = v;
      }
      return _hydrateSplitChildren(out, userId);
    });
  } catch {
    return items;
  }
}

// Recipe-split children are diary-item shaped too; hydrate them the same way.
function _hydrateSplitChildren(item, userId = null) {
  if (!item || !Array.isArray(item._splitItems) || !item._splitItems.length) return item;
  return { ...item, _splitItems: hydrateItems(item._splitItems, userId) };
}

export function freshenItemImages(items, userId = null) {
  if (!Array.isArray(items) || !items.length) return items;
  try {
    // #199 (@tellis82): skip data URLs. A base64 img_url can easily be
    // 400-800 KB, and this hydrator stamps it onto every diary item
    // referencing that food on every date served by GET /api/diary
    // (the all-days endpoint), producing 50 MB+ payloads once a
    // frequently-used food carries one. Data URLs are still visible on
    // the food's own detail view (that renders from the food row
    // directly); dropping them here only affects the diary hydration.
    // The write-side fix (sync push localizes incoming data URLs to
    // /uploads/) prevents new occurrences; this read-side filter also
    // shields existing rows that were pushed before the write fix.
    // The reader's own rows first, so their own Banana's photo wins a
    // name match over one shared with them.
    const fs = foodScope(userId), ms = mealScope(userId);
    const foods = db.prepare(
      `SELECT f.id, f.name, f.brand, f.img_url FROM foods f
        WHERE f.deleted_at IS NULL AND f.img_url IS NOT NULL AND f.img_url != '' AND f.img_url NOT LIKE 'data:%' AND ${fs.sql}
        ORDER BY ${userId == null ? '' : 'f.user_id = @u DESC,'} f.id ASC`
    ).all(fs.args);
    const meals = db.prepare(
      `SELECT m.id, m.name, m.img_url FROM meals m
        WHERE m.deleted_at IS NULL AND m.img_url IS NOT NULL AND m.img_url != '' AND m.img_url NOT LIKE 'data:%' AND ${ms.sql}
        ORDER BY ${userId == null ? '' : 'm.user_id = @u DESC,'} m.id ASC`
    ).all(ms.args);

    // Foods: three lookup tiers.
    const foodByIdName = new Map();
    const foodByNameBrand = new Map();
    const foodByName = new Map();
    for (const r of foods) {
      foodByIdName.set(`${r.id}|${_norm(r.name)}`, r.img_url);
      const nb = `${_norm(r.name)}|${_norm(r.brand)}`;
      // With accounts on, the reader's own row (first) wins; otherwise the
      // newest, as before.
      if (userId == null || !foodByNameBrand.has(nb)) foodByNameBrand.set(nb, r.img_url);
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
