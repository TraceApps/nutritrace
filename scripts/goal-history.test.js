/**
 * Goal history: the goals that were in effect on a past local calendar day.
 *
 * One complete snapshot per person per date, effective from that date until
 * the day before the next; several changes in a day collapse to the day's
 * final configuration; a date before the first snapshot is unknown rather
 * than being today's goals. Resolution reuses the app's own rules, so
 * weekday goals, percent macros, Dynamic/Adaptive calories and the activity
 * adjustment read from the snapshot's settings and from the data available
 * at that date.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'nutritrace-goal-history-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'goal-history-test-only';

const { default: db } = await import('../server/db.js');
const {
  captureGoalSnapshot, currentUserToday, effectiveGoalsForDate, effectiveGoalsForRange, userToday, isGoalHistoryDate,
} = await import('../server/lib/goal-history.js');
const { computeAdaptiveTdee } = await import('../server/lib/adaptive-tdee.js');
const { getGoalsCore, registerGetGoals } = await import('../server/lib/mcp/tools/goals.js');
const { goalSnapshot, normalizeGoalSnapshot } = await import('../src/lib/goal-snapshot.js');
const { WEEKDAY_ORDER } = await import('../src/lib/goal-resolver.js');
const { goalDateInZone } = await import('../src/lib/goal-snapshot.js');

let userId;

const setSetting = (key, value, deleted = false) => db.prepare(
  `INSERT INTO user_settings (user_id, key, value, updated_at, deleted_at)
   VALUES (?, ?, ?, datetime('now'), ?)
   ON CONFLICT(user_id, key) DO UPDATE SET
     value = excluded.value, updated_at = datetime('now'), deleted_at = excluded.deleted_at`
).run(userId, key, JSON.stringify(value), deleted ? new Date().toISOString() : null);

function setGoals(kcal, protein = 150, water = 2500) {
  setSetting('goals', {
    calories: { max: kcal, sharedGoal: true },
    proteins: { max: protein, sharedGoal: true },
  });
  setSetting('waterGoalMl', water);
  setSetting('calorieGoalMode', 'fixed');
  setSetting('calorieGoalFactor', 1);
}

function mockServer() {
  return {
    tools: new Map(),
    registerTool(name, _def, handler) { this.tools.set(name, handler); },
    call(name, args = {}) { return this.tools.get(name)(args); },
  };
}

before(() => {
  userId = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run('goal-history-test', 'x').lastInsertRowid);
  setGoals(2000, 150, 2500);
});

after(() => {
  try { db.close(); } catch {}
  rmSync(temp, { recursive: true, force: true });
});

test('current goals keep their shape, and a date before history is unknown', () => {
  const current = getGoalsCore(userId);
  assert.deepEqual(current.goals, {
    calories: { max: 2000, sharedGoal: true },
    proteins: { max: 150, sharedGoal: true },
  });
  assert.equal(current.water_goal_ml, 2500);
  assert.ok(current.goals_by_weekday, 'weekday goals are described');
  assert.ok(current.today?.targets, "today's targets are resolved");

  const historical = getGoalsCore(userId, { date: '2026-08-31' });
  assert.equal(historical.known, false);
  assert.equal(historical.reason, 'before_first_recorded_snapshot');
  assert.equal(historical.effective_from, null);
  assert.equal(historical.history_available_from, null);
  assert.equal(historical.calorie_target_kcal, undefined);
});

test('a snapshot is effective from its own date, until the next one', () => {
  captureGoalSnapshot(userId, { effectiveDate: '2026-09-01', changedAt: '2026-09-01T08:00:00.000Z' });
  setGoals(2400, 170, 3000);
  captureGoalSnapshot(userId, { effectiveDate: '2026-09-04', changedAt: '2026-09-04T08:00:00.000Z' });

  const before = effectiveGoalsForDate(userId, '2026-09-03');
  assert.equal(before.known, true);
  assert.equal(before.effective_from, '2026-09-01');
  assert.equal(before.calorie_target_kcal, 2000);
  assert.equal(before.resolved_goals.proteins, 150);
  assert.equal(before.water_goal_ml, 2500);

  const after = effectiveGoalsForDate(userId, '2026-09-04');
  assert.equal(after.effective_from, '2026-09-04');
  assert.equal(after.calorie_target_kcal, 2400);
  assert.equal(after.resolved_goals.proteins, 170);
  assert.equal(after.water_goal_ml, 3000);
});

test('a range reports each day and whether all of them are known', () => {
  setGoals(2200, 160, 2800);
  captureGoalSnapshot(userId, { effectiveDate: '2026-09-07', changedAt: '2026-09-07T08:00:00.000Z' });
  const range = effectiveGoalsForRange(userId, '2026-09-02', '2026-09-08');
  assert.equal(range.history_complete, true);
  assert.equal(range.history_available_from, '2026-09-01');
  const byDate = new Map(range.days.map(day => [day.date, day]));
  assert.equal(byDate.get('2026-09-02').calorie_target_kcal, 2000);
  assert.equal(byDate.get('2026-09-05').calorie_target_kcal, 2400);
  assert.equal(byDate.get('2026-09-08').calorie_target_kcal, 2200);

  const part = effectiveGoalsForRange(userId, '2026-08-30', '2026-09-02');
  assert.equal(part.history_complete, false);
  assert.equal(part.days[0].known, false);
  assert.equal(part.days[0].history_available_from, '2026-09-01');
});

test('same-day edits collapse to the latest snapshot, and an older retry loses', () => {
  setGoals(2100, 155, 2600);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-10', changedAt: '2026-09-10T09:00:00.000Z', source: 'test',
  });
  setGoals(2300, 165, 2900);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-10', changedAt: '2026-09-10T11:00:00.000Z', source: 'test',
  });
  // A queued change from an older moment in the same day, arriving late.
  setGoals(1800, 120, 1800);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-10', changedAt: '2026-09-10T10:00:00.000Z', source: 'stale_retry',
  });

  const day = effectiveGoalsForDate(userId, '2026-09-10');
  assert.equal(day.calorie_target_kcal, 2300);
  assert.equal(day.resolved_goals.proteins, 165);
  assert.equal(day.water_goal_ml, 2900);
  assert.equal(day.changed_at, '2026-09-10T11:00:00.000Z');
  assert.equal(day.source, 'test');
});

test('reset keeps older days and makes the reset day explicitly the defaults', () => {
  db.prepare(`UPDATE user_settings SET deleted_at = datetime('now') WHERE user_id = ?`).run(userId);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-12', changedAt: '2026-09-12T08:00:00.000Z', source: 'settings_reset',
  });
  const before = effectiveGoalsForDate(userId, '2026-09-11');
  const reset = effectiveGoalsForDate(userId, '2026-09-12');
  assert.equal(before.calorie_target_kcal, 2300);
  assert.deepEqual(reset.goals, {});
  assert.equal(reset.calorie_target_kcal, 2000);
  assert.equal(reset.water_goal_ml, 2000);
  assert.equal(reset.source, 'settings_reset');
});

test('weekday goals and percent macros resolve on the historical date', () => {
  setGoals(2000, 150, 2500);
  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-14',
    changedAt: '2026-09-14T08:00:00.000Z',
    snapshot: {
      goals: {
        calories: { sharedGoal: false, days: [2400, 2400, 2700, 2400, 2700, 2400, 2700], max: 2700 },
        proteins: { sharedGoal: false, isPercent: true, days: [30, 30, 30, 30, 30, 25, 25], max: 30 },
      },
      water_goal_ml: 2500,
      calorie_goal_mode: 'fixed',
      calorie_goal_factor: 1,
      calorie_adjust_from_activity: false,
      diary_show_activity: false,
      manual_activity_policy: 'wearable_wins',
      lifttrace_overlap_fill: true,
    },
  });

  const tuesday = effectiveGoalsForDate(userId, '2026-09-15');
  assert.equal(tuesday.calorie_target_kcal, 2700);
  assert.equal(tuesday.resolved_goals.proteins, 203, '30% of 2700 kcal at 4 kcal/g');
  assert.equal(tuesday.goals_by_weekday.calories.tuesday, 2700);
  assert.equal(tuesday.targets.proteins, 203);
  assert.equal(tuesday.calorie_basis.mode, 'fixed');

  const sunday = effectiveGoalsForDate(userId, '2026-09-20');
  assert.equal(sunday.calorie_target_kcal, 2400);
  assert.equal(sunday.resolved_goals.proteins, 180, '30% of 2400 kcal');
  assert.equal(sunday.targets.calories, 2400);
});

test('Dynamic and activity-aware targets resolve from the snapshot, percent macros stay on the base', () => {
  db.prepare(
    `INSERT INTO wellness_data (user_id, date, source, metric_type, value)
     VALUES (?, '2026-09-21', 'garmin', 'calories_out', 2500)`
  ).run(userId);
  db.prepare(
    `INSERT INTO wellness_data (user_id, date, source, metric_type, value)
     VALUES (?, '2026-09-22', 'garmin', 'active_calories', 200)`
  ).run(userId);
  db.prepare(
    `INSERT INTO activity_log (user_id, date, name, kcal, source)
     VALUES (?, '2026-09-22', 'Walk', 300, 'manual_form')`
  ).run(userId);
  db.prepare(`UPDATE user_settings SET deleted_at = datetime('now') WHERE user_id = ?`).run(userId);

  captureGoalSnapshot(userId, {
    effectiveDate: '2026-09-21',
    changedAt: '2026-09-21T08:00:00.000Z',
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

  const day = effectiveGoalsForDate(userId, '2026-09-22');
  assert.equal(day.calorie_base_target_kcal, 2250, 'yesterday: 2500 x 0.9');
  assert.equal(day.activity_adjustment_kcal, 500, 'wearable 200 + manual 300, additive');
  assert.equal(day.calorie_target_kcal, 2750);
  assert.equal(day.resolved_goals.proteins, 169, '30% stays on the 2250 base, before activity');
  assert.equal(day.calorie_basis.mode, 'dynamic');
  assert.equal(day.calorie_basis.calories_out_date, '2026-09-21');
  assert.equal(day.calorie_basis.calories_out_source, 'garmin');
});

test('a historical Adaptive goal uses only the observations up to that date', () => {
  db.prepare('DELETE FROM diary WHERE user_id = ?').run(userId);
  db.prepare("DELETE FROM wellness_data WHERE user_id = ? AND metric_type = 'weight_kg'").run(userId);
  const days = [];
  const start = Date.UTC(2026, 0, 1, 12);
  for (let i = 0; i < 30; i++) {
    const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
    days.push(d);
    db.prepare(`INSERT INTO diary (user_id, date, items) VALUES (?, ?, ?)`)
      .run(userId, d, JSON.stringify([{ name: 'meal', nutrition: { calories: 2000 }, quantity: 1 }]));
    db.prepare(`INSERT INTO wellness_data (user_id, date, source, metric_type, value) VALUES (?, ?, 'withings', 'weight_kg', 80)`)
      .run(userId, d);
  }
  const anchor = days[24];
  const atAnchor = computeAdaptiveTdee(userId, { endDate: anchor });
  assert.equal(atAnchor.ready, true);
  assert.equal(atAnchor.tdee, 2000);

  // Later intake and a heavier scale reading must not move the old day.
  for (const d of days.slice(25)) {
    db.prepare(`UPDATE diary SET items = ? WHERE user_id = ? AND date = ?`)
      .run(JSON.stringify([{ name: 'meal', nutrition: { calories: 4000 }, quantity: 1 }]), userId, d);
    db.prepare(`UPDATE wellness_data SET value = 85 WHERE user_id = ? AND date = ? AND metric_type = 'weight_kg'`)
      .run(userId, d);
  }
  assert.equal(computeAdaptiveTdee(userId, { endDate: anchor }).tdee, 2000);
  assert.notEqual(computeAdaptiveTdee(userId, { endDate: days[29] }).tdee, 2000);

  captureGoalSnapshot(userId, {
    effectiveDate: anchor,
    changedAt: '2026-01-25T08:00:00.000Z',
    snapshot: {
      goals: { calories: { max: 2000, sharedGoal: true } },
      water_goal_ml: 2000,
      calorie_goal_mode: 'adaptive',
      calorie_goal_factor: 1,
      calorie_adjust_from_activity: false,
      diary_show_activity: false,
      manual_activity_policy: 'wearable_wins',
      lifttrace_overlap_fill: true,
    },
  });
  const day = effectiveGoalsForDate(userId, anchor);
  assert.equal(day.calorie_basis.mode, 'adaptive');
  assert.equal(day.calorie_target_kcal, 2000);
  assert.equal(day.calorie_basis.days_available, 25);
});

test('MCP get_goals keeps the current response and adds dated forms', async () => {
  const server = mockServer();
  registerGetGoals(server, { userId });

  const current = await server.call('get_goals');
  assert.deepEqual(Object.keys(current.structuredContent).sort(),
    ['goals', 'goals_by_weekday', 'today', 'water_goal_ml', 'weekday_order']);
  assert.ok(current.structuredContent.today.date);

  const one = await server.call('get_goals', { date: '2026-09-05' });
  assert.equal(one.structuredContent.known, true);
  assert.equal(one.structuredContent.calorie_target_kcal, 2400);
  assert.equal(one.structuredContent.effective_from, '2026-09-04');

  const range = await server.call('get_goals', { start: '2026-09-03', end: '2026-09-05' });
  assert.equal(range.structuredContent.days.length, 3);
  assert.equal(range.structuredContent.days[0].calorie_target_kcal, 2000);
  assert.equal(range.structuredContent.days[2].calorie_target_kcal, 2400);

  const both = await server.call('get_goals', { date: '2026-09-05', start: '2026-09-01' });
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /either date or start\/end/);

  const half = await server.call('get_goals', { start: '2026-09-01' });
  assert.equal(half.isError, true);
  assert.match(half.content[0].text, /Both start and end/);

  const bogus = await server.call('get_goals', { date: '2026-02-31' });
  assert.equal(bogus.isError, true);
  assert.match(bogus.content[0].text, /Invalid date/);
});

test('a snapshot date must be a real calendar day, and the local date follows the time zone', () => {
  assert.equal(isGoalHistoryDate('2026-02-31'), false);
  assert.equal(isGoalHistoryDate('2026-13-01'), false);
  assert.equal(isGoalHistoryDate('2026-02-28'), true);

  setSetting('timezone', 'Pacific/Kiritimati'); // UTC+14
  assert.equal(userToday(userId, Date.parse('2026-09-01T23:00:00Z')), '2026-09-02');
  setSetting('timezone', 'America/New_York'); // UTC-4 in September
  assert.equal(userToday(userId, Date.parse('2026-09-02T02:00:00Z')), '2026-09-01');
});

test('the phone and the server build a snapshot with the same defaults', () => {
  assert.deepEqual(goalSnapshot({}), {
    goals: {},
    water_goal_ml: 2000,
    calorie_goal_mode: 'fixed',
    calorie_goal_factor: 1,
    calorie_adjust_from_activity: false,
    diary_show_activity: false,
    manual_activity_policy: 'wearable_wins',
    lifttrace_overlap_fill: true,
  });
  // A water goal of 0 is a choice, not a missing value.
  assert.equal(goalSnapshot(new Map([['waterGoalMl', 0]])).water_goal_ml, 0);
  assert.equal(goalSnapshot({ calorieGoalFactor: -2 }).calorie_goal_factor, 1);
  assert.equal(goalSnapshot({ calorieGoalMode: 'weird' }).calorie_goal_mode, 'fixed');

  // A client's snapshot cannot claim another day or add response fields.
  const stored = normalizeGoalSnapshot({
    goals: { calories: { max: 2100 } }, water_goal_ml: 'lots', known: false, date: '1999-01-01',
  });
  assert.equal(stored.water_goal_ml, 2000);
  assert.equal(stored.known, undefined);
  assert.equal(stored.date, undefined);
  assert.deepEqual(stored.goals, { calories: { max: 2100 } });
});

test('two devices changing different settings on one day keep both, field by field', () => {
  const u = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run('goal-history-two-devices', 'x').lastInsertRowid);
  const set = (key, value) => db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(u, key, JSON.stringify(value));
  const DAY = '2026-09-24';
  const base = {
    goals: { calories: { max: 2000, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } },
    water_goal_ml: 2000,
  };
  set('goals', base.goals);
  set('waterGoalMl', base.water_goal_ml);

  // Device A sets the calorie goal at 10:00: the server records the day from
  // its own (merged) settings.
  set('goals', { calories: { max: 2500, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } });
  captureGoalSnapshot(u, { effectiveDate: DAY, changedAt: '2026-09-24T10:00:00.000Z' });

  // Device B never got that change. At 11:00 it changes only the water goal,
  // and sends the configuration it has: its calorie goal is stale.
  set('waterGoalMl', 3000);
  captureGoalSnapshot(u, {
    effectiveDate: DAY,
    changedAt: '2026-09-24T11:00:00.000Z',
    source: 'client_sync',
    snapshot: {
      goals: base.goals,
      water_goal_ml: 3000,
      calorie_goal_mode: 'fixed',
      calorie_goal_factor: 1,
      calorie_adjust_from_activity: false,
      diary_show_activity: false,
      manual_activity_policy: 'wearable_wins',
      lifttrace_overlap_fill: true,
    },
    fieldTimes: { water_goal_ml: '2026-09-24T11:00:00.000Z' },
  });

  const day = effectiveGoalsForDate(u, DAY);
  assert.equal(day.calorie_target_kcal, 2500, "the calorie goal stays the server's newer one");
  assert.equal(day.resolved_goals.proteins, 120, 'the field device B only carried is left alone');
  assert.equal(day.water_goal_ml, 3000, "device B's own change is kept");
  assert.equal(day.changed_at, '2026-09-24T11:00:00.000Z');

  // The next day starts from both changes, and only the fields a later
  // change names move again.
  captureGoalSnapshot(u, {
    effectiveDate: '2026-09-25',
    changedAt: '2026-09-25T08:00:00.000Z',
    source: 'client_sync',
    snapshot: { ...day, goals: base.goals, water_goal_ml: 3000, calorie_goal_mode: 'fixed',
      calorie_goal_factor: 1, calorie_adjust_from_activity: false, diary_show_activity: false,
      manual_activity_policy: 'wearable_wins', lifttrace_overlap_fill: true },
    fieldTimes: { calorie_goal_factor: '2026-09-25T08:00:00.000Z' },
  });
  const next = effectiveGoalsForDate(u, '2026-09-25');
  assert.equal(next.calorie_target_kcal, 2500, 'the configuration in effect carries over');
  assert.equal(next.water_goal_ml, 3000);
});

test('a whole configuration from an app without per-field times still replaces the day', () => {
  const u = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run('goal-history-whole-row', 'x').lastInsertRowid);
  captureGoalSnapshot(u, {
    effectiveDate: '2026-09-26',
    changedAt: '2026-09-26T09:00:00.000Z',
    snapshot: { goals: { calories: { max: 2100, sharedGoal: true } }, water_goal_ml: 2100 },
  });
  captureGoalSnapshot(u, {
    effectiveDate: '2026-09-26',
    changedAt: '2026-09-26T12:00:00.000Z',
    snapshot: { goals: { calories: { max: 2600, sharedGoal: true } }, water_goal_ml: 2600 },
  });
  const day = effectiveGoalsForDate(u, '2026-09-26');
  assert.equal(day.calorie_target_kcal, 2600);
  assert.equal(day.water_goal_ml, 2600);
});

test("a client and the server date a goal change by the same account day", () => {
  const at = new Date('2026-09-01T23:00:00Z');
  assert.equal(goalDateInZone('Pacific/Kiritimati', at), '2026-09-02');
  assert.equal(goalDateInZone('America/New_York', at), '2026-09-01');
  // No zone, or one this browser does not know: UTC, the server's fallback
  // (server/lib/goal-history-baseline.js userDate), not the device's day.
  assert.equal(goalDateInZone(null, at), '2026-09-01');
  assert.equal(goalDateInZone('not/a-zone', at), '2026-09-01');
  // A user with no timezone setting: both sides name the same day.
  const u = Number(db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')")
    .run('goal-history-utc-fallback').lastInsertRowid);
  assert.equal(userToday(u, at.getTime()), goalDateInZone(null, at), 'UTC on both sides');
});

test('the current answer keeps the server zone when the account has none, while a dated day is UTC', () => {
  const u = Number(db.prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')")
    .run('goal-history-current-zone').lastInsertRowid);
  const was = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    // Sunday 23:00 in Los Angeles is already Monday in UTC.
    const at = Date.parse('2026-09-07T06:00:00Z');
    assert.equal(userToday(u, at), '2026-09-07', 'a dated day: UTC, as the phone');
    assert.equal(currentUserToday(u, at), '2026-09-06', "the current answer: the server's own day, as before");
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
});

test('no-argument get_goals is the complete current answer, unchanged', () => {
  const u = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run('goal-history-current', 'x').lastInsertRowid);
  const set = (key, value) => db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))`
  ).run(u, key, JSON.stringify(value));
  const goalsNow = {
    calories: { max: 2400, sharedGoal: true },
    proteins: { max: 180, sharedGoal: true },
    carbohydrates: { max: 220, sharedGoal: true },
    fat: { max: 70, sharedGoal: true },
  };
  set('goals', goalsNow);
  set('waterGoalMl', 3000);

  const today = userToday(u);
  const weekday = WEEKDAY_ORDER[new Date(`${today}T00:00:00`).getDay()];
  assert.deepEqual(getGoalsCore(u), {
    goals: goalsNow,
    water_goal_ml: 3000,
    weekday_order: WEEKDAY_ORDER,
    goals_by_weekday: {},
    today: {
      date: today,
      weekday,
      targets: { calories: 2400, proteins: 180, carbohydrates: 220, fat: 70 },
    },
  });
});

test('the routes read history through the shared core, not their own SQL', () => {
  const v1 = readFileSync(new URL('../server/routes/api/v1/goals.js', import.meta.url), 'utf8');
  assert.match(v1, /getGoalsCore\(req\.apiUser\.id, \{/);
  for (const param of ['date', 'start', 'end']) assert.match(v1, new RegExp(`${param}: req\\.query\\.${param}`));
  assert.doesNotMatch(v1, /db\.prepare/, 'the public route must not carry its own goal query');

  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(index, /import \{ getGoalsCore \} from '\.\/lib\/mcp\/tools\/goals\.js'/);
  const start = index.indexOf("router.get('/api/goals/effective'");
  const end = index.indexOf('// Adaptive TDEE', start);
  assert.ok(start >= 0 && end > start, 'the app route for historical goals is mounted');
  const route = index.slice(start, end);
  assert.match(route, /getGoalsCore\(userId, \{/);
  for (const param of ['date', 'start', 'end']) assert.match(route, new RegExp(`${param}: req\\.query\\.${param}`));
  assert.doesNotMatch(route, /db\.prepare/, 'the app route must not fork goal-history SQL');
});

test('applying a goal template is one bulk write, so it makes one snapshot', () => {
  const src = readFileSync(new URL('../src/routes/Goals.svelte', import.meta.url), 'utf8');
  const apply = src.match(/async function applyTemplate\(tpl\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(apply, /const next = \{ goals:/);
  assert.match(apply, /next\.waterGoalMl = tpl\.waterGoalMl/);
  assert.match(apply, /await bulkSet\(next\)/);
  assert.doesNotMatch(apply, /goals\.set|waterGoalMl\.set/);
});

test('the app records the day with a goal change, and carries it up', () => {
  const store = readFileSync(new URL('../src/stores/settings.js', import.meta.url), 'utf8');
  assert.match(store, /dbCaptureGoalHistory\(madeOn, \{ changedKeys: \[key\], changedAt: at \}\)/);
  assert.match(store, /if \(_storeWriting\) return;/, 'a store edit is one native write, not one per listener');
  assert.match(store, /const gen = accountGeneration\(\);/, "the edit's account is captured with it");
  assert.match(store, /export function settleNativeWrites\(\)/, 'an account switch waits for queued writes');
  assert.match(store, /effective_date: madeOn/);
  // The day, moment and snapshot are taken with the change, and the queue
  // gets those, not a read after the request failed.
  assert.match(store, /const madeGoals = changesGoals \? _currentGoalSnapshot\(\) : null/);
  assert.match(store, /const madeFields = changesGoals \? _goalFieldTimes\(\[key\], madeAt\) : null/);
  assert.match(store, /queueGoalHistory\(madeOn, madeGoals, \{ changedAt: madeAt, fieldTimes: madeFields \}\)/);
  assert.match(store, /queueSetting\(key, value, madeAt\)/, 'the queued retry keeps the edit time');
  assert.match(store, /dbCaptureGoalHistory\(madeOn, \{ changedKeys: goalKeys, changedAt: editedAt \}\)/);
  assert.match(store, /queueSetting\(key, value, madeAt\)[\s\S]*bulk|for \(const \[key, value\] of userPrefEntries\) await queueSetting\(key, value, madeAt\)/);
  assert.match(store, /changed_at: madeAt, client_now: new Date\(\).toISOString\(\)/);
  assert.match(store, /goalDateInZone\(DB\.getSetting\('timezone', null\)\)/, "the account's day, not the device's");
  assert.doesNotMatch(store, /queueGoalHistory\(madeOn, _currentGoalSnapshot\(\)\)/);

  const native = readFileSync(new URL('../src/lib/db-native.js', import.meta.url), 'utf8');
  assert.match(native, /CREATE TABLE IF NOT EXISTS goal_history/);
  assert.match(native, /sync_status='pending'/);
  assert.match(native, /export async function dbCaptureGoalHistory/);
  assert.match(native, /field_times TEXT DEFAULT NULL/, 'the fields a day changed here, and when');
  assert.match(native, /changedKeys = null, changedAt = null/, 'the edit says which fields and when');
  assert.match(native, /const at = changedAt \|\| _editNow\(\)/, "the phone's clock set right, with its marker");
  assert.match(native, /export async function dbUpsertSetting\(key, value, at = _editNow\(\)\)/, 'a setting is stamped the same way');
  assert.match(native, /'goal_history', 'activity_log', 'fasts', 'sync_log'/, 'cleared with the account');
  assert.match(native, /FROM goal_history WHERE sync_status = 'pending'/, 'counted as unsent');

  const sync = readFileSync(new URL('../src/lib/sync.js', import.meta.url), 'utf8');
  assert.match(sync, /goal_history: pendingGoalHistory\.map/);
  assert.match(sync, /field_times: _parseJson\(h\.field_times\)/);
  assert.match(sync, /dbUpsertGoalHistoryFromServer/);
  assert.match(sync, /UPDATE goal_history  SET sync_status='pending'/);
});

test('settings writes and sync carry the day with the change', () => {
  const settings = readFileSync(new URL('../server/routes/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /captureGoalSnapshot\(req\.user\.id, \{ effectiveDate, changedAt: new Date\(at\)\.toISOString\(\), source: 'settings' \}\)/);
  assert.match(settings, /writeSetting\(db, req\.user\.id, key, \{ value: stored \}, at\)/, 'the direct PUT merges as a push does');
  assert.match(settings, /source: 'settings_bulk'/);
  assert.match(settings, /source: 'settings_reset'/);
  assert.match(settings, /if \(!isGoalHistoryDate\(supplied\)\)/);
  assert.match(settings, /writeSetting\(db, req\.user\.id, key, \{ deleted: true \}, at, \{ restamp: true \}\)/, 'a reset stamps each delete at its own moment');
  assert.match(settings, /clientClock\(req\.body\?\.client_now\)/, 'the phone clock is set right, as on a push');
  assert.match(settings, /editMs\(raw, clock, Date\.now\(\), \{\}\)/);

  const sync = readFileSync(new URL('../server/routes/sync.js', import.meta.url), 'utf8');
  assert.match(sync, /goal_history/);
  assert.match(sync, /writeSetting\(\s*db, u, s\.key,\s*s\.deleted_at \? \{ deleted: true \} : \{ value: stored \},\s*at,/, 'a push merges through the same helper');
  assert.match(sync, /captureGoalSnapshot\(u, \{/);
  assert.match(sync, /const ms = editAt\(raw\)/, 'each field time is set right like the row\'s');
  assert.match(sync, /fieldTimes: Object\.keys\(claimed\)\.length \? claimed : null/);
  assert.match(sync, /const date = userToday\(u, goalAt\)/);
  assert.match(sync, /changedAt: new Date\(goalAt\)\.toISOString\(\)/, 'a late retry is dated by its edit, not its arrival');
  assert.match(sync, /if \(written\.kept && GOAL_HISTORY_SETTING_KEYS\.has\(s\.key\)/, 'only a change that was kept dates history');
  assert.doesNotMatch(sync, /slice\(0, 10\).*goal/i, 'an edit date is not taken as the UTC text of a timestamp');

  const backup = readFileSync(new URL('../server/routes/full-backup.js', import.meta.url), 'utf8');
  assert.match(backup, /goal_history:     db\.prepare\('SELECT \* FROM goal_history'\)\.all\(\)/);
  assert.match(backup, /INSERT OR IGNORE INTO goal_history/);
  assert.match(backup, /DELETE FROM goal_history/);
  assert.match(backup, /ensureGoalHistoryBaseline\(db, u\.id, \{ source: 'restore_baseline' \}\)/, 'a backup without history starts it at the restore');

  const server = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  assert.match(server, /ensureGoalHistoryBaseline\(db, id\)/);
  assert.match(server, /ALTER TABLE goal_history ADD COLUMN field_times/);
});
