/**
 * Sign-in security follow-ups (#222), against the real server
 * (server/index.js on a scratch database). Nothing leaves the machine: the
 * server, and a stand-in identity provider, listen on 127.0.0.1 only.
 *
 * - Session versions (server/lib/session-version.js): a password change
 *   (own, by an emailed link, by an admin), two-step sign-in turned on or
 *   off or reset (admin, RECOVERY_TOKEN, npm run reset-2fa), and Sign Out
 *   Everywhere sign every session out, bearer and cookie alike. The device
 *   that made the change is given a new session and keeps going. A session
 *   from before this (no version) still works. API tokens are separate.
 * - The Android SSO hand-off: the deep link carries a code, single use,
 *   short lived, bound to the app's secret; the session is made when it is
 *   swapped. Older apps (no app_challenge) still get the token in the
 *   link, said in the log, unless OIDC_APP_LINK_TOKEN=off.
 * - Creating an API token takes a fresh check (password, the code when
 *   two-step sign-in is on, or a recent sign-in for a single sign-on
 *   account), and a chosen expiry.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { hotp, timeStep, base32Decode } from '../server/lib/totp.js';

// ── This app ───────────────────────────────────────────────────────────────
const APP = 'nutritrace';
const COOKIE = 'nt_token';
const DB_FILE = 'nt.db';
const CSRF = true;                                   // sessions carry a CSRF token
const V1 = { path: '/api/v1/foods', scope: 'read:foods' };
const ROLE = 'user';                                 // an everyday account's role
const SERVER_ENV = {};
const IMAGE_TOKEN = null;                            // LiftTrace: '_lt_t'

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const SERVER_DIR = fileURLToPath(new URL('../server/', import.meta.url));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
const NEW_PW = 'N3w-Pass-Word-88!y';
const JWT_SECRET = 'session-version-test-0123456789abcdef01234';
const RECOVERY_TOKEN = 'owner-recovery-token-0123456789abcdef';

let _ipN = 10;
const newIp = () => `127.0.0.${_ipN++}`;

function serverEnv(dir, port, extra = {}) {
  return {
    ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, DB_FILE), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'),
    JWT_SECRET, RECOVERY_TOKEN, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'info', UPDATE_CHECK: 'off', ...extra,
  };
}

async function boot(dir, extra = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], { cwd: SERVER_DIR, env: serverEnv(dir, port, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const srv = { proc, port, dir, extra, get log() { return log; } };
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

/** One request: { status, data, cookie, location } (cookie: the session cookie it set, if any). */
function send(srv, { method = 'POST', path, body, bearer, cookie, csrf, headers: extraHeaders, ip = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (cookie) headers.Cookie = `${COOKIE}=${cookie}`;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const payload = body == null || method === 'GET' ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers, localAddress: ip }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let data; try { data = JSON.parse(text); } catch { data = text; }
        const set = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith(`${COOKIE}=`) && !c.startsWith(`${COOKIE}=;`));
        resolve({ status: res.statusCode, data, location: res.headers.location, cookie: set ? decodeURIComponent(set.split(';')[0].slice(COOKIE.length + 1)) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const openDb = (srv) => new (serverRequire('better-sqlite3'))(join(srv.dir, DB_FILE));
const jwt = () => serverRequire('jsonwebtoken');
const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const codeFor = (secret, ahead = 0) => hotp(base32Decode(secret), timeStep() + ahead);
function rewind(srv, id) {
  const db = openDb(srv);
  db.prepare('UPDATE user_two_step SET last_step = 0 WHERE user_id = ?').run(id);
  db.close();
}

// ── One server for most tests ─────────────────────────────────────────────
let S = null;
const ids = {};
let adminTok = null;

const login = (name, password = PW, ip = newIp()) => send(S, { path: '/api/auth/login', body: { username: name, password }, ip });
/** A fresh account and two signed-in "devices": bearer tokens a and b, and a browser cookie. */
async function account(name, role = ROLE) {
  const r = await send(S, { path: '/api/auth/register', body: { username: name, password: PW, role }, bearer: adminTok });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ids[name] = r.data.user.id;
  const a = await login(name);
  const b = await login(name);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  return { a: a.data.token, b: b.data.token, cookie: b.cookie, csrf: claims(b.cookie).csrf };
}
const me = (who) => send(S, { method: 'GET', path: '/api/auth/me', ...who });
/** Signed in still? true, or 'ended' (signed out by a version change), or 'none'. */
async function state(who) {
  const r = await me(who);
  if (r.data?.user) return true;
  return r.data?.session_ended ? 'ended' : 'none';
}

test.before(async () => {
  if (!ready) return;
  const dir = mkdtempSync(join(tmpdir(), `${APP}-sessions-`));
  S = await boot(dir, SERVER_ENV);
  const reg = await send(S, { path: '/api/auth/register', body: { username: 'admin', password: PW } });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  ids.admin = reg.data.user.id;
  adminTok = (await login('admin')).data.token;
});
test.after(async () => { await stop(S); if (S?.dir) rmSync(S.dir, { recursive: true, force: true }); });

// ── Session versions ──────────────────────────────────────────────────────
test('a session from before versions (no sv) still works: the upgrade signs nobody out', { skip: !ready }, async () => {
  const d = await account('olda');
  const old = jwt().sign({ id: ids.olda, username: 'olda', role: ROLE, ...(CSRF ? { csrf: 'x' } : {}) }, JWT_SECRET, { expiresIn: '1h' });
  assert.equal(claims(old).sv, undefined);
  assert.equal(await state({ bearer: old }), true);
  assert.equal(await state({ cookie: old }), true);
  assert.equal(claims(d.a).sv, 0, 'new sessions carry the number');
  // After any change it's an old number like any other.
  const r = await send(S, { path: '/api/auth/sign-out-everywhere', bearer: d.a });
  assert.equal(r.status, 200);
  assert.equal(await state({ bearer: old }), 'ended');
});

test('a password change signs every other session out, bearer and cookie; the device that changed it keeps going', { skip: !ready }, async () => {
  const d = await account('pwc');
  const r = await send(S, { method: 'PUT', path: '/api/auth/password', body: { current_password: PW, new_password: NEW_PW }, bearer: d.a });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.session?.token, 'a new session in the answer');
  assert.equal(claims(r.data.session.token).sv, 1);
  if (CSRF) assert.equal(r.data.session.csrf, claims(r.data.session.token).csrf);
  assert.equal(await state({ bearer: r.data.session.token }), true, 'the changer keeps going');
  assert.equal(await state({ cookie: r.cookie }), true, 'and its new cookie');
  assert.equal(await state({ bearer: d.a }), 'ended', 'its old token is done too');
  assert.equal(await state({ bearer: d.b }), 'ended', 'the other device');
  assert.equal(await state({ cookie: d.cookie }), 'ended', 'the browser');
  // A route behind requireAuth says so with the 401.
  const two = await send(S, { method: 'GET', path: '/api/auth/two-step/status', bearer: d.b });
  assert.equal(two.status, 401);
  // Signing in with the new password works, at the new number.
  const l = await login('pwc', NEW_PW);
  assert.equal(l.status, 200);
  assert.equal(await state({ bearer: l.data.token }), true);
  assert.match(S.log, /\[sessions\] user id \d+: every session signed out \(password changed\)/);
  assert.equal(S.log.includes(d.a), false, 'the log never has a token');
});

test('an account that is gone is no session, but not "signed out on this device"', { skip: !ready }, async () => {
  const d = await account('gone');
  assert.equal((await send(S, { method: 'DELETE', path: `/api/auth/users/${ids.gone}`, bearer: adminTok })).status, 200);
  const r = await me({ bearer: d.a });
  assert.equal(r.data.user, null);
  assert.equal(r.data.session_ended, undefined);
});

test('a backup restore never brings a signed-out session back', { skip: !ready }, async () => {
  const d = await account('bkp');
  const made = await send(S, { path: '/api/full-backup', bearer: adminTok });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  await send(S, { path: '/api/auth/sign-out-everywhere', bearer: d.b });
  assert.equal(await state({ bearer: d.a }), 'ended');
  const restored = await send(S, { path: `/api/full-backup/${encodeURIComponent(made.data.filename)}/restore`, bearer: adminTok });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(await state({ bearer: d.a }), 'ended', 'still signed out after the restore');
  assert.equal(await state({ bearer: adminTok }), true, 'the admin who restored keeps going');
});

test('requireAuth says session_ended with its 401; an admin\'s stale session is no admin', { skip: !ready }, async () => {
  const other = (await login('admin')).data.token;
  const r = await send(S, { path: '/api/auth/sign-out-everywhere', bearer: adminTok });
  assert.equal(r.status, 200);
  adminTok = r.data.session.token;
  const stale = await send(S, { method: 'GET', path: '/api/auth/users', bearer: other });
  assert.equal(stale.status, 401);
  assert.equal(stale.data.session_ended, true);
  assert.match(stale.data.error, /signed out on this device/);
  assert.equal((await send(S, { method: 'GET', path: '/api/auth/users', bearer: adminTok })).status, 200);
  // A never-valid token is just not signed in.
  const none = await send(S, { method: 'GET', path: '/api/auth/users', bearer: 'nope' });
  assert.equal(none.status, 401);
  assert.equal(none.data.session_ended, undefined);
});

test('Sign Out Everywhere: every session ends, this one gets a new one; a browser sends its CSRF token', { skip: !ready }, async () => {
  const d = await account('soe');
  if (CSRF) {
    const noCsrf = await send(S, { path: '/api/auth/sign-out-everywhere', cookie: d.cookie });
    assert.equal(noCsrf.status, 403, 'a page on another site can\'t do it');
    assert.equal(await state({ bearer: d.a }), true, 'nothing happened');
  }
  assert.equal((await send(S, { path: '/api/auth/sign-out-everywhere' })).status, 401, 'no session');
  const r = await send(S, { path: '/api/auth/sign-out-everywhere', cookie: d.cookie, csrf: d.csrf });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.cookie, 'a new cookie');
  assert.equal(await state({ cookie: r.cookie }), true);
  assert.equal(await state({ bearer: r.data.session.token }), true);
  assert.equal(await state({ bearer: d.a }), 'ended');
  assert.equal(await state({ bearer: d.b }), 'ended');
  assert.equal(await state({ cookie: d.cookie }), 'ended');
  // The new session keeps the time of the real sign-in: never a fresh one.
  assert.equal(claims(r.data.session.token).auth_time, claims(d.cookie).iat);
  assert.match(S.log, /every session signed out \(Sign Out Everywhere\)/);
});

