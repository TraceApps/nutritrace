/**
 * Focused contract tests for the body-measurements federation read route.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routeJs = readFileSync(new URL('../server/routes/api/v1/body-measurements.js', import.meta.url), 'utf8');
const apiIndex = readFileSync(new URL('../server/routes/api/v1/index.js', import.meta.url), 'utf8');
const tokensJs = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');
const docs = readFileSync(new URL('../docs/federation.md', import.meta.url), 'utf8');

test('read:body-measurements is a recognized, separately described scope', () => {
  assert.match(tokensJs, /'read:body-measurements'/);
  assert.match(tokensJs, /read:body-measurements[^\n]*persisted weight and body-composition measurements/i);
});

test('federation GET is mounted on the existing body-measurements router', () => {
  assert.match(apiIndex, /import bodyMeasurementsRouter from '\.\/body-measurements\.js'/);
  assert.match(apiIndex, /router\.use\('\/body-measurements',\s*bodyMeasurementsRouter\)/);
  assert.match(routeJs, /router\.get\('\/',\s*requireScope\('read:body-measurements'\)/);
  assert.match(routeJs, /getBodyCompositionCore\(req\.apiUser\.id/);
  assert.match(routeJs, /start:\s*req\.query\.start/);
  assert.match(routeJs, /end:\s*req\.query\.end/);
  assert.match(routeJs, /source:\s*req\.query\.source/);
});

test('federation GET has no Public API or MCP scope dependency', () => {
  assert.doesNotMatch(routeJs, /PUBLIC_API_ENABLED|PUBLIC_API_WRITE_ENABLED/);
  const getBlock = routeJs.match(/router\.get\([\s\S]*?\n\}\)\);/u)?.[0] || '';
  assert.doesNotMatch(getBlock, /mcp:read/);
  assert.match(getBlock, /read:body-measurements/);
});

test('existing POST remains write-scoped and source-compatible', () => {
  assert.match(routeJs, /router\.post\('\/',\s*requireScope\('write:body-measurements'\)/);
  assert.match(routeJs, /source='federation'/);
});

test('federation read documentation defines the source-preserving contract', () => {
  assert.match(docs, /`read:body-measurements`/);
  assert.match(docs, /GET \/api\/v1\/body-measurements/);
  assert.match(docs, /start.*end.*source/s);
  assert.match(docs, /last 90 days/);
  assert.match(docs, /different sources on the same date remain\s+separate/);
  assert.match(docs, /missing metric remains absent/);
  assert.doesNotMatch(docs, /GET \/api\/v1\/body-measurements` is not yet/);
});
