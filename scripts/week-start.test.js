/**
 * First Day of Week (#232).
 *
 * NutriTrace started every week on Sunday: the Diary's week strip, every
 * calendar (Diary date picker, Statistics custom range, date fields) and
 * the lists of weekdays (goals and coach targets by weekday, fasting days,
 * the weekly summary day). Settings > Regional & Units now has First Day
 * of Week: Automatic (the device's locale), Monday, Sunday or Saturday.
 *
 * The rules checked here:
 * - week math for every setting and for locales, including browsers with
 *   no Intl weekInfo, across month, year and daylight-saving boundaries;
 * - month grids put every date under its own weekday;
 * - anything stored by weekday keeps its real weekdays (only the order
 *   shown changes);
 * - the weekly summary covers the chosen week, and with Automatic exactly
 *   the 7 days it always has (real server code, a stand-in SMTP server);
 * - the setting syncs (USER_PREFS) and every week-start spot reads it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FIRST_DAY_SETTINGS, explicitFirstDay, localeFirstDay, resolveFirstDay,
  weekdayOrder, inWeekOrder, weekdayOf, shiftIso, weekStartIso, weekIsos,
  leadingBlanks, weeklySummaryRange,
} from '../src/lib/week.js';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
// The summary's subject separates its parts with these.
const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);

// Locales

const hasWeekInfo = (() => {
  try { const L = new Intl.Locale('en-US'); return !!(L.getWeekInfo?.() || L.weekInfo); } catch { return false; }
})();

test('Automatic follows the locale: en-US Sunday, en-GB and de Monday, ar-EG Saturday', () => {
  assert.equal(localeFirstDay('en-US'), 0);
  assert.equal(localeFirstDay('en'), 0, 'bare English is US English');
  assert.equal(localeFirstDay('en-GB'), 1);
  assert.equal(localeFirstDay('de'), 1);
  assert.equal(localeFirstDay('de-DE'), 1);
  assert.equal(localeFirstDay('fr-CA'), 0);
  assert.equal(localeFirstDay('pt-BR'), 0);
  assert.equal(localeFirstDay('ar-EG'), 6);
  assert.equal(localeFirstDay('fa-IR'), 6);
});

test('a locale that asks for its own first day gets it, where Intl reads it', { skip: !hasWeekInfo && 'no Intl weekInfo here' }, () => {
  assert.equal(localeFirstDay('en-US-u-fw-mon'), 1);
});

/** Run fn with Intl weekInfo gone (older WebViews), or with no Intl.Locale at all. */
function withoutWeekInfo(fn, { noLocale = false } = {}) {
  const P = Intl.Locale.prototype;
  const saved = ['getWeekInfo', 'weekInfo'].map((k) => [k, Object.getOwnPropertyDescriptor(P, k)]);
  const savedLocale = Intl.Locale;
  for (const [k, d] of saved) if (d) delete P[k];
  if (noLocale) Intl.Locale = undefined;
  try { return fn(); } finally {
    Intl.Locale = savedLocale;
    for (const [k, d] of saved) if (d) Object.defineProperty(P, k, d);
  }
}

test('Automatic without Intl weekInfo (older WebViews) reads the region', () => {
  withoutWeekInfo(() => {
    assert.equal(typeof new Intl.Locale('en-US').getWeekInfo, 'undefined');
    assert.equal(new Intl.Locale('en-US').weekInfo, undefined);
    assert.equal(localeFirstDay('en-US'), 0);
    assert.equal(localeFirstDay('en'), 0);
    assert.equal(localeFirstDay('en-GB'), 1);
    assert.equal(localeFirstDay('de'), 1);
    assert.equal(localeFirstDay('ar-EG'), 6);
    assert.equal(localeFirstDay('ar'), 6);
    assert.equal(localeFirstDay('en-AU'), 1);
    assert.equal(localeFirstDay('dv-MV'), 5);
    assert.equal(resolveFirstDay('auto', 'en-US'), 0);
    assert.equal(resolveFirstDay('auto', 'de-DE'), 1);
  });
});

