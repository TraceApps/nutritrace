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
  // The save sent goals only: water was never part of that day, so it is
  // unknown, not a default handed to a reader as that day's target.
  assert.equal(day.water_goal_ml, undefined);
  assert.ok(day.unknown_fields.includes('water_goal_ml'));
  assert.equal(day.history_complete, false);
  assert.equal(day.changed_at, '2026-09-01T08:00:00.000Z', 'the moment the client made the change, not when it arrived');

  const before = await goalsOn('2026-08-31');
  assert.equal(before.known, false);
  assert.equal(before.reason, 'before_first_recorded_snapshot');
  assert.equal(before.history_available_from, '2026-09-01');
  assert.equal(before.calorie_target_kcal, undefined);

  const bad = await call('GET', '/api/goals/effective?date=2026-02-31');
  assert.equal(bad.status, 400);
  const empty = await call('GET', '/api/goals/effective?date=');
  assert.equal(empty.status, 400, 'an empty date is a bad request, not the current answer');
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
  assert.equal(before.water_goal_ml, undefined, 'a day that never got the water goal says so');
  assert.deepEqual(before.goals, GOALS, 'while its goals are the ones it had');
  assert.ok(before.unknown_fields.includes('water_goal_ml'));

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
  // The fields the push didn't send keep what the day already had: water
  // is the 2900 the earlier offline push set (the baseline's water was
  // never saved, so that older edit reached it), the same as the live goal.
  assert.equal(day.water_goal_ml, 2900, "the fields the push didn't change keep the day's own history");
  assert.equal((await api('GET', '/api/goals/effective')).water_goal_ml, 2900);

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
  const t10 = '2026-10-05T10:00:00.000Z';
  const t11 = '2026-10-05T11:00:00.000Z';

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
  const t09 = '2026-10-06T09:00:00.000Z';
  const t11 = '2026-10-06T11:00:00.000Z';
  const t1130 = '2026-10-06T11:30:00.000Z';

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
  // Start this account's history empty: the fabricated edit times below are
  // older than the baseline the account was given a moment ago.
  {
    const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
    const writer = new Database(join(dir, 'server.db'));
    try {
      writer.prepare('DELETE FROM goal_history WHERE user_id = (SELECT id FROM users WHERE username = ?)').run('fay');
    } finally { writer.close(); }
  }
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
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
        effective_date: today, snapshot: DAY(2000, 2400), changed_at: plain,
        field_times: { water_goal_ml: plain },
      },
      // The later day's field time is already on the server clock.
      {
        effective_date: tomorrow, snapshot: DAY(2000, 2500), changed_at: marked,
        field_times: { water_goal_ml: marked },
      },
    ],
  });

  const shifted = Date.parse(plain) - 2 * 3600_000;
  const offClock = await goalsOnAs(tok, today);
  assert.ok(Math.abs(Date.parse(offClock.changed_at) - shifted) < 5000,
    `a time on the phone's clock is set right by the offset the push reports (got ${offClock.changed_at})`);
  const onClock = await goalsOnAs(tok, tomorrow);
  assert.equal(Date.parse(onClock.changed_at), Date.parse(marked), 'the marked time is stored as sent');

  // The claims themselves, as stored, follow the same rule; a claim left in
  // the future would beat the settings it must merge with.
  const stored = new Map(dbRows(
    `SELECT effective_date, field_times FROM goal_history WHERE effective_date IN (?, ?)`,
    today, tomorrow
  ).map(row => [row.effective_date, JSON.parse(row.field_times)]));
  assert.ok(Math.abs(Date.parse(stored.get(today).water_goal_ml) - shifted) < 5000,
    `the phone-clock claim is corrected (${stored.get(today).water_goal_ml})`);
  assert.equal(Date.parse(stored.get(tomorrow).water_goal_ml), Date.parse(marked),
    'the marked claim is not offset again');
});

