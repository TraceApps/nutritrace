/**
 * Contract/integration checks for the additive MCP read-range overlay.
 * Uses a temporary SQLite database and invokes registered handlers directly.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(os.tmpdir(), `mcp-range-nt-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let db, registerReadTools;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools } = await import('../server/lib/mcp/tools/index.js'));
} catch (e) {
  test('MCP range integration skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-range] skipping: ${(e?.message || e).split('\n')[0]}`);
  process.exit(0);
}

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, definition, handler) { this.tools.set(name, { definition, handler }); }
  async call(name, args = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.handler(args);
  }
}

let userId;
let server;
const json = result => result.structuredContent;

before(() => {
  userId = db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('mcp-range-nt', 'x', 'user')"
  ).run().lastInsertRowid;
  const foodId = db.prepare(
    "INSERT INTO foods (user_id, name, nutrition, portion, unit) VALUES (?, 'Range Banana', '{\"calories\":89}', 100, 'g')"
  ).run(userId).lastInsertRowid;
  db.prepare(
    `INSERT INTO diary (user_id, date, items, body_stats, water)
     VALUES (?, '2020-01-02', ?, '{}', '[{"amount":250}]')`
  ).run(userId, JSON.stringify([{ id: foodId, name: 'Range Banana', nutrition: { calories: 89 } }]));
  db.prepare(
    `INSERT INTO meals (user_id, name, is_recipe, last_used_at)
     VALUES (?, 'Range Meal', 0, '2020-01-02 12:00:00')`
  ).run(userId);

  server = new MockServer();
  registerReadTools(server, { userId });
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

test('tools/list registration includes range reads and advertises start/end', () => {
  for (const name of ['list_diary_entries_range', 'get_daily_totals_range']) assert.ok(server.tools.has(name), name);
  for (const name of ['list_diary_entries_range', 'get_daily_totals_range', 'get_recent_foods', 'get_recent_meals']) {
    const shape = server.tools.get(name).definition.inputSchema;
    assert.ok(shape.start, `${name}.start`);
    assert.ok(shape.end, `${name}.end`);
  }
});

test('explicit range reaches diary data older than the default 90-day window', async () => {
  const diary = json(await server.call('list_diary_entries_range', { start: '2020-01-01', end: '2020-01-03' }));
  assert.equal(diary.count, 1);
  assert.equal(diary.entries[0].items[0].name, 'Range Banana');

  const totals = json(await server.call('get_daily_totals_range', { start: '2020-01-01', end: '2020-01-03' }));
  assert.equal(totals.count, 1);
  assert.equal(totals.totals[0].totals.calories, 89);
  assert.equal(totals.totals[0].water_ml, 250);

  const foods = json(await server.call('get_recent_foods', { start: '2020-01-01', end: '2020-01-03' }));
  assert.equal(foods.count, 1);
  assert.equal(foods.items[0].name, 'Range Banana');

  const meals = json(await server.call('get_recent_meals', { start: '2020-01-01', end: '2020-01-03' }));
  assert.equal(meals.count, 1);
  assert.equal(meals.items[0].name, 'Range Meal');

  const mealsThroughEnd = json(await server.call('get_recent_meals', { end: '2020-01-02' }));
  assert.equal(mealsThroughEnd.count, 1);
});

test('range boundaries are inclusive and omitted bounds remain open', async () => {
  const exact = json(await server.call('list_diary_entries_range', { start: '2020-01-02', end: '2020-01-02' }));
  assert.equal(exact.count, 1);

  const fromStart = json(await server.call('list_diary_entries_range', { start: '2020-01-02' }));
  assert.equal(fromStart.count, 1);

  const throughEnd = json(await server.call('list_diary_entries_range', { end: '2020-01-02' }));
  assert.equal(throughEnd.count, 1);

  const defaultRange = json(await server.call('list_diary_entries_range'));
  assert.equal(defaultRange.count, 0);
});

test('range validation rejects a reversed range', async () => {
  const result = await server.call('get_daily_totals_range', { start: '2020-01-03', end: '2020-01-01' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /start must be on or before end/i);
});

test('range validation rejects impossible calendar dates', async () => {
  const result = await server.call('get_daily_totals_range', { start: '2026-02-31', end: '2026-03-01' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /YYYY-MM-DD/i);
});

test('a start-only range stays open-ended and reaches future-dated rows', async () => {
  db.prepare(
    `INSERT INTO diary (user_id, date, items, body_stats, water)
     VALUES (?, '2099-06-01', ?, '{}', '[]')`
  ).run(userId, JSON.stringify([{ name: 'Planned Oats', nutrition: { calories: 150 } }]));

  const fromStart = json(await server.call('list_diary_entries_range', { start: '2020-01-01' }));
  assert.equal(fromStart.end, null, 'the end is left open, not set to today');
  assert.deepEqual(fromStart.entries.map(e => e.date), ['2020-01-02', '2099-06-01']);

  const totals = json(await server.call('get_daily_totals_range', { start: '2099-01-01' }));
  assert.equal(totals.end, null);
  assert.deepEqual(totals.totals.map(t => t.date), ['2099-06-01']);

  const throughEnd = json(await server.call('list_diary_entries_range', { end: '2020-12-31' }));
  assert.equal(throughEnd.start, null, 'the start is left open');
  assert.deepEqual(throughEnd.entries.map(e => e.date), ['2020-01-02']);

  // With neither bound, the default window still ends today.
  const defaults = json(await server.call('get_daily_totals_range'));
  assert.match(defaults.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(defaults.end, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(defaults.count, 0, 'future-dated rows are outside the default window');
});

test('range totals match the single-day tool for each day', async () => {
  const range = json(await server.call('get_daily_totals_range', { start: '2020-01-01' }));
  assert.ok(range.count >= 2);
  for (const day of range.totals) {
    const single = json(await server.call('get_daily_totals', { date: day.date }));
    assert.deepEqual(day, single, day.date);
  }
});

test('list_diary_entries_range refuses more logged days than the cap, totals still work', async () => {
  const { MAX_RANGE_DAYS } = await import('../server/lib/mcp/tools/list-diary-range.js');
  const bigUser = db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('mcp-range-big', 'x', 'user')"
  ).run().lastInsertRowid;
  const insert = db.prepare(
    `INSERT INTO diary (user_id, date, items, body_stats, water) VALUES (?, ?, ?, '{}', '[]')`
  );
  const day = new Date(Date.UTC(2021, 0, 1));
  db.transaction(() => {
    for (let i = 0; i <= MAX_RANGE_DAYS; i++) {
      insert.run(bigUser, day.toISOString().slice(0, 10), JSON.stringify([{ name: 'Toast', nutrition: { calories: 80 } }]));
      day.setUTCDate(day.getUTCDate() + 1);
    }
  })();
  const big = new MockServer();
  registerReadTools(big, { userId: bigUser });

  const tooMany = await big.call('list_diary_entries_range', { start: '2021-01-01' });
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.content[0].text, new RegExp(`${MAX_RANGE_DAYS + 1} logged days.*limit is ${MAX_RANGE_DAYS}`));

  const atCap = json(await big.call('list_diary_entries_range', { start: '2021-01-02' }));
  assert.equal(atCap.count, MAX_RANGE_DAYS);

  const totals = json(await big.call('get_daily_totals_range', { start: '2021-01-01' }));
  assert.equal(totals.count, MAX_RANGE_DAYS + 1);
});
