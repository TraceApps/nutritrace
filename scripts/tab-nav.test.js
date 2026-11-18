/**
 * From cooktrace#99: in the Android app every tab tap added to the back
 * history, so back walked through each tab visited before the app would
 * exit. In the app and the installed web app the history now holds at most
 * Diary, the tab you're on, and the pages opened inside it: back goes one
 * step inside a tab, then to Diary, then leaves (tab-nav.js is CookTrace's,
 * with this app's home tab). A browser tab keeps the browser's
 * usual history. These run tab-nav.js against a simulated browser history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/lib/tab-nav.js', import.meta.url), 'utf8');

// A browser's session history for one tab, as hash routing sees it.
class FakeWin {
  constructor(start = '/', { standalone = false } = {}) {
    this.entries = [{ path: start, state: null }];
    this.i = 0;
    this.listeners = { popstate: [], hashchange: [] };
    const self = this;
    this.history = {
      get length() { return self.entries.length; },
      get state() { return self.entries[self.i].state; },
      replaceState(state, _t, url) { self.entries[self.i] = { path: url ? url.replace(/^#/, '') : self.entries[self.i].path, state }; },
      go(n) { setTimeout(() => self._move(n), 1); },
      back() { this.go(-1); },
    };
    this.location = { get hash() { return '#' + self.entries[self.i].path; }, get href() { return 'app://x/#' + self.entries[self.i].path + '@' + self.i; } };
    this.matchMedia = () => ({ matches: standalone });
    this.navigator = {};
  }
  addEventListener(t, f) { this.listeners[t].push(f); }
  removeEventListener(t, f) { this.listeners[t] = this.listeners[t].filter(x => x !== f); }
  _fire(t) { for (const f of [...this.listeners[t]]) f({ type: t, state: this.history.state }); }
  _move(n) {
    const to = Math.max(0, Math.min(this.entries.length - 1, this.i + n));
    if (to === this.i) return;
    this.i = to; this._fire('popstate'); this._fire('hashchange');
  }
  // svelte-spa-router: push sets location.hash, replace spreads the state.
  push(p) { this.entries.splice(this.i + 1); this.entries.push({ path: p, state: null }); this.i++; this._fire('popstate'); this._fire('hashchange'); }
  replace(p) { this.entries[this.i] = { path: p, state: { ...(this.history.state || {}) } }; this._fire('hashchange'); }
  // What back can reach: entries up to the current one (forward ones are never used).
  paths() { return this.entries.slice(0, this.i + 1).map(e => e.path); }
  async back() { this._move(-1); await new Promise(r => setTimeout(r, 5)); }
}

async function load(win, { native }) {
  globalThis.__tabNavStub = { push: (p) => win.push(p), replace: (p) => win.replace(p), isNative: native };
  const code = SRC
    .replace(/import \{ push, replace \} from 'svelte-spa-router';/, 'const { push, replace } = globalThis.__tabNavStub;')
    .replace(/import \{ isNative \} from '\.\/platform\.js';/, 'const { isNative } = globalThis.__tabNavStub;');
  assert.doesNotMatch(code, /^import /m, 'every import was stubbed');
  const mod = await import('data:text/javascript,' + encodeURIComponent(code) + `%0A//${Math.random()}`);
  mod.trackTabDepth(win);
  const tab = (p) => mod.goTab(p, win);
  return { mod, tab };
}

test("the reporter's steps leave Diary and the last tab", async () => {
  const win = new FakeWin('/');
  const { tab } = await load(win, { native: true });
  for (const p of ['/', '/foods', '/statistics', '/', '/foods']) await tab(p);
  assert.deepEqual(win.paths(), ['/', '/foods']);
  assert.equal(win.i, 1);
  await win.back();
  assert.equal(win.location.hash, '#/', 'back goes to Diary');
  assert.equal(win.i, 0, 'and then there is nothing left to go back to');
});

test('pages opened inside a tab go back one step, and are dropped by the next tab', async () => {
  const win = new FakeWin('/');
  const { tab, mod } = await load(win, { native: true });
  await tab('/settings');
  win.push('/settings/ai');
  win.push('/settings');          // the page's own back arrow pushes
  assert.equal(mod._tabDepth(), 3);
  await tab('/statistics');
  assert.deepEqual(win.paths(), ['/', '/statistics'], 'Settings pages are gone');
  win.push('/statistics/5');
  await win.back();
  assert.equal(win.location.hash, '#/statistics', 'back from a page goes to its tab');
  await win.back();
  assert.equal(win.location.hash, '#/');
});

test('the Diary tab goes back to where the app started', async () => {
  const win = new FakeWin('/');
  const { tab } = await load(win, { native: true });
  await tab('/foods');
  win.push('/foods/3');
  await tab('/');
  assert.equal(win.i, 0);
  assert.equal(win.location.hash, '#/');
  // On a page inside it, Diary goes to its main page.
  win.push('/item/12');
  await tab('/');
  assert.equal(win.location.hash, '#/');
  assert.equal(win.i, 0);
});

test('tapping the tab you are on, or a filtered Diary, ends on the main page', async () => {
  const win = new FakeWin('/');
  const { tab } = await load(win, { native: true });
  await tab('/settings');
  win.push('/settings/ai');
  await tab('/settings');
  assert.deepEqual(win.paths(), ['/', '/settings']);
  await tab('/');
  win.replace('/?view=x');
  await tab('/');
  assert.equal(win.location.hash, '#/');
});

test('a start somewhere other than Diary (an app shortcut) is replaced, not stacked', async () => {
  const win = new FakeWin('/goals');
  const { tab } = await load(win, { native: true });
  await tab('/foods');
  assert.deepEqual(win.paths(), ['/foods']);
  await tab('/');
  assert.deepEqual(win.paths(), ['/']);
});

test('the installed web app works the same way', async () => {
  const win = new FakeWin('/', { standalone: true });
  const { tab } = await load(win, { native: false });
  for (const p of ['/foods', '/statistics', '/goals']) await tab(p);
  assert.deepEqual(win.paths(), ['/', '/goals']);
});

test('in a browser tab a tab adds to the history as before', async () => {
  const win = new FakeWin('/');
  const { tab } = await load(win, { native: false });
  for (const p of ['/foods', '/statistics']) await tab(p);
  assert.deepEqual(win.paths(), ['/', '/foods', '/statistics']);
});

test('a page that rewrites its address (Manage sections) keeps the count right', async () => {
  const win = new FakeWin('/');
  const { tab, mod } = await load(win, { native: true });
  await tab('/goals');
  win.history.replaceState(win.history.state, '', '#/goals/tags');   // Manage.svelte switching sections
  win.push('/goals/tags/x');
  assert.equal(mod._tabDepth(), 2);
  await win.back();
  assert.equal(mod._tabDepth(), 1);
  await tab('/foods');
  assert.deepEqual(win.paths(), ['/', '/foods']);
});

test('Diary is the home tab', async () => {
  const { mod } = await load(new FakeWin('/'), { native: true });
  for (const loc of ['/', '/?date=2026-11-01', '', null]) assert.equal(mod.isHomeTab(loc), true, String(loc));
  for (const loc of ['/foods', '/foods/12', '/settings/updates']) assert.equal(mod.isHomeTab(loc), false, loc);
  const w = (standalone, ios = false) => ({ matchMedia: () => ({ matches: standalone }), navigator: { standalone: ios } });
  assert.equal(mod.isAppLike(false, w(true)), true);
  assert.equal(mod.isAppLike(false, w(false, true)), true);
  assert.equal(mod.isAppLike(false, w(false)), false);
  assert.equal(mod.isAppLike(false, { matchMedia: () => { throw new Error('no'); } }), false);
});

test('the bottom bar and the sidebar use it, and the app starts counting at launch', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const p of ['../src/components/layout/BottomNav.svelte', '../src/components/layout/Sidebar.svelte']) {
    const src = read(p);
    assert.match(src, /function go\(path\) \{\s*goTab\(path\);/, p);
    assert.doesNotMatch(src, /\bpush\(path\)/, p);
  }
  const app = read('../src/App.svelte');
  assert.match(app, /onMount\(async \(\) => \{\s*trackTabDepth\(\);/);
  assert.match(app, /if \(canGoBack\) \{\s*window\.history\.back\(\);\s*\} else if \(!isHomeTab\(getStore\(location\)\)\) \{[\s\S]*?replace\(HOME_TAB\);\s*\} else \{/);
});

test('pages that rewrite their address keep the history state', () => {
  for (const p of ['../src/stores/auth.js']) {
    const src = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /replaceState\(null\b/, p);
  }
});
