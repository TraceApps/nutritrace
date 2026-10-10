import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldFromFeatures, foldFromSegments, sizeClassFor, columnsAcrossFold, keepOffCrease, placeAnchoredMenu, gridTemplateAcrossFold, columnForIndex } from '../src/lib/fold-core.js';

test('size classes', () => {
  assert.equal(sizeClassFor(344), 'compact');
  assert.equal(sizeClassFor(599), 'compact');
  assert.equal(sizeClassFor(600), 'medium');
  assert.equal(sizeClassFor(882), 'medium');
  assert.equal(sizeClassFor(1024), 'expanded');
});

test('half open gives book or tabletop; open flat still reports where the hinge is', () => {
  const f = (state, orientation, extra = {}) => ({ features: [{ state, orientation, separating: false, left: 440, right: 442, top: 0, bottom: 1104, ...extra }] });
  assert.deepEqual(foldFromFeatures(f('half_opened', 'vertical')),
    { posture: 'book', start: 440, end: 442, separating: true, vertical: true });
  assert.deepEqual(foldFromFeatures(f('half_opened', 'horizontal', { left: 0, right: 1104, top: 441, bottom: 441 })),
    { posture: 'tabletop', start: 441, end: 441, separating: true, vertical: false });
  assert.deepEqual(foldFromFeatures(f('flat', 'vertical', { separating: true })),
    { posture: 'book', start: 440, end: 442, separating: true, vertical: true });
  // Open flat the crease is still physically there. Posture is 'flat', so
  // nothing that avoids a crease reacts, but a layout can line a gutter up.
  assert.deepEqual(foldFromFeatures(f('flat', 'vertical')),
    { posture: 'flat', start: 440, end: 442, separating: false, vertical: true });
  assert.equal(foldFromFeatures({ features: [] }), null);
  assert.equal(foldFromFeatures(null), null);
});

test("a flat crease does not trigger anything that avoids one", () => {
  // The helpers that take a fold check its posture, so a flat crease is inert
  // for them. keepOffCrease takes raw coordinates instead, so its guard lives
  // at the call site, which is why it is not asserted here.
  const flat = foldFromFeatures({ features: [{ state: 'flat', orientation: 'vertical', separating: false, left: 440, right: 442, top: 0, bottom: 1104 }] });
  assert.equal(flat.posture, 'flat');
  assert.equal(columnsAcrossFold({ width: 900, gap: 12, minCard: 200, fold: flat }), null);
  const menu = placeAnchoredMenu({ anchorTop: 100, anchorBottom: 140, viewportHeight: 900, fold: flat });
  assert.equal(menu.above, false, 'a flat crease does not push a menu around');
});

test('both sources return the same shape', () => {
  const fromPlugin = foldFromFeatures({ features: [{ state: 'half_opened', orientation: 'vertical', separating: false, left: 400, right: 420, top: 0, bottom: 900 }] });
  const fromWeb = foldFromSegments([{ x: 0, y: 0, width: 400, height: 900 }, { x: 420, y: 0, width: 400, height: 900 }]);
  assert.deepEqual(Object.keys(fromPlugin).sort(), Object.keys(fromWeb).sort());
  assert.deepEqual(fromPlugin, fromWeb);
});

test('viewport segments', () => {
  assert.equal(foldFromSegments([{ x: 0, y: 0, width: 800, height: 600 }]), null);
  assert.deepEqual(foldFromSegments([{ x: 0, y: 0, width: 400, height: 900 }, { x: 420, y: 0, width: 400, height: 900 }]),
    { posture: 'book', start: 400, end: 420, separating: true, vertical: true });
  assert.deepEqual(foldFromSegments([{ x: 0, y: 0, width: 900, height: 400 }, { x: 0, y: 400, width: 900, height: 400 }]),
    { posture: 'tabletop', start: 400, end: 400, separating: true, vertical: false });
});

test('a book fold splits a grid into columns either side of the crease', () => {
  // A 1000px grid at the left edge, creased between 480 and 520.
  const fold = { posture: 'book', start: 480, end: 520 };
  const split = columnsAcrossFold({ width: 1000, left: 0, gap: 16, minCard: 236, fold });
  assert.deepEqual(split, { left: 1, right: 1, hinge: 40 });

  // Wider cards either side give more of them.
  const wide = columnsAcrossFold({ width: 2000, left: 0, gap: 16, minCard: 236, fold: { posture: 'book', start: 980, end: 1020 } });
  assert.deepEqual(wide, { left: 3, right: 3, hinge: 40 });
});

