/**
 * The backup schedule runs at the time picked, on the clock of whoever picked
 * it, and backups are named in that time (TraceApps/notetrace#44, ported to NutriTrace).
 *
 * Before: the server read "02:00" in its own zone (UTC on a container without
 * TZ), so a New York admin's 2:00 AM backup ran at 10:00 PM the evening
 * before, and every file was named in UTC.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  isValidTimeZone, zonedParts, zonedTimeToInstant, scheduledInstantToday, nextScheduledInstant, zonedStamp,
} from '../server/lib/zoned-time.js';
import { isBackupDue, nextBackupAt, backupFileStamp, effectiveTimeZone, backupNameInstant, newestFirst } from '../server/lib/backup-schedule.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const iso = (t) => new Date(t).toISOString();
const NY = 'America/New_York';

test('a wall-clock time in a zone is the right instant, daylight saving included', () => {
  assert.equal(iso(zonedTimeToInstant(2026, 10, 21, 2, 0, NY)), '2026-10-21T06:00:00.000Z');
  assert.equal(iso(zonedTimeToInstant(2026, 1, 21, 2, 0, NY)), '2026-01-21T07:00:00.000Z');
  // Clocks skip 02:00 to 03:00: 02:30 runs at the first moment after the skip.
  assert.equal(iso(zonedTimeToInstant(2026, 3, 8, 2, 30, NY)), '2026-03-08T07:00:00.000Z');
  // Clocks go back: 01:30 happens twice, and it's the first.
  assert.equal(iso(zonedTimeToInstant(2026, 11, 1, 1, 30, NY)), '2026-11-01T05:30:00.000Z');
  // The same in Europe (last Sundays of March and October).
  assert.equal(iso(zonedTimeToInstant(2026, 3, 29, 2, 30, 'Europe/Berlin')), '2026-03-29T01:00:00.000Z');
  assert.equal(iso(zonedTimeToInstant(2026, 10, 25, 2, 30, 'Europe/Berlin')), '2026-10-25T00:30:00.000Z');
  // A half-hour zone, and one ahead of UTC across midnight.
  assert.equal(iso(zonedTimeToInstant(2026, 10, 21, 2, 0, 'Asia/Kolkata')), '2026-10-20T20:30:00.000Z');
  assert.equal(iso(zonedTimeToInstant(2026, 10, 21, 2, 0, 'UTC')), '2026-10-21T02:00:00.000Z');
  assert.deepEqual(zonedParts(Date.UTC(2026, 9, 21, 22, 16, 9), NY), { year: 2026, month: 10, day: 21, hour: 18, minute: 16, second: 9 });
});

test('zones are checked, and a file name reads the local time', () => {
  for (const z of [NY, 'UTC', 'Asia/Kolkata', 'Europe/Berlin']) assert.ok(isValidTimeZone(z), z);
  for (const z of ['', 'Nope/Zone', 'America/New York', null, 42, 'x'.repeat(80)]) assert.equal(isValidTimeZone(z), false, String(z));
  assert.equal(zonedStamp(Date.UTC(2026, 9, 22, 2, 0, 0), NY), '2026-10-21T22-00-00');
  assert.equal(zonedStamp(Date.UTC(2026, 9, 22, 2, 0, 0), 'UTC'), '2026-10-22T02-00-00');
  assert.equal(scheduledInstantToday(Date.UTC(2026, 9, 21, 12), '25:00', NY), null);
});

// The server checks every 15 minutes: step a clock that way over days and
// record when backups run, and what Next said just before each one.
function simulate(cfg, { from, days, phase = 0, down = null, change = null }) {
  let state = { ...cfg };
  const runs = [], wrongNext = [];
  let predicted = null;
  for (let t = from + phase; t < from + days * 86_400_000; t += 15 * 60_000) {
    if (change && t >= change.at && !change.done) { state = { ...state, ...change.cfg }; change.done = true; predicted = nextBackupAt(state, t); }
    if (down && t >= down[0] && t < down[1]) continue;
    if (isBackupDue(state, t)) {
      // Next said this run would come at most one check before it did.
      if (predicted && (t - new Date(predicted).getTime() >= 15 * 60_000 || new Date(predicted).getTime() > t)) wrongNext.push([iso(t), predicted]);
      state = { ...state, lastAutoRun: iso(t) };
      runs.push(t);
    }
    predicted = nextBackupAt(state, t);
  }
  return { runs, wrongNext };
}
const wall = (t, tz) => { const p = zonedParts(t, tz); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
// Every run within one 15-minute check of the set time, in that zone, except catch-ups listed.
function onTime(runs, time, tz, except = []) {
  const [h, m] = time.split(':').map(Number);
  return runs.filter(t => !except.includes(iso(t))).every(t => {
    const p = zonedParts(t, tz);
    const mins = ((p.hour * 60 + p.minute) - (h * 60 + m) + 1440) % 1440;
    return mins < 15 || (p.hour === 3 && h === 2); // a skipped 02:xx runs at 03:00
  });
}

test('a 2:00 AM New York schedule runs at 2:00 AM New York, not 2:00 AM UTC', () => {
  // Yesterday's backup ran at 2:00 AM New York (06:00 UTC on the 21st); 10:00 PM is when dev ran it.
  const cfg = { schedule: 'daily', time: '02:00', timeZone: NY, lastAutoRun: '2026-10-21T06:00:00Z' };
  assert.equal(isBackupDue(cfg, Date.UTC(2026, 9, 22, 2, 0)), false);
  assert.equal(isBackupDue(cfg, Date.UTC(2026, 9, 22, 6, 0)), true);
  assert.equal(nextBackupAt(cfg, Date.UTC(2026, 9, 22, 2, 0)), '2026-10-22T06:00:00.000Z');
  // Nothing run yet: the first set time after it was set, even with a check landing past midnight.
  const fresh = { ...cfg, lastAutoRun: null, setAt: '2026-10-21T20:00:00Z' }; // set at 4 PM New York
  assert.equal(nextBackupAt(fresh, Date.UTC(2026, 9, 21, 21)), '2026-10-22T06:00:00.000Z');
  assert.equal(isBackupDue(fresh, Date.UTC(2026, 9, 22, 5, 45)), false);
  assert.equal(isBackupDue(fresh, Date.UTC(2026, 9, 22, 6, 7)), true);
  // Set before #44 and never run (no record of when): due at once.
  assert.equal(isBackupDue({ ...cfg, lastAutoRun: null }, Date.UTC(2026, 9, 22, 2, 0)), true);
  assert.equal(isBackupDue({ ...cfg, schedule: 'off' }, Date.UTC(2026, 9, 22, 6, 0)), false);
  const { runs, wrongNext } = simulate(cfg, { from: Date.UTC(2026, 9, 21, 12), days: 30 });
  assert.equal(runs.length, 30);
  assert.ok(onTime(runs, '02:00', NY), runs.map(t => wall(t, NY)).join(' '));
  assert.deepEqual(wrongNext, []);
});

test('runs stay on the set time over weeks: zone switch, near midnight, weekly, monthly, downtime', () => {
  // Switched from UTC to New York at 21:00 UTC: the next run is 2:00 AM New York, and it stays there.
  let s = simulate({ schedule: 'daily', time: '02:00', timeZone: 'UTC', lastAutoRun: '2026-10-21T02:00:00Z' },
    { from: Date.UTC(2026, 9, 21, 2, 15), days: 14, change: { at: Date.UTC(2026, 9, 21, 21), cfg: { timeZone: NY } } });
  assert.equal(iso(s.runs[0]), '2026-10-22T06:00:00.000Z');
  assert.ok(onTime(s.runs, '02:00', NY), s.runs.map(t => wall(t, NY)).join(' '));
  assert.equal(s.runs.length, 13, 'Oct 22 to Nov 3: one a day');
  assert.deepEqual(s.wrongNext, []);
  // 00:30, 23:55 in UTC and Kathmandu (+05:45), with checks that never land on the minute.
  for (const [time, tz, phase] of [['00:30', 'UTC', 0], ['23:55', 'UTC', 7 * 60_000], ['23:55', 'Asia/Kathmandu', 7 * 60_000], ['00:05', 'Asia/Kathmandu', 3 * 60_000]]) {
    s = simulate({ schedule: 'daily', time, timeZone: tz, lastAutoRun: null, setAt: iso(Date.UTC(2026, 2, 1)) }, { from: Date.UTC(2026, 2, 1), days: 20, phase });
    assert.ok(s.runs.length >= 19 && s.runs.length <= 20, `${time} ${tz}: ${s.runs.length} runs`);
    assert.ok(onTime(s.runs, time, tz), `${time} ${tz}: ${s.runs.map(t => wall(t, tz)).join(' ')}`);
    assert.deepEqual(s.wrongNext, [], `${time} ${tz}`);
  }
  // Weekly in the morning, through both clock changes: always that wall-clock time, 7 days apart.
  s = simulate({ schedule: 'weekly', time: '09:30', timeZone: NY, lastAutoRun: '2026-02-04T14:30:00Z' }, { from: Date.UTC(2026, 1, 5), days: 300 });
  assert.ok(onTime(s.runs, '09:30', NY), s.runs.map(t => wall(t, NY)).join(' '));
  assert.ok(s.runs.length >= 42 && s.runs.length <= 43, String(s.runs.length));
  assert.deepEqual(s.wrongNext, []);
  // Monthly (every 28 days) across spring forward, at a time the change skips once.
  s = simulate({ schedule: 'monthly', time: '02:30', timeZone: NY, lastAutoRun: '2026-02-08T07:30:00Z' }, { from: Date.UTC(2026, 1, 9), days: 120 });
  assert.deepEqual(s.runs.map(t => wall(t, NY)), ['03:00', '02:30', '02:30', '02:30'], 'only the skipped 02:30 on Mar 8 runs at 03:00');
  assert.deepEqual(s.wrongNext, []);
  // Down from 1:00 to 9:00 over a 2:00 run: one catch-up at 9:00, then 2:00 again, no drift, no burst.
  s = simulate({ schedule: 'daily', time: '02:00', timeZone: 'UTC', lastAutoRun: '2026-10-20T02:00:00Z' },
    { from: Date.UTC(2026, 9, 20, 2, 15), days: 6, down: [Date.UTC(2026, 9, 21, 1), Date.UTC(2026, 9, 21, 9)] });
  assert.equal(iso(s.runs[0]), '2026-10-21T09:00:00.000Z');
  assert.ok(onTime(s.runs, '02:00', 'UTC', [iso(s.runs[0])]), s.runs.map(iso).join(' '));
  assert.equal(s.runs.length, 6);
});

test('a schedule saved without a zone keeps running in the server\'s zone (TZ, else UTC)', () => {
  const run = (tz) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    const s = await import(${JSON.stringify(new URL('../server/lib/backup-schedule.js', import.meta.url).href)});
    console.log(JSON.stringify({
      zone: s.effectiveTimeZone(null),
      next: s.nextBackupAt({ schedule: 'daily', time: '02:00', timeZone: null, lastAutoRun: '2026-10-21T12:00:00Z' }, Date.UTC(2026, 9, 21, 13, 0)),
      stamp: s.backupFileStamp('', Date.UTC(2026, 9, 22, 2, 0)),
    }));`], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
  assert.deepEqual(JSON.parse(run('UTC').stdout.trim()), { zone: 'UTC', next: '2026-10-22T02:00:00.000Z', stamp: '2026-10-22T02-00-00+0000' });
  assert.deepEqual(JSON.parse(run(NY).stdout.trim()), { zone: NY, next: '2026-10-22T06:00:00.000Z', stamp: '2026-10-21T22-00-00-0400' });
  assert.equal(effectiveTimeZone('Not/AZone'), effectiveTimeZone(null), 'a bad saved zone falls back too');
});

test('a backup name says when it was made, old UTC names included', () => {
  assert.equal(iso(backupNameInstant('nutritrace-backup-2026-10-21T22-00-00-0400.zip')), '2026-10-22T02:00:00.000Z');
  assert.equal(iso(backupNameInstant('nutritrace-backup-2026-10-22T07-30-00+0530-2.zip')), '2026-10-22T02:00:00.000Z');
  assert.equal(iso(backupNameInstant('nutritrace-backup-2026-10-22T02-00-00.zip')), '2026-10-22T02:00:00.000Z');
  assert.equal(iso(backupNameInstant('nutritrace-backup-auto-2026-10-22T02-00-00-2.zip')), '2026-10-22T02:00:00.000Z');
  assert.equal(backupNameInstant('my-backup.zip'), null);
  assert.deepEqual(newestFirst([
    { name: 'my-backup.zip', mtime: Date.UTC(2026, 9, 23) },
    { name: 'nutritrace-backup-2026-10-22T02-00-00.zip', mtime: 0 },
    { name: 'nutritrace-backup-2026-10-21T23-00-00-0400.zip', mtime: 0 },
  ]).map(e => e.name), ['my-backup.zip', 'nutritrace-backup-2026-10-21T23-00-00-0400.zip', 'nutritrace-backup-2026-10-22T02-00-00.zip']);
});

test('nextScheduledInstant walks calendar days in the zone', () => {
  const t = nextScheduledInstant({ now: Date.UTC(2026, 2, 7, 12), time: '02:30', timeZone: NY });
  assert.equal(iso(t), '2026-03-08T07:00:00.000Z', 'the skipped 02:30 runs at 03:00');
  assert.equal(nextScheduledInstant({ now: Date.UTC(2026, 2, 7, 12), time: 'nope', timeZone: NY }), null);
});

// ── The server: saving the zone, naming and pruning files ───────────────
let backup = null, dir = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'nutritrace-backup-tz-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.UPLOADS_PATH = join(dir, 'uploads');
  mkdirSync(join(dir, 'uploads', 'backups'), { recursive: true });
  delete process.env.BACKUP_SCHEDULE; delete process.env.BACKUP_TIME; delete process.env.BACKUP_RETENTION;
  backup = await import('../server/routes/full-backup.js');
} catch { /* better-sqlite3 not built for this Node: the server half skips */ }
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('the schedule keeps the zone it was saved in, and names its files in it', { skip: !backup && 'needs better-sqlite3' }, () => {
  const before = backup.getScheduleConfig();
  assert.equal(before.timeZone, null, 'none until a browser saves one');
  assert.equal(before.runsIn, before.serverTimeZone);
  const cfg = backup.setScheduleConfig({ schedule: 'daily', time: '02:00', timeZone: NY });
  assert.deepEqual([cfg.timeZone, cfg.runsIn], [NY, NY]);
  assert.ok(cfg.nextRunAt, 'the next run is reported');
  assert.throws(() => backup.setScheduleConfig({ timeZone: 'Nope/Zone' }), /IANA time zone/);
  // A save without a zone (an older app, a retention change) leaves it alone.
  assert.equal(backup.setScheduleConfig({ retention: 5 }).timeZone, NY);
  const a = backup.createBackup({ now: Date.UTC(2026, 9, 22, 6, 0, 3) });
  assert.equal(a.filename, 'nutritrace-backup-2026-10-22T02-00-03-0400.zip');
  // Two in the same second: a second file, not an overwrite.
  const b = backup.createBackup({ now: Date.UTC(2026, 9, 22, 6, 0, 3) });
  assert.equal(b.filename, 'nutritrace-backup-2026-10-22T02-00-03-0400-2.zip');
  // The hour clocks go back happens twice: the offset tells the two apart.
  assert.notEqual(backupFileStamp(NY, Date.UTC(2026, 10, 1, 5, 30)), backupFileStamp(NY, Date.UTC(2026, 10, 1, 6, 30)));
  // A bad field saves nothing, not even the good ones beside it.
  assert.throws(() => backup.setScheduleConfig({ time: '05:00', retention: 3, timeZone: 'Nope/Zone' }), /IANA time zone/);
  assert.deepEqual([backup.getScheduleConfig().time, backup.getScheduleConfig().retention], ['02:00', 5]);
  // '' goes back to the server's zone.
  assert.equal(backup.setScheduleConfig({ timeZone: '' }).timeZone, null);
});

