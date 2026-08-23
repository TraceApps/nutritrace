/**
 * Static-analysis tests for POST /api/v1/activity wiring (#154).
 *
 * Guards against accidental unmounting of the route, missing scope
 * registration, or the requireScope check being dropped from the
 * handler. End-to-end verification is done by running the server and
 * POSTing with a real bearer token.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const v1Index    = readFileSync(new URL('../server/routes/api/v1/index.js', import.meta.url), 'utf8');
const activityJs = readFileSync(new URL('../server/routes/api/v1/activity.js', import.meta.url), 'utf8');
const apiTokens  = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');

test('v1 index imports and mounts the activity router at /activity', () => {
  assert.match(v1Index, /import activityRouter[\s\S]*from '\.\/activity\.js'/);
  assert.match(v1Index, /router\.use\('\/activity',\s*activityRouter\)/);
});

test('write:activity scope is registered in KNOWN_SCOPES', () => {
  assert.match(apiTokens, /'write:activity'/);
});

test('write:activity has a SCOPE_DESCRIPTIONS entry so the Settings UI can label it', () => {
  assert.match(apiTokens, /'write:activity':\s*"[^"]+"/);
});

test('POST /api/v1/activity requires the write:activity scope', () => {
  assert.match(activityJs, /router\.post\('\/',\s*requireScope\('write:activity'\)/);
});

test('POST /api/v1/activity validates required fields', () => {
  assert.match(activityJs, /bad_date/);
  assert.match(activityJs, /bad_name/);
  assert.match(activityJs, /bad_kcal/);
});

test('POST /api/v1/activity writes into activity_log (the diary Activity table)', () => {
  assert.match(activityJs, /INSERT INTO activity_log/);
});

test('POST /api/v1/activity supports idempotency via external_id', () => {
  assert.match(activityJs, /external_id/);
  assert.match(activityJs, /UPDATE activity_log/);
  assert.match(activityJs, /sourceValue/);
});

test('POST /api/v1/activity does NOT write to workouts or wellness_data (those are /workouts territory)', () => {
  assert.doesNotMatch(activityJs, /INSERT INTO workouts/);
  assert.doesNotMatch(activityJs, /INSERT INTO wellness_data/);
});
