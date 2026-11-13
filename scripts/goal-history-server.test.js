/**
 * Goal history over the real server (server/index.js, scratch database):
 * the settings routes record the day a change is for, `/api/goals/effective`
 * and the sync pull read it back, and a phone's offline goal history reaches
 * the server with each day's own targets.
 *
 * Dates are the person's local calendar dates. A client sends the day it
 * made the change; one that can't (an app from before this feature) has its
 * day derived from the edit time in the account's time zone, and only when
 * that day is the newest history has, so today's targets are never written
 * into the past.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* not built for this Node */ }
const skip = t => { if (!ready) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };

const dir = ready ? mkdtempSync(join(tmpdir(), 'nt-goal-history-')) : null;
const JWT_SECRET = 'goal-history-server-secret-0123456789abcdef';
let server = null, base = null, token = null, sqlite = null;
const dbRows = (sql, ...args) => sqlite.prepare(sql).all(...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

const GOALS = { calories: { max: 2100, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } };
const DAY = (max, water) => ({
  goals: { calories: { max, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } },
  water_goal_ml: water,
  calorie_goal_mode: 'fixed',
  calorie_goal_factor: 1,
  calorie_adjust_from_activity: false,
  diary_show_activity: false,
  manual_activity_policy: 'wearable_wins',
  lifttrace_overlap_fill: true,
});

async function call(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}
async function api(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}
const goalsOn = date => api('GET', `/api/goals/effective?date=${date}`);
const push = body => api('POST', '/api/sync/push', {
  foods: [], meals: [], diary: [], activity: [], fasts: [], wellness: [], settings: [], workouts: [],
  client_now: new Date().toISOString(), ...body,
});
const pull = () => api('GET', '/api/sync/pull?since=1970-01-01T00:00:00.000Z');

// A second account, so a case's dates start with no history of their own.
// The token is signed as the server does (the secret is this test's), not
// signed in: many cases share one sign-in rate limit.
async function freshAccount(name) {
  const password = 'Str0ng-Pass-77!x';
  const { user } = await api('POST', '/api/auth/register', { username: name, password });
  const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
  return jwt.sign({ id: user.id, username: user.username, role: user.role, csrf: 'test' }, JWT_SECRET, { expiresIn: '1h' });
}
async function as(tok, method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(parsed).slice(0, 200)}`);
  return parsed;
}
const pushAs = (tok, body) => as(tok, 'POST', '/api/sync/push', {
  foods: [], meals: [], diary: [], activity: [], fasts: [], wellness: [], settings: [], workouts: [],
  client_now: new Date().toISOString(), ...body,
});
const goalsOnAs = (tok, date) => as(tok, 'GET', `/api/goals/effective?date=${date}`);

test.before(async () => {
  if (!ready) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET, NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  await api('POST', '/api/auth/register', { username: 'nora', password: 'Str0ng-Pass-77!x' });
  token = (await api('POST', '/api/auth/login', { username: 'nora', password: 'Str0ng-Pass-77!x' })).token;
  await api('PUT', '/api/settings', { key: 'timezone', value: 'UTC' });
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  sqlite = new Database(join(dir, 'server.db'), { readonly: true, fileMustExist: true });
});
test.after(() => {
  try { sqlite?.close(); } catch {}
  try { server?.kill(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('a setting saved with a date records that day, and a date before history is unknown', async (t) => {
  if (skip(t)) return;
  await api('PUT', '/api/settings', {
    key: 'goals', value: GOALS, effective_date: '2026-09-01', changed_at: '2026-09-01T08:00:00.000Z',
  });

  const day = await goalsOn('2026-09-01');
  assert.equal(day.known, true);
  assert.equal(day.effective_from, '2026-09-01');
  assert.deepEqual(day.goals, GOALS);
  assert.equal(day.calorie_target_kcal, 2100);
  assert.equal(day.resolved_goals.proteins, 120);
  assert.equal(day.water_goal_ml, 2000, 'the water goal it had then');
  assert.equal(day.changed_at, '2026-09-01T08:00:00.000Z', 'the moment the client made the change, not when it arrived');

  const before = await goalsOn('2026-08-31');
  assert.equal(before.known, false);
  assert.equal(before.reason, 'before_first_recorded_snapshot');
  assert.equal(before.history_available_from, '2026-09-01');
  assert.equal(before.calorie_target_kcal, undefined);

  const bad = await call('GET', '/api/goals/effective?date=2026-02-31');
  assert.equal(bad.status, 400);
  const half = await call('GET', '/api/goals/effective?start=2026-09-01');
  assert.equal(half.status, 400, 'a range needs both ends');
  const both = await call('GET', '/api/goals/effective?date=2026-09-01&start=2026-09-01&end=2026-09-02');
  assert.equal(both.status, 400, 'one form or the other');
});

test('a bulk save makes one complete snapshot, and an impossible date is refused', async (t) => {
  if (skip(t)) return;
  // A template: new goals and a water goal, with the template's own values.
  const template = {
    goals: { calories: { max: 2250, sharedGoal: true }, proteins: { max: 135, sharedGoal: true } },
    waterGoalMl: 3100,
    calorieGoalMode: 'fixed',
  };
  await api('PUT', '/api/settings/bulk', {
    settings: template,
    effective_date: '2026-09-04',
    changed_at: '2026-09-04T08:00:00.000Z',
  });
  const day = await goalsOn('2026-09-04');
  assert.equal(day.water_goal_ml, 3100, 'the template’s water goal is part of the same snapshot');
  assert.deepEqual(day.goals, template.goals, 'and so are its new goals, not the ones from before');
  assert.equal(day.calorie_target_kcal, 2250);
  assert.equal(day.effective_from, '2026-09-04', 'one snapshot for the whole batch');
  assert.equal(day.source, 'settings_bulk');

  const before = await goalsOn('2026-09-03');
  assert.equal(before.water_goal_ml, 2000, 'the day before keeps what it had');
  assert.deepEqual(before.goals, GOALS, 'and its own goals');

  const refused = await call('PUT', '/api/settings', { key: 'waterGoalMl', value: 900, effective_date: '2026-02-31' });
  assert.equal(refused.status, 400);
  assert.equal((await goalsOn('2026-09-04')).water_goal_ml, 3100, 'nothing was written');
});

test("the phone's offline history brings each day's own targets, and a stale retry loses", async (t) => {
  if (skip(t)) return;
  await push({
    goal_history: [
      { effective_date: '2026-09-07', snapshot: DAY(2300, 2500), changed_at: '2026-09-07T09:00:00.000Z' },
      { effective_date: '2026-09-08', snapshot: DAY(2600, 2800), changed_at: '2026-09-08T09:00:00.000Z' },
      // The same day changed again later offline: its final configuration.
      { effective_date: '2026-09-08', snapshot: DAY(2700, 2900), changed_at: '2026-09-08T18:00:00.000Z' },
    ],
    settings: [
      { key: 'goals', value: DAY(2700, 2900).goals, updated_at: '2026-09-08T18:00:00.000Z' },
      { key: 'waterGoalMl', value: 2900, updated_at: '2026-09-08T18:00:00.000Z' },
    ],
  });

  assert.equal((await goalsOn('2026-09-07')).calorie_target_kcal, 2300);
  assert.equal((await goalsOn('2026-09-08')).calorie_target_kcal, 2700);
  assert.equal((await goalsOn('2026-09-08')).water_goal_ml, 2900);

  // A retry queued before the day's last edit, arriving after it.
  await push({
    goal_history: [
      { effective_date: '2026-09-08', snapshot: DAY(1800, 1800), changed_at: '2026-09-08T17:00:00.000Z' },
    ],
  });
  const kept = await goalsOn('2026-09-08');
  assert.equal(kept.calorie_target_kcal, 2700);
  assert.equal(kept.changed_at, '2026-09-08T18:00:00.000Z');

  const pulled = await pull();
  const rows = new Map(pulled.goal_history.map(row => [row.effective_date, row]));
  assert.equal(rows.get('2026-09-07').snapshot.goals.calories.max, 2300);
  assert.equal(rows.get('2026-09-08').snapshot.water_goal_ml, 2900, 'the pull sends the snapshot parsed');
  for (const row of pulled.goal_history) assert.equal(row.field_times, undefined, 'the per-field times stay on the server');
});

test('goal settings from an app without history are dated in the account’s time zone', async (t) => {
  if (skip(t)) return;
  await api('PUT', '/api/settings', { key: 'timezone', value: 'Pacific/Kiritimati' }); // UTC+14
  const at = new Date();
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Kiritimati', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);

  await push({
    settings: [{ key: 'goals', value: { calories: { max: 2400, sharedGoal: true } }, updated_at: at.toISOString() }],
  });

  const day = await goalsOn(local);
  assert.equal(day.known, true);
  assert.equal(day.calorie_target_kcal, 2400);
  assert.equal(day.source, 'client_sync');
  assert.equal(day.water_goal_ml, 2900, 'the rest of the configuration is the one in effect (the 09-08 edit wins)');

  // The older days keep their own targets: today's were not written into them.
  assert.equal((await goalsOn('2026-09-07')).calorie_target_kcal, 2300);
});

test('a reset day is the defaults, and the days before keep their targets', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('rhea');
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: GOALS, effective_date: '2026-09-10', changed_at: '2026-09-10T08:00:00.000Z',
  });
  await as(tok, 'DELETE', '/api/settings', { effective_date: '2026-09-12', changed_at: '2026-09-12T08:00:00.000Z' });

  const reset = await goalsOnAs(tok, '2026-09-12');
  assert.equal(reset.known, true);
  assert.deepEqual(reset.goals, {});
  assert.equal(reset.calorie_target_kcal, 2000);
  assert.equal(reset.water_goal_ml, 2000);
  assert.equal(reset.source, 'settings_reset');
  assert.equal((await goalsOnAs(tok, '2026-09-11')).calorie_target_kcal, 2100);
  const current = await as(tok, 'GET', '/api/goals/effective');
  assert.deepEqual(current.goals, {}, 'the reset reached the live settings too');
});

test('two devices changing different settings on one day: the day is the server configuration', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('dana');
  const D = '2026-10-05';
  const t10 = new Date(Date.now() - 4 * 3600_000).toISOString();
  const t11 = new Date(Date.now() - 3 * 3600_000).toISOString();

  // Device A sets the calorie goal at 10:00.
  await pushAs(tok, {
    settings: [{ key: 'goals', value: DAY(2500, 2000).goals, updated_at: t10 }],
    goal_history: [{ effective_date: D, snapshot: DAY(2500, 2000), changed_at: t10 }],
  });
  // Device B never received that change; at 11:00 it changes only the water
  // goal and sends the configuration it has (its calorie goal is stale).
  await pushAs(tok, {
    settings: [{ key: 'waterGoalMl', value: 3000, updated_at: t11 }],
    goal_history: [{
      effective_date: D,
      snapshot: DAY(2000, 3000),
      changed_at: t11,
      field_times: { water_goal_ml: t11 },
    }],
  });

  const day = await goalsOnAs(tok, D);
  assert.equal(day.calorie_target_kcal, 2500, "device A's newer calorie goal stays");
  assert.equal(day.water_goal_ml, 3000, "device B's own change is kept");
  assert.equal(day.resolved_goals.proteins, 120, 'a field device B only carried is left alone');
  assert.equal(day.changed_at, t11);
});

test('a late retry does not date a day after the edit it lost to, so the edit between them wins', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('eli');
  const D = '2026-10-06';
  const t09 = new Date(Date.now() - 5 * 3600_000).toISOString();
  const t11 = new Date(Date.now() - 3 * 3600_000).toISOString();
  const t1130 = new Date(Date.now() - 2.5 * 3600_000).toISOString();

  // The real edit at 11:00 reaches the server.
  await pushAs(tok, {
    settings: [{ key: 'waterGoalMl', value: 3000, updated_at: t11 }],
    goal_history: [{ effective_date: D, snapshot: DAY(2000, 3000), changed_at: t11 }],
  });
  // A retry queued at 09:00 arrives later; its change loses to the 11:00 one.
  await pushAs(tok, {
    settings: [{ key: 'waterGoalMl', value: 2800, updated_at: t09 }],
  });
  const kept = await goalsOnAs(tok, D);
  assert.equal(kept.water_goal_ml, 3000, 'the retry did not bring its older setting back');
  assert.equal(kept.changed_at, t11, 'and did not move the day to when it arrived');

  // An offline edit made at 11:30, pushed after the retry, is newer than the
  // real 11:00 edit and must win.
  await pushAs(tok, {
    settings: [{ key: 'waterGoalMl', value: 2900, updated_at: t1130 }],
    goal_history: [{
      effective_date: D,
      snapshot: DAY(2000, 2900),
      changed_at: t1130,
      field_times: { water_goal_ml: t1130 },
    }],
  });
  const after = await goalsOnAs(tok, D);
  assert.equal(after.water_goal_ml, 2900);
  assert.equal(after.changed_at, t1130);
});

test('a change stamped on the server clock is not offset again, and field times go through the same correction', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('fay');
  const marked = new Date(Date.now() - 3600_000).toISOString().replace(/Z$/, '+00:00');
  const plain = new Date(Date.now() - 3600_000).toISOString();
  // The phone's clock is two hours fast at push time, so an edit time on it
  // is set back by two hours; one already on the server clock isn't.
  const clientNow = new Date(Date.now() + 2 * 3600_000).toISOString();

  await pushAs(tok, {
    client_now: clientNow,
    goal_history: [
      // The earlier day first: it has nothing to lose to. Its field time is
      // on the phone's clock and must be corrected like its row time.
      {
        effective_date: '2026-10-06', snapshot: DAY(2000, 2400), changed_at: plain,
        field_times: { water_goal_ml: plain },
      },
      // The later day's field time is already on the server clock.
      {
        effective_date: '2026-10-07', snapshot: DAY(2000, 2500), changed_at: marked,
        field_times: { water_goal_ml: marked },
      },
    ],
  });

  const shifted = Date.parse(plain) - 2 * 3600_000;
  const offClock = await goalsOnAs(tok, '2026-10-06');
  assert.ok(Math.abs(Date.parse(offClock.changed_at) - shifted) < 5000,
    `a time on the phone's clock is set right by the offset the push reports (got ${offClock.changed_at})`);
  const onClock = await goalsOnAs(tok, '2026-10-07');
  assert.equal(Date.parse(onClock.changed_at), Date.parse(marked), 'the marked time is stored as sent');

  // The claims themselves, as stored, follow the same rule; a claim left in
  // the future would beat the settings it must merge with.
  const stored = new Map(dbRows(
    `SELECT effective_date, field_times FROM goal_history WHERE effective_date IN ('2026-10-06', '2026-10-07')`
  ).map(row => [row.effective_date, JSON.parse(row.field_times)]));
  assert.ok(Math.abs(Date.parse(stored.get('2026-10-06').water_goal_ml) - shifted) < 5000,
    `the phone-clock claim is corrected (${stored.get('2026-10-06').water_goal_ml})`);
  assert.equal(Date.parse(stored.get('2026-10-07').water_goal_ml), Date.parse(marked),
    'the marked claim is not offset again');
});

