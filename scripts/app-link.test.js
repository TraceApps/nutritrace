/**
 * Links that open the app (lib/app-link.js): the SSO return
 * <app>://oidc-callback?… and home screen shortcuts <app>://new/…, read the
 * same on every Android WebView. Older WebViews (124 on an Android 15
 * emulator) gave new URL('<app>://oidc-callback?token=…').hostname as '',
 * so the app ignored the SSO return and signing in never finished.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAppLink } from '../src/lib/app-link.js';

// How those older WebViews read a URL with a scheme the standard doesn't know.
class OldWebViewURL {
  constructor(s) {
    const m = /^([a-z][a-z0-9+.-]*):([^?#]*)(\?[^#]*)?/i.exec(String(s));
    if (!m) throw new TypeError('Invalid URL');
    this.protocol = m[1].toLowerCase() + ':';
    this.hostname = '';
    this.host = '';
    this.pathname = m[2];
    this.search = m[3] || '';
    this.searchParams = new URLSearchParams(this.search.slice(1));
  }
}

test('the SSO return and shortcuts are read as their host, path and query', () => {
  const a = parseAppLink('nutritrace://oidc-callback?token=abc.def&provider_id=2');
  assert.equal(a.scheme, 'nutritrace');
  assert.equal(a.host, 'oidc-callback');
  assert.equal(a.params.get('token'), 'abc.def');
  assert.equal(a.params.get('provider_id'), '2');
  const b = parseAppLink('lifttrace://oidc-callback/?code=xyz');
  assert.equal(b.host, 'oidc-callback');
  assert.equal(b.path, '/');
  assert.equal(b.params.get('code'), 'xyz');
  const c = parseAppLink('notetrace://new/checklist');
  assert.equal(c.host, 'new');
  assert.equal(c.path, '/checklist');
  const d = parseAppLink('CookTrace://OIDC-Callback?error=access%20denied#frag');
  assert.equal(d.host, 'oidc-callback');
  assert.equal(d.params.get('error'), 'access denied');
  const e = parseAppLink('nutritrace://callback?fitbit=connected');
  assert.equal(e.host, 'callback');
  assert.equal(e.params.get('fitbit'), 'connected');
  assert.equal(parseAppLink('not a link'), null);
  assert.equal(parseAppLink(''), null);
  assert.equal(parseAppLink(undefined), null);
});

test('it reads the same where the WebView leaves the host empty', () => {
  const link = 'nutritrace://oidc-callback?token=abc';
  assert.equal(new OldWebViewURL(link).hostname, '', 'the old reading this replaces');
  const real = globalThis.URL;
  globalThis.URL = OldWebViewURL;
  try {
    const a = parseAppLink(link);
    assert.equal(a.host, 'oidc-callback');
    assert.equal(a.params.get('token'), 'abc');
  } finally { globalThis.URL = real; }
});

test('the deep-link handler reads links with parseAppLink, not new URL()', () => {
  const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
  const start = app.indexOf("addListener('appUrlOpen'");
  assert.ok(start > 0, 'App.svelte listens for appUrlOpen');
  const handler = app.slice(start, start + 2500);
  assert.match(handler, /const link = parseAppLink\(url\);/);
  assert.match(handler, /const host = link\.host;/);
  assert.doesNotMatch(handler, /new URL\(url\)/);
  assert.doesNotMatch(handler, /u\.hostname/);
});
