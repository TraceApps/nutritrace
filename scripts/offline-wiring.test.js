/**
 * The browser's offline mode is wired where it should be. Text checks, so they
 * run without a browser; behaviour is covered by offline-edits.test.js and the
 * end-to-end run in design/tools/offline-flow.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const api = read('../src/lib/api.js');
const offline = read('../src/lib/offline-api.js');
const app = read('../src/App.svelte');
const auth = read('../src/stores/auth.js');
const foods = read('../src/routes/Foods.svelte');
const settings = read('../src/stores/settings.js');
const diaryScreen = read('../src/routes/Diary.svelte');
const en = JSON.parse(read('../src/i18n/en.json'));

test('the web API is the HTTP one wrapped for offline, and native is untouched', () => {
  assert.match(api, /import \{ createOfflineApi \} from '\.\/offline-api\.js'/);
  assert.match(api, /impl = _webApi\(\);\s+implName = 'HTTP'/);
  // Native keeps its own SQLite paths.
  assert.match(api, /impl = NtApiNative;/);
  assert.match(api, /impl = NtApiCached;/);
});

test('reads that must answer offline are mirrored', () => {
  for (const method of ['getDiaryDate', 'getAllDiary', 'getFoods', 'getFood', 'getMeals', 'getRecipes']) {
    assert.ok(offline.includes(`'${method}'`) || offline.includes(`async ${method}(`), `${method} should be mirrored`);
  }
});

test('the queue goes up through the same sync push the phone uses', () => {
  assert.match(offline, /_post\('\/api\/sync\/push'/);
  // and the queue can send even before a screen has built the API wrapper
  assert.match(offline, /if \(_http\) return _http\.post\(path, body\)/);
});

test('sending is guarded across tabs and retries with a backoff', () => {
  assert.match(offline, /navigator\.locks\.request\('nutritrace-offline-flush'/);
  assert.match(offline, /navigator\.locks\?\.request/); // guarded for browsers without it
  assert.match(offline, /new BroadcastChannel\('nutritrace-offline'\)/);
  assert.match(offline, /RETRY_MIN_MS = 3_000/);
  assert.match(offline, /RETRY_MAX_MS = 30_000/);
  // Safari has no Background Sync, and iPhone is the point of this work.
  assert.ok(!/BackgroundSync|sync\.register/.test(offline));
  assert.match(offline, /addEventListener\('online'/);
});

test('the header badge reports the queue on the web', () => {
  assert.match(app, /import \{ offlineState \} from '\.\/lib\/offline-api\.js'/);
  assert.match(app, /_webOffline = !isNative &&/);
  assert.match(app, /_webFailing = !isNative && !!\$offlineState\.error/);
  assert.ok(en.sync.pending_web, 'sync.pending_web copy exists');
});

test('signing out sends what is waiting, then clears the mirror', () => {
  const i = auth.indexOf('flushOutbox');
  assert.ok(i > 0, 'logout flushes the outbox');
  assert.ok(auth.indexOf('clearOffline') > i, 'and clears only afterwards');
});

test('offline says why the other sources are empty, rather than showing zero', () => {
  // Open Food Facts, USDA, Mealie and CookTrace all need the network.
  assert.match(foods, /_sourcesOffline = \$offlineState\.online === false/);
  assert.match(foods, /if \(_sourcesOffline\) \{/);
  for (const key of ['foods.offline.source', 'foods.offline.search_hint', 'foods.offline.barcode', 'foods.offline.import']) {
    assert.ok(foods.includes(`$_('${key}')`), `${key} is shown somewhere`);
  }
  assert.ok(en.foods.offline.source && en.foods.offline.search_hint && en.foods.offline.barcode && en.foods.offline.import);
});

test('a barcode scanned offline does not read as an unknown product', () => {
  const scan = foods.slice(foods.indexOf('_normBarcode(code)'));
  assert.ok(scan.indexOf("foods.offline.barcode") < scan.indexOf('Not in Open Food Facts'), 'the offline case is handled before the not-found message');
});

test('a setting changed offline is queued rather than lost', () => {
  // Settings push themselves, so they never pass through the API wrapper.
  assert.match(settings, /const \{ queueSetting \} = await import\('\.\.\/lib\/offline-api\.js'\)/);
  assert.match(settings, /if \(!isNative\) \{/);
});

test('a photo that cannot load falls back to the placeholder', () => {
  assert.match(diaryScreen, /_brokenThumbs/);
  assert.match(diaryScreen, /on:error=\{\(\) => \{ _brokenThumbs/);
});

test('the fasting widget works offline, by path', () => {
  // The fasting store calls the server by path, not through a named method.
  assert.match(offline, /const _FASTS = /);
  for (const m of ['async get(path', 'async post(path', 'async patch(path', 'async del(path']) {
    assert.ok(offline.includes(m), `${m} is intercepted`);
  }
  // Anything that isn't fasting still goes to the server, and says so offline.
  assert.match(offline, /_through\(http, 'get', path, rest\)/);
  assert.match(offline, /async function _through\(/);
  // One fast at a time, as the server insists.
  assert.match(offline, /A fast is already in progress/);
  assert.match(offline, /'fasts', 'fasts', 'create', newTempId\(\)/);
});

test('a row created offline is changed by its real id after the queue goes up', () => {
  assert.match(offline, /const _realId = /);
  // Every change by id, and the fasting paths, go through the map.
  for (const m of ['async updateFood(id, data) {\n      id = _realId(id);',
                   'async deleteFood(id) {\n      id = _realId(id);',
                   'async updateMeal(id, data) {\n      id = _realId(id);',
                   'async deleteMeal(id) {\n      id = _realId(id);',
                   'async updateActivity(id, data) {\n      id = _realId(id);',
                   'async deleteActivity(id) {\n      id = _realId(id);']) {
    assert.ok(offline.includes(m), `${m.split('(')[0]} translates the id`);
  }
  assert.equal(offline.match(/path = _fixFastPath\(path\);/g).length, 3, 'post, patch and delete');
  // Other tabs learn the new ids with the outbox message.
  assert.match(offline, /_channel\?\.postMessage\(\{ type: 'outbox', ids: map \}\)/);
  assert.match(offline, /if \(e\.data\.ids\) _swapped = /);
});

test('new mirror stores reach testers who already have the database', () => {
  // Bumped whenever a store is added, or onupgradeneeded never runs for them.
  assert.match(offline, /indexedDB\.open\(name, 3\)/);
  assert.match(offline, /objectStoreNames\.contains\('fasts'\)/);
  assert.match(offline, /objectStoreNames\.contains\('reads'\)/);
  // and sign-out clears it with the rest
  assert.match(offline, /_tx\('fasts', 'readwrite', s => s\.clear\(\)\)/);
});

test('the mirror forgets what the server no longer has', () => {
  // A food deleted on another device used to live on in the browser's copy:
  // gone while online, back the moment the connection dropped.
  assert.match(offline, /async function _replace\(/);
  for (const call of ["_replace('foods', foods)", "_replace('meals', meals)", "_replace('recipes', recipes)",
                      "_replace('activity'", "_replace('diary', days"]) {
    assert.ok(offline.includes(call), `${call} prunes the mirror`);
  }
  // Rows still waiting to go up are not the server's to forget.
  assert.match(offline, /isTempId\(old\.id\)/);
});

test("a day's wellness figures stay on screen with no connection", () => {
  assert.match(offline, /const _KEEP_READS = /);
  assert.match(offline, /wellness\\\/\[\\w-\]\+\\\/data/);
  assert.match(offline, /_tx\('reads', 'readwrite'/);
  // Authorising a provider or asking it to sync is not kept.
  assert.ok(!/authorize|disconnect/.test(offline.match(/const _KEEP_READS = \[[\s\S]*?\];/)[0]));
});
