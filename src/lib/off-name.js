/**
 * off-name.js: the name to show for an Open Food Facts product (#238).
 *
 * `product_name` is the name in the product's main language, and OFF leaves
 * it blank when that language has no name, even though other languages do.
 * Barcode 7623186629037 is French-main with an empty French name and a
 * German and English name, so `product_name` is "" and NutriTrace reported
 * a product that exists as not found. Asking OFF for another language (lc=,
 * langs=) does not fill `product_name` in; the localized names only arrive
 * as `product_name_<lang>`.
 *
 * Order, first non-blank wins:
 *
 *  1. The user's OFF language, but only when they chose one other than
 *     English. English is the default, and opening Connected Services writes
 *     it back, so it cannot tell "chose English" from "never looked". Putting
 *     it first would swap the names of every product that already had one for
 *     everyone on the default. A language anyone picks on purpose is safe to
 *     honor.
 *  2. `product_name`, exactly what was shown before. A product that had a
 *     name keeps it.
 *  3. The user's language, then the product's main language, then English,
 *     then any other language in a fixed order.
 *  4. The same ladder over `generic_name` ("Milch, teilentrahmt"), so a
 *     product with nutrition but no product name in any language is still
 *     found. The local OFF mirror already falls back to the generic name.
 *
 * Returns '' when nothing usable is there, which the caller treats as "not a
 * product we can show", as before.
 */

// OFF language codes are two letters. Longer suffixes are other fields
// (product_name_en_imported, product_name_en_debug_tags), not names.
const LANG_SUFFIX = /^[a-z]{2}$/;

function _text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function _ladder(p, field, lang, main, userChoseLang) {
  const tries = [];
  if (userChoseLang) tries.push(p[`${field}_${lang}`]);
  tries.push(p[field]);
  if (lang) tries.push(p[`${field}_${lang}`]);
  if (main) tries.push(p[`${field}_${main}`]);
  tries.push(p[`${field}_en`]);
  const prefix = `${field}_`;
  for (const key of Object.keys(p).sort()) {
    if (key.startsWith(prefix) && LANG_SUFFIX.test(key.slice(prefix.length))) tries.push(p[key]);
  }
  for (const v of tries) {
    const t = _text(v);
    if (t) return t;
  }
  return '';
}

/**
 * @param {object} p     an OFF product (v3 product, search hit or mirror row)
 * @param {string} lang  the user's OFF language, a two-letter code
 */
export function offProductName(p, lang) {
  if (!p || typeof p !== 'object') return '';
  const want = String(lang || '').toLowerCase();
  const main = String(p.lang || p.lc || '').toLowerCase();
  const userChoseLang = !!want && want !== 'en';
  return _ladder(p, 'product_name', want, main, userChoseLang)
      || _ladder(p, 'generic_name', want, main, userChoseLang);
}
