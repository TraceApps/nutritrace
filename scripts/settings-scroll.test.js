/**
 * #227: /settings and /settings/<section> share the page's one scroller, so
 * a section opened wherever the index was scrolled to. A section now opens
 * at its top, and going back to the index returns to where you were on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const settings = read('../src/routes/Settings.svelte');
const app = read('../src/App.svelte');

test('the index and its sections share one scroller (why the fix is needed)', () => {
  assert.match(app, /'\/settings':\s+Settings,/);
  assert.match(app, /'\/settings\/:section': Settings,/);
  assert.match(app, /\{#key \(\$location \|\| ''\)\.split\('\/'\)\[1\] \|\| ''\}/, 'the scroller only remounts per first segment');
});

test('what survives the remount between the two routes lives in module scope', () => {
  const mod = settings.slice(settings.indexOf('<script context="module">'), settings.indexOf('</script>'));
  assert.match(mod, /const _scrollMemo = \{ scroller: null, indexTop: 0 \};/);
});

test('a section opens at its top; the index returns to where it was', () => {
  assert.match(settings, /s\.scrollTo\(\{ top: section \? 0 : _scrollMemo\.indexTop, behavior: 'instant' \}\);/, 'instant, or a smooth scroll records its in-between positions');
});

test('the index position is recorded while scrolling, not on the way out', () => {
  // Only while the URL is the index, so the swap's own scroll events don't count.
  assert.match(settings, /const _onIndexUrl = \(\) => typeof location !== 'undefined' && \/\^#\\\/settings\\\/\?\(\\\?\|\$\)\/\.test\(location\.hash\);/);
  // Under Svelte 5 teardown runs after the content is removed, when the
  // scroller has already snapped back.
  assert.match(settings, /addEventListener\('scroll', _recordIndexScroll/);
  assert.match(settings, /removeEventListener\('scroll', _recordIndexScroll\)/);
  assert.match(settings, /function _recordIndexScroll\(e\) \{\s*if \(_onIndexUrl\(\)\) _scrollMemo\.indexTop = e\.currentTarget\.scrollTop;/);
});

test('opening Settings fresh from another page starts at the top', () => {
  assert.match(settings, /if \(s && s === _scrollMemo\.scroller\) _placeScroll\(currentSection\);\s*else _scrollMemo\.indexTop = 0;/);
});

test('the search deep link still scrolls to its match afterwards', () => {
  // The placement is immediate (after one tick); the deep link waits a tick plus 60ms.
  assert.match(settings, /await tick\(\);\s*await new Promise\(r => setTimeout\(r, 60\)\);/);
});