test('Automatic with no Intl.Locale at all reads the tag', () => {
  withoutWeekInfo(() => {
    assert.equal(Intl.Locale, undefined);
    assert.equal(localeFirstDay('en-US'), 0);
    assert.equal(localeFirstDay('en_GB'), 1);
    assert.equal(localeFirstDay('en'), 0);
    assert.equal(localeFirstDay('de'), 1);
    assert.equal(localeFirstDay('ar-EG'), 6);
    assert.equal(localeFirstDay('zh-Hant-TW'), 0);
    assert.equal(localeFirstDay('garbage!!'), 1);
  }, { noLocale: true });
});

test('the fallback table agrees with Intl for every region', { skip: !hasWeekInfo && 'no Intl weekInfo here' }, () => {
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const intl = {};
  for (const a of A) for (const b of A) {
    const r = a + b;
    if (!names.of(r)) continue;
    try { const L = new Intl.Locale(`und-${r}`); intl[r] = (L.getWeekInfo ? L.getWeekInfo() : L.weekInfo).firstDay % 7; } catch { /* not a region */ }
  }
  // Codes no longer in use, or not countries.
  const legacy = new Set(['BU', 'RH', 'YD', 'DD', 'CS', 'SU', 'YU', 'ZR', 'TP', 'AN', 'NH', 'FX', 'DY', 'HV', 'VD', 'CP', 'CQ', 'EZ', 'QO', 'UN', 'EU', 'XA', 'XB', 'ZZ']);
  const fallback = withoutWeekInfo(() => Object.fromEntries(Object.keys(intl).map((r) => [r, localeFirstDay(`und-${r}`)])));
  const wrong = Object.keys(intl).filter((r) => !legacy.has(r) && intl[r] !== fallback[r]);
  assert.deepEqual(wrong, [], 'regions whose fallback differs from Intl: ' + wrong.map((r) => `${r} intl=${intl[r]} ours=${fallback[r]}`).join(', '));
});

// The setting

test('each setting value comes to its day; Automatic and anything unknown follow the locale', () => {
  assert.deepEqual(FIRST_DAY_SETTINGS, { monday: 1, sunday: 0, saturday: 6 });
  for (const loc of ['en-US', 'en-GB', 'ar-EG']) {
    assert.equal(resolveFirstDay('monday', loc), 1);
    assert.equal(resolveFirstDay('sunday', loc), 0);
    assert.equal(resolveFirstDay('saturday', loc), 6);
    for (const v of ['auto', undefined, null, '', 'Tuesday', 3, {}]) assert.equal(resolveFirstDay(v, loc), localeFirstDay(loc), String(v));
  }
  assert.equal(explicitFirstDay('auto'), null);
  assert.equal(explicitFirstDay('MONDAY'), 1);
});

// Week math

