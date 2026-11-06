/**
 * Runs the app's own food search (src/lib/api.js, as the web app runs it,
 * through /api/proxy) against the recorded OFF and USDA replies, and prints
 * what it found as JSON. mcp-external-foods.test.js compares this with what
 * the server's MCP tools return for the same replies (#314).
 *
 *   node client-food-search.mjs '<{ settings, ops }>'
 *
 * api.js is written for Vite, so `import.meta.env` is filled in on load and
 * the few browser globals it touches are stubbed. It runs in its own
 * process because of that, and exits when done (the offline layer it pulls
 * in keeps timers).
 */
import { registerHooks } from 'node:module';
import { answer } from './external-food-mock.mjs';

registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (url.includes('/src/') && url.endsWith('.js')) {
      return { ...r, source: String(r.source).replaceAll('import.meta.env', "({ DEV: false, PROD: true, BASE_URL: '/', MODE: 'test' })") };
    }
    return r;
  },
});

const { settings = {}, ops = [] } = JSON.parse(process.argv[2] || '{}');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
// The web app, signed in as one user: settings live under wl_u1_<key>.
store.set('wl:userId', '1');
for (const [k, v] of Object.entries(settings)) store.set(`wl_u1_${k}`, JSON.stringify(v));
globalThis.window = globalThis;
globalThis.location = new URL('http://localhost/');
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

// Every request the app makes goes to /api/proxy?url=<the real address>.
const urls = [];
globalThis.fetch = async (input) => {
  const u = new URL(String(input), 'http://localhost');
  if (u.pathname !== '/api/proxy') throw new Error(`unexpected request ${u}`);
  const target = u.searchParams.get('url');
  urls.push(target);
  const { status, body } = answer(target);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const { API, USDA } = await import('../../src/lib/api.js');

// Search results and lookups, with the markers the app keeps off the food.
const out = (f) => (f ? { ...f, _offPresent: f._offPresent ?? null } : null);
const results = [];
for (const op of ops) {
  if (op.kind === 'offSearch') results.push((await API.searchByName(op.query)).map(out));
  else if (op.kind === 'offBarcode') results.push(out(await API.lookupBarcode(op.code)));
  else if (op.kind === 'usdaSearch') results.push((await USDA.searchByName(op.query, 1, op.key)).map(out));
  else if (op.kind === 'usdaBarcode') results.push(out(await USDA.lookupBarcode(op.code, op.key)));
  else if (op.kind === 'usdaFdc') results.push(out(await USDA.lookupFdcId(op.id, op.key)));
  else throw new Error(`unknown op ${op.kind}`);
}
process.stdout.write(JSON.stringify({ urls, results }));
process.exit(0);
