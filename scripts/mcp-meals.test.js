/**
 * Integration tests for the MCP meal and recipe writers (#331):
 * create_meal, update_meal, and log_meal for recipes, against a real temp
 * SQLite database (same harness as mcp-integration.test.js).
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DB = path.join(os.tmpdir(), `mcp-meals-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let db, registerReadTools, registerWriteTools, registerDestroyTools;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools, registerWriteTools, registerDestroyTools } =
    await import('../server/lib/mcp/tools/index.js'));
} catch (e) {
  test('MCP meals suite skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-meals] skipping: ${(e?.message || String(e)).split('\n')[0]}`);
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

let userId, otherUserId;
let soupId, creamId, chickenId, otherUsersFoodId;
let server;

before(() => {
  userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mcp-meals', 'x', 'admin')").run().lastInsertRowid;
  otherUserId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mcp-meals-other', 'x', 'user')").run().lastInsertRowid;
  const food = (u, name, portion, unit, nutrition) => db.prepare(
    `INSERT INTO foods (user_id, name, portion, unit, nutrition, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(u, name, portion, unit, JSON.stringify(nutrition)).lastInsertRowid;
  soupId    = food(userId, 'Soup packet', 40, 'g', { calories: 160, proteins: 4, salt: 2 });
  creamId   = food(userId, 'Cream', 100, 'ml', { calories: 300, fat: 30 });
  chickenId = food(userId, 'Chicken breast', 100, 'g', { calories: 110, proteins: 23 });
  otherUsersFoodId = food(otherUserId, 'Not mine', 100, 'g', { calories: 1 });

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
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('create_meal refuses without confirm=true', async () => {
  const r = await server.call('create_meal', { confirm: false, name: 'X', items: [{ food_id: soupId }] });
  assert.equal(r.isError, true);
  assert.match(_text(r), /confirm=true/);
});

test('create_meal builds items like the meal editor and sums nutrition', async () => {
  const r = await server.call('create_meal', {
    confirm: true, name: 'Chicken lunch',
    items: [{ food_id: chickenId, portion: 150 }, { food_id: soupId, quantity: 2 }],
  });
  assert.equal(r.isError, undefined, _text(r));
  const meal = _json(r).created;
  assert.equal(meal.is_recipe, false);
  assert.equal(meal.item_count, 2);
  const row = db.prepare('SELECT items FROM meals WHERE id = ?').get(meal.id);
  const [chicken, soup] = JSON.parse(row.items);
  // portion × quantity as the portion, quantity 1, scaled nutrition.
  assert.equal(chicken.portion, 150);
  assert.equal(chicken.quantity, 1);
  assert.equal(chicken.food_server_id, chickenId);
  near(chicken.nutrition.calories, 165);
  assert.equal(soup.portion, 80);
  near(soup.nutrition.calories, 320);
  assert.ok(typeof chicken.uuid === 'string' && chicken.uuid !== soup.uuid);
  near(meal.nutrition.calories, 485);
  near(meal.nutrition.proteins, 23 * 1.5 + 8);
  // Salt alone on an ingredient gets its sodium, as Nutrition.calculate does.
  assert.ok(meal.nutrition.sodium > 0);
});

test('create_meal saves a recipe per serving; 1 of 4 servings logs a quarter (#331 acceptance)', async () => {
  const r = await server.call('create_meal', {
    confirm: true, name: 'Creamy chicken soup', is_recipe: true, servings: 4,
    items: [{ food_id: soupId }, { food_id: creamId, portion: 200 }, { food_id: chickenId, portion: 400 }],
  });
  assert.equal(r.isError, undefined, _text(r));
  const recipe = _json(r).created;
  const total = 160 + 600 + 440;
  assert.equal(recipe.is_recipe, true);
  assert.equal(recipe.servings, 4);
  near(recipe.nutrition.calories, total / 4);
  near(recipe.portion, (40 + 200 + 400) / 4);
  assert.equal(recipe.unit, 'g');

  const day = '2026-09-01';
  const before = _json(await server.call('get_daily_totals', { date: day })).totals.calories || 0;
  const logged = await server.call('log_meal', { meal_id: recipe.id, date: day, servings: 1, meal: 2 });
  assert.equal(logged.isError, undefined, _text(logged));
  const after = _json(await server.call('get_daily_totals', { date: day })).totals.calories;
  near(after - before, total / 4);
  const items = JSON.parse(db.prepare('SELECT items FROM diary WHERE user_id = ? AND date = ?').get(userId, day).items);
  assert.equal(items.length, 1);
  assert.equal(items[0].meal, 2);
  assert.ok(items[0].uuid);
});

test('create_meal takes total_amount over the summed weight', async () => {
  const r = await server.call('create_meal', {
    confirm: true, name: 'Reduced soup', is_recipe: true, servings: 2, total_amount: 500,
    items: [{ food_id: soupId }, { food_id: creamId, portion: 1000 }],
  });
  assert.equal(_json(r).created.portion, 250);
});

test('create_meal refuses a name already taken, foods not in the catalog, and recipe fields on a meal', async () => {
  let r = await server.call('create_meal', { confirm: true, name: 'chicken LUNCH', items: [{ food_id: soupId }] });
  assert.equal(r.isError, true);
  assert.match(_text(r), /already exists/);
  r = await server.call('create_meal', { confirm: true, name: 'Theft', items: [{ food_id: otherUsersFoodId }] });
  assert.equal(r.isError, true);
  assert.match(_text(r), /not found/);
  r = await server.call('create_meal', { confirm: true, name: 'Odd', servings: 2, items: [{ food_id: soupId }] });
  assert.equal(r.isError, true);
  assert.match(_text(r), /for recipes/);
});

test('update_meal keeps an imported recipe\'s nutrition: items and servings refused, name allowed', async () => {
  const id = _json(await server.call('create_meal', {
    confirm: true, name: 'Imported lasagne', is_recipe: true, servings: 4, items: [{ food_id: soupId }],
  })).created.id;
  db.prepare("UPDATE meals SET source_app = 'cooktrace', source_external_id = 'ct-1' WHERE id = ?").run(id);
  let r = await server.call('update_meal', { confirm: true, meal_id: id, servings: 6 });
  assert.equal(r.isError, true);
  assert.match(_text(r), /imported from cooktrace/);
  r = await server.call('update_meal', { confirm: true, meal_id: id, name: 'Imported lasagne 2' });
  assert.equal(r.isError, undefined, _text(r));
});

test('update_meal adds and removes items and works nutrition out again', async () => {
  const id = _json(await server.call('create_meal', {
    confirm: true, name: 'Edit me', items: [{ food_id: soupId }, { food_id: chickenId }],
  })).created.id;
  const r = await server.call('update_meal', {
    confirm: true, meal_id: id, remove_item_indexes: [0], add_items: [{ food_id: creamId, portion: 50 }], name: 'Edited',
  });
  assert.equal(r.isError, undefined, _text(r));
  const { before, after } = _json(r);
  assert.equal(before.name, 'Edit me');
  assert.equal(after.name, 'Edited');
  assert.deepEqual(after.items.map(i => i.name), ['Chicken breast', 'Cream']);
  near(after.nutrition.calories, 110 + 150);
});

test('update_meal changes a recipe\'s servings and keeps its total amount', async () => {
  const id = _json(await server.call('create_meal', {
    confirm: true, name: 'Stew', is_recipe: true, servings: 2, total_amount: 900,
    items: [{ food_id: chickenId, portion: 500 }],
  })).created.id;
  const after = _json(await server.call('update_meal', { confirm: true, meal_id: id, servings: 3 })).after;
  assert.equal(after.servings, 3);
  near(after.portion, 300);
  near(after.nutrition.calories, 550 / 3);
});

test('update_meal refuses an out-of-range index, an empty result and a taken name', async () => {
  const id = _json(await server.call('create_meal', {
    confirm: true, name: 'Single', items: [{ food_id: soupId }],
  })).created.id;
  let r = await server.call('update_meal', { confirm: true, meal_id: id, remove_item_indexes: [3] });
  assert.match(_text(r), /out of range/);
  r = await server.call('update_meal', { confirm: true, meal_id: id, remove_item_indexes: [0] });
  assert.match(_text(r), /at least one item/);
  r = await server.call('update_meal', { confirm: true, meal_id: id, name: 'Stew' });
  assert.match(_text(r), /already named/);
});

test('update_meal replaces a recipe\'s items: portion follows the new sum, in grams', async () => {
  const id = _json(await server.call('create_meal', {
    confirm: true, name: 'Swap soup', is_recipe: true, servings: 2, total_amount: 900,
    items: [{ food_id: soupId }],
  })).created.id;
  const after = _json(await server.call('update_meal', {
    confirm: true, meal_id: id, items: [{ food_id: chickenId, portion: 300 }, { food_id: creamId }],
  })).after;
  assert.deepEqual(after.items.map(i => i.name), ['Chicken breast', 'Cream']);
  near(after.portion, (300 + 100) / 2);
  assert.equal(after.unit, 'g');
  near(after.nutrition.calories, (330 + 300) / 2);
});

test('update_meal clears notes with an empty string', async () => {
  const id = _json(await server.call('create_meal', {
    confirm: true, name: 'Noted', notes: 'old note', items: [{ food_id: soupId }],
  })).created.id;
  const r = await server.call('update_meal', { confirm: true, meal_id: id, notes: '' });
  assert.equal(r.isError, undefined, _text(r));
  assert.equal(db.prepare('SELECT notes FROM meals WHERE id = ?').get(id).notes, '');
});
