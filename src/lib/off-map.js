/**
 * off-map.js: Open Food Facts requests and products, as NutriTrace reads them.
 *
 * Shared by the app (api.js) and the server's MCP tools (#314), so a product
 * searched or logged by an AI assistant gets the same name, ranking and
 * numbers as the same product picked in the Foods page. Nothing here touches
 * storage or the network: the caller passes the user's settings in and does
 * the fetching.
 */
import { offProductName } from './off-name.js';
import { rankOFFResults } from './off-rank.js';
import { asSoldNutriments } from './off-nutrition-sets.js';
import { Nutrition } from './nutrition.js';

export const OFF_BASE = 'https://world.openfoodfacts.org';
export const OFF_SEARCH_BASE = 'https://search.openfoodfacts.org/search';

// OFF nutriment keys behind each NutriTrace nutrient, with the factor that
// turns OFF's unit into ours (g to mg is 1000, g to mcg 1000000). Calories
// are handled separately (kcal, or kJ / 4.184).
export const OFF_NUTRIENTS = [
  ['kilojoules', 'energy'],
  ['fat', 'fat'],
  ['saturated-fat', 'saturated-fat'],
  ['trans-fat', 'trans-fat'],
  ['polyunsaturated-fat', 'polyunsaturated-fat'],
  ['monounsaturated-fat', 'monounsaturated-fat'],
  ['carbohydrates', 'carbohydrates'],
  ['sugars', 'sugars'],
  ['added-sugars', 'added-sugars'],
  ['fiber', 'fiber'],
  ['proteins', 'proteins'],
  ['salt', 'salt'],
  ['sodium', 'sodium', 1000],
  ['potassium', 'potassium', 1000],
  ['cholesterol', 'cholesterol', 1000],
  ['caffeine', 'caffeine', 1000],
  ['alcohol', 'alcohol'],
  ['calcium', 'calcium', 1000],
  ['iron', 'iron', 1000],
  ['magnesium', 'magnesium', 1000],
  ['vitamin-c', 'vitamin-c', 1000],
  ['vitamin-a', 'vitamin-a', 1000000],
  ['vitamin-d', 'vitamin-d', 1000000],
  ['vitamin-e', 'vitamin-e', 1000],
  ['vitamin-k', 'vitamin-k', 1000000],
  ['b1', 'vitamin-b1', 1000],
  ['b2', 'vitamin-b2', 1000],
  ['b3', 'vitamin-b3', 1000],
  ['b6', 'vitamin-b6', 1000],
  ['b9', 'vitamin-b9', 1000000],
  ['b12', 'vitamin-b12', 1000000],
  ['zinc', 'zinc', 1000],
  ['phosphorus', 'phosphorus', 1000],
  ['starch', 'starch'],
  ['b5', 'pantothenic-acid', 1000],
  ['iodine', 'iodine', 1000000],
  ['selenium', 'selenium', 1000000],
  ['copper', 'copper', 1000],
  ['manganese', 'manganese', 1000],
  ['choline', 'choline', 1000],
];

/** The OFF language setting as a two-letter code; 'en' when unset. */
export function offLanguage(lang) {
  if (!lang || typeof lang !== 'string') return 'en';
  return lang.slice(0, 2).toLowerCase();
}

/** The OFF country setting as a countries_tags value (`en:norway`), or null
 *  for 'World' or nothing. */
export function offCountryTag(country) {
  if (!country || typeof country !== 'string' || country === 'World') return null;
  const slug = country.toLowerCase().replace(/\s+/g, '-');
  return slug.startsWith('en:') ? slug : `en:${slug}`;
}

