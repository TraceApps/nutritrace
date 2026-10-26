import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// Exercise the real native server API with only device storage/sync mocked.
// Profile saves must reach the server, rather than depend on diary sync.
async function nativeApi() {
  const result = await build({
    entryPoints: [new URL('../src/lib/api-cached.js', import.meta.url).pathname],
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'device-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => args.kind === 'dynamic-import' ? { path: args.path, external: true } : undefined);
      builder.onResolve({ filter: /^\.\/(db-native|platform|sync|adaptive-tdee-local)\.js$/ }, args => ({ path: args.path, namespace: 'device' }));
      builder.onLoad({ filter: /.*/, namespace: 'device' }, args => {
        if (args.path === './platform.js') return { contents: `
          export const getServerUrl = () => 'https://example.invalid/nutritrace';
          export const getAuthToken = () => 'test-session-token';
          export const apiUrl = path => getServerUrl() + path;
          export const resolveAssetUrl = value => value;
          export const restoreCachedAssetUrl = value => value;
        ` };
        if (args.path === './sync.js') return { contents: `
          export function schedulePush() { throw new Error('Profile must not use diary sync'); }
          export function flushCompletionOps() { throw new Error('Unexpected completion sync'); }
        ` };
        // The static imports are the local diary/catalog operations. Throw
        // if profile saving accidentally writes to those tables.
        const names = ['dbGetFoods', 'dbGetFood', 'dbCreateFood', 'dbUpdateFood', 'dbDeleteFood', 'dbCopyFood', 'dbBumpFoodUsage',
          'dbGetMeals', 'dbGetMeal', 'dbCreateMeal', 'dbUpdateMeal', 'dbDeleteMeal', 'dbCopyMeal', 'dbBumpMealUsage',
          'dbGetDiaryDate', 'dbSaveDiaryDate', 'dbGetAllDiary', 'dbSetDiaryCompletion', 'dbSetMealCompletion', 'dbQueueCompletionOp'];
        return { contents: names.map(name => `export function ${name}() { throw new Error('Unexpected local storage write'); }`).join('\n') };
      });
    } }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).NtApiCached;
}

test('Android profile save sends birthday/gender with session auth and returns the saved user', async t => {
  const api = await nativeApi();
  const profile = { full_name: 'Test User', nickname: 'Test', birthday: '1990-02-03', gender: 'female', avatar_url: '', email: '' };
  const savedUser = { id: 7, username: 'test-user', role: 'admin', ...profile };
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    assert.equal(url, 'https://example.invalid/nutritrace/api/auth/profile');
    assert.equal(options.method, 'PUT');
    assert.equal(options.headers.Authorization, 'Bearer test-session-token');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.credentials, 'include');
    assert.deepEqual(JSON.parse(options.body), profile);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ user: savedUser });
  });
  assert.deepEqual(await api.updateProfile(profile), { user: savedUser });
  assert.equal(requests, 1);
});

test('Android profile save propagates auth failures and offline errors instead of claiming success', async t => {
  const api = await nativeApi();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Not authenticated' }, { status: 401 }));
  await assert.rejects(() => api.updateProfile({ birthday: '1990-02-03', gender: 'female' }), /401/);
  fetchMock.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(() => api.updateProfile({ birthday: '1990-02-03', gender: 'female' }), /Failed to fetch/);
});
