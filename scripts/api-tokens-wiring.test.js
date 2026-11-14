/**
 * Static-analysis tests for personal API token management wiring.
 *
 * These guard against accidental reintroduction of admin-only gating
 * on the token CRUD route, or unwiring of the dual mount paths /
 * per-user SQL filters. Pure text/regex checks over the source files,
 * no db.js import, so this runs without a compiled better-sqlite3
 * native binding.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs   = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const routeJs   = readFileSync(new URL('../server/routes/api-tokens.js', import.meta.url), 'utf8');
const libJs     = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');
const uiSvelte  = readFileSync(new URL('../src/components/settings/SettingsApiTokens.svelte', import.meta.url), 'utf8');

test('api-tokens CRUD route requires session auth (requireAuth) and does not require admin', () => {
  assert.match(routeJs, /router\.use\(requireAuth\)/);
  assert.doesNotMatch(routeJs, /requireAdmin/);
  assert.doesNotMatch(routeJs, /bearerAuth/);
});

test('api-tokens route is mounted at /api/tokens with legacy /api/admin/api-tokens alias', () => {
  assert.match(indexJs, /import apiTokensRoutes[\s\S]*from '\.\/routes\/api-tokens\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/tokens',\s*apiTokensRoutes\)/);
  assert.match(indexJs, /router\.use\('\/api\/admin\/api-tokens',\s*apiTokensRoutes\)/);
});

test('listTokens and revokeToken filter by user_id', () => {
  assert.match(libJs, /WHERE user_id = \?/);
  assert.match(libJs, /DELETE FROM api_tokens WHERE id = \? AND user_id = \?/);
});

test('SettingsApiTokens.svelte calls /api/tokens, not the legacy admin path', () => {
  // Quote-anchored so /api/tokens cannot false-match a longer path like
  // the legacy admin mount or a doubled api-tokens segment.
  assert.match(uiSvelte, /apiUrl\('\/api\/tokens'\)/);
  assert.match(uiSvelte, /apiUrl\(`\/api\/tokens\/\$\{t\.id\}`\)/);
  assert.doesNotMatch(uiSvelte, /\/api\/admin\/api-tokens/);
  assert.doesNotMatch(uiSvelte, /\/api\/api-tokens/);
});
