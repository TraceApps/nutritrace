/**
 * sync-clock.js: whose edit is newer, on the server's clock.
 *
 * A phone stamps its edits with its own clock, which can be minutes slow or
 * fast. It also sends its clock when it talks to the server (client_now),
 * so its edit times are put right before they're compared. Used by the
 * Android sync push (routes/sync.js) and the diary routes (routes/diary.js:
 * the day's note, completion marks).
 *
 * Better still, the phone learns the server's clock from each reply and
 * stamps its edits on it as it makes them, so a clock put right between
 * an edit and its push doesn't matter. Those times end in "+00:00"
 * instead of "Z" (still plain UTC ISO 8601): already on the server's
 * clock, so the push-time offset is never added to them. Times the phone
 * made before it knew the server's clock end in "Z" and are set right as
 * before.
 */

// The phone's clock against the server's, from the time the phone sent
// (client_now) and the time the server received the request.
// known=false (compare and stamp as before) when it's missing, unreadable,
// or more than 30 days out, which no real clock is. Under 2 seconds is
// left at 0: that much is the request's own travel time, not the clock.
// Limits: the clock is read at the push, so a phone whose clock was put
// right between an offline edit and the push (it found the network time
// again) has that edit judged off by the correction; and a push that
// takes long to arrive (a slow upload) counts its travel time as clock.
const MAX_CLOCK_OFFSET_MS = 30 * 24 * 3600 * 1000;
const MIN_CLOCK_OFFSET_MS = 2000;
export function clientClock(clientNow, serverNow = Date.now()) {
  const t = typeof clientNow === 'string' ? parseUtc(clientNow) : NaN;
  if (!Number.isFinite(t)) return { known: false, offsetMs: 0 };
  const off = serverNow - t;
  if (Math.abs(off) > MAX_CLOCK_OFFSET_MS) return { known: false, offsetMs: 0 };
  return { known: true, offsetMs: Math.abs(off) < MIN_CLOCK_OFFSET_MS ? 0 : off };
}

// A time the phone already put on the server's clock.
export const onServerClock = ts => typeof ts === 'string' && /\+00:00$/.test(ts.trim());

// Timestamps arrive as ISO strings ('...Z') or SQLite's UTC
// 'YYYY-MM-DD HH:MM:SS'. Both are UTC; Date.parse would read the second
// as local time.
export function parseUtc(ts) {
  if (typeof ts !== 'string' || !ts) return NaN;
  let s = ts.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
  return Date.parse(s);
}

export const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

// An edit's time on the server's clock: as sent when the phone already
// put it there, else set right by the push-time offset. One that can't be
// right (later than now, or before the row was made) counts as now.
function _onServer(incoming, offsetMs, { serverNow, createdAt } = {}) {
  let a = parseUtc(incoming);
  if (!Number.isFinite(a)) return NaN;
  if (!onServerClock(incoming)) a += offsetMs;
  if (serverNow != null) {
    const made = parseUtc(createdAt);
    if (a > serverNow + 1000 || (Number.isFinite(made) && Math.floor(a / 1000) < Math.floor(made / 1000))) a = serverNow;
  }
  return a;
}

// Whether an edit is at least as new as the server's. Whole seconds, as
// the server stamps rows (datetime('now')), the way the old string compare
// worked. `opts` ({ serverNow, createdAt }) turns on the sanity bound.
export function pushWins(incoming, existing, offsetMs = 0, opts = undefined) {
  const a = _onServer(incoming, offsetMs, opts), b = parseUtc(existing);
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return Math.floor(a / 1000) >= Math.floor(b / 1000);
}

// The time a winning edit stores: when it was made, on the server's
// clock, so a later edit compares against the edit and not against when
// it happened to arrive. Never later than now, nor before the row was
// made. Without a usable clock (or edit time), the time it arrived, as
// before.
export function editStamp(incoming, clock, serverNow = Date.now(), { createdAt } = {}) {
  const a0 = parseUtc(incoming);
  if (!Number.isFinite(a0) || (!clock?.known && !onServerClock(incoming))) return sqlTime(serverNow);
  return sqlTime(Math.min(_onServer(incoming, clock?.offsetMs || 0, { serverNow, createdAt }), serverNow));
}

/**
 * The day's note after an edit. `incoming` is { has, notes, at }: whether
 * the request carries a note at all, the note, and when it was edited (on
 * the sender's clock; absent for an edit made just now, as the web makes
 * them). The newer edit wins, a cleared note included. A note that
 * doesn't change leaves its time alone. Returns { notes, at }; `at` is
 * the notes_updated_at to store.
 */
export function resolveNote(existing, incoming, clock, serverNow = Date.now()) {
  const cur = existing?.notes ?? null;
  const curAt = existing?.notes_updated_at ?? null;
  if (!incoming?.has) return { notes: cur, at: curAt };
  const next = (typeof incoming.notes === 'string' && incoming.notes.trim()) ? incoming.notes : null;
  if (next === cur) return { notes: cur, at: curAt };
  if (!Number.isFinite(parseUtc(incoming.at))) return { notes: next, at: sqlTime(serverNow) };
  // A note the server has, or had: its time. A day that never had one has
  // nothing to lose.
  const theirs = existing && (cur != null || curAt) ? (curAt || existing.updated_at) : null;
  if (theirs && !pushWins(incoming.at, theirs, clock?.offsetMs || 0, { serverNow })) return { notes: cur, at: curAt };
  return { notes: next, at: editStamp(incoming.at, clock, serverNow) };
}
