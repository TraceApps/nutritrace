/**
 * api.js - External API calls (Open Food Facts)
 */

// In native mode, call external APIs directly (no CORS in WebView).
// In web mode, go through the server proxy to avoid CORS.
//
// Exception: when the admin has configured a local OFF mirror on the server
// (`off_local` env-lock true), the native server-connected path routes
// through the server proxy too so the mirror actually gets used. Without
// this gate, an admin running OFF_LOCAL_ONLY=1 would still see Android
// users silently bypassing the air-gap via CapacitorHttp. The gate is
// strictly opt-in — users who haven't enabled the mirror see no behavior
// change. Standalone native (no server) keeps the direct call because
// there's no proxy to route through. Issue #22.
async function _extFetch(url) {
  if (isNative) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const { apiUrl, getServerUrl, getAuthToken } = await import('./platform.js');
    let envLockedOffLocal = false;
    try {
      const { get } = await import('svelte/store');
      const { envLocks } = await import('../stores/settings.js');
      envLockedOffLocal = !!get(envLocks)?.off_local;
    } catch {}
    if (envLockedOffLocal && getServerUrl()) {
      // Server-connected native + admin enabled local OFF mirror: route
      // through /api/proxy on the server so the local DB intercept fires.
      const proxyUrl = apiUrl('/api/proxy?url=' + encodeURIComponent(url));
      const headers = { 'Accept': 'application/json' };
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await CapacitorHttp.get({ url: proxyUrl, headers });
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        json: async () => typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data,
      };
    }
    // Default native path: direct call (bypasses WebView CORS, unchanged
    // behavior for all users who don't enable the local mirror).
    const resp = await CapacitorHttp.get({ url, headers: { 'Accept': 'application/json' } });
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data,
    };
  }
  // Lazy-import to avoid an early-load circular reference; apiUrl() prefixes
  // the path with the BASE_URL when running at a subpath.
  const { apiUrl } = await import('./platform.js');
  return fetch(apiUrl('/api/proxy?url=' + encodeURIComponent(url)));
}

