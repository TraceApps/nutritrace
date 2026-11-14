/**
 * api.js - External API calls (Open Food Facts)
 */
import { settingPrefix } from './setting-key.js';
import { OFF_BASE, offLanguage, offCountryTag, offSearchUrl, offProductUrl, isOffSuccess, mapOffProduct, mapFullOffProduct, rankOffSearch } from './off-map.js';
import { shareWithOff, OffShareError } from './off-contribute.js';

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
// `live`: ask Open Food Facts itself even when the server has a local OFF
// mirror (#241). The mirror is a periodic dump, so a product edited on OFF
// since then comes back old; Refresh from OFF is the one place that must see
// the edit. An air-gapped server (OFF_LOCAL_ONLY) still answers from the mirror.
async function _extFetch(url, { live = false } = {}) {
  const proxyPath = '/api/proxy?url=' + encodeURIComponent(url) + (live ? '&live=1' : '');
  if (isNative) {
    const { NativeHttp } = await import('./native-http.js');
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
      const proxyUrl = apiUrl(proxyPath);
      const headers = { 'Accept': 'application/json' };
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await NativeHttp.get({ url: proxyUrl, headers });
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        json: async () => typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data,
      };
    }
    // Default native path: direct call (bypasses WebView CORS, unchanged
    // behavior for all users who don't enable the local mirror).
    const resp = await NativeHttp.get({ url, headers: { 'Accept': 'application/json' } });
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data,
    };
  }
  // Lazy-import to avoid an early-load circular reference; apiUrl() prefixes
  // the path with the BASE_URL when running at a subpath.
  const { apiUrl } = await import('./platform.js');
  return fetch(apiUrl(proxyPath));
}

// Read the user's saved OFF country-filter preference from localStorage.
// Returns the OFF countries_tags value (for example `en:norway`) or null when
// the user picked 'World' or hasn't set anything. Reading direct from
// localStorage instead of the store to keep this module store-free.
function _getOffSearchCountry() {
  try {
    const setKey = settingPrefix() + 'offSearchCountry';
    const raw = localStorage.getItem(setKey);
    if (!raw) return null;
    return offCountryTag(JSON.parse(raw));
  } catch { return null; }
}

// The search-a-licious URL for the user's OFF country and language. The
// query escaping and the URL itself live in off-map.js, shared with the
// server's MCP tools (#314).
function _offSearchUrl(query, page, pageSize) {
  return offSearchUrl(query, { page, pageSize, country: _getOffSearchCountry(), lang: _getOffSearchLanguage() });
}

// Read the user's saved OFF language preference (short ISO 639-1 code
// like 'en', 'fr', 'de'). Name search sends it as `langs=` (with English
// alongside, see offSearchLangs in off-map.js). Defaults to 'en'
// (matches the setting store default) so we don't have to special-case
// null downstream. Same store-free localStorage pattern as
// _getOffSearchCountry.
function _getOffSearchLanguage() {
  try {
    const setKey = settingPrefix() + 'offSearchLanguage';
    const raw = localStorage.getItem(setKey);
    if (!raw) return 'en';
    return offLanguage(JSON.parse(raw));
  } catch { return 'en'; }
}

// The user's Import Portion As setting for OFF ('per100g' or 'perServing').
function _getOffImportPortion() {
  let importPortion = 'per100g';
  try {
    const raw = localStorage.getItem(settingPrefix() + 'offImportPortion');
    if (raw) importPortion = JSON.parse(raw);
  } catch {}
  return importPortion;
}

// Search result ordering (OFF relevance groups, then photos, completeness
// and Nutri-Score) lives in off-rank.js. #192, #213.

// Whether a reply found a product (isOffSuccess), the nutrient table and the
// mapper itself are in off-map.js, shared with the server (#314).

