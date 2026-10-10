/**
 * The image proxy only passes images, and sends them so they can't act as a
 * page. It answers from the app's own origin before sign-in, and for the
 * image hosts it passed through whatever came back: an HTML page from one of
 * them was served as text/html (reproduced with i.imgur.com), and an SVG with
 * no protection. Photos and SVGs still show in an <img>.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../server/routes/proxy.js', import.meta.url), 'utf8');

test('only an image is passed through, never a page from an image host', () => {
  assert.match(src, /if \(contentType\.startsWith\('image\/'\) \|\| \(isImgHost && !contentType\)\) \{/);
  assert.doesNotMatch(src, /contentType\.startsWith\('image\/'\) \|\| isImgHost\)/);
  assert.match(src, /if \(isImgHost\) \{[\s\S]{0,160}return res\.status\(502\)\.json\(\{ error: 'That address is not an image' \}\);/);
});

test('the type is read in lower case, so IMAGE/JPEG is still an image', () => {
  assert.match(src, /const contentType = \(response\.headers\.get\('content-type'\) \|\| ''\)\.toLowerCase\(\);/);
});

test('an image is sent with nosniff and a sandbox policy', () => {
  assert.match(src, /res\.set\('X-Content-Type-Options', 'nosniff'\);/);
  assert.match(src, /res\.set\('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox"\);/);
});
