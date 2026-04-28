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
 *   PUT  /api/settings             upserts a single setting (key, value)
 *
 * Diary upserts on (user_id, date) so re-uploading a date the server already
 * has overwrites cleanly — workouts/body-stats inside the day are part of
 * that single PUT. Foods and meals don't have a natural unique key, so
 * running upload twice produces duplicates (user is warned in the dialog).
 */

import { dbGetFoods, dbGetMeals, dbGetAllDiary } from './db-native.js';
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
    const [foods, mealsAll, diary] = await Promise.all([
      dbGetFoods().catch(() => []),
      dbGetMeals().catch(() => []),
      dbGetAllDiary().catch(() => []),
    ]);
    let settings = 0;
    try { settings = Object.keys(DB.getAllSettings() || {}).length; } catch {}
    const meals   = mealsAll.filter(m => !m.is_recipe).length;
    const recipes = mealsAll.filter(m =>  m.is_recipe).length;
    const total = foods.length + meals + recipes + diary.length + settings;
    return { foods: foods.length, meals, recipes, diary: diary.length, settings, total };
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
    success: { foods: 0, meals: 0, recipes: 0, diary: 0, settings: 0 },
    errors: [],
    total: 0,
    totalSuccess: 0,
  };
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
  };

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

  // ── Foods ───────────────────────────────────────────────────────────────────
  const localFoods = await dbGetFoods().catch(() => []);
  for (let i = 0; i < localFoods.length; i++) {
    onProgress?.('foods', i, localFoods.length);
    const food = localFoods[i];
    try {
      const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at, imgUrl, categories, ...rest } = food;
      await _post(`${serverUrl}/api/foods`, headers, {
        ...rest,
        img_url: imgUrl || null,
        category: categories?.[0] || null,
      });
      summary.success.foods++;
    } catch (e) {
      summary.errors.push({ stage: 'foods', name: food.name || `food #${food.id}`, message: e.message });
    }
  }

  // ── Meals + Recipes ─────────────────────────────────────────────────────────
  const localMeals = await dbGetMeals().catch(() => []);
  for (let i = 0; i < localMeals.length; i++) {
    onProgress?.('meals', i, localMeals.length);
    const meal = localMeals[i];
    const isRecipe = !!meal.is_recipe;
    try {
      const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at, imgUrl, ...rest } = meal;
      await _post(`${serverUrl}/api/meals`, headers, {
        ...rest,
        img_url: imgUrl || null,
      });
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

  // ── Diary (one PUT per date — items + body_stats + water + notes) ────────
  const localDiary = await dbGetAllDiary().catch(() => []);
  for (let i = 0; i < localDiary.length; i++) {
    onProgress?.('diary', i, localDiary.length);
    const entry = localDiary[i];
    try {
      await _put(`${serverUrl}/api/diary/${encodeURIComponent(entry.date)}`, headers, {
        items:      entry.items      || [],
        body_stats: entry.body_stats || {},
        water:      entry.water      || [],
        notes:      entry.notes      || '',
      });
      summary.success.diary++;
    } catch (e) {
      summary.errors.push({ stage: 'diary', name: entry.date, message: e.message });
    }
  }

  for (const k of Object.keys(summary.success)) {
    summary.totalSuccess += summary.success[k];
    summary.total        += summary.success[k];
  }
  summary.total += summary.errors.length;
  return summary;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function _empty() {
  return { foods: 0, meals: 0, recipes: 0, diary: 0, settings: 0, total: 0 };
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