test('a claim carried from the day before loses to a newer edit already in the inherited snapshot', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('gus');
  const MON = '2026-10-12', TUE = '2026-10-13';
  const t10 = new Date(Date.now() - 6 * 3600_000).toISOString();
  const t09 = new Date(Date.now() - 8 * 3600_000).toISOString();
  const tTue = new Date(Date.now() - 5 * 3600_000).toISOString();

  // Device B sets Monday's calorie goal at 10:00.
  await pushAs(tok, {
    goal_history: [{ effective_date: MON, snapshot: DAY(2500, 2000), changed_at: t10 }],
  });
  // Device A was offline at 09:00 (calories 2200), then on Tuesday changes
  // only the water goal and sends both days; its Tuesday row still names the
  // goals it carries, with Monday's 09:00 time.
  await pushAs(tok, {
    goal_history: [
      { effective_date: MON, snapshot: DAY(2200, 2000), changed_at: t09 },
      {
        effective_date: TUE,
        snapshot: DAY(2200, 3000),
        changed_at: tTue,
        field_times: { goals: t09, water_goal_ml: tTue },
      },
    ],
  });

  assert.equal((await goalsOnAs(tok, MON)).calorie_target_kcal, 2500, 'the older Monday edit lost');
  const day = await goalsOnAs(tok, TUE);
  assert.equal(day.calorie_target_kcal, 2500, "the carried goals claim loses to Monday's newer edit");
  assert.equal(day.water_goal_ml, 3000, "the day's own change is kept");
  assert.equal(day.changed_at, tTue);
});

