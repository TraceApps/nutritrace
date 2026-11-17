/**
 * Import All Recipes lists the whole CookTrace catalog (#329) and waits out
 * CookTrace's rate limit instead of skipping what's left (#330).
 *
 * CookTrace allows each token 60 requests a minute by default and answers
 * 429 with Retry-After past that. The import makes one request per recipe,
 * so a big catalog always reaches it: it used to count every recipe after
 * that as skipped and still show a green toast.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test, { after } from 'node:test';

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { DB } = await import('../src/lib/db.js');
const { CookTrace, withRateLimitWait, listAllRecipeIds } = await import('../src/lib/cooktraceApi.js');

DB.getSetting = (key, fallback) => ({ cooktraceBaseUrl: 'http://ct.test', cooktraceApiToken: 't' }[key] ?? fallback);

async function withFetch(reply, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body).path);
    const r = typeof reply === 'function' ? reply(calls.length) : reply;
    return { ok: r.status < 400, status: r.status, headers: new Headers(r.headers || {}), json: async () => r.body };
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

test('an empty search makes no request (the Foods search)', async () => {
  await withFetch({ status: 200, body: { items: [{ id: 1 }], total: 1 } }, async (calls) => {
    const meta = await CookTrace.searchWithMeta('', 1, 50);
    assert.deepEqual(meta.items, []);
    assert.equal(calls.length, 0);
  });
});

test('the import lists the catalog a page at a time, and reads the rate limit', async () => {
  await withFetch({ status: 429, headers: { 'Retry-After': '37' }, body: { error: 'Rate limited' } }, async (calls) => {
    const r = await CookTrace.listRecipesRaw(100, 50);
    assert.deepEqual(calls, ['/api/v1/recipes?q=&limit=50&offset=100']);
    assert.equal(r.status, 429);
    assert.equal(r.retryAfter, 37);
  });
  await withFetch({ status: 200, body: { id: 7 } }, async (calls) => {
    const r = await CookTrace.getRecipeRaw(7);
    assert.deepEqual(calls, ['/api/v1/recipes/7']);
    assert.equal(r.ok, true);
    assert.equal(r.retryAfter, null);
  });
});

// A clock that moves only when the wait sleeps.
function fakeClock() {
  let t = 1_000_000;
  const slept = [];
  return { now: () => t, sleep: async ms => { slept.push(ms); t += ms; }, slept };
}

test('a 429 waits as long as CookTrace says, then asks again', async () => {
  const clock = fakeClock(), waits = [];
  let n = 0;
  const r = await withRateLimitWait(async () => (++n < 3 ? { status: 429, retryAfter: 2 } : { ok: true, status: 200, body: 'recipe' }), {
    ...clock, onWait: left => waits.push(left),
  });
  assert.equal(r.body, 'recipe');
  assert.equal(n, 3);
  assert.equal(clock.slept.reduce((a, b) => a + b, 0), 6000, '2s + 1s, twice');
  assert.deepEqual(waits, [3, 2, 1, 0, 3, 2, 1, 0]);
});

test('the wait ends on time when timers run late (a hidden tab, a locked phone)', async () => {
  let t = 0;
  const late = { now: () => t, sleep: async () => { t += 60_000; } }; // every timer a minute late
  let n = 0, sleeps = 0;
  await withRateLimitWait(async () => (++n === 1 ? { status: 429, retryAfter: 41 } : { ok: true, status: 200 }), {
    now: late.now, sleep: async ms => { sleeps++; await late.sleep(ms); },
  });
  assert.equal(n, 2);
  assert.equal(sleeps, 1, 'one late timer, not 42 of them');
});

test('no Retry-After waits 30s; never more than 2 minutes; gives up after 5 waits in a row', async () => {
  let clock = fakeClock();
  await withRateLimitWait(async () => (clock.slept.length ? { ok: true, status: 200 } : { status: 429, retryAfter: null }), clock);
  assert.equal(clock.slept.reduce((a, b) => a + b, 0), 31_000);
  clock = fakeClock();
  await withRateLimitWait(async () => (clock.slept.length ? { ok: true, status: 200 } : { status: 429, retryAfter: 9999 }), clock);
  assert.equal(clock.slept.reduce((a, b) => a + b, 0), 120_000);
  let calls = 0;
  const r = await withRateLimitWait(async () => { calls++; return { status: 429, retryAfter: 1 }; }, fakeClock());
  assert.equal(r.status, 429);
  assert.equal(calls, 6, 'the first try and 5 more');
  // Anything else is answered at once.
  calls = 0;
  const gone = await withRateLimitWait(async () => { calls++; return { status: 404 }; }, { sleep: async () => { throw new Error('no wait'); } });
  assert.equal(gone.status, 404);
  assert.equal(calls, 1);
  // A request that throws (no connection) answers status 0.
  const down = await withRateLimitWait(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(down.status, 0);
  assert.equal(down.ok, false);
});

// The catalog as CookTrace pages it: `pages` answers request by request.
async function listWith(pages) {
  const asked = [];
  const real = CookTrace.listRecipesRaw;
  CookTrace.listRecipesRaw = async (offset, limit) => { asked.push(offset); return pages[asked.length - 1]; };
  try { return { ...(await listAllRecipeIds(call => call(), { page: 2 })), asked }; }
  finally { CookTrace.listRecipesRaw = real; }
}
const pageOf = (ids, total) => ({ ok: true, status: 200, body: { items: ids.map(id => ({ id })), total } });

test('listing goes up to the total CookTrace reports, a page at a time', async () => {
  const r = await listWith([pageOf([1, 2], 5), pageOf([3, 4], 5), pageOf([5], 5)]);
  assert.deepEqual(r.ids, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.asked, [0, 2, 4]);
});

test('a short page goes on to the total; an empty page ends it', async () => {
  const short = await listWith([pageOf([1], 3), pageOf([2, 3], 3)]);
  assert.deepEqual(short.ids, [1, 2, 3]);
  const empty = await listWith([pageOf([1, 2], 9), pageOf([], 9)]);
  assert.deepEqual(empty.ids, [1, 2]);
  assert.equal(empty.asked.length, 2);
});

test('a recipe that moved to another page while listing is kept once', async () => {
  const r = await listWith([pageOf([5, 4], 4), pageOf([4, 3], 4)]);
  assert.deepEqual(r.ids, [5, 4, 3]);
});

test("a page that can't be read stops the listing with the answer, importing nothing", async () => {
  const r = await listWith([pageOf([1, 2], 6), { ok: false, status: 429, retryAfter: 30 }]);
  assert.equal(r.ok, false);
  assert.equal(r.failed.status, 429);
  assert.deepEqual(r.ids, []);
});

test('Import All lists and fetches through the wait, and never shows a green toast for skipped recipes', () => {
  const src = readFileSync(new URL('../src/routes/settings/ConnectedServices.svelte', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function _ctBulkImport()'), src.indexOf('async function _ctBulkImportPantry()'));
  assert.match(fn, /listAllRecipeIds\(_ctPaced\)/);
  assert.match(fn, /_ctPaced\(\(\) => CookTrace\.getRecipeRaw\(id\)\)/);
  assert.match(fn, /if \(skipped\) \{\s*showError\(/);
  assert.match(fn, /reason: \[\.\.\.reasons\]\.join\('; '\)/, 'every reason, not just the first');
  assert.match(fn, /NtApi\.getRecipes\(\)/, 'imports are recipes: a re-run counts them as updated');
  assert.match(fn, /existingSet\.add\(mapped\.source_external_id\)/);
  // One import at a time, also across a return to Settings.
  assert.match(src, /<script context="module">[\s\S]*let _ctImportRunning = false;/);
  assert.match(fn, /_ctImportRunning = true;[\s\S]*finally \{[\s\S]*_ctImportRunning = false;/);
  // No answer, or the proxy's 502/503/504, reads as "couldn't be reached".
  assert.match(src, /\[0, 502, 503, 504\]\.includes\(r\.status\) \? \$_\('settings\.connected_services\.cooktrace_import\.not_reached'\)/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  for (const k of ['waiting', 'running', 'list_failed', 'some_skipped', 'not_reached', 'deleted', 'rate_limited', 'http']) {
    assert.ok(en.settings.connected_services.cooktrace_import[k], k);
  }
});

// ── The server's proxy passes CookTrace's answer, rate limit included ──
const temp = mkdtempSync(join(tmpdir(), 'nutritrace-ct-ratelimit-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'ct-ratelimit-test-only';
const { default: db } = await import('../server/db.js');
const { default: express } = await import('../server/node_modules/express/index.js');
const { default: cooktrace } = await import('../server/routes/cooktrace.js');

// A CookTrace that allows 2 requests, then 429s with its real headers.
let served = 0;
const ct = createServer((req, res) => {
  served++;
  if (served > 2) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '41', 'X-RateLimit-Limit': '2', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1794900000' });
    return res.end(JSON.stringify({ error: 'Rate limited', code: 'rate_limited' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-RateLimit-Limit': '2', 'X-RateLimit-Remaining': String(2 - served), 'X-RateLimit-Reset': '1794900000' });
  res.end(JSON.stringify({ id: 1, name: 'Soup' }));
}).listen(0, '127.0.0.1');
await once(ct, 'listening');
const ctBase = `http://127.0.0.1:${ct.address().port}`;
db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('single_user_mode', '1')`).run();
const app = express();
app.use(express.json());
app.use('/api/cooktrace', cooktrace);
const nt = app.listen(0, '127.0.0.1');
await once(nt, 'listening');
after(() => { ct.close(); nt.close(); db.close(); rmSync(temp, { recursive: true, force: true }); });

const viaProxy = () => fetch(`http://127.0.0.1:${nt.address().port}/api/cooktrace/proxy`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ baseUrl: ctBase, token: 'ct_pat_x', path: '/api/v1/recipes/1' }),
});

test("the proxy passes CookTrace's 429 and when to try again", async () => {
  const ok = await viaProxy();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-ratelimit-remaining'), '1');
  await viaProxy();
  const limited = await viaProxy();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '41');
  assert.equal(limited.headers.get('x-ratelimit-reset'), '1794900000');
});

test('the Android app can read those headers (CORS)', () => {
  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(idx, /Access-Control-Expose-Headers', '[^']*Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset'/);
});
