/**
 * Static-analysis tests for the MCP endpoint wiring (#103).
 *
 * These do not exercise the wire protocol; they only guard against
 * accidental unwiring of the route mount, the scope registration, or
 * the tool registrations during future refactors. End-to-end protocol
 * verification is done by running the server with MCP_ENABLED=1 and
 * pointing a real MCP client at it (docs/mcp.md covers setup).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs      = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const mcpRoute     = readFileSync(new URL('../server/routes/mcp.js', import.meta.url), 'utf8');
const mcpServer    = readFileSync(new URL('../server/lib/mcp/server.js', import.meta.url), 'utf8');
const mcpTools     = readFileSync(new URL('../server/lib/mcp/tools/index.js', import.meta.url), 'utf8');
const apiTokens    = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');
const pkgJson      = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'));

test('MCP route is mounted at /api/mcp on the main router', () => {
  assert.match(indexJs, /import mcpRoutes[\s\S]*from '\.\/routes\/mcp\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/mcp',\s*mcpRoutes\)/);
});

test('MCP route is feature-flagged on MCP_ENABLED and requires bearer + at-least-one mcp:* scope', () => {
  assert.match(mcpRoute, /MCP_ENABLED/);
  assert.match(mcpRoute, /bearerAuth/);
  // Any-of-mcp:* check: route-level gate accepts read, write, OR destroy
  // (so a write-only or destroy-only token isn't unusable). Per-tool
  // scope enforcement happens at registration time.
  assert.match(mcpRoute, /requireAnyMcpScope/);
  assert.match(mcpRoute, /'mcp:read'/);
  assert.match(mcpRoute, /'mcp:write'/);
  assert.match(mcpRoute, /'mcp:destroy'/);
});

test('MCP route validates Origin as a DNS-rebinding defense', () => {
  assert.match(mcpRoute, /_isOriginAllowed|Origin not allowed|origin_rejected/);
});

test('mcp:read scope is registered in KNOWN_SCOPES so tokens can hold it', () => {
  assert.match(apiTokens, /'mcp:read'/);
});

test('mcp:write scope is registered (Phase 2)', () => {
  assert.match(apiTokens, /'mcp:write'/);
});

test('mcp:destroy scope is registered (Phase 3)', () => {
  assert.match(apiTokens, /'mcp:destroy'/);
});

test('MCP route computes write eligibility from MCP_WRITE_ENABLED + mcp:write scope', () => {
  assert.match(mcpRoute, /MCP_WRITE_ENABLED/);
  assert.match(mcpRoute, /mcp:write/);
  assert.match(mcpRoute, /req\.mcpWrites/);
});

test('MCP route computes destroy eligibility from MCP_DESTROY_ENABLED + mcp:destroy scope', () => {
  assert.match(mcpRoute, /MCP_DESTROY_ENABLED/);
  assert.match(mcpRoute, /mcp:destroy/);
  assert.match(mcpRoute, /req\.mcpDestroy/);
});

test('MCP server registers write tools only when req.mcpWrites is true', () => {
  assert.match(mcpServer, /registerWriteTools/);
  assert.match(mcpServer, /req\.mcpWrites/);
});

test('MCP server registers destroy tools only when req.mcpDestroy is true', () => {
  assert.match(mcpServer, /registerDestroyTools/);
  assert.match(mcpServer, /req\.mcpDestroy/);
});

test('MCP transport is stateless (no session id generator)', () => {
  // Stateless mode is what current MCP clients (Claude Desktop / Cursor
  // / Codex) expect for a read-only server; switching to stateful would
  // add per-session state that Phase 1 doesn't need. Keep sessionIdGenerator
  // undefined until a tool genuinely needs a session.
  assert.match(mcpServer, /sessionIdGenerator:\s*undefined/);
});

test('All Phase 1 read tools are registered', () => {
  const expected = [
    'registerGetGoals',
    'registerListDiary',
    'registerDailyTotals',
    'registerSearchFoods',
    'registerRecentFoods',
  ];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('All Phase 2 write tools are registered in registerWriteTools', () => {
  const expected = [
    'registerLogFood',
    'registerLogWater',
    'registerLogMeal',
    'registerLogBodyStat',
  ];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('All Phase 3 destructive tools are registered in registerDestroyTools', () => {
  const expected = [
    'registerDeleteDiaryEntry',
    'registerEditDiaryEntry',
    'registerCreateFood',
  ];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('Every Phase 3 destructive tool requires confirm=true', () => {
  const destroyFiles = ['delete-diary-entry.js', 'edit-diary-entry.js', 'create-food.js'];
  for (const f of destroyFiles) {
    const src = readFileSync(
      new URL(`../server/lib/mcp/tools/${f}`, import.meta.url),
      'utf8'
    );
    assert.match(
      src,
      /confirm\s*!==\s*true/,
      `${f} does not appear to require confirm=true — check its input handling`
    );
    assert.match(
      src,
      /confirm:\s*z\.boolean\(\)/,
      `${f} does not declare confirm as a boolean in inputSchema`
    );
  }
});

test('@modelcontextprotocol/sdk is declared as a runtime dependency', () => {
  const deps = pkgJson.dependencies || {};
  assert.ok(deps['@modelcontextprotocol/sdk'], 'missing @modelcontextprotocol/sdk in dependencies');
  assert.ok(deps['zod'], 'missing zod (SDK peer + used for tool inputSchema) in dependencies');
});

test('MCP tool DB queries scope on user_id — no cross-user access', () => {
  // Every tool that queries the DB directly must filter by user_id.
  // If a future tool forgets, this test surfaces it before merge.
  const toolFiles = [
    'goals.js',
    'list-diary.js',
    'daily-totals.js',
    'search-foods.js',
    'recent-foods.js',
    'log-food.js',
    'log-water.js',
    'log-meal.js',
    'log-body-stat.js',
    'delete-diary-entry.js',
    'edit-diary-entry.js',
    'create-food.js',
  ];
  for (const f of toolFiles) {
    const src = readFileSync(
      new URL(`../server/lib/mcp/tools/${f}`, import.meta.url),
      'utf8'
    );
    if (/db\.prepare|\.get\(|\.all\(/.test(src)) {
      assert.match(
        src,
        /WHERE\s+user_id\s*=\s*\?/i,
        `${f} queries the DB but does not appear to scope on user_id`
      );
    }
  }
});
