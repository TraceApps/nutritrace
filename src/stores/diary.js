import { writable, derived } from 'svelte/store';
import { NtApi } from '../lib/api.js';
import { Nutrition } from '../lib/nutrition.js';
import { localDateStr, DB } from '../lib/db.js';
import { resolveAssetUrl, restoreCachedAssetUrl } from '../lib/platform.js';
import { stripInlineDiaryImages } from '../lib/diary-payload.js';

function todayStr() {
  return localDateStr();
}

export const currentDate  = writable(todayStr());
export const currentEntry = writable(null);
export const diaryLoadError = writable(false);
export const diaryLoadErrorMsg = writable('');
// UI state — controlled from App.svelte topbar buttons, consumed in Diary.svelte
export const diaryShowNutritionSummary = writable(false);
export const diaryShowBodyStats        = writable(false);

export const diaryTotals = derived(currentEntry, $entry => {
  if (!$entry || !$entry.items) return {};
  return Nutrition.sum($entry.items.map(i => Nutrition.calculate(i)));
});

export const macroPercents = derived(diaryTotals, $t => {
  return Nutrition.macroPercents($t);
});

// Map API snake_case → app camelCase, resolve image URLs for native server mode
function _fromApi(entry) {
  if (!entry) return null;
  const items = (entry.items || []).map(i => i.imgUrl ? { ...i, imgUrl: resolveAssetUrl(i.imgUrl) } : i);
  return { ...entry, items, bodyStats: entry.body_stats || {}, body_stats: undefined, notes: entry.notes || '' };
}

// Map app camelCase → API snake_case
// Strip Capacitor file paths from imgUrl before sending to server
function _stripCachedPaths(items) {
  if (!items || !Array.isArray(items)) return items;
  return stripInlineDiaryImages(items).map(i => {
    if (!i.imgUrl) return i;
    // Full server-host URL → strip back to relative /uploads/... path. See
    // _stripResolvedImgUrl in src/lib/api-cached.js for the same logic; both
    // strip functions need to keep full URLs OUT of the persisted snapshot,
    // since they'd otherwise round-trip through the diary table and trigger
    // bad re-resolution on read.
    try {
      const idx = i.imgUrl.indexOf('/uploads/');
      if (i.imgUrl.startsWith('http') && idx >= 0) {
        return { ...i, imgUrl: i.imgUrl.slice(idx) };
      }
    } catch {}
    // Capacitor cache filenames are hashes and cannot be converted back by
    // inspecting their basename. Recover the exact source from the cache map.
    if (i.imgUrl.includes('_capacitor_file_') || i.imgUrl.includes('/image_cache/')) {
      return { ...i, imgUrl: restoreCachedAssetUrl(i.imgUrl) || '' };
    }
    // Strip proxy URLs back to original (they get resolved at display time)
    if (i.imgUrl.includes('/api/proxy?url=')) {
      try {
        const proxyUrl = new URL(i.imgUrl);
        const original = proxyUrl.searchParams.get('url');
        if (original) return { ...i, imgUrl: original };
      } catch {}
    }
    return i;
  });
}

function _toApi(entry) {
  return {
    items:      _stripCachedPaths(entry.items || []),
    body_stats: entry.bodyStats  || entry.body_stats || {},
    water:      entry.water      || [],
    notes:      entry.notes      || '',
  };
}

export async function loadEntry(dateStr) {
  currentDate.set(dateStr);
  let entry = null;
  let failed = false;
  try {
    const raw = await NtApi.getDiaryDate(dateStr);
    entry = _fromApi(raw);
  } catch(e) {
    console.error('[diary] loadEntry error:', e);
    diaryLoadErrorMsg.set(e?.message || String(e));
    failed = true;
  }
  let curDate = null;
  currentDate.subscribe(v => curDate = v)();
  if (curDate === dateStr) {
    diaryLoadError.set(failed);
    // On failure, set currentEntry to null (not a synthetic placeholder) so
    // the cache-check in Diary.svelte's onMount can detect "no real entry"
    // and re-fetch on the next mount (e.g. after the user logs in following
    // a 401). A placeholder with date=targetDate would fool the skip-refetch
    // logic and leave the user staring at a permanent error banner.
    currentEntry.set(failed ? null : (entry || { date: dateStr, items: [], bodyStats: {}, water: [] }));
  }
  return entry || null;
}

