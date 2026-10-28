/**
 * How the service worker answers a page load (TraceApps/notetrace#37):
 * from the server when it answers, the cached app page only offline. A
 * refresh after an update gets the new version, and a sign-in proxy whose
 * session ran out can show its sign-in page instead of the cached app.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isAppPageLoad, treatServerErrorAsOffline, keepNoPageCopy, useCachedAppOnTimeout } from '../src/lib/pwa-navigation.js';

const vite = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
const load = (p, mode = 'navigate') => ({ request: { mode }, url: new URL(p, 'https://nutrition.example.com') });

// Workbox copies the functions into the service worker as text, so they have
// to work with nothing around them.
const standalone = (fn, context = {}) => vm.runInNewContext(`(${fn.toString()})`, context);

test('the manifest is fetched with the sign-in proxy cookie', () => {
  assert.match(vite, /useCredentials: true/);
});

test('no cached page answers a page load before the server does', () => {
  // Vite PWA adds navigateFallback: 'index.html' unless it is null, and the
  // precache answers '/' as index.html unless directoryIndex is null. Either
  // runs ahead of runtimeCaching.
  assert.match(vite, /navigateFallback: null,/);
  assert.match(vite, /directoryIndex: null,/);
  const routes = vite.slice(vite.indexOf('runtimeCaching: ['));
  assert.ok(routes.indexOf('urlPattern: isAppPageLoad') < routes.indexOf("urlPattern: ({ request }) => request.mode === 'navigate'"), 'the app page route comes first');
  const appRoute = routes.slice(routes.indexOf('urlPattern: isAppPageLoad'), routes.indexOf('}', routes.indexOf('plugins: [')) + 1);
  assert.match(appRoute, /handler: 'NetworkFirst'/);
  assert.match(appRoute, /networkTimeoutSeconds: 3/);
  assert.match(appRoute, /precacheFallback: \{ fallbackURL: 'index.html' \}/);
  assert.match(appRoute, /fetchDidSucceed: treatServerErrorAsOffline, cacheWillUpdate: keepNoPageCopy, cachedResponseWillBeUsed: useCachedAppOnTimeout/);
});

test('the app page loads go to the server, under a base path too', () => {
  for (const isApp of [isAppPageLoad, standalone(isAppPageLoad)]) {
    for (const p of ['/', '/?date=2026-10-27', '/index.html', '/nutritrace/', '/diary']) assert.equal(isApp(load(p)), true, p);
    for (const p of ['/api/auth/oidc/login', '/uploads/a.png', '/uploads/backups/b.zip']) assert.equal(isApp(load(p)), false, p);
    assert.equal(isApp(load('/', 'cors')), false, 'not a page load');
  }
  const underBase = standalone(isAppPageLoad, { self: { registration: { scope: 'https://nutrition.example.com/nutritrace/' } }, URL });
  for (const p of ['/nutritrace/', '/nutritrace/?date=2026-10-27', '/nutritrace/diary']) assert.equal(underBase(load(p)), true, p);
  for (const p of ['/nutritrace/api/auth/oidc/login/1', '/nutritrace/uploads/a.png']) assert.equal(underBase(load(p)), false, p);
});

test('a server that takes too long gets the cached app page, not a blank window', async () => {
  const stored = { 'workbox-precache-v2-https://nutrition.example.com/nutritrace/': { 'https://nutrition.example.com/nutritrace/index.html': 'app page' }, 'pages-cache': { 'https://nutrition.example.com/nutritrace/index.html': 'other' } };
  const caches = {
    keys: async () => Object.keys(stored),
    open: async name => ({ match: async (url, opts) => (assert.equal(opts.ignoreSearch, true), stored[name][url]) }),
  };
  const context = { self: { registration: { scope: 'https://nutrition.example.com/nutritrace/' } }, caches, URL };
  const use = standalone(useCachedAppOnTimeout, context);
  assert.equal(await use({ cachedResponse: undefined }), 'app page');
  assert.equal(await use({ cachedResponse: 'copy' }), 'copy');
  delete stored['workbox-precache-v2-https://nutrition.example.com/nutritrace/'];
  assert.equal(await use({ cachedResponse: undefined }), null);
});

test('a proxy answering for a stopped server opens the cached app, as offline', async () => {
  for (const check of [treatServerErrorAsOffline, standalone(treatServerErrorAsOffline)]) {
    for (const status of [500, 502, 503, 504]) await assert.rejects(check({ response: { status } }), String(status));
    // Its sign-in page, a redirect to it (opaqueredirect, status 0) and a
    // basic-auth challenge reach the browser as they are.
    for (const status of [200, 0, 302, 401, 404]) {
      const response = { status };
      assert.equal(await check({ response }), response, String(status));
    }
  }
});

test('page loads are never stored, so a sign-in page never stands in for the app', async () => {
  for (const keep of [keepNoPageCopy, standalone(keepNoPageCopy)]) {
    assert.equal(await keep({ response: { status: 200 } }), null);
  }
});

test('page loads the server answers itself are never kept', () => {
  const routes = vite.slice(vite.indexOf('runtimeCaching: ['));
  assert.doesNotMatch(vite, /cacheName: 'pages-cache'/);
  const rest = routes.slice(routes.indexOf("urlPattern: ({ request }) => request.mode === 'navigate'"));
  assert.match(rest.slice(0, rest.indexOf('\n          },')), /handler: 'NetworkOnly'/);
});

test('the old page cache, with API and upload page loads in it, is deleted on update', async () => {
  assert.match(vite, /importScripts: \[[^\]]*'sw-retired-caches\.js'/);
  const code = readFileSync(new URL('../public/sw-retired-caches.js', import.meta.url), 'utf8');
  const listeners = {}, deleted = [], waited = [];
  vm.runInNewContext(code, {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    caches: { delete: async name => { deleted.push(name); return true; } },
  });
  listeners.activate({ waitUntil: p => waited.push(p) });
  await Promise.all(waited);
  assert.deepEqual(deleted, ['pages-cache']);
});
