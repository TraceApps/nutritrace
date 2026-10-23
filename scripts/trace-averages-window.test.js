/**
 * Trace's diary averages cover the days before today, by the local calendar.
 *
 * get_diary_averages built its window of "the previous N days, excluding
 * today" from the UTC date of each day, while the diary keys days by the
 * local date. In the evening west of UTC that moved the window a day
 * forward: it took in today (often half logged) and dropped the oldest day.
 *
 * Runs the window code from Trace.svelte itself, with the diary's own
 * localDateStr, on a clock set to an evening, in several time zones.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
const db = readFileSync(new URL('../src/lib/db.js', import.meta.url), 'utf8');
const start = trace.indexOf('// Build the date window: the previous numDays days, excluding today.');
const window = trace.slice(start, trace.indexOf('\n            }\n', start) + 15);
// db.js has CRLF line ends.
const helper = /export (function localDateStr[\s\S]*?\r?\n\})/.exec(db)[1];

const CASES = [
  // 21:00 on Oct 15 in New York (01:00 on the 16th in UTC).
  { TZ: 'America/New_York', now: '2026-10-16T01:00:00Z', today: '2026-10-15' },
  { TZ: 'America/Los_Angeles', now: '2026-10-16T05:30:00Z', today: '2026-10-15' },
  // 07:00 on Oct 16 in Sydney (20:00 on the 15th in UTC).
  { TZ: 'Australia/Sydney', now: '2026-10-15T20:00:00Z', today: '2026-10-16' },
  { TZ: 'UTC', now: '2026-10-15T12:00:00Z', today: '2026-10-15' },
];

for (const c of CASES) {
  test(`a 7-day window in ${c.TZ} is the 7 local days before today`, () => {
    const script = `
      const R = Date, OFF = ${Date.parse(c.now)} - R.now();
      globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
      ${helper}
      const numDays = 7;
      ${window}
      process.stdout.write(JSON.stringify([...dates]));`;
    const got = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: c.TZ }, encoding: 'utf8' }));
    const want = [7, 6, 5, 4, 3, 2, 1].map((n) => { const d = new Date(`${c.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); });
    assert.deepEqual(got, want);
  });
}