test('a claim carried from the day before loses to a newer edit already in the inherited snapshot', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('gus');
  const MON = '2026-10-12', TUE = '2026-10-13';
  const t10 = '2026-10-12T10:00:00.000Z';
  const t09 = '2026-10-12T09:00:00.000Z';
  const tTue = '2026-10-13T09:00:00.000Z';

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
  const t10 = '2026-10-19T10:00:00.000Z';
  const t11 = '2026-10-19T11:00:00.000Z';
  const tTue = '2026-10-20T09:00:00.000Z';
  const tWed = '2026-10-21T09:00:00.000Z';

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

test('a reset day lets a later offline edit back, in settings and history alike', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('zoe');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const day = D => goalsOnAs(tok, D);

  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2400), effective_date: '2026-10-16', changed_at: '2026-10-16T07:00:00.000Z',
  });
  await as(tok, 'DELETE', '/api/settings', { effective_date: '2026-10-16', changed_at: '2026-10-16T09:00:00.000Z' });
  // The edit was made after the reset, and arrives after it too.
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2600), effective_date: '2026-10-16', changed_at: '2026-10-16T10:00:00.000Z',
  });
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2600,
    'the newer edit brings the setting back');
  assert.equal((await day('2026-10-16')).calorie_target_kcal, 2600, 'and the reset day follows it');
});

test('a claim at the instant of a reset loses in history as it does in settings', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('tess');
  const D = '2026-10-18';
  const RESET = '2026-10-18T09:00:00.000Z';
  const goals = max => ({ calories: { max, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } });

  // 08:00 goals from the phone (so the setting's time is the edit's).
  await pushAs(tok, {
    settings: [{ key: 'goals', value: goals(2400), updated_at: '2026-10-18T08:00:00.000Z' }],
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

  // A couple of seconds later, both sides bring it back (the app's setting
  // merge reasons in whole seconds).
  const later = '2026-10-18T09:00:02.000Z';
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

  await pushAs(tok, {
    settings: [{ key: 'goals', value: goals(2400), updated_at: '2026-10-19T08:00:00.000Z' }],
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

test('an account created after the server started has its goal history from day one', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('newbie');
  // No timezone set: the dated forms use UTC, the same fallback the phone uses.
  const today = new Date().toISOString().slice(0, 10);
  const day = await goalsOnAs(tok, today);
  assert.equal(day.known, true, 'the account was given a baseline when it was created');
  assert.equal(day.effective_from, today);
  assert.equal(day.calorie_target_kcal, 2000);
  assert.equal(day.water_goal_ml, 2000);
});

test("a late save dates its own day with the value it sent", async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('wanda');
  const goals = max => ({ calories: { max, sharedGoal: true }, proteins: { max: 120, sharedGoal: true } });

  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(1500), effective_date: '2026-10-01', changed_at: '2026-10-01T08:00:00.000Z',
  });
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2500), effective_date: '2026-10-03', changed_at: '2026-10-03T08:00:00.000Z',
  });
  // The save made on 10-02 arrives last.
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(1800), effective_date: '2026-10-02', changed_at: '2026-10-02T08:00:00.000Z',
  });

  assert.equal((await goalsOnAs(tok, '2026-10-01')).calorie_target_kcal, 1500);
  assert.equal((await goalsOnAs(tok, '2026-10-02')).calorie_target_kcal, 1800,
    "the late save's own day has the value it sent");
  assert.equal((await goalsOnAs(tok, '2026-10-03')).calorie_target_kcal, 2500,
    'a day that set the goal itself later keeps its own');
});

test('effective_date is bounded to about a day of the corrected edit time', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('xavier');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const dayOffset = n => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const today = dayOffset(0);

  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2400), effective_date: today, changed_at: new Date().toISOString(),
  });
  // Ten days out, in either direction, is filed under the edit's own day.
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2600), effective_date: dayOffset(10), changed_at: new Date().toISOString(),
  });
  assert.equal((await goalsOnAs(tok, today)).calorie_target_kcal, 2600,
    'a date far in the future is replaced by the edit day');
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2800), effective_date: dayOffset(-10), changed_at: new Date().toISOString(),
  });
  assert.equal((await goalsOnAs(tok, today)).calorie_target_kcal, 2800,
    'a date far in the past is replaced by the edit day');

  // A phone two days ahead: its clock and its date are set right together.
  const ahead = new Date(Date.now() + 2 * 86400000).toISOString();
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(3000),
    effective_date: ahead.slice(0, 10), changed_at: ahead, client_now: ahead,
  });
  assert.equal((await goalsOnAs(tok, today)).calorie_target_kcal, 3000,
    "a wrong phone clock can't file the change under another day");

  // A normal offline save for yesterday keeps its own day.
  const yesterday = dayOffset(-1);
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2200),
    effective_date: yesterday,
    changed_at: new Date(Date.now() - 86400000).toISOString(),
    client_now: new Date().toISOString(),
  });
  assert.equal((await goalsOnAs(tok, yesterday)).calorie_target_kcal, 2200,
    "an offline edit for yesterday stays on yesterday");
});

