/**
 * #212: iPhone and iPad zoom into any text field under 16px on focus. Fields
 * get 16px on those devices only, and Copy buttons work on plain-http
 * installs (where navigator.clipboard does not exist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { copyText, copyWithSelection } from '../src/lib/clipboard.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../index.html');
const css = read('../src/styles/base.css');

// Runs index.html's own detection line against a given browser.
function detectsIos(userAgent, maxTouchPoints = 0) {
  const line = html.split(/\r?\n/).find((l) => l.includes("classList.add('ios')"));
  assert.ok(line, 'detection line present');
  const classes = new Set();
  const navigator = { userAgent, maxTouchPoints };
  const document = { documentElement: { classList: { add: (c) => classes.add(c) } } };
  new Function('navigator', 'document', line)(navigator, document);
  return classes.has('ios');
}

test('iPhone and iPad are detected, everything else is not', () => {
  const ua = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0 Mobile/15E148 Safari/604.1',
    ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Mobile Safari/537.36',
    androidWebView: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/139.0 Mobile Safari/537.36',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36',
    linuxTouch: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36',
  };
  assert.equal(detectsIos(ua.iphone), true);
  assert.equal(detectsIos(ua.iphoneChrome), true);
  assert.equal(detectsIos(ua.ipadDesktopMode, 5), true, 'iPadOS Safari reports a Mac UA but has touch');
  assert.equal(detectsIos(ua.macSafari, 0), false);
  assert.equal(detectsIos(ua.android, 5), false);
  assert.equal(detectsIos(ua.androidWebView, 5), false);
  assert.equal(detectsIos(ua.windows, 10), false);
  assert.equal(detectsIos(ua.linuxTouch, 10), false);
});

test('the class is set in <head>, before the page renders', () => {
  assert.ok(html.indexOf("classList.add('ios')") < html.indexOf('<body'));
});

test('on iOS, text fields, text areas and selects get 16px; toggles and buttons do not', () => {
  const rule = css.slice(css.indexOf('html.ios input:not('), css.indexOf('{ font-size: 16px !important; }'));
  for (const t of ['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image', 'hidden']) {
    assert.match(rule, new RegExp(`\\[type="${t}"\\]`), `${t} inputs are excluded`);
  }
  // The exclusions must add no specificity: both rules are !important, so a
  // plain :not([type]) chain would outrank html.ios .qc-kcal-input and shrink
  // the large fields to 16px (caught in a browser check).
  assert.match(rule, /^html\.ios input:not\(:where\(\[type="checkbox"\]/);
  assert.doesNotMatch(rule, /\):not\(/);
  assert.match(rule, /html\.ios textarea,/);
  assert.match(rule, /html\.ios select\s*$/);
  // Nothing outside html.ios changes.
  assert.doesNotMatch(css.replace(/html\.ios[^{]*\{[^}]*\}/g, ''), /font-size:\s*16px !important/);
});

// Every CSS rule that sizes a real form field above 16px needs an html.ios
// exception at the same size, or the 16px rule would shrink it on iOS.
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('fields that are larger than 16px on purpose keep their size on iOS', () => {
  const srcDir = new URL('../src/', import.meta.url).pathname;
  const files = walk(srcDir).filter((f) => /\.(svelte|css)$/.test(f));
  const fieldClasses = new Set();
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/<(?:input|textarea|select)\b[^>]*\bclass="([^"]+)"/g)) {
      for (const c of m[1].split(/\s+/)) if (/^[\w-]+$/.test(c)) fieldClasses.add(c);
    }
  }
  const large = [];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const last = m[1].trim().split(',').map((x) => x.trim());
      const size = m[2].match(/font-size:\s*(\d+(?:\.\d+)?)px/);
      if (!size || Number(size[1]) <= 16) continue;
      for (const sel of last) {
        const cls = sel.match(/\.([\w-]+)$/);
        if (cls && fieldClasses.has(cls[1]) && !sel.startsWith('html.ios')) large.push([cls[1], size[1]]);
      }
    }
  }
  assert.ok(large.length >= 4, 'finds the known large fields');
  for (const [cls, px] of large) {
    const exception = new RegExp(`html\\.ios \\.${cls}[^{]*\\{ font-size: ${px}px !important; \\}`);
    assert.match(css, exception, `.${cls} is ${px}px and needs an html.ios exception at ${px}px`);
  }
});

test('every Copy button goes through copyText', () => {
  const srcDir = new URL('../src/', import.meta.url).pathname;
  const offenders = walk(srcDir)
    .filter((f) => /\.(svelte|js)$/.test(f) && !f.endsWith('clipboard.js'))
    .filter((f) => /navigator\.clipboard\.writeText/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

function fakePage({ secure, clipboard, execResult = true }) {
  const calls = [];
  const body = { children: [], appendChild(c) { this.children.push(c); c.remove = () => { this.children = this.children.filter((x) => x !== c); }; } };
  const ranges = [];
  const selection = {
    get rangeCount() { return ranges.length; },
    getRangeAt: (i) => ranges[i],
    removeAllRanges: () => { ranges.length = 0; },
    addRange: (r) => ranges.push(r),
  };
  const document = {
    body,
    createElement: () => ({ style: {}, setAttribute() {}, textContent: '' }),
    createRange: () => ({ selectNodeContents(n) { this.node = n; } }),
    getSelection: () => selection,
    execCommand: (cmd) => { calls.push(['exec', cmd, ranges[0] && ranges[0].node.textContent]); return execResult; },
  };
  const g = { window: { isSecureContext: secure }, document, navigator: clipboard ? { clipboard } : {} };
  const saved = {};
  for (const [k, v] of Object.entries(g)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return {
    calls, body, ranges,
    restore() { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } },
  };
}

test('secure page: uses the clipboard API', async () => {
  const written = [];
  const page = fakePage({ secure: true, clipboard: { writeText: async (t) => { written.push(t); } } });
  try {
    await copyText('log line');
    assert.deepEqual(written, ['log line']);
    assert.equal(page.calls.length, 0);
  } finally { page.restore(); }
});

test('plain http: no clipboard API, copies through a selection instead', async () => {
  const page = fakePage({ secure: false, clipboard: null });
  try {
    await copyText('[viewport] boot mode=home-screen');
    assert.deepEqual(page.calls, [['exec', 'copy', '[viewport] boot mode=home-screen']]);
    assert.equal(page.body.children.length, 0, 'the temporary element is removed');
  } finally { page.restore(); }
});

test('clipboard API present but refused: falls back to the selection copy', async () => {
  const page = fakePage({ secure: true, clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
  try {
    await copyText('abc');
    assert.equal(page.calls[0][1], 'copy');
  } finally { page.restore(); }
});

test('nothing works: rejects so the button can show its error', async () => {
  const page = fakePage({ secure: false, clipboard: null, execResult: false });
  try {
    await assert.rejects(copyText('abc'));
    assert.equal(copyWithSelection('abc'), false);
  } finally { page.restore(); }
});

test('copyText starts the fallback without waiting, so it still counts as part of the tap', () => {
  const page = fakePage({ secure: false, clipboard: null });
  try {
    copyText('now');
    // Synchronous: the copy command already ran before any await resolved.
    assert.equal(page.calls.length, 1);
  } finally { page.restore(); }
});
