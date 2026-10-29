/**
 * The app icon's shortcuts open AppShortcutActivity first (from
 * TraceApps/nutritrace#278). Launchers start a shortcut with NEW_TASK and
 * CLEAR_TASK; aimed at MainActivity, that restarted the running app and
 * reloaded its page, so a change still waiting to save could be lost, and
 * Recents could open the shortcut again later. The pass-through activity has
 * its own task, shows nothing and stays out of Recents, and hands the link to
 * the running app (onNewIntent, appUrlOpen) or to a fresh start (the launch
 * URL), routed once either way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { shortcutRoute, firstLaunchRead } from '../src/lib/app-shortcut.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PKG = 'com.nutritrace.app';
const SCHEME = 'nutritrace';
const SHORTCUTS = [['barcode',  'barcode'],  ['food',  'food'],  ['water',  'water'],  ['weight',  'weight']];
const JAVA = `../android/app/src/main/java/${PKG.replace(/\./g, '/')}`;
const manifest = read('../android/app/src/main/AndroidManifest.xml');
const activity = (name) => {
  for (const m of manifest.matchAll(/<activity\b[^>]*>/g)) {
    if (!m[0].includes(`android:name=".${name}"`)) continue;
    if (m[0].endsWith('/>')) return m[0];
    return manifest.slice(m.index, manifest.indexOf('</activity>', m.index) + '</activity>'.length);
  }
  assert.fail(`${name} is in the manifest`);
};
const attrOf = (block, n) => (new RegExp(`android:${n}="([^"]*)"`).exec(block) || [])[1];

test('every shortcut opens the pass-through activity, with the same ids and links as before', () => {
  const xml = read('../android/app/src/main/res/xml/shortcuts.xml');
  const blocks = [...xml.matchAll(/<shortcut\b([\s\S]*?)<\/shortcut>/g)].map(m => m[1]);
  // Pinned shortcuts are kept by id: these must never change.
  assert.deepEqual(blocks.map(b => attrOf(b, 'shortcutId')), SHORTCUTS.map(s => s[0]));
  blocks.forEach((b, i) => {
    assert.equal(attrOf(b, 'action'), 'android.intent.action.VIEW');
    assert.equal(attrOf(b, 'targetPackage'), PKG);
    assert.equal(attrOf(b, 'targetClass'), `${PKG}.AppShortcutActivity`);
    assert.equal(attrOf(b, 'data'), `${SCHEME}://new/${SHORTCUTS[i][1]}`);
  });
  assert.doesNotMatch(xml, /targetClass="[^"]*MainActivity"/);
});

test('the manifest: its own task, nothing shown, out of Recents, and MainActivity as before', () => {
  const a = activity('AppShortcutActivity');
  assert.equal(attrOf(a, 'exported'), 'true', 'the launcher (and adb) can open it');
  assert.equal(attrOf(a, 'theme'), '@android:style/Theme.NoDisplay');
  assert.equal(attrOf(a, 'taskAffinity'), '', 'the launcher\'s CLEAR_TASK clears only its own task');
  assert.equal(attrOf(a, 'excludeFromRecents'), 'true');
  assert.equal(attrOf(a, 'noHistory'), 'true');
  assert.doesNotMatch(a, /<intent-filter/, 'explicit intents only; no web page can open it');

  const main = activity('MainActivity');
  assert.equal(attrOf(main, 'launchMode'), 'singleTask', 'a running app gets the link in onNewIntent');
  assert.equal(attrOf(main, 'taskAffinity'), undefined);
  assert.match(main, /<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>\s*<meta-data android:name="android.app.shortcuts" android:resource="@xml\/shortcuts" \/>/, 'the shortcuts stay on the launcher activity');
  // Sign-in return links are unchanged, and no web page opens SCHEME://new.
  const browsable = main.match(/<intent-filter[^>]*>(?:(?!<\/intent-filter>)[\s\S])*BROWSABLE(?:(?!<\/intent-filter>)[\s\S])*<\/intent-filter>/g) || [];
  assert.equal(browsable.length, 1);
  assert.deepEqual([...browsable[0].matchAll(/<data android:scheme="(\w+)" android:host="([\w-]+)" \/>/g)].map(m => `${m[1]}://${m[2]}`), ['nutritrace://callback', 'nutritrace://oidc-callback']);
});

test('the link goes on to the running MainActivity, never restarting it', () => {
  const java = read(`${JAVA}/AppShortcutActivity.java`);
  assert.match(java, /out\.addFlags\(Intent\.FLAG_ACTIVITY_NEW_TASK \| Intent\.FLAG_ACTIVITY_CLEAR_TOP \| Intent\.FLAG_ACTIVITY_SINGLE_TOP\);/);
  assert.doesNotMatch(java.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''), /CLEAR_TASK|MULTIPLE_TASK|NO_HISTORY/);
  assert.match(java, /new Intent\(context, MainActivity\.class\)/);
  assert.match(java, /out\.setData\(Uri\.parse\(MainActivity\.LINK_SCHEME \+ "\:\/\/new\/" \+ kind\)\)/, 'a rebuilt link, nothing else from the intent');
  assert.match(java, /startActivity\(forward\(this, .*\)\);\s*finish\(\);/, 'finishes at once');

  const main = read(`${JAVA}/MainActivity.java`);
  assert.match(main, new RegExp(`static final String LINK_SCHEME = "${SCHEME}";`));
  const create = main.slice(main.indexOf('public void onCreate('));
  const drop = create.indexOf('AppShortcutActivity.dropReplayedLink(this, savedInstanceState);');
  assert.ok(drop > 0 && drop < create.indexOf('super.onCreate(savedInstanceState);'), 'before the bridge reads the launch URL');
  // Recents hands back the task's first intent: dropped there, kept on a real start.
  assert.match(java, /\(in\.getFlags\(\) & Intent\.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY\) != 0;\s*if \(!fromRecents && savedInstanceState == null\) return;/);
});

// The same file in NutriTrace, LiftTrace, CookTrace and NoteTrace, below its
// package line. Change all four copies together, then this hash in every app.
test('AppShortcutActivity.java matches the hash every Trace app pins', () => {
  const java = read(`${JAVA}/AppShortcutActivity.java`);
  assert.equal(java.slice(0, java.indexOf('\n') + 1), `package ${PKG};\n`);
  const sha = createHash('sha256').update(java.slice(java.indexOf('\n') + 1)).digest('hex');
  assert.equal(sha, '25258ed3b7d9e1a2a67bd24bf5854f29446ad146bd767337a9b2bc855b2009fe');
});

test('a shortcut is routed once, in a running app and on a fresh start', () => {
  const t = 7_000_000;
  // A running app: onNewIntent fires appUrlOpen once, and nothing else reads it.
  assert.equal(shortcutRoute('barcode', t), '/?new=barcode');
  // Tapped again a while later: a new tap, routed again.
  assert.equal(shortcutRoute('barcode', t + 60_000), '/?new=barcode');
  // A fresh start: the launch URL and appUrlOpen both carry it, routed once.
  assert.equal(shortcutRoute('weight', t + 120_000), '/?new=weight');
  assert.equal(shortcutRoute('weight', t + 120_050), null);
  const app = read('../src/App.svelte');
  assert.equal((app.match(/App\.getLaunchUrl/g) || []).length, 1, 'read once, at start');
  assert.equal((app.match(/addListener\('appUrlOpen'/g) || []).length, 1);
  assert.equal((app.match(/sc\.shortcutRoute\(/g) || []).length, 2, 'the launch URL and appUrlOpen, both through the same check');
});

test('the launch URL opens its shortcut once, not again after a page reload', () => {
  // Capacitor keeps the launch URL for as long as the app runs; signing out or
  // restoring a backup reloads the page and would open the shortcut again.
  const m = new Map();
  const store = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.equal(firstLaunchRead(store), true, 'the first page');
  assert.equal(firstLaunchRead(store), false, 'the same page session, reloaded');
  assert.equal(firstLaunchRead({ getItem() { throw new Error('blocked'); } }), true, 'no storage: as before');
  const app = read('../src/App.svelte');
  const launch = app.slice(app.indexOf('App.getLaunchUrl'), app.indexOf("addListener('appUrlOpen'"));
  assert.match(launch, /if \(!sc\.firstLaunchRead\(\)\) return;[^\n]*\n\s*(?:\/\/[^\n]*\n\s*)*const route = sc\.shortcutRoute\(/);
});
