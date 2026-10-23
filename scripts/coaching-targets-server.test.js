/**
 * Coaching, phase 3 (recommended targets), against the real server, with a
 * stand-in ntfy and a stand-in webhook receiver:
 *
 * - The coach's editor starts from the client's targets (and their adaptive
 *   TDEE); what a coach may send is checked (calories, protein, carbs, fat in
 *   grams or percent, per weekday or not, or a calorie mode).
 * - A recommendation is pending until the client answers; it shows in the
 *   conversation; a newer one replaces a pending one; ending the pairing
 *   withdraws it; history is kept; answers sent offline arrive by sync push.
 * - Notifications: a new recommendation to the client, the answer to the coach.
 * - The round trip the client does on Accept (lib/coach-targets.js) and Undo
 *   brings per-weekday, percent and Adaptive targets back exactly, and the
 *   server's readers (/api/v1/goals, MCP get_goals, the goal.achieved
 *   webhook) read what Accept wrote.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyTargets, beforeTemplate, matchesTemplate } from '../src/lib/coach-targets.js';
import { dayTargets } from '../src/lib/goal-resolver.js';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'coaching-targets-test-0123456789abcdef0123';
const TODAY = new Date().toLocaleDateString('sv-SE');
let proc, base, dir, sink;
const tok = {}, ids = {};
const received = []; // ntfy pushes and webhook deliveries

async function call(who, method, path, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (who) h.Authorization = `Bearer ${tok[who] ?? who}`;
  const r = await fetch(base + path, { method, headers: h, body: body == null || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const waitFor = async (pred, ms = 3000) => { for (let i = 0; i < ms / 50; i++) { if (pred()) return true; await sleep(50); } return pred(); };

test.before(async () => {
  if (!ready) return;
  sink = await new Promise((res) => {
    const s = http.createServer((req, resp) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ path: req.url, body: b }); resp.end('{}'); }); });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  dir = mkdtempSync(join(tmpdir(), 'nt-coach-targets-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', MCP_ENABLED: '1', PUBLIC_API_ENABLED: '1', WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up */ } await sleep(100); }
  // The client is the admin here: API tokens are an admin's.
  const reg = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cleo', password: PW, full_name: 'Cleo Client' }) })).json();
  tok.client = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cleo', password: PW }) })).json()).token;
  ids.client = reg.user.id;
  const jwt = serverRequire('jsonwebtoken');
  for (const [name, role, full] of [['coach', 'coach', 'Sam Coach'], ['coach2', 'coach', 'Kim Coach']]) {
    const { user } = await ok('client', 'POST', '/api/auth/register', { username: name, password: PW, full_name: full, role });
    tok[name] = jwt.sign({ id: user.id, username: name, role, csrf: 'x' }, JWT_SECRET, { expiresIn: '1h' });
    ids[name] = user.id;
  }
  const r = await ok('coach', 'POST', '/api/coaching/requests', { client_id: ids.client });
  await ok('client', 'POST', `/api/coaching/pairings/${r.id}/accept`);
  ids.pairing = r.id;
  for (const who of ['coach', 'client']) {
    await ok(who, 'PUT', '/api/settings', { key: 'notifPushService', value: 'ntfy' });
    await ok(who, 'PUT', '/api/settings', { key: 'ntfyUrl', value: `http://127.0.0.1:${sink.address().port}` });
    await ok(who, 'PUT', '/api/settings', { key: 'ntfyTopic', value: `push-${who}` });
  }
});
test.after(() => { proc?.kill(); sink?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// Per weekday calories, protein as a percent, carbs a minimum, fat in grams,
// Adaptive mode with a factor, and goals the coach never touches.
const START = {
  calories: { sharedGoal: false, isMin: false, isPercent: false, autoAdjust: false, showInDiary: true, showInStats: false, days: [2300, 2000, 2000, 2100, 2000, 2000, 2400], max: 2400 },
  proteins: { sharedGoal: true, isMin: false, isPercent: true, autoAdjust: false, showInDiary: false, showInStats: true, days: [30, 30, 30, 30, 30, 30, 30], max: 30 },
  carbohydrates: { sharedGoal: true, isMin: true, isPercent: false, showInDiary: true, showInStats: true, days: [180, 180, 180, 180, 180, 180, 180], min: 180 },
  fat: { sharedGoal: true, isMin: false, isPercent: false, showInDiary: true, showInStats: true, days: [70, 70, 70, 70, 70, 70, 70], max: 70 },
  fiber: { sharedGoal: true, isMin: true, showInDiary: true, showInStats: true, days: [30, 30, 30, 30, 30, 30, 30], min: 30 },
};
const RECOMMEND = {
  goals: {
    calories: { sharedGoal: true, max: 1900 },
    proteins: { sharedGoal: false, isPercent: false, days: [140, 150, 150, 150, 150, 150, 140] },
    fat: { sharedGoal: true, isPercent: true, max: 25 },
  },
};
const recPath = () => `/api/coaching/clients/${ids.client}/recommendations`;

test('the editor starts from the client\'s targets; what a coach sends is checked', { skip: !ready }, async () => {
  await ok('client', 'PUT', '/api/settings', { key: 'goals', value: START });
  await ok('client', 'PUT', '/api/settings', { key: 'calorieGoalMode', value: 'adaptive' });
  await ok('client', 'PUT', '/api/settings', { key: 'calorieGoalFactor', value: 0.8 });
  const t = await ok('coach', 'GET', `/api/coaching/clients/${ids.client}/targets`);
  assert.deepEqual(Object.keys(t.goals).sort(), ['calories', 'carbohydrates', 'fat', 'proteins'], 'only the four, never fiber');
  assert.deepEqual(t.goals.calories, START.calories);
  assert.equal(t.calorie_mode, 'adaptive');
  assert.ok(t.adaptive && 'ready' in t.adaptive);
  // Refused: another nutrient, a percent over 100, six days, nothing at all.
  for (const bad of [{ goals: { fiber: { max: 40 } } }, { goals: { fat: { isPercent: true, max: 140 } } },
    { goals: { calories: { sharedGoal: false, days: [1, 2, 3, 4, 5, 6] } } }, {}, { mode: 'turbo' }]) {
    assert.equal((await call('coach', 'POST', recPath(), { payload: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('coach2', 'POST', recPath(), { payload: RECOMMEND })).status, 404, 'not their client');
  // The client is an admin here (admins can coach), but not their own coach.
  assert.equal((await call('client', 'POST', recPath(), { payload: RECOMMEND })).status, 404);
});

test('a recommendation: pending, in the conversation, replaced by a newer one, answered, kept', { skip: !ready }, async () => {
  received.length = 0;
  const first = await ok('coach', 'POST', recPath(), { payload: { mode: 'fixed' }, note: 'Try fixed first' });
  const second = await ok('coach', 'POST', recPath(), { payload: RECOMMEND, note: 'Then these' });
  assert.equal(second.status, 'pending');
  assert.deepEqual(second.payload.goals.calories, { sharedGoal: true, isMin: false, isPercent: false, days: Array(7).fill(1900), max: 1900 });
  const mine = await ok('client', 'GET', '/api/coaching/recommendations');
  assert.deepEqual(mine.map((r) => [r.id, r.status]), [[second.id, 'pending'], [first.id, 'replaced']]);
  const st = await ok('client', 'GET', '/api/coaching/state');
  assert.equal(st.awaiting, 1, 'one waiting for an answer: the dot');
  const conv = await ok('client', 'GET', `/api/coaching/pairings/${ids.pairing}/messages`);
  assert.deepEqual(conv.messages.filter((m) => m.recommendation_id).map((m) => m.recommendation_id), [first.id, second.id]);
  assert.ok(await waitFor(() => received.some((p) => p.path === '/push-client' && p.body === 'Sam Coach sent you a recommendation.')));
  assert.doesNotMatch(JSON.stringify(received), /Then these/, 'never the note');

  // The replaced one can't be accepted, and says why.
  const late = await call('client', 'POST', `/api/coaching/recommendations/${first.id}/answer`, { status: 'accepted' });
  assert.equal(late.status, 409);
  assert.equal(late.data.error, 'Replaced by a newer recommendation.');
  assert.equal(late.data.recommendation.status, 'replaced');
  // Only the client answers.
  assert.equal((await call('coach', 'POST', `/api/coaching/recommendations/${second.id}/answer`, { status: 'accepted' })).status, 404);

  received.length = 0;
  const unreadBefore = (await ok('client', 'GET', '/api/coaching/state')).unread;
  const answered = await ok('client', 'POST', `/api/coaching/recommendations/${second.id}/answer`, { status: 'accepted', response_note: 'Deal' });
  assert.equal(answered.status, 'accepted');
  // Answering reads its message: the dot and counts clear.
  assert.equal((await ok('client', 'GET', '/api/coaching/state')).unread, unreadBefore - 1);
  const read = (await ok('client', 'GET', `/api/coaching/pairings/${ids.pairing}/messages`)).messages.find((m) => m.recommendation_id === second.id);
  assert.ok(read.read_at, 'its message is read');
  assert.equal(answered.response_note, 'Deal');
  assert.equal((await call('client', 'POST', `/api/coaching/recommendations/${second.id}/answer`, { status: 'declined' })).status, 409, 'answered once');
  assert.ok(await waitFor(() => received.some((p) => p.path === '/push-coach' && p.body === 'Cleo Client accepted your recommended targets.')));
  const history = await ok('coach', 'GET', recPath());
  assert.deepEqual(history.map((r) => r.status), ['accepted', 'replaced']);
  assert.equal((await ok('client', 'GET', '/api/coaching/state')).awaiting, 0);
});

test('Accept then Undo brings per-weekday, percent and Adaptive targets back exactly; the server reads what Accept wrote', { skip: !ready }, async () => {
  const goalsNow = START, modeNow = 'adaptive';
  // What the app does on Accept (lib/coach-targets.js), then writes as settings.
  const tpl = beforeTemplate({ goals: goalsNow, mode: modeNow, waterGoalMl: 2500, name: `Before coach change, ${TODAY}`, recommendationId: 1 });
  const { goals, mode } = applyTargets(goalsNow, modeNow, RECOMMEND);
  assert.equal(mode, 'fixed', 'a calorie number switches Adaptive to Fixed');
  assert.deepEqual(goals.fiber, START.fiber, 'other nutrients untouched');
  assert.deepEqual(goals.carbohydrates, START.carbohydrates, 'targets not recommended untouched');
  assert.equal(goals.proteins.showInDiary, false, 'show/hide in Diary stays');
  assert.equal(goals.calories.showInStats, false, 'show/hide in Statistics stays');
  assert.equal(goals.proteins.isPercent, false);
  assert.deepEqual(goals.proteins.days, [140, 150, 150, 150, 150, 150, 140]);
  await ok('client', 'PUT', '/api/settings', { key: 'goals', value: goals });
  await ok('client', 'PUT', '/api/settings', { key: 'calorieGoalMode', value: mode });

  // /api/v1/goals and MCP get_goals read the new targets.
  const { raw: token } = await ok('client', 'POST', '/api/admin/api-tokens', { name: 'reader', scopes: ['mcp:read'] });
  const v1 = await ok(token, 'GET', '/api/v1/goals');
  assert.deepEqual(v1.goals.calories, goals.calories);
  assert.deepEqual(v1.goals.proteins, goals.proteins);
  const mcp = await fetch(base + '/api/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_goals', arguments: {} } }) });
  const raw = await mcp.text();
  const frame = raw.includes('data:') ? raw.split('\n').filter((l) => l.startsWith('data:')).at(-1).slice(5) : raw;
  const result = JSON.parse(JSON.parse(frame).result.content[0].text);
  assert.deepEqual(result.goals.calories, goals.calories);

  // goal.achieved reads what Accept wrote: calories (1900) and fat (25% of
  // 1900 = 53 g) are maximums now, so reaching them isn't an achievement;
  // the carbs minimum (180, untouched) is.
  received.length = 0;
  await ok('client', 'POST', '/api/admin/webhooks', { url: `http://127.0.0.1:${sink.address().port}/hook`, events: ['goal.achieved'] });
  await ok('client', 'PUT', `/api/diary/${TODAY}`, { items: [{ uuid: 'g1', name: 'Big Lunch', meal: 1, portion: 1, unit: 'serving', quantity: 1, nutrition: { calories: 1950, proteins: 10, carbohydrates: 200, fat: 60 } }], water: [], body_stats: {}, notes: '' });
  assert.ok(await waitFor(() => received.filter((p) => p.path === '/hook').length >= 1), 'goal.achieved delivered');
  await sleep(300);
  assert.deepEqual(hooksByMetric(), { carbs: 180 });

  // Undo applies the template: everything as it was, exactly.
  await ok('client', 'PUT', '/api/settings', { key: 'goals', value: tpl.goals });
  await ok('client', 'PUT', '/api/settings', { key: 'calorieGoalMode', value: tpl.calorieGoalMode });
  const back = await ok('client', 'GET', '/api/settings');
  assert.deepEqual(back.goals, START);
  assert.equal(back.calorieGoalMode, 'adaptive');
  assert.equal(back.calorieGoalFactor, 0.8, 'the factor was never touched');
  assert.ok(matchesTemplate(tpl, back.goals, back.calorieGoalMode));
});

const hooksByMetric = () => Object.fromEntries(received.filter((p) => p.path === '/hook').map((p) => JSON.parse(p.body)).map((h) => h.data ?? h.payload).map((h) => [h.metric, h.target]));
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('sv-SE'); };
let lunches = 0;
const lunch = (calories, proteins = 0, fat = 0) => ({ items: calories ? [{ uuid: `lunch-${++lunches}`, name: 'Lunch', meal: 1, portion: 1, unit: 'serving', quantity: 1, nutrition: { calories, proteins, carbohydrates: 0, fat } }] : [], water: [], body_stats: {}, notes: '' });
/** Today's diary becomes this one lunch (what was there is deleted in the same save). */
const eatToday = async (...a) => {
  const now = await ok('client', 'GET', `/api/diary/${TODAY}`);
  await ok('client', 'PUT', `/api/diary/${TODAY}`, { ...lunch(...a), deleted_uuids: { items: (now?.items || []).map((i) => i.uuid) } });
};

