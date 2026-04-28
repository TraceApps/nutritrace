/**
 * api.js - External API calls (Open Food Facts)
 */

// In native mode, call external APIs directly (no CORS in WebView).
// In web mode, go through the server proxy to avoid CORS.
async function _extFetch(url) {
  if (isNative) {
    // Use Capacitor's native HTTP to bypass CORS in the WebView
    const { CapacitorHttp } = await import('@capacitor/core');
    const resp = await CapacitorHttp.get({ url, headers: { 'Accept': 'application/json' } });
    // Wrap in a Response-like object so callers can use .ok / .json()
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data,
    };
  }
  return fetch('/api/proxy?url=' + encodeURIComponent(url));
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
    const { name, barcode, brand, portion, unit, nutrition } = food;
    if (!name || !barcode) throw new Error("Name and barcode required");
    const username = (settings && settings.offUsername) || "nutritrace-app";
    const password = (settings && settings.offPassword) || "nutritrace";
    const uploadCountry = (settings && settings.offUploadCountry) || "Auto";
    const lang = (navigator.language || "en").substring(0, 2);
    let params = "code=" + encodeURIComponent(barcode);
    params += "&user_id=" + encodeURIComponent(username);
    params += "&password=" + encodeURIComponent(password);
    params += "&lang=" + lang;
    params += "&product_name_" + lang + "=" + encodeURIComponent(name);
    if (brand) params += "&brands=" + encodeURIComponent(brand);
    params += "&nutrition_data_per=100g";
    if (portion && (parseFloat(portion) !== 100 || unit !== "g"))
      params += "&serving_size=" + encodeURIComponent(portion + " " + (unit || "g"));
    if (uploadCountry && uploadCountry !== "Auto")
      params += "&countries=" + encodeURIComponent(uploadCountry);
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
    return true;
  },

  _mapOFFProduct(p) {
    if (!p || !p.product_name) return null;
    const n = p.nutriments || {};
    const g = (key, mult) => {
      const v = n[key];
      if (v === undefined || v === null || v === '') return 0;
      return (parseFloat(v) || 0) * (mult || 1);
    };
    const kcal = g('energy-kcal_100g') || (n.energy_100g ? (parseFloat(n.energy_100g)||0) / 4.184 : 0);
    return {
      name:      (p.product_name || '').trim(),
      brand:     (Array.isArray(p.brands) ? (p.brands[0] || '') : (p.brands || '').split(',')[0] || '').trim(),
      barcode:   p.code || p._id || p.id || '',
      unit:      'g',
      portion:   100,
      quantity:  1,
      imgUrl: p.image_front_display_url || p.image_front_url || p.image_url || p.image_front_small_url || '',
      dateTime:  new Date().toISOString(),
      categories: [],
      nutrition: Nutrition.deriveSodiumSalt({
        calories:        Math.round(kcal * 10) / 10,
        kilojoules:      g('energy_100g'),
        fat:                   g('fat_100g'),
        'saturated-fat':       g('saturated-fat_100g'),
        'trans-fat':           g('trans-fat_100g'),
        'polyunsaturated-fat': g('polyunsaturated-fat_100g'),
        'monounsaturated-fat': g('monounsaturated-fat_100g'),
        carbohydrates:         g('carbohydrates_100g'),
        sugars:          g('sugars_100g'),
        'added-sugars':  g('added-sugars_100g'),
        fiber:           g('fiber_100g'),
        proteins:        g('proteins_100g'),
        salt:            g('salt_100g'),
        sodium:          g('sodium_100g', 1000),
        potassium:       g('potassium_100g', 1000),
        cholesterol:     g('cholesterol_100g', 1000),
        caffeine:        g('caffeine_100g', 1000),
        alcohol:         g('alcohol_100g'),
        calcium:         g('calcium_100g', 1000),
        iron:            g('iron_100g', 1000),
        magnesium:       g('magnesium_100g', 1000),
        'vitamin-c':     g('vitamin-c_100g', 1000),
        'vitamin-a':     g('vitamin-a_100g', 1000000),
        'vitamin-d':     g('vitamin-d_100g', 1000000),
        'vitamin-e':     g('vitamin-e_100g', 1000),
        'vitamin-k':     g('vitamin-k_100g', 1000000),
        b1:              g('vitamin-b1_100g', 1000),
        b2:              g('vitamin-b2_100g', 1000),
        b3:              g('vitamin-b3_100g', 1000),
        b6:              g('vitamin-b6_100g', 1000),
        b9:              g('vitamin-b9_100g', 1000000),
        b12:             g('vitamin-b12_100g', 1000000),
        zinc:            g('zinc_100g', 1000),
        phosphorus:      g('phosphorus_100g', 1000),
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
import { isNative, getServerUrl, getAuthToken, resolveAssetUrl } from './platform.js';
import { Nutrition } from './nutrition.js';

function _resolveBaseUrl() {
  if (!isNative) return ''; // relative — same origin as the web app
  const url = getServerUrl();
  return url || ''; // native + server configured → absolute URL
}

const _NtApiHttp = {
  // Core fetch — uses absolute URL + Bearer token (native server) or relative URL + cookies (web)
  async _fetch(method, path, body, isUpload = false) {
    const base = _resolveBaseUrl();
    const headers = {};
    if (!isUpload) headers['Content-Type'] = 'application/json';

    // Native server mode: add Bearer token (cookies don't persist across WebView reloads)
    if (isNative && base) {
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    // PWA cookie-based auth: add CSRF token for state-changing requests
    if (!isNative && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const res = await fetch(base + path, {
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

  // Users list for sharing picker (non-admin, returns peers only)
  getUsersList()                  { return this.get('/api/auth/users/list'); },

  // App config — admin full config, or public sharing status
  getAppConfig()                  { return this.get('/api/app-config'); },
  getSharingStatus()              { return this.get('/api/app-config/sharing'); },

  // Diary
  getDiaryDate(date)        { return this.get(`/api/diary/${date}`); },
  saveDiaryDate(date, data) { return this.put(`/api/diary/${date}`, data); },
  getAllDiary()              { return this.get('/api/diary'); },

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
