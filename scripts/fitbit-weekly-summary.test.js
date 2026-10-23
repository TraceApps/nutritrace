/**
 * The weekly summary push goes once, on the delivery day the person chose.
 *
 * A Fitbit sync of a date range (the Wellness page's sync) also sent the
 * weekly summary whenever the server's clock said Sunday: every such sync,
 * on every Sunday, whatever Delivery Day was set (Settings > Notifications),
 * and outside the scheduler's once-a-week guard. The scheduler is now the
 * only sender.
 *
 * Against the real server on a clock set to a Sunday, with a stand-in ntfy:
 * two range syncs send no summary when the delivery day is Wednesday, and
 * the scheduler still sends one, once, to someone whose day is Sunday.
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
// Sunday 2026-10-18, 15:00 in New York; the clock keeps running from there.
const SUNDAY = Date.parse('2026-10-18T19:00:00Z');
const CLOCK = `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${SUNDAY} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;

let proc, base, dir, ntfy, tok, started;
const pushes = [];
const tokens = {};

test.before(async () => {
  if (!ready) return;
  ntfy = await new Promise((res) => {
    const s = http.createServer((req, resp) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        // Titles with emoji arrive RFC 2047-encoded, as ntfy accepts them.
        const title = String(req.headers.title || '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
        pushes.push({ topic: req.url.slice(1), title, body }); resp.end('{}');
      });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  dir = mkdtempSync(join(tmpdir(), 'nt-fitbit-weekly-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  started = Date.now();
  proc = spawn(process.execPath, ['--import', CLOCK, 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), TZ: 'America/New_York', PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'),
      JWT_SECRET: 'fitbit-weekly-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', PUBLIC_URL: base,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const j = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(r.ok, `${method} ${p} -> ${r.status}`);
    return r.json();
  };
  // Fran's delivery day is Wednesday; Sam's is Sunday at 15:00, the clock's hour.
  for (const [name, day, time] of [['fit', 3, '09:00'], ['sam', 0, '15:00']]) {
    // Fran is the first account (the admin), and adds Sam.
    tok = tokens.fit || null;
    await j('POST', '/api/auth/register', { username: name, password: PW, full_name: name === 'fit' ? 'Fran Fit' : 'Sam Sunday' });
    tok = (await j('POST', '/api/auth/login', { username: name, password: PW })).token;
    for (const [key, value] of Object.entries({
      notifPushService: 'ntfy', ntfyUrl: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: `nt-${name}`,
      notifWeeklySummary: true, weeklySummaryDay: day, weeklySummaryTime: time, timezone: 'America/New_York',
    })) await j('PUT', '/api/settings', { key, value });
    // Fitbit steps for the last few days, so a summary has something to say.
    const wellness = [];
    for (let i = 0; i < 5; i++) {
      const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      wellness.push({ date, source: 'fitbit', metric_type: 'steps', value: 9000 + i * 100 });
    }
    await j('POST', '/api/sync/push', { wellness });
    tokens[name] = tok;
  }
  tok = tokens.fit;
});
test.after(() => { proc?.kill(); ntfy?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test('a Fitbit range sync on a Sunday sends no weekly summary when the delivery day is Wednesday', { skip: !ready && 'server packages missing' }, async () => {
  for (let n = 0; n < 2; n++) {
    const r = await fetch(base + '/api/wellness/fitbit/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ from: '2026-10-17', to: '2026-10-18' }) });
    assert.equal(r.status, 200);
  }
  await sleep(1500);
  const weekly = pushes.filter((p) => p.topic === 'nt-fit' && /Weekly Summary/.test(p.title));
  assert.equal(weekly.length, 0, `weekly summaries sent by the syncs: ${weekly.length} (${JSON.stringify(weekly)})`);
});

test('the scheduler is the only sender of the weekly summary', () => {
  const sends = [];
  for (const f of ['routes/fitbit.js', 'routes/google-health.js', 'routes/garmin.js', 'routes/withings.js', 'lib/scheduler.js']) {
    const src = readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
    if (/sendWeeklySummary\b/.test(src)) sends.push(f);
  }
  assert.deepEqual(sends, ['lib/scheduler.js']);
});

test('the scheduler sends the summary on the chosen day', { skip: !ready && 'server packages missing' }, async () => {
  // Its first pass runs 30 s after the server starts; allow a slow start.
  const samSent = () => pushes.filter((p) => p.topic === 'nt-sam' && /Weekly Summary/.test(p.title));
  const until = started + 90000;
  while (Date.now() < until && samSent().length === 0) await sleep(500);
  await sleep(2000);
  const sam = samSent();
  assert.equal(sam.length, 1, `Sam's summaries: ${sam.length}`);
  assert.match(sam[0].body, /Avg steps/);
  assert.equal(pushes.filter((p) => p.topic === 'nt-fit' && /Weekly Summary/.test(p.title)).length, 0, 'none for Fran, whose day is Wednesday');
});