test('a losing direct save keeps the newer live goal and records its own day', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('ada2');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const save = (max, date, at) => as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(max), effective_date: date, changed_at: at,
  });

  await save(1500, '2026-10-01', '2026-10-01T08:00:00.000Z');
  await save(2500, '2026-10-03', '2026-10-03T08:00:00.000Z');
  // The save for 10-02 arrives last, and loses the live setting.
  await save(1800, '2026-10-02', '2026-10-02T08:00:00.000Z');

  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2500,
    'the newer live goal stays');
  assert.equal((await goalsOnAs(tok, '2026-10-01')).calorie_target_kcal, 1500);
  assert.equal((await goalsOnAs(tok, '2026-10-02')).calorie_target_kcal, 1800,
    "the losing save's own day keeps the value it sent");
  assert.equal((await goalsOnAs(tok, '2026-10-03')).calorie_target_kcal, 2500);

  // The losing save did not stale the winning value's time: a push older
  // than the 10-03 save still loses.
  await pushAs(tok, {
    settings: [{ key: 'goals', value: goals(2000), updated_at: '2026-10-03T07:00:00.000Z' }],
  });
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2500);
});

test('a losing bulk save keeps the newer live goal and records its own day', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('bert2');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(1500), effective_date: '2026-10-01', changed_at: '2026-10-01T08:00:00.000Z',
  });
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2500), effective_date: '2026-10-03', changed_at: '2026-10-03T08:00:00.000Z',
  });
  // A template for 10-02: its goals lose to 10-03, its water goal is new.
  await as(tok, 'PUT', '/api/settings/bulk', {
    settings: { goals: goals(1800), waterGoalMl: 1900 },
    effective_date: '2026-10-02', changed_at: '2026-10-02T08:00:00.000Z',
  });

  const live = await as(tok, 'GET', '/api/goals/effective');
  assert.equal(live.goals.calories.max, 2500, 'the newer live goal stays');
  assert.equal(live.water_goal_ml, 1900);
  const day = await goalsOnAs(tok, '2026-10-02');
  assert.equal(day.calorie_target_kcal, 1800, "the template's goals are the day's own");
  assert.equal(day.water_goal_ml, 1900);
});

test('a reset older than a newer goal edit does not undo it', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('cora2');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  await pushAs(tok, {
    settings: [{ key: 'goals', value: goals(2400), updated_at: '2026-10-16T10:00:00.000Z' }],
  });
  // The reset was made at 09:00, before that edit, and arrives after it.
  await as(tok, 'DELETE', '/api/settings', { effective_date: '2026-10-16', changed_at: '2026-10-16T09:00:00.000Z' });

  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2400,
    'the newer edit survives the older reset');
  assert.equal((await goalsOnAs(tok, '2026-10-16')).calorie_target_kcal, 2400);
});

test('a pushed history row is filed under the edit day, and a later fallback still runs', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('dora2');
  const today = new Date().toISOString().slice(0, 10);
  const at = new Date().toISOString();

  // A wrong date far away: the row is filed under the edit's own day.
  await pushAs(tok, {
    goal_history: [{
      effective_date: '2099-01-01', snapshot: DAY(2400, 2000), changed_at: at,
      field_times: { goals: at },
    }],
  });
  assert.equal((await goalsOnAs(tok, today)).calorie_target_kcal, 2400,
    'the row is filed under the edit day, not 2099');

  // A legacy settings-only change afterwards is still recorded: a newest
  // history date in 2099 would have suppressed it.
  await pushAs(tok, {
    settings: [{ key: 'goals', value: { calories: { max: 2600, sharedGoal: true } }, updated_at: new Date(Date.now() + 2000).toISOString() }],
  });
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2600);
  assert.equal((await goalsOnAs(tok, today)).calorie_target_kcal, 2600);
});

