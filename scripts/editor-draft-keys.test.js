// Each item an editor opens keeps its own draft (#260).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { draftKey, pickIdentity, saveDraft, sweepDrafts } from '../src/lib/editor-draft.js';

test('saved items, picks from each source, and a blank new item get separate keys', () => {
  assert.equal(draftKey('meal', 12), 'nt:meal:draft:edit:12');
  assert.equal(draftKey('food', null), 'nt:food:draft:new');
  assert.equal(draftKey('meal', null, { name: 'Tomato Soup', source_app: 'cooktrace', source_external_id: 'recipe:169' }), 'nt:meal:draft:pick:cooktrace:recipe:169');
  assert.equal(draftKey('food', null, { name: 'Bread Flour', source_app: 'cooktrace', source_external_id: 'pantry:1' }), 'nt:food:draft:pick:cooktrace:pantry:1');
  assert.equal(draftKey('food', null, { name: 'Soup', _mealieSlug: 'soup' }), 'nt:food:draft:pick:mealie:soup');
  assert.equal(draftKey('food', null, { name: 'Oats', barcode: '3017620422003' }), 'nt:food:draft:pick:barcode:3017620422003');
  assert.equal(draftKey('food', null, { name: 'Apple', barcode: 'fdcId_171688' }), 'nt:food:draft:pick:barcode:fdcId_171688');
  assert.equal(draftKey('food', null, { name: 'Trace Omelette', brand: '' }), 'nt:food:draft:pick:name:trace omelette|');
});

test('two different picks never share a key; the same pick does', () => {
  const a = { source_app: 'cooktrace', source_external_id: 'recipe:169' };
  const b = { source_app: 'cooktrace', source_external_id: 'recipe:96' };
  assert.notEqual(draftKey('meal', null, a), draftKey('meal', null, b));
  assert.equal(draftKey('meal', null, a), draftKey('meal', null, { ...a }));
  assert.notEqual(draftKey('food', null, a), draftKey('food', null, null), 'a pick never lands on the blank-item draft');
});

test('an id wins over the pick, and "undefined" from an old URL is not an id', () => {
  assert.equal(draftKey('meal', 7, { source_app: 'cooktrace', source_external_id: 'recipe:1' }), 'nt:meal:draft:edit:7');
  assert.equal(draftKey('meal', 'undefined', { source_app: 'cooktrace', source_external_id: 'recipe:1' }), 'nt:meal:draft:pick:cooktrace:recipe:1');
  assert.equal(pickIdentity(null), null);
  assert.equal(pickIdentity({}), null);
  // A scan of an unknown barcode stays on the blank-item draft (#157).
  assert.equal(draftKey('food', null, { barcode: '0123456789' }), 'nt:food:draft:new');
});

test('both editors key their drafts by the prefill, and picks open without an id in the URL', () => {
  const meal = readFileSync(new URL('../src/routes/MealEditor.svelte', import.meta.url), 'utf8');
  const food = readFileSync(new URL('../src/routes/FoodEditor.svelte', import.meta.url), 'utf8');
  const foods = readFileSync(new URL('../src/routes/Foods.svelte', import.meta.url), 'utf8');
  // Worked out once as the editor opens, so it can't switch mid-edit.
  assert.match(meal, /const _draftKey = _mkDraftKey\('meal', params\?\.id \?\? editorState\.mealPrefill\?\.id \?\? null, editorState\.mealPrefill\)/);
  assert.match(food, /const _draftKey = _mkDraftKey\('food', params\?\.id \?\? editorState\.foodPrefill\?\.id \?\? null, editorState\.foodPrefill\)/);
  assert.match(meal, /sweepDrafts\(\);/);
  assert.match(food, /sweepDrafts\(\);/);
  // A blank-item draft from another scan isn't laid over this scan.
  assert.match(food, /String\(_draft\.barcode\) !== String\(editorState\.foodPrefill\.barcode\)/);
  assert.match(foods, /push\(item && item\.id != null \? '\/meal-editor\/' \+ item\.id : '\/meal-editor'\)/);
});

test('expired drafts are swept, fresh ones kept, and the old shared key removed', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null, get length() { return store.size; },
  };
  try {
    saveDraft('nt:food:draft:pick:barcode:1', { name: 'fresh' });
    store.set('nt:meal:draft:pick:cooktrace:recipe:2', JSON.stringify({ at: Date.now() - 5 * 3600 * 1000, state: { name: 'old' } }));
    store.set('nt:meal:draft:edit:undefined', JSON.stringify({ at: Date.now(), state: { name: 'shared' } }));
    store.set('wl_u1_theme', '"dark"');
    sweepDrafts();
    assert.deepEqual([...store.keys()].sort(), ['nt:food:draft:pick:barcode:1', 'wl_u1_theme']);
  } finally { delete globalThis.localStorage; }
});
