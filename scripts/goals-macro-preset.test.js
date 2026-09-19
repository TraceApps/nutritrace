/**
 * Static regression coverage for macro presets in Goals.svelte.
 *
 * Goals currently has no component-test harness, so these checks ensure each
 * gram-based preset resets percent mode after preserving prior goal settings.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const goalsSrc = readFileSync(new URL('../src/routes/Goals.svelte', import.meta.url), 'utf8');
const presetBlock = goalsSrc.match(/function applyMacroPreset\(name\) \{[\s\S]*?showSuccess\('Macros set'\);\n  \}/)?.[0];

test('macro presets calculate gram targets using the correct calorie densities', () => {
  assert.ok(presetBlock, 'applyMacroPreset function not found');
  assert.match(presetBlock, /const pG = Math\.round\(kcal \* preset\.p \/ 100 \/ 4\)/);
  assert.match(presetBlock, /const cG = Math\.round\(kcal \* preset\.c \/ 100 \/ 4\)/);
  assert.match(presetBlock, /const fG = Math\.round\(kcal \* preset\.f \/ 100 \/ 9\)/);
});

for (const [macro, target] of [
  ['proteins', 'pG'],
  ['carbohydrates', 'cG'],
  ['fat', 'fG'],
]) {
  test(`macro presets reset percent mode for ${macro} after merging existing settings`, () => {
    assert.ok(presetBlock, 'applyMacroPreset function not found');
    const line = presetBlock.split('\n').find(value => value.trimStart().startsWith(`${macro}:`));
    assert.ok(line, `${macro} preset goal not found`);

    const spreadAt = line.indexOf(`...(g.${macro}`);
    const resetAt = line.indexOf('isPercent: false');
    const targetAt = line.indexOf(`max: ${target}`);
    assert.ok(spreadAt >= 0, `${macro} should preserve existing goal settings`);
    assert.ok(resetAt > spreadAt, `${macro} must reset isPercent after existing settings are merged`);
    assert.ok(targetAt > resetAt, `${macro} should store the calculated gram target`);
  });
}
