/**
 * Coaching, phase 4 (day plans), against the real server, with a stand-in
 * ntfy and a stand-in webhook receiver:
 *
 * - What a coach may send is checked; one plan per date (a waiting one is
 *   replaced); Copy to Other Days makes one plan per day, one notification.
 * - The builder reads the client's foods, meals and recipes (only theirs,
 *   only what each is).
 * - Answers notify the coach and read the plan's message; a plan past its
 *   date stops counting as waiting.
 * - Logging parity: a plan's items logged the way the app logs them
 *   (lib/coach-plans.js, the Foods page's diary item) match the same foods
 *   added by hand: the day's totals, what Statistics reads, the API's
 *   totals, the sync pull and the meal.logged webhook. Only the item's
 *   provenance (`source`) says it came from the plan.
 * - Foods the client doesn't have are copied into their catalog with their
 *   source (a coach's food) or barcode (Open Food Facts); a second copy is
 *   never made, and a deleted copy can be made again.
 * - The coach sees which meals were logged; deleting them brings Log This back.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { cleanPlanPayload, planItemFrom, planItemsFromMeal, findOwn, foodFromPlanItem, planDiaryItem, loggedMeals, loggedItems, shownStatus, planTotals } from '../src/lib/coach-plans.js';
// The dot's count of waiting day plans, from the app's store itself.
const plansWaiting = (() => {
  const src = readFileSync(new URL('../src/stores/coaching.js', import.meta.url), 'utf8');
  const start = src.indexOf('export function plansWaiting');
  let depth = 0, i = src.indexOf('{', src.indexOf(')', start));
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return new Function(`${src.slice(start, i + 1).replace('export ', '')}; return plansWaiting;`)();
})();
import { Nutrition } from '../src/lib/nutrition.js';

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
const JWT_SECRET = 'coaching-plans-test-0123456789abcdef0123';
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
const TODAY = day(0);
let proc, base, dir, sink;
const tok = {}, ids = {};
const received = [];

// The fields the app keeps on a diary item (stores/diary.js _KEEP_FIELDS),
// read from the app itself so this can't drift from it.
const KEEP = [...readFileSync(new URL('../src/stores/diary.js', import.meta.url), 'utf8').match(/const _KEEP_FIELDS = \[([\s\S]*?)\];/)[1].matchAll(/'([a-z_A-Z]+)'/g)].map((m) => m[1]);
/** What addDiaryItem saves for `input` in `meal` (on the web, where a food's id is the server's). */
function addDiaryItem(input, meal) {
  const item = { ...input, uuid: randomUUID(), meal, addedAt: new Date().toISOString(), food_server_id: typeof input.id === 'number' ? input.id : null };
  return Object.fromEntries(KEEP.filter((k) => k in item).map((k) => [k, item[k]]));
}
/** The Foods page adding a food: { ...food, portion, unit, quantity, nutrition }. */
const manualItem = (food, qty = 1) => ({ ...food, portion: food.portion || 100, unit: food.unit || 'g', quantity: qty, nutrition: food.nutrition });

