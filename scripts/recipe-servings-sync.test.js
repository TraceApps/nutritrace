import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { once } from 'node:events';
import test, { after } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-recipe-sync-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'recipe-sync-test-only';

const { default: db } = await import('../server/db.js');
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
    ['resolveAssetUrl', 'setImageMap'], {
      Capacitor: { isNativePlatform: () => true }, localStorage,
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

test('background sync preserves servings even without an image cache', async () => {
  const f = fixture({ useCache: false });
  await f.api.updateMeal(f.id, { ...await f.api.getMeal(f.id), servings: 12 });
  await f.requests[0].promise;
  assert.equal(f.row().servings, 12);
  await f.pushChanges();
  assert.equal(f.row().servings, 12);
});

test('explicit photo removal and unset servings still survive save and sync', async () => {
  const f = fixture({ useCache: false });
  await f.api.updateMeal(f.id, { ...await f.api.getMeal(f.id), imgUrl: '', servings: null });
  await f.requests[0].promise;
  await f.pushChanges();
  assert.deepEqual(f.row(), { img_url: null, servings: null });
});
