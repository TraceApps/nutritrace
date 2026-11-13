/**
 * Trace's get_goals contract for past periods.
 *
 * Trace has its own client-side tool loop and does not call MCP tools, so
 * these guards keep its semantics aligned with MCP and the public API
 * without changing today's summary or diary retrieval: no arguments stay
 * local and current; a date or range asks the server for the targets in
 * effect then, and unknown history (before the upgrade, single-user or local
 * mode) is answered with "the targets may have differed", never a refusal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOLS, HISTORICAL_GOALS_NOTE, historicalGoalsResult } from '../src/lib/aiChat.js';

test('Trace advertises current, date and start/end forms', () => {
  const tool = TOOLS.find(t => t.name === 'get_goals');
  assert.ok(tool, 'get_goals tool missing');
  for (const param of ['date', 'start', 'end']) assert.ok(tool.parameters?.properties?.[param], `get_goals.${param} missing`);
  assert.match(tool.description, /no arguments returns current goals/i);
  assert.match(tool.description, /historical/i);
  assert.match(tool.description, /not today's/i);
});

test('an unknown day is answered, with a note that past targets may have differed', () => {
  const unknown = historicalGoalsResult({
    date: '2026-09-10',
    known: false,
    reason: 'before_first_recorded_snapshot',
    history_available_from: '2026-09-20',
  });
  assert.equal(unknown.known, false);
  assert.equal(unknown.date, '2026-09-10');
  assert.equal(unknown.reason, 'before_first_recorded_snapshot');
  assert.equal(unknown.note, HISTORICAL_GOALS_NOTE);
  assert.match(unknown.note, /may have differed/i);
  assert.match(unknown.note, /answer the question rather than refusing/i);
});

test('a known day is passed through as the server sent it', () => {
  const known = { date: '2026-09-10', known: true, calorie_target_kcal: 2400 };
  assert.equal(historicalGoalsResult(known), known);
});

test('a range that is incomplete, or has unknown days, carries the caveat', () => {
  const range = {
    start: '2026-09-01',
    end: '2026-09-03',
    history_complete: false,
    days: [
      { date: '2026-09-01', known: false },
      { date: '2026-09-02', known: true, calorie_target_kcal: 2400 },
      { date: '2026-09-03', known: true, calorie_target_kcal: 2400 },
    ],
  };
  const answer = historicalGoalsResult(range);
  assert.equal(answer.note, HISTORICAL_GOALS_NOTE);
  assert.equal(answer.history_complete, false);
  assert.equal(answer.days.length, 3);
  // The same caveat when only the flag says so (a day inside had no target).
  assert.equal(historicalGoalsResult({ start: '2026-09-01', end: '2026-09-02', history_complete: false, days: [] }).note, HISTORICAL_GOALS_NOTE);
  // A complete range is untouched.
  const complete = { start: '2026-09-01', end: '2026-09-02', history_complete: true, days: [{ known: true }] };
  assert.equal(historicalGoalsResult(complete), complete);
});

test('history that cannot be loaded (single-user, local mode) is still an answer', () => {
  const answer = historicalGoalsResult(null, new Error('Historical goals are not available in local mode.'));
  assert.equal(answer.known, false);
  assert.equal(answer.history_unavailable, true);
  assert.equal(answer.note, HISTORICAL_GOALS_NOTE);
  assert.equal(answer.detail, 'Historical goals are not available in local mode.');
  assert.equal(answer.error, undefined, 'not a tool error: Trace answers with the caveat');
});
