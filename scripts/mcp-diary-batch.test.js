/**
 * Integration tests for log_diary_batch against a real temp SQLite
 * database (same harness as mcp-integration.test.js).
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DB = path.join(os.tmpdir(), `mcp-diary-batch-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let db, registerReadTools, registerWriteTools, registerDestroyTools;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools, registerWriteTools, registerDestroyTools } =
    await import('../server/lib/mcp/tools/index.js'));
} catch (e) {
  test('MCP diary batch suite skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-diary-batch] skipping: ${(e?.message || String(e)).split('\n')[0]}`);
  process.exit(0);
}

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, _def, handler) { this.tools.set(name, handler); }
  call(name, args = {}) { return this.tools.get(name)(args); }
}

const _json = r => r.structuredContent;
const _text = r => r.content[0].text;

let userId, riceId, milkId, otherFoodId, recipeId, mealId, server;

before(async () => {
  userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('batch', 'x', 'admin')").run().lastInsertRowid;
  const otherUserId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('batch-other', 'x', 'user')").run().lastInsertRowid;
  const food = (u, name, portion, unit, nutrition) => db.prepare(
    `INSERT INTO foods (user_id, name, portion, unit, nutrition, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(u, name, portion, unit, JSON.stringify(nutrition)).lastInsertRowid;
  riceId = food(userId, 'Rice', 100, 'g', { calories: 350, proteins: 7.5 });
  milkId = food(userId, 'Milk', 100, 'ml', { calories: 47 });
  otherFoodId = food(otherUserId, 'Not mine', 100, 'g', { calories: 1 });
  server = new MockServer();
  registerReadTools(server, { userId });
  registerWriteTools(server, { userId });
  registerDestroyTools(server, { userId });
  recipeId = _json(await server.call('create_meal', {
    confirm: true, name: 'Stew', is_recipe: true, servings: 2, items: [{ food_id: riceId, portion: 200 }],
  })).created.id;
  mealId = _json(await server.call('create_meal', {
    confirm: true, name: 'Rice and milk', items: [{ food_id: riceId }, { food_id: milkId, portion: 200 }],
  })).created.id;
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s); } catch { /* ignore */ } }
});

const dayItems = date => JSON.parse(db.prepare('SELECT items FROM diary WHERE user_id = ? AND date = ?').get(userId, date)?.items || '[]');

test('log_diary_batch logs foods, meals and recipes across days', async () => {
  const r = _json(await server.call('log_diary_batch', { entries: [
    { meal_id: recipeId, date: '2026-12-01', meal: 1, servings: 1, notes: 'move from freezer' },
    { food_id: riceId, date: '2026-12-01', meal: 1, portion: 50 },
    { meal_id: recipeId, date: '2026-12-02', meal: 2, servings: 0.5 },
    { meal_id: mealId, date: '2026-12-02', notes: 'breakfast' },
  ] }));
  assert.equal(r.items_added, 5);
  assert.deepEqual(r.days, ['2026-12-01', '2026-12-02']);
  assert.equal(Math.round(_json(await server.call('get_daily_totals', { date: '2026-12-01' })).totals.calories), 525);
  assert.equal(Math.round(_json(await server.call('get_daily_totals', { date: '2026-12-02' })).totals.calories), 619);
  const d1 = dayItems('2026-12-01');
  assert.equal(d1[0].is_recipe, 1);
  assert.equal(d1[0].notes, 'move from freezer');
  const d2 = dayItems('2026-12-02');
  assert.equal(d2[1].notes, 'breakfast');
  assert.equal(d2[2].notes, undefined);
  assert.equal(db.prepare('SELECT usage_count FROM foods WHERE id = ?').get(riceId).usage_count, 1);
});

test('log_diary_batch writes nothing when one entry is invalid', async () => {
  const r = await server.call('log_diary_batch', { entries: [
    { food_id: riceId, date: '2026-12-03' },
    { food_id: otherFoodId, date: '2026-12-04' },
  ] });
  assert.equal(r.isError, true);
  assert.match(_text(r), /entries\[1\]: .*not found/);
  assert.deepEqual(dayItems('2026-12-03'), []);
  assert.deepEqual(dayItems('2026-12-04'), []);
});

test('log_diary_batch rolls back every day when a later day is erased', async () => {
  db.prepare(`INSERT INTO diary (user_id, date, items, deleted_at) VALUES (?, '2026-12-06', '[]', datetime('now'))`).run(userId);
  const r = await server.call('log_diary_batch', { entries: [
    { food_id: riceId, date: '2026-12-05' },
    { food_id: riceId, date: '2026-12-06' },
  ] });
  assert.equal(r.isError, true);
  assert.match(_text(r), /erased/);
  assert.deepEqual(dayItems('2026-12-05'), []);
});

test('log_diary_batch refuses mixed-up entry fields', async () => {
  assert.match(_text(await server.call('log_diary_batch', { entries: [{ food_id: riceId, servings: 2 }] })), /servings applies to meal_id/);
  assert.match(_text(await server.call('log_diary_batch', { entries: [{ meal_id: recipeId, portion: 50 }] })), /apply to food_id/);
  assert.match(_text(await server.call('log_diary_batch', { entries: [{ food_id: riceId, meal_id: recipeId }] })), /exactly one/);
  assert.match(_text(await server.call('log_diary_batch', { entries: [{ meal_id: mealId, servings: 2 }] })), /servings is for recipes/);
});
