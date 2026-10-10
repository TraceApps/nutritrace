/**
 * migrate.js — Standalone → server data migration.
 *
 * Called from Settings.svelte (Connect to server flow) when a user is
 * transitioning out of standalone mode. If the local SQLite has data from a
 * prior offline session, surface counts so the user picks: upload local →
 * server, replace local with server, or merge (upload then pull on reload).
 *
 * Two improvements over the old inline flow this replaces:
 *   1. Counts are shown UP FRONT in the merge dialog so the user knows what's
 *      about to move (the old flow asked the question with zero context).
 *   2. Upload returns a per-table success/error summary so the user actually
 *      knows whether the migration completed (the old flow .catch(() => {})'d
 *      every push silently — bugs invisible).
 *
 * Server endpoints used (already exist):
 *   POST /api/foods                creates a food
 *   POST /api/meals                creates a meal/recipe (is_recipe flag)
 *   PUT  /api/diary/:date          upserts an entire day's diary entry
 *   PUT  /api/diary/:date/completion, /meal-completion   the day's marks
 *   PUT  /api/settings             upserts a single setting (key, value)
 *   POST /api/sync/push            activities, fasts, Health Connect values
 *                                  and workouts (the Android sync's own path)
 *
 * The answer lists, per table, the rows that went up whole
 * (`uploaded`), so connecting can drop exactly those here (they come back
 * from the server) and keep everything else for the sync to send.
 *
 * Diary upserts on (user_id, date) so re-uploading a date the server already
 * has overwrites cleanly — workouts/body-stats inside the day are part of
 * that single PUT. Foods and meals don't have a natural unique key, so
 * running upload twice produces duplicates (user is warned in the dialog).
 */

import { dbGetFoods, dbGetMeals, dbGetAllDiary, getDb, dbInstallId, createKeyOf } from './db-native.js';
import { DB } from './db.js';
import { isNative, getServerUrl, getAuthToken } from './platform.js';

/**
 * Count local rows that would be uploaded. Returns
 * `{ foods, meals, recipes, diary, settings, total }`.
 *
 * Fast — pulls from local SQLite + the local-storage settings dump. No
 * network. Rejected rows fall back to zero so the dialog still renders.
 */
export async function countLocalData() {
  if (!isNative) return _empty();
  try {
    const [foods, mealsOnly, recipesOnly, diary, other] = await Promise.all([
      dbGetFoods().catch(() => []),
      dbGetMeals(false).catch(() => []),
      dbGetMeals(true).catch(() => []),
      dbGetAllDiary().catch(() => []),
      _countOther().catch(() => 0),
    ]);
    const mealsAll = [...mealsOnly, ...recipesOnly];
    let settings = 0;
    try { settings = Object.keys(DB.getAllSettings() || {}).length; } catch {}
    const meals   = mealsAll.filter(m => !m.is_recipe).length;
    const recipes = mealsAll.filter(m =>  m.is_recipe).length;
    // Activities, fasts and Health Connect data count toward whether to ask
    // at all, so they're never left out of the choice.
    const total = foods.length + meals + recipes + diary.length + settings + other;
    return { foods: foods.length, meals, recipes, diary: diary.length, settings, other, total };
  } catch (err) {
    console.warn('[migrate] countLocalData failed:', err?.message || err);
    return _empty();
  }
}

/**
 * Push every local row to the server. Caller must already have a valid
 * auth token (login completed) and the server URL. Returns
 * `{ success: { foods, meals, recipes, diary, settings }, errors: [...],
 *    total, totalSuccess }`.
 *
 * `onProgress(stage, current, total)` is called between each row so the UI
 * can render a progress bar. `stage` is one of: 'foods', 'meals', 'recipes',
 * 'diary', 'settings'.
 */
