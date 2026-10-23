/**
 * A file of the wrong type, or one over the size limit, is the caller's
 * mistake. Upload filters used to reject with a bare Error, which reached the
 * error handler without a status and answered 500. They now answer 415 and
 * 413, which the handler passes through (err.status || 500).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../server/routes/upload.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

test('the error handler turns err.status into the response code', () => {
  assert.match(index, /res\.status\(err\.status \|\| 500\)/);
});

test('a refused type carries 415 and an oversized file becomes 413', () => {
  assert.match(src, /function refusedType\(message\) \{\s*return Object\.assign\(new Error\(message\), \{ status: 415 \}\);/);
  assert.match(src, /LIMIT_FILE_SIZE[\s\S]{0,200}status: 413/);
});

test('no upload filter rejects with a bare Error that would answer 500', () => {
  const bare = [...src.matchAll(/cb\(new Error\('([^']+)'\)\)/g)].map(m => m[1]);
  // A route that maps its own message to a 4xx is fine; nothing else is.
  for (const msg of bare) {
    assert.match(src, new RegExp(`err\\.message === '${msg}'\\) return res\\.status\\(4\\d\\d\\)`), `"${msg}" would answer 500`);
  }
});

test('every multer callback hands its error to uploadError, or answers it itself', () => {
  const callbacks = [...src.matchAll(/\.single\('file'\)\(req, res, (?:async )?\(err\) => \{\s*if \(err\)([^\n]*)/g)].map(m => m[1].trim());
  assert.ok(callbacks.length > 0);
  for (const c of callbacks) assert.ok(/uploadError\(err, next, \d+\)/.test(c) || c === '{', `callback does: ${c}`);
});
