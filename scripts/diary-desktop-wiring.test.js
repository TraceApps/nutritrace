/**
 * Static-analysis smoke test for the Diary desktop redesign (Phases 1-7).
 *
 * These do not exercise the wire protocol or render anything; they only
 * guard against accidental unwiring of the desktop layout during future
 * refactors. Runs alongside the MCP wiring tests via `npm test`.
 *
 * If a future edit removes any of the anchors below (a widget import,
 * the meal-cols split, the ≥1280px media query, the viewport-gated
 * draggable binding, etc.), CI catches it before merge.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const diarySrc = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
const weekStripSrc = readFileSync(new URL('../src/components/diary/WeekStrip.svelte', import.meta.url), 'utf8');
const daySummarySrc = readFileSync(new URL('../src/components/diary/DaySummaryWidget.svelte', import.meta.url), 'utf8');

// ── Widget imports (Phase 2-4, 6) ─────────────────────────────────────────
test('Diary imports all right-rail widgets', () => {
  // Weight + Measurements merged into BodyStatsWidget in v1.2.0-dev02.
  const widgets = [
    'DaySummaryWidget',
    'WaterWidget',
    'BodyStatsWidget',
    'ActivityImpactWidget',
    'WeekStrip',
  ];
  for (const w of widgets) {
    assert.match(diarySrc, new RegExp(`import\\s+${w}\\s+from`), `missing import: ${w}`);
  }
});

// ── Wide-viewport media query gates the redesign (Phase 1) ────────────────
test('Diary gates the desktop redesign at min-width: 1280px', () => {
  assert.match(diarySrc, /@media\s*\(\s*min-width\s*:\s*1280px\s*\)/, 'no 1280px media query');
});

// ── Two-column shell + right rail (Phase 2) ───────────────────────────────
test('Diary has a .diary-right-col that is hidden by default and shown ≥1280px', () => {
  assert.match(diarySrc, /\.diary-right-col\s*\{[^}]*display:\s*none/,
    '.diary-right-col should default to display:none');
  assert.match(diarySrc, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+360px/,
    'diary-content should switch to 2-col grid with 360px rail at wide');
});

// ── Meal column-pack split (Phase 5) ──────────────────────────────────────
test('Diary computes mealsLeft and mealsRight via index parity', () => {
  assert.match(diarySrc, /mealsLeft\s*=\s*mealLayout\.filter\(m\s*=>\s*m\.mealIdx\s*%\s*2\s*===\s*0\)/);
  assert.match(diarySrc, /mealsRight\s*=\s*mealLayout\.filter\(m\s*=>\s*m\.mealIdx\s*%\s*2\s*===\s*1\)/);
});

test('Diary renders meals via a snippet consumed twice (once per column)', () => {
  assert.match(diarySrc, /\{#snippet\s+mealCard\(/, 'snippet mealCard() not defined');
  const renderMatches = diarySrc.match(/\{@render\s+mealCard\(/g) || [];
  assert.ok(renderMatches.length >= 2, `expected 2+ mealCard renders, got ${renderMatches.length}`);
});

test('Diary uses .meal-cols container with display:contents on .meal-col below wide', () => {
  assert.match(diarySrc, /\.meal-col\s*\{[^}]*display:\s*contents/,
    '.meal-col should use display:contents so cards flatten on mobile');
  assert.match(diarySrc, /order:\{mealIdx\}/,
    'each meal card needs inline order for mobile temporal ordering');
});

// ── Bottom bar + top-right icons hidden at wide (Phase 4) ─────────────────
test('Diary hides the mobile bottom bar + top-right actions at ≥1280px', () => {
  // These live inside the min-width:1280px media query and are gated
  // on :global(html:not(.force-mobile-layout) …) so the Force Mobile
  // Layout toggle can turn the whole large-screen behavior off.
  assert.match(diarySrc, /:global\(html:not\(\.force-mobile-layout\)\s+\.diary-topbar-actions\)\s*\{\s*display:\s*none/);
  assert.match(diarySrc, /:global\(html:not\(\.force-mobile-layout\)\s+\.diary-bottom-bar\)\s*\{\s*display:\s*none/);
});

// ── Week strip + hover popover (Phase 6) ──────────────────────────────────
test('WeekStrip pulls last 7 days from getAllDiary and shows kcal per day', () => {
  assert.match(weekStripSrc, /NtApi\.getAllDiary\(\)/);
  // 7-column layout
  assert.match(weekStripSrc, /grid-template-columns:\s*repeat\(7,\s*1fr\)/);
  // Full weekday names (not single-letter abbreviations)
  assert.match(weekStripSrc, /'Sunday',\s*'Monday'/);
});

test('WeekStrip respects disableAnimations in the popover fade', () => {
  assert.match(weekStripSrc, /import\s+\{[^}]*disableAnimations[^}]*\}\s+from\s+['"]\.\.\/\.\.\/stores\/settings/,
    'WeekStrip should import disableAnimations');
  assert.match(weekStripSrc, /\$disableAnimations\s*\?\s*0\s*:\s*120/,
    'popover fade duration should collapse to 0 when disableAnimations is on');
});

// ── Drag-to-copy (Phase 7) ────────────────────────────────────────────────
test('Diary drag-to-copy is gated on ≥1280px viewport', () => {
  assert.match(diarySrc, /_wideViewport/,
    'reactive _wideViewport flag missing');
  assert.match(diarySrc, /matchMedia\(['"]\(min-width:\s*1280px\)['"]\)/,
    'matchMedia listener for 1280px not present');
  assert.match(diarySrc, /draggable=\{!isEmpty\s*&&\s*_wideViewport\}/,
    'draggable attribute should require both !isEmpty AND _wideViewport');
});

test('Diary drop opens the existing Copy sheet (not an invisible write)', () => {
  assert.match(diarySrc, /_onDropMealOnWeekDay/, 'drop handler missing');
  // The drop handler should open showCopySheet, not call copyMealToDate directly
  const dropHandler = diarySrc.split('_onDropMealOnWeekDay')[1]?.split('function')[0] || '';
  assert.ok(!/copyMealToDate\(/.test(dropHandler),
    'drop should NOT call copyMealToDate directly — it should open the Copy sheet for user confirmation');
  assert.match(diarySrc, /_onDropMealOnWeekDay[\s\S]{0,800}showCopySheet\s*=\s*true/,
    'drop should set showCopySheet = true');
});

test('WeekStrip accepts drops via application/x-nt-meal-idx MIME type', () => {
  assert.match(weekStripSrc, /application\/x-nt-meal-idx/,
    'MIME type contract between Diary drag source and WeekStrip drop target must match');
  assert.match(weekStripSrc, /on:dragover/);
  assert.match(weekStripSrc, /on:drop/);
});

// ── Day Summary widget matches sheet (Phase 4 refactor) ───────────────────
test('DaySummaryWidget mirrors the Nutrition Summary sheet conventions', () => {
  // Percent/grams toggle uses shared macroLegendMode store
  assert.match(daySummarySrc, /macroLegendMode\.set\(/);
  // Three macro pill cards, not colored side-rule rows
  assert.match(daySummarySrc, /dsw-macro-pill/);
  // Open-full-summary button present
  assert.match(daySummarySrc, /open_in_full/);
  // MacroRing (not a hand-rolled ring) reused for the visualization
  assert.match(daySummarySrc, /import\s+MacroRing/);
});
