/**
 * setting-merge.js — one setting meets the one the server has, by when each
 * was edited.
 *
 * A setting is a row of one value, so "the newer edit stays" is decided per
 * row. routes/sync.js (a phone's push) and routes/settings.js (the web, a
 * template, a reset) apply changes through this, with one set of rules:
 *
 *   - times are milliseconds: two edits made in the same second still have
 *     an order, and it is the one the device recorded;
 *   - a tie goes to the arriving edit;
 *   - a delete wins a tie against a change;
 *   - an edit brings back a deleted setting only when it is strictly later;
 *   - a delete made later than an earlier delete moves the tombstone, so an
 *     edit between the two still loses;
 *   - a delete of a setting the server has never had is a no-op (there is
 *     nothing to protect here; the settings it removes were never stored).
 *
 * A losing edit still moves updated_at (the pull's cursor), so a phone's
 * next pull brings the winner back.
 *
 * A merged write sets field_times itself. In a tie its text can stay exactly
 * as it was while the value changes; the field-time triggers (lib/field-sync.js)
 * read that as a write that did not set them and would stamp the request's
 * time over the edit's. The value write below leaves a transient marker in
 * field_times for that one statement, so the trigger sees the writer's own
 * times and leaves them alone.
 */
import { createdTimes, fieldTime, instantMs, isoTime, rowTimes } from './field-sync.js';

/** Whether an edit made at `incoming` is the newer one over `here`. A tie
 *  goes to the edit; a missing `here` has nothing to lose to. */
export function settingEditBeats(incoming, here) {
  const a = instantMs(incoming), b = instantMs(here);
  if (!Number.isFinite(b)) return true;
  if (!Number.isFinite(a)) return false;
  return a >= b;
}

/** Whether a delete made at `at` beats a change made at `latest`. A tie goes
 *  to the delete. */
export function settingDeleteBeats(at, latest) {
  const a = instantMs(at), b = instantMs(latest);
  if (!Number.isFinite(b)) return true;
  if (!Number.isFinite(a)) return false;
  return a >= b;
}

/** Whether an edit made at `at` brings back a setting deleted at
 *  `deletedAt`. Only strictly later does; a tie keeps the delete. */
export function settingEditRevives(at, deletedAt) {
  const a = instantMs(at), d = instantMs(deletedAt);
  if (!Number.isFinite(d)) return true;
  if (!Number.isFinite(a)) return false;
  return a > d;
}

const _ms = value => {
  const ms = instantMs(value);
  return Number.isFinite(ms) ? ms : null;
};

/** A row's time for one field: its own stamp, else its base (a row made
 *  before the times began counts from its last write). */
function _timeOf(times, field, existing) {
  const own = fieldTime(times, field);
  if (Number.isFinite(own)) return own;
  return existing ? _ms(existing.updated_at) : null;
}

/**
 * Write a setting's value and field_times. A tie can leave the field_times
 * text exactly as it was while the value changes; the field-time trigger
 * would read that as a write that did not set them and stamp the request's
 * time over the edit's. A transient `_w` key makes the text differ for that
 * one statement (removed straight after; it never lasts past the write).
 */
function _writeValue(db, userId, key, value, nextText, existing) {
  const run = () => db.prepare(
    `UPDATE user_settings SET value = ?, field_times = ?, updated_at = datetime('now'), deleted_at = NULL
      WHERE user_id = ? AND key = ?`
  ).run(value, nextText, userId, key);
  if (!existing || existing.field_times !== nextText) return run();
  db.prepare(
    `UPDATE user_settings SET field_times = json_set(field_times, '$._w', 1) WHERE user_id = ? AND key = ?`
  ).run(userId, key);
  try { return run(); } finally {
    db.prepare(
      `UPDATE user_settings SET field_times = json_remove(field_times, '$._w') WHERE user_id = ? AND key = ?`
    ).run(userId, key);
  }
}

// A losing edit still moves updated_at (the pull's cursor), so the phone's
// next pull brings the newer value back — as the sync push has always done.
const _touch = (db, userId, key) => db.prepare(
  `UPDATE user_settings SET updated_at = datetime('now') WHERE user_id = ? AND key = ?`
).run(userId, key);

/**
 * Apply one setting's edit and write the row.
 *
 * `edit` is `{ value }` with the stored text, or `{ deleted: true }`. `at` is
 * when the edit was made, on the server's clock (ms or a time).
 *
 * `mayRevive` false is a copy a client has had for a while, with no time of
 * its own: it never brings a deleted setting back (a pushed row whose time
 * can't be read), as the sync push has always ruled.
 *
 * Returns `{ kept, inserted, deleted, revived, times }`: `kept` says whether
 * this edit is the one the row now holds.
 */
export function writeSetting(db, userId, key, edit, at, { mayRevive = true } = {}) {
  const existing = db.prepare(
    'SELECT * FROM user_settings WHERE user_id = ? AND key = ?'
  ).get(userId, key) || null;
  const times = existing ? rowTimes(existing) : {};
  const stamp = isoTime(_ms(at) ?? Date.now());
  const valueAt = existing ? _timeOf(times, 'value', existing) : null;
  const deletedAt = existing
    ? (_ms(times.deleted_at) ?? _ms(existing.deleted_at))
    : null;

  if (edit.deleted) {
    // Nothing stored here: nothing to protect, so no tombstone is made. The
    // contract is that a delete only ever removes what the server has; a
    // later edit of the same key creates it as usual.
    if (!existing) return { kept: false, times };
    if (existing.deleted_at) {
      // A later delete moves the tombstone forward: an edit made between
      // the old and the new delete time must still lose.
      if (!settingDeleteBeats(stamp, deletedAt)) return { kept: false, times };
      const next = { ...times, deleted_at: stamp };
      db.prepare(
        `UPDATE user_settings SET deleted_at = datetime('now'), field_times = ?, updated_at = datetime('now')
          WHERE user_id = ? AND key = ?`
      ).run(JSON.stringify(next), userId, key);
      return { kept: true, deleted: true, times: next };
    }
    const latest = Math.max(valueAt ?? -Infinity, deletedAt ?? -Infinity);
    if (!settingDeleteBeats(stamp, Number.isFinite(latest) ? latest : null)) {
      _touch(db, userId, key);
      return { kept: false, times };
    }
    const next = { ...times, deleted_at: stamp };
    db.prepare(
      `UPDATE user_settings SET deleted_at = datetime('now'), field_times = ?, updated_at = datetime('now')
        WHERE user_id = ? AND key = ?`
    ).run(JSON.stringify(next), userId, key);
    return { kept: true, deleted: true, times: next };
  }

  if (!existing) {
    const next = createdTimes(stamp);
    db.prepare(
      `INSERT INTO user_settings (user_id, key, value, field_times, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(userId, key, edit.value, JSON.stringify(next));
    return { kept: true, inserted: true, times: next };
  }

  if (existing.deleted_at) {
    if (!mayRevive || !settingEditRevives(stamp, deletedAt)) {
      _touch(db, userId, key);
      return { kept: false, times };
    }
    const next = { ...times, value: stamp };
    _writeValue(db, userId, key, edit.value, JSON.stringify(next), existing);
    return { kept: true, revived: true, times: next };
  }

  if (!settingEditBeats(stamp, valueAt)) {
    _touch(db, userId, key);
    return { kept: false, times };
  }
  const next = { ...times, value: stamp };
  _writeValue(db, userId, key, edit.value, JSON.stringify(next), existing);
  return { kept: true, applied: true, times: next };
}
