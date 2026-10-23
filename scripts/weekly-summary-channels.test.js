/**
 * The weekly summary goes to every channel the person has, once, on their day.
 *
 * The scheduler checked for a push service before anything else, so someone
 * with Weekly Summary on and an email address, but no ntfy, Gotify or
 * Apprise, never got the weekly email. The summary now has its own step:
 * on the chosen day and hour, once a week, a push where a push service is
 * set and an email where the server can send mail and the person has an
 * address. Someone with neither gets nothing, as before, and nothing is
 * marked as sent for them.
 *
 * Against the real server on a clock set to Sunday 15:00 New York, with a
 * stand-in ntfy and SMTP server; the scheduler's first pass runs 30 s in.
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
const SUNDAY = Date.parse('2026-10-18T19:00:00Z'); // Sunday 15:00 in New York
const CLOCK = `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${SUNDAY} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;

// name: [push service?, email address?, delivery day]
const PEOPLE = {
  push: [true, false, 0],
  mail: [false, true, 0],
  both: [true, true, 0],
  neither: [false, false, 0],
  mailwed: [false, true, 3],
};

let proc, base, dir, ntfy, smtp, started;
const pushes = [], mails = [];
const ids = {};

test.before(async () => {
  if (!ready) return;
  ntfy = await new Promise((res) => {
    const s = http.createServer((req, resp) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const title = String(req.headers.title || '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
        pushes.push({ topic: req.url.slice(1), title }); resp.end('{}');
      });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  smtp = await new Promise((res) => {
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
  dir = mkdtempSync(join(tmpdir(), 'nt-weekly-channels-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  started = Date.now();
  proc = spawn(process.execPath, ['--import', CLOCK, 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'America/New_York', PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'),
      JWT_SECRET: 'weekly-channels-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', PUBLIC_URL: base,
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_FROM: 'nt@example.com',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  let tok = null;
  const j = async (method, p, body, t = tok) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(r.ok, `${method} ${p} -> ${r.status}`);
    return r.json();
  };
  // The first account is the admin and adds the others.
  await j('POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
  tok = (await j('POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  for (const [name, [push, email, day]] of Object.entries(PEOPLE)) {
    const { user } = await j('POST', '/api/auth/register', { username: name, password: PW, full_name: name, ...(email ? { email: `${name}@example.com` } : {}) });
    ids[name] = user.id;
    const t = (await j('POST', '/api/auth/login', { username: name, password: PW }, null)).token;
    const settings = { notifWeeklySummary: true, weeklySummaryDay: day, weeklySummaryTime: '15:00', timezone: 'America/New_York' };
    if (push) Object.assign(settings, { notifPushService: 'ntfy', ntfyUrl: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: `nt-${name}` });
    for (const [key, value] of Object.entries(settings)) await j('PUT', '/api/settings', { key, value }, t);
    // Something to summarize: Fitbit steps for the push, a diary day for the email.
    const wellness = [];
    for (let i = 0; i < 4; i++) wellness.push({ date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), source: 'fitbit', metric_type: 'steps', value: 9000 });
    await j('POST', '/api/sync/push', { wellness }, t);
    const date = new Date(SUNDAY - 2 * 86400000).toISOString().slice(0, 10);
    await j('PUT', `/api/diary/${date}`, { items: [{ name: 'Oats', quantity: 1, nutrition: { calories: 400 }, meal: 0, uuid: `o-${name}` }], water: [], body_stats: {}, notes: '' }, t);
  }
  // Setup has to finish before the scheduler's first pass (30 s after start).
  assert.ok(Date.now() < started + 28000, `setup took ${Math.round((Date.now() - started) / 1000)} s, past the scheduler's first pass: rerun on a less busy machine`);
  // The scheduler's first pass, then a moment for the sends.
  while (Date.now() < started + 33000) await sleep(500);
  for (let i = 0; i < 60 && pushes.length + mails.length < 4; i++) await sleep(500);
  await sleep(2000);
});
test.after(() => { proc?.kill(); ntfy?.close(); smtp?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const pushesTo = (name) => pushes.filter((p) => p.topic === `nt-${name}` && /Weekly Summary/.test(p.title)).length;
const mailsTo = (name) => mails.filter((m) => new RegExp(`^To: ${name}@example\\.com`, 'm').test(m) && /Weekly Summary/.test(m)).length;

test('push only: one push, no email', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(pushesTo('push'), 1);
  assert.equal(mailsTo('push'), 0);
});

test('email only (no push service): one email', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(mailsTo('mail'), 1);
  assert.equal(pushesTo('mail'), 0);
});

test('both: one push and one email', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(pushesTo('both'), 1);
  assert.equal(mailsTo('both'), 1);
});

test('neither channel: nothing sent, nothing marked as sent', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(pushesTo('neither') + mailsTo('neither'), 0);
  const Database = serverRequire('better-sqlite3');
  const db = new Database(join(dir, 'nt.db'), { readonly: true });
  try {
    const marks = db.prepare(`SELECT key FROM app_config WHERE key LIKE '\\_sched\\_%\\_weekly' ESCAPE '\\'`).all().map((r) => r.key).sort();
    assert.deepEqual(marks, [`_sched_${ids.both}_weekly`, `_sched_${ids.mail}_weekly`, `_sched_${ids.push}_weekly`].sort(), 'marked once for each person it went to, and only them');
  } finally { db.close(); }
});

test('not on another day: an email-only person whose day is Wednesday gets nothing', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(mailsTo('mailwed') + pushesTo('mailwed'), 0);
});
