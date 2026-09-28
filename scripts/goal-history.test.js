/**
 * Focused effective-date tests for nutrition goal history.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';

const TMP_DB = path.join(os.tmpdir(), `goal-history-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.NODE_ENV = 'test';

let db, captureGoalSnapshot, effectiveGoalsForDate, effectiveGoalsForRange;
let getGoalsCore, registerGetGoals;
try {
  ({ default: db } = await import('../server/db.js'));
  ({ captureGoalSnapshot, effectiveGoalsForDate, effectiveGoalsForRange } =
    await import('../server/lib/goal-history.js'));
  ({ getGoalsCore, registerGetGoals } =
    await import('../server/lib/mcp/tools/goals.js'));
} catch (e) {
  test('goal history suite skipped (native module unavailable)', { skip: true }, () => {});
  console.warn(`[goal-history] skipping: ${(e?.message || String(e)).split('\n')[0]}`);
  process.exit(0);
}

let userId;

function setSetting(key, value, deleted = false) {
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at, deleted_at)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value=excluded.value, updated_at=datetime('now'), deleted_at=excluded.deleted_at`
  ).run(userId, key, JSON.stringify(value), deleted ? new Date().toISOString() : null);
}

function setGoals(kcal, protein = 150, water = 2500) {
  setSetting('goals', {
    calories: { max: kcal, sharedGoal: true },
    proteins: { max: protein, sharedGoal: true },
  });
  setSetting('waterGoalMl', water);
  setSetting('calorieGoalMode', 'fixed');
  setSetting('calorieGoalFactor', 1);
}

before(() => {
  const u = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run('goal-history-test', 'x');
  userId = u.lastInsertRowid;
  setGoals(2000, 150, 2500);
});

after(() => {
  try { db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch {}
  }
});

test('existing user with current settings and no history keeps legacy current response', () => {
  const current = getGoalsCore(userId);
  assert.deepEqual(current, {
    goals: {
      calories: { max: 2000, sharedGoal: true },
      proteins: { max: 150, sharedGoal: true },
    },
    water_goal_ml: 2500,
  });

  const historical = getGoalsCore(userId, { date: '2026-08-31' });
  assert.equal(historical.known, false);
  assert.equal(historical.reason, 'before_first_recorded_snapshot');
  assert.equal(historical.effective_from, null);
});

test('A -> B change uses inclusive effective-date boundaries', () => {
  setGoals(2000, 150, 2500);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-01',
    changedAt: '2026-09-01T08:00:00.000Z',
    source: 'test',
  });

  setGoals(2400, 170, 3000);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-04',
    changedAt: '2026-09-04T08:00:00.000Z',
    source: 'test',
  });

  const before = effectiveGoalsForDate(userId, '2026-09-03');
  const after = effectiveGoalsForDate(userId, '2026-09-04');
  assert.equal(before.known, true);
  assert.equal(before.effective_from, '2026-09-01');
  assert.equal(before.calorie_target_kcal, 2000);
  assert.equal(before.resolved_goals.proteins, 150);
  assert.equal(before.water_goal_ml, 2500);

  assert.equal(after.effective_from, '2026-09-04');
  assert.equal(after.calorie_target_kcal, 2400);
  assert.equal(after.resolved_goals.proteins, 170);
  assert.equal(after.water_goal_ml, 3000);
});

test('multiple chronological changes are preserved across a range', () => {
  setGoals(2200, 160, 2800);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-07',
    changedAt: '2026-09-07T08:00:00.000Z',
    source: 'test',
  });
  const range = effectiveGoalsForRange(userId, '2026-09-02', '2026-09-08');
  assert.equal(range.history_complete, true);
  const byDate = new Map(range.days.map(d => [d.date, d]));
  assert.equal(byDate.get('2026-09-02').calorie_target_kcal, 2000);
  assert.equal(byDate.get('2026-09-05').calorie_target_kcal, 2400);
  assert.equal(byDate.get('2026-09-08').calorie_target_kcal, 2200);
});

test('same-day edits collapse to the latest complete snapshot and older retries are idempotent', () => {
  setGoals(2100, 155, 2600);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-10',
    changedAt: '2026-09-10T09:00:00.000Z',
    source: 'test',
  });

  setGoals(2300, 165, 2900);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-10',
    changedAt: '2026-09-10T11:00:00.000Z',
    source: 'test',
  });

  setGoals(1800, 120, 1800);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-10',
    changedAt: '2026-09-10T10:00:00.000Z',
    source: 'stale_retry',
  });

  const day = effectiveGoalsForDate(userId, '2026-09-10');
  assert.equal(day.calorie_target_kcal, 2300);
  assert.equal(day.resolved_goals.proteins, 165);
  assert.equal(day.water_goal_ml, 2900);
  assert.equal(day.changed_at, '2026-09-10T11:00:00.000Z');
});

test('reset snapshot preserves old history and makes the new date explicit', () => {
  db.prepare(`UPDATE user_settings SET deleted_at = datetime('now') WHERE user_id = ?`).run(userId);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-12',
    changedAt: '2026-09-12T08:00:00.000Z',
    source: 'settings_reset',
  });
  const before = effectiveGoalsForDate(userId, '2026-09-11');
  const reset = effectiveGoalsForDate(userId, '2026-09-12');
  assert.equal(before.calorie_target_kcal, 2300);
  assert.deepEqual(reset.goals, {});
  assert.equal(reset.calorie_target_kcal, 2000);
  assert.equal(reset.water_goal_ml, 2000);
});

test('Dynamic + activity targets resolve from the historical snapshot without drifting percent macros', () => {
  db.prepare(
    `INSERT INTO wellness_data (user_id, date, source, metric_type, value)
     VALUES (?, '2026-09-15', 'garmin', 'calories_out', 2500)`
  ).run(userId);
  db.prepare(
    `INSERT INTO wellness_data (user_id, date, source, metric_type, value)
     VALUES (?, '2026-09-16', 'garmin', 'active_calories', 200)`
  ).run(userId);
  db.prepare(
    `INSERT INTO activity_log (user_id, date, name, kcal, source)
     VALUES (?, '2026-09-16', 'Walk', 300, 'manual_form')`
  ).run(userId);

  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-15',
    changedAt: '2026-09-15T08:00:00.000Z',
    source: 'test',
    snapshot: {
      goals: {
        calories: { max: 2000, sharedGoal: true },
        proteins: { max: 30, sharedGoal: true, isPercent: true },
      },
      water_goal_ml: 2500,
      calorie_goal_mode: 'dynamic',
      calorie_goal_factor: 0.9,
      calorie_adjust_from_activity: true,
      diary_show_activity: true,
      manual_activity_policy: 'additive',
      lifttrace_overlap_fill: true,
    },
  });

  const day = effectiveGoalsForDate(userId, '2026-09-16');
  assert.equal(day.calorie_base_target_kcal, 2250);
  assert.equal(day.activity_adjustment_kcal, 500);
  assert.equal(day.calorie_target_kcal, 2750);
  assert.equal(day.resolved_goals.proteins, 169, '30% macro stays based on pre-activity 2250 kcal');
  assert.equal(day.calorie_basis.calories_out_date, '2026-09-15');
  assert.equal(day.calorie_basis.calories_out_source, 'garmin');
});

test('MCP get_goals exposes historical date and range semantics', async () => {
  class MockServer {
    constructor() { this.tools = new Map(); }
    registerTool(name, _def, handler) { this.tools.set(name, handler); }
    call(name, args) { return this.tools.get(name)(args); }
  }
  const server = new MockServer();
  registerGetGoals(server, { userId });

  const one = await server.call('get_goals', { date: '2026-09-05' });
  assert.equal(one.structuredContent.known, true);
  assert.equal(one.structuredContent.calorie_target_kcal, 2400);
  assert.equal(one.structuredContent.effective_from, '2026-09-04');

  const range = await server.call('get_goals', { start: '2026-09-03', end: '2026-09-05' });
  assert.equal(range.structuredContent.days.length, 3);
  assert.equal(range.structuredContent.days[0].calorie_target_kcal, 2000);
  assert.equal(range.structuredContent.days[2].calorie_target_kcal, 2400);
});

test('REST goals route stays on the shared getGoalsCore contract', () => {
  const src = readFileSync(new URL('../server/routes/api/v1/goals.js', import.meta.url), 'utf8');
  assert.match(src, /getGoalsCore\(req\.apiUser\.id/);
  assert.match(src, /date:\s*req\.query\.date/);
  assert.match(src, /start:\s*req\.query\.start/);
  assert.match(src, /end:\s*req\.query\.end/);
  assert.doesNotMatch(src, /db\.prepare/);
});

test('template application writes goals + water through one bulk operation', () => {
  const src = readFileSync(new URL('../src/routes/Goals.svelte', import.meta.url), 'utf8');
  const apply = src.match(/async function applyTemplate\(tpl\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(apply, /const next = \{ goals:/);
  assert.match(apply, /next\.waterGoalMl = tpl\.waterGoalMl/);
  assert.match(apply, /await bulkSet\(next\)/);
  assert.doesNotMatch(apply, /goals\.set|waterGoalMl\.set/);
});
