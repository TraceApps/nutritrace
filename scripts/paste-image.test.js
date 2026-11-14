/**
 * Paste a picture into a chat (from nutritrace#304): a clipboard that is
 * just an image attaches it like the image button; one that also has plain
 * text (cells from a spreadsheet, a passage from Word come with a picture of
 * themselves) pastes as text. lib/paste-image.js is the same file in every
 * Trace app, pinned by its hash here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pastedImage } from '../src/lib/paste-image.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const png = { type: 'image/png', name: 'shot.png' };
const clip = ({ files = [], text = '' } = {}) => ({ files, getData: (t) => (t === 'text/plain' ? text : '') });

test('paste-image.js is the same in every Trace app', () => {
  assert.equal(createHash('sha256').update(read('../src/lib/paste-image.js')).digest('hex'), 'ea9f60e838dcef77d8bbbafddf437e0844048df115886f11378077ba0b19480c');
});

test('a clipboard that is just an image gives the image', () => {
  assert.equal(pastedImage(clip({ files: [png] })), png);
  assert.equal(pastedImage(clip({ files: [{ type: 'text/html' }, png] })), png);
});

test('text with a picture of it, plain text, other files and nothing paste as usual', () => {
  assert.equal(pastedImage(clip({ files: [png], text: '12\t34' })), null);
  assert.equal(pastedImage(clip({ text: 'hello' })), null);
  assert.equal(pastedImage(clip({ files: [{ type: 'application/pdf' }] })), null);
  assert.equal(pastedImage(clip()), null);
  assert.equal(pastedImage(null), null);
  assert.equal(pastedImage(undefined), null);
});

// Each chat's own handler, run against fake paste events.
function handler(src, name, busy, use) {
  const start = src.indexOf(`function ${name}(e) {`);
  assert.ok(start >= 0, name);
  const body = src.slice(start, src.indexOf('\n  }\n', start) + 4);
  return new Function('ctx', `let ${busy} = ctx.busy; const pastedImage = ctx.pastedImage; const ${use} = ctx.use; ${body}; return ${name};`);
}
function run(make, { files = [], text = '', busy = false }) {
  const used = [];
  let prevented = false;
  const fn = make({ busy, pastedImage, use: (x) => used.push(x) });
  fn({ clipboardData: clip({ files, text }), preventDefault() { prevented = true; } });
  return { used, prevented };
}

for (const [file, name, busy, use, shape] of [
  ['src/components/ai/Trace.svelte', '_onPaste', 'loading', '_useImageFiles', 'list'],
  ['src/components/coaching/Conversation.svelte', 'onPaste', 'sending', 'onFiles', 'event'],
]) {
  test(`${file}: the message box pastes a screenshot as an attachment`, () => {
    const src = read('../' + file);
    assert.match(src, /import \{ pastedImage \} from '\.\.\/\.\.\/lib\/paste-image\.js';/);
    assert.ok(src.includes(`on:paste={${name}}`), 'textarea wires the handler');
    const make = handler(src, name, busy, use);
    const handed = shape === 'list' ? [png] : { detail: [png] };
    assert.deepEqual(run(make, { files: [png] }), { used: [handed], prevented: true });
    assert.deepEqual(run(make, { files: [png], text: '12\t34' }), { used: [], prevented: false });
    assert.deepEqual(run(make, { text: 'hello' }), { used: [], prevented: false });
    assert.deepEqual(run(make, { files: [png], busy: true }), { used: [], prevented: false });
  });
}
