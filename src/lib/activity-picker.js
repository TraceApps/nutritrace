// Activity compendium helpers — search + category grouping + MET-based
// kcal auto-calc. Issue #77.
//
// The compendium ships as a small JSON file (`activity-compendium.json`),
// a curated ~130-entry subset of the 2024 Adult Compendium (Ainsworth
// et al.). Freeform activity names still work when no compendium entry
// matches; the picker is purely additive to the existing manual form.

import compendium from './activity-compendium.json';

/** All compendium activities as a flat array of { id, category, name, met }. */
export const ACTIVITIES = compendium.activities;

/** Compendium categories in the order they should appear in the picker.
 *  Ordering prioritizes the exercise-shaped categories over daily-life
 *  ones (Home / Occupation) so a user looking for "workout" sees those
 *  first. */
export const CATEGORY_ORDER = [
  'Running',
  'Bicycling',
  'Walking',
  'Water',
  'Winter',
  'Sports',
  'Conditioning',
  'Dancing',
  'Home',
  'Occupation',
];

/** Icon per category — Material Symbols names. Used by the browse sheet
 *  and the row-level source pill on picked entries. */
export const CATEGORY_ICONS = {
  Running:      'directions_run',
  Bicycling:    'directions_bike',
  Walking:      'directions_walk',
  Water:        'pool',
  Winter:       'ac_unit',
  Sports:       'sports_soccer',
  Conditioning: 'fitness_center',
  Dancing:      'nightlife',
  Home:         'home',
  Occupation:   'work',
};

/** Group all compendium entries by category, in CATEGORY_ORDER.
 *  Returns [{ category, icon, items: [...] }, ...]. */
export function groupedByCategory() {
  const bucket = new Map();
  for (const a of ACTIVITIES) {
    if (!bucket.has(a.category)) bucket.set(a.category, []);
    bucket.get(a.category).push(a);
  }
  return CATEGORY_ORDER
    .filter(c => bucket.has(c))
    .map(category => ({
      category,
      icon: CATEGORY_ICONS[category] || 'directions_run',
      items: bucket.get(category),
    }));
}

/** Fuzzy-search compendium by activity name (and category as a fallback).
 *  Case-insensitive substring match, ranked by (name-startsWith → name-contains
 *  → category-contains). Caller can slice(0, N) for typeahead brevity. */
export function search(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const startsWith = [];
  const nameHit = [];
  const catHit = [];
  for (const a of ACTIVITIES) {
    const name = a.name.toLowerCase();
    const cat = a.category.toLowerCase();
    if (name.startsWith(q)) startsWith.push(a);
    else if (name.includes(q)) nameHit.push(a);
    else if (cat.includes(q)) catHit.push(a);
  }
  return [...startsWith, ...nameHit, ...catHit];
}

/** Deterministic kcal from MET × body weight × duration (per hour).
 *  Returns null when any input is missing/invalid so callers can gracefully
 *  fall back to manual entry. */
export function metKcal({ met, weightKg, durationMin }) {
  const m = Number(met);
  const w = Number(weightKg);
  const d = Number(durationMin);
  if (!Number.isFinite(m) || m <= 0) return null;
  if (!Number.isFinite(w) || w <= 0) return null;
  if (!Number.isFinite(d) || d <= 0) return null;
  return Math.round(m * w * (d / 60));
}

/** Look up a single compendium entry by id. Returns null if not found. */
export function findById(id) {
  if (!id) return null;
  return ACTIVITIES.find(a => a.id === id) || null;
}