/**
 * Issue #81 — always refetch the server's current entry before applying
 * a save mutation. The previous "use cached currentEntry" pattern silently
 * wiped body_stats / items / water / notes when one device's write
 * happened to land while another device's cache was still stale: the
 * stale cache had empty defaults for fields the user hadn't touched, the
 * full-row PUT echoed those empties, and the server's real values were
 * overwritten. By refetching first, the mutator operates on the freshest
 * possible server state and only the field the user actually touched
 * changes; everything else passes through untouched.
 *
 * Trade-off: every diary write now costs one extra GET round-trip. On a
 * typical session of 10–20 writes that's well under a second of total
 * extra wall time, in exchange for closing the data-loss class.
 *
 * Use this for APPEND and SET style mutations (addDiaryItem, addWaterLog,
 * saveBodyStats, saveDiaryNote, meal copy/move/clear). Index-based ops
 * (removeDiaryItem, updateDiaryItem, split-child mutations) intentionally
 * stay on the cached entry because their array indices are positional and
 * a refetch could cause the wrong item to be acted on; they have a
 * separate residual race that a stable per-item id would solve.
 *
 * The mutator returns the updated entry, or null to abort the save
 * (useful for short-circuit cases like saveDiaryNote when the new value
 * equals the existing one).
 */
async function _refetchAndSave(targetDate, mutator) {
  let entry = _fromApi(await NtApi.getDiaryDate(targetDate));
  if (!entry) entry = { date: targetDate, items: [], bodyStats: {}, water: [] };
  const updated = mutator(entry);
  if (updated == null) return null;
  const saved = await _save(updated);
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  if (targetDate === viewDate) currentEntry.set(saved);
  return saved;
}

async function _save(entry) {
  const saved = await NtApi.saveDiaryDate(entry.date, _toApi(entry));
  const result = _fromApi(saved);

  // Check goals after every save (only for today)
  const today = new Date().toLocaleDateString('sv-SE');
  if (entry.date === today && result.items?.length) {
    try {
      const { Nutrition } = await import('../lib/nutrition.js');
      const { checkGoals } = await import('../lib/notifications.js');
      const { DB } = await import('../lib/db.js');
      const goals = DB.getSetting('goals', {});
      const totals = Nutrition.sum(result.items.map(i => Nutrition.calculate(i)));
      const waterMl = (result.water || []).reduce((s, l) => s + (l.amount || 0), 0);
      // Add water goal from waterGoalMl setting (it's separate from the goals object)
      const waterGoal = DB.getSetting('waterGoalMl', 0);
      if (waterGoal > 0) goals.water_ml = { min: waterGoal };
      await checkGoals(goals, { ...totals, water_ml: waterMl });
    } catch (e) {
      console.debug('[diary] goal check failed:', e.message);
    }
  }

  return result;
}

export async function addDiaryItem(foodItem, meal, date) {
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  const targetDate = date || viewDate || todayStr();

  // food_server_id — the stable, cross-device identifier for the source
  // food. PWA's food rows omit a `server_id` key entirely and their `id`
  // IS the server's id. Android cache rows have an explicit `server_id`
  // column that may be a number (synced) or null (local-only). Detecting
  // by key presence avoids guessing which of the two ids is stable.
  // Stored on the diary item so liveImgFor and friends can look up the
  // correct food regardless of any local-autoincrement renumbering that
  // happens after an Android re-install.
  const food_server_id = ('server_id' in foodItem)
    ? foodItem.server_id
    : (typeof foodItem.id === 'number' ? foodItem.id : null);
  const item = {
    ...foodItem,
    meal: meal != null ? Number(meal) : 0,
    addedAt: new Date().toISOString(),
    food_server_id,
  };

  // Issue #81: refetch from server before write so the append doesn't
  // wipe body_stats / water / notes that another device pushed in the
  // window since this client's cache was loaded.
  await _refetchAndSave(targetDate, (entry) => ({
    ...entry,
    items: [...(entry.items || []), item],
  }));

  // Bump usage_count + last_used_at on the source food so it can rise in
  // the "Most Used" / "Recently Used" sort modes. Fire-and-forget; a failed
  // bump shouldn't block the diary save the user already saw succeed.
  if (typeof item.id === 'number') {
    NtApi.markFoodUsed(item.id, targetDate).catch(() => {});
  }
}

/** Add a "Quick Calories" entry to the diary — a calorie-(plus-optional-
 *  macros)-only row that bypasses the food/portion flow. Used for
 *  Fitbit-style "I just want to log 200 kcal and move on" cases AND the
 *  MFP-style "kcal + the macros I know off the label" case (nomad64
 *  follow-up on #42). Shape: type='quick_calories', name (user-supplied
 *  or default), nutrition.{calories, proteins?, carbohydrates?, fat?}.
 *  Optional macros are omitted entirely when blank so daily totals
 *  aren't polluted with zero-filled phantoms. Renders as a dedicated row
 *  in the diary; multiple entries per meal can be either summed or shown
 *  separately per the `quickCaloriesDisplay` setting. */
