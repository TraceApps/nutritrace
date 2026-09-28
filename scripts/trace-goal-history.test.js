/**
 * Trace historical-goals contract checks.
 *
 * The built-in assistant has its own client-side tool registry/loop and does
 * not consume MCP tools directly. These guards keep its get_goals semantics
 * aligned with MCP without changing diary/totals retrieval.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../src/lib/aiChat.js';

const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
const serverIndex = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

test('Trace get_goals advertises current, date, and start/end forms', () => {
  const tool = TOOLS.find(t => t.name === 'get_goals');
  assert.ok(tool, 'get_goals tool missing');
  assert.ok(tool.parameters?.properties?.date, 'get_goals.date missing');
  assert.ok(tool.parameters?.properties?.start, 'get_goals.start missing');
  assert.ok(tool.parameters?.properties?.end, 'get_goals.end missing');
  assert.match(tool.description, /no arguments returns current goals/i);
  assert.match(tool.description, /historical/i);
});

test('Trace keeps legacy current-goals retrieval local and zero-argument compatible', () => {
  const start = trace.indexOf("case 'get_goals': {");
  const end = trace.indexOf("\n        case 'get_diary_averages':", start);
  assert.ok(start >= 0 && end > start, 'Trace get_goals handler not found');
  const handler = trace.slice(start, end);
  assert.match(handler, /if \(!hasHistoricalQuery\)/);
  assert.match(handler, /const g = goals\.get\(\)/);
  assert.match(handler, /return g \|\| \{\}/);
});

test('Trace historical get_goals uses the shared server effective-goals endpoint', () => {
  const start = trace.indexOf("case 'get_goals': {");
  const end = trace.indexOf("\n        case 'get_diary_averages':", start);
  const handler = trace.slice(start, end);
  assert.match(handler, /\/api\/goals\/effective/);
  assert.match(handler, /args\.date/);
  assert.match(handler, /args\.start/);
  assert.match(handler, /args\.end/);
  assert.match(handler, /Do not substitute current goals/);
});

test('Trace rejects ambiguous partial historical goal arguments instead of guessing', () => {
  const start = trace.indexOf("case 'get_goals': {");
  const end = trace.indexOf("\n        case 'get_diary_averages':", start);
  const handler = trace.slice(start, end);
  assert.match(handler, /Use either date or start\/end/);
  assert.match(handler, /Both start and end are required/);
});

test('Trace prompt marks TODAY goals as today-only and routes historical comparisons through dated get_goals', () => {
  assert.match(trace, /HISTORICAL GOAL SAFETY/);
  assert.match(trace, /Never compare past intake against the Goals line in TODAY'S SUMMARY/);
  assert.match(trace, /For a past period call get_goals with the matching start and end/);
  assert.match(trace, /Goals \(TODAY ONLY — never use as a historical target\)/);
  assert.match(trace, /never compare historical averages to current goals/);
});

test('Trace authenticated goals endpoint reuses getGoalsCore rather than reimplementing history', () => {
  assert.match(serverIndex, /import \{ getGoalsCore \} from '\.\/lib\/mcp\/tools\/goals\.js'/);
  const start = serverIndex.indexOf("router.get('/api/goals/effective'");
  const end = serverIndex.indexOf("// Adaptive TDEE", start);
  assert.ok(start >= 0 && end > start, 'effective goals route missing');
  const route = serverIndex.slice(start, end);
  assert.match(route, /getGoalsCore\(userId/);
  assert.match(route, /date:\s*req\.query\.date/);
  assert.match(route, /start:\s*req\.query\.start/);
  assert.match(route, /end:\s*req\.query\.end/);
  assert.doesNotMatch(route, /db\.prepare/, 'app route must not fork goal-history SQL');
});
