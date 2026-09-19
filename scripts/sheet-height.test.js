/**
 * #228: the Body Stats sheet had no height cap. With the keyboard open the
 * screen above it is short, so the sheet grew past the top edge and its title
 * and close button sat under the status bar. The hand-built bottom sheets now
 * cap their height below the status bar and scroll their own content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const rule = (css, sel) => {
  const i = css.indexOf(`${sel} {`);
  assert.ok(i >= 0, `${sel} rule`);
  return css.slice(i, css.indexOf('}', i));
};
const CAP = /max-height: min\(90dvh, calc\(100dvh - var\(--safe-top\) - 8px\)\);/;

test('the Diary sheets (Body Stats, Save to Library, Copy To, the date picker) stay below the status bar', () => {
  const r = rule(read('../src/routes/Diary.svelte'), '  .bs-sheet');
  assert.match(r, CAP);
  assert.match(r, /overflow-y: auto;/, 'the fields scroll inside the sheet');
});

test('the Body Stats title and close button stay in reach while the fields scroll', () => {
  const r = rule(read('../src/routes/Diary.svelte'), '  .bs-sheet .sheet-header-row');
  assert.match(r, /position: sticky; top: 0;/);
  assert.match(r, /background: var\(--surface-1\);/);
});

test('the Wellness date sheet gets the same cap', () => {
  const r = rule(read('../src/routes/Wellness.svelte'), '  .bs-sheet');
  assert.match(r, CAP);
  assert.match(r, /overflow-y: auto;/);
});
