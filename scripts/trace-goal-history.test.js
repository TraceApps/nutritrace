/**
 * Trace's get_goals contract for past periods.
 *
 * Trace has its own client-side tool loop and does not call MCP tools, so
 * these guards keep its semantics aligned with MCP and the public API
 * without changing today's summary or diary retrieval: no arguments stay
 * local and current; a date or range goes to the server's goal history, and
 * an unavailable answer is reported as unknown rather than replaced with
 * today's targets.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../src/lib/aiChat.js';

const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
const start = trace.indexOf("case 'get_goals': {");
const end = trace.indexOf("\n        case 'get_diary_averages':", start);
const handler = trace.slice(start, end);

test('Trace advertises current, date and start/end forms', () => {
  const tool = TOOLS.find(t => t.name === 'get_goals');
  assert.ok(tool, 'get_goals tool missing');
  assert.ok(tool.parameters?.properties?.date, 'get_goals.date missing');
  assert.ok(tool.parameters?.properties?.start, 'get_goals.start missing');
  assert.ok(tool.parameters?.properties?.end, 'get_goals.end missing');
  assert.match(tool.description, /no arguments returns current goals/i);
  assert.match(tool.description, /historical/i);
  assert.match(tool.description, /not today's/i);
});

test('no arguments keep the current-goals path local and unchanged', () => {
  assert.ok(start >= 0 && end > start, 'Trace get_goals handler not found');
  assert.match(handler, /if \(!hasHistoricalQuery\)/);
  assert.match(handler, /const g = goals\.get\(\) \|\| \{\};/);
  assert.match(handler, /return \{ goals: g, \.\.\.describeGoals\(g, localDateStr\(\)\) \};/);
});

test('a date or range goes to the shared effective-goals endpoint', () => {
  assert.match(handler, /\/api\/goals\/effective/);
  assert.match(handler, /args\.date/);
  assert.match(handler, /args\.start/);
  assert.match(handler, /args\.end/);
  assert.match(handler, /Do not substitute current goals/);
});

test('ambiguous or malformed historical arguments are refused, not guessed', () => {
  assert.match(handler, /Use either date or start\/end/);
  assert.match(handler, /Both start and end are required/);
  assert.match(handler, /Historical goals need YYYY-MM-DD dates/);
});

test("today's summary is marked today-only and old comparisons go through dated goals", () => {
  assert.match(trace, /HISTORICAL GOAL SAFETY/);
  assert.match(trace, /Never compare past intake against the Goals line in TODAY'S SUMMARY/);
  assert.match(trace, /For a past period call get_goals with the matching start and end/);
  assert.match(trace, /Goals \(TODAY ONLY — never use as a historical target\)/);
  assert.match(trace, /never compare historical averages to current goals/);
});
