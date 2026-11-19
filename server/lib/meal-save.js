/**
 * Saving a meal or recipe row: the code behind POST and PUT /api/meals,
 * shared with the MCP tools (create_meal, update_meal) so a meal made or
 * changed there is saved exactly as one from the app: retries by
 * client_key, the CookTrace re-import upsert, default visibility, the
 * changed_fields merge and the revive rules for a row deleted elsewhere.
 *
 * Images are localized by the caller (the route): what comes in here is
 * the URL to store.
 */
import db from '../db.js';
import { onlyChanged, deletedSave } from './rest-merge.js';
import { resolveNewItemVisibility } from './default-visibility.js';
import { cleanCreateKey, findByCreateKey, setCreateKey } from './create-keys.js';
import { categoriesFromSave } from './categories.js';

const _has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/**
 * Save a new meal or recipe for user `u` (null in single-user mode) from a
 * POST body. `img` is the image URL to store. Returns `{ status, row }`:
 * 201 for a new row, 200 for the row a retry or a re-import lands on.
 */
export function createMeal(u, body, img) {
  const { name, nutrition, items, notes, is_recipe, portion, unit, servings, visibility, source_id,
          source_app, source_external_id, source_url, import_warnings } = body;
  // Sent again (a retry, or the answer was lost): the meal made the first time.
  const createKey = cleanCreateKey(body.client_key);
  const made = findByCreateKey('meals', u, createKey);
  if (made) return { status: 200, row: made };
  // #183: honor the caller's defaultShareVisibility when the client
  // omits an explicit value. Same rule applies to recipes (is_recipe=1).
  const vis = visibility || resolveNewItemVisibility(u);
  const cleanSourceApp = source_app ? String(source_app).slice(0, 40) : null;
  const cleanSourceExtId = source_external_id ? String(source_external_id).slice(0, 128) : null;
  const cleanSourceUrl = source_url ? String(source_url).slice(0, 2048) : null;
  const warningsCol = Array.isArray(import_warnings) && import_warnings.length
    ? JSON.stringify(import_warnings.map(w => String(w || '').slice(0, 400)).filter(Boolean).slice(0, 20))
    : null;

  // Upsert on re-import: a save with the same (user, source_app, source_external_id)
  // as an existing row updates that row in place. This is how the CookTrace pull
  // flow keeps a re-imported recipe on the same NT meal id rather than tripping
  // the partial unique index on meals(user_id, source_app, source_external_id).
  if (cleanSourceApp && cleanSourceExtId) {
    const existing = u == null
      ? db.prepare(`SELECT id FROM meals WHERE user_id IS NULL AND source_app = ? AND source_external_id = ? AND deleted_at IS NULL`).get(cleanSourceApp, cleanSourceExtId)
      : db.prepare(`SELECT id FROM meals WHERE user_id = ? AND source_app = ? AND source_external_id = ? AND deleted_at IS NULL`).get(u, cleanSourceApp, cleanSourceExtId);
    if (existing) {
      db.prepare(
        `UPDATE meals SET name=?, nutrition=?, items=?, img_url=?, notes=?, is_recipe=?, portion=?, unit=?, servings=?, visibility=?,
                          source_url=?, import_warnings=?, updated_at=datetime('now') WHERE id=?`
      ).run(name, JSON.stringify(nutrition || {}), JSON.stringify(items || []),
        img, notes || null, is_recipe ? 1 : 0, portion ?? 100, unit || 'g',
        servings != null ? Math.max(1, parseInt(servings) || 1) : null,
        vis, cleanSourceUrl, warningsCol, existing.id);
      return { status: 200, row: db.prepare('SELECT * FROM meals WHERE id = ?').get(existing.id) };
    }
  }

  // A deleted meal from the same source still holds its place in the unique
  // (source_app, source_external_id) index: it lets go, so the new one can
  // be made (a CookTrace recipe deleted and pulled again), as a deleted food
  // does (routes/foods.js).
  if (cleanSourceApp && cleanSourceExtId) {
    db.prepare(`UPDATE meals SET source_app = NULL, source_external_id = NULL WHERE user_id IS ? AND source_app = ? AND source_external_id = ? AND deleted_at IS NOT NULL`)
      .run(u ?? null, cleanSourceApp, cleanSourceExtId);
  }
  const result = db.prepare(
    `INSERT INTO meals (user_id, name, nutrition, items, img_url, notes, categories, is_recipe, portion, unit, servings, visibility, source_id,
                        source_app, source_external_id, source_url, import_warnings, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(u, name, JSON.stringify(nutrition || {}), JSON.stringify(items || []),
    img, notes || null, categoriesFromSave(body, null)?.categories ?? null, is_recipe ? 1 : 0, portion ?? 100, unit || 'g',
    servings != null ? Math.max(1, parseInt(servings) || 1) : null,
    vis, source_id || null,
    cleanSourceApp, cleanSourceExtId, cleanSourceUrl, warningsCol);
  setCreateKey('meals', result.lastInsertRowid, createKey);
  return { status: 201, row: db.prepare('SELECT * FROM meals WHERE id = ?').get(result.lastInsertRowid) };
}

/**
 * Save a change to the meal row `existing` from a PUT body. `img` is the
 * image URL to store. Returns the saved row, or null when the row was
 * deleted elsewhere and this save doesn't bring it back (the route answers
 * that 410).
 */
export function updateMeal(existing, body, img) {
  const { name, nutrition, items, notes, is_recipe, portion, unit, servings, visibility, favorite } = body;
  const fav = favorite != null ? (favorite ? 1 : 0) : existing.favorite;
  // Body explicitly set servings → take it (null clears, number clamps to >=1).
  // Body omitted servings entirely → preserve the existing row value (null stays null).
  const srv = 'servings' in body
    ? (servings != null ? Math.max(1, parseInt(servings) || 1) : null)
    : existing.servings;
  // Only the fields a save says it changed, when it says (lib/rest-merge.js).
  const next = onlyChanged('meals', existing, {
    name: name ?? existing.name, nutrition: JSON.stringify(nutrition ?? JSON.parse(existing.nutrition || '{}')),
    items: JSON.stringify(items ?? JSON.parse(existing.items || '[]')), img_url: img,
    notes: notes ?? existing.notes,
    // Kept since #332; a save that doesn't send them leaves them.
    categories: _has(body, 'categories') ? categoriesFromSave({ categories: body.categories }, existing).categories : existing.categories,
    is_recipe: is_recipe != null ? (is_recipe ? 1 : 0) : existing.is_recipe,
    portion: portion ?? existing.portion, unit: unit ?? existing.unit, servings: srv, favorite: fav,
  }, body.changed_fields);
  const vis = visibility ?? existing.visibility;
  // Deleted elsewhere: a save that changes something, made after the delete,
  // brings the meal or recipe back; any other is refused as gone
  // (lib/rest-merge.js).
  if (existing.deleted_at && !deletedSave('meals', existing, next)) return null;
  db.prepare(
    `UPDATE meals SET name=?, nutrition=?, items=?, img_url=?, notes=?, categories=?, is_recipe=?, portion=?, unit=?, servings=?, visibility=?, favorite=?, updated_at=datetime('now')${existing.deleted_at ? ', deleted_at=NULL' : ''} WHERE id=?`
  ).run(next.name, next.nutrition, next.items, next.img_url, next.notes, next.categories, next.is_recipe,
    next.portion, next.unit, next.servings,
    vis, next.favorite, existing.id);
  return db.prepare('SELECT * FROM meals WHERE id = ?').get(existing.id);
}

/**
 * Soft-delete a meal or recipe: deleted_at set and updated_at bumped, so
 * phones pull the delete on their next sync. Diary entries logged from it
 * keep their own copy.
 */
export function deleteMeal(id) {
  db.prepare(`UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
}
