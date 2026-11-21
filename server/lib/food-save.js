/**
 * Saving a change to a food row, and deleting one: the code behind PUT and
 * DELETE /api/foods/:id, shared with the MCP tools (update_food,
 * delete_food) so a change made there is saved exactly as one from the
 * app: the changed_fields merge, the revive rules for a row deleted
 * elsewhere, and soft deletes that phones sync.
 *
 * Images are localized by the caller (the route): what comes in here is
 * the URL to store.
 */
import db from '../db.js';
import { onlyChanged, deletedSave } from './rest-merge.js';
import { categoriesFromSave } from './categories.js';

// Issues #69 + #70: normalize alt_units for storage. Same shape as the sync
// route helper.
export function serializeAltUnitsForFood(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return null;
  const clean = v
    .filter(r => r && typeof r === 'object')
    .map(r => ({ abbr: String(r.abbr || '').trim(), grams: Number(r.grams) }))
    .filter(r => r.abbr && Number.isFinite(r.grams) && r.grams > 0);
  return clean.length ? JSON.stringify(clean) : null;
}
export function normalizeDensity(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Save a change to the food row `existing` from a PUT body. `img` is the
 * image URL to store. Returns the saved row, or null when the row was
 * deleted elsewhere and this save doesn't bring it back (the route answers
 * that 410).
 */
export function updateFood(existing, body, img) {
  const { name, brand, nutrition, portion, unit, notes, barcode, visibility, favorite,
    nutrition_basis, alt_units, density_g_ml } = body;
  const fav = favorite != null ? (favorite ? 1 : 0) : existing.favorite;
  // For the OFF metadata: undefined → keep existing, null → explicit clear,
  // any other value → normalize-and-store. Lets the client patch one field
  // without resetting the others.
  const nb = nutrition_basis === undefined ? existing.nutrition_basis : (nutrition_basis || null);
  const au = alt_units === undefined ? existing.alt_units : serializeAltUnitsForFood(alt_units);
  const dg = density_g_ml === undefined ? existing.density_g_ml : normalizeDensity(density_g_ml);
  // A save that says which fields it changed (changed_fields) changes only
  // those: a form opened before an edit made elsewhere doesn't put that
  // edit's fields back (lib/rest-merge.js).
  // Categories: a list from this app, the first alone from an older one or
  // the API; taking them all away clears them (lib/categories.js, #332).
  const cats = categoriesFromSave(body, existing) ?? { category: existing.category, categories: existing.categories };
  const next = onlyChanged('foods', existing, {
    name: name ?? existing.name, brand: brand ?? existing.brand,
    nutrition: JSON.stringify(nutrition ?? JSON.parse(existing.nutrition || '{}')),
    portion: portion ?? existing.portion, unit: unit ?? existing.unit, img_url: img,
    notes: notes ?? existing.notes, category: cats.category, categories: cats.categories, barcode: barcode ?? existing.barcode,
    favorite: fav, nutrition_basis: nb, alt_units: au, density_g_ml: dg,
  }, body.changed_fields);
  const vis = visibility ?? existing.visibility;
  // Deleted elsewhere: a save that changes something, made after the delete,
  // brings the food back; any other is refused as gone (lib/rest-merge.js).
  if (existing.deleted_at && !deletedSave('foods', existing, next)) return null;
  db.prepare(
    `UPDATE foods SET name=?, brand=?, nutrition=?, portion=?, unit=?, img_url=?, notes=?, category=?, categories=?, barcode=?, visibility=?, favorite=?, nutrition_basis=?, alt_units=?, density_g_ml=?, updated_at=datetime('now')${existing.deleted_at ? ', deleted_at=NULL' : ''} WHERE id=?`
  ).run(next.name, next.brand, next.nutrition, next.portion, next.unit, next.img_url,
    next.notes, next.category, next.categories, next.barcode,
    vis, next.favorite, next.nutrition_basis, next.alt_units, next.density_g_ml, existing.id);
  return db.prepare('SELECT * FROM foods WHERE id = ?').get(existing.id);
}

/**
 * Soft-delete a food: deleted_at set and updated_at bumped, so phones pull
 * the delete on their next sync. Diary entries keep their own copy.
 */
export function deleteFood(id) {
  db.prepare(`UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
}