export async function addQuickCalories({ kcal, name, meal, date, proteins, carbohydrates, fat } = {}) {
  const calories = Math.max(0, Math.round(Number(kcal) || 0));
  if (!calories) throw new Error('Quick Calories requires a positive kcal value.');
  const nutrition = { calories };
  // Optional macros — only include when a positive numeric value was supplied.
  // Round to 1 decimal place to match the rest of the diary's macro storage.
  const _opt = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
  };
  const p = _opt(proteins),       c = _opt(carbohydrates), f = _opt(fat);
  if (p != null) nutrition.proteins      = p;
  if (c != null) nutrition.carbohydrates = c;
  if (f != null) nutrition.fat           = f;
  const item = {
    type: 'quick_calories',
    name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 60) : 'Quick Calories',
    nutrition,
    // No portion/unit/quantity — render branch skips the portion line for this type.
    // Diary totals sum item.nutrition.* regardless of type, so macros flow through
    // to daily/weekly summaries + the existing macro ring without any extra wiring.
  };
  return addDiaryItem(item, meal, date);
}

// NOTE: removeDiaryItem / updateDiaryItem / splitRecipeItem /
// removeSplitChild / updateSplitChild all operate on a positional
// array index from the rendered cached view. Issue #81's refactor
// uses _refetchAndSave for append/set paths, but these index-based
// paths intentionally stay on the cached entry: refetching first
// could shift items in the array (another device added/removed
// items) and cause the deletion / update to land on the WRONG
// item. The residual race is that a concurrent write from another
// device can still get wiped by these paths' full-row PUT. A
// proper fix requires stable per-item identifiers; tracked for a
// follow-up commit.
export async function removeDiaryItem(index) {
  let entry = null;
  currentEntry.subscribe(v => entry = v)();
  if (!entry) return;
  const updated = { ...entry, items: entry.items.filter((_, i) => i !== index) };
  currentEntry.set(await _save(updated));
}

export async function updateDiaryItem(index, changes) {
  let entry = null;
  currentEntry.subscribe(v => entry = v)();
  if (!entry) return;
  const updated = { ...entry, items: entry.items.map((item, i) => i === index ? { ...item, ...changes } : item) };
  currentEntry.set(await _save(updated));
}

/**
 * Split a single recipe diary item into its constituent ingredients while
 * preserving the recipe identity. The recipe row stays as a single line in
 * the diary (with its name + image) but gets a `_splitItems` array of
 * scaled children that the UI renders expandable underneath. Removing a
 * child decrements the parent's totals; removing the last child collapses
 * the parent back to a regular un-split entry.
 *
 * Mirrors Cronometer's "Explode Recipe" but keeps the parent visible —
 * users still see "Chicken Stir Fry" with its picture, and can drill in
 * via a chevron when they want to drop one ingredient. The saved recipe
 * in the library is untouched.
 *
 * Sources for ingredients (in priority order):
 *   1. The diary item's own `items[]` array — recipes added via Foods.svelte
 *      spread the meal/recipe row in, so each diary item already carries
 *      the full ingredient list.
 *   2. Fallback: fetch the recipe by `food_server_id` (or `id`) via NtApi.
 *
 * Scale factor: (item portion × item quantity) / (recipe portion × recipe
 * quantity). Logging 1.5 servings of a recipe produces 1.5x of every
 * ingredient.
 */