async function call(who, method, path, body) {
  const h = { 'Content-Type': 'application/json' };
  if (who) h.Authorization = `Bearer ${tok[who] ?? who}`;
  const r = await fetch(base + path, { method, headers: h, body: body == null || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const waitFor = async (pred, ms = 3000) => { for (let i = 0; i < ms / 50; i++) { if (pred()) return true; await sleep(50); } return pred(); };
const saveDay = (date, items, deleted = []) => ok('client', 'PUT', `/api/diary/${date}`, { items, water: [], body_stats: {}, notes: '', deleted_uuids: { items: deleted, water: [] } });
const recPath = () => `/api/coaching/clients/${ids.client}/recommendations`;

test.before(async () => {
  if (!ready) return;
  sink = await new Promise((res) => {
    const s = http.createServer((req, resp) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ path: req.url, body: b }); resp.end('{}'); }); });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  dir = mkdtempSync(join(tmpdir(), 'nt-coach-plans-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', MCP_ENABLED: '1', PUBLIC_API_ENABLED: '1', WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up */ } await sleep(100); }
  // The client is the admin here: webhooks and API tokens are an admin's.
  const reg = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cleo', password: PW, full_name: 'Cleo Client' }) })).json();
  tok.client = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cleo', password: PW }) })).json()).token;
  ids.client = reg.user.id;
  const jwt = serverRequire('jsonwebtoken');
  for (const [name, role, full] of [['coach', 'coach', 'Sam Coach'], ['coach2', 'coach', 'Kim Coach'], ['other', 'user', 'Oli Other']]) {
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
  await ok('client', 'PUT', '/api/settings', { key: 'mealNames', value: ['Early', 'Midday', 'Evening', 'Late'] });
});
test.after(() => { proc?.kill(); sink?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const OATS = { name: 'Oats', brand: 'Mill', portion: 50, unit: 'g', nutrition: { calories: 190, proteins: 6.5, carbohydrates: 33, fat: 3.5, fiber: 5 } };
const SHAKE = { name: 'Whey Shake', brand: 'Lift', portion: 30, unit: 'g', nutrition: { calories: 120, proteins: 24, carbohydrates: 3, fat: 1.5 }, barcode: '4006381333931' };
const SKYR = { name: 'Skyr', brand: 'Nordic', portion: 100, unit: 'g', nutrition: { calories: 63, proteins: 11, carbohydrates: 4, fat: 0.2 }, barcode: '5701234567893' };

test('what a coach may send is checked; the builder reads only the client\'s catalog, only what each item is', { skip: !ready }, async () => {
  const good = { meals: [{ meal: 0, items: [{ name: 'Oats', portion: 50, unit: 'g', quantity: 1, nutrition: { calories: 190 }, source: { kind: 'client_food', id: 1 } }] }] };
  assert.ok(cleanPlanPayload(good).payload);
  for (const [bad, why] of [
    [{ meals: [] }, 'empty'],
    [{ meals: [{ meal: 0, items: [{ ...good.meals[0].items[0], name: '' }] }] }, 'no name'],
    [{ meals: [{ meal: 0, items: [{ ...good.meals[0].items[0], portion: -1 }] }] }, 'no amount'],
    [{ meals: [{ meal: 0, items: [{ ...good.meals[0].items[0], nutrition: { calories: 'lots' } }] }] }, 'nutrition not a number'],
    [{ meals: [{ meal: 0, items: [{ ...good.meals[0].items[0], source: { kind: 'someone_else', id: 1 } }] }] }, 'unknown source'],
    [{ meals: [{ meal: 0, items: [{ ...good.meals[0].items[0], source: { kind: 'off' } }] }] }, 'OFF without a barcode'],
    [{ meals: [{ meal: 0, items: [{ ...good.meals[0].items[0], barcode: '<img>' }] }] }, 'not a barcode'],
    [{ meals: [{ meal: 99, items: good.meals[0].items }] }, 'not a meal'],
    [{ meals: [{ meal: 0, items: Array(31).fill(good.meals[0].items[0]) }] }, 'too many'],
  ]) assert.ok(cleanPlanPayload(bad).error, why);

  const bad = await call('coach', 'POST', recPath(), { kind: 'day_plan', date: TODAY, payload: { meals: [] } });
  assert.equal(bad.status, 400);
  assert.equal((await call('coach', 'POST', recPath(), { kind: 'day_plan', date: 'soon', payload: good })).status, 400, 'a date');
  assert.equal((await call('coach', 'POST', recPath(), { kind: 'breakfast', date: TODAY, payload: good })).status, 400, 'a kind there is');
  assert.equal((await call('coach', 'POST', recPath(), { kind: 'meal', date: TODAY, payload: good })).status, 404, 'a meal is sent by its id, one of the coach\'s');

  // The client's catalog: their foods, meals (with ingredients) and recipes.
  const oats = await ok('client', 'POST', '/api/foods', OATS);
  const skyr = await ok('client', 'POST', '/api/foods', SKYR);
  const gone = await ok('client', 'POST', '/api/foods', { ...OATS, name: 'Old Bar' });
  await ok('client', 'DELETE', `/api/foods/${gone.id}`);
  await ok('other', 'POST', '/api/foods', { ...OATS, name: 'Not Theirs' });
  const breakfast = await ok('client', 'POST', '/api/meals', { name: 'Oats and Skyr', items: [{ ...oats, quantity: 1 }, { ...skyr, quantity: 2 }], nutrition: {} });
  const stew = await ok('client', 'POST', '/api/meals', { name: 'Lentil Stew', is_recipe: true, portion: 350, unit: 'g', nutrition: { calories: 420, proteins: 24, carbohydrates: 60, fat: 8 }, items: [] });
  ids.oats = oats.id; ids.skyr = skyr.id; ids.stew = stew.id; ids.breakfast = breakfast.id;
  const cat = await ok('coach', 'GET', `/api/coaching/clients/${ids.client}/catalog`);
  assert.deepEqual(cat.foods.map((f) => f.name), ['Oats', 'Skyr'], 'theirs, not deleted, nobody else\'s');
  assert.deepEqual(Object.keys(cat.foods[0]).sort(), ['barcode', 'brand', 'id', 'name', 'nutrition', 'portion', 'unit'], 'what each is, never who sees it');
  assert.deepEqual(cat.meals.map((m) => [m.name, m.items.length]), [['Oats and Skyr', 2]]);
  assert.deepEqual(cat.recipes.map((m) => m.name), ['Lentil Stew']);
  const fromMeal = planItemsFromMeal(cat.meals[0], 'client');
  assert.deepEqual(fromMeal.map((i) => [i.name, i.quantity, i.source.kind, i.source.id]), [['Oats', 1, 'client_food', oats.id], ['Skyr', 2, 'client_food', skyr.id]], 'a meal adds its ingredients, as the Diary does');
  // Only this client's coach.
  for (const who of ['coach2', 'other']) {
    assert.equal((await call(who, 'GET', `/api/coaching/clients/${ids.client}/catalog`)).status >= 400, true, who);
    assert.equal((await call(who, 'POST', recPath(), { kind: 'day_plan', date: TODAY, payload: good })).status >= 400, true, who);
  }
});

test('one plan per date; Copy to Other Days makes one per day with one notification; answers notify the coach and read the message; past its date a plan is Expired', { skip: !ready }, async () => {
  const cat = await ok('coach', 'GET', `/api/coaching/clients/${ids.client}/catalog`);
  const item = planItemFrom(cat.foods.find((f) => f.name === 'Oats'), 'client_food');
  const plan = { meals: [{ meal: 0, items: [item] }] };
  received.length = 0;
  const [first] = await ok('coach', 'POST', recPath(), { kind: 'day_plan', date: day(1), payload: plan, note: 'Easy day' });
  assert.equal(first.status, 'pending');
  assert.equal(first.date, day(1));
  const [second] = await ok('coach', 'POST', recPath(), { kind: 'day_plan', date: day(1), payload: plan });
  const mine = await ok('client', 'GET', '/api/coaching/recommendations');
  assert.equal(mine.find((r) => r.id === first.id).status, 'replaced', 'one plan per date');
  assert.equal(mine.find((r) => r.id === second.id).status, 'pending');
  // Copy to Other Days: the same plan for three days, one of them replacing the one waiting.
  await sleep(500); // the notifications for the two above have arrived
  received.length = 0;
  const copies = await ok('coach', 'POST', recPath(), { kind: 'day_plan', dates: [day(3), day(1), day(2)], payload: plan });
  assert.deepEqual(copies.map((r) => r.date), [day(1), day(2), day(3)]);
  assert.equal((await ok('client', 'GET', '/api/coaching/recommendations')).find((r) => r.id === second.id).status, 'replaced');
  await sleep(500);
  assert.equal(received.filter((p) => p.path === '/push-client').length, 1, 'one notification');
  const conv = await ok('client', 'GET', `/api/coaching/pairings/${ids.pairing}/messages`);
  for (const c of copies) assert.ok(conv.messages.some((m) => m.recommendation_id === c.id), 'each in the conversation');
  assert.equal((await call('coach', 'POST', recPath(), { kind: 'day_plan', dates: Array.from({ length: 32 }, (_, i) => day(i)), payload: plan })).status, 400, 'up to 31 days');

  // Answers.
  const before = (await ok('client', 'GET', '/api/coaching/state')).unread;
  received.length = 0;
  await ok('client', 'POST', `/api/coaching/recommendations/${copies[1].id}/answer`, { status: 'declined', response_note: 'Busy day' });
  assert.ok(await waitFor(() => received.some((p) => p.path === '/push-coach' && p.body === `Cleo Client declined your day plan for ${day(2)}.`)));
  assert.equal((await ok('client', 'GET', '/api/coaching/state')).unread, before - 1, 'its message is read');

  // Past its date: Expired, shown from the date; no longer waiting for an
  // answer. The server's `awaiting` leaves day plans to the device (only it
  // knows the person's date); `recommendations` counts them, so a change shows.
  const sqlite = new (serverRequire('better-sqlite3'))(join(dir, 'nt.db'));
  const st = await ok('client', 'GET', '/api/coaching/state');
  assert.equal(st.awaiting, 0, 'no requests or targets waiting; plans are counted on the device');
  assert.equal(st.recommendations, 2);
  const waitingBefore = plansWaiting(await ok('client', 'GET', '/api/coaching/recommendations'), TODAY);
  sqlite.prepare(`UPDATE coach_recommendations SET date = ? WHERE id = ?`).run(day(-3), copies[2].id);
  sqlite.close();
  assert.equal(plansWaiting(await ok('client', 'GET', '/api/coaching/recommendations'), TODAY), waitingBefore - 1, 'an expired plan stops the dot');
  const expired = (await ok('client', 'GET', '/api/coaching/recommendations')).find((r) => r.id === copies[2].id);
  assert.equal(expired.status, 'pending', 'nothing changes it on the server');
  assert.equal(shownStatus(expired, TODAY), 'expired');
  assert.equal(shownStatus({ ...expired, date: TODAY }, TODAY), 'pending', 'its own day is not past');
  ids.plan1 = copies[0].id;
  // Dates: from yesterday (today somewhere) to a year ahead.
  assert.equal((await call('coach', 'POST', recPath(), { kind: 'day_plan', date: day(-5), payload: plan })).status, 400, 'long past');
  assert.equal((await call('coach', 'POST', recPath(), { kind: 'day_plan', date: day(400), payload: plan })).status, 400, 'too far ahead');
  // One plan per date, accepted ones too: the new one replaces it.
  await ok('client', 'POST', `/api/coaching/recommendations/${copies[0].id}/answer`, { status: 'accepted' });
  const [newer] = await ok('coach', 'POST', recPath(), { kind: 'day_plan', date: day(1), payload: plan });
  const now = await ok('client', 'GET', '/api/coaching/recommendations');
  assert.equal(now.find((r) => r.id === copies[0].id).status, 'replaced');
  assert.equal(now.filter((r) => r.kind === 'day_plan' && r.date === day(1) && ['pending', 'accepted'].includes(r.status)).map((r) => r.id).join(), String(newer.id));
});

test('logging parity: a plan\'s items logged as the app logs them match the same foods added by hand, in totals, Statistics, the API, sync and meal.logged; foods the client lacks are copied once, with their source', { skip: !ready }, async () => {
  // The coach's own food (with no barcode), an Open Food Facts product, the
  // client's food and recipe.
  const coachFood = await ok('coach', 'POST', '/api/foods', { name: 'Coach Granola', brand: 'Home', portion: 60, unit: 'g', nutrition: { calories: 270, proteins: 7, carbohydrates: 38, fat: 10 } });
  const cat = await ok('coach', 'GET', `/api/coaching/clients/${ids.client}/catalog`);
  const offHit = { ...SHAKE, nutrition: { ...SHAKE.nutrition } };
  const payload = cleanPlanPayload({ meals: [
    { meal: 0, items: [planItemFrom(cat.foods.find((f) => f.name === 'Oats'), 'client_food'), { ...planItemFrom(coachFood, 'coach_food'), quantity: 1.5 }] },
    { meal: 2, items: [planItemFrom(cat.recipes[0], 'client_recipe'), planItemFrom(offHit, 'off')] },
  ] }).payload;
  const [plan] = await ok('coach', 'POST', recPath(), { kind: 'day_plan', date: TODAY, payload });
  await ok('client', 'POST', `/api/coaching/recommendations/${plan.id}/answer`, { status: 'accepted' });
  assert.deepEqual(planTotals(payload).calories, 190 + 270 * 1.5 + 420 + 120);

  received.length = 0;
  await ok('client', 'POST', '/api/admin/webhooks', { url: `http://127.0.0.1:${sink.address().port}/hook`, events: ['meal.logged'] });

  // What the app does on Log This, meal by meal (lib/coach-plan-log.js):
  // the client's own food or recipe, else a copy made in their catalog.
  const myCatalog = async () => ({ foods: await ok('client', 'GET', '/api/foods'), recipes: await ok('client', 'GET', '/api/meals?recipes=1') });
  async function logMeal(slot) {
    const meal = payload.meals.find((m) => m.meal === slot);
    const items = [];
    for (const [i, it] of meal.items.entries()) {
      let food = findOwn(it, await myCatalog());
      if (!food) food = await ok('client', 'POST', '/api/foods', foodFromPlanItem(it));
      items.push(addDiaryItem(planDiaryItem(it, food, plan.id, slot, i), slot));
    }
    const now = await ok('client', 'GET', `/api/diary/${TODAY}`);
    await saveDay(TODAY, [...now.items, ...items]);
    return items;
  }
  const planned = [...await logMeal(0), ...await logMeal(2)];
  const mine = await ok('client', 'GET', '/api/foods');
  const granola = mine.find((f) => f.name === 'Coach Granola');
  assert.equal(granola.source_app, 'coach');
  assert.equal(granola.source_external_id, `food:${coachFood.id}`, 'the copy remembers the coach\'s food');
  const shake = mine.find((f) => f.name === 'Whey Shake');
  assert.equal(shake.barcode, SHAKE.barcode, 'an Open Food Facts item becomes a food with its barcode');
  assert.equal(mine.filter((f) => f.name === 'Oats').length, 1, 'their own food is used, not copied');

  // The same foods, added by hand the Foods page's way, on another day.
  const OTHER = day(-1);
  const byHand = [
    addDiaryItem(manualItem(mine.find((f) => f.name === 'Oats')), 0),
    addDiaryItem(manualItem(granola, 1.5), 0),
    addDiaryItem(manualItem((await myCatalog()).recipes[0]), 2),
    addDiaryItem(manualItem(shake), 2),
  ];
  await saveDay(OTHER, byHand);

  // The same items, but for provenance and their own uuid and time.
  const strip = (it) => { const { uuid: _u, addedAt: _a, source: _s, ...rest } = it; return rest; };
  const dayOf = async (d) => (await ok('client', 'GET', `/api/diary/${d}`)).items;
  assert.deepEqual((await dayOf(TODAY)).map(strip), (await dayOf(OTHER)).map(strip));
  assert.deepEqual((await dayOf(TODAY)).map((i) => i.source), [0, 1, '2.0', '2.1'].map((k, n) => `coach:plan:${plan.id}:${n < 2 ? `0.${k}` : k}`));
  assert.ok((await dayOf(OTHER)).every((i) => !('source' in i)));
  // Totals: the day's, what Statistics reads (every day, summed the app's way), the API's.
  const sum = (items) => Nutrition.sum(items.map((i) => Nutrition.calculate(i)));
  assert.deepEqual(sum(await dayOf(TODAY)), sum(await dayOf(OTHER)));
  assert.equal(Math.round(sum(await dayOf(TODAY)).calories), 190 + 405 + 420 + 120);
  const all = await ok('client', 'GET', '/api/diary');
  assert.deepEqual(sum(all.find((d) => d.date === TODAY).items), sum(all.find((d) => d.date === OTHER).items));
  const { raw: token } = await ok('client', 'POST', '/api/admin/api-tokens', { name: 'reader', scopes: ['mcp:read'] });
  const t1 = await ok(token, 'GET', `/api/v1/diary/${TODAY}/totals`), t2 = await ok(token, 'GET', `/api/v1/diary/${OTHER}/totals`);
  assert.deepEqual(t1.totals, t2.totals);
  // Sync: what a phone pulls is the same.
  const pull = await ok('client', 'GET', '/api/sync/pull?since=1970-01-01');
  const pulled = (d) => JSON.parse(JSON.stringify(pull.diary.find((x) => x.date === d).items)).map(strip);
  assert.deepEqual(pulled(TODAY), pulled(OTHER));
  // meal.logged: one per save, the same items.
  assert.ok(await waitFor(() => received.filter((p) => p.path === '/hook').length >= 3));
  const hooks = received.filter((p) => p.path === '/hook').map((p) => JSON.parse(p.body)).map((h) => h.data ?? h.payload);
  const hookItems = (d) => hooks.filter((h) => h.date === d).flatMap((h) => h.items).map(strip);
  assert.equal(hookItems(TODAY).length, 4);
  assert.deepEqual(hookItems(TODAY), hookItems(OTHER));

  // The coach sees which meals were logged; deleting one brings Log This back.
  const logged = async () => (await ok('coach', 'GET', recPath())).find((r) => r.id === plan.id).logged_meals;
  assert.deepEqual(await logged(), [0, 2]);
  assert.deepEqual([...loggedMeals(await dayOf(TODAY), plan)].sort(), [0, 2], 'the client\'s card reads the same');
  // One item deleted: its meal isn't logged any more, and only it is missing.
  const shakeItem = (await dayOf(TODAY)).find((i) => i.name === 'Whey Shake');
  await saveDay(TODAY, (await dayOf(TODAY)).filter((i) => i.uuid !== shakeItem.uuid), [shakeItem.uuid]);
  assert.deepEqual(await logged(), [0]);
  assert.deepEqual([...loggedMeals(await dayOf(TODAY), plan)], [0]);
  assert.deepEqual([...loggedItems(await dayOf(TODAY), plan.id)].sort(), ['0.0', '0.1', '2.0']);
  const evening = (await dayOf(TODAY)).filter((i) => i.meal === 2).map((i) => i.uuid);
  await saveDay(TODAY, (await dayOf(TODAY)).filter((i) => i.meal !== 2), evening);

  // Logged again: the copies made before are used, never a second one.
  await logMeal(2);
  const after = await ok('client', 'GET', '/api/foods');
  assert.equal(after.filter((f) => f.name === 'Whey Shake').length, 1);
  assert.equal(after.filter((f) => f.name === 'Coach Granola').length, 1);
  // A copy the client deleted is made again the next time.
  await ok('client', 'DELETE', `/api/foods/${granola.id}`);
  const again = await ok('client', 'POST', '/api/foods', foodFromPlanItem(payload.meals[0].items[1]));
  assert.notEqual(again.id, granola.id);
  assert.equal(again.source_external_id, `food:${coachFood.id}`);
  // A phone that made its own copy meanwhile: the push finds the one here.
  const pushed = await ok('client', 'POST', '/api/sync/push', { foods: [{ client_id: 77, server_id: null, ...foodFromPlanItem(payload.meals[0].items[1]), name: 'Granola (phone)' }] });
  assert.equal(pushed.foods[0].server_id, again.id, 'the same food, not a failed push');
  assert.equal(pushed.foods[0].row.name, 'Coach Granola', 'and the server\'s copy goes back, so the phone holds the same');
  assert.equal((await ok('client', 'GET', '/api/foods')).filter((f) => f.name === 'Coach Granola').length, 1);
  // The same for a CookTrace pantry item deleted here and imported again.
  const ct = { name: 'Pantry Rice', portion: 100, unit: 'g', nutrition: { calories: 130 }, source_app: 'cooktrace', source_external_id: 'pantry-12' };
  const first = await ok('client', 'POST', '/api/foods', ct);
  await ok('client', 'DELETE', `/api/foods/${first.id}`);
  const back = await call('client', 'POST', '/api/foods', ct);
  assert.ok(back.status < 300, `imported again: ${back.status} ${JSON.stringify(back.data).slice(0, 120)}`);
  assert.notEqual(back.data.id, first.id);
});
