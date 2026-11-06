import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const apiJs = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
// The search URL and country tag moved to off-map.js, shared with the
// server's MCP tools (#314); api.js builds its searches with it.
const offMapJs = readFileSync(new URL('../src/lib/off-map.js', import.meta.url), 'utf8');
// OFF_COUNTRY_OPTS moved from Settings.svelte to the extracted
// ConnectedServices settings component during the settings file-split
// refactor. Update this path if the constant ever moves again.
const connectedSvelte = readFileSync(new URL('../src/routes/settings/ConnectedServices.svelte', import.meta.url), 'utf8');
// The mirror dispatch moved from routes/proxy.js to lib/external-api.js,
// shared with the MCP food tools (#314).
const proxyJs = readFileSync(new URL('../server/lib/external-api.js', import.meta.url), 'utf8');

test('Open Food Facts country search uses search-a-licious with Lucene countries_tags filter', () => {
  // v1.1.2 migrated OFF text search from v2 API to search-a-licious.
  // Country filter is now folded into the Lucene `q` string as
  // `+countries_tags:"..."`, not a separate query param.
  assert.match(offMapJs, /search\.openfoodfacts\.org\/search/);
  assert.match(offMapJs, /\+countries_tags:"\$\{country\}"/);
  assert.match(offMapJs, /`en:\$\{slug\}`/);
  assert.match(apiJs, /offSearchUrl\(query, \{ page, pageSize, country: _getOffSearchCountry\(\), lang: _getOffSearchLanguage\(\) \}\)/);
  assert.match(apiJs, /return offCountryTag\(JSON\.parse\(raw\)\);/);
  for (const src of [apiJs, offMapJs]) {
    assert.doesNotMatch(src, /countries_tags_en/);
    assert.doesNotMatch(src, /world\.openfoodfacts\.org\/api\/v2\/search/);
  }
});

test('Open Food Facts country options include Norway and the expanded set', () => {
  // Spot-check a handful of countries from the expanded list plus the
  // original Norway ask so regressions on either surface here.
  for (const country of ['Norway', 'Sweden', 'Denmark', 'Netherlands', 'Ireland', 'New Zealand', 'South Africa']) {
    assert.match(connectedSvelte, new RegExp(`OFF_COUNTRY_OPTS[\\s\\S]*'${country}'`), `expected '${country}' in OFF_COUNTRY_OPTS`);
  }
});

test('local OFF proxy handles v2 search endpoint', () => {
  assert.match(proxyJs, /world\.openfoodfacts\.org[\s\S]*\/api\/v2\/search/);
  assert.match(proxyJs, /searchParams\.get\('search_terms'\)/);
});
