/**
 * cooktraceApi.js: CookTrace federation client for NutriTrace.
 *
 * Mirrors mealieApi.js: server-side proxy through /api/cooktrace/proxy
 * (CORS + bearer token stays off the WebView), settings live in
 * `cooktraceBaseUrl`, `cooktraceApiToken`, `cooktraceEnabled`.
 *
 * Wire contract (CT side): GET /api/v1/recipes for list/search,
 * GET /api/v1/recipes/:id for the full recipe. See
 * docs/cooktrace/nt-federation.md for the full shape.
 */
import { DB } from './db.js';
import { apiUrl, isNative, getServerUrl, getAuthToken } from './platform.js';
import { Nutrition } from './nutrition.js';

function _cfg() {
  const baseUrl = (DB.getSetting('cooktraceBaseUrl', '') || '').replace(/\/$/, '');
  const token   = DB.getSetting('cooktraceApiToken', '') || '';
  return { baseUrl, token };
}

async function _proxy(path, method = 'GET') {
  const raw = await _proxyRaw(path, method);
  return raw?.ok ? raw.body : null;
}

// Raw proxy for callers that need to distinguish 404 (upstream row was
// deleted) from transient network / auth errors (503, timeouts, etc).
// Returns { ok, status, body } or null when the connection is not
// configured. status mirrors the upstream CT status code so a 404 lets
// the MealEditor's "source deleted" indicator light up.
async function _proxyRaw(path, method = 'GET') {
  const { baseUrl, token } = _cfg();
  if (!baseUrl || !token) return null;
  const csrf = !isNative ? localStorage.getItem('nt:csrf') : null;
  const res = await fetch(apiUrl('/api/cooktrace/proxy'), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(isNative && getServerUrl() && getAuthToken() ? { 'Authorization': `Bearer ${getAuthToken()}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify({ baseUrl, token, path, method }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

const CookTrace = {
  isConfigured() {
    const { baseUrl, token } = _cfg();
    return !!(baseUrl && token);
  },

  /**
   * Text-search recipes. Returns raw items[] the way CT's
   * /api/v1/recipes list endpoint returns them (id, name, img_url,
   * servings, portion, unit, nutrition, source_url, updated_at).
   */
  async search(query, limit = 25) {
    if (!query) return [];
    try {
      const p = `/api/v1/recipes?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`;
      const data = await _proxy(p);
      return data?.items || [];
    } catch (e) {
      console.error('[CookTrace] search failed:', e);
      return [];
    }
  },

  /**
   * Paginated search with metadata for infinite-scroll callers, same
   * envelope shape Foods.svelte expects for OFF / USDA / Mealie.
   */
  async searchWithMeta(query, page = 1, perPage = 10) {
    if (!query) return { items: [], totalHits: 0, page, hasMore: false };
    try {
      const offset = Math.max(0, (page - 1) * perPage);
      const p = `/api/v1/recipes?q=${encodeURIComponent(query)}&limit=${perPage}&offset=${offset}`;
      const data = await _proxy(p);
      const items = data?.items || [];
      const totalHits = typeof data?.total === 'number' ? data.total : items.length;
      const hasMore = offset + items.length < totalHits;
      return { items, totalHits, page, hasMore };
    } catch (e) {
      console.error('[CookTrace] search failed:', e);
      return { items: [], totalHits: 0, page, hasMore: false };
    }
  },

  /** Full recipe by numeric id, with flattened items[] and per-item nutrition. */
  async getRecipe(id) {
    if (id == null) return null;
    try {
      return await _proxy(`/api/v1/recipes/${encodeURIComponent(id)}`);
    } catch (e) {
      console.error('[CookTrace] getRecipe failed:', e);
      return null;
    }
  },

  /**
   * Probe a CT recipe's existence without returning the full body. Used
   * by the MealEditor's "source deleted" indicator to distinguish an
   * upstream 404 (recipe was deleted or user lost read access) from a
   * transient network / auth blip. Returns:
   *   'exists'  - HTTP 200
   *   'deleted' - HTTP 404
   *   'unknown' - anything else (offline, 401, 500, etc)
   */
  async probeRecipeStatus(id) {
    if (id == null) return 'unknown';
    try {
      const raw = await _proxyRaw(`/api/v1/recipes/${encodeURIComponent(id)}`);
      if (!raw) return 'unknown';
      if (raw.ok) return 'exists';
      if (raw.status === 404) return 'deleted';
      return 'unknown';
    } catch { return 'unknown'; }
  },

  /**
   * List all pantry items on the CT side, shaped for direct POST to
   * NutriTrace's /api/foods endpoint. Skips generic parents that have
   * variants (only leaves ship). Returns:
   *   { ok: true, items: [...] }              (success, may be empty)
   *   { ok: false, reason: 'not_configured' } (no URL/token saved)
   *   { ok: false, reason: 'scope' }          (token lacks read:pantry)
   *   { ok: false, reason: 'not_found' }      (CT server has no /api/v1/pantry: not upgraded)
   *   { ok: false, reason: 'auth' }           (token invalid)
   *   { ok: false, reason: 'network', status } (anything else)
   * Distinguishing these lets the caller show a specific error instead
   * of the misleading "no pantry items found" success toast.
   */
  /**
   * Paginated pantry search for the Foods-tab CookTrace source chip.
   * Same envelope shape Foods.svelte expects from OFF / USDA / Mealie so
   * it drops into the existing search plumbing unchanged. Returns leaves
   * only (generic parents with variants are filtered server-side), and
   * CT matches against the composed "Parent, Child" name so a variant
   * stays findable by its generic's word.
   */
  async searchPantryWithMeta(query, page = 1, perPage = 10) {
    if (!query) return { items: [], totalHits: 0, page, hasMore: false };
    try {
      const offset = Math.max(0, (page - 1) * perPage);
      const p = `/api/v1/pantry?q=${encodeURIComponent(query)}&limit=${perPage}&offset=${offset}`;
      const data = await _proxy(p);
      const items = data?.items || [];
      const totalHits = typeof data?.total === 'number' ? data.total : items.length;
      return { items, totalHits, page, hasMore: offset + items.length < totalHits };
    } catch (e) {
      console.error('[CookTrace] pantry search failed:', e);
      return { items: [], totalHits: 0, page, hasMore: false };
    }
  },

  async listPantry() {
    const { baseUrl, token } = _cfg();
    if (!baseUrl || !token) return { ok: false, reason: 'not_configured' };
    try {
      const raw = await _proxyRaw('/api/v1/pantry');
      if (!raw) return { ok: false, reason: 'not_configured' };
      if (raw.ok) {
        const items = Array.isArray(raw.body?.items) ? raw.body.items : [];
        return { ok: true, items };
      }
      if (raw.status === 403) return { ok: false, reason: 'scope' };
      if (raw.status === 404) return { ok: false, reason: 'not_found' };
      if (raw.status === 401) return { ok: false, reason: 'auth' };
      return { ok: false, reason: 'network', status: raw.status };
    } catch (e) {
      console.error('[CookTrace] listPantry failed:', e);
      return { ok: false, reason: 'network', status: 0 };
    }
  },

  /**
   * Server-verified connection test. Hits /api/v1/me so it validates the
   * bearer token AND the URL in one round trip, and echoes back the
   * signed-in username so the Settings UI can show "Connected as X".
   */
  async testConnection() {
    try {
      const data = await _proxy('/api/v1/me');
      if (!data || !data.user) return { ok: false, error: 'Empty response' };
      const scopes = Array.isArray(data.scopes) ? data.scopes : [];
      if (!scopes.includes('read:recipes')) {
        return { ok: false, error: 'Token is valid but missing the read:recipes scope. Mint a new token on CookTrace with that scope ticked.' };
      }
      return { ok: true, username: data.user.username, instance: data.instance };
    } catch (e) {
      return { ok: false, error: e.message || 'Connection failed' };
    }
  },

  /**
   * Turn a full CT recipe into an NT meal prefill (is_recipe=1).
   * Items[] land as NT MealEditor ingredient rows with per-item
   * nutrition; the recipe's rollup nutrition rides on the meal
   * itself and is what the MealEditor's totals-strip will show
   * before the user hits Recompute inside NT.
   *
   * source_app / source_external_id / source_url stamp provenance
   * so the MealEditor's "From CookTrace" badge lights up and the
   * meal upserts on a future re-import (partial unique index on
   * meals(user_id, source_app, source_external_id)).
   */
  mapRecipe(recipe) {
    if (!recipe) return null;
    const items = Array.isArray(recipe.items) ? recipe.items.map(it => ({
      name: String(it?.name || '').slice(0, 200),
      brand: it?.brand ? String(it.brand).slice(0, 120) : '',
      // Preserve CT's exact unit (empty string when the ingredient has
      // no unit, e.g. "4 egg yolks"). Do NOT default to 'g' or NT will
      // render "4 g" for countable ingredients.
      portion: Number.isFinite(Number(it?.portion)) ? Number(it.portion) : 1,
      unit: it?.unit != null ? String(it.unit).slice(0, 16) : '',
      quantity: Number.isFinite(Number(it?.quantity)) ? Number(it.quantity) : 1,
      nutrition: (it?.nutrition && typeof it.nutrition === 'object') ? Nutrition.deriveSodiumSalt(it.nutrition) : {},
      ...(it?.barcode ? { barcode: String(it.barcode) } : {}),
      // MealEditor's ingredient rows render `item.imgUrl`; CT ships the
      // linked pantry row's photo as `img_url`. Without this mapping every
      // imported ingredient falls back to the grey placeholder icon.
      ...(it?.img_url ? { imgUrl: String(it.img_url) } : {}),
    })) : [];

    // CT stores recipe.nutrition as PER-SERVING values (that's what its
    // own Recompute engine writes). NT's MealEditor expects meal.nutrition
    // to be WHOLE-RECIPE totals and divides by servings on save. Multiply
    // through here so the shape matches NT's convention; the editor's own
    // per-serving math then produces the same numbers CT showed.
    const servingsN = Number.isFinite(Number(recipe.servings)) ? Number(recipe.servings) : 1;
    const perServing = (recipe.nutrition && typeof recipe.nutrition === 'object')
      ? Nutrition.deriveSodiumSalt(recipe.nutrition)
      : {};
    const totals = Object.fromEntries(
      Object.entries(perServing).map(([k, v]) => [k, (parseFloat(v) || 0) * servingsN])
    );

    return {
      name: recipe.name || 'Recipe',
      imgUrl: recipe.img_url || '',
      items,
      nutrition: totals,
      servings: servingsN,
      portion: Number.isFinite(Number(recipe.portion)) ? Number(recipe.portion) : null,
      unit: recipe.unit || 'g',
      source_app: 'cooktrace',
      source_external_id: `recipe:${recipe.id}`,
      source_url: recipe.source_url || null,
      _source: 'cooktrace',
    };
  },
};

export { CookTrace };
