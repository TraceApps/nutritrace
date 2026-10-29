/**
 * Two-step sign-in (#222) against the real server (server/index.js on a
 * scratch database). Nothing leaves the machine: every request goes to the
 * server on 127.0.0.1, from loopback addresses (127.0.0.x) so each test has
 * its own per-address limits.
 *
 * - The password step hands back a pending token, never a session, and a
 *   pending token opens nothing else (as a bearer, as a cookie, expired,
 *   forged, of the other kind, after a password change, used twice).
 * - Setup turns on only with a right code; ten recovery codes, single use.
 * - The ±1 step window, and a code (or an older one) never works twice.
 * - Wrong-code limits per pending token, per account and per address.
 * - Turning it off and new recovery codes need the password and a code.
 * - Getting back in: a recovery code, an admin's reset (own password, own
 *   code, not themselves, admins only), RECOVERY_TOKEN for one account,
 *   and `npm run reset-2fa -- <username>`.
 * - Forgot Password never signs in past the code. Require for everyone
 *   sends people through setup (and an invite too). Single sign-on only
 *   accounts are left alone. Apps from before two-step sign-in get a plain
 *   error and no session.
 * - A changed key never locks anyone out; account deletion and backup.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { hotp, timeStep, base32Decode } from '../server/lib/totp.js';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const SERVER_DIR = fileURLToPath(new URL('../server/', import.meta.url));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'two-step-test-0123456789abcdef0123456789';
const RECOVERY_TOKEN = 'owner-recovery-token-0123456789abcdef';

let _ipN = 10;
/** A loopback address of its own, so a test's limits are its own. */
const newIp = () => `127.0.0.${_ipN++}`;

function serverEnv(dir, port, extra = {}) {
  return {
    ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'),
    JWT_SECRET, RECOVERY_TOKEN, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'info', UPDATE_CHECK: 'off', ...extra,
  };
}

