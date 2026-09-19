/**
 * Viewport probe. Layout snapshots written to the in-app diagnostic log so
 * display bugs on devices nobody here owns (iPhone reports #208 and #212)
 * can be diagnosed from a copied log instead of a guess.
 *
 * Covers: the line format, the focused-field description (font size is what
 * decides iOS focus zoom), silence while verbose logging is off, and that
 * continuous events like scrolling do not repeat an unchanged layout.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setVerboseLogging } from '../src/lib/log-capture.js';
import { describeRect, describeFocus, formatSnapshot, layoutKey, startViewportProbe } from '../src/lib/viewport-probe.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('describeRect gives whole-pixel top-bottom, or says why not', () => {
  const el = { getBoundingClientRect: () => ({ top: 700.4, bottom: 780.6 }) };
  assert.equal(describeRect(el, { display: 'flex' }), '700-781');
  assert.equal(describeRect(el, { display: 'none' }), 'hidden');
  assert.equal(describeRect(null, null), 'none');
});

test('describeFocus names the field and its font size, and ignores non-fields', () => {
  assert.equal(describeFocus({ tagName: 'INPUT', type: 'number', className: 'goal-input  wide' }, { fontSize: '15px' }), 'input[number].goal-input 15px');
  assert.equal(describeFocus({ tagName: 'TEXTAREA', className: '' }, { fontSize: '16px' }), 'textarea 16px');
  assert.equal(describeFocus({ tagName: 'BUTTON', type: 'button', className: 'btn' }, {}), 'none');
  assert.equal(describeFocus(null, null), 'none');
});

const sample = {
  mode: 'home-screen', iosFix: 'on', screen: '390x844', vh: '844', doc: '844', win: '390x844', visible: '390x508', zoom: '1', offset: '0,0',
  safe: '47,0,34,0', safeVar: '34', dock: '731-844', nav: '766-844', bar: '731-766',
  dockToBottom: '0', focus: 'input[text].search 15px', scroll: '120', route: '#/diary',
};

test('formatSnapshot writes every field on one line in a fixed order', () => {
  const line = formatSnapshot('focus', sample);
  assert.equal(line.split('\n').length, 1);
  assert.equal(line,
    '[viewport] focus mode=home-screen iosFix=on screen=390x844 vh=844 doc=844 win=390x844 visible=390x508 zoom=1 offset=0,0 safe=47,0,34,0 ' +
    'safeVar=34 dock=731-844 nav=766-844 bar=731-766 dockToBottom=0 focus=input[text].search 15px scroll=120 route=#/diary');
});

test('layoutKey ignores the route but notices any measured change', () => {
  assert.equal(layoutKey(sample), layoutKey({ ...sample, route: '#/goals' }));
  assert.notEqual(layoutKey(sample), layoutKey({ ...sample, dockToBottom: '34' }));
  assert.notEqual(layoutKey(sample), layoutKey({ ...sample, zoom: '1.07' }));
  assert.notEqual(layoutKey(sample), layoutKey({ ...sample, win: '390x785' }));
  assert.notEqual(layoutKey(sample), layoutKey({ ...sample, doc: '785' }));
});

test('main.js starts the probe right after the log capture is installed', () => {
  const main = read('../src/main.js');
  const capture = main.indexOf("from './lib/log-capture.js'");
  const start = main.indexOf('startViewportProbe();');
  assert.ok(capture >= 0 && start > capture);
  assert.ok(start < main.indexOf("import App from './App.svelte'"));
});

test('the probe never reads field contents', () => {
  const src = read('../src/lib/viewport-probe.js');
  assert.doesNotMatch(src, /\.value\b|innerText|textContent|innerHTML/);
});

function fakeBrowser() {
  const handlers = {};
  const on = (scope) => (type, fn) => { (handlers[`${scope}:${type}`] ||= []).push(fn); };
  const fire = (key, e = {}) => (handlers[key] || []).forEach((fn) => fn(e));
  const box = (top, bottom) => ({ getBoundingClientRect: () => ({ top, bottom }) });
  const els = { '.bottom-dock': box(731, 844), '.bottom-nav': box(766, 844), '.diary-bottom-bar': box(731, 766), '.page-transition': { ...box(0, 844), scrollTop: 0 } };
  const vv = { width: 390, height: 844, scale: 1, offsetLeft: 0, offsetTop: 0, addEventListener: on('vv') };
  const root = { scrollHeight: 844, classList: { contains: (c) => c === 'ios-home-screen' } };
  const doc = {
    documentElement: root,
    body: { appendChild() {} },
    activeElement: null,
    visibilityState: 'visible',
    createElement: () => ({ style: {}, setAttribute() {}, getBoundingClientRect: () => ({ height: 844 }) }),
    querySelector: (sel) => els[sel] || null,
    addEventListener: on('doc'),
  };
  const globals = {
    window: { innerWidth: 390, innerHeight: 844, visualViewport: vv, addEventListener: on('win'), matchMedia: () => ({ matches: true }) },
    document: doc,
    location: { hash: '#/diary' },
    navigator: {},
    screen: { width: 390, height: 844 },
    getComputedStyle: () => ({ display: 'block', fontSize: '15px', paddingTop: '47px', paddingRight: '0px', paddingBottom: '34px', paddingLeft: '0px' }),
  };
  const saved = {};
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  };
  return { fire, els, vv, doc, restore };
}

test('silent while verbose logging is off, one line per real change once on', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const b = fakeBrowser();
  const lines = [];
  const info = mock.method(console, 'info', (msg) => { if (String(msg).startsWith('[viewport]')) lines.push(msg); });
  try {
    setVerboseLogging(false);
    startViewportProbe();
    mock.timers.tick(5000);
    b.fire('doc:focusin', { target: { tagName: 'INPUT' } });
    b.fire('vv:resize');
    mock.timers.tick(5000);
    assert.equal(lines.length, 0, 'nothing is logged or measured with verbose logging off');

    setVerboseLogging(true);
    b.fire('vv:resize');
    mock.timers.tick(300);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[viewport\] visible-area mode=home-screen iosFix=on screen=390x844 vh=844 doc=844 win=390x844 visible=390x844 zoom=1 /);
    assert.match(lines[0], /safe=47,0,34,0 safeVar=34 dock=731-844 nav=766-844 bar=731-766 dockToBottom=0 /);

    // A burst of scroll events with nothing moved: collapsed and then skipped.
    for (let i = 0; i < 20; i++) b.fire('doc:scroll');
    mock.timers.tick(800);
    assert.equal(lines.length, 1, 'an unchanged layout is not repeated for scrolling');

    // The keyboard opens: the visible area shrinks and iOS zooms in.
    const field = { tagName: 'INPUT', type: 'text', className: 'search' };
    b.doc.activeElement = field;
    b.fire('doc:focusin', { target: field });
    Object.assign(b.vv, { height: 508, scale: 1.07 });
    b.fire('vv:resize');
    b.fire('vv:scroll');
    mock.timers.tick(300);
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^\[viewport\] focus .* focus=input\[text\]\.search 15px /);
    assert.match(lines[2], /^\[viewport\] visible-area .* visible=390x508 zoom=1\.07 /);

    // The bug from #208: the dock drifts off the bottom edge.
    b.els['.bottom-dock'] = { getBoundingClientRect: () => ({ top: 697, bottom: 810 }) };
    b.fire('doc:scroll');
    mock.timers.tick(800);
    assert.equal(lines.length, 4);
    assert.match(lines[3], /^\[viewport\] scroll-stop .* dock=697-810 .* dockToBottom=34 /);

    // Page changes always log, even when the layout is the same.
    b.fire('win:hashchange');
    mock.timers.tick(600);
    assert.equal(lines.length, 5);
    assert.match(lines[4], /^\[viewport\] page /);
  } finally {
    setVerboseLogging(false);
    info.mock.restore();
    mock.timers.reset();
    b.restore();
  }
});