test('goal.achieved: only minimum goals, against the day\'s calorie goal as the Diary shows it with Dynamic or Adaptive', { skip: !ready }, async () => {
  const Database = serverRequire('better-sqlite3');
  const days = (v) => Array(7).fill(v);
  // Eat at least 2000 (a minimum), protein at least 20% of calories, fat at most 50 g.
  const goals = {
    calories: { sharedGoal: true, isMin: true, isPercent: false, days: days(2000), min: 2000 },
    proteins: { sharedGoal: true, isMin: true, isPercent: true, days: days(20), min: 20 },
    fat: { sharedGoal: true, isMin: false, isPercent: false, days: days(50), max: 50 },
  };
  await ok('client', 'PUT', '/api/settings', { key: 'goals', value: goals });

  // Dynamic: yesterday's calories out 2500, factor 1.1: today's goal is 2750.
  await ok('client', 'PUT', '/api/settings', { key: 'calorieGoalMode', value: 'dynamic' });
  await ok('client', 'PUT', '/api/settings', { key: 'calorieGoalFactor', value: 1.1 });
  const sql = new Database(join(dir, 'nt.db'));
  const yesterday = new Date(TODAY + 'T12:00:00Z'); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  sql.prepare(`INSERT INTO wellness_data (user_id, date, source, metric_type, value) VALUES (?, ?, 'garmin', 'calories_out', 2500)`).run(ids.client, yesterday.toISOString().slice(0, 10));
  sql.close();
  assert.equal((await ok('client', 'GET', `/api/wellness/calories-out?date=${TODAY}`)).calories_out, 2500, 'the Diary reads the same number');
  const protein = dayTargets(goals, TODAY, { calories: 2750 }).proteins;
  await eatToday(0);
  received.length = 0;
  // Past the base 2000 but short of 2750: nothing for calories; protein
  // (20% of 2750) reached; fat over its maximum is no achievement.
  await eatToday(2600, protein + 1, 80);
  assert.ok(await waitFor(() => received.some((p) => p.path === '/hook')));
  await sleep(300);
  assert.deepEqual(hooksByMetric(), { protein });
  received.length = 0;
  await eatToday(2800, protein + 1, 80);
  assert.ok(await waitFor(() => received.some((p) => p.path === '/hook')));
  await sleep(300);
  assert.deepEqual(hooksByMetric(), { calories: 2750 });

  // Adaptive: 25 days of 2400 at a steady 80 kg learn a TDEE near 2400.
  await ok('client', 'PUT', '/api/settings', { key: 'calorieGoalMode', value: 'adaptive' });
  await ok('client', 'PUT', '/api/settings', { key: 'calorieGoalFactor', value: 1 });
  for (let n = 1; n <= 25; n++) await ok('client', 'PUT', `/api/diary/${daysAgo(n)}`, { ...lunch(2400), body_stats: { weight: 80, weight_unit: 'kg' } });
  await eatToday(0);
  const learned = await ok('client', 'GET', '/api/goals/adaptive-tdee');
  assert.ok(learned.ready && learned.tdee > 2000, `adaptive ready: ${JSON.stringify(learned)}`);
  received.length = 0;
  await eatToday(2100);
  await sleep(500);
  assert.deepEqual(hooksByMetric(), {}, 'past the base 2000, short of the learned goal');
  await eatToday(learned.tdee + 100);
  assert.ok(await waitFor(() => received.some((p) => p.path === '/hook')));
  await sleep(300);
  const tdeeNow = (await ok('client', 'GET', '/api/goals/adaptive-tdee')).tdee;
  assert.deepEqual(hooksByMetric(), { calories: Math.round(tdeeNow) });
});

