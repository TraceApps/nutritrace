/**
 * Reminders and the weekly summary set just after midnight fire.
 *
 * The scheduler read the person's clock with Intl and `hour12: false`. On
 * Node 20 (the server image) that writes the hour after midnight as "24", so
 * from 00:00 to 00:59 the time read as 24:xx: a bedtime at 00:00, a weekly
 * summary at 00:00 and a wind-down before a bedtime just after midnight never
 * fired. The hour is now read with `hourCycle: 'h23'`, and the 15-minute
 * windows run across midnight, so a 23:55 reminder still fires at 00:03.
 *
 * The real server and scheduler (first pass 30 s in), on a UTC server, on a
 * clock at 00:03 on Sunday in New York, with a stand-in ntfy.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const NOW = Date.parse('2026-10-18T04:03:00Z'); // 00:03, Sunday Oct 18, New York
const CLOCK = `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${NOW} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;

// name: settings. Each has its own ntfy topic.
const PEOPLE = {
  bed0000: { notifBedtime: true, notifBedtimeTime: '00:00', notifBedtimeSmart: false },
  bed2355: { notifBedtime: true, notifBedtimeTime: '23:55', notifBedtimeSmart: false },
  bed2230: { notifBedtime: true, notifBedtimeTime: '22:30', notifBedtimeSmart: false },
  winddown: { notifBedtime: true, notifBedtimeTime: '00:30', notifBedtimeSmart: false, notifBedtimeWindDown: true, notifBedtimeWindDownMin: 35 },
  weekly0: { notifWeeklySummary: true, weeklySummaryDay: 0, weeklySummaryTime: '00:00' },
};
let proc, dir, ntfy, started;
const pushes = [];

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
  dir = mkdtempSync(join(tmpdir(), 'nt-midnight-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  started = Date.now();
  proc = spawn(process.execPath, ['--import', CLOCK, 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'midnight-hour-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
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
  await j('POST', '/api/auth/register', { username: 'admin', password: PW });
  tok = (await j('POST', '/api/auth/login', { username: 'admin', password: PW })).token;
  for (const [name, settings] of Object.entries(PEOPLE)) {
    await j('POST', '/api/auth/register', { username: name, password: PW });
    const t = (await j('POST', '/api/auth/login', { username: name, password: PW }, null)).token;
    const all = { ...settings, timezone: 'America/New_York', notifPushService: 'ntfy', ntfyUrl: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: `nt-${name}` };
    for (const [key, value] of Object.entries(all)) await j('PUT', '/api/settings', { key, value }, t);
    // Something for the weekly summary to say.
    await j('POST', '/api/sync/push', { wellness: [{ date: new Date(NOW - 86400000).toISOString().slice(0, 10), source: 'fitbit', metric_type: 'steps', value: 9000 }] }, t);
  }
  assert.ok(Date.now() < started + 28000, "setup ran past the scheduler's first pass: rerun on a less busy machine");
  // Wait for the first pass: the 23:55 bedtime fires on old and new code alike.
  for (let i = 0; i < 180 && !pushes.some((p) => p.topic === 'nt-bed2355'); i++) await sleep(500);
  await sleep(3000);
});
test.after(() => { proc?.kill(); ntfy?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const got = (name, re) => pushes.filter((p) => p.topic === `nt-${name}` && re.test(p.title)).length;

test('a bedtime at 00:00 fires at 00:03', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(got('bed0000', /Bedtime Reminder/), 1);
});
test('a bedtime at 23:55 still fires at 00:03 (its window crosses midnight)', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(got('bed2355', /Bedtime Reminder/), 1);
});
test('a bedtime at 22:30 does not fire at 00:03', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(got('bed2230', /Bedtime|Wind Down/), 0);
});
test('a wind-down 35 minutes before a 00:30 bedtime fires at 00:03 (from 23:55)', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(got('winddown', /Wind Down/), 1);
  assert.equal(got('winddown', /Bedtime Reminder/), 0);
});
test('a weekly summary at 00:00 on its day fires', { skip: !ready && 'server packages missing' }, () => {
  assert.equal(got('weekly0', /Weekly Summary/), 1);
});

test('one place reads the clock, and every 15-minute window runs across midnight', async () => {
  const src = readFileSync(new URL('../server/lib/scheduler.js', import.meta.url), 'utf8');
  assert.match(src, /hourCycle: 'h23'/);
  assert.doesNotMatch(src, /minute: 'numeric', hour12: false/);
  assert.doesNotMatch(src, /currentMin >= (targetMin|bedtimeMin|windDownTarget)|diff >= 0 && diff < 15/);
  assert.match(src, /const lateMin = _localMinutes\(local\) - \(hh \* 60 \+ mm\);/, 'the fasting check uses the same reading');
  if (!ready) return;
  const work = mkdtempSync(join(tmpdir(), 'nt-midnight-lib-'));
  process.env.DB_PATH = join(work, 'nt.db');
  try {
    const { inWindow } = await import('../server/lib/scheduler.js');
    assert.equal(inWindow(3, 1435), true, '23:55 at 00:03');
    assert.equal(inWindow(3, 0), true);
    assert.equal(inWindow(15, 0), false);
    assert.equal(inWindow(1439, 1430), true);
    assert.equal(inWindow(1430, 1439), false, 'not early');
    assert.equal(inWindow(600, 600), true);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
