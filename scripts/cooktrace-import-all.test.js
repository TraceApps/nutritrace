/**
 * Import All Recipes lists the whole CookTrace catalog.
 *
 * The import pages through CookTrace's recipe list with an empty search,
 * but searchWithMeta returned nothing for an empty search, so the import
 * always reported "No CookTrace recipes found". The Foods search keeps that
 * guard; the import opts out of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { DB } = await import('../src/lib/db.js');
const { CookTrace } = await import('../src/lib/cooktraceApi.js');

DB.getSetting = (key, fallback) => ({ cooktraceBaseUrl: 'http://ct.test', cooktraceApiToken: 't' }[key] ?? fallback);

async function withFetch(body, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body).path);
    return { ok: true, status: 200, json: async () => body };
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

test('an empty search makes no request', async () => {
  await withFetch({ items: [{ id: 1 }], total: 1 }, async (calls) => {
    const meta = await CookTrace.searchWithMeta('', 1, 50);
    assert.deepEqual(meta.items, []);
    assert.equal(calls.length, 0);
  });
});

test('allowEmpty lists the catalog, a page at a time', async () => {
  await withFetch({ items: [{ id: 1 }, { id: 2 }], total: 5 }, async (calls) => {
    const meta = await CookTrace.searchWithMeta('', 2, 2, { allowEmpty: true });
    assert.deepEqual(calls, ['/api/v1/recipes?q=&limit=2&offset=2']);
    assert.equal(meta.items.length, 2);
    assert.equal(meta.hasMore, true);
  });
});

test('Import All Recipes asks for the whole list', () => {
  const src = readFileSync(new URL('../src/routes/settings/ConnectedServices.svelte', import.meta.url), 'utf8');
  assert.match(src, /CookTrace\.searchWithMeta\(''[^;]*allowEmpty: true/);
});
