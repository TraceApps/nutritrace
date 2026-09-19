/**
 * #225: dragging the Trace button down while the page was at the top was
 * read as pull-to-refresh and synced the Diary. Anything draggable is now
 * left out of pull-to-refresh, alongside the areas that already were.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPullSyncExempt, PULL_SYNC_EXEMPT } from '../src/lib/pull-sync.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Minimal element: a class list, attributes, and a parent. closest() checks
// each simple selector in a comma list against the element and its ancestors.
function el(classes = [], attrs = {}, parent = null) {
  const node = {
    classes: new Set(classes), attrs, parentElement: parent,
    matches(sel) {
      return sel.split(',').map((x) => x.trim()).some((s) => {
        if (s.startsWith('.')) return this.classes.has(s.slice(1));
        const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
        if (m) return m[2] === undefined ? m[1] in this.attrs : this.attrs[m[1]] === m[2];
        return false;
      });
    },
    closest(sel) {
      for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n;
      return null;
    },
  };
  return node;
}

test('dragging the Trace button never starts a pull', () => {
  const fab = el(['ai-fab', 'panel-open']);
  const face = el(['fab-robot-wrap'], {}, fab);   // the touch lands on the face inside it
  assert.equal(isPullSyncExempt(fab), true);
  assert.equal(isPullSyncExempt(face), true);
});

test('reorder handles and the photo cropper are left out too', () => {
  assert.equal(isPullSyncExempt(el(['drag-handle', 'material-symbols-rounded'])), true);
  assert.equal(isPullSyncExempt(el(['crop-box'])), true);
  assert.equal(isPullSyncExempt(el([], { 'data-no-pull-sync': '' })), true);
});

test('everything that was already left out still is', () => {
  assert.equal(isPullSyncExempt(el([], { role: 'dialog' })), true);
  for (const c of ['sheet-backdrop', 'sidebar-panel', 'sidebar-backdrop', 'bottom-nav', 'bottom-dock']) {
    assert.equal(isPullSyncExempt(el([c])), true, c);
  }
});

test('ordinary page content still starts a pull', () => {
  const page = el(['page-transition']);
  const card = el(['meal-group'], {}, el(['diary-content'], {}, page));
  assert.equal(isPullSyncExempt(card), false);
  assert.equal(isPullSyncExempt(el(['app-topbar'])), false, 'pulling over the top bar keeps working');
  assert.equal(isPullSyncExempt(null), false);
});

test('the classes it relies on are the ones the app uses', () => {
  assert.match(read('../src/components/ai/Trace.svelte'), /class="ai-fab"/);
  assert.match(read('../src/components/ui/ImageCropper.svelte'), /class="crop-box"/);
  for (const f of ['../src/routes/settings/Diary.svelte', '../src/routes/settings/Nutrients.svelte',
    '../src/routes/settings/BodyStats.svelte', '../src/routes/settings/Statistics.svelte', '../src/routes/MealEditor.svelte']) {
    assert.match(read(f), /class="drag-handle[ "]/, f);
  }
  for (const s of ['.ai-fab', '.drag-handle', '.crop-box']) assert.ok(PULL_SYNC_EXEMPT.includes(s), s);
});

test('App.svelte uses the shared check when a touch starts', () => {
  const app = read('../src/App.svelte');
  const start = app.slice(app.indexOf('function _startPullSync'), app.indexOf('function _movePullSync'));
  assert.match(start, /if \(isPullSyncExempt\(event\.target\)\) return;/);
  assert.doesNotMatch(start, /closest\?\.\('\[role="dialog"\]/, 'no second, drifting copy of the list');
});