test('a late edit of a past day reaches the days that inherited it, until one edited the field itself', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('hana');
  const MON = '2026-10-19', TUE = '2026-10-20', WED = '2026-10-21';
  const t10 = new Date(Date.now() - 10 * 3600_000).toISOString();
  const t11 = new Date(Date.now() - 9 * 3600_000).toISOString();
  const tTue = new Date(Date.now() - 8 * 3600_000).toISOString();
  const tWed = new Date(Date.now() - 7 * 3600_000).toISOString();

  await pushAs(tok, {
    goal_history: [{ effective_date: MON, snapshot: DAY(2000, 2000), changed_at: t10 }],
  });
  // Tuesday changes only the water goal: its calories are Monday's.
  await pushAs(tok, {
    goal_history: [{
      effective_date: TUE, snapshot: DAY(2000, 3000), changed_at: tTue,
      field_times: { water_goal_ml: tTue },
    }],
  });
  // Wednesday sets its own calorie goal, later than Monday's coming edit.
  await pushAs(tok, {
    goal_history: [{
      effective_date: WED, snapshot: DAY(2300, 3000), changed_at: tWed,
      field_times: { goals: tWed },
    }],
  });

  // Monday's offline edit made at 11:00 arrives only now: it corrects
  // Monday, and Tuesday must follow (it never set calories itself).
  await pushAs(tok, {
    goal_history: [{ effective_date: MON, snapshot: DAY(2500, 2000), changed_at: t11 }],
  });

  assert.equal((await goalsOnAs(tok, MON)).calorie_target_kcal, 2500);
  const tue = await goalsOnAs(tok, TUE);
  assert.equal(tue.calorie_target_kcal, 2500, 'the day that inherited the field follows the correction');
  assert.equal(tue.water_goal_ml, 3000, 'while keeping its own change');
  assert.equal((await goalsOnAs(tok, WED)).calorie_target_kcal, 2300, "a day that set the field itself keeps its own");

  const times = new Map(dbRows(
    `SELECT effective_date, field_times FROM goal_history WHERE effective_date IN ('2026-10-19', '2026-10-20', '2026-10-21')`
  ).map(row => [row.effective_date, JSON.parse(row.field_times)]));
  assert.equal(times.get('2026-10-20').goals, t11, 'the inherited field now counts from the correction');
  assert.equal(times.get('2026-10-21').goals, tWed, 'the day with its own edit is where the walk stopped');
});

