/**
 * Searching your own foods offline (Add food from the Diary) reads the
 * browser's copy of them, which only the Foods screen used to fill: a fresh
 * browser that opened only the Diary found none. The app now fills the copy
 * once per account on first load.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('warming the copy reads foods, meals and recipes through the wrapped API, and only online', async () => {
  const { warmOfflineCatalog } = await import('../src/lib/offline-catalog.js');
  const calls = [];
  const api = { getFoods: async () => calls.push('foods'), getMeals: async () => calls.push('meals'), getRecipes: async () => calls.push('recipes') };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  assert.equal(await warmOfflineCatalog(api), true);
  assert.deepEqual(calls, ['foods', 'meals', 'recipes']);
  calls.length = 0;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  assert.equal(await warmOfflineCatalog(api), false);
  assert.deepEqual(calls, [], 'nothing asked for while offline');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  assert.equal(await warmOfflineCatalog({ getFoods: async () => { throw new Error('down'); } }), false, 'a failure is left for the next load');
});

test('the web app warms it once per account after sign-in, not on Android', () => {
  const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /\$: if \(!isNative && authLoaded && \$currentUser\?\.id != null && _catalogWarmedFor !== \$currentUser\.id\) \{/);
  assert.match(app, /off\.warmOfflineCatalog\(NtApi\)/);
});
