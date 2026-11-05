/**
 * The connection banner in Settings (ConnectionStatus.svelte) has no English
 * of its own: its default labels come from en.json (connection_status), so
 * they follow the app's language.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = read('../src/components/settings/ConnectionStatus.svelte');
const en = JSON.parse(read('../src/i18n/en.json'));

test('the connection banner has no hardcoded English', () => {
  const code = src.replace(/<style[\s\S]*?<\/style>/, '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  for (const s of ['Connected', 'Not connected', 'Testing', 'Test']) {
    assert.doesNotMatch(code, new RegExp(`['">]${s}`), s);
  }
});

test('every label it reads is in en.json', () => {
  const keys = [...src.matchAll(/\$_\('(connection_status\.[a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, 'reads its labels from en.json');
  for (const k of keys) assert.equal(typeof k.split('.').reduce((o, p) => o?.[p], en), 'string', k);
  assert.equal(en.connection_status.not_connected_error, 'Not connected: {error}');
});