async function boot(dir, extra = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], { cwd: SERVER_DIR, env: serverEnv(dir, port, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const srv = { proc, port, dir, get log() { return log; } };
  for (let i = 0; i < 150; i++) {
    try { if ((await send(srv, { method: 'GET', path: '/api/auth/status' })).status === 200) return srv; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`server did not start: ${log}`);
}
async function stop(srv) {
  if (!srv?.proc || srv.proc.exitCode != null) return;
  await new Promise((r) => { srv.proc.once('exit', r); srv.proc.kill(); });
}

/** One request: { status, data, cookie } (cookie: the nt_token it set, if any). */
function send(srv, { method = 'POST', path, body, bearer, cookie, csrf, ip = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (cookie) headers.Cookie = `nt_token=${cookie}`;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const payload = body == null || method === 'GET' ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers, localAddress: ip }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let data; try { data = JSON.parse(text); } catch { data = text; }
        const set = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('nt_token=') && !c.startsWith('nt_token=;'));
        resolve({ status: res.statusCode, data, cookie: set ? decodeURIComponent(set.split(';')[0].slice('nt_token='.length)) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openDb(srv) {
  const Database = serverRequire('better-sqlite3');
  return new Database(join(srv.dir, 'nt.db'));
}

/** The current code for a base32 secret, `ahead` steps from now. */
const codeFor = (secret, ahead = 0) => hotp(base32Decode(secret), timeStep() + ahead);

/** Waits out the last seconds of a 30-second step, so "two steps ahead" can't become one on the way. */
async function awayFromEdge() {
  const left = 30000 - (Date.now() % 30000);
  if (left < 5000) await sleep(left + 200);
}

const jwt = () => serverRequire('jsonwebtoken');
const pendingKey = () => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(JWT_SECRET), Buffer.from('traceapps.two-step.pending.v1'), Buffer.alloc(0), 32));

// ── One server for most tests ─────────────────────────────────────────────
let S = null;
const tok = {};
const ids = {};
const secrets = {};
const recovery = {};

async function login(name, ip, password = PW) {
  return send(S, { path: '/api/auth/login', body: { username: name, password }, ip });
}
async function makeUser(name, role = 'user', extra = {}) {
  const r = await send(S, { path: '/api/auth/register', body: { username: name, password: PW, role, ...extra }, bearer: tok.admin });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ids[name] = r.data.user.id;
  tok[name] = jwt().sign({ id: r.data.user.id, username: name, role, csrf: 'x' }, JWT_SECRET, { expiresIn: '1h' });
}
/** Turns two-step sign-in on for someone signed in; keeps the secret and codes. */
async function enable(name, ip = newIp()) {
  const start = await send(S, { path: '/api/auth/two-step/setup/start', body: { password: PW }, bearer: tok[name], ip });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  secrets[name] = start.data.secret;
  const done = await send(S, { path: '/api/auth/two-step/setup/confirm', body: { code: codeFor(start.data.secret) }, bearer: tok[name], ip });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  recovery[name] = done.data.recovery_codes;
}
/** Lets the next code be the current one again (the test can't wait 30 s). */
function rewind(name) {
  const db = openDb(S);
  db.prepare('UPDATE user_two_step SET last_step = 0 WHERE user_id = ?').run(ids[name]);
  db.close();
}

test.before(async () => {
  if (!ready) return;
  const dir = mkdtempSync(join(tmpdir(), 'nt-two-step-'));
  S = await boot(dir);
  const reg = await send(S, { path: '/api/auth/register', body: { username: 'admin', password: PW, full_name: 'Ada Admin' } });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const l = await login('admin', newIp());
  assert.equal(l.status, 200);
  tok.admin = l.data.token;
  ids.admin = l.data.user.id;
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hal', 'ivy', 'jo', 'kim', 'lee', 'max', 'ned']) await makeUser(n);
  await makeUser('admin2', 'admin');
});
test.after(async () => { await stop(S); if (S?.dir) rmSync(S.dir, { recursive: true, force: true }); });

// ── Setup ─────────────────────────────────────────────────────────────────
test('setup: password first, then the secret; on only after a right code; ten recovery codes', { skip: !ready }, async () => {
  const ip = newIp();
  let st = await send(S, { method: 'GET', path: '/api/auth/two-step/status', bearer: tok.alice, ip });
  assert.equal(st.data.enabled, false);
  assert.equal(st.data.has_password, true);
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/two-step/status', ip })).status, 401);

  assert.equal((await send(S, { path: '/api/auth/two-step/setup/start', body: {}, bearer: tok.alice, ip })).status, 401, 'no password');
  assert.equal((await send(S, { path: '/api/auth/two-step/setup/start', body: { password: 'wrong' }, bearer: tok.alice, ip })).status, 401);
  const start = await send(S, { path: '/api/auth/two-step/setup/start', body: { password: PW }, bearer: tok.alice, ip });
  assert.equal(start.status, 200);
  assert.match(start.data.secret, /^[A-Z2-7]{32}$/);
  assert.match(start.data.otpauth_uri, /^otpauth:\/\/totp\/NutriTrace%3Aalice\?secret=/);
  assert.match(start.data.qr, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(start.data.qr.split(',')[1], 'base64').toString(), /^<svg /);

  // Not on yet: sign-in still takes the password alone.
  assert.equal((await login('alice', ip)).status, 200);
  const wrong = await send(S, { path: '/api/auth/two-step/setup/confirm', body: { code: codeFor(start.data.secret, 5) }, bearer: tok.alice, ip });
  assert.equal(wrong.status, 400);
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/two-step/status', bearer: tok.alice, ip })).data.enabled, false);

  const done = await send(S, { path: '/api/auth/two-step/setup/confirm', body: { code: codeFor(start.data.secret) }, bearer: tok.alice, ip });
  assert.equal(done.status, 200);
  assert.equal(done.data.recovery_codes.length, 10);
  assert.equal(new Set(done.data.recovery_codes).size, 10);
  for (const c of done.data.recovery_codes) assert.match(c, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
  secrets.alice = start.data.secret;
  recovery.alice = done.data.recovery_codes;

  st = await send(S, { method: 'GET', path: '/api/auth/two-step/status', bearer: tok.alice, ip });
  assert.equal(st.data.enabled, true);
  assert.equal(st.data.recovery_codes_left, 10);
  assert.equal(JSON.stringify(st.data).includes(secrets.alice), false, 'status never carries the secret');
  assert.equal((await send(S, { path: '/api/auth/two-step/setup/start', body: { password: PW }, bearer: tok.alice, ip })).status, 409, 'already on');

  // Stored: a locked secret, and hashes of the codes, never the codes.
  const db = openDb(S);
  const row = db.prepare('SELECT * FROM user_two_step WHERE user_id = ?').get(ids.alice);
  assert.match(row.secret_enc, /^ts:v1:[0-9a-f]{8}:/);
  assert.equal(row.secret_enc.includes(secrets.alice), false);
  const hashes = db.prepare('SELECT code_hash FROM user_two_step_recovery WHERE user_id = ?').all(ids.alice).map((r) => r.code_hash);
  db.close();
  assert.equal(hashes.length, 10);
  for (const c of recovery.alice) assert.equal(hashes.some((h) => h.includes(c.replace(/-/g, ''))), false);
  // The key is its own file, readable by the server only.
  const keyFile = join(S.dir, 'two-step.key');
  assert.ok(existsSync(keyFile));
  assert.equal(statSync(keyFile).mode & 0o077, 0, 'key file is private');
  assert.equal(S.log.includes(secrets.alice), false, 'the log never has the secret');
  assert.match(S.log, /\[two-step\] alice \(id \d+\): turned on/);
  // safeUser says it's on (Settings, Users), never more.
  const users = await send(S, { method: 'GET', path: '/api/auth/users', bearer: tok.admin, ip });
  const a = users.data.find((u) => u.username === 'alice');
  assert.equal(a.two_step_enabled, true);
  assert.equal(JSON.stringify(users.data).includes('secret_enc'), false);
});

// ── The password step gives a pending token, never a session ─────────────
test('password step: a pending token, no session, no cookie; it opens nothing else', { skip: !ready }, async () => {
  await enable('bob');
  const ip = newIp();
  const r = await login('bob', ip);
  assert.equal(r.status, 401);
  assert.equal(r.data.two_step, 'verify');
  assert.ok(r.data.pending_token);
  assert.equal(r.data.token, undefined);
  assert.equal(r.data.user, undefined);
  assert.equal(r.cookie, null, 'no session cookie');
  assert.match(r.data.error, /two-step sign-in/);
  const p = r.data.pending_token;

  // As a bearer, or as the session cookie: nobody.
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/me', bearer: p, ip })).data.user, null);
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/me', cookie: p, ip })).data.user, null);
  assert.equal((await send(S, { method: 'GET', path: '/api/settings', bearer: p, ip })).status, 401);
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/two-step/status', bearer: p, ip })).status, 401);
  assert.equal((await send(S, { path: '/api/auth/two-step/disable', body: { password: PW, code: codeFor(secrets.bob) }, bearer: p, ip })).status, 401);
  assert.equal((await send(S, { path: '/api/auth/two-step/recovery-codes', body: { password: PW, code: codeFor(secrets.bob) }, bearer: p, ip })).status, 401);
  // Not a setup token either.
  assert.equal((await send(S, { path: '/api/auth/two-step/setup/start', body: { pending_token: p }, ip })).status, 401);

  // The second step signs in.
  rewind('bob');
  const v = await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: codeFor(secrets.bob) }, ip });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.ok(v.data.token);
  assert.equal(v.data.user.username, 'bob');
  assert.ok(v.cookie, 'session cookie set');
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/me', bearer: v.data.token, ip })).data.user.username, 'bob');
  // A pending token is good once.
  assert.equal((await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: codeFor(secrets.bob, 1) }, ip })).status, 401);
});

