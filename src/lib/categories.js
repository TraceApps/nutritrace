/**
 * A food, meal or recipe's categories (#332): several can be picked, kept as
 * a list. Foods also keep `category`, the first, for older apps, the public
 * API, MCP and exports. Shared by the app (every mode) and the server
 * (server/lib/categories.js), so both read and clean them the same way.
 */
const MAX = 20;
const MAX_LEN = 200;

/** A clean list: strings, trimmed, no empties or repeats, at most 20. */
export function cleanCategories(v) {
  const list = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  const out = [];
  for (const c of list) {
    const s = String(c ?? '').trim().slice(0, MAX_LEN);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX) break;
  }
  return out;
}

/** The categories a row has: its list (an array or JSON text), or else its
 *  single category (a row from before #332, or from an older app). */
export function storedCategories(row) {
  if (!row) return [];
  if (Array.isArray(row.categories)) return cleanCategories(row.categories);
  if (typeof row.categories === 'string' && row.categories) {
    try { const a = JSON.parse(row.categories); if (Array.isArray(a)) return cleanCategories(a); } catch { /* fall through */ }
  }
  return cleanCategories(row.category);
}

/** What a food sends or stores from the app's form: the list, and the
 *  first of it as `category`. */
export function foodCategoryFields(food) {
  const list = cleanCategories(Array.isArray(food?.categories) ? food.categories : food?.category);
  return { categories: list, category: list[0] ?? null };
}