test('pruning keeps the newest backups by when they were made, old UTC names and new local ones mixed', { skip: !backup && 'needs better-sqlite3' }, () => {
  const bdir = join(dir, 'uploads', 'backups');
  for (const f of readdirSync(bdir)) rmSync(join(bdir, f));
  // A folder copied without its dates: every file has the same date, so only
  // the names can say which is newest. The old UTC name sorts after the newer
  // local ones as text.
  const files = [
    'nutritrace-backup-2026-10-22T02-00-00.zip',       // UTC name (before #44): 10 PM New York on the 21st
    'nutritrace-backup-2026-10-21T22-30-00-0400.zip',  // made after it
    'nutritrace-backup-2026-10-21T23-00-00-0400.zip',
  ];
  const copied = Date.UTC(2026, 11, 1) / 1000;
  for (const f of files) { writeFileSync(join(bdir, f), 'x'); utimesSync(join(bdir, f), copied, copied); }
  const deleted = backup.pruneOldBackups(2);
  assert.deepEqual(deleted, ['nutritrace-backup-2026-10-22T02-00-00.zip'], 'the oldest made goes, whatever its name');
});

test('the scheduler, the settings page and the phone use it', () => {
  const sched = read('../server/lib/scheduler.js');
  assert.match(sched, /if \(!isBackupDue\(cfg\)\) return;/);
  assert.doesNotMatch(sched, /now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\), hh, mm/);
  const page = read('../src/components/settings/SettingsBackup.svelte');
  assert.match(page, /patch\.time != null \|\| patch\.schedule != null\)\) patch = \{ \.\.\.patch, timeZone: browserZone \}/);
  assert.match(page, /saveSchedule\(\{ timeZone: browserZone \}\)/);
  assert.match(page, /nutritrace-backup-\$\{localFileStamp\(\)\}\.zip/);
  const phone = read('../src/lib/local-backup-scheduler.js');
  assert.match(phone, /\$\{AUTO_PREFIX\}\$\{localFileStamp\(\)\}\.zip/);
  assert.match(phone, /const due = isBackupDue\(\{/);
  assert.match(phone, /const autos = newestFirst\(/);
  assert.match(page, /nextBackupAt\(\{ \.\.\.cfg, timeZone: null \}\)/);
  assert.match(page, /&& !_sameZone\(scheduleCfg\.runsIn, browserZone\)\)/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.ok(en.settings_backup.full_backup.zone_differs.includes('{zone}') && en.settings_backup.full_backup.use_my_zone === 'Use My Time Zone');
});
