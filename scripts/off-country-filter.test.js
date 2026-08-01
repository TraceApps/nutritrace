import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const apiJs = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
const settingsSvelte = readFileSync(new URL('../src/routes/Settings.svelte', import.meta.url), 'utf8');
const proxyJs = readFileSync(new URL('../server/routes/proxy.js', import.meta.url), 'utf8');

test('Open Food Facts country search uses v2 countries_tags filtering', () => {
  assert.match(apiJs, /world\.openfoodfacts\.org\/api\/v2\/search/);
  assert.match(apiJs, /params\.set\('countries_tags', country\)/);
  assert.match(apiJs, /`en:\$\{slug\}`/);
  assert.doesNotMatch(apiJs, /countries_tags_en/);
  assert.doesNotMatch(apiJs, /search\.openfoodfacts\.org\/search\?q=/);
});

test('Open Food Facts country options include Norway', () => {
  assert.match(settingsSvelte, /OFF_COUNTRY_OPTS[\s\S]*'Norway'/);
});

test('local OFF proxy handles v2 search endpoint', () => {
  assert.match(proxyJs, /world\.openfoodfacts\.org[\s\S]*\/api\/v2\/search/);
  assert.match(proxyJs, /searchParams\.get\('search_terms'\)/);
});