test('pending tokens: expired, forged, signed with the session secret, or after a password change are refused', { skip: !ready }, async () => {
  await enable('carol');
  const ip = newIp();
  const j = jwt();
  const db = openDb(S);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ids.carol);
  db.close();
  const pwv = crypto.createHash('sha256').update(user.password_hash).digest('hex').slice(0, 16);
  const claims = { typ: 'two_step_pending', sub: String(ids.carol), kind: 'verify', pwv, jti: 'abc' };
  const tryVerify = (p) => send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: codeFor(secrets.carol) }, ip });

  const expired = j.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 5 }, pendingKey());
  let r = await tryVerify(expired);
  assert.equal(r.status, 401); assert.equal(r.data.restart, true);
  // Signed with the sign-in secret instead of the pending key.
  assert.equal((await tryVerify(j.sign(claims, JWT_SECRET, { expiresIn: '5m' }))).status, 401);
  // A real session token is no pending token.
  assert.equal((await tryVerify(tok.carol)).status, 401);
  // Made with the right key but naming another account's password.
  assert.equal((await tryVerify(j.sign({ ...claims, pwv: '0000000000000000' }, pendingKey(), { expiresIn: '5m' }))).status, 401);
  // The other way round: a pending token made with our secret isn't a session.
  const typed = j.sign({ id: ids.carol, username: 'carol', role: 'user', typ: 'two_step_pending' }, JWT_SECRET, { expiresIn: '5m' });
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/me', bearer: typed, ip })).data.user, null);

  // A password change since the password step: the pending token is done.
  const first = await login('carol', ip);
  const NEW = 'An0ther-Pass-88!y';
  const ch = await send(S, { method: 'PUT', path: '/api/auth/password', body: { current_password: PW, new_password: NEW }, bearer: tok.carol, ip });
  assert.equal(ch.status, 200);
  r = await tryVerify(first.data.pending_token);
  assert.equal(r.status, 401);
  assert.equal(r.data.restart, true);
  const again = await login('carol', ip, NEW);
  rewind('carol');
  assert.equal((await tryVerify(again.data.pending_token)).status, 200);
});

