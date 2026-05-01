/**
 * diary-helpers.js — shared transformations for diary item arrays.
 *
 * Used by both `routes/diary.js` (single-date + list endpoints) and
 * `routes/sync.js` (native pull endpoint) so the same freshening logic
 * runs everywhere diary items are returned to clients.
 */
import db from '../db.js';

/**
 * Fill missing/empty imgUrl values from current foods table state.
 *
 * Diary items snapshot all fields at log time including imgUrl. If a food was
 * logged before it had an image (and the image got added later), the snapshot
 * stays at '' forever. Cosmetic fields like images warrant live-lookup at
 * render time (unlike name/macros, where snapshot semantics protect history).
 *
 * Looks up the food id captured in each diary item's `id` field and overrides
 * empty imgUrl with the food's current image. Items that already carry their
 * own non-empty imgUrl are left untouched. Single batch query, scales fine
 * for typical diary days. Wrapped in try/catch so a query error never breaks
 * the calling endpoint — falls through to returning items unchanged.
 */
export function freshenItemImages(items) {
  if (!Array.isArray(items) || !items.length) return items;
  try {
    const ids = [];
    for (const it of items) {
      if (!it.imgUrl && typeof it.id === 'number') ids.push(it.id);
    }
    if (!ids.length) return items;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, name, img_url FROM foods WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).all(...ids);
    if (!rows.length) return items;
    const foodById = new Map();
    for (const r of rows) foodById.set(r.id, r);
    if (!foodById.size) return items;
    // Defensive name-match guard: a diary item's `id` is the food id captured
    // at log time (or copied from a saved meal/recipe). If the foods table got
    // rebuilt at some point — disaster recovery, restore from another deploy,
    // user manually re-imported their catalogue — the auto-increment counter
    // can reassign the same id to a totally unrelated food, which would make
    // this helper silently swap thumbnails to wrong items. Only freshen when
    // the looked-up food's name still matches the item's name.
    const norm = s => String(s || '').trim().toLowerCase();
    return items.map(it => {
      if (!it.imgUrl && typeof it.id === 'number') {
        const food = foodById.get(it.id);
        if (food && food.img_url && norm(food.name) === norm(it.name)) {
          return { ...it, imgUrl: food.img_url };
        }
      }
      return it;
    });
  } catch {
    return items;
  }
}
