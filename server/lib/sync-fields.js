/**
 * The fields of each synced table, as two edits of a row meet them
 * (lib/field-sync.js): the newer edit of each field stays. The server keeps
 * when each last changed (field_times, db.js); the Android app keeps the
 * copy the server has of each row and says which of these it changed
 * (src/lib/db-native.js, src/lib/sync.js), and so does the browser for an
 * edit it saves (src/lib/offline-api.js). Columns written their own way
 * aren't here: how often and when a food was last used (the larger count
 * stays), where it came from (kept unless an edit says), who it's shared
 * with (Share sets it). A diary day merges its items and water one by one
 * (lib/diary-merge.js), its note by its own time, and its measurements
 * each on their own (DIARY_STAT_PREFIX).
 */
export const SYNC_FIELDS = {
  foods: [
    'name', 'brand', 'nutrition', 'portion', 'unit', 'img_url', 'notes', 'category', 'barcode',
    'favorite', 'nutrition_basis', 'alt_units', 'density_g_ml',
  ],
  meals: ['name', 'nutrition', 'items', 'img_url', 'notes', 'is_recipe', 'portion', 'unit', 'servings', 'favorite'],
  activity_log: ['date', 'name', 'kcal', 'duration_min', 'distance', 'source', 'met', 'is_template'],
  fasts: ['start_at', 'end_at', 'goal_hours', 'notes'],
};

/**
 * Fields that mean something only together, merged as one: the edit that
 * stays brings the whole group.
 */
export const SYNC_GROUPS = {
  foods: [
    // A food's nutrients are for its serving (portion and unit), as the
    // label gives them (per serving or per 100 g).
    ['nutrition', 'portion', 'unit', 'nutrition_basis'],
    // Other units it can be weighed in, and its density for cups and spoons.
    ['alt_units', 'density_g_ml'],
  ],
  meals: [
    // A meal's nutrients are its ingredients' for its servings and size.
    ['items', 'nutrition', 'portion', 'unit', 'servings'],
  ],
  activity_log: [
    // The calories come from the activity (its MET) and how long it lasted.
    ['name', 'met', 'kcal', 'duration_min'],
  ],
};

/** Fields that hold JSON: compared by what they hold, as text or parsed. */
export const SYNC_JSON = {
  foods: ['nutrition', 'alt_units'],
  meals: ['nutrition', 'items'],
};

/** A diary day's measurements, each a field of its own in field_times. */
export const DIARY_STAT_PREFIX = 'body_stats.';
