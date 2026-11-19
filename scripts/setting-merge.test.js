/**
 * One setting meets the one the server has, by when each was edited
 * (server/lib/setting-merge.js). The rule the direct settings routes and a
 * phone's sync push share:
 *
 *   - times are milliseconds, so two edits in the same second still have an
 *     order;
 *   - a tie goes to the arriving edit;
 *   - a delete wins a tie, and an edit brings a deleted setting back only
 *     when it is strictly later;
 *   - a losing edit only moves the row's updated_at, so the next pull brings
 *     the winner back.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test, { after, before } from 'node:test';

let ready = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); ready = true; } catch { /* not built */ }
const skip = t => {
  if (!ready) {
    t.skip('better-sqlite3 is not built for this Node');
    return true;
  }
  return false;
};

// The database is only opened when better-sqlite3 is here: importing
// server/db.js otherwise throws and the whole file would fail instead of
// skipping (as every other native test does).
const temp = ready ? mkdtempSync(join(tmpdir(), 'nt-setting-merge-')) : null;
if (ready) {
  process.env.DB_PATH = join(temp, 'test.db');
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'setting-merge-test-only';
}

let db = null, writeSetting = null;
if (ready) {
  ({ default: db } = await import('../server/db.js'));
  ({ writeSetting } = await import('../server/lib/setting-merge.js'));
}

let userId;
const row = key => db.prepare(
  'SELECT value, deleted_at, field_times, updated_at FROM user_settings WHERE user_id = ? AND key = ?'
).get(userId, key);
const valueOf = key => row(key)?.value;
const timesOf = key => JSON.parse(row(key)?.field_times || '{}');

before(() => {
  if (!ready) return;
  userId = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'admin')")
    .run('setting-merge-test').lastInsertRowid);
});

after(() => {
  try { db?.close(); } catch {}
  if (temp) rmSync(temp, { recursive: true, force: true });
});

test('the newer edit stays, and one inside the same second still has an order', (t) => {
  if (skip(t)) return;
  const base = Date.parse('2026-10-01T10:00:00.000Z');
  writeSetting(db, userId, 'units', { value: 'first' }, base + 100);
  writeSetting(db, userId, 'units', { value: 'second' }, base + 900);
  assert.equal(valueOf('units'), 'second');
  // The older millisecond arrives after the newer one: it loses.
  const written = writeSetting(db, userId, 'units', { value: 'late-old', }, base + 500);
  assert.equal(written.kept, false);
  assert.equal(valueOf('units'), 'second');
  assert.equal(Date.parse(timesOf('units').value), base + 900);
});

test('a losing edit only moves updated_at, so the next pull brings the winner back', (t) => {
  if (skip(t)) return;
  const base = Date.parse('2026-10-02T10:00:00.000Z');
  writeSetting(db, userId, 'theme', { value: 'dark' }, base + 1000);
  // Put the row's updated_at in the past: the move must be visible even
  // inside the same second (datetime('now') counts whole seconds, so a
  // plain ">= before" would pass without the losing edit touching anything).
  db.prepare(`UPDATE user_settings SET updated_at = '2000-01-01 00:00:00' WHERE user_id = ? AND key = 'theme'`).run(userId);
  writeSetting(db, userId, 'theme', { value: 'light' }, base + 500);
  assert.equal(valueOf('theme'), 'dark');
  assert.notEqual(row('theme').updated_at, '2000-01-01 00:00:00', 'the row still moved for the pull cursor');
});

test('an exact tie keeps the edit’s own time, and the next millisecond wins', (t) => {
  if (skip(t)) return;
  const base = Date.parse('2026-10-05T10:00:00.000Z');
  writeSetting(db, userId, 'tieUnit', { value: 'old' }, base - 1000);
  // The first edit at `base` stamps field_times.value = base.
  writeSetting(db, userId, 'tieUnit', { value: 'a' }, base);
  // Same millisecond, different value: the arriving edit wins, and now its
  // field_times text is exactly the one already stored.
  const tied = writeSetting(db, userId, 'tieUnit', { value: 'b' }, base);
  assert.equal(tied.kept, true);
  assert.equal(valueOf('tieUnit'), 'b');
  // The trigger must not stamp the request’s time over the tie’s, or this
  // later edit (one millisecond after the tie) would lose.
  assert.equal(Date.parse(timesOf('tieUnit').value), base, 'the tie keeps its own time');
  const later = writeSetting(db, userId, 'tieUnit', { value: 'c' }, base + 1);
  assert.equal(later.kept, true);
  assert.equal(valueOf('tieUnit'), 'c');
});

test('a delete wins a tie, and an edit brings the setting back only when strictly later', (t) => {
  if (skip(t)) return;
  const base = Date.parse('2026-10-03T10:00:00.000Z');
  writeSetting(db, userId, 'waterUnit', { value: 'ml' }, base);
  // Same millisecond as the value: the delete wins.
  const tied = writeSetting(db, userId, 'waterUnit', { deleted: true }, base);
  assert.equal(tied.kept, true);
  assert.ok(row('waterUnit').deleted_at);
  // An edit at the delete's instant does not bring it back.
  const same = writeSetting(db, userId, 'waterUnit', { value: 'l' }, base);
  assert.equal(same.kept, false);
  assert.ok(row('waterUnit').deleted_at);
  // One millisecond later does.
  const later = writeSetting(db, userId, 'waterUnit', { value: 'oz' }, base + 1);
  assert.equal(later.kept, true);
  assert.equal(valueOf('waterUnit'), 'oz');
  assert.equal(row('waterUnit').deleted_at, null);
});

test('a later delete moves an already-deleted setting’s tombstone', (t) => {
  if (skip(t)) return;
  const base = Date.parse('2026-10-04T10:00:00.000Z');
  writeSetting(db, userId, 'tempUnit', { value: 'C' }, base);
  writeSetting(db, userId, 'tempUnit', { deleted: true }, base + 1000);
  assert.equal(Date.parse(timesOf('tempUnit').deleted_at), base + 1000);
  // A reset, or a phone’s later delete, moves the tombstone forward.
  writeSetting(db, userId, 'tempUnit', { deleted: true }, base + 5000);
  assert.equal(Date.parse(timesOf('tempUnit').deleted_at), base + 5000);
  // An edit between the two deletes stays behind the newer one.
  const old = writeSetting(db, userId, 'tempUnit', { value: 'F' }, base + 2000);
  assert.equal(old.kept, false);
  assert.ok(row('tempUnit').deleted_at);
  // A later delete than the tombstone’s cannot move it backwards.
  writeSetting(db, userId, 'tempUnit', { deleted: true }, base + 3000);
  assert.equal(Date.parse(timesOf('tempUnit').deleted_at), base + 5000);
  // Strictly after the tombstone brings it back.
  const back = writeSetting(db, userId, 'tempUnit', { value: 'K' }, base + 5001);
  assert.equal(back.kept, true);
  assert.equal(valueOf('tempUnit'), 'K');
});

test('deleting a setting the server never had stores nothing', (t) => {
  if (skip(t)) return;
  const base = Date.parse('2026-10-06T10:00:00.000Z');
  const gone = writeSetting(db, userId, 'neverWasHere', { deleted: true }, base);
  assert.equal(gone.kept, false);
  assert.equal(row('neverWasHere'), undefined, 'no tombstone row is made');
  // There is no delete to beat: a later edit creates the setting as usual,
  // even one made before the no-op delete’s time.
  const made = writeSetting(db, userId, 'neverWasHere', { value: 'here' }, base - 1000);
  assert.equal(made.kept, true);
  assert.equal(valueOf('neverWasHere'), 'here');
});
