/**
 * Sharing as it behaves today, against the real server: Bulk Share, the
 * From Others lists and counts, one item's share, and copying a shared item.
 * Written for 1.5 coaching (the editors gained a Share button and coaches can
 * Send to Client), and run unchanged on the code from before those, so both
 * give the same answers. Each answer is reduced to what a person sees (names,
 * who shared, counts), not ids or times.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
const JWT_SECRET = 'sharing-baseline-test-0123456789abcdef01';
let proc, base, dir;
const tok = {}, ids = {};

async function call(who, method, path, body) {
  const h = { 'Content-Type': 'application/json' };
  if (who) h.Authorization = `Bearer ${tok[who]}`;
  const r = await fetch(base + path, { method, headers: h, body: body == null || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
// Every answer seen, in order: SHARING_SNAPSHOT=<file> writes them out, to
// compare a run on the old code with one on the new.
const seenAll = [];
const names = (rows) => (rows || []).map((r) => `${r.name}${r._shared_by ? ` (${r._shared_by})` : ''}`).sort();
const counts = (s) => ({ on: s.sharing_enabled, foods: s.foods, meals: s.meals, recipes: s.recipes });
const others = async (who) => { const r = {
  foods: names(await ok(who, 'GET', '/api/foods?group=1')),
  meals: names(await ok(who, 'GET', '/api/meals?group=1')),
  recipes: names(await ok(who, 'GET', '/api/meals?recipes=1&group=1')),
  counts: counts(await ok(who, 'GET', '/api/app-config/sharing')),
}; seenAll.push(['others', who, r]); return r; };
const mine = async (who) => { const r = {
  foods: names(await ok(who, 'GET', '/api/foods')),
  meals: names(await ok(who, 'GET', '/api/meals')),
  recipes: names(await ok(who, 'GET', '/api/meals?recipes=1')),
}; seenAll.push(['mine', who, r]); return r; };

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'nt-sharing-baseline-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up */ } await sleep(100); }
  await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: PW, full_name: 'Ada Admin' }) });
  tok.ada = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: PW }) })).json()).token;
  const jwt = serverRequire('jsonwebtoken');
  for (const [name, full] of [['ben', 'Ben B'], ['cy', 'Cy C']]) {
    const { user } = await ok('ada', 'POST', '/api/auth/register', { username: name, password: PW, full_name: full, role: 'user' });
    tok[name] = jwt.sign({ id: user.id, username: name, role: 'user', csrf: 'x' }, JWT_SECRET, { expiresIn: '1h' });
    ids[name] = user.id;
  }
});
test.after(() => {
  proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true });
  if (process.env.SHARING_SNAPSHOT) writeFileSync(process.env.SHARING_SNAPSHOT, JSON.stringify(seenAll, null, 1));
});

test('sharing off: nothing from others, and sharing calls are refused', { skip: !ready }, async () => {
  await ok('ada', 'POST', '/api/foods', { name: 'Ada Oats', portion: 50, unit: 'g', nutrition: { calories: 190 } });
  await ok('ada', 'POST', '/api/meals', { name: 'Ada Breakfast', items: [], nutrition: { calories: 400 } });
  await ok('ada', 'POST', '/api/meals', { name: 'Ada Stew', is_recipe: true, items: [], nutrition: { calories: 420 }, portion: 350, unit: 'g' });
  assert.deepEqual(await others('ben'), { foods: [], meals: [], recipes: [], counts: { on: false, foods: 0, meals: 0, recipes: 0 } });
  assert.equal((await call('ada', 'POST', '/api/foods/bulk-share', { visibility: 'group', targets: ['foods'] })).status, 403);
  const food = (await ok('ada', 'GET', '/api/foods'))[0];
  assert.equal((await call('ada', 'PATCH', `/api/foods/${food.id}/share`, { visibility: 'group' })).status, 403);
  assert.equal((await call('ben', 'POST', `/api/foods/${food.id}/copy`)).status, 403);
});

