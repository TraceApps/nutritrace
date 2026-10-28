/**
 * The system's light or dark is followed only when the choice saved for the
 * account is System. A Light or Dark choice stays when the system switches,
 * and the browser bar keeps the accent's color. The listener in main.js is
 * run as it is, with a stand-in page around it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

function listener(saved, metaColor) {
  const fn = main.match(/function followSystemTheme\(e\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, 'main.js names its system-theme listener');
  const attrs = { 'data-theme': saved === 'dark' ? 'dark' : 'light' };
  const meta = { content: metaColor };
  const settings = { appearance: saved };
  const context = {
    DB: { getSetting: (key, def) => (settings[key] !== undefined ? settings[key] : def) },
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } }, getElementById: (id) => (id === 'theme-color-meta' ? meta : null) },
    applyBannerText: () => {},
  };
  const follow = vm.runInNewContext(`(${fn[0]})`, context);
  return { follow, attrs, meta };
}

test('the old Waistline key is not what decides', () => {
  assert.doesNotMatch(main, /wl_appearance/);
  assert.match(main, /addEventListener\('change', followSystemTheme\)/);
});

test('a Light or Dark choice stays when the system switches', () => {
  for (const [saved, systemDark] of [['dark', false], ['light', true]]) {
    const { follow, attrs, meta } = listener(saved, '#B69CFF');
    follow({ matches: systemDark });
    assert.equal(attrs['data-theme'], saved, `${saved} kept`);
    assert.equal(meta.content, '#B69CFF');
  }
});

test('System follows the system, and the browser bar keeps the accent', () => {
  for (const systemDark of [true, false]) {
    const { follow, attrs, meta } = listener('system', '#B69CFF');
    follow({ matches: systemDark });
    assert.equal(attrs['data-theme'], systemDark ? 'dark' : 'light');
    assert.equal(meta.content, '#B69CFF', 'the accent color stays');
  }
});

test('before an accent is set, the browser bar takes the theme color', () => {
  const { follow, meta } = listener('system', '#F5F7FA');
  follow({ matches: true });
  assert.equal(meta.content, '#0A0B0F');
  // Nothing saved yet counts as System.
  const fresh = listener(undefined, '#0A0B0F');
  fresh.follow({ matches: false });
  assert.equal(fresh.attrs['data-theme'], 'light');
  assert.equal(fresh.meta.content, '#F5F7FA');
});
