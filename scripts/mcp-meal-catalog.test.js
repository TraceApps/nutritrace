/**
 * Integration tests for the MCP catalog tools: create_meal, update_meal,
 * delete_meal, update_food, delete_food, and log_meal on recipes, against
 * a real temp SQLite database (same harness as mcp-integration.test.js).
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DB = path.join(os.tmpdir(), `mcp-meal-catalog-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let db, registerReadTools, registerWriteTools, registerDestroyTools;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools, registerWriteTools, registerDestroyTools } =
    await import('../server/lib/mcp/tools/index.js'));
} catch (e) {
  test('MCP meal catalog suite skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-meal-catalog] skipping: ${(e?.message || String(e)).split('\n')[0]}`);
  process.exit(0);
}

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, _def, handler) { this.tools.set(name, handler); }
  call(name, args = {}) { return this.tools.get(name)(args); }
}

const _json = r => r.structuredContent;
const _text = r => r.content[0].text;

let userId, otherUserId, flakesId, milkId, riceId, otherFoodId, server;

before(() => {
  userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('catalog', 'x', 'admin')").run().lastInsertRowid;
  otherUserId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('other', 'x', 'user')").run().lastInsertRowid;
  const food = (u, name, portion, unit, nutrition) => db.prepare(
    `INSERT INTO foods (user_id, name, portion, unit, nutrition, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(u, name, portion, unit, JSON.stringify(nutrition)).lastInsertRowid;
  flakesId = food(userId, 'Flakes', 100, 'g', { calories: 343, proteins: 12 });
  milkId = food(userId, 'Milk', 100, 'ml', { calories: 47, proteins: 3.4 });
  riceId = food(userId, 'Rice', 100, 'g', { calories: 350, proteins: 7.5 });
  otherFoodId = food(otherUserId, 'Not mine', 100, 'g', { calories: 1 });
  server = new MockServer();
  registerReadTools(server, { userId });
  registerWriteTools(server, { userId });
  registerDestroyTools(server, { userId });
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s); } catch { /* ignore */ } }
});

test('create_meal requires confirm=true', async () => {
  const r = await server.call('create_meal', { confirm: false, name: 'X', items: [{ food_id: flakesId }] });
  assert.equal(r.isError, true);
});

test('create_meal saves a meal with scaled items and summed nutrition', async () => {
  const r = await server.call('create_meal', {
    confirm: true, name: 'Breakfast',
    items: [{ food_id: flakesId }, { food_id: milkId, portion: 275 }],
  });
  const c = _json(r).created;
  assert.equal(c.is_recipe, false);
  assert.equal(c.nutrition.calories, 472.25);
  const row = db.prepare('SELECT items, is_recipe FROM meals WHERE id = ?').get(c.id);
  const items = JSON.parse(row.items);
  assert.equal(row.is_recipe, 0);
  assert.equal(items[1].portion, 275);
  assert.equal(items[1].quantity, 1);
  assert.equal(items[1].food_server_id, milkId);
  assert.equal(items[1].nutrition.calories, 129.25);
});

test('create_meal refuses a duplicate name and foods of another user', async () => {
  const dup = await server.call('create_meal', { confirm: true, name: 'breakfast', items: [{ food_id: flakesId }] });
  assert.match(_text(dup), /already exists/);
  const foreign = await server.call('create_meal', { confirm: true, name: 'Y', items: [{ food_id: otherFoodId }] });
  assert.match(_text(foreign), /not found/);
});

let chilliId;
test('create_meal saves a recipe per serving, weight from ingredients or total_weight', async () => {
  const r = await server.call('create_meal', {
    confirm: true, name: 'Chilli', is_recipe: true, servings: 4,
    items: [{ food_id: riceId, portion: 400 }],
  });
  const c = _json(r).created;
  chilliId = c.id;
  assert.equal(c.nutrition.calories, 350);
  assert.equal(c.portion, 100);
  const w = await server.call('create_meal', {
    confirm: true, name: 'Chilli batch', is_recipe: true, servings: 4, total_weight: 1600,
    items: [{ food_id: riceId, portion: 400 }],
  });
  assert.equal(_json(w).created.portion, 400);
});

test('a meal can hold servings of a recipe', async () => {
  const r = await server.call('create_meal', {
    confirm: true, name: 'Chilli + rice',
    items: [{ recipe_id: chilliId, quantity: 1 }, { food_id: riceId }],
  });
  const c = _json(r).created;
  assert.equal(c.nutrition.calories, 700);
  const items = JSON.parse(db.prepare('SELECT items FROM meals WHERE id = ?').get(c.id).items);
  assert.equal(items[0].is_recipe, 1);
  assert.equal(items[0].food_server_id, chilliId);
});

test('log_meal logs a recipe as one item with servings and notes', async () => {
  const r = await server.call('log_meal', { meal_id: chilliId, date: '2026-11-23', meal: 2, servings: 1.5, notes: 'from the fridge' });
  assert.equal(_json(r).logged.servings, 1.5);
  const items = JSON.parse(db.prepare(`SELECT items FROM diary WHERE user_id = ? AND date = '2026-11-23'`).get(userId).items);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 1.5);
  assert.equal(items[0].meal, 2);
  assert.equal(items[0].notes, 'from the fridge');
  assert.equal(items[0].nutrition.calories, 350);
  const totals = _json(await server.call('get_daily_totals', { date: '2026-11-23' }));
  assert.equal(Math.round(totals.totals.calories), 525);
});

