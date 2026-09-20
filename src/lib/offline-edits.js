/**
 * offline-edits.js: the pure half of the browser's offline mode.
 *
 * No IndexedDB, no fetch, no Svelte. Everything here is a plain function over
 * plain data, so it can be tested without a browser (scripts/offline-edits.test.js)
 * and reasoned about on its own. offline-api.js does the storage and the sending.
 *
 * A queued edit is one day of the diary, exactly as the app would have sent it:
 *
 *   { seq, type: 'diary', date: '2026-09-20', day: { items, water, body_stats, notes }, at }
 *
 * The app already merges a day's items in memory before saving, so a later edit
 * to the same day supersedes the earlier one and only the last one goes up.
 * Items keep their uuids, so the server merges a queued day against whatever
 * arrived from another device exactly as it merges the phone's (routes/sync.js).
 */

/** Was this error the server being unreachable, rather than a real answer? */
export function isOfflineError(err) {
  if (!err) return false;
  if (err.offline) return true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String(err.message || err);
  // fetch() rejects with a TypeError when the network is gone; the timeouts
  // the API layer sets abort instead.
  return /Failed to fetch|NetworkError|Load failed|network|timeout|aborted|The operation was aborted/i.test(msg);
}

/** A day as the diary screen expects it, with nothing in it. */
export const emptyDay = (date) => ({ date, items: [], water: [], body_stats: {}, notes: null });

/**
 * The mirror with the outbox applied, as a Map keyed by date. The caller gets
 * what the screen should show: saved days, plus edits that haven't gone up.
 */
export function applyDiaryOps(days, ops) {
  const out = new Map();
  for (const d of days || []) if (d && d.date) out.set(d.date, { ...d });
  for (const op of ops || []) {
    if (!op || op.type !== 'diary' || !op.date) continue;
    const base = out.get(op.date) || emptyDay(op.date);
    out.set(op.date, { ...base, ...op.day, date: op.date, _pending: true });
  }
  return out;
}

/** One day, mirror plus anything queued for it. Never null: an unseen day is empty. */
export function dayWithOps(days, ops, date) {
  return applyDiaryOps(days, ops).get(date) || emptyDay(date);
}

/**
 * Only the last queued edit per day is worth sending, because each one is the
 * whole day. Deletions are the exception: the app clears its pending-deletions
 * list once a save "succeeds", so a later edit of the same day carries none.
 * Every tombstone queued for a day therefore rides along with the last edit,
 * or an item deleted offline and followed by another change would come back
 * from the server, which keeps whatever the client doesn't mention.
 */
