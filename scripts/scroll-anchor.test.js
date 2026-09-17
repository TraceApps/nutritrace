/**
 * #217: the Foods filter rail and detail pane are fixed-positioned and
 * portaled out of the page, with their top measured in JS. That measurement
 * read window.scrollY, which is always 0 here because the page scrolls
 * inside .page-transition. Once the user had scrolled, the next list resize
 * (loading more search results) re-measured them to the top of the screen,
 * over the header and the search bar. Diary's rail measured the same way,
 * and Foods restored its scroll position from the same wrong number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageScroller, pageScrollTop, pageScrollTo, restorePageScroll } from '../src/lib/scroll-anchor.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function fakeDom({ scrollTop = 0, overflowY = 'auto', scrollHeight = 5000, clientHeight = 800 } = {}) {
  const scroller = { nodeType: 1, classList: { contains: (c) => c === 'page-transition' }, scrollTop, scrollHeight, clientHeight, parentElement: null };
  const middle = { nodeType: 1, classList: { contains: () => false }, scrollHeight: 100, clientHeight: 100, parentElement: scroller };
  const leaf = { nodeType: 1, classList: { contains: () => false }, scrollHeight: 50, clientHeight: 50, parentElement: middle };
  const saved = {};
  const globals = {
    document: { querySelector: (s) => (s === '.page-transition' ? scroller : null), documentElement: { scrollTop: 0 } },
    window: { scrollY: 0, scrollTo: (x, y) => { globals.window._scrolledTo = y; } },
    getComputedStyle: (node) => ({ overflowY: node === scroller ? overflowY : 'visible' }),
  };
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return { scroller, leaf, globals, restore() { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } } };
}

test('the page scroller is found from an element inside it', () => {
  const dom = fakeDom({ scrollTop: 1200 });
  try {
    assert.equal(pageScroller(dom.leaf), dom.scroller);
    assert.equal(pageScrollTop(dom.leaf), 1200, 'reads the container, not window.scrollY');
  } finally { dom.restore(); }
});

test('a detached element still finds the page scroller', () => {
  const dom = fakeDom({ scrollTop: 640 });
  try {
    assert.equal(pageScrollTop(null), 640);
  } finally { dom.restore(); }
});

test('with no page scroller at all, it falls back to the window', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null, documentElement: { scrollTop: 0 } }, configurable: true, writable: true });
  const savedWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { scrollY: 310 }, configurable: true, writable: true });
  try {
    assert.equal(pageScrollTop(null), 310);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document;
    if (savedWin) Object.defineProperty(globalThis, 'window', savedWin); else delete globalThis.window;
  }
});

test('scrolling back to a saved offset moves the container', () => {
  const dom = fakeDom({ scrollTop: 0 });
  try {
    pageScrollTo(dom.leaf, 900);
    assert.equal(dom.scroller.scrollTop, 900);
  } finally { dom.restore(); }
});

test('restoring keeps trying while the list is still rendering', () => {
  // The rows come back over a few frames; the browser clamps a scroll past
  // what has rendered, so one attempt lands short.
  const dom = fakeDom({ scrollTop: 0 });
  let rendered = 200;                       // scrollable height so far
  Object.defineProperty(dom.scroller, 'scrollTop', {
    get: () => dom.scroller._top ?? 0,
    set: (v) => { dom.scroller._top = Math.min(v, rendered); },
    configurable: true,
  });
  const frames = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (fn) => frames.push(fn), configurable: true, writable: true });
  try {
    restorePageScroll(dom.leaf, 900);
    assert.equal(dom.scroller.scrollTop, 200, 'first attempt is clamped');
    rendered = 900;                          // the rest of the list arrives
    frames.shift()();
    assert.equal(dom.scroller.scrollTop, 900, 'the retry lands on the saved offset');
    const pending = frames.length;
    frames.forEach((f) => f());
    assert.equal(pending <= 1, true, 'it stops once the offset sticks');
  } finally { delete globalThis.requestAnimationFrame; dom.restore(); }
});

test('restoring does nothing when the saved offset is the top', () => {
  const dom = fakeDom({ scrollTop: 0 });
  try {
    restorePageScroll(dom.leaf, 0);
    assert.equal(dom.scroller.scrollTop, 0);
  } finally { dom.restore(); }
});

test('a fixed panel keeps its place while the page scrolls', () => {
  // What the measuring code computes: the element's top as if the page were
  // at rest. It has to come out the same at any scroll offset, or the panel
  // jumps to the top of the screen on the next re-measure (#217).
  const anchorInDocument = 177;
  const measure = (scrollTop) => {
    const dom = fakeDom({ scrollTop });
    try {
      const rectTop = anchorInDocument - scrollTop;   // what the browser reports while scrolled
      return rectTop + pageScrollTop(dom.leaf);
    } finally { dom.restore(); }
  };
  assert.equal(measure(0), anchorInDocument);
  assert.equal(measure(1200), anchorInDocument);
  assert.equal(measure(8051), anchorInDocument);
});

test('Foods and Diary measure and restore against the page scroller, not the window', () => {
  for (const f of ['../src/routes/Foods.svelte', '../src/routes/Diary.svelte']) {
    const src = read(f);
    assert.doesNotMatch(src, /window\.scrollY/, `${f} must not read window.scrollY`);
    assert.match(src, /from '\.\.\/lib\/scroll-anchor\.js'/, `${f} imports the helper`);
  }
  const foods = read('../src/routes/Foods.svelte');
  assert.match(foods, /const scrollY = pageScrollTop\(_foodsBodyEl\);/, 'rail + pane anchor');
  assert.match(foods, /editorState\.foodsScrollY\s*=\s*pageScrollTop\(_foodsBodyEl\);/, 'saved scroll position');
  assert.match(foods, /restorePageScroll\(_foodsBodyEl, sy\);/, 'restored scroll position');
  assert.match(read('../src/routes/Diary.svelte'), /const scrollY = pageScrollTop\(_diaryContentEl\);/);
});