export async function splitRecipeItem(index) {
  let entry = null;
  currentEntry.subscribe(v => entry = v)();
  if (!entry || !Array.isArray(entry.items) || index < 0 || index >= entry.items.length) return false;

  const item = entry.items[index];
  // Already split — no-op. Avoids accidentally re-scaling.
  if (Array.isArray(item._splitItems) && item._splitItems.length > 0) return false;

  let recipe = item;
  if (!Array.isArray(item.items) || item.items.length === 0) {
    const recipeId = item.food_server_id ?? item.id;
    if (typeof recipeId !== 'number') return false;
    try { recipe = await NtApi.getMeal(recipeId); }
    catch { return false; }
  }
  if (!Array.isArray(recipe.items) || recipe.items.length === 0) return false;

  const itemMass = (item.portion || 100) * (item.quantity || 1);
  // Derive the recipe's true total mass from the sum of its ingredients.
  // recipe.portion is unreliable for scale math because users can hand-edit
  // it after auto-fill (e.g., overwriting the 2299g auto-sum with a 300g
  // per-serving value). The ingredient totals are what they actually are.
  let ingredientsMass = 0;
  for (const ing of recipe.items) {
    const p = parseFloat(ing.portion);
    const q = parseFloat(ing.quantity);
    if (!Number.isFinite(p) || p <= 0) continue;
    ingredientsMass += p * (Number.isFinite(q) && q > 0 ? q : 1);
  }
  const recipeMass = ingredientsMass > 0
    ? ingredientsMass
    : (recipe.portion || 100) * (recipe.quantity || 1);
  const scale = recipeMass > 0 ? itemMass / recipeMass : 1;

  const now  = new Date().toISOString();
  // Bake the scale factor into portion + nutrition rather than into quantity.
  // The display math works out the same either way (portion × quantity ×
  // nutrition_per_unit), but storing scale-as-quantity (e.g. 454g × 0.13 =
  // 59.245g logged) means the edit sheet shows "Serving Size: 454, # Servings:
  // 0.13049151805132667" — opaque. With scale-as-portion the child carries
  // the scaled gram-equivalent as portion, quantity=1, nutrition pre-scaled.
  // Editing presents clean numbers and behaves like any other diary item.
  //
  // Portion rounded to 1 decimal (min 0.1) for readability — meat / pasta /
  // sauce in typical 50-500g amounts read like whole numbers, while tiny
  // ingredients (saffron 0.7g, vanilla 0.3g) keep their precision. Nutrition
  // is rebalanced from the rounded portion so per-gram density stays
  // accurate.
  const _round1 = v => Math.round(v * 10) / 10;
  const splitItems = recipe.items.map(ing => {
    const food_server_id = ('server_id' in ing)
      ? ing.server_id
      : (typeof ing.id === 'number' ? ing.id : null);
    const origPortion  = parseFloat(ing.portion)  || 100;
    const origQuantity = parseFloat(ing.quantity) || 1;
    const exactScaledMass = origPortion * origQuantity * scale;
    const newPortion = Math.max(0.1, _round1(exactScaledMass));
    // Nutrition was stored per (origPortion × origQuantity) of the
    // ingredient. We want it per newPortion (with quantity=1), so the
    // multiplier is newPortion / (origPortion × origQuantity).
    const nutritionFactor = newPortion / (origPortion * origQuantity);
    let scaledNutrition = ing.nutrition;
    if (ing.nutrition && typeof ing.nutrition === 'object') {
      scaledNutrition = Object.fromEntries(
        Object.entries(ing.nutrition).map(([k, v]) => [k, (parseFloat(v) || 0) * nutritionFactor])
      );
    }
    return {
      ...ing,
      portion: newPortion,
      quantity: 1,
      nutrition: scaledNutrition,
      addedAt: now,
      food_server_id,
    };
  });

  const updated = {
    ...entry,
    items: entry.items.map((it, i) => i === index ? { ...item, _splitItems: splitItems } : it),
  };
  currentEntry.set(await _save(updated));
  return true;
}

/**
 * Remove a single ingredient from a split recipe parent. Updates the
 * parent's `_splitItems` array (and the parent's nutrition recomputes
 * automatically via Nutrition.calculate). If the removal empties the
 * children array, the entire parent is removed from the diary — the user
 * has effectively dropped the whole recipe.
 */
export async function removeSplitChild(parentIndex, childIndex) {
  let entry = null;
  currentEntry.subscribe(v => entry = v)();
  if (!entry || !Array.isArray(entry.items) || parentIndex < 0 || parentIndex >= entry.items.length) return;

  const parent = entry.items[parentIndex];
  if (!Array.isArray(parent._splitItems) || childIndex < 0 || childIndex >= parent._splitItems.length) return;

  const remaining = parent._splitItems.filter((_, i) => i !== childIndex);
  let newItems;
  if (remaining.length === 0) {
    newItems = entry.items.filter((_, i) => i !== parentIndex);
  } else {
    newItems = entry.items.map((it, i) =>
      i === parentIndex ? { ...parent, _splitItems: remaining } : it
    );
  }
  currentEntry.set(await _save({ ...entry, items: newItems }));
}

/**
 * Update one ingredient inside a split recipe parent. Used when the user
 * tweaks a child's quantity / portion — keeps the parent intact, only
 * the child changes.
 */
