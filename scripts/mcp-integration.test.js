/**
 * Integration tests for MCP tools against a real temp SQLite database.
 *
 * The static wiring test guards *shape* (route mounted, scopes registered,
 * tools filed under the right registrar). This suite exercises *behavior*
 * against a real DB: it seeds foods / meals / diary rows, invokes each
 * tool handler directly (via a mock McpServer that captures registrations),
 * and asserts the on-disk state after the call.
 *
 * Tests set DB_PATH to a temp file BEFORE importing anything server-side,
 * so the module-scope `new Database(dbPath)` in server/db.js opens the
 * scratch DB instead of the real one. The temp file is removed at the end.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DB = path.join(os.tmpdir(), `mcp-integration-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

// Dynamic imports so DB_PATH is applied first. Wrapped in try so a
// Node-ABI mismatch on better-sqlite3 (e.g. running against a Node
// build that doesn't match the .node binary compiled for the Docker
// image) skips the suite with a clear diagnostic instead of crashing.
// The Docker container runs Node 20 with a matching binding, so this
// suite always runs there.
let db, registerReadTools, registerWriteTools, registerDestroyTools;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools, registerWriteTools, registerDestroyTools } =
    await import('../server/lib/mcp/tools/index.js'));
} catch (e) {
  test('MCP integration suite skipped (native module unavailable)', { skip: true }, () => {});
  const msg = e?.message || String(e);
  console.warn(`[mcp-integration] skipping: ${msg.split('\n')[0]}`);
  if (/better_sqlite3\.node/i.test(msg)) {
    console.warn('[mcp-integration] Node ABI mismatch on better-sqlite3. Run inside the Docker image, or `cd server && npm rebuild better-sqlite3` to build against the local Node.');
  }
  process.exit(0);
}

// ── Mock McpServer that captures tool handlers so we can invoke them
//    without spinning up a real Streamable-HTTP transport. ────────────
class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, _def, handler) { this.tools.set(name, handler); }
  async call(name, args = {}) {
    const h = this.tools.get(name);
    if (!h) throw new Error(`tool ${name} not registered`);
    return h(args);
  }
}

let userId;
let bananaId, oatsId, altFoodId;
let breakfastMealId, breakfastRecipeId;
let server;

before(() => {
  // Seed a user + a couple of foods + a saved meal + a recipe. The db
  // module already ran all CREATE TABLE / ALTER migrations at import
  // time against the temp file, so the schema is real.
  const u = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run('mcp-int-test', 'x');
  userId = u.lastInsertRowid;

  bananaId = db.prepare(
    `INSERT INTO foods (user_id, name, brand, portion, unit, nutrition, updated_at)
     VALUES (?, 'Banana', NULL, 100, 'g', ?, datetime('now'))`
  ).run(userId, JSON.stringify({ calories: 89, carbohydrates: 23, protein: 1.1 }))
    .lastInsertRowid;

  oatsId = db.prepare(
    `INSERT INTO foods (user_id, name, brand, portion, unit, nutrition, updated_at)
     VALUES (?, 'Oats', 'Quaker', 40, 'g', ?, datetime('now'))`
  ).run(userId, JSON.stringify({ calories: 150, carbohydrates: 27, protein: 5, fat: 3 }))
    .lastInsertRowid;

  // Food with alt_units: should refuse portion override in log_food/edit.
  altFoodId = db.prepare(
    `INSERT INTO foods (user_id, name, portion, unit, nutrition, alt_units, updated_at)
     VALUES (?, 'Pizza', 1, 'slice', ?, ?, datetime('now'))`
  ).run(userId, JSON.stringify({ calories: 300 }), JSON.stringify([{ abbr: 'g', grams: 140 }]))
    .lastInsertRowid;

  breakfastMealId = db.prepare(
    `INSERT INTO meals (user_id, name, items, is_recipe, updated_at)
     VALUES (?, 'Standard Breakfast', ?, 0, datetime('now'))`
  ).run(userId, JSON.stringify([
    { name: 'Banana', meal: 0, quantity: 1, portion: 100, unit: 'g',
      nutrition: { calories: 89 }, food_server_id: bananaId, source: 'import:mfp' },
    { name: 'Oats',   meal: 0, quantity: 1, portion: 40,  unit: 'g',
      nutrition: { calories: 150 }, food_server_id: oatsId },
  ]))
    .lastInsertRowid;

  breakfastRecipeId = db.prepare(
    `INSERT INTO meals (user_id, name, items, is_recipe, updated_at)
     VALUES (?, 'Overnight Oats', ?, 1, datetime('now'))`
  ).run(userId, JSON.stringify([]))
    .lastInsertRowid;

  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'timeFormat', '"12h"')`).run(userId);

  // Fresh server per-test would be ideal but tools are stateless — one
  // registration covers every assertion.
  server = new MockServer();
  registerReadTools   (server, { userId });
  registerWriteTools  (server, { userId });
  registerDestroyTools(server, { userId });
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

const _text = r => r?.content?.[0]?.text || '';
const _json = r => r?.structuredContent;

// ────────────────────────────────────────────────────────────────────────
// READ
// ────────────────────────────────────────────────────────────────────────

test('search_foods returns seeded rows and honors LIKE-escape', async () => {
  const r = await server.call('search_foods', { query: 'ban' });
  const sc = _json(r);
  assert.equal(sc.count, 1);
  assert.equal(sc.items[0].name, 'Banana');
  // '%' should not wildcard.
  const w = await server.call('search_foods', { query: '%' });
  assert.equal(_json(w).count, 0);
});

test('get_goals returns null water_goal_ml when unset', async () => {
  const r = await server.call('get_goals', {});
  assert.deepEqual(_json(r).goals, {});
  assert.equal(_json(r).water_goal_ml, null);
});

// ────────────────────────────────────────────────────────────────────────
// WRITE
// ────────────────────────────────────────────────────────────────────────

test('log_food writes a diary row and bumps foods.usage_count', async () => {
  const r = await server.call('log_food', { food_id: bananaId });
  assert.equal(_json(r).ok, true);
  assert.equal(_json(r).total_items_on_day, 1);
  const row = db.prepare(`SELECT items FROM foods WHERE id = ?`).get(bananaId);
  assert.ok(row);
  const usage = db.prepare(`SELECT usage_count FROM foods WHERE id = ?`).get(bananaId);
  assert.equal(usage.usage_count, 1);
});

test('log_food scales nutrition on portion override for linear-unit foods', async () => {
  // Oats: base 40g, log 80g → should double calories in the stored item.
  const r = await server.call('log_food', { food_id: oatsId, portion: 80 });
  assert.equal(_json(r).ok, true);
  const day = _json(r).date;
  const drow = db.prepare(`SELECT items FROM diary WHERE user_id = ? AND date = ?`).get(userId, day);
  const items = JSON.parse(drow.items);
  const oats = items.find(it => it.name === 'Oats');
  assert.equal(oats.portion, 80);
  assert.equal(oats.nutrition.calories, 300);   // 150 * (80/40)
});

test('log_food REFUSES portion override on foods with alt_units', async () => {
  const r = await server.call('log_food', { food_id: altFoodId, portion: 2 });
  assert.equal(r.isError, true);
  assert.match(_text(r), /alt.units/i);
});

test('log_water appends to water[] and returns cumulative total', async () => {
  await server.call('log_water', { amount_ml: 250 });
  const r = await server.call('log_water', { amount_ml: 500 });
  assert.equal(_json(r).total_ml_on_day, 750);
  assert.equal(_json(r).entry_count_on_day, 2);
});

test('log_water rejects malformed time strings', async () => {
  const r = await server.call('log_water', { amount_ml: 100, time: 'morningish' });
  assert.equal(r.isError, true);
  assert.match(_text(r), /Invalid time/);
});

test('log_meal expands saved meal items into diary and preserves per-item source', async () => {
  const r = await server.call('log_meal', { meal_id: breakfastMealId, date: '2026-08-08' });
  assert.equal(_json(r).logged.item_count, 2);
  const drow = db.prepare(`SELECT items FROM diary WHERE user_id = ? AND date = '2026-08-08'`).get(userId);
  const items = JSON.parse(drow.items);
  const banana = items.find(it => it.name === 'Banana');
  assert.equal(banana.source, 'import:mfp');           // preserved, not clobbered
  assert.equal(banana.source_meal_id, breakfastMealId); // stamped
});

test('log_meal REFUSES recipes', async () => {
  const r = await server.call('log_meal', { meal_id: breakfastRecipeId, date: '2026-08-08' });
  assert.equal(r.isError, true);
  assert.match(_text(r), /is a recipe/i);
});

test('search_meals returns the seeded meal and excludes recipes by default', async () => {
  const r = await server.call('search_meals', { query: 'break' });
  const sc = _json(r);
  assert.equal(sc.count, 1);
  assert.equal(sc.items[0].id, breakfastMealId);
  assert.equal(sc.items[0].name, 'Standard Breakfast');
  assert.equal(sc.items[0].is_recipe, false);
});

test('search_meals with include_recipes=true also returns recipes', async () => {
  const r = await server.call('search_meals', { query: 'oat', include_recipes: true });
  const sc = _json(r);
  const found = sc.items.find(m => m.id === breakfastRecipeId);
  assert.ok(found, 'Overnight Oats recipe should be returned when include_recipes:true');
  assert.equal(found.is_recipe, true);
});

test('search_meals honors LIKE escape so % is not a wildcard', async () => {
  const r = await server.call('search_meals', { query: '%' });
  assert.equal(_json(r).count, 0);
});

test('search_meals with no query lists all meals (browse mode)', async () => {
  const r = await server.call('search_meals', {});
  const sc = _json(r);
  assert.equal(sc.count, 1);            // only the meal; recipe excluded by default
  assert.equal(sc.query, null);
  assert.equal(sc.items[0].id, breakfastMealId);
});

test('search_meals with empty-string query behaves as browse mode', async () => {
  const r = await server.call('search_meals', { query: '   ' });
  const sc = _json(r);
  assert.equal(sc.count, 1);
  assert.equal(sc.query, null);
});

test('get_meal_details returns the meal + item_count + nutrition', async () => {
  const r = await server.call('get_meal_details', { meal_id: breakfastMealId });
  const d = _json(r);
  assert.equal(d.id, breakfastMealId);
  assert.equal(d.is_recipe, false);
  assert.equal(d.item_count, 2);
  assert.equal(d.items.length, 2);
  const banana = d.items.find(it => it.name === 'Banana');
  assert.equal(banana.food_server_id, bananaId);
  assert.equal(banana.nutrition.calories, 89);
});

test('get_meal_details returns tool error for unknown meal_id', async () => {
  const r = await server.call('get_meal_details', { meal_id: 999_999 });
  assert.equal(r.isError, true);
  assert.match(_text(r), /not found/i);
});

test('get_recent_meals excludes meals never logged (last_used_at NULL)', async () => {
  const r = await server.call('get_recent_meals', {});
  // Neither seed meal has last_used_at set yet, so nothing surfaces.
  assert.equal(_json(r).count, 0);
});

test('get_recent_meals surfaces a meal after last_used_at is set', async () => {
  db.prepare(`UPDATE meals SET last_used_at = datetime('now'), usage_count = usage_count + 1 WHERE id = ?`)
    .run(breakfastMealId);
  const r = await server.call('get_recent_meals', {});
  const sc = _json(r);
  assert.equal(sc.count, 1);
  assert.equal(sc.items[0].id, breakfastMealId);
  assert.equal(sc.items[0].usage_count, 1);
});

test('log_body_stat tags weight with kg for a fresh row', async () => {
  const r = await server.call('log_body_stat', { stats: { weight: 75 }, date: '2026-08-06' });
  assert.equal(_json(r).ok, true);
  const row = db.prepare(`SELECT body_stats FROM diary WHERE user_id = ? AND date = '2026-08-06'`).get(userId);
  const bs = JSON.parse(row.body_stats);
  assert.equal(bs.weight, 75);
  assert.equal(bs.weight_unit, 'kg');
});

test('log_body_stat REFUSES writing over untagged legacy values', async () => {
  // Seed a tombstone-adjacent legacy row: weight without weight_unit tag.
  db.prepare(
    `INSERT INTO diary (user_id, date, items, body_stats, water, updated_at)
     VALUES (?, '2026-08-05', '[]', ?, '[]', datetime('now'))`
  ).run(userId, JSON.stringify({ weight: 165 }));   // legacy lb-ish, untagged
  const r = await server.call('log_body_stat', { stats: { weight: 75 }, date: '2026-08-05' });
  assert.equal(r.isError, true);
  assert.match(_text(r), /untagged legacy/i);
});

// ────────────────────────────────────────────────────────────────────────
// TOMBSTONE PROTECTION
// ────────────────────────────────────────────────────────────────────────

test('mutateDiaryDay REFUSES to resurrect a tombstoned day', async () => {
  db.prepare(
    `INSERT INTO diary (user_id, date, items, water, body_stats, updated_at, deleted_at)
     VALUES (?, '2026-07-01', '[]', '[]', '{}', datetime('now'), datetime('now'))`
  ).run(userId);
  const r = await server.call('log_water', { amount_ml: 100, date: '2026-07-01' });
  assert.equal(r.isError, true);
  assert.match(_text(r), /erased/i);
  // Row should stay tombstoned.
  const row = db.prepare(`SELECT deleted_at FROM diary WHERE user_id = ? AND date = '2026-07-01'`).get(userId);
  assert.ok(row.deleted_at);
});

// ────────────────────────────────────────────────────────────────────────
// DESTROY
// ────────────────────────────────────────────────────────────────────────

test('delete_diary_entry refuses without confirm=true', async () => {
  const r = await server.call('delete_diary_entry', { entry_index: 0 });
  assert.equal(r.isError, true);
  assert.match(_text(r), /confirm/i);
});

test('delete_diary_entry removes an item and returns the removed shape', async () => {
  const day = new Date().toLocaleDateString('sv-SE');
  const before = JSON.parse(db.prepare(`SELECT items FROM diary WHERE user_id = ? AND date = ?`).get(userId, day).items);
  assert.ok(before.length > 0);
  const r = await server.call('delete_diary_entry', { entry_index: 0, confirm: true });
  assert.equal(_json(r).ok, true);
  assert.equal(_json(r).removed.name, before[0].name);
  const after = JSON.parse(db.prepare(`SELECT items FROM diary WHERE user_id = ? AND date = ?`).get(userId, day).items);
  assert.equal(after.length, before.length - 1);
});

test('edit_diary_entry patches quantity + rescales nutrition on portion patch', async () => {
  const day = new Date().toLocaleDateString('sv-SE');
  // Ensure at least one entry exists.
  await server.call('log_food', { food_id: oatsId });   // fresh oats entry at end
  const items = JSON.parse(db.prepare(`SELECT items FROM diary WHERE user_id = ? AND date = ?`).get(userId, day).items);
  const idx = items.length - 1;
  const r = await server.call('edit_diary_entry', {
    entry_index: idx,
    patch: { portion: 20 },   // half of the food's 40g baseline
    confirm: true,
  });
  assert.equal(_json(r).ok, true);
  const updated = JSON.parse(db.prepare(`SELECT items FROM diary WHERE user_id = ? AND date = ?`).get(userId, day).items);
  assert.equal(updated[idx].portion, 20);
  assert.equal(updated[idx].nutrition.calories, 75);   // 150 * (20/40)
});

test('create_food refuses duplicates and inserts unique row with updated_at set', async () => {
  const first = await server.call('create_food', {
    confirm: true, name: 'Test Cracker', brand: 'Trader',
    portion: 30, unit: 'g', nutrition: { calories: 130, carbohydrates: 20 },
  });
  assert.equal(_json(first).ok, true);
  const newId = _json(first).created.id;
  const row = db.prepare(`SELECT updated_at FROM foods WHERE id = ?`).get(newId);
  assert.ok(row.updated_at, 'updated_at should be set so sync picks up the row');

  const dup = await server.call('create_food', {
    confirm: true, name: 'test cracker', brand: 'TRADER',   // case-insensitive dedup
    portion: 30, unit: 'g', nutrition: { calories: 130 },
  });
  assert.equal(dup.isError, true);
  assert.match(_text(dup), /already exists/i);
});

test('create_food caps outlandish nutriment values', async () => {
  const r = await server.call('create_food', {
    confirm: true, name: 'Hallucinated Food',
    portion: 1, unit: 'g', nutrition: { calories: 1e12 },
  });
  assert.equal(r.isError, true);
  assert.match(_text(r), /exceeds/i);
});