test('the grid keeps its own layout when the crease misses it', () => {
  const beside = { posture: 'book', start: 100, end: 140 };
  // The grid sits to the right of the fold, next to a sidebar.
  assert.equal(columnsAcrossFold({ width: 800, left: 300, gap: 16, minCard: 236, fold: beside }), null);
  // Flat, or tabletop, is not a vertical crease.
  assert.equal(columnsAcrossFold({ width: 800, left: 0, gap: 16, minCard: 236, fold: null }), null);
  assert.equal(columnsAcrossFold({ width: 800, left: 0, gap: 16, minCard: 236, fold: { posture: 'tabletop', start: 400, end: 440 } }), null);
});

test('a side with no room for a card is left unsplit', () => {
  // The crease sits 80px in: one column on the left would be unreadable.
  const tight = { posture: 'book', start: 80, end: 120 };
  assert.equal(columnsAcrossFold({ width: 900, left: 0, gap: 16, minCard: 236, fold: tight }), null);
});

test('a floating panel slides to the side of the crease it leans towards', () => {
  const crease = { start: 480, end: 520, min: 12, max: 1000 };
  // Mostly left of the crease: it goes fully left, ending where the crease starts.
  assert.equal(keepOffCrease({ pos: 380, size: 200, ...crease }), 280);
  // Mostly right: it starts where the crease ends.
  assert.equal(keepOffCrease({ pos: 460, size: 300, ...crease }), 520);
});

test('a panel already clear of the crease is left alone', () => {
  const crease = { start: 480, end: 520, min: 12, max: 1000 };
  assert.equal(keepOffCrease({ pos: 100, size: 200, ...crease }), 100);
  assert.equal(keepOffCrease({ pos: 600, size: 200, ...crease }), 600);
  // No crease at all.
  assert.equal(keepOffCrease({ pos: 300, size: 200, start: 0, end: 0, min: 0, max: 1000 }), 300);
});

test('a panel too big for either side stays where it was put', () => {
  // 900 wide with a crease at 480: neither side can hold it, and pushing it
  // off screen would be worse than leaving it across the fold.
  assert.equal(keepOffCrease({ pos: 50, size: 900, start: 480, end: 520, min: 12, max: 1000 }), 50);
});

test('a menu opens below its field when there is room', () => {
  const place = placeAnchoredMenu({ anchorTop: 100, anchorBottom: 140, viewportHeight: 900, fold: null });
  assert.equal(place.above, false);
  assert.equal(place.top, 144);
  assert.equal(place.maxHeight, 320);
});

test('a menu flips above its field when the space below is short', () => {
  const place = placeAnchoredMenu({ anchorTop: 700, anchorBottom: 740, viewportHeight: 800, fold: null });
  assert.equal(place.above, true);
  assert.ok(place.top < 700, 'it sits above the field');
});

test('a menu never ends up split by the crease, wherever the field is', () => {
  // The property that matters, checked the length of the screen rather than
  // at one flattering spot: the menu's box never overlaps the hinge.
  const fold = { posture: 'tabletop', start: 500, end: 540 };
  for (let top = 0; top <= 940; top += 20) {
    const place = placeAnchoredMenu({ anchorTop: top, anchorBottom: top + 40, viewportHeight: 1000, fold });
    const bottom = place.top + place.maxHeight;
    const clear = bottom <= fold.start || place.top >= fold.end || place.maxHeight === 0;
    assert.ok(clear, `field at ${top}: menu ${place.top}-${bottom} runs through the crease`);
  }
});

test('the roomier side wins when a crease shortens one of them', () => {
  // 156px below the field before the crease, 292 above it: above is better,
  // and bigger, which is the same rule as a menu near the bottom of a screen.
  const fold = { posture: 'tabletop', start: 500, end: 540 };
  const place = placeAnchoredMenu({ anchorTop: 300, anchorBottom: 340, viewportHeight: 1000, fold });
  assert.equal(place.above, true);
  assert.equal(place.maxHeight, 288);
});

