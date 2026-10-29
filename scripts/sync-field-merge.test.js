/**
 * Two edits of one row, on a real server (server/index.js, scratch
 * database): the newer edit of each FIELD stays, not the newer whole row.
 *
 * Before, a phone's push of a row (or the browser's offline queue, or a
 * form saved from a copy opened before) put back every field as it had
 * it: an edit made elsewhere to another field of the same row was undone,
 * or the push's own edit was dropped because the row was newer elsewhere.
 * Now each field is decided by when it was last edited (field_times, kept
 * by the server; lib/field-sync.js): the phone says which fields it
 * changed (changed_fields), and a whole row from an older app counts as
 * every field edited at its own time. Fields that belong together (a
 * food's nutrients and its serving) stay together. A delete made before a
 * later edit doesn't win; an edit made before a delete doesn't bring the
 * row back, one made after does. A day's measurements merge one by one.
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
import { buildCatalogPush, buildDiaryPush } from '../src/lib/offline-edits.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* not built for this Node */ }
const skip = t => { if (!ready) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };

const dir = ready ? mkdtempSync(join(tmpdir(), 'nt-field-merge-')) : null;
let server = null, base = null, token = null, sqlite = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = ms => new Date(ms).toISOString();
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const pull = () => api('GET', '/api/sync/pull?since=1970-01-01T00:00:00.000Z');
const push = body => api('POST', '/api/sync/push', { foods: [], meals: [], diary: [], activity: [], fasts: [], wellness: [], settings: [], workouts: [], ...body, client_now: iso(Date.now()) });
const pulled = async (kind, id) => (await pull())[kind].find(r => r.id === id);