test('an admin setting a password signs that person out; the admin keeps going; their own takes Profile', { skip: !ready }, async () => {
  const d = await account('adm1');
  const r = await send(S, { method: 'PUT', path: `/api/auth/users/${ids.adm1}/password`, body: { new_password: NEW_PW }, bearer: adminTok });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.session, undefined, 'someone else: nothing for this device');
  assert.equal(await state({ bearer: d.a }), 'ended');
  assert.equal(await state({ cookie: d.cookie }), 'ended');
  assert.equal(await state({ bearer: adminTok }), true);
  assert.match(S.log, /every session signed out \(password set by an admin\) by admin/);
  // Their own, from Settings > Users: refused. Profile asks for the current
  // password; a stolen admin session alone can't set it and sign the owner out.
  const second = (await login('admin')).data.token;
  const own = await send(S, { method: 'PUT', path: `/api/auth/users/${ids.admin}/password`, body: { new_password: NEW_PW }, bearer: adminTok });
  assert.equal(own.status, 400);
  assert.match(own.data.error, /Profile/);
  assert.equal(await state({ bearer: second }), true, 'nothing changed');
  assert.equal((await login('admin')).status, 200, 'the password is the same');
});

test('a password reset by email link signs every session out', { skip: !ready }, async () => {
  const d = await account('rst');
  const t = crypto.randomBytes(16).toString('hex');
  const db = openDb(S);
  db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(t, ids.rst, new Date(Date.now() + 3600e3).toISOString());
  db.close();
  const r = await send(S, { path: '/api/auth/reset-password', body: { token: t, password: NEW_PW } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await state({ bearer: d.a }), 'ended');
  assert.equal(await state({ cookie: d.cookie }), 'ended');
  assert.equal(await state({ cookie: r.cookie }), true, 'the reset signs this browser in at the new number');
  assert.match(S.log, /every session signed out \(password reset by email link\)/);
});

test('two-step sign-in on, off, and every reset sign the account out; on and off keep this device', { skip: !ready }, async () => {
  const d = await account('tsv');
  // On: from Settings, with this session.
  const start = await send(S, { path: '/api/auth/two-step/setup/start', body: { password: PW }, bearer: d.a });
  assert.equal(start.status, 200);
  assert.equal(await state({ bearer: d.b }), true, 'starting setup changes nothing');
  const on = await send(S, { path: '/api/auth/two-step/setup/confirm', body: { code: codeFor(start.data.secret) }, bearer: d.a });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.recovery_codes.length, 10);
  let mine = on.data.session.token;
  assert.equal(await state({ bearer: mine }), true);
  assert.equal(await state({ bearer: d.a }), 'ended');
  assert.equal(await state({ bearer: d.b }), 'ended');
  assert.equal(await state({ cookie: d.cookie }), 'ended');
  // A pending token from before a change is done too.
  rewind(S, ids.tsv);
  const pending = (await login('tsv')).data.pending_token;
  assert.ok(pending);
  const soe = await send(S, { path: '/api/auth/sign-out-everywhere', bearer: mine });
  mine = soe.data.session.token;
  const late = await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: pending, code: codeFor(start.data.secret) } });
  assert.equal(late.status, 401);
  assert.equal(late.data.restart, true);
  // Off: password and code; this device keeps going.
  const other = await (async () => { rewind(S, ids.tsv); const p = (await login('tsv')).data.pending_token; return (await send(S, { path: '/api/auth/two-step/verify', body: { pending_token: p, code: codeFor(start.data.secret) } })).data.token; })();
  assert.equal(await state({ bearer: other }), true);
  rewind(S, ids.tsv);
  const off = await send(S, { path: '/api/auth/two-step/disable', body: { password: PW, code: codeFor(start.data.secret) }, bearer: mine });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(await state({ bearer: off.data.session.token }), true);
  assert.equal(await state({ bearer: other }), 'ended');
  assert.match(S.log, /every session signed out \(two-step sign-in turned on\)/);
  assert.match(S.log, /every session signed out \(two-step sign-in turned off by its owner\)/);

  // Resets: an admin's, RECOVERY_TOKEN, and the command line.
  const enable = async (bearer) => {
    const s1 = await send(S, { path: '/api/auth/two-step/setup/start', body: { password: PW }, bearer });
    const s2 = await send(S, { path: '/api/auth/two-step/setup/confirm', body: { code: codeFor(s1.data.secret) }, bearer });
    assert.equal(s2.status, 200, JSON.stringify(s2.data));
    return s2.data.session.token;
  };
  // Each on an account of its own: sign-in limits count per username.
  const ta = await account('tsa');
  let t = await enable(ta.a);
  const adminReset = await send(S, { path: `/api/auth/two-step/users/${ids.tsa}/reset`, body: { password: PW }, bearer: adminTok });
  assert.equal(adminReset.status, 200, JSON.stringify(adminReset.data));
  assert.equal(await state({ bearer: t }), 'ended');
  assert.equal(await state({ bearer: adminTok }), true, 'the admin keeps going');
  assert.match(S.log, /every session signed out \(two-step sign-in reset by an admin\) by admin/);

  t = await enable((await account('tsr')).a);
  const owner = await send(S, { path: '/api/auth/two-step/recover', body: { token: RECOVERY_TOKEN, username: 'tsr' }, ip: newIp() });
  assert.equal(owner.status, 200, JSON.stringify(owner.data));
  assert.equal(await state({ bearer: t }), 'ended');
  assert.match(S.log, /every session signed out \(two-step sign-in reset with the RECOVERY_TOKEN\)/);

  t = await enable((await account('tsc')).a);
  const out = execFileSync(process.execPath, ['scripts/reset-2fa.js', 'tsc'], { cwd: SERVER_DIR, env: serverEnv(S.dir, 0), encoding: 'utf8' });
  assert.match(out, /tsc/);
  assert.equal(await state({ bearer: t }), 'ended', 'the command line too');
});

