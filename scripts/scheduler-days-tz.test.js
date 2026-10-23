/**
 * The scheduled wellness sync fetches the right days in every time zone.
 *
 * The scheduler listed the days to fetch by reading each date as the
 * server's local noon and taking its UTC date, and found the first day by
 * stepping from "now" in local time. On a server at UTC+13/+14 (New Zealand
 * in summer, Tonga, Samoa) every day came out one early, so today was never
 * fetched. Without a timezone setting, "today" was also the UTC date while
 * the hour and weekday were local. The days are now calendar days.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const src = readFileSync(new URL('../server/lib/scheduler.js', import.meta.url), 'utf8');
const lib = new URL('../server/lib/scheduler.js', import.meta.url).href;

for (const TZ of ['Pacific/Auckland', 'Pacific/Tongatapu', 'Pacific/Kiritimati', 'UTC', 'America/New_York', 'Pacific/Honolulu']) {
  test(`a three-day sync ending today lists the three calendar days, in ${TZ}`, { skip: !ready && 'server packages missing' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'nt-sched-days-'));
    try {
      const script = `
        const { dayList, shiftDay } = await import(${JSON.stringify(lib)});
        const out = { week: dayList(shiftDay('2026-10-16', -2), '2026-10-16'), year: dayList('2025-12-30', '2026-01-02'), leap: shiftDay('2024-03-01', -1) };
        process.stdout.write(JSON.stringify(out)); process.exit(0);`;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: new URL('../server/', import.meta.url).pathname,
        env: { PATH: process.env.PATH, HOME: process.env.HOME || dir, TZ, DB_PATH: join(dir, 'nt.db'), LOG_LEVEL: 'error' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
      });
      const r = JSON.parse(out.slice(out.lastIndexOf('{"week"')));
      assert.deepEqual(r.week, ['2026-10-14', '2026-10-15', '2026-10-16']);
      assert.deepEqual(r.year, ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
      assert.equal(r.leap, '2024-02-29');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('the scheduled Fitbit sync and its first day use calendar days, and the fallback today is local', () => {
  assert.match(src, /const days = dayList\(from, today\);/);
  assert.match(src, /return shiftDay\(today, -\(range - 1\)\);/);
  assert.match(src, /dateStr: now\.toLocaleDateString\('sv-SE'\)/);
  assert.doesNotMatch(src, /new Date\(from \+ 'T12:00:00'\)|new Date\(today \+ 'T12:00:00'\)/);
});