test.before(async () => {
  if (!ready) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['index.js'], {
    cwd: join(root, 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'field-merge-test-secret-0123456789abcdef', NODE_ENV: 'test' },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch {}
    await sleep(250);
  }
  await api('POST', '/api/auth/register', { username: 'mia', password: 'Str0ng-Pass-77!x' });
  token = (await api('POST', '/api/auth/login', { username: 'mia', password: 'Str0ng-Pass-77!x' })).token;
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  sqlite = new Database(join(dir, 'server.db'));
});
test.after(() => {
  try { sqlite?.close(); } catch {}
  try { server?.kill(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// The row a phone sends (src/lib/sync.js), from the copy it pulled.
const ROW = {
  foods: f => ({ name: f.name, brand: f.brand, nutrition: f.nutrition, portion: f.portion, unit: f.unit, img_url: f.img_url, notes: f.notes, category: f.category, barcode: f.barcode, favorite: f.favorite, usage_count: f.usage_count, last_used_at: f.last_used_at, nutrition_basis: f.nutrition_basis, alt_units: f.alt_units, density_g_ml: f.density_g_ml }),
  meals: m => ({ name: m.name, nutrition: m.nutrition, items: m.items, img_url: m.img_url, notes: m.notes, is_recipe: m.is_recipe, portion: m.portion, unit: m.unit, servings: m.servings, favorite: m.favorite, usage_count: m.usage_count, last_used_at: m.last_used_at }),
  activity: a => ({ date: a.date, name: a.name, kcal: a.kcal, duration_min: a.duration_min, distance: a.distance, source: a.source, met: a.met, is_template: a.is_template }),
  fasts: f => ({ start_at: f.start_at, end_at: f.end_at, goal_hours: f.goal_hours, notes: f.notes }),
};
const phoneRow = (kind, copy, over) => ({ client_id: 1, server_id: copy.id, ...ROW[kind](copy), deleted_at: null, ...over });

// Each kind: how the web makes a row, and edits field A (`web`); the phone
// edits field B.
const KINDS = {
  foods: { make: () => api('POST', '/api/foods', { name: 'Oats', brand: 'Acme', nutrition: { calories: 380 }, portion: 100, unit: 'g' }), a: ['brand', 'Acme Co'], b: ['notes', 'soak overnight'],
    web: (row, copy, a) => api('PUT', `/api/foods/${row.id}`, { ...copy, [a[0]]: a[1] }) },
  meals: { make: () => api('POST', '/api/meals', { name: 'Porridge', nutrition: { calories: 300 }, items: [] }), a: ['name', 'Morning porridge'], b: ['notes', 'add salt'],
    web: (row, copy, a) => api('PUT', `/api/meals/${row.id}`, { ...copy, [a[0]]: a[1] }) },
  activity: { make: () => api('POST', '/api/activity', { date: '2026-10-01', name: 'Walk', kcal: 100, duration_min: 30, distance: '2 km' }), a: ['distance', '3 km'], b: ['is_template', 1],
    web: (row, copy, a) => api('PUT', `/api/activity/${row.id}`, { [a[0]]: a[1] }) },
  fasts: { make: async () => { const on = await api('GET', '/api/fasts/active').catch(() => null); if (on?.id) await api('POST', `/api/fasts/${on.id}/end`, {}); return api('POST', '/api/fasts/start', { goal_hours: 16 }); },
    a: ['notes', 'easy one'], b: ['goal_hours', 18], web: (row, copy, a) => api('PATCH', `/api/fasts/${row.id}`, { [a[0]]: a[1] }) },
};

// The web edits A; the phone's offline edit of B was made `phone` of it.
async function twoEdits(kind, { phone, says }) {
  const k = KINDS[kind];
  const row = await k.make();
  const copy = await pulled(kind, row.id);
  await sleep(1100);
  const before = Date.now() - 500;
  await sleep(1100);
  await k.web(row, copy, k.a);
  await sleep(1100);
  const at = phone === 'before' ? before : Date.now();
  const answer = await push({ [kind]: [phoneRow(kind, copy, { [k.b[0]]: k.b[1], updated_at: iso(at), ...(says ? { changed_fields: [k.b[0]] } : {}) })] });
  return { k, row, now: await pulled(kind, row.id), back: answer[kind][0].row };
}

for (const kind of Object.keys(KINDS)) {
  test(`${kind}: a phone's offline edit made before a web edit of another field goes in, and the web's stays`, async (t) => {
    if (skip(t)) return;
    const { k, now, back } = await twoEdits(kind, { phone: 'before' });
    assert.equal(String(now[k.a[0]]), String(k.a[1]), `the web's ${k.a[0]}`);
    assert.equal(String(now[k.b[0]]), String(k.b[1]), `the phone's ${k.b[0]} (dropped before: the row was newer)`);
    assert.ok(back, 'the answer hands the phone the row that stays');
    assert.equal(String(back[k.a[0]]), String(k.a[1]));
    assert.equal(back.field_times, undefined, 'the times stay on the server');
  });
  test(`${kind}: a phone's edit made after a web edit of another field, saying what it changed, leaves the web's`, async (t) => {
    if (skip(t)) return;
    const { k, now } = await twoEdits(kind, { phone: 'after', says: true });
    assert.equal(String(now[k.a[0]]), String(k.a[1]), `the web's ${k.a[0]} (put back before)`);
    assert.equal(String(now[k.b[0]]), String(k.b[1]));
  });
  test(`${kind}: a whole row from an app that can't say what it changed counts as all of it, at its own time`, async (t) => {
    if (skip(t)) return;
    const { k, now } = await twoEdits(kind, { phone: 'after' });
    assert.notEqual(String(now[k.a[0]]), String(k.a[1]), 'its copy of the other field is newer, as it always was');
    assert.equal(String(now[k.b[0]]), String(k.b[1]));
  });
}

test("a food's nutrients and serving stay together: an older serving change doesn't mix with a newer one", async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Flour', nutrition: { calories: 364 }, portion: 100, unit: 'g' });
  const copy = await pulled('foods', f.id);
  const before = Date.now();
  await sleep(1100);
  // The web: per cup now.
  await api('PUT', `/api/foods/${f.id}`, { ...copy, nutrition: { calories: 455 }, portion: 1, unit: 'cup' });
  await sleep(1100);
  // The phone, offline earlier: the portion only (100 g to 50 g).
  await push({ foods: [phoneRow('foods', copy, { portion: 50, updated_at: iso(before), changed_fields: ['portion'] })] });
  const now = await pulled('foods', f.id);
  assert.deepEqual([now.portion, now.unit, now.nutrition.calories], [1, 'cup', 455]);
});

test('a delete made before a later edit elsewhere loses, and the phone gets the row back', async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Rice', brand: 'X', nutrition: {} });
  const copy = await pulled('foods', f.id);
  const delAt = Date.now();
  await sleep(1100);
  await api('PUT', `/api/foods/${f.id}`, { ...copy, brand: 'Edited later' });
  await sleep(1100);
  const ans = await push({ foods: [phoneRow('foods', copy, { updated_at: iso(delAt), deleted_at: iso(delAt) })] });
  assert.equal((await pulled('foods', f.id)).deleted_at, null);
  assert.equal(ans.foods[0].row?.brand, 'Edited later');
  // A delete made after it goes ahead.
  await push({ foods: [phoneRow('foods', copy, { updated_at: iso(Date.now()), deleted_at: iso(Date.now()) })] });
  assert.ok((await pulled('foods', f.id)).deleted_at);
});

test('an edit made before a delete elsewhere stays deleted (the phone is told); one made after brings the row back', async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Beans', brand: 'X', nutrition: {} });
  const copy = await pulled('foods', f.id);
  const editAt = Date.now();
  await sleep(1100);
  await api('DELETE', `/api/foods/${f.id}`);
  await sleep(1100);
  const ans = await push({ foods: [phoneRow('foods', copy, { brand: 'Y', updated_at: iso(editAt), changed_fields: ['brand'] })] });
  assert.ok((await pulled('foods', f.id)).deleted_at);
  assert.ok(ans.foods[0].row?.deleted_at, 'the phone is told it was deleted');
  // Logging it on the phone (its use count) changes nothing of it: no revival.
  await push({ foods: [phoneRow('foods', copy, { usage_count: 9, updated_at: iso(Date.now()), changed_fields: [] })] });
  assert.ok((await pulled('foods', f.id)).deleted_at);
  await push({ foods: [phoneRow('foods', copy, { brand: 'Z', updated_at: iso(Date.now()), changed_fields: ['brand'] })] });
  const back = await pulled('foods', f.id);
  assert.equal(back.deleted_at, null);
  assert.equal(back.brand, 'Z');
});

for (const order of ['before', 'after']) {
  test(`a day's measurements merge one by one: weight on the phone (made ${order}), body fat on the web`, async (t) => {
    if (skip(t)) return;
    const date = order === 'before' ? '2026-09-01' : '2026-09-02';
    await api('PUT', `/api/diary/${date}`, { items: [], water: [], body_stats: { weight: 80 } });
    const copy = (await pull()).diary.find(d => d.date === date);
    await sleep(1100);
    const early = Date.now() - 500;
    await sleep(1100);
    await api('PUT', `/api/diary/${date}`, { items: [], water: [], body_stats: { ...copy.body_stats, body_fat: 20 } });
    await sleep(1100);
    await push({ diary: [{ client_id: 1, server_id: copy.id, date, items: [], water: [], body_stats: { ...copy.body_stats, weight: 79 }, deleted_uuids: { items: [], water: [] },
      updated_at: iso(order === 'before' ? early : Date.now()), deleted_at: null, body_stats_changed: ['weight'] }] });
    const now = (await pull()).diary.find(d => d.date === date);
    assert.deepEqual(now.body_stats, { weight: 79, body_fat: 20 });
    assert.equal(now.field_times, undefined);
  });
}

test("a day's measurement taken away offline before the web set it again stays; an empty push changes nothing (#81)", async (t) => {
  if (skip(t)) return;
  const date = '2026-09-04';
  await api('PUT', `/api/diary/${date}`, { items: [], water: [], body_stats: { weight: 80, waist: 90 } });
  const copy = (await pull()).diary.find(d => d.date === date);
  const early = Date.now();
  await sleep(1100);
  await api('PUT', `/api/diary/${date}`, { items: [], water: [], body_stats: { weight: 80, waist: 88 } });
  await sleep(1100);
  // Whole object without waist (an older app), made before the web's.
  await push({ diary: [{ client_id: 1, server_id: copy.id, date, items: [], water: [], body_stats: { weight: 80 }, deleted_uuids: { items: [], water: [] }, updated_at: iso(early), deleted_at: null }] });
  assert.deepEqual((await pull()).diary.find(d => d.date === date).body_stats, { weight: 80, waist: 88 });
  await push({ diary: [{ client_id: 1, server_id: copy.id, date, items: [], water: [], body_stats: {}, deleted_uuids: { items: [], water: [] }, updated_at: iso(Date.now()), deleted_at: null }] });
  assert.deepEqual((await pull()).diary.find(d => d.date === date).body_stats, { weight: 80, waist: 88 });
  // Taken away now, saying so: gone.
  await push({ diary: [{ client_id: 1, server_id: copy.id, date, items: [], water: [], body_stats: { weight: 80 }, deleted_uuids: { items: [], water: [] }, updated_at: iso(Date.now()), deleted_at: null, body_stats_changed: ['waist'] }] });
  assert.deepEqual((await pull()).diary.find(d => d.date === date).body_stats, { weight: 80 });
});

test("logging a food after a phone's offline weight doesn't make the weight older than the day", async (t) => {
  if (skip(t)) return;
  const date = '2026-09-05';
  const early = Date.now();
  await sleep(1100);
  // The web makes the day by logging breakfast; the phone's weight came first.
  await api('PUT', `/api/diary/${date}`, { items: [{ uuid: 'b1', name: 'Toast', nutrition: {}, portion: 30, unit: 'g', quantity: 1, meal: 0 }], water: [], body_stats: {} });
  await sleep(1100);
  await push({ diary: [{ client_id: 1, server_id: null, date, items: [], water: [], body_stats: { weight: 75 }, deleted_uuids: { items: [], water: [] }, updated_at: iso(early), deleted_at: null, body_stats_changed: ['weight'] }] });
  const now = (await pull()).diary.find(d => d.date === date);
  assert.deepEqual(now.body_stats, { weight: 75 });
  assert.equal(now.items.length, 1);
});

test('a setting: an older change made offline no longer replaces a newer one, and the phone gets the newer back', async (t) => {
  if (skip(t)) return;
  const at = Date.now();
  await sleep(1100);
  await api('PUT', '/api/settings', { key: 'units', value: 'imperial' });
  const cursor = new Date().toISOString();
  await sleep(1100);
  await push({ settings: [{ key: 'units', value: 'metric', updated_at: iso(at) }] });
  const later = await api('GET', `/api/sync/pull?since=${cursor}`);
  assert.equal(JSON.parse(later.settings.find(s => s.key === 'units').value), 'imperial', 'in the next pull');
  await push({ settings: [{ key: 'units', value: 'metric', updated_at: iso(Date.now()) }] });
  assert.equal(JSON.parse((await pull()).settings.find(s => s.key === 'units').value), 'metric');
});

test("the browser's offline queue (its own code) sends its edit's time and fields, not the copy's", async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Tofu', brand: 'Plain', nutrition: { calories: 80 }, portion: 100, unit: 'g' });
  const shown = await api('GET', `/api/foods/${f.id}`);
  await sleep(1100);
  const phoneCopy = await pulled('foods', f.id);
  await push({ foods: [phoneRow('foods', phoneCopy, { brand: 'Firm', updated_at: iso(Date.now()), changed_fields: ['brand'] })] });
  await sleep(1100);
  // Queued after the phone's push (offline), on the copy shown before it.
  const ops = [{ seq: 1, type: 'catalog', v: 2, table: 'foods', action: 'update', id: f.id, data: { ...shown, notes: 'press first' }, at: Date.now(), changed: ['notes'] }];
  const body = buildCatalogPush(ops);
  assert.notEqual(body.foods[0].updated_at, shown.updated_at);
  await push(body);
  const now = await pulled('foods', f.id);
  assert.deepEqual([now.brand, now.notes], ['Firm', 'press first']);
});

