/**
 * PR #304 (@librarian): pasting a screenshot into Trace attaches it.
 * Office apps put text and a picture of it on the clipboard together, so a
 * paste that carries plain text stays a text paste.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('function _onPaste'), src.indexOf('function _useImageFiles'));
// Extract the handler and run it against fake clipboard events.
const onPaste = new Function('ctx', `let loading = ctx.loading; const _useImageFiles = ctx.use; ${body}; return _onPaste;`);

function run({ files = [], text = '', loading = false }) {
  const used = [];
  let prevented = false;
  const fn = onPaste({ loading, use: (f) => used.push(...f) });
  fn({ clipboardData: { files, getData: (t) => (t === 'text/plain' ? text : '') }, preventDefault() { prevented = true; } });
  return { used, prevented };
}

const png = { type: 'image/png', name: 'shot.png' };

test('the textarea wires the paste handler', () => {
  assert.match(src, /on:paste=\{_onPaste\}/);
});

test('a screenshot is attached instead of pasted', () => {
  assert.deepEqual(run({ files: [png] }), { used: [png], prevented: true });
});

test('text with a picture of it (spreadsheet cells) pastes as text', () => {
  assert.deepEqual(run({ files: [png], text: '12\t34' }), { used: [], prevented: false });
});

test('plain text and non-image files paste normally', () => {
  assert.deepEqual(run({ text: 'hello' }), { used: [], prevented: false });
  assert.deepEqual(run({ files: [{ type: 'application/pdf' }] }), { used: [], prevented: false });
});

test('nothing is attached while Trace is answering', () => {
  assert.deepEqual(run({ files: [png], loading: true }), { used: [], prevented: false });
});
