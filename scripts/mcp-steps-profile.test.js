/**
 * Tests for the get_steps and get_profile MCP tools and their REST
 * parity routes (GET /api/v1/steps, GET /api/v1/profile).
 *
 * Two layers, mirroring the split the other suites use:
 *
 * 1. Static wiring checks (pure text/regex over the source files, no
 *    db.js import, run anywhere) — route mounts, feature flags, scope
 *    gating, and the xCore reuse contract.
 *
 * 2. Behavior checks against a real temp SQLite database, invoking the
 *    tool handlers through a mock McpServer (same pattern as
 *    mcp-integration.test.js). Skipped with a diagnostic when the
 *    better-sqlite3 native binding does not match the running Node
 *    (run inside the Docker image for full coverage).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ────────────────────────────────────────────────────────────────────
// Static wiring (no native module needed)
// ────────────────────────────────────────────────────────────────────

const indexJs     = readFileSync(new URL('../server/routes/api/v1/index.js', import.meta.url), 'utf8');
const stepsJs     = readFileSync(new URL('../server/routes/api/v1/steps.js', import.meta.url), 'utf8');
const profileJs   = readFileSync(new URL('../server/routes/api/v1/profile.js', import.meta.url), 'utf8');
const toolsIndex  = readFileSync(new URL('../server/lib/mcp/tools/index.js', import.meta.url), 'utf8');
const apiTokensJs = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');

test('steps/profile sub-routers are mounted under /api/v1/index.js', () => {
  assert.match(indexJs, /import stepsRouter from '\.\/steps\.js'/);
  assert.match(indexJs, /import profileRouter from '\.\/profile\.js'/);
  assert.match(indexJs, /router\.use\('\/steps',\s*stepsRouter\)/);
  assert.match(indexJs, /router\.use\('\/profile',\s*profileRouter\)/);
});

test('steps/profile sub-routers are feature-flagged on PUBLIC_API_ENABLED', () => {
  for (const [name, src] of [['steps.js', stepsJs], ['profile.js', profileJs]]) {
    assert.match(src, /PUBLIC_API_ENABLED/, `${name} should check PUBLIC_API_ENABLED`);
  }
});

test('steps/profile routes reuse mcp:read and call the shared xCore functions', () => {
  for (const [name, src, coreFn] of [
    ['steps.js', stepsJs, 'getStepsCore'],
    ['profile.js', profileJs, 'getProfileCore'],
  ]) {
    assert.doesNotMatch(src, /db\.prepare/, `${name} should not query the DB directly, only via xCore imports`);
    assert.match(src, new RegExp(`import \\{ ${coreFn} \\} from`), `${name} should import ${coreFn}`);
    assert.match(src, new RegExp(`${coreFn}\\(req\\.apiUser\\.id`), `${name} should call ${coreFn} with the token owner's id`);
    const getRoutes = [...src.matchAll(/router\.get\(('[^']+'|"[^"]+")\s*,\s*([^,]+),/g)];
    for (const [, p, middleware] of getRoutes) {
      assert.match(middleware, /requireScope\('mcp:read'\)/, `${p} in ${name} should require mcp:read`);
    }
  }
});

test('get_steps and get_profile are registered as read tools', () => {
  assert.match(toolsIndex, /import \{ registerGetSteps \} from '\.\/get-steps\.js'/);
  assert.match(toolsIndex, /import \{ registerGetProfile \} from '\.\/profile\.js'/);
  assert.match(toolsIndex, /\bregisterGetSteps\s*\(/);
  assert.match(toolsIndex, /\bregisterGetProfile\s*\(/);
});

test('both cores are exported from their tool files', () => {
  const profileTool = readFileSync(new URL('../server/lib/mcp/tools/profile.js', import.meta.url), 'utf8');
  const stepsToolSrc = readFileSync(new URL('../server/lib/mcp/tools/get-steps.js', import.meta.url), 'utf8');
  assert.match(stepsToolSrc, /export function getStepsCore\(/);
  assert.match(stepsToolSrc, /getStepsCore\(userId/);
  assert.match(profileTool, /export function getProfileCore\(/);
  assert.match(profileTool, /getProfileCore\(userId/);
});

test('mcp:read scope description mentions steps and profile', () => {
  const desc = apiTokensJs.match(/SCOPE_DESCRIPTIONS = \{([\s\S]*?)\n\};/)[1];
  assert.match(desc, /mcp:read/);
  const readLine = desc.split('\n').find(l => l.includes("'mcp:read'"));
  assert.match(readLine, /steps/);
  assert.match(readLine, /profile/i);
  assert.match(readLine, /gender/);
  assert.match(readLine, /date of birth/i);
});

// ────────────────────────────────────────────────────────────────────
// Behavior (real temp SQLite; skipped on native-module mismatch)
// ────────────────────────────────────────────────────────────────────

const TMP_DB = path.join(os.tmpdir(), `mcp-steps-profile-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let nativeOk = true;
let db, registerReadTools, getStepsCore, getProfileCore;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools } = await import('../server/lib/mcp/tools/index.js'));
  ({ getStepsCore } = await import('../server/lib/mcp/tools/get-steps.js'));
  ({ getProfileCore } = await import('../server/lib/mcp/tools/profile.js'));
} catch (e) {
  nativeOk = false;
  const msg = e?.message || String(e);
  test('steps/profile behavior suite skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[mcp-steps-profile] skipping behavior tests: ${msg.split('\n')[0]}`);
  if (/better_sqlite3\.node/i.test(msg)) {
    console.warn('[mcp-steps-profile] Node ABI mismatch on better-sqlite3. Run inside the Docker image, or `cd server && npm rebuild better-sqlite3` to build against the local Node.');
  }
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

let userId, otherUserId, server;

if (nativeOk) {
  test('setup: seed users, wellness steps and profile data', () => {
    const u = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
      .run('steps-profile-test', 'x');
    userId = u.lastInsertRowid;

    const o = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')")
      .run('steps-profile-other', 'x');
    otherUserId = o.lastInsertRowid;

    // Steps from two sources on a range of dates (well inside the
    // default 90-day window), plus one old row outside it, plus one
    // row for the OTHER user that must never leak across.
    const ins = db.prepare(
      `INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
       VALUES (?, ?, ?, 'steps', ?, datetime('now'))`
    );
    ins.run(userId, '2026-09-01', 'fitbit', 8432);
    ins.run(userId, '2026-09-02', 'fitbit', 9100);
    ins.run(userId, '2026-09-02', 'google_fit', 9055);
    ins.run(userId, '2026-09-03', 'fitbit', 7777);
    ins.run(userId, '2020-01-01', 'fitbit', 100);   // outside default range
    ins.run(otherUserId, '2026-09-02', 'fitbit', 999999);   // cross-user, must never appear
    // A non-steps wellness metric on the same date — must be excluded.
    db.prepare(
      `INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
       VALUES (?, '2026-09-02', 'fitbit', 'calories_burned', 2200, datetime('now'))`
    ).run(userId);

    server = new MockServer();
    registerReadTools(server, { userId });
  });

  test('get_steps default range returns seeded rows ordered by date then source', async () => {
    const r = await server.call('get_steps', {});
    const sc = r.structuredContent;
    assert.equal(sc.count, 4);
    assert.equal(sc.steps[0].date, '2026-09-01');
    // Same date, two sources: fitbit sorts before google_fit.
    assert.equal(sc.steps[1].date, '2026-09-02');
    assert.equal(sc.steps[1].source, 'fitbit');
    assert.equal(sc.steps[2].source, 'google_fit');
    assert.equal(sc.steps[3].date, '2026-09-03');
    // The 2020 row is outside the default window.
    assert.ok(!sc.steps.some(s => s.date === '2020-01-01'));
  });

  test('get_steps explicit range filters inclusively', async () => {
    const r = await server.call('get_steps', { start: '2026-09-02', end: '2026-09-02' });
    const sc = r.structuredContent;
    assert.equal(sc.count, 2);
    assert.equal(sc.start, '2026-09-02');
    assert.equal(sc.end, '2026-09-02');
  });

  test('get_steps source filter returns only that source', async () => {
    const r = await server.call('get_steps', { source: 'google_fit' });
    const sc = r.structuredContent;
    assert.equal(sc.count, 1);
    assert.equal(sc.steps[0].source, 'google_fit');
    assert.equal(sc.steps[0].steps, 9055);
  });

  test('get_steps does not merge values across sources (per-source rows)', async () => {
    const r = await server.call('get_steps', { start: '2026-09-02', end: '2026-09-02' });
    const sc = r.structuredContent;
    assert.equal(sc.steps.length, 2);
    assert.equal(sc.steps.find(s => s.source === 'fitbit').steps, 9100);
    assert.equal(sc.steps.find(s => s.source === 'google_fit').steps, 9055);
  });

  test('get_steps end-only range is open on the start side (reaches old rows)', async () => {
    const r = await server.call('get_steps', { end: '2020-12-31' });
    const sc = r.structuredContent;
    assert.equal(sc.count, 1);
    assert.equal(sc.steps[0].date, '2020-01-01');
  });

  test('get_steps invalid range returns a tool error', async () => {
    const r = await server.call('get_steps', { start: 'not-a-date' });
    assert.equal(r.isError, true);
    const r2 = await server.call('get_steps', { start: '2026-09-10', end: '2026-09-01' });
    assert.equal(r2.isError, true);
  });

  test('getStepsCore returns {error} for an invalid range (REST convention)', () => {
    assert.ok(getStepsCore(userId, { start: 'garbage' }).error);
  });

  test('get_steps never returns another user\u2019s rows', async () => {
    const r = await server.call('get_steps', { start: '2000-01-01', end: '2030-01-01' });
    const sc = r.structuredContent;
    assert.ok(sc.count >= 5);
    assert.ok(!sc.steps.some(s => s.steps === 999999), 'other user\u2019s step value must not appear');
  });

  test('get_steps empty result is a clean empty list, not zeros', async () => {
    const r = await server.call('get_steps', { start: '2001-01-01', end: '2001-01-02' });
    const sc = r.structuredContent;
    assert.deepEqual(sc.steps, []);
    assert.equal(sc.count, 0);
  });

  test('get_profile users-table values win over user_settings fallback', async () => {
    db.prepare('UPDATE users SET birthday = ?, gender = ? WHERE id = ?')
      .run('1990-05-17', 'male', userId);
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'dob', ?)")
      .run(userId, JSON.stringify('1975-01-01'));
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'gender', ?)")
      .run(userId, JSON.stringify('female'));
    const r = await server.call('get_profile', {});
    assert.deepEqual(r.structuredContent, { gender: 'male', birthday: '1990-05-17' });
  });

  test('get_profile falls back to user_settings when users columns are empty', async () => {
    db.prepare('UPDATE users SET birthday = NULL, gender = NULL WHERE id = ?').run(userId);
    const r = await server.call('get_profile', {});
    assert.deepEqual(r.structuredContent, { gender: 'female', birthday: '1975-01-01' });
  });

  test('get_profile ignores tombstoned user_settings rows', async () => {
    db.prepare("UPDATE user_settings SET deleted_at = datetime('now') WHERE user_id = ? AND key IN ('dob','gender')")
      .run(userId);
    const r = await server.call('get_profile', {});
    assert.deepEqual(r.structuredContent, { gender: null, birthday: null });
  });

  test('get_profile returns nulls when nothing is set anywhere', async () => {
    const fresh = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')")
      .run('steps-profile-empty', 'x').lastInsertRowid;
    const profile = getProfileCore(fresh);
    assert.deepEqual(profile, { gender: null, birthday: null });
  });

  test('getProfileCore accepts legacy bare-string user_settings values', () => {
    const u = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')")
      .run('steps-profile-legacy', 'x').lastInsertRowid;
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'dob', '1988-03-03')")
      .run(u);
    db.prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, 'gender', 'female')")
      .run(u);
    assert.deepEqual(getProfileCore(u), { gender: 'female', birthday: '1988-03-03' });
  });

  test('get_profile scope contract: exactly {gender, birthday} shape', async () => {
    const r = await server.call('get_profile', {});
    assert.deepEqual(Object.keys(r.structuredContent).sort(), ['birthday', 'gender']);
  });
}
