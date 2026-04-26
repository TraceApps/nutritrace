/**
 * api-cached.js — LOCAL-FIRST API layer for native server-connected mode.
 *
 * ALL reads come from local SQLite (instant, works offline).
 * ALL writes go to local SQLite first (with sync_status='pending'),
 * then attempt server write. If server fails, sync engine pushes later.
 *
 * The sync engine (sync.js) handles background data synchronization.
 * This module never blocks on server calls for reads.
 */

import {
  dbGetFoods, dbGetFood, dbCreateFood, dbUpdateFood, dbDeleteFood, dbCopyFood,
  dbGetMeals, dbGetMeal, dbCreateMeal, dbUpdateMeal, dbDeleteMeal, dbCopyMeal,
  dbGetDiaryDate, dbSaveDiaryDate, dbGetAllDiary,
} from './db-native.js';
import { getServerUrl, getAuthToken, resolveAssetUrl } from './platform.js';
import { schedulePush } from './sync.js';

function _headers() {
  const h = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function _base() {
  return getServerUrl() || '';
}

async function _serverFetch(method, path, body, timeoutMs = 3000) {
  const res = await fetch(_base() + path, {
    method,
    headers: _headers(),
    credentials: 'include',
    cache: 'no-store',
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// Field mapping helpers
function _foodFromApi(row) {
  if (!row) return null;
  const { img_url, category, ...rest } = row;
  return { ...rest, imgUrl: resolveAssetUrl(img_url) || '', categories: category ? [category] : [] };
}

function _foodToApi(food) {
  const { imgUrl, img_url, categories, category, ...rest } = food;
  return { ...rest, img_url: imgUrl || img_url || null, category: (categories && categories[0]) || category || null };
}

function _mealFromApi(row) {
  if (!row) return null;
  const { img_url, ...rest } = row;
  return { ...rest, imgUrl: resolveAssetUrl(img_url) || '' };
}

function _mealToApi(meal) {
  const { imgUrl, img_url, ...rest } = meal;
  return { ...rest, img_url: imgUrl || img_url || null };
}

export const NtApiCached = {

  // ── Foods — always local-first ────────────────────────────────────────

  async getFoods() {
    return (await dbGetFoods().catch(() => [])).map(_foodFromApi);
  },

  async getGroupFoods() {
    // Group foods (shared by other users) — must come from server
    try {
      return (await _serverFetch('GET', '/api/foods?group=1')).map(_foodFromApi);
    } catch {
      return [];
    }
  },

  async getFood(id) {
    const local = await dbGetFood(id).catch(() => null);
    return _foodFromApi(local);
  },

  async createFood(data) {
    const local = await dbCreateFood(_foodToApi(data));
    // Try server in background
    _serverFetch('POST', '/api/foods', _foodToApi(data)).then(async server => {
      if (server?.id && local?.id) {
        const { dbSetServerId, dbMarkSynced } = await import('./db-native.js');
        await dbSetServerId('foods', local.id, server.id);
        await dbMarkSynced('foods', [local.id]);
      }
    }).catch(() => schedulePush());
    return _foodFromApi(local);
  },

  async updateFood(id, data) {
    const local = await dbUpdateFood(id, _foodToApi(data));
    // Try server in background
    const serverId = local?.server_id || id;
    _serverFetch('PUT', `/api/foods/${serverId}`, _foodToApi(data)).catch(() => schedulePush());
    return _foodFromApi(local);
  },

  async deleteFood(id) {
    await dbDeleteFood(id);
    const food = await dbGetFood(id).catch(() => null);
    const serverId = food?.server_id || id;
    _serverFetch('DELETE', `/api/foods/${serverId}`).catch(() => schedulePush());
    return { ok: true };
  },

  async shareFood(id, visibility, user_ids) {
    try { return await _serverFetch('PATCH', `/api/foods/${id}/share`, { visibility, user_ids }); }
    catch { return { ok: true }; }
  },

  async copyFood(id) {
    try {
      const r = await _serverFetch('POST', `/api/foods/${id}/copy`, {});
      return _foodFromApi(r);
    } catch {
      return _foodFromApi(await dbCopyFood(id));
    }
  },

  // ── Meals & Recipes — always local-first ──────────────────────────────

  async getMeals() {
    return (await dbGetMeals(false).catch(() => [])).map(_mealFromApi);
  },

  async getGroupMeals() {
    try { return (await _serverFetch('GET', '/api/meals?group=1')).map(_mealFromApi); }
    catch { return []; }
  },

  async getRecipes() {
    return (await dbGetMeals(true).catch(() => [])).map(_mealFromApi);
  },

  async getGroupRecipes() {
    try { return (await _serverFetch('GET', '/api/meals?recipes=1&group=1')).map(_mealFromApi); }
    catch { return []; }
  },

  async getMeal(id) {
    return _mealFromApi(await dbGetMeal(id).catch(() => null));
  },

  async createMeal(data) {
    const local = await dbCreateMeal(_mealToApi(data));
    _serverFetch('POST', '/api/meals', _mealToApi(data)).then(async server => {
      if (server?.id && local?.id) {
        const { dbSetServerId, dbMarkSynced } = await import('./db-native.js');
        await dbSetServerId('meals', local.id, server.id);
        await dbMarkSynced('meals', [local.id]);
      }
    }).catch(() => schedulePush());
    return _mealFromApi(local);
  },

  async updateMeal(id, data) {
    const local = await dbUpdateMeal(id, _mealToApi(data));
    const serverId = local?.server_id || id;
    _serverFetch('PUT', `/api/meals/${serverId}`, _mealToApi(data)).catch(() => schedulePush());
    return _mealFromApi(local);
  },

  async deleteMeal(id) {
    const meal = await dbGetMeal(id).catch(() => null);
    await dbDeleteMeal(id);
    const serverId = meal?.server_id || id;
    _serverFetch('DELETE', `/api/meals/${serverId}`).catch(() => schedulePush());
    return { ok: true };
  },

  async shareMeal(id, visibility, user_ids) {
    try { return await _serverFetch('PATCH', `/api/meals/${id}/share`, { visibility, user_ids }); }
    catch { return { ok: true }; }
  },

  async copyMeal(id) {
    try { return _mealFromApi(await _serverFetch('POST', `/api/meals/${id}/copy`, {})); }
    catch { return _mealFromApi(await dbCopyMeal(id)); }
  },

  // ── Diary — always local-first ────────────────────────────────────────

  async getDiaryDate(date) {
    const local = await dbGetDiaryDate(date).catch(() => null);
    return local || { date, items: [], body_stats: {}, water: [] };
  },

  async saveDiaryDate(date, data) {
    const local = await dbSaveDiaryDate(date, data);
    _serverFetch('PUT', `/api/diary/${date}`, data).catch(() => schedulePush());
    return local || await dbGetDiaryDate(date);
  },

  async getAllDiary() {
    return await dbGetAllDiary().catch(() => []);
  },

  // ── Users (server-only) ───────────────────────────────────────────────

  async getUsersList() {
    try { return await _serverFetch('GET', '/api/auth/users/list'); }
    catch { return []; }
  },

  // ── App config (server-only) ──────────────────────────────────────────

  async getAppConfig() {
    try { return await _serverFetch('GET', '/api/app-config'); }
    catch { return { food_sharing_enabled: false }; }
  },

  async getSharingStatus() {
    try { return await _serverFetch('GET', '/api/app-config/sharing'); }
    catch { return { enabled: false }; }
  },

  // ── Upload ────────────────────────────────────────────────────────────

  async uploadImage(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(_base() + '/api/upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getAuthToken()}` },
      body: form,
    });
    if (!res.ok) throw new Error('Upload failed');
    const data = await res.json();
    return data.url;
  },

  // ── Pass-through for NtApi.post/get/put/del ───────────────────────────
  // GET: 3s (status checks, data reads — fail fast when server is down)
  // POST/PUT/PATCH/DELETE: 30s (sync operations call external APIs and can take time)
  get(path)           { return _serverFetch('GET', path); },
  post(path, body)    { return _serverFetch('POST', path, body, 30000); },
  put(path, body)     { return _serverFetch('PUT', path, body, 30000); },
  patch(path, body)   { return _serverFetch('PATCH', path, body, 30000); },
  del(path)           { return _serverFetch('DELETE', path, 30000); },
};
