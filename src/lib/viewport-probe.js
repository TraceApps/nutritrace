/**
 * viewport-probe.js: layout snapshots for diagnosing display bugs on devices
 * nobody on the team owns (iPhone reports like #208, the summary bar coming
 * loose from the tab bar, and #212, zoom when a field gets focus).
 *
 * While diagnostic (verbose) logging is on, writes one compact line to the
 * in-app log whenever something that moves the layout happens: startup, a
 * page change, a field gaining or losing focus, the keyboard or browser
 * toolbar resizing the visible area, zooming, rotating, coming back to the
 * app, and scrolling coming to a stop. A tester reproduces the problem, then
 * copies the log from Settings, Help Improve, and sends it.
 *
 * Records layout numbers only, never what is typed or any diary data. With
 * verbose logging off every listener returns before measuring anything.
 */
import { isVerboseLogging } from './log-capture.js';

const TRACKED = {
  dock: '.bottom-dock',
  nav:  '.bottom-nav',
  bar:  '.diary-bottom-bar',
  page: '.page-transition',
};
// Reasons fired by continuous activity. Skipped when nothing measurable
// changed, so a long scroll or keyboard animation cannot flood the log.
const NOISY = new Set(['visible-area', 'resize', 'scroll-stop']);

let _started = false;
let _lastLayout = '';
const _timers = {};

/** "top-bottom" in whole pixels, or why there is nothing to measure. */
export function describeRect(el, style) {
  if (!el) return 'none';
  if (style && style.display === 'none') return 'hidden';
  const r = el.getBoundingClientRect();
  return `${Math.round(r.top)}-${Math.round(r.bottom)}`;
}

/** The focused field, if any: tag, type, first class, and font size (iOS zooms below 16px). */
export function describeFocus(el, style) {
  if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '')) return 'none';
  const type = el.type ? `[${el.type}]` : '';
  const cls = (el.className && typeof el.className === 'string') ? `.${el.className.trim().split(/\s+/)[0]}` : '';
  const size = style ? style.fontSize : '?';
  return `${el.tagName.toLowerCase()}${type}${cls} ${size}`;
}

/** One log line. Field order is fixed so lines line up when read in sequence. */
export function formatSnapshot(reason, s) {
  return `[viewport] ${reason} mode=${s.mode} iosFix=${s.iosFix} screen=${s.screen} vh=${s.vh} doc=${s.doc} win=${s.win} visible=${s.visible} zoom=${s.zoom} ` +
    `offset=${s.offset} safe=${s.safe} safeVar=${s.safeVar} dock=${s.dock} nav=${s.nav} bar=${s.bar} ` +
    `dockToBottom=${s.dockToBottom} focus=${s.focus} scroll=${s.scroll} route=${s.route}`;
}

/** Every measured field except the route, joined: equal strings mean nothing moved. */
export function layoutKey(s) {
  return [s.mode, s.iosFix, s.screen, s.vh, s.doc, s.win, s.visible, s.zoom, s.offset, s.safe, s.safeVar, s.dock, s.nav, s.bar, s.dockToBottom, s.focus, s.scroll].join('|');
}

function _safeAreaProbes() {
  const make = (css) => {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' + css;
    document.body.appendChild(el);
    return el;
  };
  // What iOS reports, and what the app's --safe-bottom token resolves to.
  // If these two ever disagree, bars sized from each will not line up.
  const env = make('padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);');
  const token = make('padding-bottom:var(--safe-bottom,0px);');
  // iOS home-screen apps can open with the window shorter than the screen,
  // leaving a black strip at the bottom until something scrolls. 100vh is
  // measured alongside because it is reported to keep the full height then.
  const vh = make('height:100vh;');
  return { env, token, vh };
}

function _collect() {
  const px = (v) => Math.round(parseFloat(v) || 0);
  const vv = window.visualViewport;
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const probes = _collect.probes || (_collect.probes = _safeAreaProbes());
  const env = getComputedStyle(probes.env);
  const els = Object.fromEntries(Object.entries(TRACKED).map(([k, sel]) => [k, document.querySelector(sel)]));
  const rect = (k) => describeRect(els[k], els[k] ? getComputedStyle(els[k]) : null);
  const dockBox = els.dock ? els.dock.getBoundingClientRect() : null;
  const active = document.activeElement;

  return {
    mode: standalone ? 'home-screen' : 'browser',
    // Whether the iPhone home-screen height workaround in base.css is active.
    iosFix: document.documentElement.classList.contains('ios-home-screen') ? 'on' : 'off',
    screen: `${screen.width}x${screen.height}`,
    vh: String(Math.round(probes.vh.getBoundingClientRect().height)),
    // Page height. Taller than the window means iOS has something to scroll.
    doc: String(document.documentElement.scrollHeight),
    win: `${window.innerWidth}x${window.innerHeight}`,
    visible: vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}` : 'n/a',
    zoom: vv ? (Math.round(vv.scale * 100) / 100).toString() : 'n/a',
    offset: vv ? `${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)}` : 'n/a',
    safe: `${px(env.paddingTop)},${px(env.paddingRight)},${px(env.paddingBottom)},${px(env.paddingLeft)}`,
    safeVar: String(px(getComputedStyle(probes.token).paddingBottom)),
    dock: rect('dock'),
    nav: rect('nav'),
    bar: rect('bar'),
    dockToBottom: dockBox ? String(Math.round(window.innerHeight - dockBox.bottom)) : 'n/a',
    focus: describeFocus(active, active && active !== document.body ? getComputedStyle(active) : null),
    scroll: els.page ? String(Math.round(els.page.scrollTop)) : 'n/a',
    route: (location.hash || '#/').split('?')[0],
  };
}

function _log(reason) {
  if (!isVerboseLogging()) return;
  try {
    const snap = _collect();
    const key = layoutKey(snap);
    if (NOISY.has(reason) && key === _lastLayout) return;
    _lastLayout = key;
    console.info(formatSnapshot(reason, snap));
  } catch (e) {
    console.warn('[viewport] snapshot failed:', e && e.message);
  }
}

// Wait for the burst of events to settle, then take one snapshot.
function _later(reason, ms) {
  if (!isVerboseLogging()) return;
  clearTimeout(_timers[reason]);
  _timers[reason] = setTimeout(() => _log(reason), ms);
}

/** Install the listeners once, at boot. Cheap when verbose logging is off. */
export function startViewportProbe() {
  if (_started || typeof window === 'undefined') return;
  _started = true;

  const isField = (t) => t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '');
  const vv = window.visualViewport;
  if (vv) {
    // The keyboard, the browser toolbar and pinch or focus zoom all show up here.
    vv.addEventListener('resize', () => _later('visible-area', 250));
    vv.addEventListener('scroll', () => _later('visible-area', 250));
  }
  window.addEventListener('resize', () => _later('resize', 250));
  window.addEventListener('orientationchange', () => _later('rotate', 600));
  window.addEventListener('hashchange', () => _later('page', 500));
  document.addEventListener('focusin', (e) => { if (isField(e.target)) _log('focus'); });
  document.addEventListener('focusout', (e) => { if (isField(e.target)) _later('blur', 400); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') _later('return', 400); });
  // Scroll events do not bubble, so listen in the capture phase to catch the page's own scroller.
  document.addEventListener('scroll', () => _later('scroll-stop', 700), { capture: true, passive: true });
  // One line straight away, before anything has had a chance to scroll or
  // re-measure, and another once the first page has rendered.
  _log('boot');
  _later('start', 1500);
}