export async function updateSplitChild(parentIndex, childIndex, changes) {
  let entry = null;
  currentEntry.subscribe(v => entry = v)();
  if (!entry || !Array.isArray(entry.items) || parentIndex < 0 || parentIndex >= entry.items.length) return;

  const parent = entry.items[parentIndex];
  if (!Array.isArray(parent._splitItems) || childIndex < 0 || childIndex >= parent._splitItems.length) return;

  const newChildren = parent._splitItems.map((c, i) =>
    i === childIndex ? { ...c, ...changes } : c
  );
  const newItems = entry.items.map((it, i) =>
    i === parentIndex ? { ...parent, _splitItems: newChildren } : it
  );
  currentEntry.set(await _save({ ...entry, items: newItems }));
}

export async function copyMealItems(fromMealIdx, toMealIdx) {
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  if (!viewDate) return 0;
  let copiedCount = 0;
  await _refetchAndSave(viewDate, (entry) => {
    const src = (entry.items || []).filter(it => Number(it.meal ?? 0) === Number(fromMealIdx));
    if (!src.length) { copiedCount = 0; return null; }
    copiedCount = src.length;
    const now = new Date().toISOString();
    const copies = src.map(it => ({ ...it, meal: Number(toMealIdx), addedAt: now }));
    return { ...entry, items: [...(entry.items || []), ...copies] };
  });
  return copiedCount;
}

export async function moveMealItems(fromMealIdx, toMealIdx) {
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  if (!viewDate) return 0;
  let movedCount = 0;
  await _refetchAndSave(viewDate, (entry) => {
    let count = 0;
    const items = (entry.items || []).map(it => {
      if (Number(it.meal ?? 0) === Number(fromMealIdx)) {
        count++;
        return { ...it, meal: Number(toMealIdx) };
      }
      return it;
    });
    if (!count) { movedCount = 0; return null; }
    movedCount = count;
    return { ...entry, items };
  });
  return movedCount;
}

export async function clearMealItems(mealIdx) {
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  if (!viewDate) return 0;
  let removedCount = 0;
  await _refetchAndSave(viewDate, (entry) => {
    const before = entry.items?.length || 0;
    const items = (entry.items || []).filter(it => Number(it.meal ?? 0) !== Number(mealIdx));
    if (items.length === before) { removedCount = 0; return null; }
    removedCount = before - items.length;
    return { ...entry, items };
  });
  return removedCount;
}

export async function copyMealToDate(fromMealIdx, targetDate, targetMealIdx) {
  // Source mealItems read from the CURRENTLY-VIEWED date's freshest server
  // state, target date gets its own refetch + append. Both sides use
  // _refetchAndSave for consistent stale-cache-race protection (#81).
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  if (!viewDate) return 0;

  const srcEntry = _fromApi(await NtApi.getDiaryDate(viewDate));
  if (!srcEntry) return 0;
  const src = (srcEntry.items || []).filter(it => Number(it.meal ?? 0) === Number(fromMealIdx));
  if (!src.length) return 0;
  const now = new Date().toISOString();
  const copies = src.map(it => ({ ...it, meal: Number(targetMealIdx), addedAt: now }));

  await _refetchAndSave(targetDate, (target) => ({
    ...target,
    items: [...(target.items || []), ...copies],
  }));
  return src.length;
}

export async function addWaterLog(amountMl, date) {
  const todayStr = () => new Date().toLocaleDateString('sv-SE');
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  const targetDate = date || viewDate || todayStr();

  const use24 = DB.getSetting('timeFormat', '12h') === '24h';
  const log = { amount: Math.round(amountMl), time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !use24 }) };

  await _refetchAndSave(targetDate, (entry) => ({
    ...entry,
    water: [...(entry.water || []), log],
  }));
}

export async function saveDiaryNote(notes) {
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  if (!viewDate) return;
  const trimmed = (notes || '').replace(/\s+$/g, '');
  await _refetchAndSave(viewDate, (entry) => {
    if ((entry.notes || '') === trimmed) return null;
    return { ...entry, notes: trimmed };
  });
}

export async function saveBodyStats(stats) {
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  if (!viewDate) return;
  await _refetchAndSave(viewDate, (entry) => ({
    ...entry,
    bodyStats: { ...entry.bodyStats, ...stats },
  }));
}

export function prevDay() {
  let d = null;
  currentDate.subscribe(v => d = v)();
  const dt = new Date(d + 'T12:00:00');
  dt.setDate(dt.getDate() - 1);
  loadEntry(localDateStr(dt));
}

export function nextDay() {
  let d = null;
  currentDate.subscribe(v => d = v)();
  const dt = new Date(d + 'T12:00:00');
  dt.setDate(dt.getDate() + 1);
  loadEntry(localDateStr(dt));
}
