/**
 * Names, titles and links are escaped in every email's HTML.
 *
 * A user's name went into the greeting and the invite as-is, and in the
 * sharing emails a food, meal or recipe name (another user's) did too, so
 * "<img src=x onerror=...>" or a link in a name became real markup in
 * someone's inbox. The helpers that take plain text now escape it
 * themselves. Verified by sending every email through a real SMTP catcher
 * before and after; ordinary names render byte for byte as before.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../server/email.js', import.meta.url), 'utf8');
const H = 'Eve & <img src=x onerror=alert(1)><a href="https://evil.test">click</a>';

// The helpers are private to the module (which opens the database when
// imported), so they are read out of the source and run on their own.
const fnSrc = (name) => {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return '';
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end + 2);
};
const helpers = ['_escapeHtml', 'greeting', 'ctaButton', 'fallbackUrl', '_sectionHeader']
  .map(fnSrc).filter(Boolean).join('\n');
const FONT = (src.match(/const _FONT = `[^`]*`;/) || [''])[0];
const h = new Function(`${FONT}\n${helpers}\nreturn { greeting, ctaButton, fallbackUrl, _escapeHtml };`)();

const noMarkup = (html) => {
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<a href="https:\/\/evil\.test"/);
};

test('a name in the greeting reads as typed, not as markup', () => {
  const html = h.greeting(H);
  noMarkup(html);
  assert.match(html, /Eve &amp; &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(h.greeting('Tom & Jerry'), /&amp;amp;/, 'escaped once, not twice');
});

test('links and button labels are escaped too', () => {
  const href = 'http://host.test/#/x?a=1&b="2"';
  const btn = h.ctaButton(href, H);
  noMarkup(btn);
  assert.match(btn, /href="http:\/\/host\.test\/#\/x\?a=1&amp;b=&quot;2&quot;"/);
  noMarkup(h.fallbackUrl('http://host.test/"><img src=x>'));
});

test('the inviter name is escaped wherever it appears in the HTML', () => {
  const invite = fnSrc('sendInvite');
  assert.match(invite, /_escapeHtml\(inviterName\)/);
  assert.doesNotMatch(invite.replace(/text: [^\n]*/, ''), /\$\{inviterName\}/, 'no raw ${inviterName} outside the plain-text part');
});

test('the old raw spots are gone', () => {
  assert.doesNotMatch(src, /' \+ name \+ '/, 'greeting');
  assert.doesNotMatch(src, /<a href="\$\{href\}"/, 'button link');
  assert.doesNotMatch(src, /href="\$\{url\}"/, 'fallback link');
});

test('a shared food or meal: names escaped in the HTML, as typed in the text', () => {
  for (const fn of ['sendFoodShared', 'sendMealShared']) {
    const body = fnSrc(fn);
    assert.match(body, /const safeSharer = _escapeHtml\(sharerText\);/, fn);
    assert.match(body, /text: `\$\{sharerText\} shared "\$\{(food|meal)Text\}"/, fn);
  }
});

test('weekly summary rows escape what they show', () => {
  assert.match(fnSrc('_statRow'), /\$\{_escapeHtml\(value\)\}/);
  assert.match(fnSrc('_statRow'), /_escapeHtml\(unit\)/);
});
