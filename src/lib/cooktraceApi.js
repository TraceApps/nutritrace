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
  if (!res.ok) return null;
  return res.json();
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
    })) : [];

    const totals = (recipe.nutrition && typeof recipe.nutrition === 'object')
      ? Nutrition.deriveSodiumSalt(recipe.nutrition)
      : {};

    return {
      name: recipe.name || 'Recipe',
      imgUrl: recipe.img_url || '',
      items,
      nutrition: totals,
      servings: Number.isFinite(Number(recipe.servings)) ? Number(recipe.servings) : 1,
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