// ── The window and replay ─────────────────────────────────────────────────
test('one step either side is accepted; a code, or an older one, never works twice', { skip: !ready }, async () => {
  await enable('dave');
  const ip = newIp();
  // Sign-in is limited to five a quarter hour per account: a pending token
  // stays good through wrong codes, so three do.
  const verify = (p, code) => send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code }, ip });
  rewind('dave');
  await awayFromEdge();
  const p1 = (await login('dave', ip)).data.pending_token;
  assert.equal((await verify(p1, codeFor(secrets.dave, -2))).status, 401, 'two steps old');
  assert.equal((await verify(p1, codeFor(secrets.dave, 2))).status, 401, 'two steps ahead');
  assert.equal((await verify(p1, codeFor(secrets.dave, -1))).status, 200, 'one step old');
  const p2 = (await login('dave', ip)).data.pending_token;
  assert.equal((await verify(p2, codeFor(secrets.dave, -1))).status, 401, 'the same code again');
  assert.equal((await verify(p2, codeFor(secrets.dave, 0))).status, 200, 'the next code');
  const p3 = (await login('dave', ip)).data.pending_token;
  assert.equal((await verify(p3, codeFor(secrets.dave, -1))).status, 401, 'an older code than the last one used');
  // The race: two sign-ins with one code at once, one wins.
  rewind('dave');
  const [r1, r2] = [(await login('dave', newIp())).data.pending_token, (await login('dave', newIp())).data.pending_token];
  const code = codeFor(secrets.dave);
  const both = await Promise.all([r1, r2].map((p) => send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code }, ip })));
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 401]);
});

// ── Limits ────────────────────────────────────────────────────────────────
test('wrong codes: five per pending token sends back to the password; five per account locks the account a while', { skip: !ready }, async () => {
  await enable('erin');
  const ip = newIp();
  const p = (await login('erin', ip)).data.pending_token;
  for (let i = 0; i < 5; i++) {
    const r = await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: '000000' }, ip });
    assert.equal(r.status, 401, `try ${i}`);
  }
  const sixth = await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: codeFor(secrets.erin) }, ip });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.data.restart, true);
  // From another address, with a new pending token: the account is limited too.
  const ip2 = newIp();
  const p2 = (await login('erin', ip2)).data.pending_token;
  const r = await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p2, code: codeFor(secrets.erin) }, ip: ip2 });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /this account/);
  // Recovery codes go through the same door.
  assert.equal((await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p2, code: recovery.erin[0] }, ip: ip2 })).status, 429);
});

test('wrong codes: ten from one address stop that address, whatever the account', { skip: !ready }, async () => {
  for (const n of ['frank', 'gina', 'hal']) await enable(n);
  const ip = newIp();
  const pend = {};
  for (const n of ['frank', 'gina', 'hal']) pend[n] = (await login(n, ip)).data.pending_token;
  let wrong = 0;
  for (const n of ['frank', 'gina', 'hal']) {
    for (let i = 0; i < 4 && wrong < 10; i++, wrong++) {
      assert.equal((await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: pend[n], code: '000000' }, ip })).status, 401);
    }
  }
  rewind('hal');
  const r = await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: pend.hal, code: codeFor(secrets.hal) }, ip });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /this address/);
});

// ── Recovery codes ────────────────────────────────────────────────────────
test('a recovery code signs in once, typed any way; it is logged and counted', { skip: !ready }, async () => {
  const ip = newIp();
  const code = recovery.alice[0];
  const typed = code.toUpperCase().replace(/-/g, ' ');
  const r = await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: (await login('alice', ip)).data.pending_token, code: typed }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.recovery_codes_left, 9);
  const again = await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: (await login('alice', ip)).data.pending_token, code }, ip });
  assert.equal(again.status, 401);
  assert.match(again.data.error, /already used/);
  assert.match(S.log, /alice \(id \d+\): signed in with a recovery code \(9 left\)/);
  assert.equal(S.log.includes(code), false, 'the log never has the code');
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/two-step/status', bearer: tok.alice, ip })).data.recovery_codes_left, 9);
});

test('new recovery codes and turning off take the password and a code', { skip: !ready }, async () => {
  await enable('ivy');
  const ip = newIp();
  const post = (path, body) => send(S, { path: `/api/auth/two-step/${path}`, body, bearer: tok.ivy, ip });
  assert.equal((await post('recovery-codes', { password: 'nope', code: codeFor(secrets.ivy) })).status, 401);
  assert.equal((await post('recovery-codes', { password: PW, code: '' })).status, 401);
  rewind('ivy');
  const fresh = await post('recovery-codes', { password: PW, code: codeFor(secrets.ivy) });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.recovery_codes.length, 10);
  // The old ones stopped working; a new one turns it off (lost phone, still signed in).
  assert.equal((await post('disable', { password: PW, code: recovery.ivy[1] })).status, 401);
  assert.equal((await post('disable', { password: 'nope', code: fresh.data.recovery_codes[0] })).status, 401);
  assert.equal((await post('disable', { password: PW, code: fresh.data.recovery_codes[0] })).status, 200);
  assert.equal((await login('ivy', ip)).status, 200, 'password alone again');
  const db = openDb(S);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_two_step_recovery WHERE user_id = ?').get(ids.ivy).n, 0);
  db.close();
  assert.match(S.log, /ivy \(id \d+\): turned off by its owner/);
  // A browser session needs its CSRF token.
  const cookieLogin = await login('ivy', ip);
  const csrf = jwt().decode(cookieLogin.cookie).csrf;
  assert.equal((await send(S, { path: '/api/auth/two-step/setup/start', body: { password: PW }, cookie: cookieLogin.cookie, ip })).status, 403);
  assert.equal((await send(S, { path: '/api/auth/two-step/setup/start', body: { password: PW }, cookie: cookieLogin.cookie, csrf, ip })).status, 200);
});