if (IMAGE_TOKEN) {
  test(`the image address token (${IMAGE_TOKEN}) is checked like the others`, { skip: !ready }, async () => {
    const d = await account('imgt');
    const path = (tk) => `/api/auth/me?${IMAGE_TOKEN}=${encodeURIComponent(tk)}`;
    assert.ok((await send(S, { method: 'GET', path: path(d.a) })).data.user, 'works before');
    await send(S, { path: '/api/auth/sign-out-everywhere', bearer: d.b });
    const after = await send(S, { method: 'GET', path: path(d.a) });
    assert.equal(after.data.user, null);
    assert.equal(after.data.session_ended, true);
  });
}

// ── API tokens ────────────────────────────────────────────────────────────
const mint = (who, body) => send(S, { path: '/api/admin/api-tokens', body: { name: 'Test', scopes: [V1.scope], ...body }, ...who });
const useApi = (raw) => send(S, { method: 'GET', path: V1.path, bearer: raw });

test('API tokens are separate: a session change never touches them', { skip: !ready }, async () => {
  const r = await mint({ bearer: adminTok }, { password: PW, expires_in_days: null });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await useApi(r.data.raw)).status, 200);
  const soe = await send(S, { path: '/api/auth/sign-out-everywhere', bearer: adminTok });
  adminTok = soe.data.session.token;
  assert.equal((await useApi(r.data.raw)).status, 200, 'still works after Sign Out Everywhere');
  const pw = await send(S, { method: 'PUT', path: '/api/auth/password', body: { current_password: PW, new_password: NEW_PW }, bearer: adminTok });
  adminTok = pw.data.session.token;
  assert.equal((await useApi(r.data.raw)).status, 200, 'and after a password change');
  const back = await send(S, { method: 'PUT', path: '/api/auth/password', body: { current_password: NEW_PW, new_password: PW }, bearer: adminTok });
  adminTok = back.data.session.token;
  // An API token is never a session.
  assert.equal((await me({ bearer: r.data.raw })).data.user, null);
});

