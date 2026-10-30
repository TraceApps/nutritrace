/**
 * The app's side of signing sessions out (#222): where a new session is
 * taken, where a signed-out device goes, and what it keeps.
 *
 * - The device that changed the password, turned two-step sign-in on or
 *   off, or chose Sign Out Everywhere takes the new session from the
 *   answer (lib/fresh-session.js):
 *   the Android app's token and biometric copy, the browser's CSRF token.
 * - Every other device, told session_ended, lands on the sign-in page with
 *   a plain message, from any of the ways it can hear it: /me at start, an
 *   API call, the Android sync.
 * - Signed out that way, nothing waiting to go up is dropped: the browser's
 *   queue and the phone's unsent changes stay for the next sign-in.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the device that made the change takes its new session', () => {
  const fresh = read('../src/lib/fresh-session.js');
  assert.match(fresh, /setAuthToken\(session\.token\)/);
  assert.match(fresh, /if \(await readSavedToken\(\)\) await saveTokenForBiometric\(session\.token\)/, 'biometric unlock keeps a working copy');
  assert.match(fresh, /localStorage\.setItem\('nt:csrf', session\.csrf\)/);
  const profile = read('../src/routes/Profile.svelte');
  const pw = profile.slice(profile.indexOf('async function changePassword'));
  assert.match(pw, /await adoptSession\(data\.session\);\s*showSuccess\(\$_\('profile\.password_changed'\)\)/);
  const two = read('../src/lib/two-step.js');
  assert.match(two, /if \(res\.ok && data\?\.session && !body\?\.pending_token\) \{[\s\S]*?await adoptSession\(data\.session\);/);
});

test('Sign Out Everywhere is in Profile, asks first, sends the CSRF token, and keeps this device', () => {
  const profile = read('../src/routes/Profile.svelte');
  const fn = profile.slice(profile.indexOf('async function signOutEverywhere'), profile.indexOf('async function changePassword'));
  assert.match(fn, /const ok = await confirmDialog\(\{[\s\S]*?dangerous: true,/);
  assert.match(fn, /if \(!ok\) return;/);
  assert.match(fn, /apiUrl\('\/api\/auth\/sign-out-everywhere'\)/);
  assert.match(fn, /'X-CSRF-Token': csrf/);
  assert.match(fn, /await adoptSession\(data\.session\);/);
  assert.match(profile, /\{#if \$userMgmtActive\}\s*<button class="security-row" on:click=\{signOutEverywhere\}/);
  const settings = read('../src/routes/Settings.svelte');
  assert.match(settings, /profile:\s*\[[^\]]*'sign out everywhere'/, 'Settings search finds it');
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['sign_out_everywhere', 'sign_out_everywhere_hint', 'sign_out_everywhere_title', 'sign_out_everywhere_message', 'signed_out_everywhere']) assert.ok(en.profile[k], k);
  assert.ok(en.login.session_ended);
});

test('a signed-out device lands on the sign-in page with a plain message, however it hears', () => {
  const auth = read('../src/stores/auth.js');
  assert.match(auth, /export const sessionEnded = writable\(false\);/);
  assert.match(auth, /if \(!user && meData\.session_ended\) \{\s*sessionEnded\.set\(true\);/, 'the web, at start');
  assert.match(auth, /if \(meData\?\.session_ended && !meData\.user\) \{\s*const \{ endSessionHere \}/, 'the Android app, at start');
  assert.match(auth, /currentUser\.subscribe\(\(u\) => \{ if \(u\) \{ authUnreachable\.set\(null\); sessionEnded\.set\(false\); \} \}\);/, 'gone once signed in');
  const api = read('../src/lib/api.js');
  assert.match(api, /if \(res\.status === 401 && e\.session_ended\) import\('\.\/fresh-session\.js'\)\.then\(\(m\) => m\.endSessionHere\(\)\)/, 'any API call');
  const sync = read('../src/lib/sync.js');
  assert.match(sync, /if \(body\?\.session_ended\) \{[\s\S]*?sessionEnded\.set\(true\);/, 'the Android sync');
  assert.equal([...sync.matchAll(/_handleSyncAuthError\((res|errText), token\)/g)].length, 3);
  // Refused for a token since replaced (this phone just took a new session): nothing is cleared.
  assert.match(sync, /if \(sentWith && sentWith !== getAuthToken\(\)\) return;/);
  const login = read('../src/routes/Login.svelte');
  assert.match(login, /\{#if \$sessionEnded && !challenge\}[\s\S]*?\$_\('login\.session_ended'\)/);
});

test('a refusal for a session this device has since replaced never signs it out', () => {
  const fresh = read('../src/lib/fresh-session.js');
  assert.match(fresh, /export async function endSessionHere\(\) \{\s*if \(await _stillSignedIn\(\)\) return;/);
  assert.match(fresh, /async function _stillSignedIn\(\) \{[\s\S]*?\/api\/auth\/me[\s\S]*?return !!\(await res\.json\(\)\)\?\.user;/);
});

test('signed out that way, nothing waiting to go up is dropped', () => {
  const fresh = read('../src/lib/fresh-session.js');
  const end = fresh.slice(fresh.indexOf('export async function endSessionHere'));
  // Never the sign-out path's clearing: the queue, the mirror and the phone's copy stay.
  assert.doesNotMatch(end, /clearOffline|dbClearUserData|resetUserState|unpairWatch/);
  // The browser's queue is filed under the last account seen, so it waits for that account.
  const offline = read('../src/lib/offline-api.js');
  assert.match(offline, /if \(user\) localStorage\.setItem\(_USER_KEY, user\);\s*else user = localStorage\.getItem\(_USER_KEY\);/);
  // The phone keeps unsent changes per account and sends them at its next sign-in.
  const account = read('../src/lib/local-account.js');
  assert.match(account, /signing out and back in to the same account keeps everything,\s*\*\s*including changes still waiting/);
});

test('the Android app links a provider in the phone\'s browser and comes back through its own link', () => {
  const profile = read('../src/routes/Profile.svelte');
  const fn = profile.slice(profile.indexOf('async function linkGranted'), profile.indexOf('async function linkGranted') + 900);
  assert.match(fn, /if \(isNative\) \{[\s\S]*?Browser\.open\(\{ url: `\$\{url\}&mobile=1`/);
  // Back in the app, the list shows the new link (the account is read again).
  assert.match(profile, /\$: if \(Array\.isArray\(\$currentUser\?\.linked_providers\)\) linkedProviders = \$currentUser\.linked_providers;/);
});