// ── The ladder: an admin ──────────────────────────────────────────────────
test('admin reset: own password, not themselves, admins only, own code when they have it on', { skip: !ready }, async () => {
  await enable('jo');
  const ip = newIp();
  const reset = (who, id, body) => send(S, { path: `/api/auth/two-step/users/${id}/reset`, body, bearer: tok[who], ip });
  assert.equal((await reset('kim', ids.jo, { password: PW })).status, 403, 'not an admin');
  assert.equal((await reset('admin', ids.jo, { password: 'nope' })).status, 401, 'wrong password');
  assert.equal((await reset('admin', ids.jo, {})).status, 401, 'no password');
  assert.equal((await reset('admin', ids.admin, { password: PW })).status, 400, 'not themselves');
  assert.equal((await reset('admin', 999999, { password: PW })).status, 404);
  assert.equal((await reset('admin', ids.jo, { password: PW })).status, 200);
  assert.equal((await reset('admin', ids.jo, { password: PW })).status, 400, 'already off');
  assert.equal((await login('jo', ip)).status, 200);
  assert.match(S.log, /jo \(id \d+\): reset by an admin by admin \(id \d+\)/);

  // An admin with two-step sign-in on gives their code as well: a session left open isn't enough.
  await enable('admin2');
  await enable('kim');
  const noCode = await reset('admin2', ids.kim, { password: PW });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.code_required, true);
  rewind('admin2');
  assert.equal((await reset('admin2', ids.kim, { password: PW, code: codeFor(secrets.admin2) })).status, 200);
  // And one admin can reset another.
  assert.equal((await reset('admin', ids.admin2, { password: PW })).status, 200);
});

// ── The ladder: the owner ─────────────────────────────────────────────────
test('RECOVERY_TOKEN resets one account and nothing else', { skip: !ready }, async () => {
  await enable('lee');
  await enable('max');
  const ip = newIp();
  const recover = (body) => send(S, { path: '/api/auth/two-step/recover', body, ip });
  assert.equal((await recover({ token: 'wrong', username: 'lee' })).status, 403);
  assert.equal((await recover({ token: RECOVERY_TOKEN.slice(0, -1), username: 'lee' })).status, 403, 'almost right');
  assert.equal((await recover({ username: 'lee' })).status, 403, 'no token');
  assert.equal((await recover({ token: RECOVERY_TOKEN, username: 'nobody' })).status, 404);
  assert.equal((await recover({ token: RECOVERY_TOKEN, username: 'Lee ' })).status, 200);
  assert.equal((await login('lee', ip)).status, 200, 'lee: password alone');
  assert.equal((await login('max', ip)).data.two_step, 'verify', 'max: still asked');
  assert.match(S.log, /lee \(id \d+\): reset with the RECOVERY_TOKEN/);
  assert.equal(S.log.includes(RECOVERY_TOKEN), false);
  // Every account is still there.
  assert.ok((await send(S, { method: 'GET', path: '/api/auth/users', bearer: tok.admin, ip })).data.length > 10);
});

