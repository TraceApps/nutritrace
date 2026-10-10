/**
 * Which file in a release is this phone's app.
 *
 * The watch build sits in the same release under the same package id, so it
 * installs straight over the phone app. Picking by position in the asset list
 * is picking by upload order, which is how a phone ends up offered a watch
 * build as its own update.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickApkAsset, isWatchApk } from '../src/lib/apk-asset.js';

const asset = (name) => ({ name, browser_download_url: `https://x/${name}`, size: 1 });

test('the phone build is picked whichever order they are listed in', () => {
  const phone = asset('notetrace-v1.0.1.apk');
  const watch = asset('notetrace-wear-v1.0.1.apk');
  assert.equal(pickApkAsset([phone, watch])?.name, phone.name);
  // The real hazard: GitHub lists assets in upload order, so this is the
  // same release with the watch build uploaded first.
  assert.equal(pickApkAsset([watch, phone])?.name, phone.name);
});

test('a release with only the watch build offers nothing', () => {
  // Installing it would replace this app with one that cannot run here. No
  // update is the better answer.
  assert.equal(pickApkAsset([asset('lifttrace-wear-v1.3.0.apk')]), null);
});

test('other files in the release are ignored', () => {
  const phone = asset('cooktrace-v1.2.0.apk');
  assert.equal(
    pickApkAsset([asset('checksums.txt'), asset('source.zip'), phone])?.name,
    phone.name,
  );
  assert.equal(pickApkAsset([asset('notes.md')]), null);
  assert.equal(pickApkAsset([]), null);
  assert.equal(pickApkAsset(undefined), null);
  assert.equal(pickApkAsset([null, { size: 2 }]), null);
});

test('"wear" and "watch" are read as words, not as letters in a name', () => {
  assert.equal(isWatchApk('notetrace-wear-v1.0.1.apk'), true);
  assert.equal(isWatchApk('lifttrace_watch_1.3.0.apk'), true);
  assert.equal(isWatchApk('app-wear.apk'), true);
  // A name that merely contains the letters is not a watch build.
  assert.equal(isWatchApk('swearword-v1.apk'), false);
  assert.equal(isWatchApk('stopwatchtrace-v1.apk'), false);
  assert.equal(isWatchApk('notetrace-v1.0.1.apk'), false);
});
