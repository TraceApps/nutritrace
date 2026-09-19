/**
 * #226: Android's back button only knew how to go back a page, so with a
 * sheet like Body Stats open it did nothing visible. Open sheets, dialogs and
 * overlays now register with back-stack.js and back closes the newest first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { onBack, handleBack, backStackDepth, closeOnBack } from '../src/lib/back-stack.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('with nothing open, back is not taken (the page goes back as before)', () => {
  assert.equal(backStackDepth(), 0);
  assert.equal(handleBack(), false);
});

test('back closes the newest layer first', () => {
  const closed = [];
  const sheet = closeOnBack({}, () => closed.push('sheet'));
  const dialog = closeOnBack({}, () => closed.push('dialog'));
  assert.equal(handleBack(), true);
  assert.deepEqual(closed, ['dialog']);
  dialog.destroy();                       // the dialog's element goes away
  assert.equal(handleBack(), true);
  assert.deepEqual(closed, ['dialog', 'sheet']);
  sheet.destroy();
  assert.equal(backStackDepth(), 0);
  assert.equal(handleBack(), false, 'then back falls through to the page');
});

test('a layer closed some other way stops catching back', () => {
  let hits = 0;
  const layer = closeOnBack({}, () => hits++);
  layer.destroy();                        // closed with its X, or the page changed
  assert.equal(handleBack(), false);
  assert.equal(hits, 0);
});

test('a layer that must be answered keeps catching back', () => {
  // The sync merge dialog passes a no-op: back must neither dismiss it nor
  // let the next press navigate away underneath it.
  const merge = closeOnBack({}, () => {});
  assert.equal(handleBack(), true);
  assert.equal(handleBack(), true, 'still there on the second press');
  merge.destroy();
  assert.equal(handleBack(), false);
});

test('the close action can change while the layer is open', () => {
  let which = '';
  const layer = closeOnBack({}, () => { which = 'first'; });
  layer.update(() => { which = 'second'; });
  handleBack();
  assert.equal(which, 'second');
  layer.destroy();
});

test('a handler that throws still counts as handled', () => {
  const release = onBack(() => { throw new Error('gone'); });
  assert.equal(handleBack(), true);
  release();
  assert.equal(backStackDepth(), 0);
});

test('the Android back button checks the stack, then the sidebar, then goes back a page', () => {
  const app = read('../src/App.svelte');
  const h = app.slice(app.indexOf("App.addListener('backButton'"), app.indexOf("App.addListener('appUrlOpen'"));
  const stackAt = h.indexOf('if (handleBack()) return;');
  const sideAt = h.indexOf('if (sidebarOpen && !sidebarPinned)');
  const pageAt = h.indexOf('window.history.back()');
  assert.ok(stackAt > 0 && sideAt > stackAt && pageAt > sideAt);
});

function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

// A tag ends at the first '>' outside {...}, so arrow functions in
// attributes (on:click={() => ...}) don't cut it short.
function tagAt(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === '>' && depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start);
}

test('every modal overlay in the app is registered', () => {
  // Any element marked as a modal dialog must also be registered, so a new
  // sheet can't reintroduce #226 unnoticed. Sheet.svelte registers on its
  // backdrop, whose panel carries the role.
  // Inner panels of an already-registered backdrop carry the role too.
  const innerPanels = [['components/ui/Sheet.svelte', 'sheet-panel'], ['components/ui/Dialog.svelte', 'dialog-box']];
  const files = walk(new URL('../src/', import.meta.url).pathname).filter((f) => f.endsWith('.svelte'));
  const missing = [];
  let checked = 0;
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    const rel = f.split('/src/')[1];
    for (let at = s.indexOf('aria-modal="true"'); at >= 0; at = s.indexOf('aria-modal="true"', at + 1)) {
      const tag = tagAt(s, s.lastIndexOf('<', at));
      if (innerPanels.some(([file, cls]) => rel === file && tag.includes(cls))) continue;
      checked++;
      if (!/use:closeOnBack=/.test(tag)) missing.push(`${rel}: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.ok(checked >= 16, `found the overlays (${checked})`);
  assert.deepEqual(missing, []);
});

test('every hand-built backdrop and overlay is registered too', () => {
  // Overlays without aria-modal: a backdrop, overlay or scrim element.
  // These are the ones back rightly leaves alone:
  const notLayers = new Map([
    ['components/layout/Sidebar.svelte', 'sidebar-backdrop'],       // App.svelte closes the sidebar itself
    ['routes/Profile.svelte', 'avatar-overlay'],                     // a hover hint on the photo
    ['routes/Foods.svelte', 'scan-lookup-overlay'],                  // a "looking up" note that takes no taps
    ['components/foods/BarcodeScanner.svelte', 'scanner-backdrop'],  // the browser scanner, never on Android
  ]);
  const files = walk(new URL('../src/', import.meta.url).pathname).filter((f) => f.endsWith('.svelte'));
  const missing = [];
  let checked = 0;
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    const rel = f.split('/src/')[1];
    const markup = s.lastIndexOf('</script>');
    for (const m of s.slice(markup).matchAll(/<(div|aside|section)\b/g)) {
      const tag = tagAt(s, markup + m.index);
      const layer = ((tag.match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/).find((c) => /(^|-)(backdrop|overlay|scrim)$/.test(c));
      if (!layer || notLayers.get(rel) === layer) continue;
      checked++;
      if (!/use:closeOnBack=/.test(tag)) missing.push(`${rel}: .${layer}`);
    }
  }
  assert.ok(checked >= 30, `found the overlays (${checked})`);
  assert.deepEqual(missing, []);
});

test('the shared components and hand-built sheets are registered', () => {
  assert.match(read('../src/components/ui/Sheet.svelte'), /class="sheet-backdrop" on:click=\{onBackdropClick\} use:closeOnBack=\{close\}/);
  assert.match(read('../src/components/ui/Dialog.svelte'), /class="dialog-backdrop"[^>]*use:closeOnBack=/);
  assert.match(read('../src/components/ui/ActionSheet.svelte'), /class="as-backdrop"[^>]*use:closeOnBack=/);
  const diary = read('../src/routes/Diary.svelte');
  assert.match(diary, /use:closeOnBack=\{\(\) => diaryShowBodyStats\.set\(false\)\}/, 'Body Stats, the sheet from the report');
  assert.equal((read('../src/routes/Goals.svelte').match(/use:closeOnBack=/g) || []).length, 4);
  assert.match(read('../src/components/ai/Trace.svelte'), /class="ai-backdrop" use:closeOnBack=\{\(\) => panelOpen = false\}/);
  assert.match(read('../src/components/foods/BarcodeScanner.svelte'), /use:closeOnBack=\{closeNative\}/);
  assert.match(read('../src/routes/FoodEditor.svelte'), /use:closeOnBack=\{stopCamera\}/, 'the camera stops, not just hides');
  assert.match(read('../src/routes/MealEditor.svelte'), /use:closeOnBack=\{closeCamera\}/);
});

test('the sync merge dialog swallows back rather than dismissing it', () => {
  const sc = read('../src/routes/settings/ServerConnection.svelte');
  assert.equal((sc.match(/class="merge-overlay"[^>]*use:closeOnBack=\{\(\) => \{\}\}/g) || []).length, 3);
});
