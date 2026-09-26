/**
 * #238 (@meggiman): an Open Food Facts product whose `product_name` is blank
 * was reported as not in OFF, though it had names in other languages. Also
 * dropped from name searches for the same reason (39 of 1,900 real search
 * results had a blank `product_name` when this was fixed).
 *
 * The order is in src/lib/off-name.js. The rule that matters most for "does
 * not break anything": on the default language (English), any product that
 * had a `product_name` keeps exactly that name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { offProductName } from '../src/lib/off-name.js';

// The name fields of barcode 7623186629037 as OFF v3 returned them.
const REPORTED = {
  code: '7623186629037', lang: 'fr', lc: 'fr', brands: 'Valflora',
  product_name: '', product_name_de: 'Milch Drink UHT 1,5% Milchfett',
  product_name_en: 'Milch Drink UHT 1,5% Milchfett', product_name_fr: '',
  generic_name: '', generic_name_de: 'Milch, teilentrahmt', generic_name_en: '', generic_name_fr: '',
};

test("the reported product gets a name instead of 'not found'", () => {
  assert.equal(offProductName(REPORTED, 'en'), 'Milch Drink UHT 1,5% Milchfett');
  assert.equal(offProductName(REPORTED, 'de'), 'Milch Drink UHT 1,5% Milchfett');
  assert.equal(offProductName(REPORTED, 'fr'), 'Milch Drink UHT 1,5% Milchfett', 'French is blank, so fall through');
});

// A French-main product with translations, like the first live search hit.
const TRANSLATED = {
  lang: 'fr', product_name: 'UHT Milch Drink',
  product_name_fr: 'UHT Milch Drink', product_name_en: 'UHT Milch Drink Teilentrahmt', product_name_de: 'Bio Milch UHT',
};

test('on the default language a product that had a name keeps exactly that name', () => {
  assert.equal(offProductName(TRANSLATED, 'en'), 'UHT Milch Drink');
  assert.equal(offProductName(TRANSLATED, undefined), 'UHT Milch Drink');
  assert.equal(offProductName(TRANSLATED, ''), 'UHT Milch Drink');
});

test('a language picked on purpose is preferred when the product has it', () => {
  assert.equal(offProductName(TRANSLATED, 'de'), 'Bio Milch UHT');
  assert.equal(offProductName(TRANSLATED, 'it'), 'UHT Milch Drink', 'no Italian name: the main name, as before');
});

test('with product_name blank: chosen language, main language, English, then any other', () => {
  const p = { lang: 'it', product_name: '', product_name_it: 'Latte', product_name_en: 'Milk', product_name_es: 'Leche' };
  assert.equal(offProductName(p, 'es'), 'Leche', 'the chosen language first');
  assert.equal(offProductName(p, 'en'), 'Milk', 'English, the default, counts as the user language here: no name existed before');
  assert.equal(offProductName(p, 'de'), 'Latte', 'no German name: the main language before English');
  assert.equal(offProductName({ ...p, product_name_it: '' }, 'de'), 'Milk', 'then English');
  assert.equal(offProductName({ lang: 'it', product_name_nl: 'Melk', product_name_da: 'Mælk' }, 'en'), 'Mælk',
    'any other language in a fixed order, so the result never depends on key order');
});

test('generic_name is the last resort, with the same order', () => {
  assert.equal(offProductName({ lang: 'fr', product_name: '', generic_name_de: 'Milch, teilentrahmt' }, 'en'), 'Milch, teilentrahmt');
  assert.equal(offProductName({ product_name: '', generic_name: 'Milk', generic_name_de: 'Milch' }, 'de'), 'Milch');
  assert.equal(offProductName({ product_name_en: 'Milk', generic_name: 'Dairy' }, 'en'), 'Milk', 'any product name beats a generic one');
});

test('blank, whitespace and non-text values never count as a name', () => {
  assert.equal(offProductName({ product_name: '   ', product_name_en: 'Milk' }, 'en'), 'Milk');
  assert.equal(offProductName({ product_name: { en: 'x' }, product_name_de: ['x'], product_name_fr: 5, product_name_en: 'Milk' }, 'en'), 'Milk');
  assert.equal(offProductName({ product_name: '  Milk  ' }, 'en'), 'Milk', 'trimmed, as before');
});

test('a product with no name anywhere is still not shown', () => {
  for (const p of [{}, { product_name: '' }, { product_name: '', generic_name: '  ' }, null, undefined, 'x']) {
    assert.equal(offProductName(p, 'en'), '');
  }
});

test('fields that only look like language names are ignored', () => {
  assert.equal(offProductName({ product_name_debug_tags: 'x', product_name_en_imported: 'y', product_name_en_debug_tags: 'z' }, 'en'), '');
});

test('the OFF mapper uses it for both the check and the name it stores', () => {
  const api = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
  const fn = api.slice(api.indexOf('  _mapOFFProduct(p'));
  assert.match(fn, /const name = offProductName\(p, _getOffSearchLanguage\(\)\);\s*if \(!p \|\| !name\) return null;/);
  assert.match(fn, /\n      name,\n/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n  }\n')), /p\.product_name/, 'nothing reads product_name directly any more');
});