test('npm run reset-2fa -- <username> resets one account, from the server', { skip: !ready }, async () => {
  const env = serverEnv(S.dir, 0);
  const out = execFileSync(process.execPath, ['scripts/reset-2fa.js', 'max'], { cwd: SERVER_DIR, env, encoding: 'utf8' });
  assert.match(out, /Two-step sign-in is off for max/);
  assert.equal((await login('max', newIp())).status, 200);
  const list = (() => { try { return execFileSync(process.execPath, ['scripts/reset-2fa.js'], { cwd: SERVER_DIR, env, encoding: 'utf8' }); } catch (e) { return e.stdout; } })();
  assert.match(list, /npm run reset-2fa -- <username>/);
  assert.match(list, /alice/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/reset-2fa.js', 'nobody'], { cwd: SERVER_DIR, env, stdio: 'pipe' }));
  assert.match(execFileSync(process.execPath, ['scripts/reset-2fa.js', 'max'], { cwd: SERVER_DIR, env, encoding: 'utf8' }), /already off/);
  // The package script is what the docs say to run. The Docker image runs
  // the server folder with the root package.json copied over its own, so
  // the root one has it too, working from either place.
  assert.equal(JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8')).scripts['reset-2fa'], 'node scripts/reset-2fa.js');
  const rootScript = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['reset-2fa'];
  assert.equal(rootScript, 'node scripts/reset-2fa.js');
  // In the image, /app/scripts is the server's scripts folder.
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY server\/ \./);
  assert.match(dockerfile, /COPY --from=build \/app\/package\.json \.\/package\.json/);
  // From a checkout: the root script runs the server's from the server folder.
  const fromRoot = execFileSync(process.execPath, ['scripts/reset-2fa.js', 'max'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8' });
  assert.match(fromRoot, /already off/);
  // docker exec skips the entrypoint: secrets given as *_FILE are read by the command itself.
  const secretFile = join(S.dir, 'jwt.secret');
  writeFileSync(secretFile, JWT_SECRET + '\n');
  const { JWT_SECRET: _drop, ...noSecret } = env;
  const viaFile = execFileSync(process.execPath, ['scripts/reset-2fa.js', 'max'], { cwd: SERVER_DIR, env: { ...noSecret, NODE_ENV: 'production', JWT_SECRET_FILE: secretFile }, encoding: 'utf8' });
  assert.match(viaFile, /already off/);
});

// ── Forgot Password ───────────────────────────────────────────────────────
test('a password reset link changes the password but never signs in past the code', { skip: !ready }, async () => {
  const ip = newIp();
  const db = openDb(S);
  const t = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(t, ids.alice, new Date(Date.now() + 3600e3).toISOString());
  db.close();
  const NEW = 'Reset-Pass-99!z';
  const r = await send(S, { path: '/api/auth/reset-password', body: { token: t, password: NEW }, ip });
  assert.equal(r.status, 401);
  assert.equal(r.data.password_changed, true);
  assert.equal(r.cookie, null);
  assert.equal(r.data.user, undefined);
  const l = await login('alice', ip, NEW);
  assert.equal(l.data.two_step, 'verify');
  // Someone without two-step sign-in is signed in by the link as before.
  const db2 = openDb(S);
  const t2 = crypto.randomBytes(16).toString('hex');
  db2.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(t2, ids.ned, new Date(Date.now() + 3600e3).toISOString());
  db2.close();
  const r2 = await send(S, { path: '/api/auth/reset-password', body: { token: t2, password: NEW }, ip });
  assert.equal(r2.status, 200);
  assert.ok(r2.cookie);
});

// ── Apps from before two-step sign-in ─────────────────────────────────────
test('an app from before two-step sign-in gets a plain error and no session', { skip: !ready }, async () => {
  const ip = newIp();
  const r = await login('bob', ip);
  // The Android app's sign-in (lib/server-signin.js passwordSignIn) as 1.4 shipped it.
  const signin = await import('../src/lib/server-signin.js');
  signin._useHttpForTests({ post: async () => ({ status: r.status, data: r.data }) });
  await assert.rejects(signin.passwordSignIn('https://nt.example', 'bob', PW), /uses two-step sign-in\. Update NutriTrace/);
  // The web sign-in page as cached before: !res.ok || !data.user shows the error.
  assert.ok(r.status >= 400 && !r.data.user && !r.data.token && !r.cookie);
});

// ── Require for everyone ──────────────────────────────────────────────────
test('require for everyone: setup right after the password, then codes; invites too; SSO-only accounts untouched', { skip: !ready }, async () => {
  const ip = newIp();
  const cfg = await send(S, { method: 'PUT', path: '/api/app-config', body: { key: 'two_step_required', value: 'true' }, bearer: tok.admin, ip });
  assert.equal(cfg.status, 200);
  const r = await login('ned', ip, 'Reset-Pass-99!z');
  assert.equal(r.status, 401);
  assert.equal(r.data.two_step, 'setup');
  assert.equal(r.cookie, null);
  const p = r.data.pending_token;
  // A setup token is no verify token and no session.
  assert.equal((await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: '123456' }, ip })).status, 401);
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/me', bearer: p, ip })).data.user, null);
  const start = await send(S, { path: '/api/auth/two-step/setup/start', body: { pending_token: p }, ip });
  assert.equal(start.status, 200);
  assert.equal((await send(S, { path: '/api/auth/two-step/setup/confirm', body: { pending_token: p, code: '000000' }, ip })).status, 400);
  const done = await send(S, { path: '/api/auth/two-step/setup/confirm', body: { pending_token: p, code: codeFor(start.data.secret) }, ip });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.recovery_codes.length, 10);
  assert.ok(done.data.token);
  assert.ok(done.cookie);
  assert.equal(done.data.user.two_step_enabled, true);
  // Used once.
  assert.equal((await send(S, { path: '/api/auth/two-step/setup/start', body: { pending_token: p }, ip })).status, 401);
  assert.equal((await login('ned', ip, 'Reset-Pass-99!z')).data.two_step, 'verify');

  // An invite accepted while it's required: the account, then setup.
  const inv = await send(S, { path: '/api/auth/invite', body: { role: 'user' }, bearer: tok.admin, ip });
  const invToken = new URL(inv.data.inviteUrl.replace('/#/', '/')).searchParams.get('token');
  const acc = await send(S, { path: '/api/auth/accept-invite', body: { token: invToken, username: 'olga', password: PW }, ip });
  assert.equal(acc.status, 401);
  assert.equal(acc.data.two_step, 'setup');
  assert.equal(acc.data.account_created, true);
  assert.equal(acc.cookie, null);

  // A single sign-on account (no password) can't set it up; the IdP does its own.
  const db = openDb(S);
  const sso = db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('ssouser', NULL, 'user')`).run().lastInsertRowid;
  db.close();
  const ssoTok = jwt().sign({ id: Number(sso), username: 'ssouser', role: 'user', csrf: 'x' }, JWT_SECRET, { expiresIn: '1h' });
  const st = await send(S, { method: 'GET', path: '/api/auth/two-step/status', bearer: ssoTok, ip });
  assert.equal(st.data.has_password, false);
  const sStart = await send(S, { path: '/api/auth/two-step/setup/start', body: {}, bearer: ssoTok, ip });
  assert.equal(sStart.status, 400);
  assert.match(sStart.data.error, /single sign-on/);

  await send(S, { method: 'PUT', path: '/api/app-config', body: { key: 'two_step_required', value: '' }, bearer: tok.admin, ip });
  assert.equal((await login('olga', ip)).status, 200, 'off again: password alone');
});

// ── Deletion and backup ───────────────────────────────────────────────────
test('backup keeps two-step sign-in; a backup from before it restores with it off; deleting an account removes its rows', { skip: !ready }, async () => {
  const AdmZip = serverRequire('adm-zip');
  const ip = newIp();
  const made = await send(S, { path: '/api/full-backup', bearer: tok.admin, ip });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const zip = new AdmZip(join(S.dir, 'backups', made.data.filename));
  const data = JSON.parse(zip.readAsText('database.json'));
  assert.ok(data.user_two_step.some((r) => r.user_id === ids.alice && r.enabled === 1));
  assert.ok(data.user_two_step_recovery.some((r) => r.user_id === ids.alice));
  assert.equal(JSON.stringify(data).includes(secrets.alice), false, 'the archive never has a secret in the clear');

  // Turn alice's off, restore: it's back, and her code works.
  assert.equal((await send(S, { path: `/api/auth/two-step/users/${ids.alice}/reset`, body: { password: PW }, bearer: tok.admin, ip })).status, 200);
  assert.equal((await send(S, { path: `/api/full-backup/${encodeURIComponent(made.data.filename)}/restore`, bearer: tok.admin, ip })).status, 200);
  rewind('alice');
  const p = (await login('alice', ip, 'Reset-Pass-99!z')).data.pending_token;
  assert.equal((await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: codeFor(secrets.alice) }, ip })).status, 200);

  // A backup from before two-step sign-in.
  delete data.user_two_step;
  delete data.user_two_step_recovery;
  const old = new AdmZip();
  old.addFile('database.json', Buffer.from(JSON.stringify(data)));
  const oldName = 'nutritrace-backup-2026-01-01T00-00-00.zip';
  old.writeZip(join(S.dir, 'backups', oldName));
  assert.equal((await send(S, { path: `/api/full-backup/${oldName}/restore`, bearer: tok.admin, ip })).status, 200);
  assert.equal((await login('bob', ip)).status, 200, 'off after an old backup');

  // Deleting accounts takes their rows.
  await enable('bob');
  assert.equal((await send(S, { method: 'DELETE', path: `/api/auth/users/${ids.bob}`, bearer: tok.admin, ip })).status, 200);
  await enable('kim');
  assert.equal((await send(S, { method: 'DELETE', path: '/api/auth/me', bearer: tok.kim, ip })).status, 200);
  const db = openDb(S);
  for (const t of ['user_two_step', 'user_two_step_recovery']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id IN (?, ?)`).get(ids.bob, ids.kim).n, 0, t);
  }
  db.close();
});

