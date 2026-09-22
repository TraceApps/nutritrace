/**
 * The update banner has to mean what it says, and its button has to work.
 *
 * Both were broken in the same way in all four apps: the banner told PWA
 * users to install something, and Reload called a function that only posts
 * skip-waiting to a waiting worker and does nothing at all when there is
 * none. These are the rules that keep it honest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const pwa = read('../src/lib/pwa-update.js');
const banner = read('../src/components/UpdateBanner.svelte');

test('Reload always reloads, waiting worker or not', () => {
  // A button that can silently do nothing is the bug being fixed here.
  assert.match(pwa, /export async function applyPwaUpdate/);
  assert.match(pwa, /_reloadOnce\(\);\n\}/);
  assert.match(pwa, /setTimeout\(_reloadOnce, \d+\)/);
});

test('checking for an update asks the browser, not the skip-waiting function', () => {
  // registerSW's return value ignores its argument and only posts
  // skip-waiting; the real check is registration.update().
  assert.match(pwa, /await registration\.update\(\)/);
  assert.doesNotMatch(pwa, /export function checkForPwaUpdate[\s\S]*?_updateSW\(\)/);
});

test('a worker already waiting still raises the banner', () => {
  // onNeedRefresh only fires on the transition, so a tab opened after the
  // worker started waiting would never hear about it.
  assert.match(pwa, /if \(registration\.waiting\) pwaUpdateReady\.set\(true\)/);
});

test('the registration is kept, because nothing else can ask for a check', () => {
  assert.match(pwa, /onRegisteredSW\(_swUrl, registration\)/);
});

test('the banner does not tell a web user to install anything', () => {
  // A page cannot install a release; it can reload a bundle it already has.
  assert.match(banner, /\{#if \$pwaUpdateReady\}\s*\n\s*\{\$_\('updates\.ready_headline'/);
  assert.match(banner, /\$pwaUpdateReady\s*\n?\s*\? \$_\('updates\.ready_cta'/);
});

test('both strings exist in English', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(typeof en.updates.ready_headline, 'string');
  assert.equal(typeof en.updates.ready_cta, 'string');
  assert.ok(!/install/i.test(en.updates.ready_cta));
});
