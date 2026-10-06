/**
 * The weekly summary email reads the diary's real columns.
 *
 * It asked for a `data` column the diary table never had, so the query threw
 * and, since the error was only logged, no weekly summary email was ever
 * sent. Verified against the server with a mail catcher: the email now
 * arrives, with the averages a two-day diary works out to.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const email = readFileSync(new URL('../server/email.js', import.meta.url), 'utf8');
const db = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
const fn = email.slice(email.indexOf('export async function sendWeeklySummaryEmail'));

test('the diary table has items and water, and no data column', () => {
  const create = db.slice(db.indexOf('CREATE TABLE IF NOT EXISTS diary'), db.indexOf(');', db.indexOf('CREATE TABLE IF NOT EXISTS diary')));
  assert.match(create, /\bitems\b/);
  assert.match(create, /\bwater\b/);
  assert.doesNotMatch(create, /\bdata\b/);
});

test('the summary reads those columns', () => {
  assert.match(fn, /SELECT items, water, body_stats FROM diary WHERE user_id=\? AND date >= \? AND date <= \? AND deleted_at IS NULL ORDER BY date ASC/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}\n')), /row\.data|SELECT data FROM diary/);
});
