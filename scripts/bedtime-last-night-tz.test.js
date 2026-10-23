/**
 * The smart bedtime reminder reads last night's sleep in every time zone.
 *
 * It found "yesterday" by reading today as local noon and taking its UTC
 * date. On a server at UTC+13 or +14 (New Zealand in summer, Tonga, Samoa)
 * local noon is already the day before in UTC, so it read the night before
 * last and missed last night's sleep. It now steps back one calendar day.
 *
 * The real server and scheduler, on a clock at the bedtime minute, with a
 * stand-in ntfy; the scheduler's first pass runs 30 s in. One server in
 * Auckland, one in UTC as a control, side by side.
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
const clock = (ms) => `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${ms} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;

// 22:30 on Friday Oct 16 2026: in Auckland (UTC+13) and in UTC.
const RUNS = {
  'Pacific/Auckland': { now: Date.parse('2026-10-16T09:30:00Z'), today: '2026-10-16' },
  UTC: { now: Date.parse('2026-10-16T22:30:00Z'), today: '2026-10-16' },
};
const servers = [];
const pushes = [];
let ntfy;

async function boot(TZ, { now, today }) {
  const dir = mkdtempSync(join(tmpdir(), 'nt-bedtime-tz-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const proc = spawn(process.execPath, ['--import', clock(now), 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ, PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'bedtime-tz-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off', PUBLIC_URL: base },
    stdio: 'ignore',
  });
  servers.push({ proc, dir });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  let tok = null;
  const j = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(r.ok, `${method} ${p} -> ${r.status}`);
    return r.json();
  };
  await j('POST', '/api/auth/register', { username: 'sleeper', password: PW, full_name: 'Sam Sleeper' });
  tok = (await j('POST', '/api/auth/login', { username: 'sleeper', password: PW })).token;
  for (const [key, value] of Object.entries({
    notifPushService: 'ntfy', ntfyUrl: `http://127.0.0.1:${ntfy.address().port}`, ntfyTopic: `bed-${TZ.replace('/', '-')}`,
    notifBedtime: true, notifBedtimeTime: '22:30', notifBedtimeSmart: true, timezone: TZ,
  })) await j('PUT', '/api/settings', { key, value });
  // Five hours last night; nothing the night before.
  const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  await j('POST', '/api/sync/push', { wellness: [{ date: d.toISOString().slice(0, 10), source: 'fitbit', metric_type: 'sleep_duration_min', value: 300 }] });
  return started;
}

test.before(async () => {
  if (!ready) return;
  ntfy = await new Promise((res) => {
    const s = http.createServer((req, resp) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => { pushes.push({ topic: req.url.slice(1), body }); resp.end('{}'); });
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
  const starts = await Promise.all(Object.entries(RUNS).map(([TZ, r]) => boot(TZ, r)));
  // Setup has to finish before each scheduler's first pass (30 s after start).
  assert.ok(Date.now() < Math.min(...starts) + 28000, "setup ran past the scheduler's first pass: rerun on a less busy machine");
  const until = Math.max(...starts) + 33000;
  while (Date.now() < until) await sleep(500);
  for (let i = 0; i < 40 && pushes.length < 2; i++) await sleep(500);
});
test.after(() => {
  ntfy?.close();
  for (const { proc, dir } of servers) { proc.kill(); rmSync(dir, { recursive: true, force: true }); }
});

for (const TZ of Object.keys(RUNS)) {
  test(`the bedtime reminder in ${TZ} names last night's 5 hours`, { skip: !ready && 'server packages missing' }, () => {
    const got = pushes.filter((p) => p.topic === `bed-${TZ.replace('/', '-')}`);
    assert.equal(got.length, 1, `reminders: ${JSON.stringify(got)}`);
    assert.match(got[0].body, /You slept 5h last night/);
  });
}
