import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { centeredSquareCrop, moveSquareCrop, resizeSquareCrop } from '../src/lib/crop-geometry.js';

test('crop starts centered and square inside the rendered image', () => {
  assert.deepEqual(centeredSquareCrop(400, 300), { x: 80, y: 30, size: 240 });
  assert.deepEqual(centeredSquareCrop(200, 500), { x: 20, y: 170, size: 160 });
});

test('moving a crop remains inside image bounds', () => {
  const crop = { x: 20, y: 30, size: 160 };
  assert.deepEqual(moveSquareCrop(crop, -100, 500, 300, 250), { x: 0, y: 90, size: 160 });
});

test('resizing remains square and respects minimum and image bounds', () => {
  const crop = { x: 40, y: 30, size: 160 };
  assert.deepEqual(resizeSquareCrop(crop, 200, 100, 300, 260), { x: 40, y: 30, size: 230 });
  assert.deepEqual(resizeSquareCrop(crop, -500, -300, 300, 260), { x: 40, y: 30, size: 48 });
});

test('food and recipe editors both use the shared pointer-event cropper', () => {
  for (const path of ['src/routes/FoodEditor.svelte', 'src/routes/MealEditor.svelte']) {
    assert.match(readFileSync(path, 'utf8'), /<ImageCropper/);
  }
  const component = readFileSync('src/components/ui/ImageCropper.svelte', 'utf8');
  assert.match(component, /on:pointerdown/);
  assert.match(component, /on:pointermove/);
  assert.match(component, /crop-resize-handle/);
});