test('creating an API token takes the password, and the code when two-step sign-in is on', { skip: !ready }, async () => {
  const d = await account('mintr', 'admin');
  const who = { bearer: d.a };
  assert.equal((await mint(who, {})).status, 401, 'a session alone');
  const wrong = await mint(who, { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error, /password/);
  assert.equal((await mint(who, { password: PW })).status, 201);
  if (CSRF) {
    assert.equal((await mint({ cookie: d.cookie }, { password: PW })).status, 403, 'a browser sends its CSRF token');
    assert.equal((await mint({ cookie: d.cookie, csrf: d.csrf }, { password: PW })).status, 201);
  }
  // Two-step sign-in on: the code too.
  const s1 = await send(S, { path: '/api/auth/two-step/setup/start', body: { password: PW }, bearer: d.a });
  const s2 = await send(S, { path: '/api/auth/two-step/setup/confirm', body: { code: codeFor(s1.data.secret) }, bearer: d.a });
  const t = { bearer: s2.data.session.token };
  const noCode = await mint(t, { password: PW });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.code_required, true);
  rewind(S, ids.mintr);
  assert.equal((await mint(t, { password: PW, code: codeFor(s1.data.secret) })).status, 201);
  // Someone who isn't allowed tokens at all still isn't.
  const plain = await account('mintu');
  const user = await mint({ bearer: plain.a }, { password: PW });
  assert.ok([201, 403].includes(user.status), `status ${user.status}`);
});

