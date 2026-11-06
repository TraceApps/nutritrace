/**
 * #314: the MCP food tools on a server with a local Open Food Facts mirror
 * (OFF_LOCAL_DB), and an air-gapped one (OFF_LOCAL_ONLY). They answer from
 * the mirror exactly as the app's proxy does (the same lib/external-api.js
 * dispatch), fall back to OFF on a miss unless air-gapped, and an air-gapped
 * server makes no outside request at all, USDA and product photos included.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answer, USDA_GOOD_KEY } from './fixtures/external-food-mock.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ext-mirror-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.UPLOADS_PATH = path.join(TMP, 'uploads');
process.env.NODE_ENV = 'test';
delete process.env.OFF_LOCAL_ONLY;

let DuckDBInstance, db, registerReadTools, registerWriteTools, ext, foods;
try {
  ({ DuckDBInstance } = await import('../server/node_modules/@duckdb/node-api/lib/index.js'));
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools, registerWriteTools } = await import('../server/lib/mcp/tools/index.js'));
  ext = await import('../server/lib/external-api.js');
  foods = await import('../server/lib/external-foods.js');
} catch (e) {
  test('MCP external foods mirror suite skipped (a native module is unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-external-foods-mirror] skipping: ${(e?.message || String(e)).split('\n')[0]}`);
  process.exit(0);
}

const SKYR = '4016241040503';
const requests = [];
const images = [];
let userId;

before(async () => {
  // A legacy-shape mirror (one row per product, nutriments as columns), with
  // numbers unlike OFF's live ones so an answer shows where it came from.
  const file = path.join(TMP, 'off.duckdb');
  const inst = await DuckDBInstance.create(file);
  const conn = await inst.connect();
  await conn.run(`CREATE TABLE products (code VARCHAR, product_name VARCHAR, brands VARCHAR,
    "energy-kcal_100g" DOUBLE, proteins_100g DOUBLE, fat_100g DOUBLE, image_url VARCHAR)`);
  await conn.run(`INSERT INTO products VALUES
    ('${SKYR}', 'Skyr Vanilla Mirror', 'Arla', 70, 9, 0.2, 'https://images.openfoodfacts.org/images/products/401/624/104/0503/front_en.jpg'),
    ('5705830010780', 'Skyr Natural Mirror', 'Arla', 63, 11, 0.2, NULL)`);
  conn.closeSync();
  inst.closeSync();
  process.env.OFF_LOCAL_DB = file;

  ext._setFetchForTests(async (url) => {
    requests.push(url);
    const { status, body } = answer(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  foods._setLocalizeForTests(async (url) => { images.push(url); return '/uploads/mirror-photo.jpg'; });

  userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mirror-314', 'x', 'user')").run().lastInsertRowid;
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'usdaEnabled', 'true'), (?, 'usdaApiKey', ?)`)
    .run(userId, userId, JSON.stringify(USDA_GOOD_KEY));
});

after(() => {
  ext._setFetchForTests(null);
  foods._setLocalizeForTests(null);
  delete process.env.OFF_LOCAL_DB;
  delete process.env.OFF_LOCAL_ONLY;
  try { db.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, _def, handler) { this.tools.set(name, handler); }
  call(name, args = {}) { return this.tools.get(name)(args); }
}
const tools = () => { const s = new MockServer(); registerReadTools(s, { userId }); registerWriteTools(s, { userId }); return s; };
const json = (r) => r?.structuredContent;
const text = (r) => r?.content?.[0]?.text || '';

test('with a mirror, name search and barcode lookup answer from it', async () => {
  const n = requests.length;
  const s = json(await tools().call('search_external_foods', { query: 'skyr mirror', source: 'off' }));
  assert.deepEqual(s.items.map(i => i.name).sort(), ['Skyr Natural Mirror', 'Skyr Vanilla Mirror']);
  const b = json(await tools().call('search_external_foods', { barcode: SKYR, source: 'off' }));
  assert.equal(b.items[0].name, 'Skyr Vanilla Mirror');
  assert.equal(b.items[0].nutrition.calories, 70);
  assert.equal(requests.length, n, 'Open Food Facts itself was not asked');
});

test('a mirror miss falls through to Open Food Facts, as the proxy does', async () => {
  const n = requests.length;
  const s = json(await tools().call('search_external_foods', { barcode: '3017620422003', source: 'off' }));
  assert.equal(s.items[0].name, 'Nutella');
  assert.ok(requests.slice(n).some(u => u.startsWith('https://world.openfoodfacts.org/api/v3/product/3017620422003')));
});

test('air-gapped: answers only from the mirror, never the network', async () => {
  process.env.OFF_LOCAL_ONLY = '1';
  try {
    const n = requests.length;
    const t = tools();
    const hit = json(await t.call('search_external_foods', { query: 'skyr mirror', source: 'off' }));
    assert.equal(hit.items.length, 2);
    const miss = json(await t.call('search_external_foods', { barcode: '3017620422003', source: 'off' }));
    assert.deepEqual(miss.sources, [{ source: 'off', status: 'no_match', count: 0 }], 'a miss stays a miss');
    const usda = await t.call('search_external_foods', { query: 'skyr', source: 'usda' });
    assert.equal(usda.isError, true);
    assert.match(text(usda), /air-gapped/);
    const both = json(await t.call('search_external_foods', { query: 'skyr mirror' }));
    assert.equal(both.sources.find(x => x.source === 'usda').status, 'offline');

    // Logging works from the mirror alone, without fetching the photo.
    const imgs = images.length;
    const logged = json(await t.call('log_external_food', { ref: `off:${SKYR}`, portion: 150, date: '2026-11-06' }));
    assert.equal(logged.food.created, true);
    const row = db.prepare('SELECT * FROM foods WHERE id = ?').get(logged.food.id);
    assert.equal(row.name, 'Skyr Vanilla Mirror');
    assert.equal(JSON.parse(row.nutrition).calories, 70);
    assert.equal(row.img_url, null);
    assert.equal(images.length, imgs, 'no photo download on an air-gapped server');
    const off = await t.call('log_external_food', { ref: 'usda:171688' });
    assert.equal(off.isError, true);
    assert.equal(requests.length, n, 'not one outside request');
  } finally {
    delete process.env.OFF_LOCAL_ONLY;
  }
});
