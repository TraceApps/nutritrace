/**
 * Bottom dock (#208). Diary's summary bar and the tab bar used to be two
 * independently fixed elements, the bar placed by its own arithmetic
 * (tab bar height plus the safe area) instead of being attached to the tab
 * bar. On an iPhone they drifted apart, leaving a see-through gap. Both now
 * live in one fixed container in App.svelte, so they cannot separate.
 *
 * These checks keep it that way: neither bar may go back to positioning
 * itself, and the summary bar must mount into the dock rather than <body>.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { portal } from '../src/lib/portal.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../src/App.svelte');
const nav = read('../src/components/layout/BottomNav.svelte');
const diary = read('../src/routes/Diary.svelte');
const cssBlock = (src, sel) => {
  const i = src.search(new RegExp(`^\\s*${sel.replace('.', '\\.')}\\s*\\{`, 'm'));
  assert.ok(i >= 0, `${sel} rule not found`);
  return src.slice(i, src.indexOf('}', i) + 1);
};

test('App renders one bottom dock holding the slot and the tab bar', () => {
  const dock = app.slice(app.indexOf('<div class="bottom-dock"'), app.indexOf('</div>', app.indexOf('id="bottom-dock-slot"') + 30) + 6);
  assert.match(dock, /id="bottom-dock-slot"/);
  assert.match(dock, /<BottomNav \/>/);
  assert.equal((app.match(/<BottomNav \/>/g) || []).length, 1, 'the tab bar is rendered only inside the dock');
});

test('the dock renders before the page so the slot exists when Diary mounts', () => {
  const slot = app.indexOf('id="bottom-dock-slot"');
  assert.ok(slot >= 0, 'the dock slot must exist');
  assert.ok(slot < app.indexOf('class="page-transition"'));
});

test('the dock owns the fixed positioning and the sidebar offset', () => {
  const dock = cssBlock(app, '.bottom-dock');
  assert.match(dock, /position:\s*fixed/);
  assert.match(dock, /bottom:\s*0/);
  assert.match(dock, /left:\s*var\(--sidebar-w/);
  // The old per-bar offsets would now push relative children sideways.
  assert.doesNotMatch(app, /:global\(\.bottom-nav\)\s*\{[^}]*left:/);
  assert.doesNotMatch(app, /:global\(\.diary-bottom-bar\)\s*\{[^}]*left:/);
});

test('neither bar positions itself any more', () => {
  for (const [src, sel] of [[nav, '.bottom-nav'], [diary, '.diary-bottom-bar']]) {
    const rule = cssBlock(src, sel);
    assert.doesNotMatch(rule, /position:\s*fixed/, `${sel} must not be fixed`);
    assert.doesNotMatch(rule, /(?:^|[\s;{])bottom\s*:/, `${sel} must not set bottom`);
  }
  assert.doesNotMatch(diary, /barBottom/, 'the old bottom-offset arithmetic is gone');
});

test('without the tab bar, the bar itself covers the home indicator strip', () => {
  // Padding on the transparent dock left a see-through strip under the bar
  // on iPhones using the menu button instead of the tab bar (#208).
  assert.doesNotMatch(app, /\.bottom-dock\.no-nav\s*\{[^}]*padding/);
  assert.match(app, /\.bottom-dock\.no-nav #bottom-dock-slot > :global\(:last-child\)\s*\{\s*padding-bottom:\s*var\(--safe-bottom\)/);
});

test('the summary bar mounts into the dock slot, not <body>', () => {
  assert.match(diary, /use:portal=\{'#bottom-dock-slot'\} class="diary-bottom-bar"/);
});

test('portal mounts into the target, falls back to body, and cleans up', () => {
  const made = [];
  const el = (name) => { const e = { name, children: [], parentNode: null,
    appendChild(c) { c.parentNode = e; e.children.push(c); },
    removeChild(c) { e.children = e.children.filter(x => x !== c); c.parentNode = null; } }; made.push(e); return e; };
  const body = el('body'), slot = el('slot');
  globalThis.document = { body, querySelector: (s) => (s === '#bottom-dock-slot' ? slot : null) };
  try {
    const a = el('bar');
    const handle = portal(a, '#bottom-dock-slot');
    assert.equal(a.parentNode, slot);
    handle.destroy();
    assert.equal(a.parentNode, null);
    assert.equal(slot.children.length, 0);

    const b = el('sheet');
    portal(b);
    assert.equal(b.parentNode, body, 'no target keeps the old behaviour');

    const c = el('orphan');
    portal(c, '#missing');
    assert.equal(c.parentNode, body, 'a missing target falls back to body');
  } finally {
    delete globalThis.document;
  }
});

test('the iPhone home-screen height workaround is scoped to home-screen launches', () => {
  // iOS can open a home-screen app with the window shorter than the screen,
  // leaving a black strip along the bottom until something scrolls (#208).
  const html = read('../index.html');
  const css = read('../src/styles/base.css');
  assert.match(html, /if \(window\.navigator\.standalone === true\) document\.documentElement\.classList\.add\('ios-home-screen'\);/);
  // Set in <head> before the stylesheet loads, so the first layout already has it.
  assert.ok(html.indexOf("classList.add('ios-home-screen')") < html.indexOf('<body'));
  assert.match(css, /html\.ios-home-screen #app \{ min-height: 100vh; \}/);
  // Everywhere else keeps the dynamic height, which follows Safari's toolbar.
  assert.match(cssBlock(css, '#app'), /min-height: 100dvh/);
});