test('a single sign-on account (no password) creates one within 15 minutes of signing in, never on a session given again', { skip: !ready }, async () => {
  const db = openDb(S);
  const sso = Number(db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('ssominter', NULL, 'admin')`).run().lastInsertRowid);
  db.close();
  const now = Math.floor(Date.now() / 1000);
  const tok = (ageSec) => jwt().sign({ id: sso, username: 'ssominter', role: 'admin', ...(CSRF ? { csrf: 'x' } : {}), iat: now - ageSec }, JWT_SECRET, { expiresIn: '2h' });
  const stale = await mint({ bearer: tok(20 * 60) }, {});
  assert.equal(stale.status, 401);
  assert.equal(stale.data.reauth, true);
  assert.match(stale.data.error, /15 minutes/);
  assert.equal((await mint({ bearer: tok(60) }, {})).status, 201);
  // Sign Out Everywhere from an old sign-in gives a new session, never a fresh check.
  const soe = await send(S, { path: '/api/auth/sign-out-everywhere', bearer: tok(20 * 60) });
  assert.equal(soe.status, 200);
  assert.equal((await mint({ bearer: soe.data.session.token }, {})).status, 401);
});

test('a token expires when chosen; no expiry stays available; a bad expiry is refused; older tokens keep working', { skip: !ready }, async () => {
  const who = { bearer: adminTok };
  const days = await mint(who, { password: PW, expires_in_days: 30 });
  assert.equal(days.status, 201, JSON.stringify(days.data));
  const at = Date.parse(days.data.token.expires_at.replace(' ', 'T') + 'Z');
  assert.ok(Math.abs(at - (Date.now() + 30 * 864e5)) < 120e3, days.data.token.expires_at);
  const never = await mint(who, { password: PW, expires_in_days: null });
  assert.equal(never.data.token.expires_at, null);
  for (const bad of [0, -1, 1.5, 4000, 'soon']) assert.equal((await mint(who, { password: PW, expires_in_days: bad })).status, 400, String(bad));
  assert.equal((await mint(who, { password: PW, expires_at: '2001-01-01 00:00:00' })).status, 400, 'a time gone by');
  assert.equal((await mint(who, { password: PW, expires_at: 'garbage' })).status, 400);
  assert.equal((await mint(who, { password: PW, expires_at: '2999-01-01 00:00:00' })).status, 400, 'more than ten years');
  const at400 = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const later = await mint(who, { password: PW, expires_at: at400 });
  assert.equal(later.data.token.expires_at, at400, 'an older page\'s expires_at');
  // Expired: refused. A token made before this (straight into the table): works.
  assert.equal((await useApi(days.data.raw)).status, 200);
  const db = openDb(S);
  db.prepare(`UPDATE api_tokens SET expires_at = '2001-01-01 00:00:00' WHERE id = ?`).run(days.data.token.id);
  db.close();
  assert.equal((await useApi(days.data.raw)).status, 401);
  assert.equal((await useApi(never.data.raw)).status, 200);
});

// ── Android SSO hand-off ──────────────────────────────────────────────────
// A stand-in identity provider on 127.0.0.1: discovery, /auth (signs in
// whoever `idp.user` says, at once), /token (an RS256 ID token), /jwks.
async function standInIdp() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idp = { user: { sub: 'sso-sub-1', email: 'sso1@idp.example' } };
  const server = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://x');
    const ib = `http://127.0.0.1:${server.address().port}`;
    const json = (o) => { rs.setHeader('content-type', 'application/json'); rs.end(JSON.stringify(o)); };
    if (u.pathname.endsWith('openid-configuration')) return json({ issuer: ib, authorization_endpoint: `${ib}/auth`, token_endpoint: `${ib}/token`, jwks_uri: `${ib}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
    if (u.pathname === '/jwks') return json({ keys: [jwk] });
    if (u.pathname === '/auth') {
      const c = crypto.randomUUID();
      codes.set(c, { ...idp.user, nonce: u.searchParams.get('nonce') });
      rs.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${c}&state=${u.searchParams.get('state')}` });
      return rs.end();
    }
    if (u.pathname === '/token') {
      let b = '';
      rq.on('data', (d) => { b += d; });
      rq.on('end', () => {
        const who = codes.get(new URLSearchParams(b).get('code'));
        const now = Math.floor(Date.now() / 1000);
        const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
        const p = b64({ iss: ib, aud: 'trace', sub: who.sub, email: who.email, email_verified: true, nonce: who.nonce, iat: now, exp: now + 300 });
        json({ access_token: 'at', token_type: 'Bearer', id_token: `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}` });
      });
      return;
    }
    rs.statusCode = 404; rs.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  idp.base = `http://127.0.0.1:${server.address().port}`;
  idp.close = () => new Promise((r) => server.close(r));
  return idp;
}
const plainGet = (url) => new Promise((res, rej) => http.get(url, (rs) => { rs.resume(); res({ status: rs.statusCode, location: rs.headers.location }); }).on('error', rej));
function addProvider(srv, idp) {
  const db = openDb(srv);
  const id = Number(db.prepare(`INSERT INTO oidc_providers (issuer_url, client_id, redirect_uris, token_endpoint_auth_method, display_name, is_active, auto_register, auto_register_new_users) VALUES (?, 'trace', ?, 'none', 'Test IdP', 1, 1, 1)`)
    .run(idp.base, JSON.stringify([`http://127.0.0.1:${srv.port}/api/auth/oidc/callback`])).lastInsertRowid);
  db.close();
  return id;
}
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
/** The app's sign-in, to the deep link the server ends on. */
async function appSignIn(srv, pid, query) {
  const start = await send(srv, { method: 'GET', path: `/api/auth/oidc/login/${pid}?mobile=1${query}` });
  assert.equal(start.status, 302, JSON.stringify(start.data));
  const atIdp = await plainGet(start.location);
  return (await plainGet(atIdp.location)).location;
}
const swap = (srv, code, verifier) => send(srv, { path: '/api/auth/oidc/handoff', body: { code, verifier } });

test('the Android SSO link carries a code: single use, short lived, bound to the app\'s secret; the session is made at the swap', { skip: !ready }, async () => {
  const idp = await standInIdp();
  try {
    const pid = addProvider(S, idp);
    const k = pkce();
    const link = await appSignIn(S, pid, `&app_challenge=${k.challenge}`);
    assert.match(link, new RegExp(`^${APP}://oidc-callback/\\?code=`));
    assert.doesNotMatch(link, /token=/);
    const code = new URL(link.replace(`${APP}://`, 'http://x/')).searchParams.get('code');
    // Kept with the code: the account, never a session.
    let db = openDb(S);
    const row = db.prepare(`SELECT * FROM oauth_state WHERE state = ?`).get(code);
    db.close();
    assert.ok(row.user_id);
    assert.equal(JSON.parse(row.data).token, undefined, 'no session at rest');
    // Another app that caught the link has the code but not the secret: it gets nothing, and the code is gone.
    assert.equal((await swap(S, code, pkce().verifier)).status, 400);
    assert.equal((await swap(S, code, k.verifier)).status, 400, 'single use, even after a wrong secret');

    // The right app: a session at the account's current number; once.
    const k2 = pkce();
    const code2 = new URL((await appSignIn(S, pid, `&app_challenge=${k2.challenge}`)).replace(`${APP}://`, 'http://x/')).searchParams.get('code');
    // Two swaps racing: one wins.
    const [r1, r2] = await Promise.all([swap(S, code2, k2.verifier), swap(S, code2, k2.verifier)]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 400]);
    const ok = r1.status === 200 ? r1 : r2;
    assert.equal(await state({ bearer: ok.data.token }), true);
    assert.equal(ok.data.provider_id, pid);

    // Expired: refused.
    const k3 = pkce();
    const code3 = new URL((await appSignIn(S, pid, `&app_challenge=${k3.challenge}`)).replace(`${APP}://`, 'http://x/')).searchParams.get('code');
    db = openDb(S);
    db.prepare(`UPDATE oauth_state SET expires_at = ? WHERE state = ?`).run(new Date(Date.now() - 1000).toISOString(), code3);
    db.close();
    assert.equal((await swap(S, code3, k3.verifier)).status, 400);

    // Signed out everywhere between the provider and the swap: the code went with the rest.
    const k4 = pkce();
    const code4 = new URL((await appSignIn(S, pid, `&app_challenge=${k4.challenge}`)).replace(`${APP}://`, 'http://x/')).searchParams.get('code');
    await send(S, { path: '/api/auth/sign-out-everywhere', bearer: ok.data.token });
    assert.equal((await swap(S, code4, k4.verifier)).status, 400);
    const k5 = pkce();
    const code5 = new URL((await appSignIn(S, pid, `&app_challenge=${k5.challenge}`)).replace(`${APP}://`, 'http://x/')).searchParams.get('code');
    const r5 = await swap(S, code5, k5.verifier);
    assert.equal(r5.status, 200);
    assert.equal(await state({ bearer: r5.data.token }), true, 'at the new number');

    // An older app (no app_challenge): the token in the link, said in the log.
    const old = await appSignIn(S, pid, '');
    assert.match(old, new RegExp(`^${APP}://oidc-callback/\\?token=`));
    assert.match(S.log, /an older \w+ app signed .* in with the session in the sign-in link/);
    const oldTok = new URL(old.replace(`${APP}://`, 'http://x/')).searchParams.get('token');
    assert.equal(await state({ bearer: oldTok }), true);
  } finally { await idp.close(); }
});

test('OIDC_APP_LINK_TOKEN=off refuses the older app\'s link and says to update; the code still works', { skip: !ready }, async () => {
  const idp = await standInIdp();
  const dir = mkdtempSync(join(tmpdir(), `${APP}-applink-`));
  const s = await boot(dir, { OIDC_APP_LINK_TOKEN: 'off' });
  try {
    await send(s, { path: '/api/auth/register', body: { username: 'owner', password: PW } });
    const pid = addProvider(s, idp);
    const old = await appSignIn(s, pid, '');
    assert.match(old, new RegExp(`^${APP}://oidc-callback/\\?error=`));
    assert.doesNotMatch(old, /token=/);
    assert.match(decodeURIComponent(old), /Update \w+ to sign in with single sign-on/);
    assert.match(s.log, /refused an older \w+ app's single sign-on/);
    const k = pkce();
    const link = await appSignIn(s, pid, `&app_challenge=${k.challenge}`);
    const code = new URL(link.replace(`${APP}://`, 'http://x/')).searchParams.get('code');
    assert.equal((await swap(s, code, k.verifier)).status, 200);
  } finally {
    await stop(s);
    rmSync(dir, { recursive: true, force: true });
    await idp.close();
  }
});
