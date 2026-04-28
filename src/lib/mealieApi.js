/**
 * mealieApi.js — Mealie self-hosted recipe manager integration
 * Docs: https://docs.mealie.io/documentation/getting-started/api-usage/
 * Auth: Bearer token created at /user/profile/api-tokens in Mealie UI
 *
 * All requests are proxied through /api/mealie/proxy to avoid CORS.
 */
import { DB } from './db.js';
import { apiUrl, isNative, getServerUrl, getAuthToken } from './platform.js';
import { Nutrition } from './nutrition.js';

function _cfg() {
  const baseUrl = (DB.getSetting('mealieBaseUrl', '') || '').replace(/\/$/, '');
  const token   = DB.getSetting('mealieApiToken', '') || '';
  return { baseUrl, token };
}

async function _proxy(path) {
  const { baseUrl, token } = _cfg();
  if (!baseUrl || !token) return null;
  const csrf = !isNative ? localStorage.getItem('nt:csrf') : null;
  const res = await fetch(apiUrl('/api/mealie/proxy'), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(isNative && getServerUrl() && getAuthToken() ? { 'Authorization': `Bearer ${getAuthToken()}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify({ baseUrl, token, path }),
  });
  if (!res.ok) return null;
  return res.json();
}

const Mealie = {
  isConfigured() {
    const { baseUrl, token } = _cfg();
    return !!(baseUrl && token);
  },

  /** Search recipes by name. Returns list of recipe summaries. */
  async search(query, page = 1) {
    if (!query) return [];
    try {
      const filter = `name LIKE "%${query}%"`;
      const data = await _proxy(`/api/recipes?queryFilter=${encodeURIComponent(filter)}&perPage=10&page=${page}`);
      return data?.items || [];
    } catch(e) {
      console.error('[Mealie] search failed:', e);
      return [];
    }
  },

  /** Get full recipe details by slug, including nutrition. */
  async getRecipe(slug) {
    if (!slug) return null;
    try {
      return await _proxy(`/api/recipes/${slug}`);
    } catch(e) {
      console.error('[Mealie] getRecipe failed:', e);
      return null;
    }
  },

  /** Test the connection — returns true if the server can reach Mealie. */
  async testConnection() {
    try {
      const data = await _proxy('/api/recipes?perPage=1&page=1');
      return data != null;
    } catch {
      return false;
    }
  },

  /** Build the full image URL for a recipe (loaded directly by the browser — no CORS issue for <img>). */
  imageUrl(recipeId) {
    const { baseUrl } = _cfg();
    if (!baseUrl || !recipeId) return '';
    return `${baseUrl}/api/media/recipes/${recipeId}/images/original.webp`;
  },

  /**
   * Map a full Mealie recipe object to the app's food structure.
   * Nutrition is per-serving; portion=100, unit='serving' so diary qty = servings.
   */
  mapRecipe(recipe) {
    const { baseUrl } = _cfg();
    const n = recipe.nutrition || {};
    const pf = v => parseFloat(v) || 0;

    let brand = '';
    if (recipe.orgURL) {
      try { brand = new URL(recipe.orgURL).hostname.replace(/^www\./, ''); } catch {}
    }

    return {
      name:      recipe.name || 'Unnamed Recipe',
      brand,
      portion:   100,
      unit:      'serving',
      quantity:  1,
      imgUrl:    recipe.id ? `${baseUrl}/api/media/recipes/${recipe.id}/images/original.webp` : '',
      dateTime:  new Date().toISOString(),
      categories: [],
      _source:   'mealie',
      _mealieSlug: recipe.slug,
      nutrition: Nutrition.deriveSodiumSalt({
        calories:        pf(n.calories),
        proteins:        pf(n.proteinContent),
        carbohydrates:   pf(n.carbohydrateContent),
        fat:             pf(n.fatContent),
        'saturated-fat': pf(n.saturatedFatContent),
        fiber:           pf(n.fiberContent),
        sugars:          pf(n.sugarContent),
        sodium:          pf(n.sodiumContent),
        cholesterol:     pf(n.cholesterolContent),
        'trans-fat':     pf(n.transFatContent),
      }),
    };
  },
};

export { Mealie };
