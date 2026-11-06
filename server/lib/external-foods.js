/**
 * external-foods.js: Open Food Facts and USDA FoodData Central for the MCP
 * tools search_external_foods and log_external_food (#314).
 *
 * Everything a person sees in the Foods page is reproduced here with the
 * app's own code (src/lib/off-map.js, usda-map.js): the same requests, the
 * same ranking, the same numbers, under the same settings (OFF language,
 * country and Import Portion As; USDA on and its API key). Requests go
 * through lib/external-api.js, the proxy's path: the allowed hosts only, the
 * local OFF mirror first when there is one, no network at all when the
 * server is air-gapped (OFF_LOCAL_ONLY), a timeout and a size cap.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import {
  mapOffProduct, mapFullOffProduct, rankOffSearch, offSearchUrl, offProductUrl,
  offLanguage, offCountryTag, isOffSuccess,
} from '../../src/lib/off-map.js';
import {
  mapUsdaFood, rankUsdaResults, usdaSearchUrl, usdaBarcodeSearchUrl, usdaFoodUrl,
  usdaBarcodeMatch, usdaFdcId,
} from '../../src/lib/usda-map.js';
import { fetchExternalJson, ExternalApiError, isAirGapped } from './external-api.js';
import { localizeImage } from './image-localizer.js';
import { resolveNewItemVisibility } from './default-visibility.js';

// The page the Foods page asks for and ranks (API.searchByName,
// USDA.searchByName): results are ranked within it, then cut to the limit.
const SEARCH_PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15000;
const IMAGE_TIMEOUT_MS = 10000;
// Only product photos from Open Food Facts' own image host are saved, the
// one the app's image proxy allows for them.
const IMAGE_HOSTS = ['images.openfoodfacts.org'];

export const SOURCES = ['off', 'usda'];
const SOURCE_NAMES = { off: 'Open Food Facts', usda: 'USDA FoodData Central' };

/** A tool-facing error. `code` says which: see the messages below. */
export class ExternalFoodError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── references ─────────────────────────────────────────────────────────────

const REF_RE = /^(off|usda):(\d{1,24})$/;
export const BARCODE_RE = /^\d{4,24}$/;

/**
 * An OFF code the way OFF keeps it: leading zeros dropped, then 8 digits
 * (EAN-8) or 13 (EAN-13, UPC-A with a leading 0) when shorter. Longer codes
 * stay as they are. So "00004016241040503", "4016241040503" and the like
 * all name one product.
 */
export function canonicalOffCode(code) {
  const digits = String(code || '').replace(/^0+/, '');
  if (!digits) return '';
  if (digits.length <= 8) return digits.padStart(8, '0');
  if (digits.length <= 13) return digits.padStart(13, '0');
  return digits;
}

/** 'off:<barcode>' or 'usda:<fdcId>' as { source, id }, or null. The id is
 *  canonical, so one product has one id however it was written. */
export function parseRef(ref) {
  const m = REF_RE.exec(String(ref || '').trim());
  if (!m) return null;
  const id = m[1] === 'off' ? canonicalOffCode(m[2]) : m[2].replace(/^0+/, '');
  return id ? { source: m[1], id } : null;
}

// ── the user's settings, as the app reads them ─────────────────────────────

function _setting(userId, key, fallback) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ? AND deleted_at IS NULL').get(userId, key);
  if (!row || row.value == null) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

/** The settings the Foods page searches with (stores/settings.js defaults). */
export function externalFoodSettings(userId) {
  const key = _setting(userId, 'usdaApiKey', '');
  return {
    offEnabled: !!_setting(userId, 'offEnabled', true),
    lang: offLanguage(_setting(userId, 'offSearchLanguage', 'en')),
    country: offCountryTag(_setting(userId, 'offSearchCountry', 'World')),
    importPortion: _setting(userId, 'offImportPortion', 'per100g'),
    usdaEnabled: !!_setting(userId, 'usdaEnabled', false),
    usdaKey: typeof key === 'string' ? key.trim() : '',
  };
}

function _assertUsable(source, settings) {
  if (source === 'off' && !settings.offEnabled) {
    throw new ExternalFoodError('disabled', 'Open Food Facts is turned off in Settings > Connected Services.');
  }
  if (source === 'usda' && (!settings.usdaEnabled || !settings.usdaKey)) {
    throw new ExternalFoodError('not_set_up',
      'USDA FoodData Central is not set up for this account. Turn USDA on and save a USDA API key in ' +
      'Settings > Connected Services (a free key from https://fdc.nal.usda.gov/api-key-signup).');
  }
}

// ── requests ───────────────────────────────────────────────────────────────

