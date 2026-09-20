/**
 * Fonts are served by the instance, never from a CDN. Loading them from
 * Google meant every page load told Google the visitor's IP, before anyone
 * had enabled anything, which contradicted the privacy page. The files live
 * in public/fonts, one per script subset with the unicode-range split Google
 * uses, so a browser still downloads only the scripts a page needs and a new
 * translation needs no font work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const FONTS = join(ROOT, 'public/fonts');
const css = readFileSync(join(FONTS, 'fonts.css'), 'utf8');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('nothing asks Google for fonts', () => {
  const files = [join(ROOT, 'index.html'), ...walk(join(ROOT, 'src'))].filter((f) => /\.(html|css|svelte|js|ts)$/.test(f));
  const offenders = files.filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => f.replace(ROOT, '')), []);
});

test('the page loads the local font stylesheet for everyone', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/fonts\/fonts\.css" \/>/);
  // Not behind a Capacitor check: the browser needs it too.
  assert.doesNotMatch(html, /isNativePlatform[\s\S]{0,400}fonts\.css/);
});

test('every font file the stylesheet references exists', () => {
  const refs = [...css.matchAll(/url\(\.\/([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 7, `expected the subset files (${refs.length})`);
  assert.deepEqual(refs.filter((f) => !existsSync(join(FONTS, f))), []);
});

test('Inter covers the weights the app uses, including 500', () => {
  const inter = css.split('@font-face').filter((b) => /font-family: 'Inter'/.test(b));
  assert.ok(inter.length >= 7, `one Inter face per subset (${inter.length})`);
  for (const face of inter) assert.match(face, /font-weight: 300 700;/, 'the variable file covers 300 to 700');
});

test('the script subsets are all declared with their unicode-range', () => {
  for (const subset of ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese']) {
    assert.ok(css.includes(`inter-${subset}.woff2`), `Inter ${subset}`);
  }
  const faces = css.split('@font-face').filter((b) => /url\(/.test(b));
  const noRange = faces.filter((b) => !/unicode-range:/.test(b) && !/Material Symbols/.test(b));
  assert.deepEqual(noRange.map((b) => (b.match(/font-family: '([^']+)'/) || [])[1]), [], 'every text face declares a range');
});