test('ending coaching withdraws what is pending; answers made offline arrive by sync push; sync and backup carry them', { skip: !ready }, async () => {
  const a = await ok('coach', 'POST', recPath(), { payload: { goals: { calories: { max: 2050 } } } });
  // The phone answered with no connection; the push brings it.
  const pushed = await ok('client', 'POST', '/api/sync/push', { coach_answers: [{ id: a.id, status: 'declined', response_note: 'Too low' }] });
  assert.equal(pushed.coach_answers[0].row.status, 'declined');
  const again = await ok('client', 'POST', '/api/sync/push', { coach_answers: [{ id: a.id, status: 'declined' }] });
  assert.equal(again.coach_answers[0].status, 409, 'once');
  const pulled = await ok('client', 'GET', '/api/sync/pull?coaching=1');
  assert.equal((await ok('coach', 'GET', '/api/sync/pull?coaching=1')).coach_recommendations.length, 0, 'a coach never pulls their own as theirs to answer');
  assert.ok(pulled.coach_recommendations.some((r) => r.id === a.id && r.status === 'declined'));
  assert.ok(!('coach_recommendations' in (await ok('client', 'GET', '/api/sync/pull'))), 'a 1.4 app sees nothing new');

  const b = await ok('coach', 'POST', recPath(), { payload: { goals: { fat: { max: 60 } } } });
  // Backup and restore keep the history.
  const AdmZip = serverRequire('adm-zip');
  const made = await ok('client', 'POST', '/api/full-backup');
  const data = JSON.parse(new AdmZip(join(dir, 'uploads', 'backups', made.filename)).readAsText('database.json'));
  assert.ok(data.coach_recommendations.length >= 4);
  await ok('client', 'POST', `/api/coaching/pairings/${ids.pairing}/end`);
  assert.equal((await ok('client', 'GET', '/api/coaching/recommendations')).find((r) => r.id === b.id).status, 'withdrawn');
  assert.equal((await call('client', 'POST', `/api/coaching/recommendations/${b.id}/answer`, { status: 'accepted' })).data.error, 'This recommendation was withdrawn.');
  await ok('client', 'POST', `/api/full-backup/${encodeURIComponent(made.filename)}/restore`);
  assert.equal((await ok('client', 'GET', '/api/coaching/recommendations')).find((r) => r.id === b.id).status, 'pending', 'restored as it was');
  // Deleting the coach's account takes the pairing and its history.
  await ok('client', 'DELETE', `/api/auth/users/${ids.coach}`);
  assert.deepEqual(await ok('client', 'GET', '/api/coaching/recommendations'), []);
});