test('settings sent without history keep each day and each field', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('emma2');
  const goals = max => ({ calories: { max, sharedGoal: true } });

  // Two goal keys for different days in one push: two days, not the newest.
  await pushAs(tok, {
    settings: [
      { key: 'goals', value: goals(2400), updated_at: '2026-10-05T08:00:00.000Z' },
      { key: 'waterGoalMl', value: 2900, updated_at: '2026-10-06T08:00:00.000Z' },
    ],
  });
  assert.equal((await goalsOnAs(tok, '2026-10-05')).calorie_target_kcal, 2400);
  const second = await goalsOnAs(tok, '2026-10-06');
  assert.equal(second.water_goal_ml, 2900);
  assert.equal(second.calorie_target_kcal, 2400, 'the goal set the day before carries over');

  // A history row for one field must not keep the settings from recording
  // another field of the same day.
  await pushAs(tok, {
    goal_history: [{
      effective_date: '2026-10-07',
      snapshot: DAY(2000, 2000),
      changed_at: '2026-10-07T08:00:00.000Z',
      field_times: { water_goal_ml: '2026-10-07T08:00:00.000Z' },
    }],
    settings: [{ key: 'goals', value: goals(2500), updated_at: '2026-10-07T08:00:00.000Z' }],
  });
  const third = await goalsOnAs(tok, '2026-10-07');
  assert.equal(third.calorie_target_kcal, 2500, 'the settings value is not suppressed by the history row');
  assert.equal(third.water_goal_ml, 2000, 'and the history row keeps its own field');
});

test('a late first-day edit stops at the next day own edit in the same second', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('freda2');
  const MON = '2026-10-12', TUE = '2026-10-13';
  const tMon = '2026-10-12T10:00:00.000Z';
  const tTue = '2026-10-13T10:00:00.000Z';

  await pushAs(tok, {
    goal_history: [{ effective_date: MON, snapshot: DAY(1500, 2000), changed_at: tMon }],
  });
  await pushAs(tok, {
    goal_history: [{ effective_date: TUE, snapshot: DAY(2500, 2000), changed_at: tTue }],
  });
  // Monday's late edit is stamped at the very second Tuesday set its own.
  await pushAs(tok, {
    goal_history: [{ effective_date: MON, snapshot: DAY(1800, 2000), changed_at: tTue }],
  });

  assert.equal((await goalsOnAs(tok, MON)).calorie_target_kcal, 1800, 'Monday takes the correction');
  assert.equal((await goalsOnAs(tok, TUE)).calorie_target_kcal, 2500,
    "Tuesday's own edit is not overwritten by the first day's late arrival");
});

test('a losing setting pushed without history still dates its own day', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('gina2');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const sent = (max, at) => pushAs(tok, { settings: [{ key: 'goals', value: goals(max), updated_at: at }] });

  await sent(1500, '2026-10-01T08:00:00.000Z');
  await sent(2500, '2026-10-03T08:00:00.000Z');
  // The 10-02 change loses the live setting to 10-03's.
  await sent(1800, '2026-10-02T08:00:00.000Z');

  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2500);
  assert.equal((await goalsOnAs(tok, '2026-10-02')).calorie_target_kcal, 1800,
    'the losing push still records its own day');
  assert.equal((await goalsOnAs(tok, '2026-10-03')).calorie_target_kcal, 2500);
});