export function collapseOps(ops) {
  const byDate = new Map();
  const tombs = new Map();
  for (const op of ops || []) {
    if (!op || op.type !== 'diary' || !op.date) continue;
    const t = tombs.get(op.date) || { items: new Set(), water: new Set() };
    for (const uuid of op.day?.deleted_uuids?.items || []) t.items.add(uuid);
    for (const uuid of op.day?.deleted_uuids?.water || []) t.water.add(uuid);
    tombs.set(op.date, t);
    byDate.set(op.date, op);
  }
  return [...byDate.values()]
    .map(op => {
      const t = tombs.get(op.date);
      return { ...op, day: { ...op.day, deleted_uuids: { items: [...t.items], water: [...t.water] } } };
    })
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/**
 * The /api/sync/push body for what's waiting. Same row shape the Android app
 * sends (src/lib/sync.js), so the server merge path is the one already in use.
 * server_id comes from the mirror when the day exists there; the server also
 * resolves by (user, date), so a day first written offline still lands.
 */
export function buildDiaryPush(ops, days) {
  const mirror = new Map((days || []).filter(d => d && d.date).map(d => [d.date, d]));
  const diary = collapseOps(ops).map(op => {
    const known = mirror.get(op.date);
    return {
      client_id: null,
      server_id: known?.id ?? null,
      date: op.date,
      items: op.day?.items || [],
      body_stats: op.day?.body_stats || {},
      water: op.day?.water || [],
      deleted_uuids: op.day?.deleted_uuids || { items: [], water: [] },
      updated_at: new Date(op.at || Date.now()).toISOString(),
      deleted_at: null,
    };
  });
  return { foods: [], meals: [], diary, activity: [], fasts: [], wellness: [], settings: [], workouts: [] };
}

/** Dates the push covered, so their queued edits can be dropped once it lands. */
export function sentSeqs(ops) {
  const dates = new Set(collapseOps(ops).map(op => op.date));
  return (ops || []).filter(op => op.type === 'diary' && dates.has(op.date)).map(op => op.seq);
}

/** Did the server refuse part of the push? Returns the first message, or null. */
export function pushError(response) {
  const tables = response?.tables || response || {};
  for (const value of Object.values(tables)) {
    if (value && !Array.isArray(value) && value.error) return String(value.error);
  }
  return null;
}

// ── Foods made or changed without a connection ───────────────────────
//
// A food created offline gets a temporary negative id so the diary can
// reference it at once. The push sends it as client_id, the server answers
// with the real id, and every reference is rewritten before the diary goes up
// (offline-api.js), so nothing ends up pointing at an id that never existed.

let _tempSeq = 0;
/** A new id that cannot collide with a server one. */
export const newTempId = () => -(Date.now() * 1000 + (++_tempSeq % 1000));
export const isTempId = (id) => Number(id) < 0;

/** The catalogue with queued food work applied: creates, edits and deletions. */
export function applyFoodOps(foods, ops) {
  const out = new Map();
  for (const f of foods || []) if (f && f.id != null) out.set(Number(f.id), { ...f });
  for (const op of ops || []) {
    if (!op || op.type !== 'food') continue;
    const id = Number(op.id);
    if (op.action === 'delete') { out.delete(id); continue; }
    const base = out.get(id) || {};
    out.set(id, { ...base, ...op.data, id, _pending: true });
  }
  return out;
}

/**
 * One row per food, newest state wins. A food created and then edited offline
 * goes up as a single create; one created and then deleted never goes up at all.
 */
export function collapseFoodOps(ops) {
  const byId = new Map();
  for (const op of ops || []) {
    if (!op || op.type !== 'food') continue;
    const id = Number(op.id);
    const prev = byId.get(id);
    if (op.action === 'delete') {
      // Deleting something that only ever existed offline: drop both.
      if (isTempId(id) && prev?.action === 'create') byId.delete(id);
      else byId.set(id, { ...op, data: prev?.data });
      continue;
    }
    byId.set(id, prev?.action === 'create'
      ? { ...prev, data: { ...prev.data, ...op.data }, seq: op.seq }
      : { ...op, data: { ...(prev?.data || {}), ...op.data } });
  }
  return [...byId.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/** The /api/sync/push body for queued food work. */
export function buildFoodsPush(ops) {
  const foods = collapseFoodOps(ops).map(op => {
    const temp = isTempId(op.id);
    const when = new Date(op.at || Date.now()).toISOString();
    const row = {
      client_id: temp ? Number(op.id) : null,
      server_id: temp ? null : Number(op.id),
      updated_at: when,
      deleted_at: op.action === 'delete' ? when : null,
      ...(op.data || {}),
    };
    // The data may carry the app's own field names; the server wants img_url.
    if (row.imgUrl && !row.img_url) { row.img_url = row.imgUrl; }
    delete row.imgUrl;
    delete row._pending;
    row.id = undefined;
    return row;
  });
  return { foods, meals: [], diary: [], activity: [], fasts: [], wellness: [], settings: [], workouts: [] };
}

/** Temporary id to real id, from what the server answered. */
export function createdFoodIds(response) {
  const rows = response?.tables?.foods || response?.foods || [];
  const map = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.client_id != null && r.server_id != null && isTempId(r.client_id)) map[Number(r.client_id)] = Number(r.server_id);
  }
  return map;
}

/**
 * Point everything at the real ids: the food rows themselves, and the diary
 * entries logged from a food that only existed offline.
 */
export function remapFoodIds(value, map) {
  if (!map || !Object.keys(map).length) return value;
  const swap = (id) => (id != null && map[Number(id)] != null ? map[Number(id)] : id);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = { ...v };
      for (const key of ['id', 'food_id', 'food_server_id', 'foodId']) {
        if (out[key] != null && isTempId(out[key])) out[key] = swap(out[key]);
      }
      for (const [k, val] of Object.entries(out)) {
        if (val && typeof val === 'object') out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}