// #241: what Open Food Facts actually has for each product seen this session,
// by barcode. The OFF mapper turns missing values into 0, so a product with no
// "as sold" values arrives looking like a real 0 kcal food. Screens copy
// product objects around (spreads drop the hidden markers on them), so they
// ask here by barcode instead. In memory only: nothing here is ever saved.
// A full product lookup always beats a search hit, which carries less.
const _OFF_INFO_MAX = 500;
const _offInfo = new Map();
function _rememberOffInfo(code, info) {
  if (!code) return;
  const key = String(code);
  const prior = _offInfo.get(key);
  if (prior && prior.full && !info.full) return;
  _offInfo.delete(key);
  if (_offInfo.size >= _OFF_INFO_MAX) _offInfo.delete(_offInfo.keys().next().value);
  _offInfo.set(key, info);
}

const API = {
  OFF_BASE,

  /** What OFF has for a product seen this session, or null (see _offInfo). */
  // #241: a full product lookup, with the product's "as sold" values when
  // v3 leaves them out. v3 serves one set of values and prefers "as prepared",
  // so a product that has both comes back "as prepared" only; v3.5 serves all
  // the sets (see off-nutrition-sets.js). Asked only in that case, and any
  // failure or surprise keeps the v3 answer, as does an "as sold" set with no
  // calories (a formula listing only "sugars 0"): 0 kcal is worse than the
  // "as prepared" values the user is offered then.
  async _mapFullOFFProduct(product, code, { live = false } = {}) {
    return mapFullOffProduct(product, code, {
      map: (p) => this._mapOFFProduct(p, { full: true }),
      fetchJson: async (url) => {
        const res = await _extFetch(url, { live });
        return res.ok ? await res.json() : null;
      },
    });
  },

  offNutritionInfo(barcode) {
    return barcode ? (_offInfo.get(String(barcode)) || null) : null;
  },

  async lookupBarcode(barcode, { live = false } = {}) {
    try {
      const lc = _getOffSearchLanguage();
      // v3 is the current canonical product endpoint. v0/v2 still work
      // (OFF marks v2 deprecated but supported for back-compat) and the
      // local mirror at server/routes/proxy.js intercepts any /api/vN/
      // path, so on-disk mirrors keep working unchanged. Status shape
      // differs: v3 returns { status: "success" }, v2/mirror returns
      // { status: 1 } — accept both so a mirror hit and a live v3 hit
      // are treated the same.
      const url = offProductUrl(barcode, lc);
      const res = await _extFetch(url, { live });
      if (!res.ok) return null;
      const data = await res.json();
      if (!isOffSuccess(data)) return null;
      return await this._mapFullOFFProduct(data.product, barcode, { live });
    } catch(e) {
      console.error('Barcode lookup failed:', e);
      return null;
    }
  },

  // Fetch full product detail for a specific barcode from v3, used to
  // hydrate a search-a-licious hit before the user opens the add sheet.
  // search-a-licious's index deliberately omits serving_size,
  // serving_quantity, nutrition_data_per, and the _serving nutriment
  // variants (see #133 migration). Those fields matter for the Import
  // Portion As setting, alt-units convenience picker, and the cross-
  // system nutrition-basis warning. Fetching them on tap keeps the
  // search itself fast and restores full fidelity at add-time. Cached
  // in-session by barcode so a second tap on the same food doesn't
  // refetch. Returns null on error; caller falls back to the search hit.
  // LRU-capped hydrate cache. Bound prevents unbounded growth over a long
  // browsing session where a user searches OFF many times and taps many
  // unique results. Map iteration order is insertion order in JS, so
  // deleting the first key evicts the least-recently-inserted entry; each
  // hit is re-inserted so recently-used entries move to the tail.
  _offHydrateCache: new Map(),
  _OFF_HYDRATE_MAX: 200,
  async fetchProductByCode(code) {
    if (!code) return null;
    if (this._offHydrateCache.has(code)) {
      const cached = this._offHydrateCache.get(code);
      this._offHydrateCache.delete(code);
      this._offHydrateCache.set(code, cached);
      return cached;
    }
    try {
      const lc = _getOffSearchLanguage();
      const url = offProductUrl(code, lc);
      const res = await _extFetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      if (!isOffSuccess(data)) return null;
      const mapped = await this._mapFullOFFProduct(data.product, code);
      if (mapped) {
        if (this._offHydrateCache.size >= this._OFF_HYDRATE_MAX) {
          const oldest = this._offHydrateCache.keys().next().value;
          if (oldest !== undefined) this._offHydrateCache.delete(oldest);
        }
        this._offHydrateCache.set(code, mapped);
      }
      return mapped;
    } catch(e) {
      console.warn('OFF hydrate failed:', e);
      return null;
    }
  },

  async searchByName(query, page) {
    page = page || 1;
    try {
      const offUrl = _offSearchUrl(query, page, 50);
      const res = await _extFetch(offUrl);
      if (!res.ok) return [];
      const data = await res.json();
      // Read whichever envelope is present. The proxy at server/routes/proxy.js
      // may respond with `hits` (local OFF mirror) or `products` (remote v2
      // API fall-through when the mirror is off or misses). v1.1.0 shipped
      // reading `hits` only, which silently returned empty for the majority
      // of self-hosters who don't run the mirror. #133 (@JacosVerksted).
      // #192: local OFF mirror populates `data.hits`; public OFF v2
      // populates `data.products`. Feed the source hint into the
      // ranker so mirror pages don't get the photos-first tier.
      return rankOffSearch(data, p => this._mapOFFProduct(p)).items;
    } catch(e) {
      console.error('Search failed:', e);
      return [];
    }
  },

  // Same as searchByName but returns pagination metadata alongside the
  // items so the caller can drive infinite-scroll ("Load more when
  // hasMore" and "showing N of totalHits"). Kept separate from
  // searchByName so the simpler array-returning API stays intact for
  // quick-log, Trace, and MealEditor which don't need paging. #96.
  async searchByNameWithMeta(query, page, pageSize = 50) {
    page = page || 1;
    try {
      const offUrl = _offSearchUrl(query, page, pageSize);
      const res = await _extFetch(offUrl);
      if (!res.ok) return { items: [], totalHits: 0, page, hasMore: false };
      const data = await res.json();
      // Read whichever envelope is present. The proxy at server/routes/proxy.js
      // may respond with `hits` (local OFF mirror) or `products` (remote v2
      // API fall-through when the mirror is off or misses). v1.1.0 shipped
      // reading `hits` only, which silently returned empty for the majority
      // of self-hosters who don't run the mirror. #133 (@JacosVerksted).
      // #192, #213: same source hint and scores as searchByName. See off-rank.js.
      const { items, count } = rankOffSearch(data, p => this._mapOFFProduct(p));
      const totalHits = typeof data.count === 'number' ? data.count : count;
      const hasMore = page * pageSize < totalHits;
      return { items, totalHits, page, hasMore };
    } catch(e) {
      console.error('Search failed:', e);
      return { items: [], totalHits: 0, page, hasMore: false };
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
    // Only the person's own Open Food Facts login (#284). The shared
    // "nutritrace-app" login it used to fall back to is refused by OFF.
    const username = String((settings && settings.offUsername) || '').trim();
    const password = (settings && settings.offPassword) || '';
    if (!username || !password) throw new OffShareError('no_account');
    const uploadCountry = (settings && settings.offUploadCountry) || "Auto";
    const lang = (navigator.language || "en").substring(0, 2).toLowerCase();
    // If the food's portion is 100g exactly, our nutrition values are
    // per-100g and we send them as such. For any other portion size, our
    // values are per-that-portion, so we send them with nutrition_data_per
    // = serving and tell OFF the serving size.
    const portionVal = parseFloat(portion) || 0;
    const unitVal    = unit || 'g';
    const isPer100g  = portionVal === 100 && unitVal === 'g';
    const fields = {
      code: barcode, lang, app_name: 'NutriTrace',
      ['product_name_' + lang]: name,
      nutrition_data_per: isPer100g ? '100g' : 'serving',
    };
    if (brand) fields.brands = brand;
    if (!isPer100g) fields.serving_size = portionVal + " " + unitVal;
    if (uploadCountry && uploadCountry !== "Auto") fields.countries = uploadCountry;
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
        fields["nutriment_" + field] = nut[key];
    }
    // The photo goes up after the product, as a multipart POST.
    let image = imgUrl ? await this._fetchImageBlob(imgUrl) : null;
    // Over the server's 10 MB cap: the product goes without it.
    const photoTooBig = !!image && image.size > 10 * 1024 * 1024;
    if (photoTooBig) image = null;

    // The Android app with no server sends to Open Food Facts itself (it
    // allows any origin). Everything else goes through this app's server,
    // which POSTs with the login in the body and names the app.
    if (isNative && !getServerUrl()) {
      const sent = await shareWithOff({ fetchImpl: fetch, userId: username, password, fields, image });
      return photoTooBig ? { ...sent, photo: 'failed' } : sent;
    }
    const fd = new FormData();
    fd.append('user_id', username);
    fd.append('password', password);
    fd.append('fields', JSON.stringify(fields));
    if (image) fd.append('image', image, 'front.jpg');
    const headers = {};
    if (isNative) {
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    let res;
    try {
      res = await fetch(apiUrl('/api/off/contribute'), { method: 'POST', headers, body: fd, credentials: 'include', cache: 'no-store' });
    } catch {
      throw new Error('Could not reach the NutriTrace server.');
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (out.kind && out.kind !== 'off_local_only') throw new OffShareError(out.kind, out.detail || '');
      throw new Error(out.error || `API error ${res.status}`);
    }
    if (out.ok !== true) throw new OffShareError('unreachable');
    return photoTooBig ? { ...out, photo: 'failed' } : out;
  },

  // Fetch any imgUrl (relative server path, absolute URL, or data: URI)
  // as a Blob so it can be sent in the multipart OFF upload. Returns null
  // on failure — callers treat the image as optional.
  async _fetchImageBlob(imgUrl) {
    if (!imgUrl) return null;
    try {
      const res = await fetch(resolveAssetUrl(imgUrl), { credentials: 'include' });
      if (!res.ok) return null;
      const blob = await res.blob();
      return blob && blob.size && /^image\//.test(blob.type || 'image/') ? blob : null;
    } catch {
      return null;
    }
  },

  // The mapper is off-map.js's, shared with the server (#314). This adds the
  // user's settings and remembers what OFF has for the product (#241).
  _mapOFFProduct(p, { full = false } = {}) {
    const mapped = mapOffProduct(p, { lang: _getOffSearchLanguage(), importPortion: _getOffImportPortion() });
    if (!mapped) return null;
    _rememberOffInfo(mapped.barcode, {
      present: [...mapped._offPresent],
      preparedOnly: mapped._offPreparedOnly,
      prepared: mapped._offPrepared,
      full,
    });
    return mapped;
  }
};

// USDA results are re-ranked by data type (Foundation and SR Legacy first)
// with rankUsdaResults in usda-map.js, shared with the server (#314).

const USDA = {
  // Per 100 g (or 100 ml) as USDA gives it; servingSize is never a factor (#290).
  _mapProduct(item) {
    return mapUsdaFood(item);
  },

  async searchByName(query, page, apiKey) {
    page = page || 1;
    if (!apiKey) return [];
    try {
      // No dataType filter — search all (Branded, Foundation, SR Legacy, Survey)
      // matches Android app behaviour. pageSize=50 matches SparkyFitness'
      // default (USDA's own max is 200); 20 was too sparse on common queries
      // like "chicken" that have 20k+ hits. #96.
      const url = usdaSearchUrl(query, { page, pageSize: 50, apiKey });
      const res = await _extFetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      const items = (data.foods || []).map(f => this._mapProduct(f)).filter(f => f.name);
      return rankUsdaResults(items);
    } catch(e) {
      console.error('[USDA] Search failed:', e);
      return [];
    }
  },

  // Same as searchByName but returns pagination metadata for
  // infinite-scroll callers. USDA's `foods/search` returns totalHits +
  // totalPages so we can stop fetching cleanly at the tail. #96.
  async searchByNameWithMeta(query, page, apiKey, pageSize = 50) {
    page = page || 1;
    if (!apiKey) return { items: [], totalHits: 0, page, hasMore: false };
    try {
      const url = usdaSearchUrl(query, { page, pageSize, apiKey });
      const res = await _extFetch(url);
      if (!res.ok) return { items: [], totalHits: 0, page, hasMore: false };
      const data = await res.json();
      const items = (data.foods || []).map(f => this._mapProduct(f)).filter(f => f.name);
      const totalHits = typeof data.totalHits === 'number' ? data.totalHits : items.length;
      const totalPages = typeof data.totalPages === 'number' ? data.totalPages : Math.ceil(totalHits / pageSize);
      const hasMore = page < totalPages;
      return { items: rankUsdaResults(items), totalHits, page, hasMore };
    } catch(e) {
      console.error('[USDA] Search failed:', e);
      return { items: [], totalHits: 0, page, hasMore: false };
    }
  },

  async lookupBarcode(barcode, apiKey) {
    if (!apiKey || !barcode) return null;
    try {
      // Branded only (only branded products have GTINs/UPCs)
      const url = usdaBarcodeSearchUrl(barcode, apiKey);
      const res = await _extFetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const match = usdaBarcodeMatch(data.foods, barcode);
      if (!match) return null;
      return this._mapProduct(match);
    } catch(e) {
      console.error('[USDA] Barcode lookup failed:', e);
      return null;
    }
  },

  // One food by its FoodData Central id, for Refresh from USDA in the food
  // editor (#290). Returns null when USDA does not have it; throws when the
  // request fails, so the editor can tell the two apart.
  async lookupFdcId(fdcId, apiKey) {
    if (!apiKey || !fdcId) return null;
    const url = usdaFoodUrl(fdcId, apiKey);
    const res = await _extFetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('USDA ' + res.status);
    const item = await res.json();
    return item && item.fdcId ? this._mapProduct(item) : null;
  },

  // SR Legacy and Foundation search hits carry no household portions, so
  // they came in per 100 g with no "1 large" to pick (#289). Their detail
  // has them; Foods fetches it on tap, like OFF's fetchProductByCode, and
  // keeps the alt_units. LRU-capped and cached in-session by fdcId; a
  // failed request isn't cached, so the next tap tries again.
  _altUnitsCache: new Map(),
  _ALT_UNITS_CACHE_MAX: 200,
  async fetchAltUnits(fdcId, apiKey) {
    if (!fdcId || !apiKey) return null;
    if (this._altUnitsCache.has(fdcId)) {
      const cached = this._altUnitsCache.get(fdcId);
      this._altUnitsCache.delete(fdcId);
      this._altUnitsCache.set(fdcId, cached);
      return cached;
    }
    try {
      const full = await this.lookupFdcId(fdcId, apiKey);
      const altUnits = full ? full.alt_units : null;
      if (this._altUnitsCache.size >= this._ALT_UNITS_CACHE_MAX) {
        this._altUnitsCache.delete(this._altUnitsCache.keys().next().value);
      }
      this._altUnitsCache.set(fdcId, altUnits);
      return altUnits;
    } catch(e) {
      console.warn('[USDA] Portion lookup failed:', e);
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
import { mapUsdaFood, rankUsdaResults, usdaSearchUrl, usdaBarcodeSearchUrl, usdaFoodUrl, usdaBarcodeMatch } from './usda-map.js';

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

    // On the web, a request with an offline answer stops waiting for a server
    // that doesn't answer, and the answer takes over (request-deadline.js).
    const res = await fetchWithDeadline((u, i) => fetch(u, i), apiUrl(path), {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: isUpload ? body : body != null ? JSON.stringify(body) : undefined,
    }, !isNative && !isUpload ? offlineDeadlineMs(method, path) : null);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      const err = new Error(e.error || `API error ${res.status}`);
      err.status = res.status;
      // Signed out on this device (a password change elsewhere, Sign Out
      // Everywhere): to the sign-in page, saying why (lib/fresh-session.js).
      if (res.status === 401 && e.session_ended) import('./fresh-session.js').then((m) => m.endSessionHere()).catch(() => {});
      // A code (and its values) names the error, for the app to say in the person's language.
      if (typeof e.code === 'string') { err.code = e.code; if (e.params && typeof e.params === 'object') err.params = e.params; }
      throw err;
    }
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
  // #207: mark or unmark a day as fully logged. Purely a visual affordance
  // (week strip + date picker badges); no diary math depends on it.
  setDiaryCompletion(date, completed) { return this.put(`/api/diary/${date}/completion`, { completed: !!completed }); },
  // #207 (per-meal companion): mark or unmark a single meal slot on the day.
  setDiaryMealCompletion(date, slot, completed) {
    return this.put(`/api/diary/${date}/meal-completion`, { slot: Number(slot), completed: !!completed });
  },

  // Latest wellness_data row across all sources for a metric — used by
  // AddActivitySheet for MET auto-estimate weight lookup (#99). Returns
  // { date, value, source } or null.
  getLatestWellness(metric) { return this.get(`/api/wellness/latest?metric=${encodeURIComponent(metric)}`); },

  // Activity (manual exercise/calorie-burn entries)
  getActivity(date)          { return this.get(`/api/activity/${date}`); },
  getActivitySum(date, policy = 'wearable_wins') { return this.get(`/api/activity/sum/${date}?policy=${encodeURIComponent(policy)}`); },
  getActivityRange(from, to) { return this.get(`/api/activity?from=${from}&to=${to}`); },
  createActivity(data)       { return this.post('/api/activity', data); },
  updateActivity(id, data)   { return this.put(`/api/activity/${id}`, data); },
  deleteActivity(id)         { return this.del(`/api/activity/${id}`); },

  // Your own profile. Through here rather than a raw fetch, so the offline
  // layer sees it and a picture chosen with no connection is kept until
  // there is one. Same shape in LiftTrace and CookTrace.
  updateProfile(data)        { return this.put('/api/auth/profile', data); },

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
import { createOfflineApi, offlineDeadlineMs } from './offline-api.js';
import { fetchWithDeadline } from './request-deadline.js';

// The browser's API, wrapped so the diary keeps working without a connection
// (#211). Built on first use, so a page that never calls the API never opens
// IndexedDB.
let _offlineHttp = null;
const _webApi = () => (_offlineHttp ||= createOfflineApi(_NtApiHttp));

export const NtApi = new Proxy({}, {
  get(_, prop) {
    // Skip well-known thenable / meta probes. Awaiting a Proxy without
    // this returns the fallback stub for `then`, which JS tries to
    // invoke as a resolver and behavior gets weird.
    if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;

    let impl, implName;
    if (!isNative) {
      impl = _webApi();     implName = 'HTTP';       // Web PWA: server, with an offline mirror
    } else if (!getServerUrl()) {
      impl = NtApiNative;   implName = 'Native';     // Native standalone — always local
    } else {
      impl = NtApiCached;   implName = 'Cached';     // Native + server — cached/offline
    }
    const v = impl[prop];
    if (typeof v === 'function') return v.bind(impl);
    if (v !== undefined) return v;

    // The requested method isn't implemented on the current impl. Return
    // a stub that returns a rejected promise instead of undefined, so a
    // caller doing `NtApi.foo(...).catch(...)` still gets its .catch()
    // attached — a bare undefined throws SYNCHRONOUSLY at the call site,
    // which inside a Svelte reactive block aborts the update and looks
    // like the button did nothing (#162 root cause). The warn helps the
    // next divergence surface in DevTools / Diagnostic Logs.
    return function _ntApiMissing() {
      const msg = `[NtApi] '${String(prop)}' is not implemented in ${implName} mode`;
      try { console.warn(msg); } catch { /* noop */ }
      return Promise.reject(new Error(msg));
    };
  }
});
export { API, USDA };