async function _get(source, url) {
  try {
    return await fetchExternalJson(url, { timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof ExternalApiError) {
      if (e.code === 'offline') {
        throw new ExternalFoodError('offline',
          source === 'off'
            ? 'This server only uses its local copy of Open Food Facts (OFF_LOCAL_ONLY), and it has no answer.'
            : 'This server is air-gapped (OFF_LOCAL_ONLY), so USDA FoodData Central cannot be reached.');
      }
      throw new ExternalFoodError('unreachable', `${SOURCE_NAMES[source]} could not be reached. Try again later.`);
    }
    throw e;
  }
}

function _httpError(source, status) {
  if (source === 'usda' && (status === 401 || status === 403)) {
    return new ExternalFoodError('not_set_up', 'USDA FoodData Central refused the API key saved in Settings > Connected Services.');
  }
  if (status === 429) return new ExternalFoodError('unreachable', `${SOURCE_NAMES[source]} is limiting requests right now. Try again in a minute.`);
  return new ExternalFoodError('unreachable', `${SOURCE_NAMES[source]} answered with an error (${status}). Try again later.`);
}

// ── mapping, with the extra facts a tool result shows ──────────────────────

function _mapOff(p, settings) {
  const mapped = mapOffProduct(p, { lang: settings.lang, importPortion: settings.importPortion });
  if (mapped) {
    const qty = parseFloat(p.serving_quantity);
    Object.defineProperty(mapped, '_serving', {
      value: (p.serving_size || Number.isFinite(qty)) ? {
        size: p.serving_size ? String(p.serving_size).slice(0, 100) : null,
        quantity: Number.isFinite(qty) ? qty : null,
        unit: p.serving_quantity_unit || (Number.isFinite(qty) ? 'g' : null),
      } : null,
      enumerable: false,
    });
  }
  return mapped;
}

function _mapUsda(item) {
  const mapped = mapUsdaFood(item);
  const size = Number(item.servingSize);
  Object.defineProperty(mapped, '_serving', {
    value: Number.isFinite(size) && size > 0
      ? { size: item.householdServingFullText ? String(item.householdServingFullText).slice(0, 100) : null, quantity: size, unit: item.servingSizeUnit || null }
      : null,
    enumerable: false,
  });
  Object.defineProperty(mapped, '_gtin', { value: item.gtinUpc || null, enumerable: false });
  return mapped;
}

/** A mapped food as a tool result: per portion, like search_foods. */
export function toResult(source, food) {
  const off = source === 'off';
  const id = off ? String(food.barcode || '') : usdaFdcId(food.barcode);
  const ref = id && (off ? BARCODE_RE.test(id) : /^\d{1,24}$/.test(id)) ? `${source}:${id}` : null;
  return {
    ref,
    source,
    name: food.name,
    brand: food.brand || null,
    barcode: off ? (food.barcode || null) : (food._gtin || null),
    fdc_id: off ? undefined : (id || null),
    data_type: off ? undefined : (food.dataType || null),
    portion: food.portion,
    unit: food.unit,
    nutrition_basis: food.nutrition_basis ?? null,
    serving: food._serving || null,
    alt_units: food.alt_units || null,
    nutriscore: off ? (food.nutriscore || null) : undefined,
    completeness: off ? food.completeness : undefined,
    // Which nutrients the source actually has. Anything else in `nutrition`
    // is 0 only because the source left it blank.
    nutrients_reported: [...(food._offPresent || [])],
    nutrition: food.nutrition,
  };
}

// ── search ─────────────────────────────────────────────────────────────────

async function _searchOff(settings, { query, barcode }) {
  if (barcode) {
    const food = await _lookupOff(settings, barcode);
    return food ? [food] : [];
  }
  const r = await _get('off', offSearchUrl(query, { page: 1, pageSize: SEARCH_PAGE_SIZE, country: settings.country, lang: settings.lang }));
  if (!r.ok) throw _httpError('off', r.status);
  return rankOffSearch(r.body, p => _mapOff(p, settings)).items;
}

async function _searchUsda(settings, { query, barcode }) {
  if (barcode) {
    const r = await _get('usda', usdaBarcodeSearchUrl(barcode, settings.usdaKey));
    if (!r.ok) throw _httpError('usda', r.status);
    const match = usdaBarcodeMatch(r.body?.foods, barcode);
    return match ? [_mapUsda(match)] : [];
  }
  const r = await _get('usda', usdaSearchUrl(query, { page: 1, pageSize: SEARCH_PAGE_SIZE, apiKey: settings.usdaKey }));
  if (!r.ok) throw _httpError('usda', r.status);
  return rankUsdaResults((Array.isArray(r.body?.foods) ? r.body.foods : []).filter(f => f && typeof f === 'object').map(_mapUsda).filter(f => f.name));
}

/**
 * Search one or both sources by name or barcode. Each source answers or
 * says why not; the caller turns "none answered" into a tool error.
 */
export async function searchExternalFoods(userId, { query, barcode, source = 'all', limit = 10 }) {
  const settings = externalFoodSettings(userId);
  const wanted = source === 'all' ? SOURCES : [source];
  const results = await Promise.all(wanted.map(async (src) => {
    try {
      // With both sources asked for, one that is off or not set up is only
      // a note; asked for by name, it is the answer.
      _assertUsable(src, settings);
      const foods = src === 'off'
        ? await _searchOff(settings, { query, barcode })
        : await _searchUsda(settings, { query, barcode });
      const items = foods.slice(0, limit).map(f => toResult(src, f));
      return { source: src, status: items.length ? 'ok' : 'no_match', count: items.length, items };
    } catch (e) {
      // A reply shaped in a way the mappers can't read is that source's
      // problem only; the other source still answers.
      const err = e instanceof ExternalFoodError
        ? e
        : new ExternalFoodError('bad_response', `${SOURCE_NAMES[src]} sent an answer NutriTrace could not read.`);
      return { source: src, status: err.code, count: 0, message: err.message, items: [] };
    }
  }));
  return {
    sources: results.map(({ items, ...s }) => s),
    items: results.flatMap(r => r.items),
  };
}

// ── one product, for logging ───────────────────────────────────────────────

async function _lookupOff(settings, code) {
  const r = await _get('off', offProductUrl(code, settings.lang));
  // OFF answers a barcode it doesn't have with 404 (and the app treats any
  // failed lookup as "not found"); anything else that fails is an error.
  if (r.status === 404) return null;
  if (!r.ok) throw _httpError('off', r.status);
  if (!isOffSuccess(r.body) || !r.body.product) return null;
  return mapFullOffProduct(r.body.product, code, {
    map: (p) => _mapOff(p, settings),
    fetchJson: async (url) => {
      const s = await _get('off', url);
      return s.ok ? s.body : null;
    },
  });
}

async function _lookupUsda(settings, fdcId) {
  const r = await _get('usda', usdaFoodUrl(fdcId, settings.usdaKey));
  if (r.status === 404) return null;
  if (!r.ok) throw _httpError('usda', r.status);
  if (!r.body || !r.body.fdcId) return null;
  const food = _mapUsda(r.body);
  return food.name ? food : null;
}

/** The product a reference names, read fresh from its source (or the OFF
 *  mirror), as the app maps it. Throws ExternalFoodError. */
export async function fetchExternalProduct(userId, { source, id }) {
  const settings = externalFoodSettings(userId);
  _assertUsable(source, settings);
  const food = source === 'off' ? await _lookupOff(settings, id) : await _lookupUsda(settings, id);
  if (!food) throw new ExternalFoodError('not_found', `${SOURCE_NAMES[source]} has no product ${source}:${id}.`);
  return food;
}

// ── the catalog food for a product ─────────────────────────────────────────

/** The barcodes a saved OFF product may carry: OFF's own form and the
 *  12-digit UPC-A / 8-digit forms of the same code. `codes` are canonical. */
function _offBarcodes(...codes) {
  const out = new Set();
  for (const c of codes) {
    if (!c) continue;
    out.add(c);
    const bare = c.replace(/^0+/, '');
    if (bare) {
      out.add(bare);
      if (bare.length <= 12) out.add(bare.padStart(12, '0'));
    }
  }
  return [...out];
}

/** How the app saves the product as a barcode: OFF's code, or fdcId_<id>. */
function _barcodesFor({ source, id }, extra = null) {
  return source === 'off' ? _offBarcodes(id, extra) : [`fdcId_${id}`];
}

/**
 * The user's catalog food for a product, or null. First one this tool made
 * (source_app + source_external_id), then one the user saved in the app:
 * the app saves an OFF product under its barcode and a USDA one as
 * fdcId_<id>, and adds nothing else that says where it came from.
 */
export function findCatalogFood(userId, ref, extraCode = null) {
  const bySource = db.prepare(
    `SELECT * FROM foods WHERE user_id = ? AND source_app = ? AND source_external_id = ? AND deleted_at IS NULL`
  ).get(userId, ref.source, ref.id);
  if (bySource) return { food: bySource, matched_by: 'source' };
  const codes = _barcodesFor(ref, extraCode);
  const byBarcode = db.prepare(
    `SELECT * FROM foods WHERE user_id = ? AND deleted_at IS NULL AND barcode IN (${codes.map(() => '?').join(',')})
      ORDER BY id ASC LIMIT 1`
  ).get(userId, ...codes);
  if (byBarcode) return { food: byBarcode, matched_by: 'barcode' };
  return null;
}

function _sourceUrl({ source, id }) {
  return source === 'off'
    ? `https://world.openfoodfacts.org/product/${id}`
    : `https://fdc.nal.usda.gov/food-details/${id}/nutrients`;
}

// Tests swap in a stand-in so they never download a photo.
let _localize = localizeImage;
export function _setLocalizeForTests(fn) { _localize = fn || localizeImage; }

// The product photo, saved under /uploads/ the way the app saves one when a
// food is added (routes/foods.js, localizeImage), never on an air-gapped
// server and only from OFF's image host. Null when there is none.
async function _productImage(url) {
  if (!url || isAirGapped()) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || !IMAGE_HOSTS.includes(parsed.hostname)) return null;
  const local = await _localize(url, { timeoutMs: IMAGE_TIMEOUT_MS });
  return local && local.startsWith('/uploads/') ? local : null;
}

