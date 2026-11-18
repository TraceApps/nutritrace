/**
 * Settings search: which sections show for what was typed.
 *
 * Each section is searched by what it shows (src/lib/settings-search-index.json,
 * made by scripts/gen-settings-search.mjs from the section's own files): its
 * labels, descriptions, buttons and option names, in the app's language and
 * in English, plus its title and the other names people use for it
 * (SECTION_KEYWORDS in Settings.svelte, such as "2fa" or "kj"). Every word
 * typed has to be in the section somewhere, so "dark mode", "two step sign
 * in" and "Regional & Units" find theirs. It used to match one hand-written
 * keyword at a time, and a setting added without keywords couldn't be found.
 */
import { foldText } from './search-text.js';

/** Lowercase, without accents, punctuation as spaces. */
export function normalize(s) {
  return ` ${foldText(s).replace(/[^\p{L}\p{N}%]+/gu, ' ').trim()} `;
}

/** The words of a query. */
export function queryWords(query) {
  return normalize(query).trim().split(' ').filter(Boolean);
}

/**
 * What each section is searched by: { key: text }. `translate(key)` gives a
 * translation key's text in the app's language, `english(key)` in English.
 */
export function sectionHaystacks(index, { keywords = {}, titles = {}, translate = k => k, english = k => k } = {}) {
  const out = {};
  const keys = new Set([...Object.keys(index || {}), ...Object.keys(keywords), ...Object.keys(titles)]);
  for (const key of keys) {
    const entry = index?.[key] || { keys: [], text: [] };
    const parts = [...(keywords[key] || []), titles[key] || '', ...entry.text];
    for (const k of entry.keys) {
      const here = _safe(translate, k);
      const en = _safe(english, k);
      if (here && here !== k) parts.push(here);
      if (en && en !== k && en !== here) parts.push(en);
    }
    out[key] = parts.map(normalize).join('|');
  }
  return out;
}

function _safe(fn, k) {
  try { const v = fn(k); return typeof v === 'string' ? _plainText(v) : ''; } catch { return ''; }
}

// A message's words without its ICU syntax ({count, plural, one {...} other {...}}):
// "plural" or "other" aren't words a section shows.
function _plainText(v) {
  return v.replace(/\{\s*\w+\s*,\s*(?:plural|select|selectordinal|number|date|time)\s*,?/g, ' ')
    .replace(/(?:^|[\s}])(?:=\d+|zero|one|two|few|many|other)\s*\{/g, ' ')
    .replace(/\{\s*\w+\s*\}/g, ' ');
}

/**
 * Every word of `query` starts a word in the section's text: "fast" finds
 * Fasting, not every "breakfast".
 */
export function sectionMatches(query, haystack) {
  const words = queryWords(query);
  if (!words.length) return true;
  if (!haystack) return false;
  return words.every(w => haystack.includes(` ${w}`));
}