test("the browser's offline day sends only the measurements it changed", async (t) => {
  if (skip(t)) return;
  const date = '2026-09-03';
  await api('PUT', `/api/diary/${date}`, { items: [], water: [], body_stats: { weight: 70 } });
  const shown = (await pull()).diary.find(d => d.date === date);
  const queuedAt = Date.now();
  await sleep(1100);
  await push({ diary: [{ client_id: 1, server_id: shown.id, date, items: [], water: [], body_stats: { ...shown.body_stats, waist: 80 }, deleted_uuids: { items: [], water: [] }, updated_at: iso(Date.now()), deleted_at: null, body_stats_changed: ['waist'] }] });
  await sleep(1100);
  const ops = [{ seq: 1, type: 'diary', date, day: { items: [], water: [], body_stats: { ...shown.body_stats, weight: 69 } }, at: queuedAt, note_at: null, stats_changed: ['weight'] }];
  await push(buildDiaryPush(ops, [shown]));
  assert.deepEqual((await pull()).diary.find(d => d.date === date).body_stats, { weight: 69, waist: 80 });
});

test("a form opened before the phone's edit, saved saying what it changed, leaves the phone's edit", async (t) => {
  if (skip(t)) return;
  for (const [kind, path, field] of [['foods', '/api/foods', 'brand'], ['meals', '/api/meals', 'name']]) {
    const row = await api('POST', path, kind === 'foods' ? { name: 'Milk', brand: 'Farm', nutrition: {} } : { name: 'Stew', nutrition: {}, items: [] });
    const form = await api('GET', `${path}/${row.id}`);
    await sleep(1100);
    const phoneCopy = await pulled(kind, row.id);
    await push({ [kind]: [phoneRow(kind, phoneCopy, { [field]: 'From the phone', updated_at: iso(Date.now()), changed_fields: [field] })] });
    await sleep(1100);
    await api('PUT', `${path}/${row.id}`, { ...form, notes: 'from the form', changed_fields: ['notes'] });
    const now = await pulled(kind, row.id);
    assert.deepEqual([now[field], now.notes], ['From the phone', 'from the form'], kind);
    // Without changed_fields (an older page), the whole form goes in, as before.
    await api('PUT', `${path}/${row.id}`, { ...form, notes: 'again' });
    assert.equal((await pulled(kind, row.id))[field], form[field], kind);
  }
});