test('a delayed direct save loses to a newer one, and the day agrees with the live goals', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('vera');
  const D = '2026-10-14';
  const goals = max => ({ calories: { max, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } });

  // B saves 2500 at 10:00; A's 09:00 save arrives only after it.
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2500), effective_date: D, changed_at: '2026-10-14T10:00:00.000Z',
  });
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2200), effective_date: D, changed_at: '2026-10-14T09:00:00.000Z',
  });

  const live = await as(tok, 'GET', '/api/goals/effective');
  assert.equal(live.goals.calories.max, 2500, 'the newer save stays in the live settings');
  assert.equal((await goalsOnAs(tok, D)).calorie_target_kcal, 2500, 'and the day says the same');

  // The same save delivered again (a retry after a timeout): still 2500.
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2200), effective_date: D, changed_at: '2026-10-14T09:00:00.000Z',
  });
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2500);
  const day = await goalsOnAs(tok, D);
  assert.equal(day.calorie_target_kcal, 2500);
  assert.equal(day.changed_at, '2026-10-14T10:00:00.000Z');
});

test('an edit inside the same second is judged by its milliseconds, in settings and in history alike', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('walt');
  const D = '2026-10-15';
  const goals = max => ({ calories: { max, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } });
  const pushGoals = (max, at) => pushAs(tok, {
    settings: [{ key: 'goals', value: goals(max), updated_at: at }],
    goal_history: [{ effective_date: D, snapshot: DAY(max, 2000), changed_at: at }],
  });

  // The server has 2500, made at .900 of the second.
  await pushGoals(2500, '2026-10-15T10:00:00.900Z');
  // An offline edit made at .100, later in the same second, arrives after.
  await pushGoals(2200, '2026-10-15T10:00:00.100Z');

  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2500,
    'the setting keeps the newer millisecond');
  assert.equal((await goalsOnAs(tok, D)).calorie_target_kcal, 2500,
    'and the day is not rolled back either');

  // One at .950 is newer in both.
  await pushGoals(2600, '2026-10-15T10:00:00.950Z');
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2600);
  assert.equal((await goalsOnAs(tok, D)).calorie_target_kcal, 2600);
});

