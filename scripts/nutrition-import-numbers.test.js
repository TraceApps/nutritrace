/**
 * Spreadsheet exports keep the displayed value, so a column with a thousands
 * format writes "1,150". That is 1150, not 1.15; "1,5" stays a decimal comma.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber } from '../server/lib/nutrition-import/common.js';

test('a comma before groups of three digits separates thousands', () => {
  assert.equal(parseNumber('1,150'), 1150);
  assert.equal(parseNumber('12,000'), 12000);
  assert.equal(parseNumber('1,250.5'), 1250.5);
});

test('a lone comma with one or two decimals is a decimal comma', () => {
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber('12,25'), 12.25);
  assert.equal(parseNumber('0,125'), 0.125);
});
