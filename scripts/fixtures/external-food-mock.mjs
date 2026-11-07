/**
 * Open Food Facts and USDA FoodData Central, answered from replies recorded
 * from the real services (mcp-external-foods.json, off-nutrition-sets.json,
 * usda-290-responses.json, usda-energy-responses.json). Used by the #314 tests for both the server's
 * MCP tools and the app's own api.js, so both read the same answers and
 * neither reaches the network.
 */
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const FX = read('./mcp-external-foods.json');
const SETS = read('./off-nutrition-sets.json').products;
const USDA290 = read('./usda-290-responses.json');
const ENERGY = read('./usda-energy-responses.json');

export const USDA_GOOD_KEY = 'TESTKEY';
export const USDA_BAD_KEY = 'BADKEY';

const json = (status, body) => ({ status, body });

function _setsProduct(code) {
  return Object.values(SETS).find(p => p.v3?.code === code) || null;
}

/** The recorded answer for one request, as { status, body }. */
export function answer(urlString) {
  const url = new URL(urlString);
  const host = url.hostname;
  const path = url.pathname;
  if (host === 'search.openfoodfacts.org' && path === '/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    if (q.includes('skyr')) return json(200, FX.off_search_skyr);
    return json(200, { hits: [], count: 0, page: 1, page_size: Number(url.searchParams.get('page_size')) || 50 });
  }
  if (host === 'world.openfoodfacts.org') {
    let m = /^\/api\/v3\/product\/([^/]+)$/.exec(path);
    if (m) {
      const code = m[1];
      const rec = FX[`off_v3_${code}`];
      if (rec) return json(200, rec);
      const sets = _setsProduct(code);
      if (sets) return json(200, { code, status: 'success', product: sets.v3 });
      return json(404, FX.off_v3_missing);
    }
    m = /^\/api\/v3\.5\/product\/([^/]+)$/.exec(path);
    if (m) {
      const sets = _setsProduct(m[1]);
      if (sets) return json(200, { code: m[1], status: 'success', product: sets.v3_5 });
      return json(404, FX.off_v3_missing);
    }
    return json(404, { status: 'failure' });
  }
  if (host === 'api.nal.usda.gov') {
    const key = url.searchParams.get('api_key');
    if (key !== USDA_GOOD_KEY) return json(403, FX.usda_bad_key);
    if (path === '/fdc/v1/foods/search') {
      const q = (url.searchParams.get('query') || '').toLowerCase();
      if (url.searchParams.get('dataType') === 'Branded') {
        const all = [...FX.usda_search_skyr.foods, ...FX.usda_search_greek.foods, ...USDA290.search_popcorn.foods];
        const foods = all.filter(f => f.gtinUpc && (f.gtinUpc === q || f.gtinUpc.includes(q.replace(/^0+/, ''))));
        return json(200, { totalHits: foods.length, currentPage: 1, totalPages: 1, foods });
      }
      // Not a real reply: a shape the mapper can't read, for the per-source error.
      if (q.includes('badshape')) return json(200, { totalHits: 1, foods: [null, { fdcId: 1, description: 5 }] });
      if (q.includes('greek')) return json(200, FX.usda_search_greek);
      if (q.includes('skyr')) return json(200, FX.usda_search_skyr);
      if (q.includes('popcorn')) return json(200, USDA290.search_popcorn);
      return json(200, { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] });
    }
    const m = /^\/fdc\/v1\/food\/(\d+)$/.exec(path);
    if (m && USDA290[`food_${m[1]}`]) return json(200, USDA290[`food_${m[1]}`]);
    if (m && ENERGY[`food_${m[1]}`]) return json(200, ENERGY[`food_${m[1]}`]);
    return json(404, { error: 'not found' });
  }
  return json(404, {});
}
