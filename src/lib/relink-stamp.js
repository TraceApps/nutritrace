/**
 * relink-stamp.js: the edit time of a link filled in.
 *
 * The Android app fills in the server id of a food or meal a recipe's
 * ingredient (or a diary item) names by the phone's own id, once that row
 * has gone up (db-native.js dbLinkDiaryItems). That is bookkeeping, not
 * something anyone changed, so it must not count as an edit made now: the
 * server judges a pushed row by its edit time, and one made now beats a
 * delete made on another device since the phone last heard (the recipe
 * comes back), and beats a newer edit of the same field made there.
 *
 * So a link takes the time the row already had, moved by a millisecond. The
 * move is only so the row's updated_at differs from the copy a push in
 * flight holds (dbMarkSynced leaves a row that changed meanwhile pending,
 * and the link goes up with the next push); it stays in the same second,
 * because the server compares whole seconds (lib/field-sync.js), so the
 * link loses to everything the row's last edit lost to, and ties go as that
 * edit's did: to a delete.
 *
 * The time keeps the clock it was on. A phone-made stamp ("Z") is set right
 * by the server against the clock it reads at the push, as every edit made
 * before the phone learned the server's clock is. A stamp on the server's
 * clock ("+00:00", or the server's own 'YYYY-MM-DD HH:MM:SS' that a pull
 * brings) is sent as "+00:00", which the server takes as it is: sent bare,
 * the server would read it as the phone's and shift it by the phone's clock
 * error.
 */
import { instantMs } from './field-sync.js';

// The earliest time there is, for a row with no readable time (none is: a row's
// updated_at has a default and the server always sends one). The phone takes
// it as the oldest there is; a server counts an edit older than its row as
// made when it arrives, which is what a link was before.
const EARLIEST = '1970-01-01T00:00:00.001Z';

/**
 * @param prev       the time the row had (updated_at, or a field's edit time)
 * @param offsetMs   this phone's clock against the server's, as learned
 * @param notBefore  ms on the server's clock: the row was made on the server
 *                   then (a push that made it), and the server treats an edit
 *                   from before its row existed as made now, so a link on a
 *                   row made in this push can't go earlier than that
 */
export function relinkStamp(prev, { offsetMs = 0, notBefore = NaN } = {}) {
  const ms = instantMs(prev);
  if (!Number.isFinite(ms)) return EARLIEST;
  const onServer = !/z$/i.test(String(prev).trim());
  let base = ms, server = onServer;
  if (Number.isFinite(notBefore) && notBefore > (onServer ? ms : ms + (offsetMs || 0))) { base = notBefore; server = true; }
  // One millisecond on, or back if that would be the next second.
  const out = new Date(base % 1000 === 999 ? base - 1 : base + 1).toISOString();
  return server ? out.replace(/Z$/, '+00:00') : out;
}
