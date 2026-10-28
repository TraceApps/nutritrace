/**
 * The iPhone home screen icon is a full 180px square with no see-through
 * pixels. iOS rounds the corners itself and fills anything see-through with
 * white: the rounded icon with transparent corners it used before showed a
 * white rim on the home screen (Android and NoteTrace were fine).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url));

test('index.html links one apple-touch-icon, the 180px square', () => {
  const html = read('index.html').toString();
  const links = html.match(/<link rel="apple-touch-icon"[^>]*>/g) || [];
  assert.equal(links.length, 1, links.join('\n'));
  assert.match(links[0], /sizes="180x180" href="\/icons\/apple-touch-icon-180\.png/);
});

test('the icon is a 180x180 PNG with no alpha channel', () => {
  const png = read('public/icons/apple-touch-icon-180.png');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  // Colour type 2 is RGB: nothing can be see-through.
  assert.equal(png[25], 2, 'colour type');
  assert.ok(!png.includes(Buffer.from('tRNS')), 'no transparency chunk');
});
