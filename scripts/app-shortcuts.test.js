/**
 * App icon shortcuts (#278): Scan Barcode, Log Food, Log Water and Log
 * Weight, from Android's launcher (res/xml/shortcuts.xml, nutritrace://new/…)
 * and the installed web app (the manifest's shortcuts, ./#/?new=…).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseAppLink } from '../src/lib/app-link.js';
import { oidcReturnHash } from '../server/lib/oidc-return.js';
import {
  SHORTCUT_KINDS, shortcutFromQuery, shortcutFromAppLink, isShortcutHash,
  shortcutRoute, shortcutNav, shortcutPickRoute, rememberFoodsTab, lastFoodsTab,
} from '../src/lib/app-shortcut.js';
import { mealForTime, mealTimes, defaultMealTime } from '../src/lib/meal-by-time.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const at = (h, m = 0) => new Date(2026, 9, 28, h, m);
const DEFAULT = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];

test('the links and addresses are read as their kind, and nothing else is', () => {
  assert.deepEqual(SHORTCUT_KINDS, ['barcode', 'food', 'water', 'weight']);
  for (const k of SHORTCUT_KINDS) {
    assert.equal(shortcutFromAppLink(parseAppLink(`nutritrace://new/${k}`)), k);
    assert.equal(shortcutFromQuery(`?new=${k}`), k);
    assert.equal(shortcutFromQuery(`new=${k}`), k, 'svelte-spa-router\'s querystring has no ?');
    assert.equal(isShortcutHash(`#/?new=${k}`), true);
  }
  assert.equal(shortcutFromAppLink(parseAppLink('NutriTrace://NEW/Barcode/')), 'barcode');
  assert.equal(shortcutFromAppLink(parseAppLink('nutritrace://new/drawing')), null);
  assert.equal(shortcutFromAppLink(parseAppLink('nutritrace://oidc-callback?code=x')), null);
  assert.equal(shortcutFromAppLink(parseAppLink('notetrace://new/food')), null, 'another app\'s link');
  assert.equal(shortcutFromAppLink(null), null);
  assert.equal(shortcutFromQuery('?new=voice'), null);
  assert.equal(shortcutFromQuery(''), null);
  assert.equal(shortcutFromQuery(undefined), null);
  assert.equal(isShortcutHash('#/foods?new=water'), false, 'only the Diary\'s address');
  assert.equal(isShortcutHash('#/?note=1'), false);
  assert.equal(isShortcutHash('#/'), false);
  assert.equal(isShortcutHash(''), false);
});

test('a shortcut that starts the app is sent once, though Android reports it twice', () => {
  const t = 1_000_000;
  assert.equal(shortcutRoute('water', t), '/?new=water');
  assert.equal(shortcutRoute('water', t + 500), null, 'the launch URL and appUrlOpen: one tap');
  assert.equal(shortcutRoute('weight', t + 600), '/?new=weight', 'another shortcut goes through');
  assert.equal(shortcutRoute('weight', t + 4000), '/?new=weight', 'the same one tapped again later');
  assert.equal(shortcutRoute('nope', t + 9000), null);
  assert.equal(shortcutRoute(null, t + 9000), null);
});

test('Scan Barcode and Log Food open the Diary\'s add screen, marked as from a shortcut', () => {
  const food = new URLSearchParams(shortcutPickRoute({ kind: 'food', meal: 1, date: '2026-10-28' }).split('?')[1]);
  assert.ok(shortcutPickRoute({ kind: 'food', meal: 1, date: '2026-10-28' }).startsWith('/foods?'));
  assert.deepEqual(Object.fromEntries(food), { pick: '1', meal: '1', date: '2026-10-28', via: 'shortcut' });
  const scan = new URLSearchParams(shortcutPickRoute({ kind: 'barcode', meal: 2, date: '2026-10-28' }).split('?')[1]);
  assert.equal(scan.get('scan'), '1');
  assert.equal(scan.get('meal'), '2');
  assert.equal(new URLSearchParams(shortcutPickRoute({ kind: 'food', meal: 'x', date: '' }).split('?')[1]).get('meal'), '0');
});

test('Log Food opens on the tab used last, on this device', () => {
  const mem = new Map();
  const store = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(lastFoodsTab(store), 0, 'Foods until a tab is used');
  rememberFoodsTab(2, store);
  assert.equal(lastFoodsTab(store), 2);
  rememberFoodsTab(-1, store);
  rememberFoodsTab(7, store);
  assert.equal(lastFoodsTab(store), 2, 'only a real tab is kept');
  mem.set('nt:foodsLastTab', 'junk');
  assert.equal(lastFoodsTab(store), 0);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => rememberFoodsTab(1, broken));
  assert.equal(lastFoodsTab(broken), 0);
  assert.equal(lastFoodsTab(undefined), 0);
});

test('the meal for the time of day, with the default meals', () => {
  const pick = (h, m) => DEFAULT[mealForTime(DEFAULT, { now: at(h, m) })];
  assert.equal(pick(5, 0), 'Breakfast', 'early morning, before any turn: the first meal');
  assert.equal(pick(8, 0), 'Breakfast');
  assert.equal(pick(11, 29), 'Breakfast');
  assert.equal(pick(11, 30), 'Lunch', 'an hour before 12:30');
  assert.equal(pick(14, 29), 'Lunch');
  assert.equal(pick(14, 30), 'Snacks');
  assert.equal(pick(17, 29), 'Snacks');
  assert.equal(pick(17, 30), 'Dinner');
  assert.equal(pick(23, 0), 'Dinner');
  assert.equal(pick(1, 0), 'Dinner', 'late at night: the day\'s latest meal');
  assert.equal(pick(4, 0), 'Breakfast', 'the day starts at 4:00');
});

test('custom names, other languages, and how many meals there are', () => {
  const six = ['Breakfast', 'Morning Snack', 'Lunch', 'Afternoon Snack', 'Dinner', 'Evening Snack'];
  const pick = (names, h, m = 0) => names[mealForTime(names, { now: at(h, m) })];
  assert.equal(pick(six, 9), 'Breakfast');
  assert.equal(pick(six, 10, 15), 'Morning Snack');
  assert.equal(pick(six, 12), 'Lunch');
  assert.equal(pick(six, 15), 'Afternoon Snack');
  assert.equal(pick(six, 19), 'Dinner');
  assert.equal(pick(six, 21, 30), 'Evening Snack');
  const fr = ['Petit-déjeuner', 'Déjeuner', 'Dîner', 'Collation'];
  assert.equal(pick(fr, 8), 'Petit-déjeuner', 'not lunch: déjeuner is inside the name');
  assert.equal(pick(fr, 12, 30), 'Déjeuner');
  assert.equal(pick(fr, 19), 'Dîner');
  assert.equal(pick(['Frühstück', 'Mittagessen', 'Abendessen'], 13), 'Mittagessen');
  assert.equal(pick(['Desayuno', 'Almuerzo', 'Cena', 'Merienda'], 16), 'Merienda');
  // Nothing recognized: the meals in order, spread over the day.
  const plain = ['Meal 1', 'Meal 2', 'Meal 3'];
  assert.deepEqual(mealTimes(plain), [480, 810, 1140]);
  assert.equal(pick(plain, 7, 30), 'Meal 1');
  assert.equal(pick(plain, 13), 'Meal 2');
  assert.equal(pick(plain, 20), 'Meal 3');
  assert.equal(mealForTime(['Food'], { now: at(3) }), 0);
  // Some recognized: the others aren't guessed.
  assert.equal(pick(['Breakfast', 'Fuel', 'Dinner'], 13), 'Breakfast');
  assert.equal(mealForTime([], { now: at(12) }), 0);
  assert.equal(mealForTime(undefined, { now: at(12) }), 0);
});

test('with meal reminders on, their times decide', () => {
  const pick = (h, m, times) => DEFAULT[mealForTime(DEFAULT, { now: at(h, m), reminderTimes: times })];
  // Settings shows 08:00, 12:00, 18:00 and 15:00 for Snacks before any is changed.
  assert.equal(pick(10, 59, []), 'Breakfast');
  assert.equal(pick(11, 0, []), 'Lunch');
  assert.equal(pick(14, 0, []), 'Snacks');
  assert.equal(pick(17, 0, []), 'Dinner');
  const late = ['10:00', '14:00', '21:00', 'bad'];
  assert.equal(pick(12, 30, late), 'Breakfast', 'late riser: breakfast at 10:00 runs until lunch\'s turn');
  assert.equal(pick(13, 0, late), 'Lunch');
  assert.equal(pick(14, 0, late), 'Snacks', 'a bad time falls back to its default, 15:00');
  assert.equal(pick(20, 0, late), 'Dinner');
  assert.equal(defaultMealTime(0), '08:00');
  assert.equal(defaultMealTime(9), '12:00');
  assert.match(read('../src/components/settings/SettingsNotifications.svelte'), /const _defaultMealTime = defaultMealTime;/, 'the same defaults as Settings');
});

test('the installed web app lists the four shortcuts, in order', () => {
  const vite = read('../vite.config.js');
  const block = vite.slice(vite.indexOf('shortcuts: ['), vite.indexOf('],', vite.indexOf('shortcuts: [')));
  const items = [...block.matchAll(/\{ name: '([^']+)', short_name: '([^']+)', url: '([^']+)', icons: \[\{ src: '([^']+)'/g)];
  assert.deepEqual(items.map(m => [m[1], m[2], m[3]]), [
    ['Scan Barcode', 'Scan Barcode', './#/?new=barcode'],
    ['Log Food', 'Log Food', './#/?new=food'],
    ['Log Water', 'Log Water', './#/?new=water'],
    ['Log Weight', 'Log Weight', './#/?new=weight'],
  ]);
  for (const m of items) {
    assert.equal(shortcutFromQuery(m[3].split('?')[1]), m[3].split('=')[1]);
    assert.ok(existsSync(new URL('../public/' + m[4], import.meta.url)), m[4]);
  }
});

test('Android\'s shortcuts.xml: ids, labels, icons and explicit intents', () => {
  const xml = read('../android/app/src/main/res/xml/shortcuts.xml');
  const strings = read('../android/app/src/main/res/values/strings.xml');
  const blocks = [...xml.matchAll(/<shortcut\b([\s\S]*?)<\/shortcut>/g)].map(m => m[1]);
  assert.equal(blocks.length, 4);
  const ids = [];
  const labels = [];
  for (const b of blocks) {
    const attr = n => (new RegExp(`android:${n}="([^"]*)"`).exec(b) || [])[1];
    ids.push(attr('shortcutId'));
    assert.equal(attr('enabled'), 'true');
    const label = /^@string\/(\w+)$/.exec(attr('shortcutShortLabel'))?.[1];
    assert.ok(label, 'a string resource, so it can be translated');
    const text = new RegExp(`<string name="${label}">([^<]+)</string>`).exec(strings)?.[1];
    assert.ok(text && text.length <= 25, `${label} exists and fits a launcher's short label`);
    labels.push(text);
    const icon = /^@drawable\/(\w+)$/.exec(attr('icon'))?.[1];
    const vec = read(`../android/app/src/main/res/drawable/${icon}.xml`);
    assert.match(vec, /<vector[\s\S]*android:viewportWidth="24"[\s\S]*<path android:fillColor="@android:color\/white" android:pathData="M[^"]+" \/>/);
    assert.equal(attr('action'), 'android.intent.action.VIEW');
    assert.equal(attr('targetPackage'), 'com.nutritrace.app');
    assert.equal(attr('targetClass'), 'com.nutritrace.app.AppShortcutActivity', 'through the pass-through activity (app-shortcut-activity.test.js)');
    assert.equal(shortcutFromAppLink(parseAppLink(attr('data'))), attr('shortcutId'), 'the link asks for the shortcut\'s own kind');
  }
  assert.deepEqual(ids, SHORTCUT_KINDS);
  assert.deepEqual(labels, ['Scan Barcode', 'Log Food', 'Log Water', 'Log Weight']);
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>\s*<meta-data android:name="android.app.shortcuts" android:resource="@xml\/shortcuts" \/>/, 'on the launcher activity');
  // No web page opens nutritrace://new: it isn't a browsable link.
  const browsable = manifest.match(/<intent-filter[^>]*>(?:(?!<\/intent-filter>)[\s\S])*BROWSABLE(?:(?!<\/intent-filter>)[\s\S])*<\/intent-filter>/g) || [];
  assert.ok(browsable.length);
  for (const f of browsable) assert.doesNotMatch(f, /android:host="new"/);
});

test('the app routes a shortcut link to the Diary, which opens it for today', () => {
  const app = read('../src/App.svelte');
  const handler = app.slice(app.indexOf("addListener('appUrlOpen'"));
  assert.match(handler, /if \(host === 'new'\) \{[\s\S]*?sc\.shortcutRoute\(sc\.shortcutFromAppLink\(link\)\)[\s\S]*?\[sc\.shortcutNav\(window\.location\.hash\)\]\(route\)[\s\S]*?return;/);
  assert.match(app, /App\.getLaunchUrl\?\.\(\)\.then\(async \(r\) => \{[\s\S]*?sc\.shortcutRoute\(sc\.shortcutFromAppLink\(parseAppLink\(r\.url\)\)\)/);
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /\$: _openShortcut\(shortcutFromQuery\(\$querystring\)\);/);
  const fn = diary.slice(diary.indexOf('async function _openShortcut'), diary.indexOf('async function _openShortcut') + 1600);
  assert.match(fn, /replace\('\/'\);[\s\S]*const today = localDateStr\(\);[\s\S]*loadEntry\(today\)/, 'off the address, then today');
  assert.match(fn, /mealForTime\(/);
  assert.match(fn, /editorState\.foodsActiveTab = null;\s*editorState\.foodsScrollY = null;\s*push\(shortcutPickRoute/, 'not a tab an earlier editor trip left behind');
  assert.match(fn, /push\(shortcutPickRoute\(\{ kind, meal, date: today \}\)\)/);
  assert.match(fn, /if \(_waterShowInDiary\) _lockAndOpen\(\(\) => showWaterQuickAdd = true\);\s*else \{ showInfo\(\$_\('diary\.shortcut\.water_hidden'\)\); push\('\/settings\/water'\); \}/, 'water hidden: where to turn it on');
  assert.match(fn, /openBodyStats\(\);/);
  // The Diary's own + is unchanged.
  assert.match(diary, /push\('\/foods\?pick=1&meal=' \+ mealIdx \+ '&date=' \+ \$currentDate\);/);
});

test('signed out, the shortcut waits under the sign-in screen and opens after it', () => {
  const login = read('../src/routes/Login.svelte');
  assert.equal((login.match(/const shortcutWaiting = isShortcutHash\(window\.location\.hash\);/g) || []).length, 2, 'password and fingerprint sign-in');
  assert.equal((login.match(/if \(!shortcutWaiting\) push\('\/'\);/g) || []).length, 2);
  assert.doesNotMatch(login, /^\s*push\('\/'\);/m);
  const app = read('../src/App.svelte');
  assert.match(app, /const shortcutWaiting = isShortcutHash\(window\.location\.hash\);\s*setAuthToken\(token\);/, 'read before signing in (the Diary takes it after)');
  assert.match(app, /if \(!shortcutWaiting\) window\.location\.hash = '#\/';/);
});

test('the add screen from a shortcut names where the food goes; from the + it is as before', () => {
  const foods = read('../src/routes/Foods.svelte');
  assert.match(foods, /\$: viaShortcut = pickMode && params\.via === 'shortcut';/);
  assert.match(foods, /\{#if viaShortcut\}\s*<!-- #278[^>]*-->\s*<button type="button" class="shortcut-destination" on:click=\{openDestination\}/);
  assert.match(foods, /<span class="sd-text">\{_destText\}<\/span>/);
  assert.match(foods, /\$: _destText = viaShortcut \? \$_\('foods\.detail\.adding_to_day', \{ values: \{\s*meal: \(\$mealNames[^\n]*\[Number\(pickMeal\) \|\| 0\][^\n]*\n\s*\.\.\.dayValues\(pickDate \|\| localDateStr\(\), \{ lang: \$language \}\),/, 'follows a change of meal or day');
  assert.match(foods, /\{#if viaShortcut\}\s*<ActionSheet bind:open=\{_destOpen\}[^>]*on:select=\{onDestinationPicked\}>\s*<svelte:fragment slot="header"><div class="dest-day"><DayPicker bind:value=\{_destDay\} \/><\/div>/);
  assert.match(foods, /\{#if \(!pickMode \|\| viaShortcut\) && showQtyPrompt\}/, 'the quantity step names it too');
  // Scan Barcode: the scanner on Foods once the list is loaded; Log Food: the tab used last.
  assert.match(foods, /if \(viaShortcut && editorState\.foodsActiveTab == null\) \{\s*if \(params\.scan === '1'\) \{\s*activeTab = 0;\s*_scanOnOpen = true;\s*\} else \{\s*activeTab = lastFoodsTab\(\);/);
  assert.match(foods, /await load\(\);\s*\/\/[^\n]*\n\s*if \(_scanOnOpen\) \{ _scanOnOpen = false; scannerOpen = true; \}/);
  // A change keeps to the address (the editor and a reload see it) and the Diary's day.
  const pickFn = foods.slice(foods.indexOf('function onDestinationPicked'), foods.indexOf('function onDestinationPicked') + 400);
  assert.match(pickFn, /pickMeal = String\(Number\(e\.detail\?\.value\) \|\| 0\);\s*pickDate = _destDay \|\| pickDate \|\| localDateStr\(\);\s*_syncShortcutUrl\(\);\s*if \(\$diaryDate !== pickDate\) loadEntry\(pickDate\);/);
  assert.match(foods, /function onTabChange\(e\) \{\s*\/\/[^\n]*\n\s*rememberFoodsTab\(TABS\.findIndex\(t => t\.value === e\?\.detail\?\.value\)\);/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.foods.shortcut.change, 'Change');
  assert.ok(en.foods.shortcut.change_aria);
  assert.match(en.diary.shortcut.water_hidden, /Show In Diary/);
  assert.equal(en.settings_water.show_in_diary, 'Show In Diary', 'names the toggle as Settings does');
});

test('a web SSO sign-in comes back to the shortcut waiting under it', () => {
  // The sign-in page sends its address after the #.
  assert.equal(oidcReturnHash('#/?new=water', null, 'ok'), '/?new=water&oidc=ok');
  assert.equal(shortcutFromQuery(oidcReturnHash('#/?new=water', null, 'ok').split('?')[1]), 'water');
  assert.equal(oidcReturnHash('#/', null, 'ok'), '/?oidc=ok', 'no longer #/#/?oidc=ok');
  assert.equal(oidcReturnHash('', 'access_denied'), '/?oidc_error=access_denied');
  assert.equal(oidcReturnHash('/profile', null, 'linked'), '/profile?oidc=linked');
  assert.equal(oidcReturnHash('settings', null, null), '/settings');
  assert.equal(oidcReturnHash('#', null, 'ok'), '/?oidc=ok');
  assert.match(read('../server/routes/oidc.js'), /res\.redirect\(`\$\{basePath\}\/#\$\{oidcReturnHash\(returnPath, error, ok\)\}`\);/);
});

test('a shortcut replaces the first page when the app just started, else Back returns', () => {
  for (const h of ['', '#', '#/', '/']) assert.equal(shortcutNav(h), 'replace', JSON.stringify(h));
  for (const h of ['#/settings', '#/?note=1', '#/foods?pick=1', '#/shopping', '#/statistics']) assert.equal(shortcutNav(h), 'push', h);
  assert.equal(shortcutNav(undefined), 'replace');
  const app = read('../src/App.svelte');
  assert.equal((app.match(/\(await import\('svelte-spa-router'\)\)\[sc\.shortcutNav\(window\.location\.hash\)\]\(route\);/g) || []).length, 2, 'the launch URL and appUrlOpen');
});