function _dropUpload(localPath) {
  if (!localPath || !localPath.startsWith('/uploads/')) return;
  const dir = process.env.UPLOADS_PATH || './uploads';
  try { fs.unlinkSync(path.join(dir, path.basename(localPath))); } catch { /* already gone */ }
}

const _insertOnce = db.transaction((userId, ref, food, imgUrl) => {
  // Checked again here, in one transaction with the insert: two logs of the
  // same product at once still make one food. The code OFF answered with
  // counts too.
  const again = findCatalogFood(userId, ref, food.barcode ? String(food.barcode) : null);
  if (again) return { ...again, created: false };
  // A deleted food from the same source still holds its place in the
  // unique (user, source_app, source_external_id) index; it lets go, as
  // routes/foods.js does for a CookTrace item deleted and added again.
  db.prepare(`UPDATE foods SET source_app = NULL, source_external_id = NULL
               WHERE user_id = ? AND source_app = ? AND source_external_id = ? AND deleted_at IS NOT NULL`)
    .run(userId, ref.source, ref.id);
  const alt = Array.isArray(food.alt_units) && food.alt_units.length ? JSON.stringify(food.alt_units) : null;
  const result = db.prepare(
    `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, img_url, notes, category, barcode, visibility,
                        nutrition_basis, alt_units, density_g_ml, source_app, source_external_id, source_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, datetime('now'))`
  ).run(
    userId, food.name, food.brand || null, JSON.stringify(food.nutrition || {}),
    food.portion ?? 100, food.unit || 'g', imgUrl, food.barcode || null,
    resolveNewItemVisibility(userId), food.nutrition_basis || null, alt,
    ref.source, ref.id, _sourceUrl(ref),
  );
  return {
    food: db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid),
    matched_by: null,
    created: true,
  };
});

