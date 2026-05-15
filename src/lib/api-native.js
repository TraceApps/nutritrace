/**
 * api-native.js — NtApi implementation for the Capacitor native app.
 *
 * Provides the same interface as NtApi in api.js but reads/writes to the
 * local SQLite database instead of making HTTP calls to the server.
 *
 * Used automatically when running in Capacitor standalone mode (no server URL set).
 * When a server URL is configured, the standard HTTP NtApi is used instead.
 */

import {
  dbGetFoods, dbGetFood, dbCreateFood, dbUpdateFood, dbDeleteFood, dbCopyFood, dbBumpFoodUsage,
  dbGetMeals, dbGetMeal, dbCreateMeal, dbUpdateMeal, dbDeleteMeal, dbCopyMeal, dbBumpMealUsage,
  dbGetDiaryDate, dbSaveDiaryDate, dbGetAllDiary,
  dbGetActivity, dbGetActivityRange, dbSumActivity, dbWearableActiveCalories,
  dbCreateActivity, dbUpdateActivity, dbDeleteActivity,
  LOCAL_USER_ID,
} from './db-native.js';
import { Filesystem, Directory } from '@capacitor/filesystem';

// ── Field mapping helpers (mirror server-side NtApi in api.js) ─────────────

import { resolveAssetUrl } from './platform.js';

function _foodFromDb(row) {
  if (!row) return null;
  const { img_url, category, sync_status, ...rest } = row;
  return { ...rest, imgUrl: resolveAssetUrl(img_url) || '', categories: category ? [category] : [] };
}

function _foodToDb(food) {
  const { imgUrl, img_url, categories, category, ...rest } = food;
  return {
    ...rest,
    img_url: imgUrl || img_url || null,
    category: (categories && categories[0]) || category || null,
  };
}

function _mealFromDb(row) {
  if (!row) return null;
  const { img_url, sync_status, ...rest } = row;
  return { ...rest, imgUrl: resolveAssetUrl(img_url) || '' };
}

function _mealToDb(meal) {
  const { imgUrl, img_url, ...rest } = meal;
  return { ...rest, img_url: imgUrl || img_url || null };
}

// ── NtApi native implementation ────────────────────────────────────────────

