/**
 * #323: the browser's language was ignored until one was picked in Settings.
 * App.svelte sets the app's locale from the `language` setting, which
 * defaulted to 'en', so a Spanish browser was switched back to English as
 * soon as the app mounted. The setting now defaults to the same pick as the
 * first paint (the browser's language if the app has it), as in LiftTrace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the language setting defaults to the browser pick, not English', () => {
  const s = read('../src/stores/settings.js');
  assert.match(s, /import \{ pickInitialLocale \} from '\.\.\/i18n\/index\.js';/);
  assert.match(s, /createSettingStore\('language',\s+pickInitialLocale\(\)\)/);
  assert.doesNotMatch(s, /createSettingStore\('language',\s+'en'\)/);
});

test('first paint and the setting use the same pick', () => {
  const i = read('../src/i18n/index.js');
  assert.match(i, /export function pickInitialLocale\(\)/);
  assert.match(i, /initialLocale: initialLocale \|\| pickInitialLocale\(\)/);
});
