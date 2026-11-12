/**
 * Recommended daily targets (lib/daily-targets.js). Expected values come from
 * the formulas in that file, worked out by hand for a 38-year-old man at
 * 190.5 cm, 98.43 kg, target 86.18 kg, on a 2,000 kcal goal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ageOn, bmrMifflinStJeor, recommendedTargets } from '../src/lib/daily-targets.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const NOW = new Date('2026-11-02T12:00:00');
const man = { gender: 'male', dob: '1988-10-07', height_cm: 190.5, weight_kg: 98.43, target_weight: 86.18 };

test('age counts birthdays already passed this year', () => {
  assert.equal(ageOn('1988-10-07', NOW), 38);
  assert.equal(ageOn('1988-11-03', NOW), 37);
  assert.equal(ageOn('', NOW), null);
  assert.equal(ageOn('not a date', NOW), null);
});

test('Mifflin-St Jeor BMR for the example man is about 1,990 kcal', () => {
  const bmr = bmrMifflinStJeor({ gender: 'male', age: 38, height_cm: 190.5, weight_kg: 98.43 });
  assert.ok(Math.abs(bmr - 1989.9) < 0.1, String(bmr));
  assert.equal(bmrMifflinStJeor({ gender: 'x', age: 38, height_cm: 190.5, weight_kg: 98.43 }), null);
});

test('macros: protein 1.8 g per kg of target weight when Extremely Active, fat 30%, carbs get the rest', () => {
  const t = recommendedTargets({ ...man, activity: 'very_active' }, 2000, NOW);
  assert.deepEqual(t.proteins, { value: 155, kind: 'min' });
  assert.deepEqual(t.fat, { value: 67, kind: 'target' });
  assert.deepEqual(t.carbohydrates, { value: 194, kind: 'target' });
  assert.deepEqual(t['saturated-fat'], { value: 22, kind: 'max' });
  assert.deepEqual(t['added-sugars'], { value: 50, kind: 'max' });
});

test('limits that do not depend on the profile', () => {
  const t = recommendedTargets({}, 2000, NOW);
  assert.deepEqual(t.sodium, { value: 2300, kind: 'max' });
  assert.deepEqual(t.cholesterol, { value: 300, kind: 'max' });
});

test('micronutrients for a man aged 31-50', () => {
  const t = recommendedTargets(man, 2000, NOW);
  assert.deepEqual(t.fiber, { value: 38, kind: 'min' });
  assert.equal(t.calcium.value, 1000);
  assert.equal(t.iron.value, 8);
  assert.equal(t.potassium.value, 3400);
  assert.equal(t.magnesium.value, 420);
  assert.equal(t['vitamin-d'].value, 15);
  assert.equal(t.b6.value, 1.3);
  assert.equal(t.b12.value, 2.4);
});

test('a woman gets her own values: more iron, less potassium, less fiber', () => {
  const t = recommendedTargets({ gender: 'female', dob: '1996-05-01', weight_kg: 65 }, 2000, NOW);
  assert.equal(t.iron.value, 18);
  assert.equal(t.potassium.value, 2600);
  assert.equal(t.fiber.value, 25);
  assert.equal(t.magnesium.value, 310);
});

test('age bands change the values: calcium and fiber after 50', () => {
  const t = recommendedTargets({ gender: 'female', dob: '1970-01-01', weight_kg: 65 }, 2000, NOW);
  assert.equal(t.calcium.value, 1200);
  assert.equal(t.fiber.value, 21);
  assert.equal(t.b6.value, 1.5);
});

test('no micronutrient targets without a sex or under 19', () => {
  const noSex = recommendedTargets({ dob: '1988-10-07', weight_kg: 98 }, 2000, NOW);
  assert.equal(noSex.iron, undefined);
  assert.equal(noSex.fiber, undefined);
  const teen = recommendedTargets({ gender: 'male', dob: '2010-01-01', weight_kg: 60 }, 2000, NOW);
  assert.equal(teen.calcium, undefined);
  assert.ok(teen.sodium);
});

test('no macro targets without a calorie goal, and no protein without a weight', () => {
  const noCal = recommendedTargets(man, null, NOW);
  assert.equal(noCal.fat, undefined);
  assert.equal(noCal.proteins, undefined);
  const noWeight = recommendedTargets({ gender: 'male', dob: '1988-10-07' }, 2000, NOW);
  assert.equal(noWeight.proteins, undefined);
  assert.ok(noWeight.fat);
});

test('target weight falls back to current weight for protein', () => {
  const t = recommendedTargets({ gender: 'male', dob: '1988-10-07', weight_kg: 100, activity: 'very_active' }, 2000, NOW);
  assert.equal(t.proteins.value, 180);
});

test('protein follows the activity level from setup, 0.8 g/kg (the RDA) when none is saved', () => {
  const p = (activity) => recommendedTargets({ weight_kg: 80, activity }, 2000, NOW).proteins.value;
  assert.equal(p('sedentary'), 64);
  assert.equal(p('light'), 80);
  assert.equal(p('moderate'), 96);
  assert.equal(p('active'), 128);
  assert.equal(p('very_active'), 144);
  assert.equal(p(undefined), 64);
  assert.equal(p('something-else'), 64);
  // Carbs take what protein leaves: 2000 - 64*4 - 67*9 = 1141 kcal = 285 g.
  assert.equal(recommendedTargets({ weight_kg: 80 }, 2000, NOW).carbohydrates.value, 285);
});

test('the setting defaults to off and is synced', () => {
  const s = read('../src/stores/settings.js');
  assert.match(s, /createSettingStore\('dailyTargetsEnabled', false\)/);
  assert.match(s, /'dailyTargetsEnabled'/);
});

test('the Diary uses explicit goals before recommendations, on the Nutrition Summary only', () => {
  const d = read('../src/routes/Diary.svelte');
  assert.match(d, /out\[id\] = \{ value: v, kind: g\.max != null \? 'max' : 'min' \}/);
  // The Overview card's macro goals stay the user's own goals.
  assert.match(d, /\$: protGoal  = _macroGoal\('proteins', \$currentDate\);/);
  assert.match(d, /\$: fatGoal   = _macroGoal\('fat', \$currentDate\);/);
  assert.doesNotMatch(d, /_recTargets\.(proteins|fat|carbohydrates)\?\.value/);
});

test('the Diary reads the profile again when one of its settings changes', () => {
  const d = read('../src/routes/Diary.svelte');
  assert.match(d, /addEventListener\('wl:setting', _onProfileSetting\)/);
  assert.match(d, /recommendedTargets\(_profileForTargets\(_profileRev, \$currentUser\), caloriesGoal\)/);
  // The account's birthday and sex (Profile) before setup's answers.
  assert.match(d, /gender: u\?\.gender \|\| DB\.getSetting\('gender', ''\), dob: u\?\.birthday \|\| DB\.getSetting\('dob', ''\)/);
  for (const k of ['gender', 'dob', 'height_cm', 'weight_kg', 'target_weight', 'activity']) assert.ok(d.includes(`'${k}'`), k);
});

test('sex is read in any case: Profile keeps Male / Female, setup male / female', () => {
  const t = recommendedTargets({ gender: 'Female', dob: '1996-05-01', weight_kg: 65 }, 2000, NOW);
  assert.equal(t.iron.value, 18);
  assert.equal(recommendedTargets({ gender: 'MALE', dob: '1988-10-07' }, 2000, NOW).iron.value, 8);
  assert.equal(recommendedTargets({ gender: 'Non-binary', dob: '1988-10-07' }, 2000, NOW).iron, undefined);
});

test('the Profile page edits the activity level the protein target reads', () => {
  const p = read('../src/routes/Profile.svelte');
  assert.match(p, /DB\.setSetting\('activity', activity\)/);
  assert.match(p, /scheduleSave\('activity', activity\)/);
  for (const a of ['sedentary', 'light', 'moderate', 'active', 'very_active']) assert.ok(p.includes(`'${a}'`), a);
});
