/**
 * #224: Settings, Diary, Default Field picks which box the add and edit
 * sheets put the cursor in: Number of Servings (default) or Serving Size.
 * #170 made them focus the first box, which is Serving Size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultFieldInput, focusDefaultField } from '../src/lib/default-field.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function fakeSheet(fields) {
  const inputs = fields.map((f) => ({
    field: f, focused: false, selected: false,
    focus() { this.focused = true; }, select() { this.selected = true; },
  }));
  return {
    inputs,
    querySelector(sel) {
      const m = sel.match(/data-field="(\w+)"/);
      if (m) return inputs.find((i) => i.field === m[1]) || null;
      return inputs[0] || null;   // first number box
    },
  };
}

test('Number of Servings is the default', () => {
  const sheet = fakeSheet(['portion', 'servings']);
  assert.equal(defaultFieldInput(sheet, undefined).field, 'servings');
  assert.equal(defaultFieldInput(sheet, 'servings').field, 'servings');
});

test('Serving Size when chosen', () => {
  const sheet = fakeSheet(['portion', 'servings']);
  const el = focusDefaultField(sheet, 'portion');
  assert.equal(el.field, 'portion');
  assert.equal(el.focused, true);
  assert.equal(el.selected, true, 'the value is selected so typing replaces it');
});

test('an unknown value falls back to Number of Servings', () => {
  assert.equal(defaultFieldInput(fakeSheet(['portion', 'servings']), 'grams').field, 'servings');
});

test('a sheet without either box uses its first number box (Quick Calories)', () => {
  const sheet = fakeSheet(['kcal']);
  assert.equal(focusDefaultField(sheet, 'servings').field, 'kcal');
});

test('no sheet, no crash', () => {
  assert.equal(focusDefaultField(null, 'servings'), null);
});

test('the setting is synced with the account and defaults to Number of Servings', () => {
  const s = read('../src/stores/settings.js');
  assert.match(s, /'diaryDefaultField',/);
  assert.match(s, /createSettingStore\('diaryDefaultField', 'servings'\)/);
});

test('all three sheets mark both boxes and use the setting', () => {
  const foods = read('../src/routes/Foods.svelte');
  const diary = read('../src/routes/Diary.svelte');
  // Single add sheet, multi-food add sheet, Diary edit sheet.
  assert.equal((foods.match(/data-field="portion"/g) || []).length, 2);
  assert.equal((foods.match(/data-field="servings"/g) || []).length, 2);
  assert.equal((diary.match(/data-field="portion"/g) || []).length, 1);
  assert.equal((diary.match(/data-field="servings"/g) || []).length, 1);
  assert.match(foods, /\$diaryDefaultField === 'portion' \? _qtyPromptPortionEl : \(_qtyPromptServingsEl \|\| _qtyPromptPortionEl\)/);
  assert.match(foods, /focusDefaultField\(_multiPortionSheetEl, \$diaryDefaultField\)/);
  assert.match(diary, /focusDefaultField\(_editSheetEl, \$diaryDefaultField\)/);
});

test('Settings shows it with a description and finds it by search', () => {
  const page = read('../src/routes/settings/Diary.svelte');
  assert.match(page, /settings_diary\.default_field'\)\} desc=\{\$_\('settings_diary\.default_field_desc'\)\}/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.settings_diary.default_field, 'Default Field');
  assert.ok(en.settings_diary.default_field_desc.length > 20);
  assert.match(read('../src/routes/Settings.svelte'), /'default field','cursor'/);
});
