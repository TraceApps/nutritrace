/**
 * #285 (@kgenerozov): weekday goals reached Trace and MCP as a bare list of
 * seven (read as Monday-first), and Trace's summary of today used the
 * week's highest target.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-goals-weekday-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'goals-weekday-test-only';

const { default: db } = await import('../server/db.js');
const { getGoalsCore } = await import('../server/lib/mcp/tools/goals.js');
const { describeGoals, dayTargets, WEEKDAY_ORDER } = await import('../src/lib/goal-resolver.js');
after(() => { db.close(); rmSync(temp, { recursive: true, force: true }); });

// The reporter's goals.
const goals = {
  calories: { sharedGoal: false, isMin: false, days: [2400, 2400, 2700, 2400, 2700, 2400, 2700], max: 2700 },
  proteins: { sharedGoal: false, isPercent: true, days: [30, 30, 30, 30, 30, 30, 25], max: 30 },
  fat: { sharedGoal: true, max: 70 },
};

test("a date's targets are that weekday's, not the week's highest", () => {
  assert.equal(dayTargets(goals, '2026-10-13').calories, 2700, 'Tuesday');
  assert.equal(dayTargets(goals, '2026-10-14').calories, 2400, 'Wednesday');
  assert.equal(dayTargets(goals, '2026-10-18').calories, 2400, 'Sunday');
  const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
  assert.equal(week.reduce((s, d) => s + dayTargets(goals, d).calories, 0), 17700);
  assert.equal(dayTargets(goals, '2026-10-14').proteins, 180, '30% of 2400 kcal at 4 kcal/g');
  assert.equal(dayTargets(goals, '2026-10-14').fat, 70, 'a shared goal is unchanged');
});

test('weekday goals are spelled out by named day, Sunday first', () => {
  const d = describeGoals(goals, '2026-10-13');
  assert.deepEqual(d.weekday_order, ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
  assert.deepEqual(d.goals_by_weekday.calories,
    { sunday: 2400, monday: 2400, tuesday: 2700, wednesday: 2400, thursday: 2700, friday: 2400, saturday: 2700 });
  assert.equal(d.goals_by_weekday.proteins.unit, 'percent_of_calories');
  assert.equal(d.goals_by_weekday.proteins.saturday, 25);
  assert.equal(d.goals_by_weekday.fat, undefined, 'shared goals get no weekday list');
  assert.deepEqual(d.today, { date: '2026-10-13', weekday: 'tuesday', targets: dayTargets(goals, '2026-10-13') });
  assert.equal(d.today.targets.calories, 2700);
  assert.deepEqual(describeGoals({}, '2026-10-13').goals_by_weekday, {});
  assert.equal(describeGoals(goals, 'not a date').today, null);
  assert.equal(WEEKDAY_ORDER.length, 7);
});

test('MCP and REST goals keep their fields and add the named days and today', () => {
  const u = Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('g' + Math.random(), 'x').lastInsertRowid);
  const set = (k, v) => db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(u, k, JSON.stringify(v));
  set('goals', goals); set('waterGoalMl', 2500); set('timezone', 'Pacific/Kiritimati');
  const r = getGoalsCore(u);
  assert.deepEqual(r.goals, goals, 'stored goals unchanged');
  assert.equal(r.water_goal_ml, 2500);
  assert.equal(r.goals_by_weekday.calories.tuesday, 2700);
  // Today in the person's zone (UTC+14 here), not the server's.
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  assert.equal(r.today.date, p);
  assert.equal(r.today.targets.calories, dayTargets(goals, p).calories);
});

test('Trace uses them, and both get_goals descriptions say Sunday comes first', () => {
  const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
  assert.match(trace, /return \{ goals: g, \.\.\.describeGoals\(g, localDateStr\(\)\) \};/);
  assert.match(trace, /= dayTargets\(g, today\);/);
  assert.doesNotMatch(trace, /g\.calories\?\.max\s*\?\? g\.calories\?\.min/);
  for (const f of ['../src/lib/aiChat.js', '../server/lib/mcp/tools/goals.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /list starts on Sunday/, f);
    assert.match(src, /index 0 = Sunday \.\.\. 6 = Saturday/, f);
  }
});
