/**
 * Trace's attach button is one shared component, identical in every Trace
 * app: Camera or Gallery on a phone, a tablet or the Android app; straight to
 * the file picker on a computer, where browsers ignore the camera hint. The
 * Android app goes straight to the camera or the system photo picker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const button = read('../src/components/ai/AttachImageButton.svelte');
const trace = read('../src/components/ai/Trace.svelte');
const app = JSON.parse(read('../package.json')).name;

test('Trace attaches images only through the shared button', () => {
  assert.match(trace, /import AttachImageButton from '\.\/AttachImageButton\.svelte';/);
  assert.match(trace, /<AttachImageButton[^>]*on:files=\{e => [A-Za-z_]+\(e\.detail\)\}/);
  assert.doesNotMatch(trace, /type="file"/, 'no file inputs of its own left in Trace');
  assert.doesNotMatch(trace, /CameraSource/, 'no camera calls of its own left in Trace');
  // LiftTrace's coach compares progress photos, so it takes several at once.
  const multiple = /<AttachImageButton multiple\b/.test(trace);
  assert.equal(multiple, app === 'lifttrace', 'only LiftTrace picks several photos');
});

test('a menu where both choices mean something, the file picker elsewhere', () => {
  assert.match(button, /const touch = isNative\s*\n\s*\|\| \(typeof window !== 'undefined' && !!window\.matchMedia\?\.\('\(pointer: coarse\)'\)\.matches\);/);
  assert.match(button, /if \(!touch\) \{ fileInput\?\.click\(\); return; \}/);
  assert.match(button, /source: fromCamera \? CameraSource\.Camera : CameraSource\.Photos,/, 'Android goes straight to the camera or the photo picker');
  assert.doesNotMatch(button, /CameraSource\.Prompt/, 'never Android\'s generic chooser');
  assert.match(button, /capture="environment"/, 'the web Camera choice asks for the camera');
  assert.match(button, /on:pointerdown=\{onWindowPointer\} on:keydown=\{onWindowKey\}/, 'the menu closes on a tap outside or Escape');
});

test('the menu has its words', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.deepEqual(Object.keys(en.attach_image).sort(), ['button', 'camera', 'gallery']);
  assert.match(button, /\$_\('attach_image\.camera'\)/);
  assert.match(button, /\$_\('attach_image\.gallery'\)/);
});
