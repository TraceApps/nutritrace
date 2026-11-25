/**
 * #349, #350: measurements sent through POST /api/v1/body-measurements are
 * read like a scale's: Statistics (Weight, Body Fat, Body Water, Muscle
 * Mass), Wellness > Body on the web and in the Android app, and Goals.
 * Unit checks of the shared helper and of the Android app's local read, plus
 * text checks of each page's wiring (no browser).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { get } from 'svelte/store';
import { apiBodyData, bodyDataPath, hasBodyRows, refreshApiBodyData } from '../src/lib/api-body.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const stats = read('../src/routes/Statistics.svelte');
const wellness = read('../src/routes/Wellness.svelte');
const goals = read('../src/routes/Goals.svelte');
const native = read('../src/lib/api-native.js');

test('the path: every source with Fitbit or Health Connect on, the API alone without, none with neither', () => {
  assert.equal(bodyDataPath({ from: '2026-11-01', to: '2026-11-07' }, true, true), '/api/wellness/fitbit/data?from=2026-11-01&to=2026-11-07');
  assert.equal(bodyDataPath({ from: '2026-11-01', to: '2026-11-07' }, true, false), '/api/wellness/fitbit/data?from=2026-11-01&to=2026-11-07');
  assert.equal(bodyDataPath({ date: '2026-11-25' }, false, true), '/api/wellness/fitbit/data?date=2026-11-25&sources=federation');
  assert.equal(bodyDataPath({ date: '2026-11-25' }, false, false), null);
});

test('body rows are told apart from activity rows', () => {
  assert.equal(hasBodyRows({ '2026-11-25': { body_fat_pct: 21.3 } }), true);
  assert.equal(hasBodyRows({ '2026-11-25': { muscle_mass_kg: 35 } }), true);
  assert.equal(hasBodyRows({ '2026-11-25': { steps: 9000 } }), false);
  assert.equal(hasBodyRows({}), false);
  assert.equal(hasBodyRows(null), false);
});

test("the look asks for the API's measurements of any age, and a failed look changes nothing", async () => {
  const asked = [];
  const now = new Date(2026, 10, 25);
  await refreshApiBodyData({ get: async p => { asked.push(p); return { '2019-03-02': { weight_kg: 80 } }; } }, { now });
  assert.deepEqual(asked, ['/api/wellness/fitbit/data?from=2000-01-01&to=2026-11-25&sources=federation']);
  assert.equal(get(apiBodyData), true, 'a history imported years ago counts');
  await refreshApiBodyData({ get: async () => { throw new Error('offline'); } }, { now });
  assert.equal(get(apiBodyData), true, 'offline: still known');
  await refreshApiBodyData({ get: async () => ({}) }, { now });
  assert.equal(get(apiBodyData), false);
});

test("the phone's own database answers first, the server only when it has none", async () => {
  const now = new Date(2026, 10, 25);
  const asked = [];
  const server = { get: async p => { asked.push(p); return {}; } };
  await refreshApiBodyData(server, { now, localRead: async (f, t, src) => (src === 'federation' ? { '2026-11-20': { body_fat_pct: 21 } } : {}) });
  assert.equal(get(apiBodyData), true);
  assert.deepEqual(asked, [], 'offline-safe: no request when the phone has them');
  await refreshApiBodyData(server, { now, localRead: async () => ({}) });
  assert.equal(asked.length, 1, 'none on the phone yet: the server is asked');
  assert.equal(get(apiBodyData), false);
});

test("the Android app answers the request from its own database with the server's sources, the API's included (#349)", () => {
  const fn = native.match(/export function _dataSources\(path\) \{[\s\S]*?\n\}/)[0];
  assert.match(native, /const _DATA_SOURCES = \['fitbit', 'health_connect', 'federation'\];/);
  const run = new Function('_DATA_SOURCES', fn.replace('export ', '') + '\nreturn _dataSources;')(['fitbit', 'health_connect', 'federation']);
  assert.deepEqual(run('/api/wellness/fitbit/data?date=2026-11-25'), ['fitbit', 'health_connect', 'federation']);
  assert.deepEqual(run('/api/wellness/fitbit/data?date=2026-11-25&sources=federation'), ['federation']);
  assert.deepEqual(run('/api/wellness/fitbit/data?sources=nope'), ['fitbit', 'health_connect', 'federation']);
  assert.match(native, /path\.startsWith\('\/api\/wellness\/fitbit\/data'\)\)\s+return _wellnessDataLocal\(path, _dataSources\(path\)\);/);
  // A device's value wins over the API's, as on the server.
  assert.equal((native.match(/CASE source WHEN 'federation' THEN 0 WHEN 'health_connect' THEN 2 ELSE 1 END/g) || []).length, 2);
});

test("Wellness on Android reads the API's measurements for the day, below the devices' (#349)", () => {
  const fn = wellness.match(/async function loadLocalWellnessData\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(fn, /dbGetWellnessGrouped\(dateStr, dateStr, 'federation'\)/);
  assert.match(fn, /data = \{ \.\.\.\(hcData\[dateStr\] \|\| \{\}\), \.\.\.\(fitbitData\[dateStr\] \|\| \{\}\) \};\s+apiData = apiLocal\[dateStr\] \|\| \{\};/);
  assert.match(fn, /Object\.keys\(apiData\)\.length > 0;/, 'the day counts as having data');
});

test('Wellness shows its Body tab and loads the day once there are API measurements, web and app', () => {
  assert.match(wellness, /\$: apiBodyAvailable = \$apiBodyData;/);
  assert.match(wellness, /\$: anyAvailable {6}= .*\|\| apiBodyAvailable;/);
  assert.match(wellness, /garminBodyAvailable \|\| apiBodyAvailable \? \['body'\]/);
  assert.match(wellness, /\{#if withingsAvailable \|\| healthConnectAvailable \|\| garminBodyAvailable \|\| apiBodyAvailable\}/);
  assert.equal((wellness.match(/garminBodyAvailable \|\| apiBodyAvailable \|\| \(isNative && _hasLocalData\)/g) || []).length, 2);
  const init = wellness.match(/async function init\(\) \{[\s\S]*?\n  \}/)[0];
  const look = init.indexOf('refreshApiBodyData(NtApi, { native: isNative })');
  assert.ok(look > -1 && look < init.indexOf('if (isNative)'), 'looked for before either path');
  assert.match(init, /await apiLook;[\s\S]*\$fitbitFamilyEnabled \|\| \$apiBodyData\) \{\s+await loadData\(\);/);
});

test('Statistics reads them as a device for Weight, Body Fat, Body Water and Muscle Mass (#350)', () => {
  assert.match(stats, /\(\(metric === 'weight' \|\| metric === 'body_fat'\) && \(\$withingsEnabled \|\| \$fitbitFamilyEnabled \|\| \$apiBodyData\)\) \|\|\s+\(metric === 'body_water' && \(\$withingsEnabled \|\| \$apiBodyData\)\);/);
  assert.equal((stats.match(/bodyDataPath\(\{ from: fromStr, to: toStr \}, \$fitbitFamilyEnabled, \$apiBodyData\)/g) || []).length, 2);
  assert.match(stats, /if \(key === 'wl_muscle'\) return hasWellness \|\| \$withingsEnabled \|\| \$apiBodyData;/);
  assert.match(stats, /\(\$withingsEnabled \|\| \$fitbitFamilyEnabled \|\| \$apiBodyData\) && _wlVisible\('muscle_mass_kg'\)/);
  assert.match(stats, /\$: \{ metric; range; customStart; customEnd; \$apiBodyData;/, 'drawn again once known');
  // A device's weight in pounds reads with one decimal.
  assert.equal((stats.match(/Math\.round\(raw \* 2\.20462 \* 10\) \/ 10/g) || []).length, 2);
  assert.doesNotMatch(stats, /\? raw \* 2\.20462 : raw/);
});

test("Statistics' All keeps body stats from the first diary day, not just a year", () => {
  const all = stats.match(/if \(range === 'all' && \(isWellness \|\| isBodyDevice\)\) \{[\s\S]*?\n {4}\} else if/)[0];
  assert.match(all, /let n = 365;/);
  assert.match(all, /if \(isBodyDevice\) \{[\s\S]*_allDiary = await NtApi\.getAllDiary\(\)[\s\S]*if \(Number\.isFinite\(days\)\) n = Math\.max\(n, days\);/);
  // Read once: the day-by-day pass reuses it.
  assert.match(stats, /const allEntries = _allDiary \|\| await NtApi\.getAllDiary\(\);/);
});

test('a metric linked into Statistics waits for the look instead of snapping away', () => {
  assert.match(stats, /if \(mp\) \{ metric = mp; _linkedMetric = mp; \}/);
  assert.match(stats, /refreshApiBodyData\(NtApi, \{ native: isNative \}\)\.then\(async \(\) => \{\s+await tick\(\);\s+if \(_linkedMetric && METRICS\.some\(x => _metricKey\(x\) === _linkedMetric\)\) metric = _linkedMetric;\s+_linkedMetric = null;/);
});

test("Wellness' Body cards take every device's value before the API's, web and app", () => {
  // Garmin's too: the API's are kept apart rather than mixed into `data`.
  assert.equal((wellness.match(/\{@const raw = withingsData\[m\.id\] \?\? data\[m\.id\] \?\? garminData\[m\.id\] \?\? apiData\[m\.id\] \?\? null\}/g) || []).length, 3);
  assert.doesNotMatch(wellness, /withingsData\[m\.id\] \?\? data\[m\.id\] \?\? garminData\[m\.id\] \?\? null/);
  const load = wellness.match(/async function loadData\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(load, /\$\{\$apiBodyData \? '&sources=fitbit,health_connect' : ''\}/);
  assert.match(load, /if \(\$apiBodyData\) \{\s+try \{ apiData = \(await NtApi\.get\(`\/api\/wellness\/fitbit\/data\?date=\$\{dateStr\}&sources=federation`\)\)\[dateStr\] \|\| \{\}; \} catch \{\}/);
  assert.equal((wellness.match(/_checkWellnessGoals\(\{ \.\.\.apiData, \.\.\.garminData, \.\.\.data \}, withingsData\)/g) || []).length, 2);
  // Sparklines on the web, below the devices'.
  assert.match(wellness, /garminRange\[d\]\?\.\[m\.id\] \?\? fitbitRange\[d\]\?\.\[m\.id\] \?\? apiRange\[d\]\?\.\[m\.id\] \?\? null/);
});

test("Goals' weight and body fat goals read the API's and Withings' values too", () => {
  const fn = goals.match(/async function loadWellnessToday\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(fn, /bodyDataPath\(\{ date: today \}, \$fitbitFamilyEnabled, \$apiBodyData\)/);
  assert.match(fn, /\/api\/wellness\/withings\/data\?date=\$\{today\}/);
  assert.match(fn, /todayWellness = \{ \.\.\.fitbit, \.\.\.garmin, \.\.\.withings \};/);
  assert.match(goals, /\$: _wellnessSources = \[\$fitbitFamilyEnabled, \$garminEnabled, \$withingsEnabled, \$apiBodyData\];/);
  // The newest read wins; every source off leaves nothing stale.
  assert.match(fn, /const seq = \+\+_wellnessSeq;/);
  assert.match(fn, /if \(seq !== _wellnessSeq\) return;\s+todayWellness = /);
  assert.match(goals, /else \{ _wellnessSeq\+\+; todayWellness = \{\}; \}/);
  assert.doesNotMatch(goals, /_wellnessLoaded/);
  assert.match(goals, /refreshApiBodyData\(NtApi, \{ native: isNative \}\)/);
  assert.match(goals, /import \{[^}]*\bwithingsEnabled\b[^}]*\} from '\.\.\/stores\/settings\.js';/);
});
