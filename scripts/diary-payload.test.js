import assert from 'node:assert/strict';
import test from 'node:test';

import { stripInlineDiaryImages } from '../src/lib/diary-payload.js';

test('stripInlineDiaryImages removes only inline snapshot images', () => {
  const items = [
    { id: 1, imgUrl: 'data:image/jpeg;base64,abc', name: 'Photo food' },
    { id: 2, imgUrl: '/uploads/food.jpg' },
    { id: 3, imgUrl: 'https://images.example/food.jpg' },
  ];

  assert.deepEqual(stripInlineDiaryImages(items), [
    { id: 1, imgUrl: '', name: 'Photo food' },
    items[1],
    items[2],
  ]);
  assert.equal(items[0].imgUrl, 'data:image/jpeg;base64,abc');
});

test('stripInlineDiaryImages preserves the original array when unchanged', () => {
  const items = [{ id: 1, imgUrl: '/uploads/food.jpg' }];
  assert.equal(stripInlineDiaryImages(items), items);
  assert.equal(stripInlineDiaryImages(null), null);
});
