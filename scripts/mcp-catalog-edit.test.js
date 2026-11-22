/**
 * Integration tests for the MCP catalog fixers (#331): update_food,
 * delete_food and delete_meal, against a real temp SQLite database (same
 * harness as mcp-integration.test.js).
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DB = path.join(os.tmpdir(), `mcp-catalog-edit-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let db, registerReadTools, registerWriteTools, registerDestroyTools;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools, registerWriteTools, registerDestroyTools } =
    await import('../server/lib/mcp/tools/index.js'));
} catch (e) {
  test('MCP catalog edit suite skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-catalog-edit] skipping: ${(e?.message || String(e)).split('\n')[0]}`);
  process.exit(0);
}

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, _def, handler) { this.tools.set(name, handler); }
  async call(name, args = {}) {
    const h = this.tools.get(name);
    if (!h) throw new Error(`tool ${name} not registered`);
    return h(args);
  }
}

let userId, otherUserId, otherUsersFoodId, otherUsersMealId;
let server;

const addFood = (u, name, brand, nutrition, extra = {}) => db.prepare(
  `INSERT INTO foods (user_id, name, brand, portion, unit, nutrition, barcode, notes, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
).run(u, name, brand, extra.portion ?? 100, extra.unit ?? 'g', JSON.stringify(nutrition),
  extra.barcode ?? null, extra.notes ?? null).lastInsertRowid;
const foodRow = id => db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
const mealRow = id => db.prepare('SELECT * FROM meals WHERE id = ?').get(id);

before(() => {
  userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mcp-edit', 'x', 'admin')").run().lastInsertRowid;
  otherUserId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mcp-edit-other', 'x', 'user')").run().lastInsertRowid;
  otherUsersFoodId = addFood(otherUserId, 'Not mine', null, { calories: 1 });
  otherUsersMealId = db.prepare(
    `INSERT INTO meals (user_id, name, items, is_recipe, updated_at) VALUES (?, 'Not mine either', '[]', 0, datetime('now'))`
  ).run(otherUserId).lastInsertRowid;

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

// ── update_food ─────────────────────────────────────────────────────────

test('update_food refuses without confirm=true and for foods not in the catalog', async () => {
  const id = addFood(userId, 'Confirm me', null, { calories: 10 });
  let r = await server.call('update_food', { confirm: false, food_id: id, name: 'X' });
  assert.equal(r.isError, true);
  assert.match(_text(r), /confirm=true/);
  r = await server.call('update_food', { confirm: true, food_id: otherUsersFoodId, name: 'Mine now' });
  assert.equal(r.isError, true);
  assert.match(_text(r), /not found/);
  assert.equal(foodRow(otherUsersFoodId).name, 'Not mine');
});

test('update_food merges nutrition: numbers replace, null removes, aliases map', async () => {
  const id = addFood(userId, 'Yoghurt', 'Dairy Co', { calories: 60, proteins: 3, sugars: 4 });
  const r = await server.call('update_food', {
    confirm: true, food_id: id, nutrition: { calories: 65, protein: 3.5, sugars: null },
  });
  assert.equal(r.isError, undefined, _text(r));
  assert.deepEqual(JSON.parse(foodRow(id).nutrition), { calories: 65, proteins: 3.5 });
  assert.deepEqual(_json(r).before.nutrition, { calories: 60, proteins: 3, sugars: 4 });
  assert.deepEqual(_json(r).aliased_nutriments, ['protein → proteins']);
});

test('update_food rejects unknown nutriment keys without saving anything', async () => {
  const id = addFood(userId, 'Strict', null, { calories: 1 });
  const r = await server.call('update_food', { confirm: true, food_id: id, name: 'Strict 2', nutrition: { kcal: 5 } });
  assert.equal(r.isError, true);
  assert.match(_text(r), /kcal \(unknown key\)/);
  assert.equal(foodRow(id).name, 'Strict');
});

test('update_food refuses a portion change without nutrition for the new portion', async () => {
  const id = addFood(userId, 'Bread', null, { calories: 250 });
  let r = await server.call('update_food', { confirm: true, food_id: id, portion: 50 });
  assert.equal(r.isError, true);
  assert.match(_text(r), /per the food's portion/);
  r = await server.call('update_food', { confirm: true, food_id: id, portion: 50, nutrition: { calories: 125 } });
  assert.equal(r.isError, undefined, _text(r));
  const row = foodRow(id);
  assert.equal(row.portion, 50);
  assert.deepEqual(JSON.parse(row.nutrition), { calories: 125 });
});

test('update_food renames, clears brand/barcode/notes as the editor does, and sets categories', async () => {
  const id = addFood(userId, 'Old name', 'Brand', { calories: 1 }, { barcode: '4001234567890', notes: 'note' });
  const r = await server.call('update_food', {
    confirm: true, food_id: id, name: 'New name', brand: '', barcode: '', notes: '', categories: ['Snacks', 'Sweet'],
  });
  assert.equal(r.isError, undefined, _text(r));
  const row = foodRow(id);
  assert.equal(row.name, 'New name');
  assert.equal(row.brand, '');
  assert.equal(row.barcode, '');
  assert.equal(row.notes, '');
  assert.equal(row.category, 'Snacks');
  assert.deepEqual(JSON.parse(row.categories), ['Snacks', 'Sweet']);
  assert.deepEqual(_json(r).after.categories, ['Snacks', 'Sweet']);
});

test('update_food refuses a name + brand another food already has', async () => {
  addFood(userId, 'Taken', 'Acme', { calories: 1 });
  const id = addFood(userId, 'Free', 'Acme', { calories: 1 });
  const r = await server.call('update_food', { confirm: true, food_id: id, name: 'taken' });
  assert.equal(r.isError, true);
  assert.match(_text(r), /already has this name/);
});

test('a brand cleared to an empty string counts as no brand in the duplicate checks', async () => {
  const id = addFood(userId, 'Plain oats', 'Acme', { calories: 370 });
  await server.call('update_food', { confirm: true, food_id: id, brand: '' });
  let r = await server.call('create_food', { confirm: true, name: 'plain oats', portion: 100, unit: 'g', nutrition: { calories: 1 } });
  assert.equal(r.isError, true, _text(r));
  const other = addFood(userId, 'Other oats', null, { calories: 1 });
  r = await server.call('update_food', { confirm: true, food_id: other, name: 'Plain Oats' });
  assert.equal(r.isError, true);
  assert.match(_text(r), /already has this name/);
});

test('update_food counts nutrition stored as strings as values', async () => {
  const id = addFood(userId, 'Old import', null, { calories: '120' });
  const r = await server.call('update_food', { confirm: true, food_id: id, nutrition: { proteins: null } });
  assert.equal(r.isError, undefined, _text(r));
});

test('update_food bumps updated_at and stamps field_times, as an app edit does', async () => {
  const id = addFood(userId, 'Synced', null, { calories: 1 });
  db.prepare("UPDATE foods SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  await server.call('update_food', { confirm: true, food_id: id, notes: 'changed' });
  const row = foodRow(id);
  assert.notEqual(row.updated_at, '2020-01-01 00:00:00');
  assert.match(String(row.field_times || ''), /notes/);
});

test('update_food leaves diary entries already logged as they were', async () => {
  const id = addFood(userId, 'Logged food', null, { calories: 100 });
  await server.call('log_food', { food_id: id, date: '2026-09-02' });
  await server.call('update_food', { confirm: true, food_id: id, nutrition: { calories: 200 } });
  const items = JSON.parse(db.prepare("SELECT items FROM diary WHERE user_id = ? AND date = '2026-09-02'").get(userId).items);
  assert.equal(items[0].nutrition.calories, 100);
});

// ── delete_food ─────────────────────────────────────────────────────────

test('delete_food refuses without confirm=true and for foods not in the catalog', async () => {
  const id = addFood(userId, 'Keep me', null, { calories: 1 });
  let r = await server.call('delete_food', { food_id: id, confirm: false });
  assert.equal(r.isError, true);
  assert.equal(foodRow(id).deleted_at, null);
  r = await server.call('delete_food', { food_id: otherUsersFoodId, confirm: true });
  assert.equal(r.isError, true);
  assert.equal(foodRow(otherUsersFoodId).deleted_at, null);
});

test('delete_food soft-deletes, returns the food for undo and names meals still using it', async () => {
  const id = addFood(userId, 'Mistake', 'Brandless', { calories: 42 }, { portion: 30 });
  db.prepare("UPDATE foods SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  const mealId = db.prepare(
    `INSERT INTO meals (user_id, name, items, is_recipe, updated_at) VALUES (?, 'Uses it', ?, 1, datetime('now'))`
  ).run(userId, JSON.stringify([{ name: 'Mistake', food_server_id: id, quantity: 1 }])).lastInsertRowid;

  const r = await server.call('delete_food', { food_id: id, confirm: true });
  assert.equal(r.isError, undefined, _text(r));
  const row = foodRow(id);
  assert.ok(row.deleted_at, 'soft delete: the row stays with deleted_at set');
  assert.notEqual(row.updated_at, '2020-01-01 00:00:00', 'updated_at bumped so phones pull it');
  const out = _json(r);
  assert.equal(out.removed.name, 'Mistake');
  assert.equal(out.removed.portion, 30);
  assert.deepEqual(out.removed.nutrition, { calories: 42 });
  assert.deepEqual(out.still_in_meals, [{ meal_id: mealId, name: 'Uses it', is_recipe: true }]);

  // Gone from search, and a second delete finds nothing.
  const found = _json(await server.call('search_foods', { query: 'Mistake' }));
  assert.ok(!JSON.stringify(found).includes(`"id":${id}`));
  const again = await server.call('delete_food', { food_id: id, confirm: true });
  assert.match(_text(again), /not found/);
});

test('a food deleted with delete_food can be made again with create_food', async () => {
  const id = addFood(userId, 'Again', null, { calories: 5 });
  await server.call('delete_food', { food_id: id, confirm: true });
  const r = await server.call('create_food', {
    confirm: true, name: 'Again', portion: 100, unit: 'g', nutrition: { calories: 5 },
  });
  assert.equal(r.isError, undefined, _text(r));
});

// ── delete_meal ─────────────────────────────────────────────────────────

test('delete_meal soft-deletes a meal or recipe and returns it with its items', async () => {
  const id = db.prepare(
    `INSERT INTO meals (user_id, name, items, is_recipe, servings, updated_at) VALUES (?, 'Old recipe', ?, 1, 4, '2020-01-01 00:00:00')`
  ).run(userId, JSON.stringify([{ name: 'Rice', portion: 200, unit: 'g', quantity: 1, nutrition: { calories: 260 } }])).lastInsertRowid;
  let r = await server.call('delete_meal', { meal_id: id, confirm: false });
  assert.equal(r.isError, true);
  assert.equal(mealRow(id).deleted_at, null);

  r = await server.call('delete_meal', { meal_id: id, confirm: true });
  assert.equal(r.isError, undefined, _text(r));
  const row = mealRow(id);
  assert.ok(row.deleted_at);
  assert.notEqual(row.updated_at, '2020-01-01 00:00:00');
  const removed = _json(r).removed;
  assert.equal(removed.name, 'Old recipe');
  assert.equal(removed.is_recipe, true);
  assert.equal(removed.servings, 4);
  assert.equal(removed.items[0].name, 'Rice');

  const search = _json(await server.call('search_meals', { query: 'Old recipe', include_recipes: true }));
  assert.ok(!search.items.some(m => m.id === id));
  r = await server.call('delete_meal', { meal_id: id, confirm: true });
  assert.match(_text(r), /not found/);
});

test('delete_meal does not touch another user\'s meal', async () => {
  const r = await server.call('delete_meal', { meal_id: otherUsersMealId, confirm: true });
  assert.equal(r.isError, true);
  assert.equal(mealRow(otherUsersMealId).deleted_at, null);
});

test('delete_meal leaves diary entries logged from the meal', async () => {
  const id = db.prepare(
    `INSERT INTO meals (user_id, name, items, is_recipe, updated_at) VALUES (?, 'Logged meal', ?, 0, datetime('now'))`
  ).run(userId, JSON.stringify([{ name: 'Apple', portion: 1, unit: 'piece', quantity: 1, nutrition: { calories: 80 } }])).lastInsertRowid;
  await server.call('log_meal', { meal_id: id, date: '2026-09-03' });
  await server.call('delete_meal', { meal_id: id, confirm: true });
  const items = JSON.parse(db.prepare("SELECT items FROM diary WHERE user_id = ? AND date = '2026-09-03'").get(userId).items);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Apple');
});
