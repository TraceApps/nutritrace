/**
 * Goals page handling of macro goals saved "As percent".
 *
 * Two bugs, same root: a stored percentage being treated as grams.
 *   1. The right-rail preview (Macros card, ring, stacked bar, preset
 *      chip, macro-kcal warning) read `max ?? min` raw, so 30% showed
 *      as "30 g".
 *   2. Ticking "As percent" in the editor relabelled the field without
 *      converting it, so a 137 g goal silently became 137% of calories.
 *
 * Goals has no component harness, so the wiring checks read the source.
 * The toggle handler is pulled out of the component and executed for
 * real against the real helpers, not just matched by shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { percentGoalToGrams, gramsGoalToPercent } from '../src/lib/goal-resolver.js';
import { parseDecimal } from '../src/lib/decimal-input.js';

const src = readFileSync(new URL('../src/routes/Goals.svelte', import.meta.url), 'utf8');
const script = src.slice(0, src.indexOf('</script>'));

const MACRO_DENSITY = new Function(
  `return (${script.match(/const MACRO_DENSITY = (\{[^}]*\});/)[1]});`,
)();

// Run the component's real _onPercentToggle against a given editor state.
function toggle({ statId, val0 = '', dayVals = ['', '', '', '', '', '', ''], cal = 1828 }, checked) {
  const fn = script.match(/function _onPercentToggle\(e\) \{[\s\S]*?\n {2}\}\n/)[0];
  const run = new Function(
    'MACRO_DENSITY', 'parseDecimal', 'gramsGoalToPercent', 'percentGoalToGrams', 'state',
    `let { editStat, editVal0, editDayVals, _effectiveCalGoal } = state;
     ${fn}
     _onPercentToggle({ currentTarget: { checked: state.checked } });
     return { editVal0, editDayVals };`,
  );
  return run(MACRO_DENSITY, parseDecimal, gramsGoalToPercent, percentGoalToGrams, {
    editStat: { id: statId }, editVal0: val0, editDayVals: [...dayVals], _effectiveCalGoal: cal, checked,
  });
}

// ── 1. Right-rail preview ──────────────────────────────────────────────

test('rail converts each macro through macroGoalGrams on the effective calorie goal', () => {
  for (const [v, key] of [['_proteinGoalG', 'proteins'], ['_carbsGoalG', 'carbohydrates'], ['_fatGoalG', 'fat']]) {
    const re = new RegExp(`\\$: ${v}\\s*=\\s*macroGoalGrams\\(\\$goals\\.${key},\\s*_effectiveCalGoal,\\s*MACRO_DENSITY\\.${key}\\);`);
    assert.match(script, re, `${v} should convert percent goals to grams`);
  }
});

test('no raw `max ?? min` read of a macro goal is left in the rail', () => {
  assert.doesNotMatch(script, /\$goals\.(proteins|carbohydrates|fat)\?\.max\s*\?\?\s*\$goals\.\1\?\.min/);
});

test('helpers are imported from goal-resolver', () => {
  assert.match(script, /import \{[^}]*macroGoalGrams[^}]*\} from '\.\.\/lib\/goal-resolver\.js'/);
});

// ── 2. Editor "As percent" toggle ──────────────────────────────────────

test('checkbox runs the conversion on user change', () => {
  assert.match(src, /<input type="checkbox" bind:checked=\{editIsPercent\} on:change=\{_onPercentToggle\} \/>/);
});

test('conversion is not reactive, so opening an existing goal never converts it', () => {
  assert.doesNotMatch(script, /\$:[^\n]*_onPercentToggle/);
  assert.doesNotMatch(script, /\$:[^\n]*editIsPercent/);
});

test('ticking As percent converts grams to percent, unticking converts back exactly', () => {
  const on = toggle({ statId: 'proteins', val0: '137' }, true);
  assert.equal(on.editVal0, '30');
  const off = toggle({ statId: 'proteins', val0: on.editVal0 }, false);
  assert.equal(off.editVal0, '137');
  assert.equal(toggle({ statId: 'fat', val0: '61' }, true).editVal0, '30');
  assert.equal(toggle({ statId: 'carbohydrates', val0: '183' }, true).editVal0, '40');
});

test('per-day values convert individually and blanks stay blank', () => {
  const r = toggle({ statId: 'proteins', dayVals: ['137', '', '150', '', '', '', '120'] }, true);
  assert.deepEqual(r.editDayVals, ['30', '', '32.8', '', '', '', '26.3']);
  const back = toggle({ statId: 'proteins', dayVals: r.editDayVals }, false);
  assert.deepEqual(back.editDayVals, ['137', '', '150', '', '', '', '120']);
});

test('comma decimals convert; unparseable text is left as typed', () => {
  assert.equal(toggle({ statId: 'proteins', val0: '29,9' }, false).editVal0, '137');
  assert.equal(toggle({ statId: 'proteins', val0: 'abc' }, true).editVal0, 'abc');
  assert.equal(toggle({ statId: 'proteins', val0: '' }, true).editVal0, '');
});

test('stats that cannot be a percentage are never touched', () => {
  for (const statId of ['fiber', 'calories', 'kilojoules', 'sodium']) {
    assert.equal(toggle({ statId, val0: '137' }, true).editVal0, '137', statId);
  }
});
