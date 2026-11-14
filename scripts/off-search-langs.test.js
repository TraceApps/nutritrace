/**
 * #320: Ukrainian names were not found by name search. The setting had no
 * Ukrainian or Ukraine, and search-a-licious only searched the one chosen
 * language, so a product named only in English was missed (and langs=uk
 * alone returned nothing on OFF's production index in 2026-11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { offSearchLangs, offSearchUrl, offCountryTag } from '../src/lib/off-map.js';

const langsOf = url => new URL(url).searchParams.get('langs');

test('English searches English only', () => {
  assert.equal(offSearchLangs('en'), 'en');
  assert.equal(offSearchLangs(undefined), 'en');
  assert.equal(langsOf(offSearchUrl('milk')), 'en');
});

test('any other language also searches English', () => {
  assert.equal(offSearchLangs('uk'), 'uk,en');
  assert.equal(offSearchLangs('de'), 'de,en');
  assert.equal(langsOf(offSearchUrl('Огірки', { lang: 'uk' })), 'uk,en');
});

test('Ukraine maps to the OFF country tag', () => {
  assert.equal(offCountryTag('Ukraine'), 'en:ukraine');
  const q = new URL(offSearchUrl('сир', { country: offCountryTag('Ukraine'), lang: 'uk' })).searchParams.get('q');
  assert.equal(q, 'сир +countries_tags:"en:ukraine"');
});

test('Settings offers Ukrainian and Ukraine', () => {
  const s = readFileSync(new URL('../src/routes/settings/ConnectedServices.svelte', import.meta.url), 'utf8');
  assert.match(s, /\['uk','Ukrainian'\]/);
  assert.match(s, /'Ukraine'/);
});
