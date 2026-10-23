/**
 * Coaching, phase 5 (Send to Client), against the real server with sharing
 * off: a coach sends one of their own meals or recipes; it travels as a copy
 * (later edits of the coach's never reach it); on Accept the client gets
 * their own, with its source, and each ingredient's food copied into their
 * foods (or their own with the same barcode, or the copy a day plan made),
 * once. Decline makes nothing; an answer sent offline (sync push) makes the
 * copy too, and the next pull brings it; backup and account deletion.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createServer as netServer } from 'node:net';
import http from 'node:http';
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
const JWT_SECRET = 'coaching-send-test-0123456789abcdef01234';
let proc, base, dir, sink;
const tok = {}, ids = {};
const received = [];

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
const recPath = () => `/api/coaching/clients/${ids.client}/recommendations`;

test.before(async () => {
  if (!ready) return;
  sink = await new Promise((res) => {
    const s = http.createServer((req, resp) => {
      // Stand-ins for images a meal links to elsewhere.
      if (req.url === '/pic.png') { resp.writeHead(200, { 'Content-Type': 'image/png' }); return resp.end(PNG); }
      if (req.url === '/page.png') { resp.writeHead(200, { 'Content-Type': 'image/png' }); return resp.end('<html>' + 'x'.repeat(400) + '</html>'); }
      if (req.url === '/gone.png') { resp.writeHead(404); return resp.end(); }
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ path: req.url, body: b }); resp.end('{}'); });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  dir = mkdtempSync(join(tmpdir(), 'nt-coach-send-'));
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
});
test.after(() => { try { _db?.close(); } catch {} proc?.kill(); sink?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// A real 32 x 32 PNG (the download keeps only images, over 100 bytes).
const PNG = (() => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(32 * (1 + 32 * 3)); for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) raw.set([x * 8, y * 8, 120], y * 97 + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();
let _db = null;
const serverDb = () => (_db ||= new (serverRequire('better-sqlite3'))(join(dir, 'nt.db')));
const recipeOf = (who) => ok(who, 'GET', '/api/meals?recipes=1');

test('a coach sends their own recipe or meal, with sharing off; only their own, of the kind it is', { skip: !ready }, async () => {
  assert.equal((await ok('client', 'GET', '/api/app-config/sharing')).sharing_enabled, false, 'sharing is off');
  const oats = await ok('coach', 'POST', '/api/foods', { name: 'Coach Oats', portion: 50, unit: 'g', nutrition: { calories: 190, proteins: 6.5 }, notes: 'buy at the market on Fridays' });
  // A food of the client's own, in the coach's meal (shared with the coach once).
  const honey = await ok('client', 'POST', '/api/foods', { name: 'Cleo Honey', portion: 20, unit: 'g', nutrition: { calories: 60 } });
  ids.honey = honey.id;
  const skyr = await ok('coach', 'POST', '/api/foods', { name: 'Skyr', portion: 150, unit: 'g', nutrition: { calories: 95, proteins: 16 }, barcode: '5701234567893' });
  // The client already has the same Skyr (same barcode).
  ids.clientSkyr = (await ok('client', 'POST', '/api/foods', { name: 'My Skyr', portion: 150, unit: 'g', nutrition: { calories: 95 }, barcode: '5701234567893' })).id;
  const bowl = await ok('coach', 'POST', '/api/meals', { name: 'Protein Bowl', is_recipe: true, portion: 300, unit: 'g', servings: 2, nutrition: { calories: 285, proteins: 22.5 },
    items: [{ ...oats, quantity: 1, visibility: 'private', user_id: ids.coach }, { ...skyr, quantity: 1 }], notes: 'Mix the night before', img_url: '/uploads/bowl.jpg' });
  const breakfast = await ok('coach', 'POST', '/api/meals', { name: 'Quick Breakfast', items: [{ ...oats, quantity: 2 }, { ...honey, quantity: 1 }], nutrition: { calories: 440 } });
  const theirs = await ok('coach2', 'POST', '/api/meals', { name: 'Not Mine', is_recipe: true, items: [], nutrition: {} });
  Object.assign(ids, { oats: oats.id, skyr: skyr.id, bowl: bowl.id, breakfast: breakfast.id });

  const notMine = await call('coach', 'POST', recPath(), { kind: 'recipe', meal_id: theirs.id });
  assert.equal(notMine.status, 404, 'another coach\'s');
  assert.equal(notMine.data.code, 'own_meal_only', 'named by a code, for the app to say in the person\'s language');
  const again = await call('coach', 'POST', '/api/coaching/requests', { client_id: ids.client });
  assert.deepEqual([again.status, again.data.code, again.data.params], [409, 'already_client', { name: 'Cleo Client' }]);
  // Its kind is the saved one's, whatever the editor said.
  const asMeal = await ok('coach', 'POST', recPath(), { kind: 'meal', meal_id: bowl.id });
  assert.equal(asMeal.kind, 'recipe');
  await ok('client', 'POST', `/api/coaching/recommendations/${asMeal.id}/answer`, { status: 'declined' });
  assert.equal((await call('other', 'POST', recPath(), { kind: 'recipe', meal_id: bowl.id })).status >= 400, true, 'not their coach');
  received.length = 0;
  const sent = await ok('coach', 'POST', recPath(), { kind: 'recipe', meal_id: bowl.id, note: 'Try this' });
  assert.equal(sent.kind, 'recipe');
  assert.equal(sent.status, 'pending');
  const m = sent.payload.meal;
  assert.deepEqual([m.name, m.portion, m.unit, m.servings, m.notes, m.img_url], ['Protein Bowl', 300, 'g', 2, 'Mix the night before', '/uploads/bowl.jpg']);
  assert.deepEqual(m.items.map((i) => [i.name, i.quantity, i.source?.id]), [['Coach Oats', 1, oats.id], ['Skyr', 1, skyr.id]]);
  assert.ok(!('user_id' in m.items[0]) && !('visibility' in m.items[0]), 'what each is, never whose');
  assert.ok(!('notes' in m.items[0]), 'never the coach\'s own notes on their food');
  assert.ok(await waitFor(() => received.some((p) => p.path === '/push-client' && p.body === 'Sam Coach sent you a recommendation.')));
  const conv = await ok('client', 'GET', `/api/coaching/pairings/${ids.pairing}/messages`);
  assert.ok(conv.messages.some((x) => x.recommendation_id === sent.id), 'in the conversation');
  ids.sent = sent.id;
  // Later edits of the coach's never reach what was sent.
  await ok('coach', 'PUT', `/api/meals/${bowl.id}`, { name: 'Protein Bowl v2', items: [], nutrition: {}, is_recipe: true });
  assert.equal((await ok('client', 'GET', '/api/coaching/recommendations')).find((r) => r.id === sent.id).payload.meal.name, 'Protein Bowl');
});

test('a meal\'s picture from elsewhere goes with it, downloaded the safe way: an image, or nothing', { skip: !ready }, async () => {
  const at = `http://127.0.0.1:${sink.address().port}`;
  const send = async (name, img_url, source_app = null) => {
    const meal = await ok('coach', 'POST', '/api/meals', { name, is_recipe: true, portion: 200, unit: 'g', nutrition: { calories: 300 }, items: [] });
    // As an import keeps it: a link, not an upload.
    serverDb().prepare('UPDATE meals SET img_url = ?, source_app = ? WHERE id = ?').run(img_url, source_app, meal.id);
    return { meal, img: (await ok('coach', 'POST', recPath(), { kind: 'recipe', meal_id: meal.id })).payload.meal.img_url };
  };
  // A private address, for a coach who isn't an admin, with no opt-in: never fetched.
  assert.equal((await send('Private Picture', `${at}/pic.png`)).img, null, 'the address checks refuse it');
  // From the coach's own CookTrace (saved in Settings): their home network is trusted.
  await ok('coach', 'PUT', '/api/settings', { key: 'cooktraceBaseUrl', value: at });
  const sent = await send('Pictured Bowl', `${at}/pic.png`, 'cooktrace');
  assert.match(sent.img, /^\/uploads\/[\w.-]+\.png$/, 'downloaded into this server\'s uploads');
  assert.deepEqual(readFileSync(join(dir, 'uploads', sent.img.slice('/uploads/'.length))), PNG);
  assert.equal(serverDb().prepare('SELECT img_url FROM meals WHERE id = ?').get(sent.meal.id).img_url, sent.img, 'the coach\'s meal keeps it, as a save would');
  assert.equal((await send('Not a Picture', `${at}/page.png`, 'cooktrace')).img, null, 'not an image: nothing');
  assert.equal((await send('Gone Picture', `${at}/gone.png`, 'cooktrace')).img, null, 'not there: nothing');
  assert.equal((await send('Odd Source', `${at}/pic.png`, 'constructor')).img, null, 'an odd source name is just no trusted origin');
  assert.equal((await send('Odd Link', 'javascript:alert(1)')).img, null);
});

test('Accept: the client\'s own copy, with its source and its ingredients\' foods, once; Decline makes nothing', { skip: !ready }, async () => {
  received.length = 0;
  await ok('client', 'POST', `/api/coaching/recommendations/${ids.sent}/answer`, { status: 'accepted' });
  assert.ok(await waitFor(() => received.some((p) => p.path === '/push-coach' && p.body === 'Cleo Client accepted your recipe, Protein Bowl.')));
  const copies = (await recipeOf('client')).filter((r) => r.name === 'Protein Bowl');
  assert.equal(copies.length, 1);
  const c = copies[0];
  assert.deepEqual([c.source_app, c.source_external_id, c.source_id ?? null, c.visibility, c.portion, c.servings, c.notes, c.img_url],
    ['coach', `meal:${ids.bowl}:${ids.sent}`, null, 'private', 300, 2, 'Mix the night before', '/uploads/bowl.jpg'], 'remembers it came from the coach\'s recipe');
  ids.copy = c.id;
  const foods = await ok('client', 'GET', '/api/foods');
  const oatsCopy = foods.find((f) => f.name === 'Coach Oats');
  assert.equal(oatsCopy.source_app, 'coach');
  assert.equal(oatsCopy.source_external_id, `food:${ids.oats}`);
  assert.equal(oatsCopy.notes ?? null, null);
  assert.deepEqual(c.items.map((i) => [i.name, i.id, i.food_server_id]), [['Coach Oats', oatsCopy.id, oatsCopy.id], ['Skyr', ids.clientSkyr, ids.clientSkyr]], 'their own Skyr, by barcode; a copy of the oats');
  assert.equal(foods.filter((f) => f.barcode === '5701234567893').length, 1, 'no second Skyr');
  assert.equal((await call('client', 'POST', `/api/coaching/recommendations/${ids.sent}/answer`, { status: 'accepted' })).status, 409);
  assert.equal((await recipeOf('client')).filter((r) => r.name === 'Protein Bowl').length, 1, 'answered once, copied once');
  // Nobody else sees it: it's private, and sharing is off anyway.
  assert.deepEqual((await ok('other', 'GET', '/api/meals?recipes=1&group=1')).map((r) => r.name), []);

  // A meal, declined: nothing made.
  const meal = await ok('coach', 'POST', recPath(), { kind: 'meal', meal_id: ids.breakfast });
  await ok('client', 'POST', `/api/coaching/recommendations/${meal.id}/answer`, { status: 'declined', response_note: 'Not hungry' });
  assert.deepEqual((await ok('client', 'GET', '/api/meals')).map((x) => x.name), []);
  assert.equal((await ok('client', 'GET', '/api/foods')).filter((f) => f.name === 'Coach Oats').length, 1);
});

test('an answer sent offline makes the copy; the pull brings it; backup keeps it; the coach\'s account going leaves it', { skip: !ready }, async () => {
  const meal = await ok('coach', 'POST', recPath(), { kind: 'meal', meal_id: ids.breakfast, note: 'Again?' });
  const t0 = new Date(Date.now() - 1000).toISOString();
  const pushed = await ok('client', 'POST', '/api/sync/push', { coach_answers: [{ id: meal.id, status: 'accepted' }] });
  assert.equal(pushed.coach_answers[0].row.status, 'accepted');
  const pull = await ok('client', 'GET', `/api/sync/pull?since=${encodeURIComponent(t0)}`);
  const pulledMeal = pull.meals.find((x) => x.name === 'Quick Breakfast');
  assert.ok(pulledMeal, 'the copy comes down');
  assert.equal(pulledMeal.source_external_id, `meal:${ids.breakfast}:${meal.id}`);
  const oatsCopy = (await ok('client', 'GET', '/api/foods')).find((f) => f.name === 'Coach Oats');
  assert.deepEqual(pulledMeal.items.map((i) => [i.id, i.quantity]), [[oatsCopy.id, 2], [ids.honey, 1]], 'the oats copied before, used again; their own honey, not a copy');
  assert.equal((await ok('client', 'GET', '/api/foods')).filter((f) => f.name === 'Cleo Honey').length, 1);
  // Save a Copy of the coach's shared original (From Others) works as before:
  // a copy of it, not the one the coach sent.
  await ok('client', 'PUT', '/api/app-config', { key: 'sharing_enabled', value: 'true' });
  await ok('coach', 'PATCH', `/api/meals/${ids.bowl}/share`, { visibility: 'group' });
  const saved = await ok('client', 'POST', `/api/meals/${ids.bowl}/copy`);
  assert.notEqual(saved.id, ids.copy);
  assert.equal(saved.source_id, ids.bowl);
  await ok('client', 'PUT', '/api/app-config', { key: 'sharing_enabled', value: 'false' });
  // Backup holds the copies; the coach's account going takes the
  // recommendations, never the client's own copies.
  const AdmZip = serverRequire('adm-zip');
  const made = await ok('client', 'POST', '/api/full-backup');
  const data = JSON.parse(new AdmZip(join(dir, 'uploads', 'backups', made.filename)).readAsText('database.json'));
  assert.ok(data.meals.some((x) => x.name === 'Protein Bowl' && x.user_id === ids.client));
  assert.ok(data.coach_recommendations.some((r) => r.kind === 'recipe'));
  await ok('client', 'DELETE', `/api/auth/users/${ids.coach}`);
  assert.deepEqual(await ok('client', 'GET', '/api/coaching/recommendations'), []);
  assert.deepEqual((await ok('client', 'GET', '/api/meals?recipes=1')).map((r) => r.name), ['Protein Bowl v2', 'Protein Bowl'].sort(), 'their copies stay');
  assert.ok((await ok('client', 'GET', '/api/foods')).some((f) => f.name === 'Coach Oats'));
});