export const NtApiNative = {

  // ── Foods ─────────────────────────────────────────────────────────────

  async getFoods() {
    const rows = await dbGetFoods();
    return rows.map(_foodFromDb);
  },

  // In standalone mode, "group foods" = same as own foods (no multi-user)
  async getGroupFoods() {
    return this.getFoods();
  },

  async getFood(id) {
    const row = await dbGetFood(id);
    return _foodFromDb(row);
  },

  async createFood(data) {
    const row = await dbCreateFood(_foodToDb(data));
    return _foodFromDb(row);
  },

  async updateFood(id, data) {
    const row = await dbUpdateFood(id, _foodToDb(data));
    return _foodFromDb(row);
  },

  async deleteFood(id) {
    await dbDeleteFood(id);
    return { ok: true };
  },

  // Sharing is not available in standalone mode — no-op
  async shareFood(_id, _visibility, _userIds) {
    return { ok: true };
  },

  async copyFood(id) {
    const row = await dbCopyFood(id);
    return _foodFromDb(row);
  },

  // Bump usage_count + last_used_at when this food is logged to a diary
  // entry. Drives the "Most Used" / "Recently Used" sort modes.
  async markFoodUsed(id, date) {
    await dbBumpFoodUsage(id, date);
    return { ok: true };
  },

  // ── Meals & Recipes ───────────────────────────────────────────────────

  async getMeals() {
    const rows = await dbGetMeals(false);
    return rows.map(_mealFromDb);
  },

  async getGroupMeals() {
    return this.getMeals();
  },

  async getRecipes() {
    const rows = await dbGetMeals(true);
    return rows.map(_mealFromDb);
  },

  async getGroupRecipes() {
    return this.getRecipes();
  },

  async getMeal(id) {
    const row = await dbGetMeal(id);
    return _mealFromDb(row);
  },

  async createMeal(data) {
    const row = await dbCreateMeal(_mealToDb(data));
    return _mealFromDb(row);
  },

  async updateMeal(id, data) {
    const row = await dbUpdateMeal(id, _mealToDb(data));
    return _mealFromDb(row);
  },

  async deleteMeal(id) {
    await dbDeleteMeal(id);
    return { ok: true };
  },

  async shareMeal(_id, _visibility, _userIds) {
    return { ok: true };
  },

  async copyMeal(id) {
    const row = await dbCopyMeal(id);
    return _mealFromDb(row);
  },

  async markMealUsed(id, date) {
    await dbBumpMealUsage(id, date);
    return { ok: true };
  },

  // ── Diary ─────────────────────────────────────────────────────────────

  async getDiaryDate(date) {
    const row = await dbGetDiaryDate(date);
    if (!row) return { date, items: [], body_stats: {}, water: [] };
    return row;
  },

  async saveDiaryDate(date, data) {
    return dbSaveDiaryDate(date, data);
  },

  async getAllDiary() {
    return dbGetAllDiary();
  },

  // ── Activity (manual exercise calorie offset) ─────────────────────────

  async getActivity(date) { return await dbGetActivity(date); },
  async getActivitySum(date, policy = 'wearable_wins') {
    // In standalone mode, Health Connect is the only wearable source — its
    // active_calories rows live in the local wellness_data table.
    const [manual, wearable] = await Promise.all([
      dbSumActivity(date),
      dbWearableActiveCalories(date),
    ]);
    let effective;
    if (!wearable) effective = manual;
    else if (!manual) effective = wearable;
    else if (policy === 'manual_wins') effective = manual;
    else if (policy === 'additive')    effective = wearable + manual;
    else                                effective = wearable; // wearable_wins
    return { manual, wearable, effective, policy };
  },
  async getActivityRange(from, to) { return await dbGetActivityRange(from, to); },
  async createActivity(data)       { return await dbCreateActivity(data); },
  async updateActivity(id, data)   { return await dbUpdateActivity(id, data); },
  async deleteActivity(id)         { return await dbDeleteActivity(id); },

  // ── Users (stub — standalone is single-user) ──────────────────────────

  async getUsersList() {
    return [];
  },

  // ── App config (return safe defaults for standalone) ──────────────────

  async getAppConfig() {
    return {
      food_sharing_enabled: false,
      session_hours: 0,
      registration_open: false,
    };
  },

  async getSharingStatus() {
    return { enabled: false };
  },

  // ── Image upload — save to app's local filesystem ────────────────────

  async uploadImage(file) {
    try {
      const base64 = await _fileToBase64(file);
      const fileName = `img_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
      await Filesystem.writeFile({
        path: `uploads/${fileName}`,
        data: base64,
        directory: Directory.Data,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({
        path: `uploads/${fileName}`,
        directory: Directory.Data,
      });
      return uri; // native file URI (file:///...)
    } catch (e) {
      console.error('[NtApiNative] uploadImage failed:', e);
      throw new Error('Image upload failed');
    }
  },

  // ── Pass-through stubs for server-only routes ────────────────────────
  async get(path) {
    if (path.startsWith('/api/fasts')) return _fastsLocalGet(path);
    if (path === '/api/goals/adaptive-tdee') {
      const { computeAdaptiveTdeeLocal } = await import('./adaptive-tdee-local.js');
      return await computeAdaptiveTdeeLocal();
    }
    if (path.startsWith('/api/wellness/calories-out')) return _caloriesOutLocal(path);
    console.warn(`[NtApiNative] GET ${path} — not available in local mode`);
    return {};
  },
  async post(path, body) {
    if (path.startsWith('/api/fasts')) return _fastsLocalPost(path, body);
    console.warn(`[NtApiNative] POST ${path} — not available in local mode`);
    return {};
  },
  async put(path)  { console.warn(`[NtApiNative] PUT ${path} — not available in local mode`); return {}; },
  async patch(path, body) {
    if (path.startsWith('/api/fasts')) return _fastsLocalPatch(path, body);
    console.warn(`[NtApiNative] PATCH ${path} — not available in local mode`);
    return {};
  },
  async del(path)  {
    if (path.startsWith('/api/fasts')) return _fastsLocalDelete(path);
    // Handle clear all data locally
    if (path === '/api/data') {
      const { getDb } = await import('./db-native.js');
      const db = await getDb();
      await db.run('DELETE FROM foods WHERE user_id = 1');
      await db.run('DELETE FROM meals WHERE user_id = 1');
      await db.run('DELETE FROM diary WHERE user_id = 1');
      await db.run('DELETE FROM wellness_data WHERE user_id = 1');
      await db.run('DELETE FROM workouts WHERE user_id = 1');
      await db.run('DELETE FROM user_settings WHERE user_id = 1');
      await db.run('DELETE FROM fasts WHERE user_id = 1');
      await db.run('DELETE FROM sync_meta');
      return { ok: true };
    }
    console.warn(`[NtApiNative] DELETE ${path} — not available in local mode`);
    return {};
  },
};

// ── Fasting path dispatch (local mode) ──────────────────────────────────────
// Mirrors the server's /api/fasts routes against the local SQLite mirror so
// the IF tracker works in standalone Android with no server. Path matching
// keeps the store layer unchanged.

async function _fastsLocalGet(path) {
  const { dbGetActiveFast, dbGetFasts } = await import('./db-native.js');
  if (path === '/api/fasts/active') return await dbGetActiveFast();
  if (path.startsWith('/api/fasts')) {
    // /api/fasts or /api/fasts?limit=N
    const q = new URLSearchParams(path.includes('?') ? path.split('?')[1] : '');
    const limit = Math.min(365, Math.max(1, parseInt(q.get('limit')) || 60));
    return await dbGetFasts(limit);
  }
  return null;
}

async function _fastsLocalPost(path, body) {
  const { dbStartFast, dbEndFast } = await import('./db-native.js');
  if (path === '/api/fasts/start') {
    return await dbStartFast({
      goal_hours: body?.goal_hours,
      start_at: body?.start_at,
    });
  }
  // POST /api/fasts/:id/end
  const m = path.match(/^\/api\/fasts\/(\d+)\/end$/);
  if (m) return await dbEndFast(parseInt(m[1]));
  return null;
}

async function _fastsLocalPatch(path, body) {
  const { dbUpdateFast } = await import('./db-native.js');
  const m = path.match(/^\/api\/fasts\/(\d+)$/);
  if (m) return await dbUpdateFast(parseInt(m[1]), body || {});
  return null;
}

// Local dispatcher for /api/wellness/calories-out?date=YYYY-MM-DD. Mirrors
// the server endpoint: returns yesterday's calories_out from wellness_data
// with the same garmin > health_connect > fitbit priority.
async function _caloriesOutLocal(path) {
  const { getDb, LOCAL_USER_ID } = await import('./db-native.js');
  const q = new URLSearchParams(path.includes('?') ? path.split('?')[1] : '');
  const dateParam = q.get('date');
  const base = dateParam ? new Date(dateParam + 'T12:00:00Z') : new Date();
  base.setUTCDate(base.getUTCDate() - 1);
  const yesterday = base.toISOString().slice(0, 10);
  const db = await getDb();
  const r = await db.query(
    `SELECT source, value FROM wellness_data
     WHERE user_id = ? AND date = ? AND metric_type = 'calories_out'`,
    [LOCAL_USER_ID, yesterday]
  );
  const rows = r?.values || [];
  const PRIORITY = ['garmin', 'health_connect', 'fitbit'];
  for (const src of PRIORITY) {
    const row = rows.find(x => x.source === src);
    if (row) return { calories_out: row.value, source: src, date: yesterday };
  }
  return { calories_out: null, source: null, date: yesterday };
}

async function _fastsLocalDelete(path) {
  const { dbDeleteFast } = await import('./db-native.js');
  const m = path.match(/^\/api\/fasts\/(\d+)$/);
  if (m) { await dbDeleteFast(parseInt(m[1])); return { ok: true }; }
  return null;
}

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Remove the data URL prefix (data:image/...;base64,)
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