test('a reset lets a later offline edit back and keeps an earlier one out, in settings and history alike', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('zoe');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const day = D => goalsOnAs(tok, D);

  // 07:00 goal, reset at 09:00, then an edit made at 10:00.
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2400), effective_date: '2026-10-16', changed_at: '2026-10-16T07:00:00.000Z',
  });
  await as(tok, 'DELETE', '/api/settings', { effective_date: '2026-10-16', changed_at: '2026-10-16T09:00:00.000Z' });
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2600), effective_date: '2026-10-16', changed_at: '2026-10-16T10:00:00.000Z',
  });
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2600,
    'the newer edit brings the setting back');
  assert.equal((await day('2026-10-16')).calorie_target_kcal, 2600, 'and the reset day follows it');

  // Reset again later; an edit made before that reset cannot bring it back.
  await as(tok, 'DELETE', '/api/settings', { effective_date: '2026-10-17', changed_at: '2026-10-17T09:00:00.000Z' });
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2800), effective_date: '2026-10-17', changed_at: '2026-10-17T08:30:00.000Z',
  });
  assert.deepEqual((await as(tok, 'GET', '/api/goals/effective')).goals, {},
    'the older edit stays behind the reset');
  assert.deepEqual((await day('2026-10-17')).goals, {}, 'and the reset day stays the defaults');
});

