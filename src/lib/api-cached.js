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
  dbGetFoods, dbGetFood, dbCreateFood, dbUpdateFood, dbDeleteFood, dbCopyFood, dbBumpFoodUsage,
  dbGetMeals, dbGetMeal, dbCreateMeal, dbUpdateMeal, dbDeleteMeal, dbCopyMeal, dbBumpMealUsage,
  dbGetDiaryDate, dbSaveDiaryDate, dbGetAllDiary,
} from './db-native.js';
import { getServerUrl, getAuthToken, resolveAssetUrl, apiUrl } from './platform.js';
import { schedulePush } from './sync.js';

function _headers() {
  const h = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function _serverFetch(method, path, body, timeoutMs = 3000) {
  const res = await fetch(apiUrl(path), {
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
//
// _fromApi resolves img_url through resolveAssetUrl so the device can show
// a locally-cached copy when offline. That resolved URL (a Capacitor
// `https://localhost/_capacitor_file_/...image_cache/...` path, or a
// proxy URL) MUST be stripped back to the original server-relative path
// before _toApi persists the food/meal — otherwise the cached path lands
// on the server and breaks display on PWA + other devices that don't
// share this device's filesystem. Mirrors what _stripCachedPaths does for
// diary item snapshots in stores/diary.js.
function _stripResolvedImgUrl(url) {
  if (!url) return url;
  // Full server-host URL → strip back to relative /uploads/... path. The
  // native client's resolveAssetUrl prepends `<serverUrl>` to relative
  // upload paths for display; without this strip, the full URL gets written
  // back to the foods table on save, and then the (pre-removal) boot-time
  // image-localizer loop on the server would re-download from itself on
  // every restart, giving the row a fresh filename and orphaning every
  // diary snapshot that still pointed at the previous name.
  try {
    const idx = url.indexOf('/uploads/');
    if (url.startsWith('http') && idx >= 0) {
      return url.slice(idx);
    }
  } catch {}
  // Capacitor cached path → only restore to /uploads/<filename> when the basename
  // matches the server's localized image-naming pattern (timestamp-md5.ext, see
  // server/lib/image-localizer.js). For anything else (e.g., a Capacitor cache
  // of a proxied external URL, where the cached basename is the source URL's
  // basename like 'front.en.6.400.jpg'), the basename does NOT correspond to
  // any /uploads/ file and prepending /uploads/ would cross-pollinate images
  // across foods that happen to share an OFF basename. Drop instead.
  if (url.includes('_capacitor_file_') || url.includes('/image_cache/')) {
    const filename = url.split('/').pop();
    if (filename && /^\d{10,}-[0-9a-f]{8,16}\.\w+$/i.test(filename)) {
      return '/uploads/' + filename;
    }
    return ''; // can't recover original — clear rather than persist garbage
  }
  // Proxy URL (`/api/proxy?url=https://...`) → restore the inner URL.
  if (url.includes('/api/proxy?url=')) {
    try {
      const inner = new URL(url, 'https://x').searchParams.get('url');
      if (inner) return inner;
    } catch {}
  }
  return url;
}

function _foodFromApi(row) {
  if (!row) return null;
  const { img_url, category, ...rest } = row;
  return { ...rest, imgUrl: resolveAssetUrl(img_url) || '', categories: category ? [category] : [] };
}

function _foodToApi(food) {
  const { imgUrl, img_url, categories, category, ...rest } = food;
  return {
    ...rest,
    img_url: _stripResolvedImgUrl(imgUrl || img_url) || null,
    category: (categories && categories[0]) || category || null,
  };
}

function _mealFromApi(row) {
  if (!row) return null;
  const { img_url, ...rest } = row;
  return { ...rest, imgUrl: resolveAssetUrl(img_url) || '' };
}

function _mealToApi(meal) {
  const { imgUrl, img_url, ...rest } = meal;
  return { ...rest, img_url: _stripResolvedImgUrl(imgUrl || img_url) || null };
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
    // Route the server write exclusively through the sync engine. Previous
    // implementation also fired an inline POST /api/foods in parallel — the
    // race between that inline POST and a sync engine push (which can tick
    // any time on visibility change, the 30s timer, or a prior debounced
    // schedulePush) caused server-side duplicates when both paths inserted
    // the same row. The local row is pending; schedulePush debounces +
    // fires pushChanges, which is the single, idempotent server-write path.
    // Fixes #32.
    schedulePush();
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

  // Local-first usage bump — keeps sort order responsive offline; the
  // server-side counter catches up on next sync via /:id/used.
  async markFoodUsed(id, date) {
    const food = await dbGetFood(id).catch(() => null);
    await dbBumpFoodUsage(id, date);
    const serverId = food?.server_id || id;
    _serverFetch('POST', `/api/foods/${serverId}/used`, { date }).catch(() => schedulePush());
    return { ok: true };
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
    // Sync-engine-only server write — same race that bit createFood (#32)
    // applies to createMeal verbatim, with the same fix.
    schedulePush();
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

  async markMealUsed(id, date) {
    const meal = await dbGetMeal(id).catch(() => null);
    await dbBumpMealUsage(id, date);
    const serverId = meal?.server_id || id;
    _serverFetch('POST', `/api/meals/${serverId}/used`, { date }).catch(() => schedulePush());
    return { ok: true };
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

  // ── Activity (server-only for now; no native cache yet) ───────────────

  async getActivity(date) {
    try { return await _serverFetch('GET', `/api/activity/${date}`); }
    catch { return []; }
  },
  async getActivitySum(date, policy = 'wearable_wins') {
    try { return await _serverFetch('GET', `/api/activity/sum/${date}?policy=${encodeURIComponent(policy)}`); }
    catch { return { manual: 0, wearable: 0, effective: 0, policy }; }
  },
  async getActivityRange(from, to) {
    try { return await _serverFetch('GET', `/api/activity?from=${from}&to=${to}`); }
    catch { return []; }
  },
  async createActivity(data)     { return _serverFetch('POST', '/api/activity', data); },
  async updateActivity(id, data) { return _serverFetch('PUT', `/api/activity/${id}`, data); },
  async deleteActivity(id)       { return _serverFetch('DELETE', `/api/activity/${id}`); },

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
    const res = await fetch(apiUrl('/api/upload'), {
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
  async get(path) {
    // Local-first for IF endpoints so the timer keeps working when the
    // server is unreachable. Server pulls on the next sync will reconcile.
    if (path.startsWith('/api/fasts')) return _fastsCachedGet(path);
    // Adaptive TDEE — try server first (fresher data), fall back to local
    // compute if the server is unreachable. Numbers will match because the
    // client compute is a direct port of the server lib.
    if (path === '/api/goals/adaptive-tdee') {
      try { return await _serverFetch('GET', path); }
      catch {
        const { computeAdaptiveTdeeLocal } = await import('./adaptive-tdee-local.js');
        return await computeAdaptiveTdeeLocal();
      }
    }
    return _serverFetch('GET', path);
  },
  async post(path, body) {
    if (path.startsWith('/api/fasts')) return _fastsCachedPost(path, body);
    return _serverFetch('POST', path, body, 30000);
  },
  put(path, body)     { return _serverFetch('PUT', path, body, 30000); },
  async patch(path, body) {
    if (path.startsWith('/api/fasts')) return _fastsCachedPatch(path, body);
    return _serverFetch('PATCH', path, body, 30000);
  },
  // _serverFetch is (method, path, body, timeoutMs). Pass body as null so we
  // don't ship a stray JSON-stringified number as the request body, and put
  // the 30s timeout in its actual position.
  async del(path) {
    if (path.startsWith('/api/fasts')) return _fastsCachedDelete(path);
    return _serverFetch('DELETE', path, null, 30000);
  },
};

// ── Fasting: local-first writes, server reconciliation in background ────────

async function _fastsCachedGet(path) {
  const { dbGetActiveFast, dbGetFasts } = await import('./db-native.js');
  if (path === '/api/fasts/active') return await dbGetActiveFast();
  if (path.startsWith('/api/fasts')) {
    const q = new URLSearchParams(path.includes('?') ? path.split('?')[1] : '');
    const limit = Math.min(365, Math.max(1, parseInt(q.get('limit')) || 60));
    return await dbGetFasts(limit);
  }
  return null;
}

async function _fastsCachedPost(path, body) {
  const { dbStartFast, dbEndFast } = await import('./db-native.js');
  if (path === '/api/fasts/start') {
    const local = await dbStartFast({ goal_hours: body?.goal_hours, start_at: body?.start_at });
    // Best-effort server mirror so other clients see it too.
    _serverFetch('POST', '/api/fasts/start', body || {}, 30000)
      .then(async server => {
        if (server?.id && local?.id) {
          const { getDb } = await import('./db-native.js');
          const db = await getDb();
          await db.run(`UPDATE fasts SET server_id = ?, sync_status = 'synced' WHERE id = ?`, [server.id, local.id]);
        }
      })
      .catch(() => schedulePush());
    return local;
  }
  const m = path.match(/^\/api\/fasts\/(\d+)\/end$/);
  if (m) {
    const id = parseInt(m[1]);
    const local = await dbEndFast(id);
    // Need the server-side id to end-fast on the server. Look it up.
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    const r = await db.query(`SELECT server_id FROM fasts WHERE id = ?`, [id]);
    const serverId = (r?.values || [])[0]?.server_id;
    if (serverId) {
      _serverFetch('POST', `/api/fasts/${serverId}/end`, {}, 30000).catch(() => schedulePush());
    } else {
      // No server id yet — diff-sync push will create + end it together.
      schedulePush();
    }
    return local;
  }
  return null;
}

async function _fastsCachedPatch(path, body) {
  const { dbUpdateFast, getDb } = await import('./db-native.js');
  const m = path.match(/^\/api\/fasts\/(\d+)$/);
  if (m) {
    const id = parseInt(m[1]);
    const local = await dbUpdateFast(id, body || {});
    const db = await getDb();
    const r = await db.query(`SELECT server_id FROM fasts WHERE id = ?`, [id]);
    const serverId = (r?.values || [])[0]?.server_id;
    if (serverId) {
      _serverFetch('PATCH', `/api/fasts/${serverId}`, body || {}, 30000).catch(() => schedulePush());
    } else {
      schedulePush();
    }
    return local;
  }
  return null;
}

async function _fastsCachedDelete(path) {
  const { dbDeleteFast, getDb } = await import('./db-native.js');
  const m = path.match(/^\/api\/fasts\/(\d+)$/);
  if (m) {
    const id = parseInt(m[1]);
    const db = await getDb();
    const r = await db.query(`SELECT server_id FROM fasts WHERE id = ?`, [id]);
    const serverId = (r?.values || [])[0]?.server_id;
    await dbDeleteFast(id);
    if (serverId) {
      _serverFetch('DELETE', `/api/fasts/${serverId}`, null, 30000).catch(() => schedulePush());
    } else {
      schedulePush();
    }
    return { ok: true };
  }
  return null;
}
