import assert from 'node:assert/strict';
import test from 'node:test';

import { originalUrlForCachedImage } from '../src/lib/image-cache-map.js';

const cached = 'https://localhost/_capacitor_file_/data/image_cache/k9s3a.jpg';

test('restores a relative server upload from a hashed Android cache path', () => {
  const map = {
    '/uploads/image-abc123.jpg': cached,
    'https://food.example/uploads/image-abc123.jpg': cached,
  };
  assert.equal(originalUrlForCachedImage(cached, map), '/uploads/image-abc123.jpg');
});

test('normalizes an absolute server upload to a relative upload path', () => {
  const map = {
    'https://food.example/nutritrace/uploads/image-abc123.jpg': cached,
  };
  assert.equal(originalUrlForCachedImage(cached, map), '/uploads/image-abc123.jpg');
});

test('restores the full external URL instead of its pathname-only cache key', () => {
  const map = {
    '/images/products/front.en.400.jpg': cached,
    'https://images.openfoodfacts.org/images/products/front.en.400.jpg': cached,
  };
  assert.equal(
    originalUrlForCachedImage(cached, map),
    'https://images.openfoodfacts.org/images/products/front.en.400.jpg'
  );
});

test('unwraps a cached server proxy URL', () => {
  const source = 'https://images.example/photo.jpg';
  const map = {
    [`https://food.example/api/proxy?url=${encodeURIComponent(source)}`]: cached,
  };
  assert.equal(originalUrlForCachedImage(cached, map), source);
});

test('returns null for a local file absent from the cache map', () => {
  assert.equal(originalUrlForCachedImage(cached, {}), null);
});