test('a field just above the crease sends its menu the other way', () => {
  // Only 20px between the field and the crease: above is roomier.
  const fold = { posture: 'tabletop', start: 500, end: 540 };
  const place = placeAnchoredMenu({ anchorTop: 440, anchorBottom: 480, viewportHeight: 1000, fold });
  assert.equal(place.above, true);
  assert.ok(place.top + place.maxHeight <= 440, 'it ends above the field');
});

test('a field below the crease opens downwards as usual', () => {
  const fold = { posture: 'tabletop', start: 500, end: 540 };
  const place = placeAnchoredMenu({ anchorTop: 600, anchorBottom: 640, viewportHeight: 1000, fold });
  assert.equal(place.above, false);
  assert.equal(place.maxHeight, 320);
});

test('cards skip the hinge track and keep their reading order', () => {
  const split = { left: 2, right: 2, hinge: 24 };
  assert.equal(gridTemplateAcrossFold(split, 'x'),
    'repeat(2, minmax(0, 1fr)) 24px repeat(2, minmax(0, 1fr))');
  // Four per row: two on the left page, then two on the right, and the third
  // track is the crease, which nothing is placed in.
  const row = [0, 1, 2, 3].map(i => columnForIndex(i, split));
  assert.deepEqual(row, ['1', '2', '4', '5']);
  // The next row starts over on the left page.
  assert.deepEqual([4, 5, 6, 7].map(i => columnForIndex(i, split)), ['1', '2', '4', '5']);
});

test('without a fold the grid is left exactly as it was', () => {
  assert.equal(gridTemplateAcrossFold(null, 'repeat(auto-fill, minmax(260px, 1fr))'),
    'repeat(auto-fill, minmax(260px, 1fr))');
  assert.equal(columnForIndex(3, null), 'auto');
});

test('uneven pages still place every card on a page', () => {
  const split = { left: 1, right: 3, hinge: 30 };
  const row = [0, 1, 2, 3, 4].map(i => columnForIndex(i, split));
  assert.deepEqual(row, ['1', '3', '4', '5', '1']);
  assert.ok(!row.includes('2'), 'the hinge track is never used');
});

// Half open like a book (a Pixel Fold's inner screen, 852px), the Diary's and
// Goals' side rails took the right-hand page and squeezed the main column
// across the crease. Only below 1280px and only half open; flat and desktop
// keep their rails beside the content.
import { readFileSync as _read } from 'node:fs';
test("half open, the Diary's meals take both pages and the rail follows below; Goals puts targets and preview a page each", () => {
  const diary = _read(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
  const goals = _read(new URL('../src/routes/Goals.svelte', import.meta.url), 'utf8');
  // Diary: the rail renders in the page (not portaled and fixed) when half open below 1280.
  assert.match(diary, /\$: _railInline = \$fold\?\.posture === 'book' && !_wideViewport && !\$forceMobileLayout;/);
  assert.match(diary, /\{#if _railInline\}[\s\S]*?<aside class="diary-right-col diary-rail-inline">[\s\S]*?\{:else if _railMode === 'pinned'\}/);
  const css = diary.slice(diary.indexOf('<style'));
  const foldRules = css.slice(css.indexOf("html.fold-book.wide-content) .diary-content {") - 200);
  assert.match(foldRules, /@media \(max-width: 1279px\) \{\s*:global\(html\.fold-book\.wide-content\) \.diary-content \{\s*display: flex;\s*flex-direction: column;\s*align-items: stretch;/);
  assert.match(css, /\.diary-content\.fold-pages \.diary-right-col\.diary-rail-inline \{\s*display: grid;\s*grid-template-columns: var\(--meal-left-w\) minmax\(0, 1fr\);\s*column-gap: var\(--meal-hinge\);/);
  assert.match(diary, /class:fold-pages=\{mealFoldSnap\}/);
  // Goals: two pages with the crease as the gutter, or the preview below.
  assert.match(goals, /import \{ fold \} from '\.\.\/lib\/fold\.js';/);
  assert.match(goals, /class="goals-body" bind:this=\{goalsBodyEl\} class:fold-pages=\{goalsFoldPages\}/);
  assert.match(goals, /:global\(html\.fold-book\.wide-content\) \.goals-body\.fold-pages \{\s*grid-template-columns: var\(--goals-left-w\) minmax\(0, 1fr\);\s*column-gap: var\(--goals-hinge\);/);
});
