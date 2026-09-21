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

test('signing out in a dead zone asks before discarding what is waiting', () => {
  // Clearing the queue on a sign-out that could not send it would destroy work
  // the user never saw fail.
  assert.match(auth, /const sent = await flushOutbox\(\)\.catch\(\(\) => false\)/);
  assert.match(auth, /if \(!sent && \(await pendingCount\(\)\) > 0\)/);
  assert.match(auth, /if \(!ok\) return;/);
  assert.ok(en.sync.sign_out_waiting && en.sync.sign_out_anyway, 'the copy exists');
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
  assert.match(offline, /indexedDB\.open\(name, 4\)/);
  assert.match(offline, /objectStoreNames\.contains\('fasts'\)/);
  assert.match(offline, /objectStoreNames\.contains\('reads'\)/);
  assert.match(offline, /objectStoreNames\.contains\('meta'\)/);
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

test('the queue keeps its owner, even when the app cannot confirm who that is', () => {
  // The database is named after the user. If the id is ever cleared (a reload
  // with no connection looks exactly like a failed auth check) the queue would
  // be orphaned in a database nothing reads. LiftTrace lost work this way.
  assert.match(offline, /const _USER_KEY = 'nt:offline-user'/);
  assert.match(offline, /else user = localStorage\.getItem\(_USER_KEY\)/);
  // Sign-out is the one thing that forgets it.
  assert.match(offline, /localStorage\.removeItem\(_USER_KEY\)/);
});

test('what was kept before sign-in follows the user, rather than being stranded', () => {
  // The first reads of a page land before the app knows who is signed in.
  assert.match(offline, /async function _absorb\(/);
  assert.match(offline, /if \(leaving\) p\.then\(db => _absorb\(leaving, db\)\)/);
  assert.match(offline, /indexedDB\.deleteDatabase\(oldName\)/);
  // Queued work is re-added so it cannot land on another row's number.
  assert.match(offline, /const \{ seq, \.\.\.rest \} = row; s\.add\(rest\)/);
});

test('a refusal from the server is said in words, not just a red cloud', () => {
  assert.match(offline, /console\.error\(`\[offline\] your server refused what was waiting/);
  assert.match(app, /sync\.refused/);
  assert.ok(en.sync.refused, 'the copy exists');
  // The work is kept and retried, never dropped on a refusal.
  assert.match(offline, /_scheduleFlush\(_backoff\(\)\)/);
});

test('your profile and its picture work the same way here as in the sibling apps', () => {
  // One shape in all three: the picture goes through the API layer, which
  // embeds it when there is no connection; the save goes through the API
  // layer, so the queue sees it; the server turns the embedded picture into
  // a file at the route.
  assert.match(api, /updateProfile\(data\)\s+\{ return this\.put\('\/api\/auth\/profile', data\); \}/);
  assert.match(offline, /async updateProfile\(data\)/);
  assert.match(offline, /embeddableDataUrl\(file\)/);
  assert.match(offline, /_queueRequest\('your profile', 'profile', 'PUT', '\/api\/auth\/profile', data\)/);
  const profile = readFileSync(new URL('../src/routes/Profile.svelte', import.meta.url), 'utf8');
  assert.match(profile, /await NtApi\.updateProfile\(/);
  assert.ok(!/fetch\(apiUrl\('\/api\/auth\/profile'\)/.test(profile), 'no raw fetch around the API layer');
  // And the screen decides local mode reactively, so opening it before the
  // auth check answers cannot write a profile to local settings instead.
  assert.match(profile, /\$: _isLocal = /);
  const auth = readFileSync(new URL('../server/routes/auth.js', import.meta.url), 'utf8');
  assert.match(auth, /await localizeImage\(req\.body\?\.avatar_url\)/);
});

test('what a row created offline became is remembered on disk, not just in memory', () => {
  // A flush that stops halfway leaves queued work pointing at a row the
  // server has just created. NoteTrace has always kept this map; the others
  // now do too.
  assert.match(offline, /async function _loadSwapped\(\)/);
  assert.match(offline, /_tx\('meta', 'readwrite', s => s\.put\(_swapped, 'idMap'\)\)/);
});

test('nothing the offline path needs is fetched at the moment it is needed', () => {
  // A picture is kept exactly when there is no connection to fetch a
  // separate file with, and an installed app whose service worker has not
  // taken the newest build yet has no copy of one. Reported from a real
  // install as "Failed to fetch dynamically imported module".
  assert.match(offline, /^import \{ embeddableDataUrl \} from '\.\/image-embed\.js';$/m);
  assert.ok(!/await import\('\.\/image-embed\.js'\)/.test(offline), 'the helper is bundled, not fetched');
});