test('a row from before the times counts from its last write', async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Legacy', brand: 'Old', nutrition: {} });
  // As a server from before left it: no times, its last write an hour ago.
  sqlite.prepare(`UPDATE foods SET field_times = NULL, created_at = datetime('now', '-3 hours'), updated_at = datetime('now', '-1 hour'), changed_at = '2000-01-01 00:00:00' WHERE id = ?`).run(f.id);
  const copy = await pulled('foods', f.id);
  // An edit made two hours ago, offline: older than the row's last write.
  await push({ foods: [phoneRow('foods', copy, { brand: 'Two hours ago', updated_at: iso(Date.now() - 2 * 3600_000), changed_fields: ['brand'] })] });
  assert.equal((await pulled('foods', f.id)).brand, 'Old', 'older than the whole row: as before');
  await push({ foods: [phoneRow('foods', copy, { brand: 'Now', updated_at: iso(Date.now()), changed_fields: ['brand'] })] });
  assert.equal((await pulled('foods', f.id)).brand, 'Now');
});

test('the pull never sends field_times, and pushing them changes nothing', async (t) => {
  if (skip(t)) return;
  const all = await pull();
  for (const k of ['foods', 'meals', 'diary', 'activity', 'fasts', 'settings']) for (const r of all[k]) assert.equal(r.field_times, undefined, k);
  const f = await api('POST', '/api/foods', { name: 'Sly', nutrition: {} });
  const copy = await pulled('foods', f.id);
  await push({ foods: [phoneRow('foods', copy, { field_times: '{"name":"2999-01-01T00:00:00Z"}', updated_at: iso(Date.now()) })] });
  const t1 = JSON.parse(sqlite.prepare('SELECT field_times FROM foods WHERE id = ?').get(f.id).field_times);
  assert.ok(!String(t1.name || '').startsWith('2999'));
});