test('an edit older than the baseline cannot rewrite today, and a day before it knows only what was sent', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('hana2');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);

  // The live goals after the upgrade: water 3000, calories 2500.
  await as(tok, 'PUT', '/api/settings/bulk', {
    settings: { goals: goals(2500), waterGoalMl: 3000 },
    effective_date: today, changed_at: new Date().toISOString(),
  });

  // That configuration is the day's *baseline* (what an upgrade or a restore
  // records), not a later edit: the only row today, and it owns every field.
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  const writer = new Database(join(dir, 'server.db'));
  try {
    const id = writer.prepare('SELECT id FROM users WHERE username = ?').get('hana2').id;
    writer.prepare('DELETE FROM goal_history WHERE user_id = ?').run(id);
    const { ensureGoalHistoryBaseline } = await import('../server/lib/goal-history-baseline.js');
    ensureGoalHistoryBaseline(writer, id, { at: Date.now() });
  } finally { writer.close(); }

  // An older phone push, dated four days back: it only brought the water
  // goal it changed, 1500.
  await pushAs(tok, {
    goal_history: [{
      effective_date: old,
      snapshot: { goals: goals(2500), water_goal_ml: 1500 },
      changed_at: `${old}T09:00:00.000Z`,
      field_times: { water_goal_ml: `${old}T09:00:00.000Z` },
    }],
  });

  const now = await goalsOnAs(tok, today);
  assert.equal(now.water_goal_ml, 3000, "the baseline is not rewritten by the old edit");
  assert.equal(now.calorie_target_kcal, 2500);

  const past = await goalsOnAs(tok, old);
  assert.equal(past.water_goal_ml, 1500, 'the day before history keeps what it sent');
  assert.equal(past.calorie_target_kcal, undefined,
    "the fields it didn't send are unknown, not today's goals dressed up as that day's");
  assert.equal(past.goals, undefined);
  assert.ok(past.unknown_fields.includes('goals'));
  assert.equal(past.history_complete, false);
});

test('a reset with a losing time records the defaults for its own day, not the newer goal', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('iris2');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const D = '2026-09-02', D2 = '2026-09-03';

  // A newer edit for the next day: 2500 at 10:00.
  await pushAs(tok, {
    settings: [{ key: 'goals', value: goals(2500), updated_at: `${D2}T10:00:00.000Z` }],
  });
  // The reset was made at 09:00 the day before and arrives after it.
  await as(tok, 'DELETE', '/api/settings', {
    effective_date: D, changed_at: `${D}T09:00:00.000Z`,
  });

  assert.equal((await as(tok, 'GET', '/api/goals/effective')).goals.calories.max, 2500,
    'the newer edit survives the older reset');
  const reset = await goalsOnAs(tok, D);
  assert.equal(reset.calorie_target_kcal, 2000, "the reset's own day is the defaults");
  assert.equal(reset.water_goal_ml, 2000);
  assert.equal((await goalsOnAs(tok, D2)).calorie_target_kcal, 2500, "the newer day's edit stays");
});

test('a push carries at most 400 goal days, and the rest wait for the next one', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('jane2');
  const rows = [];
  for (let i = 0; i < 405; i++) {
    // One row per day, each made that day, so no date is bounded away.
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    rows.push({
      effective_date: day,
      snapshot: DAY(2000, 2000),
      changed_at: `${day}T09:00:00.000Z`,
      field_times: { water_goal_ml: `${day}T09:00:00.000Z` },
    });
  }
  const answer = await pushAs(tok, { goal_history: rows });
  assert.equal(answer.goal_history.length, 400, 'the answer acknowledges the days it stored, no more');
  const stored = dbRows(
    'SELECT COUNT(*) AS n FROM goal_history WHERE user_id = (SELECT id FROM users WHERE username = ?)', 'jane2'
  )[0].n;
  assert.equal(stored, 400, 'and the server stores exactly the ones it acknowledged');
});

test('a push that carries history does not date the same day and field again from its settings', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('kate2');
  const D = new Date().toISOString().slice(0, 10);
  const at = new Date().toISOString();

  await pushAs(tok, {
    settings: [{ key: 'waterGoalMl', value: 3000, updated_at: at }],
    goal_history: [{
      effective_date: D,
      snapshot: DAY(2000, 1500),
      changed_at: at,
      field_times: { water_goal_ml: at },
    }],
  });

  const day = await goalsOnAs(tok, D);
  assert.equal(day.water_goal_ml, 1500, "the day keeps what its own history said, not the settings' later value");
  assert.equal(day.changed_at, at);
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).water_goal_ml, 3000,
    'the live setting still takes the pushed value');
});

