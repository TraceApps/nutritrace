/**
 * Signing in from a plain-HTTP page. The sign-in cookie is HTTPS-only unless
 * INSECURE_COOKIES=1, so the browser drops it and the user loops back to the
 * login page with no error (#20, #41, #43, #195). The login page and the
 * setup wizard now say why, before and after signing in, and the server log
 * says so too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cookieBlockedByHttp, droppedCookieReason, COOKIE_HELP_URLS } from '../src/lib/cookie-check.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('blocked only when the cookie is HTTPS-only and the page is not secure', () => {
  const secureCookie = { secure_cookies: true }, lanCookie = { secure_cookies: false };
  assert.equal(cookieBlockedByHttp(secureCookie, { secureContext: false }), true, 'plain HTTP, HTTPS-only cookie');
  assert.equal(cookieBlockedByHttp(secureCookie, { secureContext: true }), false, 'HTTPS or localhost');
  assert.equal(cookieBlockedByHttp(lanCookie, { secureContext: false }), false, 'INSECURE_COOKIES=1 on a LAN');
  assert.equal(cookieBlockedByHttp(secureCookie, { secureContext: false, native: true }), false, 'the Android app signs in with a token');
  assert.equal(cookieBlockedByHttp(null, { secureContext: false }), false, 'no answer from the server: claim nothing');
  assert.equal(cookieBlockedByHttp({}, { secureContext: false }), false, 'an older server that does not say');
});

test('a sign-in that did not stick is put down to HTTP only when it was HTTP', () => {
  assert.equal(droppedCookieReason({ secure_cookies: true }, { secureContext: false }), 'http');
  assert.equal(droppedCookieReason({ secure_cookies: true }, { secureContext: true }), 'dropped');
  assert.equal(droppedCookieReason(null, { secureContext: false }), 'dropped');
});

test('the server reports the cookie setting and logs a plain-HTTP sign-in', () => {
  const auth = read('../server/routes/auth.js');
  assert.match(auth, /secure_cookies: !_insecureCookies,/, '/status says whether the cookie is HTTPS-only');
  const login = auth.slice(auth.indexOf("router.post('/login'"), auth.indexOf("router.post('/logout'"));
  assert.match(login, /warnIfPlainHttp\(req\);\s*\n\s*res\.cookie\('nt_token'/, 'logged when signing in');
  const register = auth.slice(auth.indexOf("router.post('/register'"), auth.indexOf("res.json({ user: safeUser(user) });", auth.indexOf("router.post('/register'")));
  assert.match(register, /warnIfPlainHttp\(req\);\s*\n\s*res\.cookie\('nt_token'/, 'and when the first account signs in');
  assert.match(auth, /if \(_insecureCookies\) return;/, 'never on a server set up for plain HTTP');
});

test('the login page and the wizard show it, before and after signing in', () => {
  const login = read('../src/routes/Login.svelte');
  assert.match(login, /if \(cookieBlockedByHttp\(data, \{ native: isNative \}\)\) signInProblem\.set\('http'\);/);
  assert.match(login, /if \(!isNative && !get\(currentUser\)\) \{\s*\n\s*signInProblem\.set\(droppedCookieReason/,
    'checked with get(): setting the user tears the page down, and its $store stops updating');
  assert.match(login, /\{#if \$signInProblem\}\s*\n\s*<CookieWarning reason=\{\$signInProblem\} \/>/);
  const wizard = read('../src/routes/Wizard.svelte');
  assert.match(wizard, /if \(cookieBlockedByHttp\(d\)\) signInProblem\.set\('http'\)/);
  assert.match(wizard, /if \(_isPwa && !get\(currentUser\)\) \{\s*\n\s*signInProblem\.set\(droppedCookieReason\(_authStatus\)\);/);
  assert.match(wizard, /<CookieWarning reason=\{\$signInProblem\} \/>/);
  assert.match(read('../src/stores/auth.js'), /export const signInProblem = writable\(null\);/);
  // No flash: on the web the user is only set once the server confirms the
  // session (loadAuthState), never straight from the login reply.
  assert.match(login, /if \(isNative\) currentUser\.set\(data\.user\);/);
  assert.doesNotMatch(login, /\n\s*currentUser\.set\(data\.user\);/);
});

test('the warning has its words and points at the fix', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['http_title', 'http_body', 'dropped_title', 'dropped_body', 'fix_link']) {
    assert.ok(en.login.cookie_warning[k], k);
  }
  assert.match(en.login.cookie_warning.http_body, /INSECURE_COOKIES=1/);
  assert.equal(COOKIE_HELP_URLS.http, 'https://traceapps.github.io/docs/getting-started/lan-http/');
  assert.equal(COOKIE_HELP_URLS.dropped, 'https://traceapps.github.io/docs/getting-started/reverse-proxy/');
  assert.match(read('../src/components/ui/CookieWarning.svelte'), /href=\{COOKIE_HELP_URLS\[reason\] \|\| COOKIE_HELP_URLS\.http\}/);
});