test("a field changed offline before a later change of another keeps its own time (field_edits)", async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Granola', brand: 'Acme', nutrition: {} });
  const copy = await pulled('foods', f.id);
  await sleep(1100);
  const renamedHere = Date.now();
  await sleep(1100);
  await api('PUT', `/api/foods/${f.id}`, { ...copy, name: 'Granola (web)', changed_fields: ['name'] });
  await sleep(1100);
  // The phone renamed it first, then changed the notes after the web's rename.
  const notedHere = Date.now();
  await push({ foods: [phoneRow('foods', copy, { name: 'Granola (phone)', notes: 'crunchy', updated_at: iso(notedHere),
    changed_fields: ['name', 'notes'], field_edits: { name: iso(renamedHere), notes: iso(notedHere) } })] });
  const now = await pulled('foods', f.id);
  assert.deepEqual([now.name, now.notes], ['Granola (web)', 'crunchy']);
  // A day's measurement too (body_stats_edits).
  const date = '2026-09-06';
  await api('PUT', `/api/diary/${date}`, { items: [], water: [], body_stats: { weight: 80 } });
  const day = (await pull()).diary.find(d => d.date === date);
  await sleep(1100);
  const weighedHere = Date.now();
  await sleep(1100);
  await api('PUT', `/api/diary/${date}`, { items: [], water: [], body_stats: { weight: 81 }, body_stats_changed: ['weight'] });
  await sleep(1100);
  await push({ diary: [{ client_id: 1, server_id: day.id, date, items: [], water: [], body_stats: { weight: 79, waist: 70 }, deleted_uuids: { items: [], water: [] },
    updated_at: iso(Date.now()), deleted_at: null, body_stats_changed: ['weight', 'waist'], body_stats_edits: { weight: iso(weighedHere), waist: iso(Date.now()) } }] });
  assert.deepEqual((await pull()).diary.find(d => d.date === date).body_stats, { weight: 81, waist: 70 });
});

