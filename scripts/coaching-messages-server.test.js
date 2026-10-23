/**
 * Coaching messages (phase 2), against the real server on a scratch
 * database, with a stand-in ntfy service and a stand-in mail server:
 *
 * - The conversation: both sides send and read; 4,000 characters at most;
 *   one photo per message.
 * - A message written offline and sent again (a retry after a lost answer,
 *   then the phone's sync push) is stored once: the uuid decides.
 * - Photos: unguessable names, kept out of /uploads, served only to the two
 *   people (the coach only while coaching), gone when the message is deleted.
 * - Read receipts, unread counts, "Message deleted" for your own messages only.
 * - After coaching ends the client still reads the conversation, the coach
 *   doesn't, and nobody writes.
 * - Notifications: ntfy for a new message and for a client's answer (on
 *   unless turned off), an email at most once per 30 minutes per conversation
 *   and only if asked for.
 * - Sync: ?coaching=1 brings messages and the conversations still readable;
 *   without it (a 1.4 app) the answer is exactly as before.
 * - Account deletion and backup/restore carry messages and photos.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
const JWT_SECRET = 'coaching-msg-test-0123456789abcdef012345';
// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let proc, base, dir, uploads;
const tok = {}, ids = {};
const pushes = [];   // what the stand-in ntfy received
const mails = [];    // what the stand-in mail server received
let ntfyPort, smtpPort;

async function call(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok[who]}`;
  const r = await fetch(base + path, { method, headers, body: body == null || method === 'GET' ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
let _u = 0;
const uuid = (tag = 'm') => `${tag}-${Date.now().toString(36)}-${++_u}-abcdef`;

function stubNtfy() {
  return new Promise((res) => {
    const s = http.createServer((req, resp) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => { pushes.push({ path: req.url, title: req.headers.title, body }); resp.end('{}'); });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}
// Just enough SMTP for nodemailer: no TLS, no auth.
function stubSmtp() {
  return new Promise((res) => {
    const s = netServer((sock) => {
      let data = false, buf = '', msg = '';
      sock.write('220 stub\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (data) {
            if (line === '.') { data = false; mails.push(msg); msg = ''; sock.write('250 ok\r\n'); } else msg += line + '\n';
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 stub\r\n');
          else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
          else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

let ntfy, smtp;
test.before(async () => {
  if (!ready) return;
  ntfy = await stubNtfy(); ntfyPort = ntfy.address().port;
  smtp = await stubSmtp(); smtpPort = smtp.address().port;
  dir = mkdtempSync(join(tmpdir(), 'nt-coach-msg-'));
  uploads = join(dir, 'uploads');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: uploads, BACKUPS_PATH: join(dir, 'backups'),
      JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      PUBLIC_URL: base, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false', SMTP_FROM: 'nt@example.com',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const reg = await (await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PW, full_name: 'Ada Admin' }) })).json();
  const login = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PW }) })).json();
  tok.admin = login.token; ids.admin = reg.user.id;
  const jwt = serverRequire('jsonwebtoken');
  for (const [name, role, full] of [['coach', 'coach', 'Sam Coach'], ['coach2', 'coach', 'Kim Coach'], ['client', 'user', 'Cleo Client'], ['plain', 'user', 'Pat Plain'], ['admin2', 'admin', 'Al Admin']]) {
    const { user } = await ok('admin', 'POST', '/api/auth/register', { username: name, password: PW, full_name: full, role, email: `${name}@example.com` });
    tok[name] = jwt.sign({ id: user.id, username: name, role, csrf: 'x' }, JWT_SECRET, { expiresIn: '1h' });
    ids[name] = user.id;
  }
  const r = await ok('coach', 'POST', '/api/coaching/requests', { client_id: ids.client });
  await ok('client', 'POST', `/api/coaching/pairings/${r.id}/accept`);
  ids.pairing = r.id;
  // The coach and the client both send pushes to the stand-in ntfy.
  for (const who of ['coach', 'client']) {
    await ok(who, 'PUT', '/api/settings', { key: 'notifPushService', value: 'ntfy' });
    await ok(who, 'PUT', '/api/settings', { key: 'ntfyUrl', value: `http://127.0.0.1:${ntfyPort}` });
    await ok(who, 'PUT', '/api/settings', { key: 'ntfyTopic', value: `nt-${who}` });
  }
});
test.after(() => { proc?.kill(); ntfy?.close(); smtp?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const clientPath = (p = '') => `/api/coaching/pairings/${ids.pairing}/messages${p}`;
const coachPath = (p = '') => `/api/coaching/clients/${ids.client}/messages${p}`;
const waitFor = async (pred, ms = 3000) => { for (let i = 0; i < ms / 50; i++) { if (pred()) return true; await sleep(50); } return pred(); };

test('the conversation: both sides send and read; limits', { skip: !ready }, async () => {
  const a = await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'Welcome aboard' });
  assert.equal(a.sender_id, ids.coach);
  const b = await ok('client', 'POST', clientPath(), { uuid: uuid(), body: 'Thanks!' });
  const seenByClient = await ok('client', 'GET', clientPath());
  const seenByCoach = await ok('coach', 'GET', coachPath());
  assert.deepEqual(seenByClient.messages.map((m) => m.body), ['Welcome aboard', 'Thanks!']);
  assert.deepEqual(seenByCoach.messages.map((m) => m.uuid), [a.uuid, b.uuid]);
  assert.equal(seenByClient.can_send, true);
  // Since a time: only what changed.
  const later = await ok('client', 'GET', clientPath(`?since=${encodeURIComponent(new Date(Date.now() + 5000).toISOString())}`));
  assert.equal(later.messages.length, 0);

  assert.equal((await call('client', 'POST', clientPath(), { uuid: uuid(), body: 'x'.repeat(4001) })).status, 400);
  assert.equal((await call('client', 'POST', clientPath(), { uuid: uuid(), body: 'x'.repeat(4000) })).status, 200);
  assert.equal((await call('client', 'POST', clientPath(), { uuid: uuid(), body: '   ' })).status, 400, 'nothing to send');
  assert.equal((await call('client', 'POST', clientPath(), { body: 'no id' })).status, 400);
  assert.equal((await call('client', 'POST', clientPath(), { uuid: uuid(), image: 'data:text/html;base64,PGgxPg==' })).status, 400, 'only images');
});

test('a message written offline is stored once, however often it is sent', { skip: !ready }, async () => {
  const id = uuid('offline');
  const msg = { uuid: id, pairing_id: ids.pairing, body: 'Written in a dead zone' };
  // The app retries the direct send after a lost answer, then the phone's
  // sync push carries the same message again.
  const first = await ok('client', 'POST', clientPath(), msg);
  const again = await ok('client', 'POST', clientPath(), msg);
  const pushed = await ok('client', 'POST', '/api/sync/push', { coach_messages: [msg, msg] });
  assert.equal(again.id, first.id);
  assert.deepEqual(pushed.coach_messages.map((r) => r.row.id), [first.id, first.id]);
  const all = (await ok('coach', 'GET', coachPath())).messages.filter((m) => m.uuid === id);
  assert.equal(all.length, 1);
  // Someone else can't take over that uuid.
  assert.equal((await call('coach', 'POST', coachPath(), { uuid: id, body: 'mine now' })).status, 409);
});

test('photos are private to the two people and go with their message', { skip: !ready }, async () => {
  const m = await ok('client', 'POST', clientPath(), { uuid: uuid('photo'), image: PNG });
  assert.match(m.image, /^\/api\/coaching\/photos\/[a-f0-9]{32}\.png$/);
  const name = m.image.split('/').pop();
  assert.ok(existsSync(join(uploads, 'coaching', name)));
  for (const who of ['client', 'coach']) {
    const r = await call(who, 'GET', m.image);
    assert.equal(r.status, 200, who);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.match(r.headers.get('cache-control'), /private/);
  }
  for (const who of ['coach2', 'plain', 'admin2', null]) assert.notEqual((await call(who, 'GET', m.image)).status, 200, String(who));
  // Never through the public /uploads mount.
  assert.equal((await fetch(`${base}/uploads/coaching/${name}`)).status, 404);
  assert.equal((await fetch(`${base}/uploads/%63oaching/${name}`)).status, 404);
  // Only the sender deletes, and the photo goes with it.
  assert.equal((await call('coach', 'DELETE', `/api/coaching/messages/${m.uuid}`)).status, 404);
  const gone = await ok('client', 'DELETE', `/api/coaching/messages/${m.uuid}`);
  assert.equal(gone.body, null); assert.equal(gone.image, null); assert.ok(gone.deleted_at);
  assert.equal((await call('client', 'GET', m.image)).status, 404);
  assert.ok(!existsSync(join(uploads, 'coaching', name)));
  // A photo whose file went missing answers 404 and the server carries on
  // (it used to stream without an error handler and could crash).
  const lost = await ok('client', 'POST', clientPath(), { uuid: uuid('lost'), image: PNG });
  rmSync(join(uploads, 'coaching', lost.image.split('/').pop()));
  assert.equal((await call('coach', 'GET', lost.image)).status, 404);
  assert.equal((await call('coach', 'GET', '/api/coaching/state')).status, 200, 'still up');
  // AVIF, which the app sends as it is when it is small enough.
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(24)]).toString('base64');
  const a = await call('client', 'POST', clientPath(), { uuid: uuid('avif'), image: `data:image/avif;base64,${avif}` });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.match(a.data.image, /\.avif$/);
  const shown = (await ok('coach', 'GET', coachPath())).messages.find((x) => x.uuid === m.uuid);
  assert.ok(shown.deleted_at, 'the coach sees "Message deleted"');
});

test('read receipts and unread counts', { skip: !ready }, async () => {
  await ok('coach', 'POST', coachPath('/read'));
  await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'How did lunch go?' });
  await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'And dinner?' });
  let st = await ok('client', 'GET', '/api/coaching/state');
  assert.equal(st.as_client.unread, 3, 'the welcome and the two new ones');
  assert.equal(st.unread, 3);
  const before = (await ok('coach', 'GET', '/api/settings', null)); void before;
  await ok('client', 'POST', clientPath('/read'));
  st = await ok('client', 'GET', '/api/coaching/state');
  assert.equal(st.unread, 0);
  const coachView = (await ok('coach', 'GET', coachPath())).messages.filter((x) => x.sender_id === ids.coach);
  assert.ok(coachView.every((x) => x.read_at), 'the coach sees them read');
  await ok('client', 'POST', clientPath(), { uuid: uuid(), body: 'Fine' });
  const list = await ok('coach', 'GET', '/api/coaching/clients');
  assert.equal(list.find((r) => r.client.id === ids.client).unread, 1);
  assert.equal((await ok('coach', 'GET', '/api/coaching/state')).as_coach.unread, 1);
});

test('notifications: a push per message and per answer, email at most every 30 minutes', { skip: !ready }, async () => {
  pushes.length = 0; mails.length = 0;
  await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'Ping' });
  assert.ok(await waitFor(() => pushes.some((p) => p.path === '/nt-client')), JSON.stringify(pushes));
  const push = pushes.find((p) => p.path === '/nt-client');
  assert.equal(push.body, 'New message from Sam Coach');
  assert.doesNotMatch(JSON.stringify(push), /Ping/, 'never the message itself');
  // Turned off: nothing.
  await ok('client', 'PUT', '/api/settings', { key: 'notifCoachMessage', value: false });
  pushes.length = 0;
  await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'Quiet' });
  await sleep(400);
  assert.equal(pushes.filter((p) => p.path === '/nt-client').length, 0);
  await ok('client', 'PUT', '/api/settings', { key: 'notifCoachMessage', value: true });
  // Email only when asked for, then at most once per 30 minutes.
  assert.equal(mails.length, 0);
  await ok('client', 'PUT', '/api/settings', { key: 'notifCoachMessageEmail', value: true });
  await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'One' });
  await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'Two' });
  await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'Three' });
  assert.ok(await waitFor(() => mails.length >= 1));
  await sleep(500);
  assert.equal(mails.length, 1, 'one email for three messages');
  assert.match(mails[0], /To: client@example\.com/i);
  assert.doesNotMatch(mails[0], /One|Two|Three/, 'the message itself is not in the email');
  // A request reaches the person asked: who, never the note.
  await ok('plain', 'PUT', '/api/settings', { key: 'notifPushService', value: 'ntfy' });
  await ok('plain', 'PUT', '/api/settings', { key: 'ntfyUrl', value: `http://127.0.0.1:${ntfyPort}` });
  await ok('plain', 'PUT', '/api/settings', { key: 'ntfyTopic', value: 'nt-plain' });
  pushes.length = 0;
  const r = await ok('coach2', 'POST', '/api/coaching/requests', { client_id: ids.plain, note: 'Secret plan inside' });
  assert.ok(await waitFor(() => pushes.some((p) => p.path === '/nt-plain')));
  assert.equal(pushes.find((p) => p.path === '/nt-plain').body, 'Kim Coach wants to be your coach.');
  assert.doesNotMatch(JSON.stringify(pushes), /Secret plan/);
  // Under New Recommendation: turned off, no push.
  await ok('plain', 'PUT', '/api/settings', { key: 'notifCoachRecommendation', value: false });
  await ok('plain', 'POST', `/api/coaching/pairings/${r.id}/decline`);
  pushes.length = 0;
  const r1 = await ok('coach2', 'POST', '/api/coaching/requests', { client_id: ids.plain });
  await sleep(400);
  assert.equal(pushes.filter((p) => p.path === '/nt-plain').length, 0);
  await ok('coach2', 'POST', `/api/coaching/pairings/${r1.id}/end`);
  // A client's answer reaches the coach.
  pushes.length = 0;
  const r2 = await ok('coach2', 'POST', '/api/coaching/requests', { client_id: ids.plain });
  await ok('coach2', 'PUT', '/api/settings', { key: 'notifPushService', value: 'ntfy' });
  await ok('coach2', 'PUT', '/api/settings', { key: 'ntfyUrl', value: `http://127.0.0.1:${ntfyPort}` });
  await ok('coach2', 'PUT', '/api/settings', { key: 'ntfyTopic', value: 'nt-coach2' });
  await ok('plain', 'POST', `/api/coaching/pairings/${r2.id}/decline`);
  assert.ok(await waitFor(() => pushes.some((p) => p.path === '/nt-coach2' && /declined/.test(p.body))));
});

test('sync: messages only for an app that asks; a 1.4 app gets the old answer', { skip: !ready }, async () => {
  const old = await ok('client', 'GET', '/api/sync/pull');
  assert.ok(!('coach_messages' in old) && !('coaching' in old), 'a 1.4 app sees no new keys');
  const neu = await ok('client', 'GET', '/api/sync/pull?coaching=1');
  assert.ok(neu.coach_messages.length > 5);
  assert.deepEqual(neu.coaching.pairings, [ids.pairing]);
  assert.ok(neu.coach_messages.every((m) => !('email' in m) && !('username' in m)));
  const other = await ok('coach2', 'GET', '/api/sync/pull?coaching=1');
  assert.equal(other.coach_messages.length, 0, 'nothing of another coach\'s conversation');
  // A delete made on the phone travels by push.
  const m = await ok('client', 'POST', clientPath(), { uuid: uuid(), body: 'oops' });
  const p = await ok('client', 'POST', '/api/sync/push', { coach_messages: [{ uuid: m.uuid, deleted_at: new Date().toISOString() }] });
  assert.ok(p.coach_messages[0].row.deleted_at);
  // Not someone else's.
  const n = await ok('coach', 'POST', coachPath(), { uuid: uuid(), body: 'keep' });
  const q = await ok('client', 'POST', '/api/sync/push', { coach_messages: [{ uuid: n.uuid, deleted_at: new Date().toISOString() }] });
  assert.equal(q.coach_messages[0].status, 404);
});

test('after coaching ends: the client still reads it, the coach does not, nobody writes', { skip: !ready }, async () => {
  const photo = await ok('client', 'POST', clientPath(), { uuid: uuid('keep'), image: PNG });
  await ok('client', 'POST', `/api/coaching/pairings/${ids.pairing}/end`);
  const kept = await ok('client', 'GET', clientPath());
  assert.ok(kept.messages.length > 5);
  assert.equal(kept.can_send, false);
  assert.equal((await call('client', 'GET', photo.image)).status, 200, 'the client keeps the photos too');
  assert.equal((await call('coach', 'GET', photo.image)).status, 404);
  assert.equal((await call('coach', 'GET', coachPath())).status, 404);
  assert.equal((await call('client', 'POST', clientPath(), { uuid: uuid(), body: 'hello?' })).status, 404);
  const st = await ok('client', 'GET', '/api/coaching/state');
  assert.deepEqual(st.past.map((x) => x.id), [ids.pairing]);
  assert.equal((await ok('coach', 'GET', '/api/sync/pull?coaching=1')).coaching.pairings.length, 0);
  assert.deepEqual((await ok('client', 'GET', '/api/sync/pull?coaching=1')).coaching.pairings, [ids.pairing]);
});

test('backup and restore carry messages and photos; deleting an account removes them', { skip: !ready }, async () => {
  const AdmZip = serverRequire('adm-zip');
  const before = (await ok('client', 'GET', clientPath())).messages;
  const photoMsg = before.filter((m) => m.image).at(-1); // one whose file is there
  const made = await ok('admin', 'POST', '/api/full-backup');
  const zip = new AdmZip(join(dir, 'backups', made.filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  assert.ok(data.coach_messages.length >= before.length);
  assert.ok(zip.getEntries().some((e) => e.entryName === `images/coaching/${photoMsg.image.split('/').pop()}`));
  rmSync(join(uploads, 'coaching', photoMsg.image.split('/').pop()));
  await ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(made.filename)}/restore`);
  const after = (await ok('client', 'GET', clientPath())).messages;
  assert.deepEqual(after.map((m) => m.uuid), before.map((m) => m.uuid));
  assert.equal((await call('client', 'GET', photoMsg.image)).status, 200, 'the photo came back');

  const files = () => readdirSync(join(uploads, 'coaching')).length;
  assert.ok(files() > 0);
  await ok('admin', 'DELETE', `/api/auth/users/${ids.client}`);
  assert.equal(files(), 0, 'the photos of the deleted account\'s conversations are gone');
  const left = await ok('admin', 'GET', '/api/coaching/admin/pairings');
  assert.ok(!left.some((p) => p.client.id === ids.client));
});

test('Trace never reads the conversation', () => {
  const { readFileSync, readdirSync: rd } = { readFileSync: (p) => serverRequire('fs').readFileSync(p, 'utf8'), readdirSync: (p) => serverRequire('fs').readdirSync(p) };
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = [
    ...['src/lib/aiChat.js', 'server/routes/ai.js', 'server/ai.js', 'server/routes/mcp.js'].map((f) => join(root, f)),
    ...rd(join(root, 'server/lib/mcp/tools')).map((f) => join(root, 'server/lib/mcp/tools', f)),
    ...rd(join(root, 'server/routes/api/v1')).map((f) => join(root, 'server/routes/api/v1', f)),
  ];
  for (const f of files) assert.doesNotMatch(readFileSync(f), /coach_messages|\/api\/coaching/, f);
});
