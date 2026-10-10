/**
 * Update checks are off until someone says yes.
 *
 * The check used to run from every browser straight to the GitHub API,
 * every 4 hours, with no way to answer the question and nothing in the
 * privacy page about it. Now: the server does the asking, a fresh install
 * starts off and setup asks, an install that predates the question keeps
 * checking, and UPDATE_CHECK=off turns it off for good.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const policy  = read('../server/lib/update-check.js');
const route   = read('../server/routes/updates.js');
const client  = read('../src/lib/updates.js');
const wizard  = read('../src/routes/Wizard.svelte');
const banner  = read('../src/components/UpdateBanner.svelte');
const settings = read('../src/components/settings/SettingsUpdates.svelte');

test('the instance asks GitHub only when the setting says so', () => {
  assert.match(policy, /export function updateCheckEnabled\(\) \{\s*if \(envLocksUpdateCheck\(\)\) return false;\s*return _get\(KEY\) === '1';/);
  // The guard sits before anything that could fetch.
  const at = route.indexOf("router.get('/server-status'");
  const handler = route.slice(at, route.indexOf('await _fetchLatest(channel)', at));
  assert.ok(handler.includes('if (!updateCheckEnabled())'), 'guarded before the fetch');
  assert.match(handler, /return res\.json\(\{ disabled: true/);
});

test('UPDATE_CHECK=off wins over the setting and refuses to be turned on', () => {
  assert.match(policy, /export function envLocksUpdateCheck\(\) \{\s*return \/\^\(0\|off\|false\|no\)\$\/i\.test/);
  const put = route.slice(route.indexOf("router.put('/config'"));
  assert.match(put, /if \(envLocksUpdateCheck\(\)\) return res\.status\(409\)/);
});

test('an existing instance keeps checking; a fresh one waits to be asked', () => {
  assert.match(policy, /export function initUpdateCheckSetting\(\)/);
  assert.match(policy, /SELECT 1 FROM users LIMIT 1/);
  assert.match(policy, /_set\(KEY, existing \? '1' : '0'\);/);
  assert.match(read('../server/index.js'), /initUpdateCheckSetting\(\);/, 'runs at startup');
});

test('a device with no answer checks nothing; one that was already using the app keeps checking', () => {
  assert.match(client, /export function getAutoCheck\(\) \{[\s\S]*?=== '1';/, 'off unless explicitly on');
  assert.doesNotMatch(client.slice(client.indexOf('export function getAutoCheck')), /v === null \? true/);
  assert.match(client, /export function migrateAutoCheck\(\)/);
  assert.match(read('../src/App.svelte'), /migrateAutoCheck\(\)/, 'runs at startup');
});

test('the browser asks this instance, not GitHub', () => {
  const check = client.slice(client.indexOf('export async function checkForUpdate'));
  assert.match(check, /if \(!isNative\) return await _latestViaServer/);
  const beforeFetch = check.slice(0, check.indexOf('api.github.com'));
  assert.ok(beforeFetch.includes('_latestViaServer'), 'the server path comes first');
});

test('setup asks, with the toggle off to begin with', () => {
  for (const list of ["'notifications','updates','summary'", "'notifications','updates','summary'"]) assert.ok(wizard.includes(list));
  assert.equal((wizard.match(/'updates','summary'/g) || []).length, 3, 'every step list');
  assert.match(wizard, /let updateChecks = false;/);
  assert.match(wizard, /if \(currentStepName === 'updates'\) \{\s*await _saveUpdateChoice\(\);/);
});

test('when checks are off, the app says so once', () => {
  assert.match(banner, /offNoticeVisible = autoCheckAnswered\(\) && !seen;/);
  assert.match(banner, /localStorage\.setItem\(OFF_NOTICE_KEY, '1'\)/, 'only once');
  assert.match(settings, /\{#if !autoCheck\}[\s\S]{0,120}updates\.off_resting/, 'Settings says it plainly');
});

test('the answer is written to both the device and the instance', () => {
  assert.match(client, /export async function setServerUpdateCheck\(enabled\)/);
  assert.match(client, /'X-CSRF-Token': csrf/, 'the write needs the token');
  for (const [name, src] of [['wizard', wizard], ['settings', settings], ['banner', banner]]) {
    assert.match(src, /setServerUpdateCheck\(/, name);
  }
});