test('Bulk Share per category, From Others lists and counts, one item\'s share, copying', { skip: !ready }, async () => {
  await ok('ada', 'PUT', '/api/app-config', { key: 'sharing_enabled', value: 'true' });
  await ok('ada', 'POST', '/api/foods', { name: 'Ada Rice', portion: 100, unit: 'g', nutrition: { calories: 130 } });
  await ok('cy', 'POST', '/api/foods', { name: 'Cy Bar', portion: 40, unit: 'g', nutrition: { calories: 180 } });
  // Bulk Share: foods to everyone, meals to Ben only, recipes private.
  await ok('ada', 'POST', '/api/foods/bulk-share', { visibility: 'group', targets: ['foods'], user_ids: [] });
  await ok('ada', 'POST', '/api/foods/bulk-share', { visibility: 'specific', targets: ['meals'], user_ids: [ids.ben] });
  await ok('ada', 'POST', '/api/foods/bulk-share', { visibility: 'private', targets: ['recipes'], user_ids: [] });
  assert.deepEqual(await others('ben'), {
    foods: ['Ada Oats (Ada Admin)', 'Ada Rice (Ada Admin)'], meals: ['Ada Breakfast (Ada Admin)'], recipes: [],
    counts: { on: true, foods: 2, meals: 1, recipes: 0 },
  });
  assert.deepEqual(await others('cy'), {
    foods: ['Ada Oats (Ada Admin)', 'Ada Rice (Ada Admin)'], meals: [], recipes: [],
    counts: { on: true, foods: 2, meals: 0, recipes: 0 },
  });
  await others('ada'); // an admin's view, as it is (compared old and new)
  // Own lists hold only one's own, whatever is shared.
  assert.deepEqual(await mine('ben'), { foods: [], meals: [], recipes: [] });
  // One item: the recipe to Cy only; its owner sees who.
  const stew = (await ok('ada', 'GET', '/api/meals?recipes=1')).find((m) => m.name === 'Ada Stew');
  await ok('ada', 'PATCH', `/api/meals/${stew.id}/share`, { visibility: 'specific', user_ids: [ids.cy] });
  const seen = await ok('ada', 'GET', `/api/meals/${stew.id}`);
  assert.equal(seen.visibility, 'specific');
  assert.deepEqual(seen._specific_users, [ids.cy]);
  assert.deepEqual((await others('cy')).recipes, ['Ada Stew (Ada Admin)']);
  assert.deepEqual((await others('ben')).recipes, []);
  assert.equal((await call('ben', 'GET', `/api/meals/${stew.id}`)).status, 403, 'not shared with Ben');
  assert.equal((await call('ben', 'PATCH', `/api/meals/${stew.id}/share`, { visibility: 'group' })).status, 403, 'only its owner shares it');
  // Copying: Cy saves the recipe; a second copy is the same one.
  const copy = await ok('cy', 'POST', `/api/meals/${stew.id}/copy`);
  assert.equal(copy.source_id, stew.id);
  assert.equal(copy.visibility, 'private');
  assert.equal((await ok('cy', 'POST', `/api/meals/${stew.id}/copy`)).id, copy.id);
  assert.deepEqual((await mine('cy')).recipes, ['Ada Stew']);
  const rice = (await ok('ada', 'GET', '/api/foods')).find((f) => f.name === 'Ada Rice');
  const riceCopy = await ok('ben', 'POST', `/api/foods/${rice.id}/copy`);
  assert.equal(riceCopy.source_id, rice.id);
  assert.equal((await call('ada', 'POST', `/api/foods/${rice.id}/copy`)).status, 400, 'already yours');
  // Back to private: gone from From Others.
  await ok('ada', 'POST', '/api/foods/bulk-share', { visibility: 'private', targets: ['foods', 'meals'], user_ids: [] });
  assert.deepEqual((await others('ben')).foods, []);
  assert.deepEqual((await others('ben')).meals, []);
  assert.deepEqual((await others('cy')).recipes, ['Ada Stew (Ada Admin)'], 'the recipe shared one by one stays');
  // Sharing switched off again: nothing from others (the From Others list
  // answers with one's own items then, and the app doesn't ask for it).
  await ok('ada', 'PUT', '/api/app-config', { key: 'sharing_enabled', value: 'false' });
  assert.deepEqual(await others('cy'), { foods: ['Cy Bar'], meals: [], recipes: ['Ada Stew'], counts: { on: false, foods: 0, meals: 0, recipes: 0 } });
});