test('a claim at the instant of a reset loses in history as it does in settings', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('tess');
  const D = '2026-10-18';
  const RESET = '2026-10-18T09:00:00.000Z';
  const goals = max => ({ calories: { max, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } });

  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2400), effective_date: D, changed_at: '2026-10-18T08:00:00.000Z',
  });
  await as(tok, 'DELETE', '/api/settings', { effective_date: D, changed_at: RESET });

  // A stale push of the old goals, made at exactly the reset's instant, and
  // the history that goes with it.
  await pushAs(tok, {
    settings: [{ key: 'goals', value: goals(2400), updated_at: RESET }],
    goal_history: [{
      effective_date: D, snapshot: DAY(2400, 2000), changed_at: RESET,
      field_times: { goals: RESET, water_goal_ml: RESET },
    }],
  });

  assert.deepEqual((await as(tok, 'GET', '/api/goals/effective')).goals, {},
    'a setting is only brought back strictly after its delete');
  const resetDay = await goalsOnAs(tok, D);
  assert.deepEqual(resetDay.goals, {}, 'and the day keeps the reset, not the old goals');
  assert.equal(resetDay.water_goal_ml, 2000);

  // One millisecond later, both sides bring it back.
  const later = '2026-10-18T09:00:00.001Z';
  await pushAs(tok, {
    settings: [{ key: 'goals', value: goals(2600), updated_at: later }],
    goal_history: [{
      effective_date: D, snapshot: DAY(2600, 2000), changed_at: later,
      field_times: { goals: later },
    }],
  });
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2600);
  assert.equal((await goalsOnAs(tok, D)).calorie_target_kcal, 2600);
});

test('a default on a reset day is dated at the reset, so an edit made between them still wins', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('ursula');
  const D = '2026-10-19';
  const goals = max => ({ calories: { max, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } });

  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2400), effective_date: D, changed_at: '2026-10-19T08:00:00.000Z',
  });
  await as(tok, 'DELETE', '/api/settings', { effective_date: D, changed_at: '2026-10-19T09:00:00.000Z' });

  // A change to another field at 11:00 rebuilds the day: the goals default
  // must keep the reset's 09:00, not be re-dated to 11:00.
  await as(tok, 'PUT', '/api/settings', {
    key: 'waterGoalMl', value: 3100, effective_date: D, changed_at: '2026-10-19T11:00:00.000Z',
  });
  // The goals edit made at 10:00 arrives last — after the reset, before the
  // water change.
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2600), effective_date: D, changed_at: '2026-10-19T10:00:00.000Z',
  });

  const live = await as(tok, 'GET', '/api/goals/effective');
  assert.equal(live.goals.calories.max, 2600, 'the 10:00 edit brings the setting back');
  const day = await goalsOnAs(tok, D);
  assert.equal(day.calorie_target_kcal, 2600, 'and the day follows the live goals');
  assert.equal(day.water_goal_ml, 3100, 'the other field keeps its own change');
});
