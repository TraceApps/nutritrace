/**
 * Dates that can't exist (2026-02-31, 2026-13-01) are refused everywhere a
 * diary date is taken: MCP tools and the /api/v1 REST routes. They used to
 * pass a shape-only YYYY-MM-DD check, so a read returned an empty day and a
 * write created a diary row for a date that doesn't exist. REST range errors
 * answer 400 instead of 200 with an error body (#219 follow-up), and
 * GET /api/v1/meals/recent honours start/end like its MCP tool (#215).
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const TMP_DB = path.join(os.tmpdir(), `mcp-dates-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

// _util.js has no native dependencies, so the pure checks always run.
const { isCalendarDate, validateDate } = await import('../server/lib/mcp/_util.js');

test('isCalendarDate accepts real dates and refuses impossible ones', () => {
  for (const d of ['2026-01-31', '2026-02-28', '2028-02-29', '2000-02-29', '2026-12-31']) assert.equal(isCalendarDate(d), true, d);
  for (const d of ['2026-02-29', '1900-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-1', 'today', '', null, undefined, 20260101]) {
    assert.equal(isCalendarDate(d), false, String(d));
  }
  assert.equal(validateDate('2026-02-31'), null);
  assert.equal(validateDate('2026-02-28'), '2026-02-28');
});

test('no MCP tool checks a diary date by shape alone', () => {
  const dir = new URL('../server/lib/mcp/tools/', import.meta.url);
  const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
    .filter((f) => /!DATE_RE\.test\(/.test(fs.readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('REST range errors answer 400, and meals/recent passes start/end through', () => {
  const steps = read('../server/routes/api/v1/steps.js');
  assert.match(steps, /if \(result\.error\) return res\.status\(400\)\.json\(\{ error: result\.error \}\);/);
  const meals = read('../server/routes/api/v1/meals.js');
  const recent = meals.slice(meals.indexOf("router.get('/recent'"), meals.indexOf('}));', meals.indexOf("router.get('/recent'")));
  assert.match(recent, /start: req\.query\.start,/);
  assert.match(recent, /end: req\.query\.end,/);
  assert.match(recent, /if \(result\.error\) throw new Error\(result\.error\);/);
});

// ── Behaviour against a real database (skipped when better-sqlite3 can't load) ──
let db, registerReadTools, registerWriteTools, listDiaryCore;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools, registerWriteTools } = await import('../server/lib/mcp/tools/index.js'));
  ({ listDiaryCore } = await import('../server/lib/mcp/tools/list-diary.js'));
} catch (e) {
  test('MCP date validation integration skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-dates] skipping: ${(e?.message || e).split('\n')[0]}`);
}

if (db) {
  class MockServer {
    constructor() { this.tools = new Map(); }
    registerTool(name, definition, handler) { this.tools.set(name, { definition, handler }); }
    call(name, args = {}) { return this.tools.get(name).handler(args); }
  }
  let userId, foodId, server;

  before(() => {
    userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mcp-dates', 'x', 'user')").run().lastInsertRowid;
    foodId = db.prepare("INSERT INTO foods (user_id, name, nutrition, portion, unit) VALUES (?, 'Toast', '{\"calories\":80}', 30, 'g')").run(userId).lastInsertRowid;
    server = new MockServer();
    registerReadTools(server, { userId });
    registerWriteTools(server, { userId });
  });

  after(() => {
    try { db.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ } }
  });

  test('reading an impossible date is an error, not an empty day', async () => {
    assert.throws(() => listDiaryCore(userId, { date: '2026-02-31' }), /Invalid date/);
    const r = await server.call('get_daily_totals', { date: '2026-02-31' });
    assert.equal(r.isError, true);
  });

  test('logging to an impossible date writes nothing', async () => {
    const r = await server.call('log_food', { food_id: foodId, date: '2026-02-31' });
    assert.equal(r.isError, true);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM diary WHERE user_id = ? AND date = ?').get(userId, '2026-02-31');
    assert.equal(rows.n, 0);
  });

  test('a real date still works, including a leap day', async () => {
    const r = await server.call('log_food', { food_id: foodId, date: '2028-02-29' });
    assert.notEqual(r.isError, true);
    assert.equal(listDiaryCore(userId, { date: '2028-02-29' }).count, 1);
  });
}