const API = {
  OFF_BASE: 'https://world.openfoodfacts.org',

  async lookupBarcode(barcode) {
    try {
      const res = await _extFetch(`${this.OFF_BASE}/api/v0/product/${barcode}.json`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.status !== 1) return null;
      return this._mapOFFProduct(data.product);
    } catch(e) {
      console.error('Barcode lookup failed:', e);
      return null;
    }
  },

  async searchByName(query, page) {
    page = page || 1;
    try {
      const offUrl = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(query)}&json=1&page_size=20&page=${page}`;
      const res = await _extFetch(offUrl);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.hits || []).map(p => this._mapOFFProduct(p)).filter(Boolean);
    } catch(e) {
      console.error('Search failed:', e);
      return [];
    }
  },

  async contributeToOFF(food, settings) {
    const { name, barcode, brand, portion, unit, nutrition, imgUrl } = food;
    if (!name || !barcode) throw new Error("Name and barcode required");
    // Air-gap honor: if the server has OFF_LOCAL_ONLY set, the admin
    // explicitly opted into never calling out to OFF — refuse the upload
    // instead of silently slipping through to the public API. (The lookup
    // proxy already enforces this on reads; this closes the same loop on
    // writes.)
    try {
      const { get } = await import('svelte/store');
      const { envLocks } = await import('../stores/settings.js');
      if (get(envLocks)?.off_local_only) {
        throw new Error('OFF contributions are disabled on this server (air-gap mode).');
      }
    } catch (e) {
      if (e.message?.startsWith('OFF contributions are disabled')) throw e;
      // Store/import lookup failed for some unrelated reason — don't block
      // the upload over an envLocks fetch glitch.
    }
    const username = (settings && settings.offUsername) || "nutritrace-app";
    const password = (settings && settings.offPassword) || "nutritrace";
    const uploadCountry = (settings && settings.offUploadCountry) || "Auto";
    const lang = (navigator.language || "en").substring(0, 2);
    // If the food's portion is 100g exactly, our nutrition values are
    // per-100g and we send them as such. For any other portion size, our
    // values are per-that-portion, so we send them with nutrition_data_per
    // = serving and tell OFF the serving size. Previously the function
    // unconditionally claimed per-100g even when the values were per a
    // different portion, which corrupted the OFF record.
    const portionVal = parseFloat(portion) || 0;
    const unitVal    = unit || 'g';
    const isPer100g  = portionVal === 100 && unitVal === 'g';
    const perKey     = isPer100g ? '100g' : 'serving';
    let params = "code=" + encodeURIComponent(barcode);
    params += "&user_id=" + encodeURIComponent(username);
    params += "&password=" + encodeURIComponent(password);
    params += "&lang=" + lang;
    params += "&product_name_" + lang + "=" + encodeURIComponent(name);
    if (brand) params += "&brands=" + encodeURIComponent(brand);
    params += "&nutrition_data_per=" + perKey;
    if (!isPer100g) {
      params += "&serving_size=" + encodeURIComponent(portionVal + " " + unitVal);
    }
    if (uploadCountry && uploadCountry !== "Auto")
      params += "&countries=" + encodeURIComponent(uploadCountry);
    // Per the official OFF spec (docs/api/ref/requestBodies/
    // add_or_edit_a_product.yaml): nutriment field naming is
    // `nutriment_<nutrient_id>` regardless of whether the values are
    // per-100g or per-serving. The `nutrition_data_per` field already
    // tells OFF how to interpret all values. NO `_serving` suffix.
    const nutMap = {
      calories: "energy-kcal", kilojoules: "energy", fat: "fat",
      "saturated-fat": "saturated-fat", carbohydrates: "carbohydrates",
      sugars: "sugars", fiber: "fiber", proteins: "proteins",
      salt: "salt", sodium: "sodium"
    };
    const nut = nutrition || {};
    for (const [key, field] of Object.entries(nutMap)) {
      if (nut[key] !== undefined && nut[key] !== "" && !isNaN(parseFloat(nut[key])))
        params += "&nutriment_" + field + "=" + nut[key];
    }
    const res = await fetch("https://world.openfoodfacts.org/cgi/product_jqm2.pl?" + params);
    const json = await res.json();
    if (json.status !== 1) throw new Error(json.status_verbose || "Upload failed");

    // Best-effort image upload as a separate multipart POST. Failure here
    // doesn't roll back the data upload — the product record is already
    // created, the image is just an enhancement. Previously the picture
    // was silently dropped. Image upload uses cgi/product_image_upload.pl
    // with imagefield=front_<lang> + imgupload_<imagefield>=<file>.
    if (imgUrl) {
      try {
        const blob = await this._fetchImageBlob(imgUrl);
        if (blob) {
          const fd = new FormData();
          fd.append('code', barcode);
          fd.append('user_id', username);
          fd.append('password', password);
          const imagefield = 'front_' + lang;
          fd.append('imagefield', imagefield);
          // Field name encodes the slot per OFF's docs.
          fd.append('imgupload_' + imagefield, blob, 'front.jpg');
          await fetch('https://world.openfoodfacts.org/cgi/product_image_upload.pl', {
            method: 'POST', body: fd,
          });
        }
      } catch (e) {
        console.warn('[OFF] image upload failed (data was still submitted):', e?.message || e);
      }
    }
    return true;
  },

  // Fetch any imgUrl (relative server path, absolute URL, or data: URI)
  // as a Blob so it can be sent in the multipart OFF upload. Returns null
  // on failure — callers treat the image as optional.
  async _fetchImageBlob(imgUrl) {
    if (!imgUrl) return null;
    try {
      const res = await fetch(imgUrl, { credentials: 'include' });
      if (!res.ok) return null;
      return await res.blob();
    } catch {
      return null;
    }
  },

  _mapOFFProduct(p) {
    if (!p || !p.product_name) return null;
    const n = p.nutriments || {};
    // Per-serving import: enabled by the user via Settings → Connected Services →
    // Open Food Facts → Import Portion As, and only when the product actually
    // exposes serving_quantity + at least one *_serving nutriment. Otherwise the
    // 100g path is used unchanged.
    const userId = localStorage.getItem('wl:userId');
    const setKey = userId ? `wl_u${userId}_offImportPortion` : 'wl_offImportPortion';
    let importPortion = 'per100g';
    try {
      const raw = localStorage.getItem(setKey);
      if (raw) importPortion = JSON.parse(raw);
    } catch {}
    const servingQty = parseFloat(p.serving_quantity);
    const useServing = importPortion === 'perServing'
      && Number.isFinite(servingQty) && servingQty > 0
      && (n['energy-kcal_serving'] != null || n.energy_serving != null);
    const suffix = useServing ? '_serving' : '_100g';
    const portion = useServing ? servingQty : 100;
    const unit    = useServing ? (p.serving_quantity_unit || 'g') : 'g';
    const g = (baseKey, mult) => {
      const v = n[baseKey + suffix];
      if (v === undefined || v === null || v === '') return 0;
      return (parseFloat(v) || 0) * (mult || 1);
    };
    const kcal = g('energy-kcal')
      || (n['energy' + suffix] ? (parseFloat(n['energy' + suffix])||0) / 4.184 : 0);
    return {
      name:      (p.product_name || '').trim(),
      brand:     (Array.isArray(p.brands) ? (p.brands[0] || '') : (p.brands || '').split(',')[0] || '').trim(),
      barcode:   p.code || p._id || p.id || '',
      unit,
      portion,
      quantity:  1,
      imgUrl: p.image_front_display_url || p.image_front_url || p.image_url || p.image_front_small_url || '',
      dateTime:  new Date().toISOString(),
      categories: [],
      nutrition: Nutrition.deriveSodiumSalt({
        calories:        Math.round(kcal * 10) / 10,
        kilojoules:      g('energy'),
        fat:                   g('fat'),
        'saturated-fat':       g('saturated-fat'),
        'trans-fat':           g('trans-fat'),
        'polyunsaturated-fat': g('polyunsaturated-fat'),
        'monounsaturated-fat': g('monounsaturated-fat'),
        carbohydrates:         g('carbohydrates'),
        sugars:          g('sugars'),
        'added-sugars':  g('added-sugars'),
        fiber:           g('fiber'),
        proteins:        g('proteins'),
        salt:            g('salt'),
        sodium:          g('sodium', 1000),
        potassium:       g('potassium', 1000),
        cholesterol:     g('cholesterol', 1000),
        caffeine:        g('caffeine', 1000),
        alcohol:         g('alcohol'),
        calcium:         g('calcium', 1000),
        iron:            g('iron', 1000),
        magnesium:       g('magnesium', 1000),
        'vitamin-c':     g('vitamin-c', 1000),
        'vitamin-a':     g('vitamin-a', 1000000),
        'vitamin-d':     g('vitamin-d', 1000000),
        'vitamin-e':     g('vitamin-e', 1000),
        'vitamin-k':     g('vitamin-k', 1000000),
        b1:              g('vitamin-b1', 1000),
        b2:              g('vitamin-b2', 1000),
        b3:              g('vitamin-b3', 1000),
        b6:              g('vitamin-b6', 1000),
        b9:              g('vitamin-b9', 1000000),
        b12:             g('vitamin-b12', 1000000),
        zinc:            g('zinc', 1000),
        phosphorus:      g('phosphorus', 1000),
      })
    };
  }
};
const _USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';

// USDA FoodData Central nutrient ID → our nutrition object key
const _USDA_NUTRIENT_MAP = {
  1008: 'calories',        // Energy kcal
  1062: 'kilojoules',      // Energy kJ
  1003: 'proteins',
  1004: 'fat',
  1258: 'saturated-fat',
  1257: 'trans-fat',
  1292: 'polyunsaturated-fat',
  1268: 'monounsaturated-fat',
  1005: 'carbohydrates',
  2000: 'sugars',
  1235: 'added-sugars',
  1079: 'fiber',
  1093: 'sodium',          // mg
  1253: 'cholesterol',     // mg
  1087: 'calcium',         // mg
  1089: 'iron',            // mg
  1092: 'potassium',       // mg
  1090: 'magnesium',       // mg
  1095: 'zinc',            // mg
  1091: 'phosphorus',      // mg
  1162: 'vitamin-c',       // mg
  1106: 'vitamin-a',       // mcg
  1114: 'vitamin-d',       // mcg
  1109: 'vitamin-e',       // mg
  1185: 'vitamin-k',       // mcg
  1165: 'b1',              // mg
  1166: 'b2',              // mg
  1167: 'b3',              // mg
  1175: 'b6',              // mg
  1177: 'b9',              // mcg (folate)
  1178: 'b12',             // mcg
};

const USDA = {
  _mapProduct(item, servingSize) {
    // Normalise all nutrient values to per-100g basis
    // servingSize is the USDA serving size in g/ml; factor scales values → per 100g
    const factor = (servingSize && servingSize > 0) ? (100 / servingSize) : 1;
    const nutrition = {};

    for (const fn of (item.foodNutrients || [])) {
      // Search API returns nutrientId directly; detail API nests it under fn.nutrient.id
      const nid = fn.nutrientId || (fn.nutrient && fn.nutrient.id);
      const key = _USDA_NUTRIENT_MAP[nid];
      // Search API uses fn.value; Foundation/SR Legacy detail API uses fn.amount
      const raw = fn.value != null ? fn.value : fn.amount;
      if (key && raw != null) {
        nutrition[key] = Math.round(raw * factor * 10000) / 10000;
      }
    }

    // Derive kJ from kcal if kJ nutrient not present (Android does same conversion)
    if (nutrition.calories && !nutrition.kilojoules) {
      nutrition.kilojoules = Math.round(nutrition.calories * 4.184 * 10) / 10;
    }

    // Derive salt from sodium (or vice versa) via the regulatory factor.
    // Sets `_derived.salt` so the food editor can render the calculator icon.
    Nutrition.deriveSodiumSalt(nutrition);

    // USDA "Carbohydrate, by difference" includes fiber — subtract to match OFF net-carbs
    if (nutrition.carbohydrates != null && nutrition.fiber != null) {
      let corrected = nutrition.carbohydrates - nutrition.fiber;
      // Floor at sugars value (can't be less than sugars)
      if (corrected < (nutrition.sugars || 0)) corrected = nutrition.sugars || 0;
      nutrition.carbohydrates = Math.round(corrected * 10000) / 10000;
    }

    const rawUnit = (item.servingSizeUnit || 'g').toLowerCase();
    const unit = rawUnit === 'ml' ? 'ml' : 'g';

    return {
      name:      (item.description || '').trim(),
      brand:     (item.brandOwner || item.brandName || '').trim(),
      // Use fdcId_ prefix as barcode (matches Android; lets food editor link to USDA page)
      barcode:   item.fdcId ? 'fdcId_' + item.fdcId : (item.gtinUpc || ''),
      unit,
      portion:   100,
      quantity:  1,
      imgUrl: '',
      dateTime:  new Date().toISOString(),
      categories: [],
      nutrition,
      _source:   'usda',
    };
  },

  async searchByName(query, page, apiKey) {
    page = page || 1;
    if (!apiKey) return [];
    try {
      // No dataType filter — search all (Branded, Foundation, SR Legacy, Survey)
      // matches Android app behaviour
      const url = _USDA_BASE + '/foods/search?query=' + encodeURIComponent(query) +
        '&pageSize=20&pageNumber=' + page +
        '&api_key=' + encodeURIComponent(apiKey);
      const res = await _extFetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.foods || []).map(f => {
        // Use servingSize when available, otherwise fall back to 100g base
        const ss = (f.servingSize && !isNaN(f.servingSize)) ? f.servingSize : 100;
        return this._mapProduct(f, ss);
      }).filter(f => f.name);
    } catch(e) {
      console.error('[USDA] Search failed:', e);
      return [];
    }
  },

  async lookupBarcode(barcode, apiKey) {
    if (!apiKey || !barcode) return null;
    try {
      // Branded only (only branded products have GTINs/UPCs)
      const url = _USDA_BASE + '/foods/search?query=' + encodeURIComponent(barcode) +
        '&dataType=Branded&pageSize=10&api_key=' + encodeURIComponent(apiKey);
      const res = await _extFetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      // Match on exact UPC or UPC without leading zeros
      const match = (data.foods || []).find(f =>
        f.gtinUpc && (f.gtinUpc === barcode || f.gtinUpc === barcode.replace(/^0+/, ''))
      );
      if (!match) return null;
      const ss = (match.servingSize && !isNaN(match.servingSize)) ? match.servingSize : 100;
      return this._mapProduct(match, ss);
    } catch(e) {
      console.error('[USDA] Barcode lookup failed:', e);
      return null;
    }
  }
};

// ── NutriTrace Server API ──────────────────────────────────────────────────

// In native standalone mode (Capacitor + no server URL), requests are served
// from the local SQLite database via NtApiNative. In all other cases (web PWA,
// or native with a server URL configured) this HTTP implementation is used.
import { isNative, getServerUrl, getAuthToken, resolveAssetUrl, apiUrl } from './platform.js';
import { Nutrition } from './nutrition.js';

const _NtApiHttp = {
  // Core fetch — apiUrl() handles the server URL prefix (native server mode)
  // or the BASE_URL prefix (PWA at a subpath) consistently for every call.
  async _fetch(method, path, body, isUpload = false) {
    const headers = {};
    if (!isUpload) headers['Content-Type'] = 'application/json';

    // Native server mode: add Bearer token (cookies don't persist across WebView reloads)
    if (isNative && getServerUrl()) {
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    // PWA cookie-based auth: add CSRF token for state-changing requests
    if (!isNative && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const res = await fetch(apiUrl(path), {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: isUpload ? body : body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `API error ${res.status}`); }
    return res.json();
  },

  get(path)           { return this._fetch('GET',    path); },
  post(path, body)    { return this._fetch('POST',   path, body); },
  put(path, body)     { return this._fetch('PUT',    path, body); },
  patch(path, body)   { return this._fetch('PATCH',  path, body); },
  del(path)           { return this._fetch('DELETE', path); },

  // Food field mapping: server uses img_url/category, app uses imgUrl/categories
  _foodFromApi(row) {
    if (!row) return null;
    const { img_url, category, ...rest } = row;
    return { ...rest, imgUrl: resolveAssetUrl(img_url) || '', categories: category ? [category] : [] };
  },
  _foodToApi(food) {
    const { imgUrl, img_url, categories, category, ...rest } = food;
    return { ...rest, img_url: imgUrl || img_url || null, category: (categories && categories[0]) || category || null };
  },

  // Foods
  async getFoods()                { const r = await this.get('/api/foods'); return r.map(f => this._foodFromApi(f)); },
  async getGroupFoods()           { const r = await this.get('/api/foods?group=1'); return r.map(f => this._foodFromApi(f)); },
  async getFood(id)               { const r = await this.get(`/api/foods/${id}`); return this._foodFromApi(r); },
  async createFood(data)          { const r = await this.post('/api/foods', this._foodToApi(data)); return this._foodFromApi(r); },
  async updateFood(id, data)      { const r = await this.put(`/api/foods/${id}`, this._foodToApi(data)); return this._foodFromApi(r); },
  deleteFood(id)                  { return this.del(`/api/foods/${id}`); },
  shareFood(id, visibility, user_ids) { return this.patch(`/api/foods/${id}/share`, { visibility, user_ids }); },
  async copyFood(id)              { const r = await this.post(`/api/foods/${id}/copy`, {}); return this._foodFromApi(r); },
  markFoodUsed(id, date)          { return this.post(`/api/foods/${id}/used`, { date }); },

  // Meal field mapping: server uses img_url, app uses imgUrl
  _mealFromApi(row) {
    if (!row) return null;
    const { img_url, ...rest } = row;
    return { ...rest, imgUrl: resolveAssetUrl(img_url) || '' };
  },
  _mealToApi(meal) {
    const { imgUrl, img_url, ...rest } = meal;
    return { ...rest, img_url: imgUrl || img_url || null };
  },

  // Meals & Recipes
  async getMeals()                { const r = await this.get('/api/meals'); return r.map(m => this._mealFromApi(m)); },
  async getGroupMeals()           { const r = await this.get('/api/meals?group=1'); return r.map(m => this._mealFromApi(m)); },
  async getGroupRecipes()         { const r = await this.get('/api/meals?recipes=1&group=1'); return r.map(m => this._mealFromApi(m)); },
  async getMeal(id)               { const r = await this.get(`/api/meals/${id}`); return this._mealFromApi(r); },
  async getRecipes()              { const r = await this.get('/api/meals?recipes=1'); return r.map(m => this._mealFromApi(m)); },
  async createMeal(data)          { const r = await this.post('/api/meals', this._mealToApi(data)); return this._mealFromApi(r); },
  async updateMeal(id, data)      { const r = await this.put(`/api/meals/${id}`, this._mealToApi(data)); return this._mealFromApi(r); },
  deleteMeal(id)                  { return this.del(`/api/meals/${id}`); },
  shareMeal(id, visibility, user_ids) { return this.patch(`/api/meals/${id}/share`, { visibility, user_ids }); },
  async copyMeal(id)              { const r = await this.post(`/api/meals/${id}/copy`, {}); return this._mealFromApi(r); },
  markMealUsed(id, date)          { return this.post(`/api/meals/${id}/used`, { date }); },

  // Users list for sharing picker (non-admin, returns peers only)
  getUsersList()                  { return this.get('/api/auth/users/list'); },

  // App config — admin full config, or public sharing status
  getAppConfig()                  { return this.get('/api/app-config'); },
  getSharingStatus()              { return this.get('/api/app-config/sharing'); },

  // Diary
  getDiaryDate(date)        { return this.get(`/api/diary/${date}`); },
  saveDiaryDate(date, data) { return this.put(`/api/diary/${date}`, data); },
  getAllDiary()              { return this.get('/api/diary'); },

  // Activity (manual exercise/calorie-burn entries)
  getActivity(date)          { return this.get(`/api/activity/${date}`); },
  getActivitySum(date, policy = 'wearable_wins') { return this.get(`/api/activity/sum/${date}?policy=${encodeURIComponent(policy)}`); },
  getActivityRange(from, to) { return this.get(`/api/activity?from=${from}&to=${to}`); },
  createActivity(data)       { return this.post('/api/activity', data); },
  updateActivity(id, data)   { return this.put(`/api/activity/${id}`, data); },
  deleteActivity(id)         { return this.del(`/api/activity/${id}`); },

  // Upload
  async uploadImage(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await this._fetch('POST', '/api/upload', form, true);
    return res.url; // relative URL, e.g. /uploads/filename.jpg
  },
};

// ── Platform-aware NtApi export ────────────────────────────────────────────
// In Capacitor native standalone mode: use SQLite-backed NtApiNative.
// In all other cases (web, native + server URL): use the HTTP implementation.
// Both are statically imported so Rollup can bundle them; the unused branch
// is never called at runtime (isNative is false in the browser).

import { NtApiNative } from './api-native.js';

// Dynamic proxy — resolves which implementation to use on EVERY call.
// Three modes: web (HTTP), native standalone (local SQLite), native server (cached).
import { NtApiCached } from './api-cached.js';

export const NtApi = new Proxy({}, {
  get(_, prop) {
    let impl;
    if (!isNative) {
      impl = _NtApiHttp;                    // Web PWA — always server
    } else if (!getServerUrl()) {
      impl = NtApiNative;                   // Native standalone — always local
    } else {
      impl = NtApiCached;                   // Native + server — cached/offline
    }
    return typeof impl[prop] === 'function' ? impl[prop].bind(impl) : impl[prop];
  }
});
export { API, USDA };