test('a day saved without saying which measurements it changed, with none of its own, still goes in whole on a new day', async (t) => {
  if (skip(t)) return;
  // A phone that lists none changed (it had them all from a server that
  // since lost the day): a new day here takes everything it sends.
  const date = '2026-09-07';
  await push({ diary: [{ client_id: 1, server_id: null, date, items: [], water: [], body_stats: { weight: 77 }, deleted_uuids: { items: [], water: [] }, updated_at: iso(Date.now()), deleted_at: null, body_stats_changed: [] }] });
  assert.deepEqual((await pull()).diary.find(d => d.date === date).body_stats, { weight: 77 });
});

// The browser's queue with an edit queued before the app said what an edit
// changed (no list: every field it sends, at its own time) and one queued
// after (a list). Collapsed, the row went up whole at the later edit's
// time, so the earlier edit's copy put back a change made elsewhere in
// between. Now each field goes with the time of the edit that changed it.
test("the browser's queue mixing an edit from before the update with one from after keeps each edit's time", async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Mix Oats', brand: 'Mill', nutrition: { calories: 380 }, portion: 100, unit: 'g' });
  const copy = await pulled('foods', f.id);
  await sleep(1100);
  // Queued by the app before (no v, no list): the notes, on its copy.
  const old = { seq: 1, type: 'catalog', table: 'foods', action: 'update', id: f.id, data: { ...copy, notes: 'soak' }, at: Date.now() };
  await sleep(2100);
  // The web changes the brand.
  await api('PUT', `/api/foods/${f.id}`, { ...copy, brand: 'Bakery', changed_fields: ['brand'] });
  await sleep(2100);
  // Queued after the update: the name.
  const now = { seq: 2, type: 'catalog', v: 2, table: 'foods', action: 'update', id: f.id, data: { ...copy, notes: 'soak', name: 'Mix Rolled Oats' }, at: Date.now(), changed: ['name'] };
  const body = buildCatalogPush([old, now]);
  await push({ foods: body.foods });
  const got = await pulled('foods', f.id);
  assert.deepEqual({ name: got.name, brand: got.brand, notes: got.notes }, { name: 'Mix Rolled Oats', brand: 'Bakery', notes: 'soak' });
});

