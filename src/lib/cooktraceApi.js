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
  // Seconds CookTrace asks to wait after a 429 (its per-token rate limit).
  const raw = res.headers?.get?.('Retry-After');
  const ra = raw == null || raw === '' ? NaN : Number(raw);
  return { ok: res.ok, status: res.status, body, retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : null };
}

// An item CookTrace couldn't scale (a pinch against values per 100 g)
// carries the values for its pantry serving. Show it at that serving so
// the row's values match its amount and Edit rescales from there, and
// keep CookTrace's amount to say what couldn't be converted (#296).
function _ctUnscaled(it, item) {
  const b = it?.basis;
  if (it?.scaled !== false || !b || !(Number(b.amount) > 0) || !b.unit) return item;
  const amount = typeof it.amount_text === 'string' ? it.amount_text
    : it.qty_text ? String(it.qty_text) : `${item.portion} ${item.unit}`.trim();
  return { ...item, portion: Number(b.amount), unit: String(b.unit).slice(0, 16), quantity: 1, ct_amount: amount.slice(0, 60) };
}

/**
 * Run one CookTrace request, waiting out its rate limit (#330). CookTrace
 * allows each token so many requests a minute (60 unless its admin changed
 * API_RATE_LIMIT_PER_MIN) and answers 429 with Retry-After past that. Waits
 * that long plus a second (30s if it doesn't say, at most 2 minutes), then
 * asks again; after `maxWaits` waits in a row it returns the 429.
 * `onWait(secondsLeft)` counts down while waiting, then gets 0. The wait
 * ends at a set time, not after so many 1-second timers: a hidden tab or a
 * locked phone runs timers late, which would stretch every wait.
 * A request that throws (the server can't be reached) answers status 0.
 */
export async function withRateLimitWait(call, {
  onWait = () => {}, maxWaits = 5,
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(),
} = {}) {
  for (let waits = 0; ; waits++) {
    let r;
    try { r = await call(); } catch { r = { ok: false, status: 0, body: null, retryAfter: null }; }
    if (r?.status !== 429 || waits >= maxWaits) return r;
    const secs = Math.min(120, Math.max(1, Math.ceil(r.retryAfter ?? 30)) + 1);
    const until = now() + secs * 1000;
    for (let left = until - now(); left > 0; left = until - now()) {
      onWait(Math.ceil(left / 1000));
      await sleep(Math.min(1000, left));
    }
    onWait(0);
  }
}

/**
 * Every recipe id in the catalog, a page at a time up to the total CookTrace
 * reports, each request through `paced` (withRateLimitWait). A page that
 * can't be read ends it: { ok: false, failed } (the answer), so the import
 * says why instead of importing part of the catalog. Ids are kept once each:
 * a recipe edited while the list is read moves to the front and can show up
 * on two pages.
 */
export async function listAllRecipeIds(paced, { page = 50, cap = 10000 } = {}) {
  const ids = [];
  for (let offset = 0; ; ) {
    const r = await paced(() => CookTrace.listRecipesRaw(offset, page));
    if (!r?.ok) return { ok: false, failed: r, ids: [] };
    const items = Array.isArray(r.body?.items) ? r.body.items : [];
    for (const it of items) if (it?.id != null) ids.push(it.id);
    offset += items.length;
    const total = Number(r.body?.total);
    if (items.length === 0 || !(offset < total) || offset >= cap) break;
  }
  return { ok: true, ids: [...new Set(ids)] };
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
   * An empty query returns nothing (Import All Recipes lists the catalog
   * with listRecipesRaw).
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

  /**
   * For long jobs (Import All Recipes, #330): one request, answered as
   * { ok, status, body, retryAfter }, or null when not configured. A 429
   * means CookTrace's rate limit; `retryAfter` says how long to wait.
   */
  async listRecipesRaw(offset = 0, limit = 50) {
    return _proxyRaw(`/api/v1/recipes?q=&limit=${limit}&offset=${offset}`);
  },
  async getRecipeRaw(id) {
    return _proxyRaw(`/api/v1/recipes/${encodeURIComponent(id)}`);
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
    const items = Array.isArray(recipe.items) ? recipe.items.map(it => _ctUnscaled(it, {
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
      // CookTrace scales each item's values to its amount and says so
      // (#296). Older CookTrace servers send neither field.
      ...(typeof it?.scaled === 'boolean' ? { ct_scaled: it.scaled } : {}),
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
