/**
 * #321: activity templates vanished from the Add Activity picker 90 days
 * after the entry they were saved on, and a template saved again offered
 * its oldest version (rows came oldest first and the first of each name won).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activitySuggestions } from '../src/lib/activity-suggestions.js';

const rows = [
  { id: 1, date: '2026-08-04', name: 'Spin class', duration_min: 45, is_template: 1 },
  { id: 2, date: '2026-09-13', name: 'Rowing', duration_min: 30, is_template: 1 },
  { id: 3, date: '2026-11-07', name: 'Rowing', duration_min: 40, is_template: 1 },
  { id: 4, date: '2026-11-09', name: 'walk ', duration_min: 30, is_template: 0 },
  { id: 5, date: '2026-11-10', name: 'Walk', duration_min: 20, is_template: 0 },
  { id: 6, date: '2026-07-01', name: 'Old hike', is_template: 0 },
];

test('a template is offered however old it is', () => {
  const { templates } = activitySuggestions(rows, { since: '2026-08-14' });
  assert.deepEqual(templates.map(t => t.name), ['Rowing', 'Spin class']);
});

test("a template saved more than once offers its newest version", () => {
  const { templates } = activitySuggestions(rows, { since: '2026-08-14' });
  assert.equal(templates.find(t => t.name === 'Rowing').duration_min, 40);
});

test('past entries: last 90 days only, newest first, one per name ignoring case', () => {
  const { pastNames } = activitySuggestions(rows, { since: '2026-08-14' });
  assert.deepEqual(pastNames, ['Walk', 'Rowing']);
});

test('the caps keep the newest', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i, date: `2026-10-${String(i + 1).padStart(2, '0')}`, name: `T${i}`, is_template: 1 }));
  const { templates } = activitySuggestions(many, { maxTemplates: 3 });
  assert.deepEqual(templates.map(t => t.name), ['T19', 'T18', 'T17']);
});

test('nothing, or rows without a name, give empty lists', () => {
  assert.deepEqual(activitySuggestions(null), { pastNames: [], templates: [] });
  assert.deepEqual(activitySuggestions([{ date: '2026-11-01', name: ' ', is_template: 1 }]), { pastNames: [], templates: [] });
});

test('the sheet reads the whole history for templates', () => {
  const s = readFileSync(new URL('../src/components/diary/AddActivitySheet.svelte', import.meta.url), 'utf8');
  assert.match(s, /getActivityRange\('1900-01-01', '2999-12-31'\)/);
  assert.match(s, /activitySuggestions\(rows, \{ since: fmt\(past\) \}\)/);
});
