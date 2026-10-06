// NutriTrace's CookTrace and Mealie proxies forward only what the app reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apiPathFor, COOKTRACE_API, MEALIE_API } from '../server/lib/service-paths.js';

test('the requests the app makes go through', () => {
  for (const p of ['/api/v1/recipes?q=soup&limit=5&offset=0', '/api/v1/recipes/abc123', '/api/v1/pantry?q=oats&limit=20&offset=0', '/api/v1/me', '/api/v1/recipes?q=a%2Fb'])
    assert.equal(apiPathFor(COOKTRACE_API, p), p, p);
  for (const p of ['/api/recipes?queryFilter=x&perPage=10&page=1', '/api/recipes/chicken-soup', '/api/recipes?perPage=1&page=1'])
    assert.equal(apiPathFor(MEALIE_API, p), p, p);
});

test('anything else is refused', () => {
  for (const p of ['/api/v1/users', '/api/v1/recipesX', '/admin', 'api/v1/me', '//evil.example/api/v1/me', '/api/v1/me#x',
    '/api/v1/recipes/../admin', '/api/v1/recipes/%2e%2e/admin', '/api/v1/recipes/..%2Fadmin', '/api/v1/recipes/x\\..\\admin', '/api/v1/recipes/x%5c..'])
    assert.equal(apiPathFor(COOKTRACE_API, p), null, p);
  assert.equal(apiPathFor(MEALIE_API, '/api/users/self'), null);
});

test("hidden characters can't turn into a climb out", () => {
  for (const p of ['/api/v1/recipes/.\t./.\t./admin', '/api/v1/recipes/.\n./admin', '/api/v1/recipes/.\r./admin', '/api/v1/recipes/a b', '/api/v1/recipes/\u0000'])
    assert.equal(apiPathFor(COOKTRACE_API, p), null, JSON.stringify(p));
});