// ── A key that changed never locks anyone out ─────────────────────────────
test('a changed key: a plain message, recovery codes and resets still work; a short RECOVERY_TOKEN is refused', { skip: !ready }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-two-step-key-'));
  let s = await boot(dir, { TWO_STEP_KEY: 'first-key-0123456789abcdef0123456789' });
  try {
    await send(s, { path: '/api/auth/register', body: { username: 'owner', password: PW } });
    const t = (await send(s, { path: '/api/auth/login', body: { username: 'owner', password: PW } })).data.token;
    const start = await send(s, { path: '/api/auth/two-step/setup/start', body: { password: PW }, bearer: t });
    const done = await send(s, { path: '/api/auth/two-step/setup/confirm', body: { code: codeFor(start.data.secret) }, bearer: t });
    assert.equal(done.status, 200);
    assert.equal(existsSync(join(dir, 'two-step.key')), false, 'TWO_STEP_KEY set: no key file');
    await stop(s);

    s = await boot(dir, { TWO_STEP_KEY: 'another-key-0123456789abcdef012345', RECOVERY_TOKEN: 'short' });
    const p = (await send(s, { path: '/api/auth/login', body: { username: 'owner', password: PW } })).data.pending_token;
    const r = await send(s, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: codeFor(start.data.secret, 1) } });
    assert.equal(r.status, 409);
    assert.equal(r.data.key_problem, 'key_changed');
    assert.match(r.data.error, /recovery code/);
    const st = await send(s, { method: 'GET', path: '/api/auth/two-step/status', bearer: t });
    assert.equal(st.data.key_problem, 'key_changed');
    const ok = await send(s, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: done.data.recovery_codes[0] } });
    assert.equal(ok.status, 200);
    // RECOVERY_TOKEN too short to reset with: unavailable on the page
    // (which doesn't say how long it is), the reason in the log.
    const short = await send(s, { path: '/api/auth/two-step/recover', body: { token: 'short', username: 'owner' } });
    assert.equal(short.status, 503);
    assert.doesNotMatch(short.data.error, /short/);
    assert.match(s.log, /RECOVERY_TOKEN is shorter than 16 characters/);
    assert.match(s.log, /can't open the secret of owner \(key_changed\)/);

    // Single sign-on never links to an account with two-step sign-in on by
    // email alone: whoever holds the email at the identity provider would
    // skip the password and the code.
    const db = new (serverRequire('better-sqlite3'))(join(dir, 'nt.db'));
    db.prepare(`UPDATE users SET email = 'owner@example.test' WHERE username = 'owner'`).run();
    db.close();
    const probe = `
      const { resolveUser } = await import('./lib/oidc.js');
      const provider = { id: 99, display_name: 'Test IdP', auto_link_verified_email: 1, auto_register_new_users: 0 };
      try { resolveUser(provider, { sub: 'attacker', email: 'owner@example.test', email_verified: true }); console.log('LINKED'); }
      catch (e) { console.log('REFUSED: ' + e.message); }`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: SERVER_DIR, env: serverEnv(dir, 0, { TWO_STEP_KEY: 'another-key-0123456789abcdef012345', LOG_LEVEL: 'error' }), encoding: 'utf8' });
    assert.match(out, /REFUSED: .*two-step sign-in/);

    // Password login turned off after the password step: the code no longer signs in.
    const p2 = (await send(s, { path: '/api/auth/login', body: { username: 'owner', password: PW } })).data.pending_token;
    const db2 = new (serverRequire('better-sqlite3'))(join(dir, 'nt.db'));
    db2.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('enable_email_password_login', '0')`).run();
    db2.close();
    const off = await send(s, { path: '/api/auth/two-step/verify', body: { pending_token: p2, code: done.data.recovery_codes[1] } });
    assert.equal(off.status, 403);
    assert.equal(off.cookie, null);
  } finally {
    await stop(s);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Last: it stops RECOVERY_TOKEN for everyone for a while.
test('wrong RECOVERY_TOKENs from many addresses stop after thirty, on both Locked Out? actions', { skip: !ready }, async () => {
  let last;
  for (let i = 0; i < 31; i++) {
    // Half at disabling user management, half at the two-step reset: one count.
    const path = i % 2 ? '/api/auth/recover' : '/api/auth/two-step/recover';
    last = await send(S, { path, body: { token: `guess-${i}`, username: `u${i}` }, ip: i % 4 === 0 ? newIp() : `127.0.0.${_ipN - 1}` });
  }
  assert.equal(last.status, 429);
  assert.equal((await send(S, { path: '/api/auth/two-step/recover', body: { token: RECOVERY_TOKEN, username: 'alice' }, ip: newIp() })).status, 429);
  assert.equal((await send(S, { path: '/api/auth/recover', body: { token: RECOVERY_TOKEN }, ip: newIp() })).status, 429, 'the wipe is capped too');
  assert.ok((await send(S, { method: 'GET', path: '/api/auth/users', bearer: tok.admin, ip: newIp() })).data.length > 5, 'every account still there');
});