test('update_meal re-splits a recipe on servings alone, recomputes on items', async () => {
  const s = _json(await server.call('update_meal', { confirm: true, meal_id: chilliId, servings: 2 })).updated;
  assert.equal(s.nutrition.calories, 700);
  assert.equal(s.portion, 200);
  const i = _json(await server.call('update_meal', {
    confirm: true, meal_id: chilliId, items: [{ food_id: riceId, portion: 200 }],
  })).updated;
  assert.equal(i.nutrition.calories, 350);
  assert.equal(i.portion, 100);
  const self = await server.call('update_meal', { confirm: true, meal_id: chilliId, items: [{ recipe_id: chilliId }] });
  assert.match(_text(self), /cannot contain itself/);
});

test('update_meal renames and refuses servings on a meal', async () => {
  const id = db.prepare(`SELECT id FROM meals WHERE name = 'Breakfast'`).get().id;
  const bad = await server.call('update_meal', { confirm: true, meal_id: id, servings: 2 });
  assert.equal(bad.isError, true);
  const ok = _json(await server.call('update_meal', { confirm: true, meal_id: id, name: 'Cereal breakfast' }));
  assert.equal(ok.updated.name, 'Cereal breakfast');
});

test('update_food merges nutrition, clears with null, refuses unknown-only keys', async () => {
  const r = _json(await server.call('update_food', {
    confirm: true, food_id: milkId, name: 'Milk 1.5%', nutrition: { protein: 3.5, fat: 1.5 },
  }));
  assert.equal(r.updated.nutrition.proteins, 3.5);
  assert.equal(r.updated.nutrition.calories, 47);
  assert.equal(r.updated.nutrition.fat, 1.5);
  const cleared = _json(await server.call('update_food', { confirm: true, food_id: milkId, nutrition: { fat: null } }));
  assert.equal('fat' in cleared.updated.nutrition, false);
  const bad = await server.call('update_food', { confirm: true, food_id: milkId, nutrition: { bogus: 1 } });
  assert.equal(bad.isError, true);
  const foreign = await server.call('update_food', { confirm: true, food_id: otherFoodId, name: 'Mine now' });
  assert.match(_text(foreign), /not found/);
});

test('delete_food and delete_meal soft-delete only the caller\'s rows', async () => {
  assert.equal(_json(await server.call('delete_food', { confirm: true, food_id: flakesId })).ok, true);
  assert.ok(db.prepare('SELECT deleted_at FROM foods WHERE id = ?').get(flakesId).deleted_at);
  assert.equal((await server.call('delete_food', { confirm: true, food_id: otherFoodId })).isError, true);
  assert.equal(_json(await server.call('delete_meal', { confirm: true, meal_id: chilliId })).ok, true);
  assert.ok(db.prepare('SELECT deleted_at FROM meals WHERE id = ?').get(chilliId).deleted_at);
  assert.equal((await server.call('log_meal', { meal_id: chilliId })).isError, true);
});

test('log_diary_batch logs foods and recipes across days in one go', async () => {
  const recipe = _json(await server.call('create_meal', {
    confirm: true, name: 'Batch stew', is_recipe: true, servings: 2, items: [{ food_id: riceId, portion: 200 }],
  })).created.id;
  const r = _json(await server.call('log_diary_batch', { entries: [
    { meal_id: recipe, date: '2026-12-01', meal: 1, servings: 1, notes: 'move from freezer' },
    { food_id: riceId, date: '2026-12-01', meal: 1, portion: 50 },
    { meal_id: recipe, date: '2026-12-02', meal: 2, servings: 0.5 },
  ] }));
  assert.equal(r.items_added, 3);
  assert.deepEqual(r.days, ['2026-12-01', '2026-12-02']);
  const day1 = _json(await server.call('get_daily_totals', { date: '2026-12-01' }));
  assert.equal(Math.round(day1.totals.calories), 525);
  const day2 = _json(await server.call('get_daily_totals', { date: '2026-12-02' }));
  assert.equal(Math.round(day2.totals.calories), 175);
});

test('log_diary_batch writes nothing when one entry is invalid', async () => {
  const r = await server.call('log_diary_batch', { entries: [
    { food_id: riceId, date: '2026-12-03' },
    { food_id: otherFoodId, date: '2026-12-04' },
  ] });
  assert.match(_text(r), /entries\[1\]: .*not found/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM diary WHERE user_id = ? AND date IN ('2026-12-03','2026-12-04')`).get(userId).n, 0);
  const mixed = await server.call('log_diary_batch', { entries: [{ food_id: riceId, servings: 2 }] });
  assert.match(_text(mixed), /servings applies to meal_id/);
  const both = await server.call('log_diary_batch', { entries: [{ food_id: riceId, meal_id: 1 }] });
  assert.match(_text(both), /exactly one/);
});