test('a baseline stops an edit only when it is older than the field it would replace', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('nina3');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const today = new Date().toISOString().slice(0, 10);
  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const d30 = day(30), d40 = day(40), d4 = day(4);

  // Water was set 30 days ago; the calorie goal is today's. (Setting goals
  // today must not touch water's own time.)
  await as(tok, 'PUT', '/api/settings', {
    key: 'waterGoalMl', value: 3000, effective_date: d30, changed_at: `${d30}T09:00:00.000Z`,
  });
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2500), effective_date: today, changed_at: new Date().toISOString(),
  });

  // Rebuild the history as the baseline an upgrade records: the configuration
  // as it is, each field keeping its own edit time (water 30 days old).
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  const writer = new Database(join(dir, 'server.db'));
  try {
    const id = writer.prepare('SELECT id FROM users WHERE username = ?').get('nina3').id;
    writer.prepare('DELETE FROM goal_history WHERE user_id = ?').run(id);
    const { ensureGoalHistoryBaseline } = await import('../server/lib/goal-history-baseline.js');
    ensureGoalHistoryBaseline(writer, id, { at: Date.now() });
  } finally { writer.close(); }

  // An offline water edit made four days ago, after the upgrade's baseline
  // but newer than the field's own (30-day-old) time: both live and history
  // must take it.
  await pushAs(tok, {
    settings: [{ key: 'waterGoalMl', value: 2800, updated_at: `${d4}T09:00:00.000Z` }],
    goal_history: [{
      effective_date: d4,
      snapshot: DAY(2000, 2800),
      changed_at: `${d4}T09:00:00.000Z`,
      field_times: { water_goal_ml: `${d4}T09:00:00.000Z` },
    }],
  });

  assert.equal((await as(tok, 'GET', '/api/goals/effective')).water_goal_ml, 2800,
    'the live goal takes the four-day-old edit');
  const now = await goalsOnAs(tok, today);
  assert.equal(now.water_goal_ml, 2800, "and today's history follows it");
  assert.equal(now.calorie_target_kcal, 2500, 'the rest of the baseline configuration stays');

  // An edit older than the field's baseline time still loses, in history as
  // in the settings.
  await pushAs(tok, {
    settings: [{ key: 'waterGoalMl', value: 2100, updated_at: `${d40}T09:00:00.000Z` }],
    goal_history: [{
      effective_date: d40,
      snapshot: DAY(2000, 2100),
      changed_at: `${d40}T09:00:00.000Z`,
      field_times: { water_goal_ml: `${d40}T09:00:00.000Z` },
    }],
  });
  assert.equal((await goalsOnAs(tok, today)).water_goal_ml, 2800,
    'an edit older than the baseline field time does not rewrite it');
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).water_goal_ml, 2800);
});

test('a day that got only some fields reports the rest as unknown, not as defaults', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('pam3');
  const today = new Date().toISOString().slice(0, 10);
  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const d5 = day(5), d4 = day(4);

  // A day before the baseline that only received its water goal.
  await pushAs(tok, {
    goal_history: [{
      effective_date: d5,
      snapshot: DAY(2500, 1500),
      changed_at: `${d5}T09:00:00.000Z`,
      field_times: { water_goal_ml: `${d5}T09:00:00.000Z` },
    }],
  });

  const got = await goalsOnAs(tok, d5);
  assert.equal(got.known, true);
  assert.equal(got.water_goal_ml, 1500, 'the field it got is its own');
  assert.equal(got.goals, undefined, 'the goals it never got are unknown');
  assert.equal(got.calorie_target_kcal, undefined, 'and no default is presented as its target');
  assert.equal(got.resolved_goals, undefined);
  assert.ok(got.unknown_fields.includes('goals'));
  assert.equal(got.history_complete, false);

  // A later day before the baseline inherits the known field and stays
  // unknown on the others.
  const next = await goalsOnAs(tok, d4);
  assert.equal(next.water_goal_ml, 1500);
  assert.equal(next.calorie_target_kcal, undefined);
  assert.ok(next.unknown_fields.includes('goals'));

  // The baseline's own day is complete again, and a range says so.
  const now = await goalsOnAs(tok, today);
  assert.equal(now.history_complete, true);
  assert.deepEqual(now.unknown_fields, []);
  assert.equal(typeof now.calorie_target_kcal, 'number');
  const range = await as(tok, 'GET', `/api/goals/effective?start=${d5}&end=${today}`);
  assert.equal(range.history_complete, false, 'a partial day makes the range incomplete');
  const byDate = new Map(range.days.map(d => [d.date, d]));
  assert.equal(byDate.get(d5).history_complete, false);
  assert.equal(byDate.get(today).history_complete, true);
});