// Escape user-typed query text for search-a-licious. Lucene reserves
// `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /` and interpreting them as
// query operators on raw user input can 500 the request (e.g. a user
// typing "Ben & Jerry's" or "M&M's" would trip the parser). Backslash-
// prefixing each reserved char (including `"`) keeps user intent intact
// and prevents an unbalanced quote inside user text from closing the
// country-filter quoted-term appended later in the query builder.
export function luceneEscape(s) {
  return String(s || '')
    .replace(/[+\-!(){}\[\]^"~*?:\\\/]/g, '\\$&')
    .replace(/&&/g, '\\&\\&')
    .replace(/\|\|/g, '\\|\\|');
}

/** The `langs=` value for a search: the user's language, then English. */
export function offSearchLangs(lang) {
  const l = offLanguage(lang);
  return l === 'en' ? 'en' : `${l},en`;
}

// Build the search-a-licious URL. OFF's canonical text-search endpoint,
// backed by ElasticSearch. Supports typo tolerance, fuzzy matching, and
// multilingual analysis vs the deprecated v2 API's substring MongoDB
// query. Country filter goes inline into `q` as Lucene syntax rather
// than a separate query param (v2's `countries_tags=` is a no-op here).
// Language filter uses `langs=` (v2 used `lc=`, ignored by search-a-licious).
// `country` is a countries_tags value (offCountryTag), `lang` a two-letter code.
// English rides along with any other language (#320): a product whose name is
// only in English is still found, and langs=uk alone returned nothing at all
// on OFF's production index in 2026-11.
export function offSearchUrl(query, { page = 1, pageSize = 50, country = null, lang = 'en' } = {}) {
  const escaped  = luceneEscape(query);
  const qWithFilter = country
    ? `${escaped} +countries_tags:"${country}"`
    : escaped;
  const params = new URLSearchParams({
    q: qWithFilter,
    page_size: String(pageSize),
    page: String(page),
    langs: offSearchLangs(lang),
  });
  return `${OFF_SEARCH_BASE}?${params.toString()}`;
}

/** The v3 product read the app uses for a barcode. */
export function offProductUrl(code, lang = 'en') {
  return `${OFF_BASE}/api/v3/product/${code}?lc=${encodeURIComponent(lang)}`;
}

/** The v3.5 read that carries a product's nutrition sets (#241). */
export function offNutritionSetsUrl(code) {
  return `${OFF_BASE}/api/v3.5/product/${code}?fields=nutrition`;
}

// Accept every "product was found" flavor OFF returns across API generations
// and mirror paths:
//   v3 live: { status: "success" }
//   v3 live with data warnings: { status: "success_with_warnings" }
//   v3 live with recoverable errors on some fields: { status: "success_with_errors" }
//   v2 live + local OFF mirror: { status: 1 }
// Falling back to a truthy `product` object handles any future envelope
// wording change without a false-negative on real hits. Only outright
// "no product" replies (status: "failure" / status: 0, or missing product
// object) drop through as null.
export function isOffSuccess(data) {
  if (!data) return false;
  const s = data.status;
  if (s === 1) return true;
  if (typeof s === 'string' && s.startsWith('success')) return true;
  return !!data.product;
}

/**
 * One OFF product (v3 product, search hit or mirror row) as a NutriTrace
 * food, or null when it has no usable name. Like the app always has, it
 * carries non-enumerable `_offPresent` (the nutrients OFF actually has),
 * `_offPreparedOnly` and `_offPrepared` (#241).
 *
 * @param {object} p
 * @param {{ lang?: string, importPortion?: string }} opts the user's OFF
 *   language (two letters) and Import Portion As setting ('per100g' or
 *   'perServing').
 */
export function mapOffProduct(p, { lang = 'en', importPortion = 'per100g' } = {}) {
  // #238: product_name is blank on products whose main language has no
  // name, even when other languages do. See off-name.js for the order.
  const name = offProductName(p, lang);
  if (!p || !name) return null;
  const n = p.nutriments || {};
  // Per-serving import: enabled by the user via Settings → Connected Services →
  // Open Food Facts → Import Portion As, and only when the product actually
  // exposes serving_quantity + at least one *_serving nutriment. Otherwise the
  // 100g path is used unchanged.
  const servingQty = parseFloat(p.serving_quantity);
  const useServing = importPortion === 'perServing'
    && Number.isFinite(servingQty) && servingQty > 0
    && (n['energy-kcal_serving'] != null || n.energy_serving != null);
  const suffix = useServing ? '_serving' : '_100g';
  const portion = useServing ? servingQty : 100;
  const unit    = useServing ? (p.serving_quantity_unit || 'g') : 'g';
  const g = (baseKey, mult) => {
    // Skip values OFF flags as "approximately/estimated" via the _modifier
    // field. These don't appear on the product label table and are usually
    // OFF-generated estimates from similar products or contributor guesses
    // (saturated fat, fiber, added sugars often have this). Importing them
    // as if they were measured values misled users into thinking a product
    // had verified data when OFF itself doesn't display it.
    if (n[baseKey + '_modifier'] === '~') return 0;
    const v = n[baseKey + suffix];
    if (v === undefined || v === null || v === '') return 0;
    return (parseFloat(v) || 0) * (mult || 1);
  };
  const kcal = g('energy-kcal')
    || (n['energy' + suffix] ? (parseFloat(n['energy' + suffix])||0) / 4.184 : 0);
  // Issues #69 + #70: capture nutrition_basis + first alt_units entry from
  // OFF's serving metadata. Both fields are nullable; downstream code
  // falls back to existing behavior when they're absent.
  //   nutrition_basis = 'g' or 'ml' per p.nutrition_data_per ('100g' /
  //     '100ml' / 'serving'). For 'serving' we can't know the basis without
  //     a unit on serving_quantity, so we treat the unit field on the
  //     serving as the hint; default null when unclear.
  //   alt_units = first row built from serving_size + serving_quantity.
  //     e.g. "1 slice (35 g)" with serving_quantity=35 + serving_size
  //     "1 slice" → {abbr: "slice", grams: 35}. We only add the row when
  //     the parsed abbr is a recognizable discrete portion (not "g"/"ml").
  const basis = (() => {
    const raw = String(p.nutrition_data_per || '').toLowerCase();
    if (raw === '100g') return 'g';
    if (raw === '100ml') return 'ml';
    // Per-serving: fall back to the unit on serving_quantity if present.
    const su = String(p.serving_quantity_unit || '').toLowerCase();
    if (su === 'g' || su === 'kg') return 'g';
    if (su === 'ml' || su === 'l') return 'ml';
    return null;
  })();
  const altUnits = (() => {
    const ss = String(p.serving_size || '').trim();
    const sq = parseFloat(p.serving_quantity);
    if (!ss || !Number.isFinite(sq) || sq <= 0) return null;
    // OFF serving_size strings look like "1 slice (35 g)" or "2 biscuits
    // (24 g)". Extract the discrete-portion label: first non-numeric word
    // before any open paren. Skip if it's a base mass/volume unit (the
    // serving_quantity itself already carries that case).
    const m = ss.match(/^\s*\d+\s*([a-zA-ZÀ-ÿ]+)/);
    const label = m ? m[1].toLowerCase() : '';
    const BASE_UNITS = new Set(['g','mg','kg','ml','l','oz','lb','cup','tbsp','tsp']);
    if (!label || BASE_UNITS.has(label)) return null;
    return [{ abbr: label, grams: Math.round(sq * 10) / 10 }];
  })();
  // Quality signals lifted from the OFF product/hit shape. Used by the
  // Foods search UI to rank results (more complete + graded entries
  // surface higher than sparse ones) and to render a small quality dot
  // next to each result so the user can pick informed. All fields are
  // optional; anything missing degrades gracefully to null / undefined.
  // #241: which nutrients OFF actually has for this product. g() turns a
  // missing value into 0, and Refresh from OFF must not write that 0 over
  // a real number, so the refresh only updates what is listed here.
  const has = (baseKey) => n[baseKey + '_modifier'] !== '~'
    && n[baseKey + suffix] !== undefined && n[baseKey + suffix] !== null && n[baseKey + suffix] !== '';
  const nutrition = { calories: Math.round(kcal * 10) / 10 };
  const present = new Set();
  if (has('energy-kcal') || has('energy')) present.add('calories');
  for (const [id, key, mult] of OFF_NUTRIENTS) {
    nutrition[id] = g(key, mult);
    if (has(key)) present.add(id);
  }
  // Salt and sodium are one datum; deriveSodiumSalt fills either from the other.
  if (present.has('salt') || present.has('sodium')) { present.add('salt'); present.add('sodium'); }
  // No as-sold values at all, but "as prepared" ones: say so rather than
  // reporting an empty product.
  const preparedOnly = present.size === 0
    && Object.keys(n).some(k => k.endsWith('_prepared' + suffix) && n[k] !== '' && n[k] != null);
  // Only for a product with no "as sold" values at all: its "as prepared"
  // ones, so the user can choose them. Never used unasked: for a drink
  // powder they describe the finished drink, not the powder you weigh.
  let prepared = null;
  if (preparedOnly) {
    const pn = (key) => n[key + '_prepared_100g'];
    const pHas = (key) => n[key + '_prepared_modifier'] !== '~' && pn(key) !== undefined && pn(key) !== null && pn(key) !== '';
    const pg = (key, mult) => pHas(key) ? (parseFloat(pn(key)) || 0) * (mult || 1) : 0;
    const pNutrition = { calories: 0 };
    const pPresent = new Set();
    const pKcal = pHas('energy-kcal') ? pg('energy-kcal') : (pHas('energy') ? pg('energy') / 4.184 : 0);
    pNutrition.calories = Math.round(pKcal * 10) / 10;
    if (pHas('energy-kcal') || pHas('energy')) pPresent.add('calories');
    for (const [id, key, mult] of OFF_NUTRIENTS) {
      pNutrition[id] = pg(key, mult);
      if (pHas(key)) pPresent.add(id);
    }
    if (pPresent.has('salt') || pPresent.has('sodium')) { pPresent.add('salt'); pPresent.add('sodium'); }
    if (pPresent.size) {
      const per = String(p.nutrition_data_prepared_per || '').toLowerCase();
      prepared = {
        nutrition: Nutrition.deriveSodiumSalt(pNutrition),
        present: [...pPresent],
        portion: 100,
        unit: per === '100ml' ? 'ml' : 'g',
      };
    }
  }
  const completeness = typeof p.completeness === 'number' ? p.completeness : null;
  const nutriscore   = (p.nutriscore_grade || p.nutrition_grades || '').toLowerCase() || null;
  const nova         = typeof p.nova_group === 'number' ? p.nova_group : null;
  // Origin country tag for the small flag emoji shown on OFF result rows.
  // Prefer `origins_tags` (actual manufacturing origin per OFF's taxonomy)
  // and fall back to `manufacturing_places_tags`. `countries_tags` is NOT
  // used because that field means "where sold", not "where from": showing
  // a US flag on a French product just because it's sold at Trader Joe's
  // would be misleading. When neither field is populated the flag doesn't
  // render (many OFF entries lack this metadata; that's honest).
  const originTag = (Array.isArray(p.origins_tags) && p.origins_tags[0])
                 || (Array.isArray(p.manufacturing_places_tags) && p.manufacturing_places_tags[0])
                 || null;
  const mapped = {
    name,
    brand:     (Array.isArray(p.brands) ? (p.brands[0] || '') : (p.brands || '').split(',')[0] || '').trim(),
    barcode:   p.code || p._id || p.id || '',
    unit,
    portion,
    quantity:  1,
    imgUrl: p.image_front_display_url || p.image_front_url || p.image_url || p.image_front_small_url || '',
    dateTime:  new Date().toISOString(),
    categories: [],
    nutrition_basis: basis,
    alt_units:       altUnits,
    completeness,
    nutriscore,
    nova,
    originTag,
    nutrition: Nutrition.deriveSodiumSalt(nutrition),
  };
  Object.defineProperty(mapped, '_offPresent', { value: [...present], enumerable: false });
  Object.defineProperty(mapped, '_offPreparedOnly', { value: preparedOnly, enumerable: false });
  Object.defineProperty(mapped, '_offPrepared', { value: prepared, enumerable: false });
  return mapped;
}

/**
 * #241: a full product lookup, with the product's "as sold" values when
 * v3 leaves them out. v3 serves one set of values and prefers "as prepared",
 * so a product that has both comes back "as prepared" only; v3.5 serves all
 * the sets (see off-nutrition-sets.js). Asked only in that case, and any
 * failure or surprise keeps the v3 answer, as does an "as sold" set with no
 * calories (a formula listing only "sugars 0"): 0 kcal is worse than the
 * "as prepared" values the user is offered then.
 *
 * @param {object} product  the v3 product
 * @param {string} code     its barcode
 * @param {(p: object) => object|null} map  maps a product (mapOffProduct, or
 *   the app's wrapper that also remembers what OFF has)
 * @param {(url: string) => Promise<object|null>} fetchJson  the parsed reply,
 *   or null when the request did not succeed
 */
export async function mapFullOffProduct(product, code, { map, fetchJson }) {
  const mapped = map(product);
  if (!mapped || !mapped._offPreparedOnly) return mapped;
  try {
    const data = await fetchJson(offNutritionSetsUrl(code));
    if (!data) return mapped;
    const asSold = isOffSuccess(data) ? asSoldNutriments(data.product?.nutrition, product.serving_quantity) : null;
    if (!asSold) return mapped;
    const merged = map({
      ...product,
      nutriments: { ...(product.nutriments || {}), ...asSold.nutriments },
      nutrition_data_per: asSold.per,
    });
    if (merged && merged._offPresent.includes('calories')) return merged;
    // The merge registered its own reading of the product; put back v3's.
    return map(product);
  } catch {
    return mapped;
  }
}

/**
 * A name-search reply, mapped and ranked the way the Foods page shows it.
 * Reads whichever envelope is present: `hits` (search-a-licious and the
 * local OFF mirror) or `products` (the v2 API). #133, #192, #213: public OFF
 * hits carry a relevance `_score`; it rides beside the food rather than on
 * it so it never gets copied into a diary entry. See off-rank.js.
 */
export function rankOffSearch(data, map) {
  const fromMirror = Array.isArray(data?.hits);
  const entries = ((data && (data.hits || data.products)) || [])
    .map(p => ({ food: map(p), score: p ? p._score : undefined }))
    .filter(e => e.food);
  return { items: rankOFFResults(entries, { fromMirror }), count: entries.length };
}
