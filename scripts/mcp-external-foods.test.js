/**
 * #314: search_external_foods and log_external_food, against a real temp
 * database and a local stand-in for Open Food Facts and USDA FoodData
 * Central built from their real replies (fixtures/external-food-mock.mjs).
 * Nothing here reaches the network: requests go through the server's own
 * path (lib/external-api.js: allowed hosts, mirror, air gap, size cap) and
 * only the last step, the connection, is pointed at the stand-in.
 *
 * The app's own search (src/lib/api.js) runs on the same replies in a child
 * process, and the results must match: same order, same numbers, same
 * requests.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { answer, USDA_GOOD_KEY, USDA_BAD_KEY } from './fixtures/external-food-mock.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ext-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOADS_PATH = path.join(TMP, 'uploads');
process.env.NODE_ENV = 'test';
delete process.env.OFF_LOCAL_DB;
delete process.env.OFF_LOCAL_ONLY;

let db, registerReadTools, registerWriteTools, registerDestroyTools, ext, foods, offMap, usdaMap, units;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools, registerWriteTools, registerDestroyTools } = await import('../server/lib/mcp/tools/index.js'));
  ext = await import('../server/lib/external-api.js');
  foods = await import('../server/lib/external-foods.js');
  offMap = await import('../src/lib/off-map.js');
  usdaMap = await import('../src/lib/usda-map.js');
  units = await import('../src/lib/units.js');
} catch (e) {
  test('MCP external foods suite skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-external-foods] skipping: ${(e?.message || String(e)).split('\n')[0]}`);
  process.exit(0);
}

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, def, handler) { this.tools.set(name, { def, handler }); }
  call(name, args = {}) {
    const t = this.tools.get(name);
    if (!t) throw new Error(`tool ${name} not registered`);
    return t.handler(args);
  }
}

// ── the stand-in services ──────────────────────────────────────────────────
let mock, mockBase, down = false;
const requests = [];
before(async () => {
  mock = http.createServer((req, res) => {
    const [, host, ...rest] = req.url.split('/');
    const real = `https://${host}/${rest.join('/')}`;
    requests.push({ url: real, ua: req.headers['user-agent'], accept: req.headers.accept });
    const { status, body } = answer(real);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;
  ext._setFetchForTests(async (url, init, guard) => {
    guards.push(guard);
    if (down) throw new TypeError('fetch failed');
    const u = new URL(url);
    return fetch(`${mockBase}/${u.hostname}${u.pathname}${u.search}`, { headers: init.headers, signal: init.signal });
  });
  foods._setLocalizeForTests(async (url) => { images.push(url); return '/uploads/test-photo.jpg'; });
});
const images = [];
const guards = [];
after(async () => {
  ext._setFetchForTests(null);
  foods._setLocalizeForTests(null);
  await new Promise(r => mock.close(r));
  try { db.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── users and their tools ──────────────────────────────────────────────────
const user = (name) => db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'user')").run(name).lastInsertRowid;
const setSetting = (uid, key, value) => db.prepare(
  `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
   ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
).run(uid, key, JSON.stringify(value));
const toolsFor = (userId, { writes = true } = {}) => {
  const s = new MockServer();
  registerReadTools(s, { userId });
  if (writes) registerWriteTools(s, { userId });
  return s;
};
const json = (r) => r?.structuredContent;
const text = (r) => r?.content?.[0]?.text || '';
const foodsOf = (uid) => db.prepare('SELECT * FROM foods WHERE user_id = ? ORDER BY id').all(uid);
const dayItems = (uid, date) => JSON.parse(db.prepare('SELECT items FROM diary WHERE user_id = ? AND date = ?').get(uid, date)?.items || '[]');

let alice, bob;
before(() => {
  alice = user('alice-314');
  bob = user('bob-314');
  setSetting(alice, 'usdaEnabled', true);
  setSetting(alice, 'usdaApiKey', USDA_GOOD_KEY);
});

// ── the app's own search on the same replies ───────────────────────────────
const RUNNER = fileURLToPath(new URL('./fixtures/client-food-search.mjs', import.meta.url));
function client(settings, ops) {
  return JSON.parse(execFileSync(process.execPath, [RUNNER, JSON.stringify({ settings, ops })], { encoding: 'utf8', timeout: 60000 }));
}
// What a result says that the app's food says, field by field.
function sameAsApp(item, food, label) {
  assert.ok(food, `${label}: the app found it too`);
  assert.equal(item.name, food.name, `${label}: name`);
  assert.equal(item.brand, food.brand || null, `${label}: brand`);
  assert.equal(item.portion, food.portion, `${label}: portion`);
  assert.equal(item.unit, food.unit, `${label}: unit`);
  assert.equal(item.nutrition_basis, food.nutrition_basis ?? null, `${label}: basis`);
  assert.deepEqual(item.alt_units, food.alt_units || null, `${label}: alt units`);
  assert.deepEqual(item.nutrition, food.nutrition, `${label}: every number`);
  assert.deepEqual(item.nutrients_reported, food._offPresent, `${label}: what the source has`);
}

const SKYR = '4016241040503';   // Arla Skyr Vanilla Fat Free, per 100 g, "1 portion (100 g)"
const COLA = '5449000000996';   // Coca-Cola 330 ml, per-serving values
const NUTELLA = '3017620422003';

// ── wiring ─────────────────────────────────────────────────────────────────

test('search_external_foods is a read tool, log_external_food a write tool only', () => {
  const read = new MockServer(); registerReadTools(read, { userId: alice });
  const write = new MockServer(); registerWriteTools(write, { userId: alice });
  const destroy = new MockServer(); registerDestroyTools(destroy, { userId: alice });
  assert.ok(read.tools.has('search_external_foods'));
  assert.ok(!read.tools.has('log_external_food'), 'no write gate, no log tool');
  assert.ok(write.tools.has('log_external_food'));
  assert.ok(!destroy.tools.has('log_external_food'));
  assert.match(read.tools.get('search_foods').def.description, /search_external_foods/, 'search_foods points at the new tool');
});

// ── search ─────────────────────────────────────────────────────────────────

test('name search: Open Food Facts results in the app\'s order with the app\'s numbers', async () => {
  const before = requests.length;
  const r = await toolsFor(alice).call('search_external_foods', { query: 'arla skyr vanilla', source: 'off', limit: 25 });
  const out = json(r);
  assert.ok(out, text(r));
  assert.deepEqual(out.sources, [{ source: 'off', status: 'ok', count: 8 }]);
  const app = client({}, [{ kind: 'offSearch', query: 'arla skyr vanilla' }]);
  assert.deepEqual(out.items.map(i => i.ref), app.results[0].map(f => `off:${f.barcode}`), 'same ranking');
  out.items.forEach((it, i) => sameAsApp(it, app.results[0][i], it.ref));
  // The same request the app sends through /api/proxy, with the proxy's user agent.
  const sent = requests.slice(before);
  assert.deepEqual(sent.map(s => s.url), app.urls);
  assert.ok(sent.every(s => s.ua === ext.EXTERNAL_USER_AGENT));
  assert.ok(out.items.every(i => i.source === 'off' && /^off:\d+$/.test(i.ref)));
});

test('name search follows the user\'s OFF language and country, like the app', async () => {
  setSetting(bob, 'offSearchLanguage', 'de');
  setSetting(bob, 'offSearchCountry', 'Germany');
  const before = requests.length;
  await toolsFor(bob).call('search_external_foods', { query: 'skyr', source: 'off' });
  const app = client({ offSearchLanguage: 'de', offSearchCountry: 'Germany' }, [{ kind: 'offSearch', query: 'skyr' }]);
  assert.deepEqual(requests.slice(before).map(s => s.url), app.urls);
  assert.match(app.urls[0], /langs=de/);
  assert.match(decodeURIComponent(app.urls[0].replace(/\+/g, ' ')), /countries_tags:"en:germany"/);
  db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key IN ('offSearchLanguage', 'offSearchCountry')").run(bob);
});

test('the limit cuts the ranked list, never more than asked', async () => {
  const out = json(await toolsFor(alice).call('search_external_foods', { query: 'arla skyr', source: 'off', limit: 3 }));
  const full = json(await toolsFor(alice).call('search_external_foods', { query: 'arla skyr', source: 'off', limit: 25 }));
  assert.equal(out.items.length, 3);
  assert.deepEqual(out.items.map(i => i.ref), full.items.slice(0, 3).map(i => i.ref));
});

test('barcode lookup: one product, the app\'s numbers, Import Portion As honored', async () => {
  const r = json(await toolsFor(alice).call('search_external_foods', { barcode: SKYR, source: 'off' }));
  assert.equal(r.items.length, 1);
  const app = client({}, [{ kind: 'offBarcode', code: SKYR }]);
  sameAsApp(r.items[0], app.results[0], 'skyr');
  assert.equal(r.items[0].ref, `off:${SKYR}`);
  assert.deepEqual(r.items[0].serving, { size: '1 portion (100 g)', quantity: 100, unit: 'g' });

  setSetting(bob, 'offImportPortion', 'perServing');
  const cola = json(await toolsFor(bob).call('search_external_foods', { barcode: COLA, source: 'off' })).items[0];
  const appCola = client({ offImportPortion: 'perServing' }, [{ kind: 'offBarcode', code: COLA }]).results[0];
  sameAsApp(cola, appCola, 'cola per serving');
  assert.equal(cola.portion, 330);
  assert.equal(cola.unit, 'ml');
  // OFF marks its kcal figure as an estimate ("~"), so the app uses kJ: 594 / 4.184.
  assert.equal(cola.nutrition.calories, 142);
  db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = 'offImportPortion'").run(bob);
});

test('a barcode OFF does not have is no match, not an error', async () => {
  const r = json(await toolsFor(alice).call('search_external_foods', { barcode: '0000000000017', source: 'off' }));
  assert.deepEqual(r.sources, [{ source: 'off', status: 'no_match', count: 0 }]);
  assert.equal(r.items.length, 0);
});

test('USDA name search: the app\'s data-type ranking and numbers, the user\'s key', async () => {
  const before = requests.length;
  const r = json(await toolsFor(alice).call('search_external_foods', { query: 'greek yogurt plain', source: 'usda', limit: 25 }));
  const app = client({}, [{ kind: 'usdaSearch', query: 'greek yogurt plain', key: USDA_GOOD_KEY }]);
  assert.deepEqual(r.items.map(i => i.fdc_id), app.results[0].map(f => usdaMap.usdaFdcId(f.barcode)), 'same ranking');
  assert.deepEqual(r.items.map(i => i.data_type).slice(0, 3), ['Foundation', 'Foundation', 'SR Legacy'], 'curated tiers first');
  r.items.forEach((it, i) => sameAsApp(it, app.results[0][i], it.ref));
  assert.deepEqual(requests.slice(before).map(s => s.url), app.urls, 'same request, key included');
  assert.ok(r.items.every(i => /^usda:\d+$/.test(i.ref)));
});

test('USDA barcode lookup matches the app', async () => {
  const code = '9421906640038';
  const r = json(await toolsFor(alice).call('search_external_foods', { barcode: code, source: 'usda' }));
  const app = client({}, [{ kind: 'usdaBarcode', code, key: USDA_GOOD_KEY }]);
  assert.equal(r.items.length, 1);
  sameAsApp(r.items[0], app.results[0], 'isey skyr');
  assert.equal(r.items[0].barcode, code);
  assert.equal(r.items[0].ref, 'usda:2183174');
});

test('both sources at once: each answers for itself', async () => {
  const r = json(await toolsFor(alice).call('search_external_foods', { query: 'skyr', limit: 2 }));
  assert.deepEqual(r.sources.map(s => [s.source, s.status, s.count]), [['off', 'ok', 2], ['usda', 'ok', 2]]);
  assert.deepEqual(r.items.map(i => i.source), ['off', 'off', 'usda', 'usda']);
});

test('USDA without a key: a clear error when asked for, a note beside OFF otherwise', async () => {
  const before = requests.length;
  const only = await toolsFor(bob).call('search_external_foods', { query: 'skyr', source: 'usda' });
  assert.equal(only.isError, true);
  assert.match(text(only), /USDA FoodData Central is not set up.*API key/);
  const both = json(await toolsFor(bob).call('search_external_foods', { query: 'skyr' }));
  assert.equal(both.sources.find(s => s.source === 'usda').status, 'not_set_up');
  assert.ok(both.items.length > 0 && both.items.every(i => i.source === 'off'));
  assert.ok(!requests.slice(before).some(s => s.url.includes('api.nal.usda.gov')), 'USDA never asked without a key');
  // A key saved but USDA turned off is the same as no key, like the app.
  setSetting(bob, 'usdaApiKey', USDA_GOOD_KEY);
  assert.equal((await toolsFor(bob).call('search_external_foods', { query: 'skyr', source: 'usda' })).isError, true);
  db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = 'usdaApiKey'").run(bob);
});

test('a USDA key USDA refuses is said plainly', async () => {
  setSetting(alice, 'usdaApiKey', USDA_BAD_KEY);
  const r = await toolsFor(alice).call('search_external_foods', { query: 'skyr', source: 'usda' });
  assert.equal(r.isError, true);
  assert.match(text(r), /refused the API key/);
  setSetting(alice, 'usdaApiKey', USDA_GOOD_KEY);
});

test('Open Food Facts turned off in Settings is not searched', async () => {
  setSetting(bob, 'offEnabled', false);
  const r = await toolsFor(bob).call('search_external_foods', { query: 'skyr', source: 'off' });
  assert.equal(r.isError, true);
  assert.match(text(r), /turned off/);
  db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = 'offEnabled'").run(bob);
});

test('an unreachable source is a clear error, and the other source still answers', async () => {
  down = true;
  try {
    const r = await toolsFor(alice).call('search_external_foods', { query: 'skyr' });
    assert.equal(r.isError, true, 'neither answered');
    assert.match(text(r), /Open Food Facts could not be reached/);
    assert.match(text(r), /USDA FoodData Central could not be reached/);
  } finally { down = false; }
});

test('query or barcode, exactly one', async () => {
  const t = toolsFor(alice);
  assert.equal((await t.call('search_external_foods', {})).isError, true);
  assert.equal((await t.call('search_external_foods', { query: 'x', barcode: '12345678' })).isError, true);
});

test('only the allowed hosts are ever asked, over https', async () => {
  await assert.rejects(ext.fetchExternalJson('https://example.com/x'), (e) => e.code === 'not_allowed');
  await assert.rejects(ext.fetchExternalJson('http://world.openfoodfacts.org/api/v3/product/1'), (e) => e.code === 'not_allowed');
  await assert.rejects(ext.fetchExternalJson('https://world.openfoodfacts.org.evil.example/x'), (e) => e.code === 'not_allowed');
});

test('requests go through the SSRF guard with redirects kept on the same host', () => {
  assert.ok(guards.length > 0);
  for (const g of guards) assert.deepEqual(g, { maxRedirects: 3, sameOrigin: true });
});

test('a reply one source can\'t read is that source\'s error only', async () => {
  const r = json(await toolsFor(alice).call('search_external_foods', { query: 'skyr badshape' }));
  assert.equal(r.sources.find(s => s.source === 'usda').status, 'bad_response');
  assert.equal(r.sources.find(s => s.source === 'off').status, 'ok');
  assert.ok(r.items.length > 0);
});

test('OFF_LOCAL_ONLY alone (no mirror) means no outside request at all', async () => {
  process.env.OFF_LOCAL_ONLY = '1';
  const n = requests.length, g = guards.length, imgs = images.length;
  const frank = user('frank-314');
  try {
    const r = await toolsFor(alice).call('search_external_foods', { query: 'skyr' });
    assert.equal(r.isError, true);
    assert.match(text(r), /OFF_LOCAL_ONLY/);
    const l = await toolsFor(frank).call('log_external_food', { ref: `off:${SKYR}` });
    assert.equal(l.isError, true);
    assert.equal(foodsOf(frank).length, 0);
  } finally {
    delete process.env.OFF_LOCAL_ONLY;
  }
  assert.equal(requests.length, n);
  assert.equal(guards.length, g, 'not even attempted');
  assert.equal(images.length, imgs);
});

test('a reply over the size cap is refused, not read', async () => {
  await assert.rejects(
    ext.fetchExternalJson(`https://search.openfoodfacts.org/search?q=skyr`, { maxBytes: 1000 }),
    (e) => e.code === 'bad_response',
  );
});

// ── logging ────────────────────────────────────────────────────────────────

test('log_external_food saves the product once, as the app would, and logs the amount', async () => {
  const t = toolsFor(alice);
  const before = foodsOf(alice).length;
  const r = await t.call('log_external_food', { ref: `off:${SKYR}`, portion: 200, unit: 'g', meal: 3, date: '2026-11-02' });
  const out = json(r);
  assert.ok(out, text(r));
  assert.equal(out.food.created, true);
  assert.equal(out.food.reused_by, null);
  const rows = foodsOf(alice);
  assert.equal(rows.length, before + 1);
  const row = rows.at(-1);
  assert.equal(row.id, out.food.id);

  // The food: what the app's import writes for this product.
  const app = client({}, [{ kind: 'offBarcode', code: SKYR }]).results[0];
  assert.equal(row.name, app.name);
  assert.equal(row.brand, app.brand);
  assert.equal(row.barcode, SKYR);
  assert.equal(row.portion, app.portion);
  assert.equal(row.unit, app.unit);
  assert.equal(row.nutrition_basis, app.nutrition_basis);
  assert.deepEqual(JSON.parse(row.alt_units), app.alt_units);
  assert.deepEqual(JSON.parse(row.nutrition), app.nutrition);
  assert.equal(row.img_url, '/uploads/test-photo.jpg', 'the photo is saved like the app saves it');
  assert.match(images.at(-1), /^https:\/\/images\.openfoodfacts\.org\//);
  assert.equal(row.source_app, 'off');
  assert.equal(row.source_external_id, SKYR);
  assert.equal(row.source_url, `https://world.openfoodfacts.org/product/${SKYR}`);
  assert.equal(row.visibility, 'private');
  assert.equal(row.deleted_at, null);

  // The entry: 200 g of a per-100 g food, which the app scales by 2 even
  // though the food has a "portion" alt unit (units.js scaleFactor).
  const factor = units.scaleFactor(row.portion, row.unit, 200, 'g', { ...row, alt_units: JSON.parse(row.alt_units) });
  assert.equal(factor, 2);
  const [item] = dayItems(alice, '2026-11-02');
  assert.equal(item.food_server_id, row.id);
  assert.equal(item.meal, 3);
  assert.equal(item.portion, 200);
  assert.equal(item.unit, 'g');
  assert.equal(item.source, 'mcp');
  for (const [k, v] of Object.entries(app.nutrition)) {
    if (typeof v === 'number') assert.equal(item.nutrition[k], Math.round(v * factor * 100) / 100, k);
  }
  assert.equal(item.nutrition.calories, 146);
});

test('logging the same product again reuses the food and asks no one', async () => {
  const t = toolsFor(alice);
  const count = foodsOf(alice).length;
  const before = requests.length;
  const imgs = images.length;
  const out = json(await t.call('log_external_food', { ref: `off:${SKYR}`, date: '2026-11-02' }));
  assert.equal(out.food.created, false);
  assert.equal(out.food.reused_by, 'source');
  assert.equal(foodsOf(alice).length, count, 'no second food');
  assert.equal(requests.length, before, 'no request: the saved food is used as it is');
  assert.equal(images.length, imgs);
  const items = dayItems(alice, '2026-11-02');
  assert.equal(items.length, 2);
  assert.equal(items[1].food_server_id, items[0].food_server_id);
  assert.equal(items[1].nutrition.calories, 73, 'the food\'s own portion when none is given');
});

test('the same product written another way is still the same food', async () => {
  const t = toolsFor(alice);
  const count = foodsOf(alice).length;
  for (const ref of [`off:000${SKYR}`, `off:0${SKYR}`]) {
    const out = json(await t.call('log_external_food', { ref, date: '2026-11-02' }));
    assert.equal(out.food.reused_by, 'source', ref);
    assert.equal(out.food.ref, `off:${SKYR}`);
  }
  assert.equal(foodsOf(alice).length, count);
  assert.deepEqual(foods.parseRef('usda:000171688'), { source: 'usda', id: '171688' });
  assert.equal(foods.parseRef('off:0000'), null);
  assert.equal(foods.canonicalOffCode('46204040381'), '0046204040381');
  assert.equal(foods.canonicalOffCode('0012345678'), '12345678', 'an EAN-8 with zeros in front');
  assert.equal(foods.canonicalOffCode('00009012'), '00009012');
});

test('a day erased in the app is refused before anything is saved', async () => {
  const gina = user('gina-314');
  db.prepare("INSERT INTO diary (user_id, date, items, deleted_at) VALUES (?, '2026-10-01', '[]', datetime('now'))").run(gina);
  const r = await toolsFor(gina).call('log_external_food', { ref: `off:${SKYR}`, date: '2026-10-01' });
  assert.equal(r.isError, true);
  assert.match(text(r), /erased in the app/);
  assert.equal(foodsOf(gina).length, 0);
});

test('a product the user saved in the app is reused by its barcode, not copied', async () => {
  // Saved the app's way: POST /api/foods with the mapped product, which
  // stores the barcode and nothing that says where it came from.
  const app = client({}, [{ kind: 'offBarcode', code: NUTELLA }]).results[0];
  const id = db.prepare(
    `INSERT INTO foods (user_id, name, brand, nutrition, portion, unit, barcode, nutrition_basis, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(alice, app.name, app.brand, JSON.stringify(app.nutrition), app.portion, app.unit, app.barcode, app.nutrition_basis).lastInsertRowid;
  const count = foodsOf(alice).length;
  const before = requests.length;
  const out = json(await toolsFor(alice).call('log_external_food', { ref: `off:${NUTELLA}`, portion: 15, date: '2026-11-03' }));
  assert.equal(out.food.id, id);
  assert.equal(out.food.reused_by, 'barcode');
  assert.equal(foodsOf(alice).length, count);
  assert.equal(requests.length, before);
  assert.equal(db.prepare('SELECT source_app FROM foods WHERE id = ?').get(id).source_app, null, 'the user\'s food is left as it is');
  assert.equal(dayItems(alice, '2026-11-03')[0].nutrition.calories, Math.round(app.nutrition.calories * 0.15 * 100) / 100);
});

test('a UPC-A saved as EAN-13 in the app is the same product', async () => {
  const id = db.prepare(`INSERT INTO foods (user_id, name, nutrition, portion, unit, barcode, updated_at)
    VALUES (?, 'Arla Skyr (US)', '{"calories":60}', 100, 'g', '0046204040381', datetime('now'))`).run(bob).lastInsertRowid;
  const out = json(await toolsFor(bob).call('log_external_food', { ref: 'off:046204040381', date: '2026-11-03' }));
  assert.equal(out.food.id, id);
  assert.equal(out.food.reused_by, 'barcode');
  db.prepare('DELETE FROM foods WHERE id = ?').run(id);
  db.prepare('DELETE FROM diary WHERE user_id = ?').run(bob);
});

test('USDA: saved as the app saves it (fdcId_<id>), then reused; an app-saved USDA food is reused too', async () => {
  const t = toolsFor(alice);
  const out = json(await t.call('log_external_food', { ref: 'usda:171688', date: '2026-11-04' }));
  assert.equal(out.food.created, true);
  const row = db.prepare('SELECT * FROM foods WHERE id = ?').get(out.food.id);
  const app = client({}, [{ kind: 'usdaFdc', id: '171688', key: USDA_GOOD_KEY }]).results[0];
  assert.equal(row.barcode, 'fdcId_171688');
  assert.equal(row.name, app.name);
  assert.deepEqual(JSON.parse(row.nutrition), app.nutrition);
  assert.equal(row.portion, 100);
  assert.equal(row.source_app, 'usda');
  assert.equal(row.img_url, null);
  assert.equal(json(await t.call('log_external_food', { ref: 'usda:171688', date: '2026-11-04' })).food.reused_by, 'source');

  const appSaved = db.prepare(`INSERT INTO foods (user_id, name, nutrition, portion, unit, barcode, updated_at)
    VALUES (?, 'HIMALAYAN PINK SALT ORGANIC POPCORN', '{"calories":500}', 100, 'g', 'fdcId_2607245', datetime('now'))`).run(alice).lastInsertRowid;
  const r = json(await t.call('log_external_food', { ref: 'usda:2607245', date: '2026-11-04' }));
  assert.equal(r.food.id, appSaved);
  assert.equal(r.food.reused_by, 'barcode');
});

test('a Foundation food with only Atwater energy (2047/2048) shows and logs its calories', async () => {
  // "Yogurt, Greek, plain, whole milk" has no 1008, only 2047 and 2048, and
  // ranks first among USDA results. It came in at 0 kcal and was refused.
  const s = json(await toolsFor(alice).call('search_external_foods', { query: 'greek yogurt plain', source: 'usda', limit: 25 }));
  const hit = s.items.find(i => i.ref === 'usda:2259794');
  assert.ok(hit, 'in the results');
  assert.equal(hit.data_type, 'Foundation');
  assert.equal(hit.nutrition.calories, 94.5, 'Atwater Specific Factors');
  assert.ok(hit.nutrients_reported.includes('calories'));
  const app = client({}, [{ kind: 'usdaFdc', id: '2259794', key: USDA_GOOD_KEY }]).results[0];
  assert.equal(app.nutrition.calories, 94.5071, 'the app reads the same food by id (USDA gives 94.507135 there)');

  const t = toolsFor(alice);
  const out = await t.call('log_external_food', { ref: 'usda:2259794', portion: 150, date: '2026-11-06' });
  assert.ok(!out.isError, text(out));
  const row = db.prepare('SELECT * FROM foods WHERE id = ?').get(json(out).food.id);
  assert.equal(row.barcode, 'fdcId_2259794');
  assert.deepEqual(JSON.parse(row.nutrition), app.nutrition);
  const item = dayItems(alice, '2026-11-06').find(i => i.name === app.name);
  assert.ok(item, 'logged');
  assert.equal(item.portion, 150);
});

test('USDA logging needs the key, like searching', async () => {
  const count = foodsOf(bob).length;
  const r = await toolsFor(bob).call('log_external_food', { ref: 'usda:171688' });
  assert.equal(r.isError, true);
  assert.match(text(r), /API key/);
  assert.equal(foodsOf(bob).length, count);
});

test('each user gets their own food; one user\'s catalog is never reused for another', async () => {
  const aliceSkyr = db.prepare("SELECT id FROM foods WHERE user_id = ? AND source_app = 'off' AND source_external_id = ?").get(alice, SKYR).id;
  const out = json(await toolsFor(bob).call('log_external_food', { ref: `off:${SKYR}`, date: '2026-11-05' }));
  assert.equal(out.food.created, true);
  assert.notEqual(out.food.id, aliceSkyr);
  assert.equal(db.prepare('SELECT user_id FROM foods WHERE id = ?').get(out.food.id).user_id, bob);
  assert.equal(dayItems(alice, '2026-11-05').length, 0, 'nothing on alice\'s day');
});

test('two logs of a new product at once make one food', async () => {
  const carol = user('carol-314');
  const t = toolsFor(carol);
  const outs = await Promise.all([1, 2, 3].map(() => t.call('log_external_food', { ref: `off:${COLA}`, date: '2026-11-05' })));
  const ids = outs.map(o => json(o).food.id);
  assert.equal(new Set(ids).size, 1);
  assert.equal(foodsOf(carol).length, 1);
  assert.equal(outs.filter(o => json(o).food.created).length, 1);
  assert.equal(dayItems(carol, '2026-11-05').length, 3);
});

test('a deleted food is not reused; the product is saved fresh', async () => {
  const dave = user('dave-314');
  const t = toolsFor(dave);
  const first = json(await t.call('log_external_food', { ref: `off:${SKYR}` })).food.id;
  db.prepare("UPDATE foods SET deleted_at = datetime('now') WHERE id = ?").run(first);
  const second = json(await t.call('log_external_food', { ref: `off:${SKYR}` }));
  assert.equal(second.food.created, true);
  assert.notEqual(second.food.id, first);
  assert.equal(db.prepare('SELECT source_app FROM foods WHERE id = ?').get(first).source_app, null, 'the deleted one let go of the product');
});

test('a product with no calories from its source is refused, and nothing is saved', async () => {
  // Real OFF product with only "as prepared" calories (its "as sold" set
  // lists sugars 0 only): the app offers the editor instead of 0 kcal.
  const code = '4056631003435';
  const sets = JSON.parse(fs.readFileSync(new URL('./fixtures/off-nutrition-sets.json', import.meta.url), 'utf8')).products.formula_sugars_only_as_sold;
  assert.equal(sets.v3.code, code);
  const count = foodsOf(alice).length;
  const r = await toolsFor(alice).call('log_external_food', { ref: `off:${code}` });
  assert.equal(r.isError, true);
  assert.match(text(r), /no calories/);
  assert.equal(foodsOf(alice).length, count);
});

test('bad calls never leave a food behind', async () => {
  const eve = user('eve-314');
  const t = toolsFor(eve);
  for (const args of [
    { ref: `off:${SKYR}`, unit: 'cup' },
    { ref: `off:${SKYR}`, date: '2026-02-31' },
    { ref: 'off:0000000000017' },
    { ref: 'off:../../api/v2/search' },
    { ref: 'usda:abc' },
    { ref: 'mealie:12' },
  ]) {
    const r = await t.call('log_external_food', args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(foodsOf(eve).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary WHERE user_id = ?').get(eve).n, 0);
});

test('the ref pattern only takes digits, so nothing else reaches a request path', () => {
  for (const bad of ['off:1/2', 'off:1?x', 'off:1%2F', 'off: 1', 'usda:1.5', 'off:', 'OFF:123']) {
    assert.equal(foods.parseRef(bad), null, bad);
  }
  assert.deepEqual(foods.parseRef('off:3017620422003'), { source: 'off', id: '3017620422003' });
});
