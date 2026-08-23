import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import i18nCheck from '../scripts/i18n-check.cjs';

const { findDuplicateKeys, collectKeyRefs, IGNORED_INDIRECT } = i18nCheck;

test('findDuplicateKeys: sibling repeated blocks (the PR #33 bug)', () => {
  assert.deepEqual(
    findDuplicateKeys('{"login":{"a":1},"other":2,"login":{"b":3}}'),
    ['login'],
  );
});

test('findDuplicateKeys: nested duplicate reports a dotted path', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{"x":1,"x":2}}'), ['a.x']);
});

test('findDuplicateKeys: same name at different depths is not a duplicate', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{"t":1},"b":{"t":2}}'), []);
});

test('findDuplicateKeys: braces and colons inside values do not confuse it', () => {
  assert.deepEqual(findDuplicateKeys('{"a":"use {count}: now","b":2}'), []);
});

test('findDuplicateKeys: escaped quotes in a value', () => {
  assert.deepEqual(findDuplicateKeys('{"a":"said \\"hi\\"","a":2}'), ['a']);
});

test('findDuplicateKeys: escaped quotes in a key', () => {
  assert.deepEqual(findDuplicateKeys('{"a\\"b":1,"a\\"b":2}'), ['a"b']);
});

test('findDuplicateKeys: arrays of objects', () => {
  assert.deepEqual(findDuplicateKeys('{"a":[{"x":1},{"x":2}],"b":[1,2]}'), []);
});

test('findDuplicateKeys: duplicate inside an array element', () => {
  assert.deepEqual(findDuplicateKeys('{"a":[{"x":1,"x":2}]}'), ['a[0].x']);
});

test('findDuplicateKeys: depth three', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{"b":{"c":1,"c":2}}}'), ['a.b.c']);
});

test('findDuplicateKeys: escaped unicode in a value', () => {
  assert.deepEqual(findDuplicateKeys('{"a":"\\u00e1rbol","b":1}'), []);
});

test('findDuplicateKeys: empty object and empty array', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{},"b":[],"c":1}'), []);
});

test('findDuplicateKeys: a triple duplicate reports twice', () => {
  assert.deepEqual(findDuplicateKeys('{"k":1,"k":2,"k":3}'), ['k', 'k']);
});

function fixture(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-check-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

test('collectKeyRefs: finds literal keys in $_() calls', () => {
  const f = fixture('A.svelte', `<h1>{$_('login.title')}</h1>\n<p>{$_("common.back")}</p>`);
  const { direct } = collectKeyRefs(new Set(['login', 'common']), [f]);
  assert.deepEqual([...direct.keys()].sort(), ['common.back', 'login.title']);
});

test('collectKeyRefs: reports the line of each reference', () => {
  const f = fixture('B.svelte', `line one\n{$_('login.title')}\n`);
  const { direct } = collectKeyRefs(new Set(['login']), [f]);
  assert.equal(direct.get('login.title').line, 2);
});

test('collectKeyRefs: finds key-shaped literals held in constants', () => {
  const f = fixture('C.svelte', `const META = { workout: { titleKey: 'settings_workout.title' } };`);
  const { direct, indirect } = collectKeyRefs(new Set(['settings_workout']), [f]);
  assert.equal(direct.size, 0);
  assert.deepEqual([...indirect.keys()], ['settings_workout.title']);
});

test('collectKeyRefs: ignores dotted strings whose root is not a top-level key', () => {
  const f = fixture('D.svelte', `const cls = 'material.symbols.rounded';\nconst v = 'foo.bar';`);
  const { indirect } = collectKeyRefs(new Set(['login']), [f]);
  assert.equal(indirect.size, 0);
});

test('collectKeyRefs: honours the ignore list for indirect literals', () => {
  assert.ok(IGNORED_INDIRECT.has('programs.id'));
  const f = fixture('E.js', `const schema = { properties: { 'programs.id': {} } };`);
  const { indirect } = collectKeyRefs(new Set(['programs']), [f]);
  assert.equal(indirect.size, 0);
});

test('collectKeyRefs: the ignore list does not silence a real $_() call', () => {
  const f = fixture('F.svelte', `{$_('programs.id')}`);
  const { direct } = collectKeyRefs(new Set(['programs']), [f]);
  assert.deepEqual([...direct.keys()], ['programs.id']);
});

test('collectKeyRefs: a key seen in $_() is not also reported as indirect', () => {
  const f = fixture('G.svelte', `{$_('login.title')}\nconst k = 'login.title';`);
  const { direct, indirect } = collectKeyRefs(new Set(['login']), [f]);
  assert.equal(direct.size, 1);
  assert.equal(indirect.size, 0);
});

test('collectKeyRefs: filename literals sharing a top-level key name are not indirect refs', () => {
  // Regression: previously 'foods.json' / 'settings.json' etc. matched
  // KEYISH_RE and were reported as unresolved i18n keys.
  const src = [
    `const paths = ['foods.json', 'diary.json', 'settings.json'];`,
    `const asset = 'icons/logo.svg';`,
    `import x from './x.svelte';`,
  ].join('\n');
  const f = fixture('H.js', src);
  const { indirect } = collectKeyRefs(new Set(['foods', 'diary', 'settings', 'icons']), [f]);
  assert.equal(indirect.size, 0, [...indirect.keys()].join(', '));
});

test('collectKeyRefs: a real i18n key that happens to end in a bare word still resolves', () => {
  // Sanity: the filename filter must not swallow legit keys like `login.title`
  // or `settings.workout.section`.
  const f = fixture('I.svelte', `const t = 'login.title';\nconst s = 'settings.workout.section';`);
  const { indirect } = collectKeyRefs(new Set(['login', 'settings']), [f]);
  assert.equal(indirect.size, 2);
});
