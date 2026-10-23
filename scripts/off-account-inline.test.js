/**
 * Share to OFF with no Open Food Facts login, or a wrong one, asks for it
 * inside the food editor (#284), as CookTrace does. It used to link away to
 * Settings > Food Sources.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('food editor: no login asks for it in place, then shares; a wrong login reopens it', () => {
  const src = read('../src/routes/FoodEditor.svelte');
  const start = src.indexOf('{#if offNeedsAccount}');
  const block = src.slice(start, src.indexOf('{/if}', start));
  assert.ok(start > 0, 'the no-account block exists');
  assert.doesNotMatch(block, /#\/settings/, 'it does not navigate away from the editor');
  assert.match(block, /<OffAccountInline\s+on:saved=\{\(\) => \{ offNeedsAccount = false; shareOrViewOnOFF\(\); \}\}/);
  assert.match(src, /if \(e\?\.kind === 'no_account' \|\| e\?\.kind === 'login'\) offNeedsAccount = true;/);
});

test('the inline fields save to the same settings as Settings > Food Sources', () => {
  const src = read('../src/components/foods/OffAccountInline.svelte');
  assert.match(src, /import \{ offUsername, offPassword \} from '\.\.\/\.\.\/stores\/settings\.js'/);
  assert.match(src, /offUsername\.set\(user\.trim\(\)\)/);
  assert.match(src, /offPassword\.set\(pass\)/);
  assert.doesNotMatch(src, /<form/, 'no nested form inside the editor');
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.ok(en.food_editor.off_share.need_account && en.food_editor.off_share.save_and_share);
  assert.equal(en.food_editor.off_share.open_settings, undefined, 'the unused link string is gone');
});