test("the browser's offline day mixing a save from before the update with one from after keeps each measurement's time", async (t) => {
  if (skip(t)) return;
  const D = '2026-09-11';
  await api('PUT', `/api/diary/${D}`, { items: [], body_stats: { weight: 80, waist: 90 }, water: [] });
  await sleep(1100);
  const day = s => ({ items: [], water: [], body_stats: s });
  const old = { seq: 1, type: 'diary', date: D, day: day({ weight: 79, waist: 90 }), at: Date.now() };
  await sleep(2100);
  await api('PUT', `/api/diary/${D}`, { items: [], body_stats: { weight: 80, waist: 88 }, water: [], body_stats_changed: ['waist'] });
  await sleep(2100);
  const now = { seq: 2, type: 'diary', date: D, day: day({ weight: 79, waist: 90, body_fat: 20 }), at: Date.now(), stats_changed: ['body_fat'] };
  await push({ diary: buildDiaryPush([old, now], []).diary });
  const got = await api('GET', `/api/diary/${D}`);
  assert.deepEqual(got.body_stats, { weight: 79, waist: 88, body_fat: 20 });
});

test("the browser's mixed offline day leaves a measurement added elsewhere since the older save", async (t) => {
  if (skip(t)) return;
  const D = '2026-09-21';
  await api('PUT', `/api/diary/${D}`, { items: [], body_stats: { weight: 80 }, water: [] });
  await sleep(1100);
  const day = s => ({ items: [], water: [], body_stats: s });
  const old = { seq: 1, type: 'diary', date: D, day: day({ weight: 79 }), at: Date.now() };
  await sleep(2100);
  await api('PUT', `/api/diary/${D}`, { items: [], body_stats: { weight: 80, waist: 88 }, water: [], body_stats_changed: ['waist'] });
  await sleep(2100);
  const now = { seq: 2, type: 'diary', date: D, day: day({ weight: 79, body_fat: 20 }), at: Date.now(), stats_changed: ['body_fat'] };
  await push({ diary: buildDiaryPush([old, now], []).diary });
  const got = await api('GET', `/api/diary/${D}`);
  assert.deepEqual(got.body_stats, { weight: 79, waist: 88, body_fat: 20 });
});

