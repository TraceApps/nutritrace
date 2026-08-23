import { randomUUID } from 'crypto';

// Per-item merge for diary items and water entries (Option C, 2026-08-11).
//
// Prior behavior: PUT /api/diary/:date and POST /api/sync/push replaced the
// row's items and water arrays wholesale. Any client whose local copy had
// gone stale (mobile SQLite reset, cache truncated, race with a concurrent
// write) would push its empty or truncated list and silently wipe the
// server's real data. See project_nutritrace_diary_persist_gap for the
// 2026-07-23 and 2026-08-11 incidents that motivated this module.
//
// New behavior: every item and every water entry has a client-generated
// uuid. Deletions are represented as explicit tombstones on both wire
// (deleted_uuids on write) and disk (diary_tombstones table). The server
// merges rather than replaces:
//
//   - Server items whose uuid is NOT in the client's list AND NOT in
//     the client's deleted_uuids are PRESERVED. This is the safe default
//     that eliminates the wholesale-wipe bug.
//   - Server items whose uuid IS in a tombstone (existing or new) are
//     DROPPED.
//   - Client items whose uuid is new to the server are ADDED.
//   - Client items whose uuid matches an existing server item are treated
//     as an update: whichever side has the later updatedAt / addedAt wins.
//
// Deletion is destructive: a tombstone on either side beats a live copy on
// the other side. Consistent with how virtually every sync system resolves
// edit-vs-delete races.
//
// All functions here are pure (no db, no I/O). Callers wire in the current
// server state, the incoming client payload, and any prior tombstones, and
// get back a merged array plus the new tombstones to persist.

/**
 * Return an ISO-comparable string extracted from an item/water entry's
 * modification timestamps. `updatedAt` takes precedence (an item that was
 * edited after being added carries a later modification), then falls back
 * to `addedAt` for un-edited items, then empty string for legacy items
 * without any timestamp (they lose any tie against a timestamped entry,
 * which is the safe direction).
 */
function _tsOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return String(entry.updatedAt || entry.addedAt || '');
}

/**
 * Deduplicate a list against a tombstone set and against itself.
 * Preserves insertion order; on uuid collision, keeps whichever entry
 * has the later `_tsOf` timestamp.
 */
function _dedupe(entries, tombstoneSet) {
  const byUuid = new Map();
  for (let entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    let uuid = entry.uuid;
    if (!uuid || typeof uuid !== 'string') {
      uuid = randomUUID();
      entry = { ...entry, uuid };
    }
    if (tombstoneSet.has(uuid)) continue;
    const existing = byUuid.get(uuid);
    if (!existing || _tsOf(entry) >= _tsOf(existing)) {
      byUuid.set(uuid, entry);
    }
  }
  return Array.from(byUuid.values());
}

/**
 * Core merge routine, shared by items and water.
 *
 * @param {Array} serverEntries - the row's current entries (post-parse).
 * @param {Array} clientEntries - the client's incoming entries.
 * @param {string[]} deletedUuids - uuids the client is deleting this write.
 * @param {string[]} tombstoneUuids - uuids already tombstoned server-side.
 * @returns {{merged: Array, newTombstoneUuids: string[]}}
 */
export function mergeEntries(serverEntries, clientEntries, deletedUuids, tombstoneUuids) {
  const server = Array.isArray(serverEntries) ? serverEntries : [];
  const client = Array.isArray(clientEntries) ? clientEntries : [];
  const deleted = Array.isArray(deletedUuids) ? deletedUuids.filter(x => typeof x === 'string' && x) : [];
  const priorTombstones = Array.isArray(tombstoneUuids) ? tombstoneUuids : [];

  // Union of every uuid that is tombstoned (already on disk) or being
  // tombstoned this write. Anything in this set stays out of the merged
  // output regardless of who sent it.
  const tombstoneSet = new Set([...priorTombstones, ...deleted]);

  // Start from server state; any legacy item lacking a uuid gets one now
  // (defense in depth — the startup backfill migration should have caught
  // these, but a merge under partial-migration or during a hot rollout
  // must still succeed).
  const serverDeduped = _dedupe(server, tombstoneSet);
  const serverByUuid = new Map(serverDeduped.map(e => [e.uuid, e]));

  // Apply client entries: add if new, replace if newer, drop if tombstoned.
  for (let entry of client) {
    if (!entry || typeof entry !== 'object') continue;
    if (!entry.uuid || typeof entry.uuid !== 'string') {
      entry = { ...entry, uuid: randomUUID() };
    }
    if (tombstoneSet.has(entry.uuid)) continue;
    const existing = serverByUuid.get(entry.uuid);
    if (!existing || _tsOf(entry) >= _tsOf(existing)) {
      serverByUuid.set(entry.uuid, entry);
    }
    // else: server has a strictly newer copy, keep it.
  }

  return {
    merged: Array.from(serverByUuid.values()),
    // Only uuids that weren't already tombstoned server-side count as NEW
    // tombstones to persist. The caller uses this to write to
    // diary_tombstones with INSERT OR IGNORE (safe either way).
    newTombstoneUuids: deleted.filter(u => !priorTombstones.includes(u)),
  };
}

/**
 * Ensure every entry in `list` has a uuid, mutating the copy (not the
 * caller's array). Idempotent. Used on server-side reads to guarantee any
 * legacy row without uuids gets stable identity before the merge sees it.
 */
export function ensureUuids(list) {
  if (!Array.isArray(list)) return [];
  let changed = false;
  const out = list.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    if (entry.uuid && typeof entry.uuid === 'string') return entry;
    changed = true;
    return { ...entry, uuid: randomUUID() };
  });
  return changed ? out : list;
}