/**
 * The catalog food for a product: the user's own when they have it,
 * otherwise made once from the source's current data. A product the user
 * already has is never fetched again, so its diary entries and its food stay
 * as they were whatever the source says now.
 *
 * `beforeCreate(product)` may throw to stop before anything is saved.
 */
export async function ensureCatalogFood(userId, ref, { beforeCreate } = {}) {
  const have = findCatalogFood(userId, ref);
  if (have) return { ...have, created: false };
  const product = await fetchExternalProduct(userId, ref);
  // #241: OFF's mapper turns a missing value into 0. A product with no
  // calories from its source would log as 0 kcal; the app sends such a
  // product to the food editor instead, so the person can choose.
  if (!product._offPresent?.includes('calories')) {
    throw new ExternalFoodError('no_nutrition',
      `${SOURCE_NAMES[ref.source]} has no calories for ${product.name} (${ref.source}:${ref.id}), so it would log as 0 kcal. ` +
      'Add it in the NutriTrace app, where its values can be checked or filled in, then log it with log_food.');
  }
  // Saved under the code OFF answered with, as the app saves it, when that
  // is a plain code; otherwise under the one asked for.
  if (ref.source === 'off') {
    const answered = BARCODE_RE.test(String(product.barcode || '')) ? String(product.barcode) : '';
    product.barcode = answered || ref.id;
  }
  if (beforeCreate) beforeCreate(product);
  const imgUrl = await _productImage(product.imgUrl);
  let out;
  try {
    out = _insertOnce(userId, ref, product, imgUrl);
  } catch (e) {
    _dropUpload(imgUrl);
    throw e;
  }
  if (!out.created) _dropUpload(imgUrl);
  return out;
}