// Logging a food from before the times bumps how often it was used, which
// moves its updated_at: that stood in for when every field was last edited,
// so an edit made offline before the bump but after the row's last real
// edit lost every field. A bump isn't an edit: the row's times start from
// its last write before it.
for (const kind of ['foods', 'meals']) {
  test(`a ${kind === 'foods' ? 'food' : 'meal'} from before the times, used after an offline edit was made, still takes that edit`, async (t) => {
    if (skip(t)) return;
    const row = kind === 'foods'
      ? await api('POST', '/api/foods', { name: 'Bumped', brand: 'Old', nutrition: {} })
      : await api('POST', '/api/meals', { name: 'Bumped meal', nutrition: {}, items: [] });
    sqlite.prepare(`UPDATE ${kind} SET field_times = NULL, created_at = datetime('now', '-3 hours'), updated_at = datetime('now', '-2 hours') WHERE id = ?`).run(row.id);
    const copy = await pulled(kind, row.id);
    const offlineAt = Date.now() - 3600_000;
    await api('POST', `/api/${kind}/${row.id}/used`, { date: '2026-10-01' });
    await push({ [kind]: [phoneRow(kind, copy, { notes: 'made an hour ago', updated_at: iso(offlineAt), changed_fields: ['notes'] })] });
    assert.equal((await pulled(kind, row.id)).notes, 'made an hour ago');
  });
}

test('logging a food from before the times through MCP is not an edit of it either', async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Mcp Bumped', brand: 'Old', nutrition: {} });
  sqlite.prepare(`UPDATE foods SET field_times = NULL, updated_at = datetime('now', '-2 hours') WHERE id = ?`).run(f.id);
  const before = sqlite.prepare('SELECT updated_at FROM foods WHERE id = ?').get(f.id).updated_at;
  // As log-food.js bumps it.
  sqlite.prepare(`UPDATE foods SET usage_count = usage_count + 1, last_used_at = MAX(COALESCE(last_used_at, ''), ?), updated_at = datetime('now') WHERE id = ?`).run('2026-10-01', f.id);
  const times = JSON.parse(sqlite.prepare('SELECT field_times FROM foods WHERE id = ?').get(f.id).field_times || '{}');
  assert.equal(Date.parse(times._base.replace(' ', 'T') + (times._base.endsWith('Z') ? '' : 'Z')), Date.parse(before.replace(' ', 'T') + 'Z'));
});

// A full backup holds when each field last changed (field_times); restoring
// it dropped them, so every field of a restored row counted as changed at
// the row's last write, and an offline edit made before that write, of a
// field changed long before, was lost.
test('a restored backup keeps when each field last changed', async (t) => {
  if (skip(t)) return;
  const f = await api('POST', '/api/foods', { name: 'Restored Oats', brand: 'Mill', nutrition: {} });
  const D = '2026-09-12';
  await api('PUT', `/api/diary/${D}`, { items: [], body_stats: { weight: 80, waist: 90 }, water: [] });
  const copy = await pulled('foods', f.id);
  await sleep(1100);
  const offlineAt = Date.now();
  await sleep(2100);
  await api('PUT', `/api/foods/${f.id}`, { ...copy, brand: 'Bakery', changed_fields: ['brand'] });
  await api('PUT', `/api/diary/${D}`, { items: [], body_stats: { weight: 80, waist: 88 }, water: [], body_stats_changed: ['waist'] });
  const timesBefore = sqlite.prepare('SELECT field_times FROM foods WHERE id = ?').get(f.id).field_times;
  const made = await api('POST', '/api/full-backup');
  await api('POST', `/api/full-backup/${encodeURIComponent(made.filename)}/restore`);
  assert.equal(sqlite.prepare('SELECT field_times FROM foods WHERE id = ?').get(f.id).field_times, timesBefore);
  // Made offline after the food and the day were made, before the web's change.
  await push({ foods: [phoneRow('foods', copy, { notes: 'offline note', updated_at: iso(offlineAt), changed_fields: ['notes'] })] });
  await push({ diary: [{ client_id: 1, date: D, items: [], water: [], body_stats: { weight: 79, waist: 90 }, body_stats_changed: ['weight'], updated_at: iso(offlineAt), deleted_at: null }] });
  const got = await pulled('foods', f.id);
  assert.deepEqual({ brand: got.brand, notes: got.notes }, { brand: 'Bakery', notes: 'offline note' });
  assert.deepEqual((await api('GET', `/api/diary/${D}`)).body_stats, { weight: 79, waist: 88 });
});
