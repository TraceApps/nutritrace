/**
 * Units nobody chose stay unchosen, and every screen agrees on the default.
 *
 * Settings > Regional & Units kept its own copy of the five units, with
 * distance defaulting to km where the store says mi, and saved all five the
 * moment it opened. Opening the page once set an account's units for it, and
 * until then Trace described distances in km while the Diary showed mi.
 * The page now reads and sets the shared stores, which skip unchanged values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const UNITS = ['weightUnit', 'heightUnit', 'lengthUnit', 'distUnit', 'tempUnit'];

const settings = read('src/stores/settings.js');
const storeDefault = (key) => {
  const m = settings.match(new RegExp(`createSettingStore\\('${key}',\\s*'([^']+)'\\)`));
  assert.ok(m, `${key} store not found`);
  return m[1];
};

test('every fallback for a unit matches its store default', () => {
  const files = readdirSync(new URL('src', root), { recursive: true })
    .filter((f) => /\.(js|svelte)$/.test(f)).map((f) => `src/${f}`);
  for (const key of UNITS) {
    const want = storeDefault(key);
    for (const f of files) {
      for (const m of read(f).matchAll(new RegExp(`getSetting\\('${key}',\\s*'([^']+)'\\)`, 'g'))) {
        assert.equal(m[1], want, `${f}: ${key} falls back to ${m[1]}, the store says ${want}`);
      }
    }
  }
});

test('Regional & Units sets a unit only when it is changed', () => {
  const page = read('src/routes/settings/Regional.svelte');
  for (const key of UNITS) {
    assert.match(page, new RegExp(`value=\\{\\$${key}\\} on:change=\\{e => ${key}\\.set\\(e\\.target\\.value\\)\\}`), `${key} picker`);
    assert.doesNotMatch(page, new RegExp(`getSetting\\('${key}'`), `${key} read from the store, not a copy`);
  }
  assert.doesNotMatch(page, /\$:\s*set\(/, 'nothing is saved on open');
});
