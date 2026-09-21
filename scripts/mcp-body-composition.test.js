/**
 * Focused contract tests for get_body_composition and REST parity.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const toolJs = readFileSync(new URL('../server/lib/mcp/tools/get-body-composition.js', import.meta.url), 'utf8');
const routeJs = readFileSync(new URL('../server/routes/api/v1/body-composition.js', import.meta.url), 'utf8');
const toolsIndex = readFileSync(new URL('../server/lib/mcp/tools/index.js', import.meta.url), 'utf8');
const apiIndex = readFileSync(new URL('../server/routes/api/v1/index.js', import.meta.url), 'utf8');
const tokensJs = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');

const METRICS = [
  'weight_kg', 'body_fat_pct', 'muscle_mass_kg', 'bone_mass_kg', 'body_water_pct',
  'lean_mass_kg', 'fat_mass_kg', 'visceral_fat', 'visceral_fat_index',
  'extracellular_water_kg', 'intracellular_water_kg', 'basal_metabolic_rate',
  'metabolic_age', 'bmi', 'protein', 'bmr', 'impedance', 'body_score',
  'lean_mass_torso_kg', 'lean_mass_left_leg_kg', 'lean_mass_left_arm_kg',
  'lean_mass_right_leg_kg', 'lean_mass_right_arm_kg', 'muscle_mass_torso_kg',
  'muscle_mass_left_leg_kg', 'muscle_mass_left_arm_kg', 'muscle_mass_right_leg_kg',
  'muscle_mass_right_arm_kg',
];

test('get_body_composition is registered as an MCP read tool', () => {
  assert.match(toolsIndex, /registerGetBodyComposition/);
  assert.match(toolsIndex, /registerGetBodyComposition\(server, ctx\)/);
  assert.match(toolJs, /server\.registerTool\(\s*'get_body_composition'/s);
});

test('shared core and allow-list are exported', () => {
  assert.match(toolJs, /export function getBodyCompositionCore\(userId/);
  assert.match(toolJs, /export const BODY_COMPOSITION_METRICS/);
  for (const metric of METRICS) assert.match(toolJs, new RegExp(`'${metric}'`));
});

test('REST route is mounted and reuses the shared core without direct DB access', () => {
  assert.match(apiIndex, /import bodyCompositionRouter from '\.\/body-composition\.js'/);
  assert.match(apiIndex, /router\.use\('\/body-composition',\s*bodyCompositionRouter\)/);
  assert.match(routeJs, /import \{ getBodyCompositionCore \} from/);
  assert.match(routeJs, /getBodyCompositionCore\(req\.apiUser\.id/);
  assert.doesNotMatch(routeJs, /db\.prepare/);
});

test('REST route is PUBLIC_API_ENABLED-gated and requires mcp:read', () => {
  assert.match(routeJs, /PUBLIC_API_ENABLED/);
  assert.match(routeJs, /requireScope\('mcp:read'\)/);
  assert.match(tokensJs, /mcp:read[^\n]*body composition/i);
});

process.env.DB_PATH = path.join(os.tmpdir(), `mcp-body-composition-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';

let nativeOk = true;
let db;
let registerReadTools;
let getBodyCompositionCore;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ registerReadTools } = await import('../server/lib/mcp/tools/index.js'));
  ({ getBodyCompositionCore } = await import('../server/lib/mcp/tools/get-body-composition.js'));
} catch (error) {
  nativeOk = false;
  test('behavior suite skipped when native database binding is unavailable', { skip: true }, () => {});
  console.warn(`[mcp-body-composition] skipped: ${(error?.message || error).split('\n')[0]}`);
}

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, _definition, handler) { this.tools.set(name, handler); }
  async call(name, args = {}) { return this.tools.get(name)(args); }
}

let userId;
let server;
let otherUserId;
const today = new Date().toLocaleDateString('sv-SE');
const daysAgo = days => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toLocaleDateString('sv-SE');
};

if (nativeOk) {
  test('setup: seed body metrics, non-body metric, other user and old row', () => {
    userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'admin')")
      .run(`body-composition-${process.pid}`,).lastInsertRowid;
    otherUserId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'user')")
      .run(`body-composition-other-${process.pid}`).lastInsertRowid;
    const insert = db.prepare(`
      INSERT INTO wellness_data (user_id, date, source, metric_type, value, synced_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    insert.run(userId, daysAgo(1), 'health_connect', 'weight_kg', 68.4);
    insert.run(userId, daysAgo(1), 'health_connect', 'body_fat_pct', 15.2);
    insert.run(userId, daysAgo(1), 'health_connect', 'lean_mass_left_leg_kg', 10.1);
    insert.run(userId, daysAgo(1), 'health_connect', 'steps', 9000);
    insert.run(userId, daysAgo(1), 'withings', 'weight_kg', 69.1);
    insert.run(userId, daysAgo(2), 'federation', 'bmi', 24.3);
    insert.run(userId, daysAgo(2), 'federation', 'protein', 20.7);
    insert.run(userId, '2000-01-01', 'health_connect', 'weight_kg', 50);
    insert.run(otherUserId, daysAgo(1), 'health_connect', 'weight_kg', 999);
    server = new MockServer();
    registerReadTools(server, { userId });
  });

  test('default no-arg range uses the existing 90-day range', async () => {
    const result = (await server.call('get_body_composition', {})).structuredContent;
    assert.equal(result.start, daysAgo(90));
    assert.equal(result.end, today);
    assert.ok(!result.measurements.some(row => row.date === '2000-01-01'));
  });

  test('explicit start/end are inclusive', async () => {
    const date = daysAgo(1);
    const result = (await server.call('get_body_composition', { start: date, end: date })).structuredContent;
    assert.equal(result.measurements.length, 2);
    assert.equal(result.measurements[0].date, date);
  });

  test('start-only and end-only ranges stay open', async () => {
    const startResult = (await server.call('get_body_composition', { start: daysAgo(2) })).structuredContent;
    assert.equal(startResult.end, null);
    assert.ok(startResult.measurements.some(row => row.date === daysAgo(1)));
    const endResult = (await server.call('get_body_composition', { end: daysAgo(2) })).structuredContent;
    assert.equal(endResult.start, null);
    assert.ok(endResult.measurements.some(row => row.date === '2000-01-01'));
  });

  test('impossible dates and reversed ranges return MCP errors and core errors', async () => {
    assert.equal((await server.call('get_body_composition', { start: '2026-02-30' })).isError, true);
    assert.ok(getBodyCompositionCore(userId, { start: '2026-09-10', end: '2026-09-01' }).error);
    assert.equal((await server.call('get_body_composition', { start: '2026-09-10', end: '2026-09-01' })).isError, true);
  });

  test('rows are owner-scoped, body-only, grouped by date/source and ordered', async () => {
    const result = (await server.call('get_body_composition', { start: '2000-01-01', end: '2030-01-01' })).structuredContent;
    assert.equal(result.count, 4);
    assert.deepEqual(
      result.measurements.map(row => `${row.date}:${row.source}`),
      [...result.measurements].sort((a, b) => `${a.date}:${a.source}`.localeCompare(`${b.date}:${b.source}`)).map(row => `${row.date}:${row.source}`),
    );
    const healthConnect = result.measurements.find(row => row.source === 'health_connect' && row.metrics.body_fat_pct === 15.2);
    const federation = result.measurements.find(row => row.source === 'federation');
    const withings = result.measurements.find(row => row.source === 'withings');
    assert.ok(federation);
    assert.equal(healthConnect.metrics.weight_kg, 68.4);
    assert.equal(healthConnect.metrics.body_fat_pct, 15.2);
    assert.equal(healthConnect.metrics.lean_mass_left_leg_kg, 10.1);
    assert.ok(withings);
    assert.ok(!JSON.stringify(result).includes('999'));
    assert.ok(!result.measurements.some(row => row.metrics.steps));
  });

  test('source filter is exact and same date with two sources remains two observations', async () => {
    const date = daysAgo(1);
    const filtered = (await server.call('get_body_composition', { start: date, end: date, source: 'health_connect' })).structuredContent;
    assert.equal(filtered.count, 1);
    assert.equal(filtered.measurements[0].source, 'health_connect');
    const all = (await server.call('get_body_composition', { start: date, end: date })).structuredContent;
    assert.equal(all.count, 2);
    assert.deepEqual(all.measurements.map(row => row.source), ['health_connect', 'withings']);
  });

  test('empty results are [] with count zero', async () => {
    const result = (await server.call('get_body_composition', { start: '2001-01-01', end: '2001-01-02' })).structuredContent;
    assert.deepEqual(result.measurements, []);
    assert.equal(result.count, 0);
  });
}
