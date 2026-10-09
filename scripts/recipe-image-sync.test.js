import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { once } from 'node:events';
import test, { after } from 'node:test';
import { originalUrlForCachedImage } from '../src/lib/image-cache-map.js';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-recipe-sync-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.UPLOADS_PATH = join(temp, 'uploads');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'recipe-sync-test-only';

const { default: db } = await import('../server/db.js');
const { freshenItemImages } = await import('../server/lib/diary-helpers.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: meals } = await import('../server/routes/meals.js');
const { default: sync } = await import('../server/routes/sync.js');
const app = express();
app.use(express.json());
app.use('/api/meals', meals);
app.use('/api/sync', sync);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(temp, { recursive: true, force: true });
});

// Execute the client modules with native SQLite and Capacitor boundaries
// supplied by the fixture. Only module syntax/Vite's build flag are removed;
// the production API mapping and complete pushChanges implementation run here.
function loadClient(file, names, bindings) {
  const source = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/^export\s+/gm, '')
    .replaceAll('import.meta.env.DEV', 'false');
  return runInNewContext(`${source}\n;({${names.join(',')}})`, {
    console, URL, AbortSignal, ...bindings,
  }, { filename: file });
}

const original = '/uploads/1789925006553-d5692c924146.jpg';
const cached = 'https://app.nutritrace.local/_capacitor_file_/data/image_cache/9a82x.jpg';

function fixture({ offline = false, useCache = true } = {}) {
  const id = Number(db.prepare(
    `INSERT INTO meals (name, items, img_url, is_recipe, servings, updated_at)
     VALUES ('Bread test', '[]', ?, 1, NULL, '2000-01-01 00:00:00')`
  ).run(original).lastInsertRowid);
  let local = { ...db.prepare('SELECT * FROM meals WHERE id=?').get(id), server_id: id,
    items: [], nutrition: {}, sync_status: 'synced' };
  const requests = [];
  const storage = new Map([['nt:serverUrl', base]]);
  const localStorage = { getItem: key => storage.get(key) ?? null };
  const platform = loadClient('platform.js',
    ['resolveAssetUrl', 'restoreCachedAssetUrl', 'setImageMap'], {
      Capacitor: { isNativePlatform: () => true }, localStorage, originalUrlForCachedImage,
    });
  platform.setImageMap(useCache ? { [original]: cached, [base + original]: cached } : {});
  const bindings = {
    ...platform, localStorage,
    getServerUrl: () => base, getAuthToken: () => null, apiUrl: path => base + path,
    dbGetMeal: async () => local,
    dbUpdateMeal: async (_id, row) => {
      local = { ...local, ...row, sync_status: 'pending',
        updated_at: new Date(Date.now() + 1000).toISOString() };
      return local;
    },
    schedulePush: () => {},
    dbGetPendingChanges: async () => ({ foods: [], meals: [local], diary: [] }),
    dbGetPendingSettings: async () => [], dbGetPendingWorkouts: async () => [],
    // Account check, completion marks and diary ids: nothing to do here.
    localDataIsThisAccount: async () => true, dbGetCompletionOps: async () => [],
    dbDeleteCompletionOp: async () => {}, dbQueueCompletionOp: async () => null,
    dbLinkDiaryItems: async () => 0, dbApplyServerWinner: async () => {}, dbSetClockOffset: async () => {}, serverKeepsNotes: async () => true, dbInstallId: async () => 'test-install', accountGeneration: () => 0,
    dbGetPendingDiaryTombstones: async () => ({}),
    dbSetServerId: async () => {}, dbMarkSynced: async () => {},
    dbMarkWellnessSynced: async () => {}, dbPurgeSoftDeleted: async () => {},
    writable: value => ({ update: fn => { value = fn(value); } }),
    fetch: (url, options) => {
      const promise = offline && options.method === 'PUT'
        ? Promise.reject(new Error('simulated offline save'))
        : fetch(url, options).then(response => {
          assert.equal(response.status, 200);
          return response;
        });
      requests.push({ body: JSON.parse(options.body), promise });
      return promise;
    },
  };
  const { NtApiCached: api } = loadClient('api-cached.js', ['NtApiCached'], bindings);
  const { pushChanges } = loadClient('sync.js', ['pushChanges'], bindings);
  return {
    api, id, pushChanges, requests,
    row: () => db.prepare('SELECT img_url, servings FROM meals WHERE id=?').get(id),
  };
}

test('editing a recipe preserves its cached image through PUT and sync', async () => {
  const f = fixture();
  const meal = await f.api.getMeal(f.id);
  assert.equal(meal.imgUrl, cached);
  await f.api.updateMeal(f.id, { ...meal, servings: null });
  await f.requests[0].promise;
  assert.deepEqual(f.row(), { img_url: original, servings: null });
  await f.pushChanges();
  assert.deepEqual(f.row(), { img_url: original, servings: null });
});

test('offline recipe edit retains its image when pushed later', async () => {
  const f = fixture({ offline: true });
  await f.api.updateMeal(f.id, { ...await f.api.getMeal(f.id), servings: null });
  await assert.rejects(f.requests[0].promise, /simulated offline/);
  await f.pushChanges();
  assert.deepEqual(f.row(), { img_url: original, servings: null });
});

test('explicit photo removal and unset servings still survive save and sync', async () => {
  const f = fixture();
  await f.api.updateMeal(f.id, { ...await f.api.getMeal(f.id), imgUrl: '', servings: null });
  await f.requests[0].promise;
  await f.pushChanges();
  assert.deepEqual(f.row(), { img_url: null, servings: null });
});

test('a recipe photo supplied inline on edit is stored as a file and visible in the diary', async () => {
  const f = fixture();
  const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(64)]);
  await f.api.updateMeal(f.id, {
    ...await f.api.getMeal(f.id), imgUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  });
  await f.requests[0].promise;
  const image = f.row().img_url;
  assert.match(image, /^\/uploads\//);
  assert.deepEqual(readFileSync(join(temp, image)), bytes);
  assert.equal(freshenItemImages([{ id: f.id, name: 'Bread test', is_recipe: true }])[0].imgUrl, image);
});
