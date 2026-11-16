// #327: opening a pick from Mealie (or Open Food Facts, USDA, CookTrace) and
// backing out saved the opened values as a draft, so for 4 hours every later
// open showed them over the source's current values. Drafts now hold only
// the fields changed from what the editor opened with, and nothing while
// nothing is changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { draftChanges, applyDraft, draftBase, makeDebouncedPersist, loadDraft, saveDraft } from '../src/lib/editor-draft.js';

function withStorage(fn) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  return Promise.resolve(fn(store)).finally(() => { delete globalThis.localStorage; });
}
const settle = () => new Promise(r => setTimeout(r, 5));
const KEY = 'nt:u1:food:draft:pick:mealie:spaghetti';
// The Food editor's form for a Mealie recipe, as it opens it.
const mealie = kcal => ({ name: 'Spaghetti', brand: '', portion: 100, unit: 'serving', calories: kcal, _mealieSlug: 'spaghetti', nutrition: { calories: kcal, proteins: 0 } });

test('opening a pick and backing out keeps no draft, so the next open shows the current values', () => withStorage(async (store) => {
  const persist = makeDebouncedPersist(KEY, 0, { keep: ['barcode'] });
  const opened = mealie(350);
  persist(draftBase(opened), draftBase(opened)); // the reactive persist firing as the editor opens
  await settle();
  assert.equal(store.has(KEY), false, 'no draft for an untouched form');
  // Mealie now says 425: the next open gets it.
  const next = mealie(425);
  assert.equal(loadDraft(KEY), null);
  assert.equal(next.calories, 425);
}));

test('an edit keeps only that field, and comes back over the current values', () => withStorage(async () => {
  const persist = makeDebouncedPersist(KEY, 0, { keep: ['barcode'] });
  const opened = mealie(350);
  persist({ ...draftBase(opened), name: 'Spaghetti Bolognese' }, draftBase(opened));
  await settle();
  const draft = loadDraft(KEY);
  assert.deepEqual(draft, { name: 'Spaghetti Bolognese' });
  // Reopened after Mealie changed: the edit, on top of 425.
  const form = applyDraft(mealie(425), draft);
  assert.equal(form.name, 'Spaghetti Bolognese');
  assert.equal(form.calories, 425);
  assert.equal(form.nutrition.calories, 425);
}));

test('changing a field back to what it opened with removes the draft', () => withStorage(async (store) => {
  const persist = makeDebouncedPersist(KEY, 0);
  const opened = mealie(350);
  persist({ ...draftBase(opened), calories: 400 }, draftBase(opened));
  await settle();
  assert.equal(store.has(KEY), true);
  persist(draftBase(opened), draftBase(opened));
  await settle();
  assert.equal(store.has(KEY), false);
}));

test("a scan's barcode stays with its draft, so it's only brought back onto that barcode", () => withStorage(async () => {
  const key = 'nt:u1:food:draft:new';
  const persist = makeDebouncedPersist(key, 0, { keep: ['barcode'] });
  const opened = { name: '', barcode: '4000000000001', calories: '' };
  persist({ ...opened, name: 'Rye Bread' }, draftBase(opened));
  await settle();
  assert.deepEqual(loadDraft(key), { name: 'Rye Bread', barcode: '4000000000001' });
}));

test('a nested field counts on its own; a list counts as a whole', () => {
  const opened = { meal: { name: 'Soup', items: [{ name: 'Leek', qty: 1 }], nutrition: { calories: 100, fat: 2 } }, recipeYields: 4 };
  const now = draftBase(opened);
  now.meal.items[0].qty = 2;          // the Meal editor binds ingredient amounts in place
  now.meal.nutrition.fat = 3;
  assert.deepEqual(draftChanges(now, opened), { meal: { items: [{ name: 'Leek', qty: 2 }], nutrition: { fat: 3 } } });
  assert.equal(draftChanges(draftBase(opened), opened), null);
  // A shallow copy would share the ingredients with the form and miss the edit.
  const shallow = { ...opened, meal: { ...opened.meal } };
  shallow.meal.items[0].qty = 5;
  assert.equal(draftChanges(shallow, opened), null, 'why the editors keep a deep copy');
  assert.deepEqual(draftBase(opened).meal.items, [{ name: 'Leek', qty: 5 }]);
});

test('a draft of a pick or saved item from before #327 (the whole form) is not brought back', () => withStorage(async (store) => {
  store.set(KEY, JSON.stringify({ at: Date.now(), state: mealie(350) }));
  assert.equal(loadDraft(KEY), null);
  assert.equal(store.has(KEY), false);
  store.set('nt:u1:meal:draft:edit:9', JSON.stringify({ at: Date.now(), state: { meal: { name: 'old' } } }));
  assert.equal(loadDraft('nt:u1:meal:draft:edit:9'), null);
  // A blank new item's draft can only be typing: it stays (#157).
  store.set('nt:u1:food:draft:new', JSON.stringify({ at: Date.now(), state: { name: 'typed' } }));
  assert.deepEqual(loadDraft('nt:u1:food:draft:new'), { name: 'typed' });
  saveDraft(KEY, { name: 'x' });
  assert.deepEqual(loadDraft(KEY), { name: 'x' });
}));
