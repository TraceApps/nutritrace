/**
 * A scheduled fast starts at the person's own time and marks their own day.
 *
 * The server's schedule check read the server's clock and marked the day it
 * fired with the UTC date. On a server in UTC, a New York evening fast at
 * 23:00 was due at 19:00 instead, and the "fired today" mark (shared with
 * the app, which also used the UTC date) said tomorrow, so the next day's
 * fast was skipped. Both now use the person's calendar day and clock: the
 * server through their timezone setting, the app through the device.
 *
 * Also: for the hour after midnight, Node 20's ICU writes the hour as "24";
 * the schedule check reads it as 0, so just after midnight an evening fast
 * isn't taken as hours late (which would mark the new day as done).
 *
 * The real server and scheduler (first pass 30 s in), in UTC, for a person
 * in New York.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const clock = (iso) => `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${Date.parse(iso)} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;

const RUNS = {
  // 23:30 on Thursday Oct 15 in New York; 03:30 on the 16th in UTC.
  evening: { now: '2026-10-16T03:30:00Z', time: '23:00' },
  // 00:15 on Friday Oct 16 in New York, with a 20:00 fast: not due yet.
  midnight: { now: '2026-10-16T04:15:00Z', time: '20:00' },
};
const results = {};
const procs = [];

async function run(name, { now, time }) {
  const dir = mkdtempSync(join(tmpdir(), 'nt-fasting-day-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const proc = spawn(process.execPath, ['--import', clock(now), 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'nt.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'fasting-day-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: 'ignore',
  });
  procs.push({ proc, dir });
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
  await j('POST', '/api/auth/register', { username: 'faster', password: 'Str0ng-Pass-77!x' });
  tok = (await j('POST', '/api/auth/login', { username: 'faster', password: 'Str0ng-Pass-77!x' })).token;
  for (const [key, value] of Object.entries({ timezone: 'America/New_York', fastingEnabled: true, fastingScheduleEnabled: true, fastingScheduleTime: time, fastingScheduleDays: [0, 1, 2, 3, 4, 5, 6], fastingScheduleGoal: 16 })) {
    await j('PUT', '/api/settings', { key, value });
  }
  assert.ok(Date.now() < started + 28000, "setup ran past the scheduler's first pass: rerun on a less busy machine");
  return { dir, started };
}

function readState(dir) {
  const Database = serverRequire('better-sqlite3');
  const db = new Database(join(dir, 'nt.db'), { readonly: true });
  try {
    const fasts = db.prepare('SELECT start_at FROM fasts WHERE deleted_at IS NULL').all();
    const mark = db.prepare(`SELECT value FROM user_settings WHERE key = 'fastingScheduleLastFired'`).get()?.value ?? null;
    return { fasts: fasts.length, mark: mark ? JSON.parse(mark) : null };
  } finally { db.close(); }
}

test.before(async () => {
  if (!ready) return;
  const runs = Object.fromEntries(await Promise.all(Object.entries(RUNS).map(async ([name, r]) => [name, await run(name, r)])));
  // The evening fast appearing shows the scheduler has run (up to 90 s for a
  // slow start); the midnight server started at the same time, so a few
  // seconds more covers its first pass too.
  const until = runs.evening.started + 90000;
  while (Date.now() < until && readState(runs.evening.dir).fasts === 0) await sleep(500);
  await sleep(5000);
  for (const [name, { dir }] of Object.entries(runs)) results[name] = readState(dir);
});
test.after(() => { for (const { proc, dir } of procs) { proc.kill(); rmSync(dir, { recursive: true, force: true }); } });

test('a 23:00 fast for someone in New York starts at 23:30 their time, marked on their day', { skip: !ready && 'server packages missing' }, () => {
  assert.deepEqual(results.evening, { fasts: 1, mark: '2026-10-15' });
});

test('just after midnight, a 20:00 fast is not due, and the new day is not marked', { skip: !ready && 'server packages missing' }, () => {
  assert.deepEqual(results.midnight, { fasts: 0, mark: null });
});

test('the app marks the day it started a scheduled fast with this device\'s day', () => {
  const src = readFileSync(new URL('../src/stores/fasting.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function checkScheduleAndStart'), src.indexOf('export function fastingStats'));
  assert.match(fn, /const todayStr = today\.toLocaleDateString\('sv-SE'\);/);
  assert.doesNotMatch(fn, /toISOString\(\)\.slice\(0, 10\)/);
  // What that reads at 23:30 in New York: the 15th, where the UTC date said the 16th.
  const out = execFileSync(process.execPath, ['-e', `const t = new Date('2026-10-16T03:30:00Z'); process.stdout.write(t.toLocaleDateString('sv-SE') + ' ' + t.toISOString().slice(0, 10));`], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(out, '2026-10-15 2026-10-16');
});

test('the forced sync fetches the person\'s today', () => {
  const src = readFileSync(new URL('../server/lib/scheduler.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function forceSync'));
  assert.match(fn.slice(0, 400), /const today = _getUserLocalTime\(userId\)\.dateStr;/);
  assert.match(src, /const lateMin = _localMinutes\(local\) - \(hh \* 60 \+ mm\);/);
});
