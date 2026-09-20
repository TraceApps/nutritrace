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
  assert.match(offline, /_http\.post\('\/api\/sync\/push'/);
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