test('the week a date falls in, for Monday, Sunday and Saturday', () => {
  // 2026-10-14 is a Wednesday.
  assert.equal(weekdayOf('2026-10-14'), 3);
  assert.deepEqual(weekIsos('2026-10-14', 1), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual(weekIsos('2026-10-14', 0), ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  assert.deepEqual(weekIsos('2026-10-14', 6), ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  // A Sunday: the last day of a Monday week, the first of a Sunday week.
  assert.equal(weekStartIso('2026-10-18', 1), '2026-10-12');
  assert.equal(weekStartIso('2026-10-18', 0), '2026-10-18');
  assert.equal(weekStartIso('2026-10-18', 6), '2026-10-17');
});

test('every day of a year falls in a week that holds it, starts on the first day and runs 7 days', () => {
  for (const fd of [0, 1, 6]) {
    for (let iso = '2024-01-01'; iso <= '2025-01-07'; iso = shiftIso(iso, 1)) {
      const w = weekIsos(iso, fd);
      assert.equal(w.length, 7);
      assert.ok(w.includes(iso), `${iso} in its week (${fd})`);
      assert.equal(weekdayOf(w[0]), fd);
      for (let i = 1; i < 7; i++) assert.equal(w[i], shiftIso(w[i - 1], 1));
    }
  }
});

test('month and year boundaries', () => {
  assert.deepEqual(weekIsos('2026-01-01', 1), ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  assert.deepEqual(weekIsos('2026-01-01', 0), ['2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(weekIsos('2024-02-29', 6), ['2024-02-24', '2024-02-25', '2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01']);
  assert.equal(weekStartIso('2026-03-01', 1), '2026-02-23');
});

test('daylight-saving changes never move a day, in any time zone', () => {
  const zones = ['America/New_York', 'Europe/Berlin', 'Australia/Sydney', 'America/Sao_Paulo', 'Pacific/Chatham', 'UTC'];
  const script = `
    import('${new URL('../src/lib/week.js', import.meta.url).href}').then(w => {
      const out = [];
      for (const d of ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01', '2026-04-05', '2026-10-04']) {
        for (const fd of [0, 1, 6]) out.push(w.weekIsos(d, fd).join(','));
        out.push(w.leadingBlanks(2026, Number(d.slice(5, 7)) - 1, 1));
      }
      process.stdout.write(JSON.stringify(out));
    });`;
  const results = zones.map((TZ) => execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }));
  for (const r of results) assert.equal(r, results[0], 'same weeks in every zone');
  // 2026-03-08 (the US change) is a Sunday: its Monday week runs Mar 2 to 8.
  assert.ok(JSON.parse(results[0])[1].startsWith('2026-03-02,'));
});

// Grids and weekday lists

test('month grids put every date under its own weekday, for every first day', () => {
  // October 2026 starts on a Thursday.
  assert.equal(leadingBlanks(2026, 9, 0), 4);
  assert.equal(leadingBlanks(2026, 9, 1), 3);
  assert.equal(leadingBlanks(2026, 9, 6), 5);
  const heads = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  for (const fd of [0, 1, 6]) {
    const header = inWeekOrder(heads, fd);
    for (const [y, m] of [[2026, 0], [2026, 1], [2024, 1], [2026, 9], [2026, 11], [2027, 0]]) {
      const blanks = leadingBlanks(y, m, fd);
      const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      for (let d = 1; d <= days; d++) {
        const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        assert.equal(header[(blanks + d - 1) % 7], heads[weekdayOf(iso)], `${iso} column (first day ${fd})`);
      }
    }
  }
});

test('lists by weekday are only reordered: each value stays on its weekday', () => {
  assert.deepEqual(weekdayOrder(1), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(weekdayOrder(0), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(weekdayOrder(6), [6, 0, 1, 2, 3, 4, 5]);
  const goalDays = [1800, 2000, 2000, 2000, 2000, 2000, 2400]; // Sun..Sat as stored
  for (const fd of [0, 1, 6]) {
    const shown = inWeekOrder(goalDays, fd);
    weekdayOrder(fd).forEach((wd, i) => assert.equal(shown[i], goalDays[wd]));
    // The Goals editor binds each field to editDayVals[weekday]: editing in
    // the order shown writes the same stored array.
    const edited = Array(7).fill('');
    weekdayOrder(fd).forEach((wd) => { edited[wd] = goalDays[wd]; });
    assert.deepEqual(edited, goalDays);
  }
});

test('which goal applies to a date does not depend on the setting', async () => {
  const { dayTargets } = await import('../src/lib/goal-resolver.js');
  assert.doesNotMatch(read('src/lib/goal-resolver.js'), /weekStart|firstDay|week\.js/);
  const goals = { calories: { sharedGoal: false, days: [1800, 2000, 2100, 2200, 2300, 2400, 2500], max: 2500 } };
  // 2026-10-18 is a Sunday, 2026-10-19 a Monday.
  assert.equal(dayTargets(goals, '2026-10-18').calories, 1800);
  assert.equal(dayTargets(goals, '2026-10-19').calories, 2000);
});

// The weekly summary

test('the weekly summary range for each setting', () => {
  // Automatic: null, the 7 days up to today as always.
  assert.equal(weeklySummaryRange('auto', '2026-10-18'), null);
  assert.equal(weeklySummaryRange(undefined, '2026-10-18'), null);
  // Monday: sent on Sunday (the default day) it is the week ending today.
  assert.deepEqual(weeklySummaryRange('monday', '2026-10-18'), { from: '2026-10-12', to: '2026-10-18' });
  // Sent on Monday or midweek: the last whole week.
  assert.deepEqual(weeklySummaryRange('monday', '2026-10-19'), { from: '2026-10-12', to: '2026-10-18' });
  assert.deepEqual(weeklySummaryRange('monday', '2026-10-14'), { from: '2026-10-05', to: '2026-10-11' });
  // Sunday: sent on Sunday, last Sunday to yesterday; on Saturday, the week ending today.
  assert.deepEqual(weeklySummaryRange('sunday', '2026-10-18'), { from: '2026-10-11', to: '2026-10-17' });
  assert.deepEqual(weeklySummaryRange('sunday', '2026-10-17'), { from: '2026-10-11', to: '2026-10-17' });
  // Saturday: sent on Friday, the week ending today.
  assert.deepEqual(weeklySummaryRange('saturday', '2026-10-16'), { from: '2026-10-10', to: '2026-10-16' });
  // Across a year.
  assert.deepEqual(weeklySummaryRange('monday', '2026-01-01'), { from: '2025-12-22', to: '2025-12-28' });
});

const serverReady = (() => {
  try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); return true; } catch { return false; }
})();

test('the weekly summary reads the day in the person\'s time zone', { skip: !serverReady && 'server packages missing' }, async () => {
  // server/db.js opens DB_PATH when imported: a throwaway one, never the repo's.
  const dir = mkdtempSync(join(tmpdir(), 'nt-week-db-'));
  process.env.DB_PATH = join(dir, 'nt.db');
  const { weeklyRangeFor, todayIn } = await import('../server/lib/weekly-range.js');
  // 2026-10-19 03:00 UTC is still Sunday the 18th in Los Angeles.
  const at = new Date('2026-10-19T03:00:00Z');
  assert.equal(todayIn('America/Los_Angeles', at), '2026-10-18');
  assert.deepEqual(weeklyRangeFor('monday', 'America/Los_Angeles', at), { from: '2026-10-12', to: '2026-10-18' });
  assert.equal(todayIn('', at), at.toLocaleDateString('sv-SE'), 'no zone: the server\'s own date, as the scheduler picks the day');
  assert.equal(weeklyRangeFor('auto', 'America/Los_Angeles', at), null);
  rmSync(dir, { recursive: true, force: true });
});

function sendSummary(firstDay, now, tz = '') {
  const dir = mkdtempSync(join(tmpdir(), 'nt-week-'));
  try {
    const out = execFileSync(process.execPath, [new URL('./fixtures/weekly-summary-run.mjs', import.meta.url).pathname], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME || dir, TZ: 'America/New_York', DB_PATH: join(dir, 'nt.db'), NOW: now, FIRST_DAY: firstDay, USER_TZ: tz },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
    });
    return JSON.parse(out.slice(out.lastIndexOf('{"sent"')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the weekly summary email covers the chosen week (real server code, stand-in SMTP)', { skip: !serverReady && 'server packages missing' }, () => {
  // Wednesday 2026-10-14, noon in New York. Each day is worth its day of
  // the month x 100 kcal, so the average names the days read.
  const now = '2026-10-14T16:00:00Z';
  const never = sendSummary('', now);
  assert.equal(never.sent, 1);
  assert.equal(never.subject, `NutriTrace Weekly Summary ${EM} Thu Oct 8 ${EN} Wed Oct 14`, 'never saved: the 7 days up to today, as before');
  assert.equal(never.avg, 1100);
  assert.deepEqual(sendSummary('auto', now), never, 'Automatic: the same');
  const mon = sendSummary('monday', now);
  assert.ok(mon.subject.endsWith(`Mon Oct 5 ${EN} Sun Oct 11`), mon.subject);
  assert.equal(mon.avg, 800);
  const sun = sendSummary('sunday', now);
  assert.ok(sun.subject.endsWith(`Sun Oct 4 ${EN} Sat Oct 10`), sun.subject);
  assert.equal(sun.avg, 700);
  const sat = sendSummary('saturday', now);
  assert.ok(sat.subject.endsWith(`Sat Oct 3 ${EN} Fri Oct 9`), sat.subject);
  assert.equal(sat.avg, 600);
});

test('a Monday week sent on its default day, Sunday, reads the same days as before', { skip: !serverReady && 'server packages missing' }, () => {
  const now = '2026-10-18T13:00:00Z'; // Sunday 9:00 in New York
  const before = sendSummary('', now, 'America/New_York');
  const mon = sendSummary('monday', now, 'America/New_York');
  assert.ok(before.subject.endsWith(`Mon Oct 12 ${EN} Sun Oct 18`), before.subject);
  assert.equal(mon.subject, before.subject);
  assert.equal(mon.avg, before.avg);
});

// Wiring

test('the setting is synced, defaults to Automatic, and has its row, strings and search words', () => {
  const settings = read('src/stores/settings.js');
  const at = settings.indexOf('export const USER_PREFS');
  const prefs = settings.slice(at, settings.indexOf(']);', at));
  assert.match(prefs, /'firstDayOfWeek'/, 'in USER_PREFS: synced to the server and the Android app');
  assert.match(settings, /createSettingStore\('firstDayOfWeek', FIRST_DAY_DEFAULT\)/);
  assert.match(read('src/lib/week.js'), /FIRST_DAY_DEFAULT = 'auto'/);
  const regional = read('src/routes/settings/Regional.svelte');
  for (const v of ['auto', 'monday', 'sunday', 'saturday']) assert.match(regional, new RegExp(`<option value="${v}">`));
  const en = JSON.parse(read('src/i18n/en.json'));
  assert.equal(en.settings.regional.first_day, 'First Day of Week');
  assert.equal(en.settings.regional.first_day_auto, 'Automatic');
  assert.match(en.settings.regional.first_day_desc, /\{day\}/);
  assert.match(read('src/routes/Settings.svelte'), /regional: +\[[^\]]*'first day of week'[^\]]*'week start'/);
});

test('every spot that starts a week reads the setting', () => {
  const strip = read('src/components/diary/WeekStrip.svelte');
  assert.match(strip, /weekIsos\(anchorIso \|\| localDateStr\(\), firstDay\)/);
  assert.equal((strip.match(/_weekIsos\(currentDate, \$weekStartDay\)/g) || []).length, 2, 'the strip and its per-day goals');
  assert.doesNotMatch(strip, /getDate\(\) - anchor\.getDay\(\)/, 'no Sunday-only week left');
  for (const f of ['src/components/ui/DatePicker.svelte', 'src/routes/Statistics.svelte']) {
    const s = read(f);
    assert.match(s, /calFirstDay += leadingBlanks\(calYear, calMonth, \$weekStartDay\)/, f);
    assert.match(s, /inWeekOrder\(\['Su','Mo','Tu','We','Th','Fr','Sa'\], \$weekStartDay\)/, f);
    assert.doesNotMatch(s, /new Date\(calYear, calMonth, 1\)\.getDay\(\)/, f);
  }
  const goals = read('src/routes/Goals.svelte');
  assert.match(goals, /\{#each weekdayOrder\(\$weekStartDay\) as i\}\s*\{@const day = DAYS\[i\]\}[\s\S]{0,400}bind:value=\{editDayVals\[i\]\}/);
  const editor = read('src/components/coaching/TargetsEditor.svelte');
  assert.match(editor, /\{#each weekdayOrder\(\$weekStartDay\) as i\}[\s\S]{0,300}bind:value=\{ed\[key\]\.days\[i\]\}/);
  const card = read('src/components/coaching/TargetsCard.svelte');
  assert.equal((card.match(/inWeekOrder\((DAYS|row\.currentDays|row\.proposedDays), \$weekStartDay\)/g) || []).length, 3, 'header and both rows in the same order');
  const diary = read('src/routes/settings/Diary.svelte');
  assert.match(diary, /\{#each _dayOrder as idx\}/);
  assert.ok(!diary.includes('Tap a day to toggle. Sunday '), 'the hint names the shown first and last day');
  const notif = read('src/components/settings/SettingsNotifications.svelte');
  assert.match(notif, /--seg-active:\{weekdayOrder\(\$weekStartDay\)\.indexOf\(_weeklySummaryDay\)\}/, 'the pill sits on the chosen day');
  assert.match(notif, /class:seg-active=\{_weeklySummaryDay === i\}[\s\S]{0,120}set\('weeklySummaryDay', i\)/, 'still stores the real weekday');
  assert.match(read('server/email.js'), /const week = userWeeklyRange\(userId\);/);
  assert.match(read('server/lib/push-notify.js'), /const week = userWeeklyRange\(userId\);/);
});