export async function uploadLocalToServer({ serverUrl, authToken, onProgress } = {}) {
  if (!isNative)   throw new Error('uploadLocalToServer only runs on Capacitor');
  if (!serverUrl)  throw new Error('Server URL required');
  if (!authToken)  throw new Error('Auth token required');

  const summary = {
    success: { foods: 0, meals: 0, recipes: 0, diary: 0, settings: 0, activity: 0, fasts: 0, wellness: 0, workouts: 0 },
    errors: [],
    total: 0,
    totalSuccess: 0,
    // Local row ids per table that went up whole.
    uploaded: { foods: [], meals: [], diary: [], activity_log: [], fasts: [], wellness_data: [], workouts: [] },
  };
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
  };
  // Every row goes with a stable key (this install, its own id here and
  // when it was made): the server makes it once, so running the upload
  // again, or an answer lost on the way back, never duplicates it. The sync
  // uses the same keys (db-native.js createKeyOf).
  const install = await dbInstallId();
  const key = (table, row) => createKeyOf(install, table, row);

  // ── Settings ────────────────────────────────────────────────────────────────
  try {
    const all = DB.getAllSettings() || {};
    const keys = Object.keys(all);
    for (let i = 0; i < keys.length; i++) {
      onProgress?.('settings', i, keys.length);
      const key = keys[i];
      try {
        await _put(`${serverUrl}/api/settings`, headers, { key, value: all[key] });
        summary.success.settings++;
      } catch (e) {
        summary.errors.push({ stage: 'settings', name: key, message: e.message });
      }
    }
  } catch (e) {
    summary.errors.push({ stage: 'settings', name: '(load)', message: e.message });
  }

  // Local id -> the server's id for what went up, so diary items logged
  // from them point at the server's rows.
  const foodIds = new Map(), mealIds = new Map();

  // ── Foods ───────────────────────────────────────────────────────────────────
  const localFoods = await dbGetFoods().catch(() => []);
  for (let i = 0; i < localFoods.length; i++) {
    onProgress?.('foods', i, localFoods.length);
    const food = localFoods[i];
    try {
      const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at, imgUrl, categories, ...rest } = food;
      const made = await _post(`${serverUrl}/api/foods`, headers, {
        ...rest,
        img_url: imgUrl || null,
        category: categories?.[0] || null,
        client_key: key('foods', food),
      });
      if (made?.id != null) foodIds.set(id, made.id);
      summary.uploaded.foods.push(id);
      summary.success.foods++;
    } catch (e) {
      summary.errors.push({ stage: 'foods', name: food.name || `food #${food.id}`, message: e.message });
    }
  }

  // ── Meals + Recipes ─────────────────────────────────────────────────────────
  // Recipes too: dbGetMeals() alone is meals only.
  const localMeals = [
    ...await dbGetMeals(false).catch(() => []),
    ...await dbGetMeals(true).catch(() => []),
  ];
  for (let i = 0; i < localMeals.length; i++) {
    onProgress?.('meals', i, localMeals.length);
    const meal = localMeals[i];
    const isRecipe = !!meal.is_recipe;
    try {
      const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at, imgUrl, ...rest } = meal;
      const made = await _post(`${serverUrl}/api/meals`, headers, {
        ...rest,
        img_url: imgUrl || null,
        client_key: key('meals', meal),
      });
      if (made?.id != null) mealIds.set(id, made.id);
      summary.uploaded.meals.push(id);
      if (isRecipe) summary.success.recipes++;
      else          summary.success.meals++;
    } catch (e) {
      summary.errors.push({
        stage: isRecipe ? 'recipes' : 'meals',
        name: meal.name || `meal #${meal.id}`,
        message: e.message,
      });
    }
  }

  // ── Diary (one PUT per date: items + body_stats + water + notes, then
  // the day's and each meal's completion marks) ──────────────────────────
  const linkItems = items => (Array.isArray(items) ? items : []).map(it => {
    if (!it || typeof it !== 'object' || typeof it.food_server_id === 'number' || typeof it.id !== 'number') return it;
    const sid = (it.is_recipe ? mealIds : foodIds).get(it.id);
    if (sid == null) return it;
    const { food_device: _d, ...rest } = it;
    const out = { ...rest, food_server_id: sid };
    return Array.isArray(out._splitItems) ? { ...out, _splitItems: linkItems(out._splitItems) } : out;
  });
  const localDiary = (await dbGetAllDiary().catch(() => [])).filter(d => !d.deleted_at);
  for (let i = 0; i < localDiary.length; i++) {
    onProgress?.('diary', i, localDiary.length);
    const entry = localDiary[i];
    const day = `${serverUrl}/api/diary/${encodeURIComponent(entry.date)}`;
    try {
      await _put(day, headers, {
        items:      linkItems(entry.items),
        body_stats: entry.body_stats || {},
        water:      entry.water      || [],
        // An empty note here leaves the server's day as it is.
        ...(entry.notes ? { notes: entry.notes } : {}),
      });
      if (entry.completed_at) await _put(`${day}/completion`, headers, { completed: true });
      for (const slot of _slots(entry.completed_meals)) await _put(`${day}/meal-completion`, headers, { slot, completed: true });
      summary.uploaded.diary.push(entry.id);
      summary.success.diary++;
    } catch (e) {
      summary.errors.push({ stage: 'diary', name: entry.date, message: e.message });
    }
  }

  // ── Activities, fasts, Health Connect values and workouts ─────────────
  const db = await getDb();
  const rows = async sql => ((await db.query(sql, [])).values || []);
  const now = new Date().toISOString();
  const tables = [
    {
      stage: 'activity', table: 'activity_log', key: 'activity',
      read: () => rows(`SELECT * FROM activity_log WHERE user_id = 1 AND deleted_at IS NULL`),
      shape: a => ({ client_id: a.id, server_id: null, client_key: key('activity_log', a), date: a.date, name: a.name, kcal: a.kcal, duration_min: a.duration_min,
        distance: a.distance, source: a.source || 'manual_form', met: a.met ?? null, is_template: a.is_template ? 1 : 0,
        updated_at: a.updated_at || now, deleted_at: null }),
    },
    {
      stage: 'fasts', table: 'fasts', key: 'fasts',
      read: () => rows(`SELECT * FROM fasts WHERE user_id = 1 AND deleted_at IS NULL`),
      shape: f => ({ client_id: f.id, server_id: null, client_key: key('fasts', f), start_at: f.start_at, end_at: f.end_at || null,
        goal_hours: f.goal_hours, notes: f.notes || null, updated_at: f.updated_at || now, deleted_at: null }),
    },
    {
      stage: 'wellness', table: 'wellness_data', key: 'wellness',
      read: () => rows(`SELECT * FROM wellness_data WHERE user_id = 1`),
      shape: w => ({ date: w.date, source: w.source, metric_type: w.metric_type, value: w.value,
        metadata: typeof w.metadata === 'string' ? w.metadata : JSON.stringify(w.metadata || {}) }),
    },
    {
      stage: 'workouts', table: 'workouts', key: 'workouts',
      read: () => rows(`SELECT * FROM workouts WHERE user_id = 1`),
      shape: w => ({ client_id: w.id, source: w.source, source_id: String(w.source_id), date: w.date,
        activity_type: w.activity_type || null, activity_name: w.activity_name || null, start_time: w.start_time || null,
        duration_ms: w.duration_ms ?? null, distance_km: w.distance_km ?? null, calories: w.calories ?? null,
        avg_hr: w.avg_hr ?? null, max_hr: w.max_hr ?? null, steps: w.steps ?? null, has_gps: w.has_gps ? 1 : 0 }),
    },
  ];
  for (const t of tables) {
    const list = await t.read().catch(() => []);
    for (let i = 0; i < list.length; i += 200) {
      const part = list.slice(i, i + 200);
      onProgress?.(t.stage, i, list.length);
      try {
        await _post(`${serverUrl}/api/sync/push`, headers, { [t.key]: part.map(t.shape), client_now: new Date().toISOString() });
        for (const r of part) summary.uploaded[t.table].push(r.id);
        summary.success[t.stage] += part.length;
      } catch (e) {
        summary.errors.push({ stage: t.stage, name: `${part.length} rows`, message: e.message });
      }
    }
  }

  for (const k of Object.keys(summary.success)) {
    summary.totalSuccess += summary.success[k];
    summary.total        += summary.success[k];
  }
  summary.total += summary.errors.length;
  return summary;
}

async function _countOther() {
  const db = await getDb();
  let n = 0;
  for (const sql of [
    `SELECT COUNT(*) AS n FROM activity_log WHERE user_id = 1 AND deleted_at IS NULL`,
    `SELECT COUNT(*) AS n FROM fasts WHERE user_id = 1 AND deleted_at IS NULL`,
    `SELECT COUNT(*) AS n FROM wellness_data WHERE user_id = 1`,
    `SELECT COUNT(*) AS n FROM workouts WHERE user_id = 1`,
  ]) n += Number((await db.query(sql, [])).values?.[0]?.n || 0);
  return n;
}

function _slots(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
  return Array.isArray(v) ? v.filter(n => Number.isInteger(n) && n >= 0 && n <= 31) : [];
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function _empty() {
  return { foods: 0, meals: 0, recipes: 0, diary: 0, settings: 0, other: 0, total: 0 };
}

async function _post(url, headers, body) {
  return _request('POST', url, headers, body);
}
async function _put(url, headers, body) {
  return _request('PUT', url, headers, body);
}
async function _request(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let msg = `${method} ${url} → ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  try { return await res.json(); } catch { return null; }
}