test('a field the account never saved counts as never edited, so an older offline edit still wins', async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('nina4');
  const goals = max => ({ calories: { max, sharedGoal: true } });
  const today = new Date().toISOString().slice(0, 10);
  const d4 = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);

  // Only the calorie goal was ever saved; water is still its default.
  await as(tok, 'PUT', '/api/settings', {
    key: 'goals', value: goals(2500), effective_date: today, changed_at: new Date().toISOString(),
  });
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  const writer = new Database(join(dir, 'server.db'));
  try {
    const id = writer.prepare('SELECT id FROM users WHERE username = ?').get('nina4').id;
    writer.prepare('DELETE FROM goal_history WHERE user_id = ?').run(id);
    writer.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = 'waterGoalMl'").run(id);
    const { ensureGoalHistoryBaseline } = await import('../server/lib/goal-history-baseline.js');
    ensureGoalHistoryBaseline(writer, id, { at: Date.now() });
  } finally { writer.close(); }

  // An offline water edit made four days ago, before the upgrade's baseline.
  await pushAs(tok, {
    settings: [{ key: 'waterGoalMl', value: 2800, updated_at: `${d4}T09:00:00.000Z` }],
    goal_history: [{
      effective_date: d4,
      snapshot: DAY(2000, 2800),
      changed_at: `${d4}T09:00:00.000Z`,
      field_times: { water_goal_ml: `${d4}T09:00:00.000Z` },
    }],
  });

  assert.equal((await as(tok, 'GET', '/api/goals/effective')).water_goal_ml, 2800);
  const now = await goalsOnAs(tok, today);
  assert.equal(now.water_goal_ml, 2800, "today's history takes the edit like the live goal");
  assert.equal(now.calorie_target_kcal, 2500, 'the saved calorie goal stays');
});

test("a day's goals and the live setting agree on which of two edits in one second won", async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('ines2');
  const DAY_ = '2026-10-20';
  const send = (ml, at) => pushAs(tok, { settings: [{ key: 'waterGoalMl', value: ml, updated_at: at }] });
  // The later edit (in milliseconds) arrives first; the earlier one, in the
  // same second, arrives after it and loses.
  await send(2500, '2026-10-20T10:00:00.800Z');
  await send(2000, '2026-10-20T10:00:00.200Z');
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).water_goal_ml, 2500, 'the live setting keeps the later edit');
  assert.equal((await goalsOnAs(tok, DAY_)).water_goal_ml, 2500, "and the day's goals say the same");
});

test("a reset and an edit in one second: the day's goals follow the live setting", async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('jonas2');
  const DAY_ = '2026-10-21';
  await pushAs(tok, { settings: [{ key: 'waterGoalMl', value: 2400, updated_at: '2026-10-21T08:00:00.000Z' }] });
  // Settings' reset at .100, then a phone's edit made at .900 of the same second.
  await as(tok, 'DELETE', '/api/settings', { changed_at: '2026-10-21T10:00:00.100Z', client_now: new Date().toISOString(), effective_date: DAY_ });
  await pushAs(tok, { settings: [{ key: 'waterGoalMl', value: 3100, updated_at: '2026-10-21T10:00:00.900Z' }] });
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).water_goal_ml, 3100, 'the later edit brings the goal back');
  assert.equal((await goalsOnAs(tok, DAY_)).water_goal_ml, 3100, "and the day's goals have it too");
});

test("an edit, then a reset made earlier in the same second: the day's goals keep the edit, as the setting does", async (t) => {
  if (skip(t)) return;
  const tok = await freshAccount('kira2');
  const DAY_ = '2026-10-22';
  await pushAs(tok, { settings: [{ key: 'waterGoalMl', value: 3100, updated_at: '2026-10-22T10:00:00.900Z' }] });
  // Settings' reset, made at .100 of that second, arrives after it.
  await as(tok, 'DELETE', '/api/settings', { changed_at: '2026-10-22T10:00:00.100Z', client_now: new Date().toISOString(), effective_date: DAY_ });
  assert.equal((await as(tok, 'GET', '/api/goals/effective')).water_goal_ml, 3100, 'the later edit keeps the goal');
  assert.equal((await goalsOnAs(tok, DAY_)).water_goal_ml, 3100, "and the day's goals say the same");
});
