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
      `SELECT id, img_url FROM foods WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).all(...ids);
    if (!rows.length) return items;
    const imgMap = new Map();
    for (const r of rows) {
      if (r.img_url) imgMap.set(r.id, r.img_url);
    }
    if (!imgMap.size) return items;
    return items.map(it => {
      if (!it.imgUrl && typeof it.id === 'number' && imgMap.has(it.id)) {
        return { ...it, imgUrl: imgMap.get(it.id) };
      }
      return it;
    });
  } catch {
    return items;
  }
}
