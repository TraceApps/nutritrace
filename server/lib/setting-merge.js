/**
 * setting-merge.js — one setting meets the one the server has, by when each
 * was edited.
 *
 * A setting is a row of one value, so "the newer edit stays" is decided per
 * row. The goal history's per-field merge is the same decision with the
 * field named. Both use the rules here, so the live goals and the goals of a
 * past day can never disagree about which edit won:
 *
 *   - times are milliseconds: two edits made in the same second still have
 *     an order, and it is the one the device recorded;
 *   - a tie goes to the arriving edit;
 *   - a delete wins a tie against a change;
 *   - an edit brings back a deleted setting only when it is strictly later.
 *
 * routes/sync.js (a phone's push), routes/settings.js (the web, a template,
 * a reset) and lib/goal-history.js (the day a change was for) all apply
 * changes through this.
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
 * can't be read), as the sync push has always ruled. `restamp` moves an
 * already-deleted setting's delete time to this one (a reset clears
 * everything as of its moment, including what was deleted before).
 *
 * Returns `{ kept, inserted, deleted, revived, times }`: `kept` says whether
 * this edit is the one the row now holds.
 */
export function writeSetting(db, userId, key, edit, at, { mayRevive = true, restamp = false } = {}) {
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
    if (!existing) return { kept: false, times };
    if (existing.deleted_at) {
      if (!restamp || !settingDeleteBeats(stamp, deletedAt)) return { kept: false, times };
      const next = { ...times, deleted_at: stamp };
      db.prepare(
        `UPDATE user_settings SET field_times = ?, updated_at = datetime('now')
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
    db.prepare(
      `UPDATE user_settings SET value = ?, field_times = ?, updated_at = datetime('now'), deleted_at = NULL
        WHERE user_id = ? AND key = ?`
    ).run(edit.value, JSON.stringify(next), userId, key);
    return { kept: true, revived: true, times: next };
  }

  if (!settingEditBeats(stamp, valueAt)) {
    _touch(db, userId, key);
    return { kept: false, times };
  }
  const next = { ...times, value: stamp };
  db.prepare(
    `UPDATE user_settings SET value = ?, field_times = ?, updated_at = datetime('now'), deleted_at = NULL
      WHERE user_id = ? AND key = ?`
  ).run(edit.value, JSON.stringify(next), userId, key);
  return { kept: true, applied: true, times: next };
}
