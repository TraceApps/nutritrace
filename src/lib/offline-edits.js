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

import { sameValue } from './field-sync.js';
import { SYNC_FIELDS, SYNC_JSON } from './sync-fields.js';

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
  // When the day's note was last changed in the queue (see noteChangedAt);
  // null when queued ops say it wasn't; absent for ops queued before ops
  // recorded it.
  const noteAt = new Map();
  // Which measurements the queued saves of a day changed, all of them
  // together (see statsChanged); null once one of them can't say.
  const stats = new Map();
  for (const op of ops || []) {
    if (!op || op.type !== 'diary' || !op.date) continue;
    const t = tombs.get(op.date) || { items: new Set(), water: new Set() };
    for (const uuid of op.day?.deleted_uuids?.items || []) t.items.add(uuid);
    for (const uuid of op.day?.deleted_uuids?.water || []) t.water.add(uuid);
    tombs.set(op.date, t);
    if ('note_at' in op) noteAt.set(op.date, op.note_at || noteAt.get(op.date) || null);
    const had = stats.has(op.date) ? stats.get(op.date) : new Map();
    if (had && Array.isArray(op.stats_changed)) {
      for (const k of op.stats_changed) had.set(k, new Date(op.at || Date.now()).toISOString());
      stats.set(op.date, had);
    } else stats.set(op.date, null);
    byDate.set(op.date, op);
  }
  return [...byDate.values()]
    .map(op => {
      const t = tombs.get(op.date);
      const out = { ...op, day: { ...op.day, deleted_uuids: { items: [...t.items], water: [...t.water] } } };
      if (noteAt.has(op.date)) out.note_at = noteAt.get(op.date);
      const st = stats.get(op.date);
      if (st) { out.stats_changed = [...st.keys()]; out.stats_at = Object.fromEntries(st); } else { delete out.stats_changed; delete out.stats_at; }
      return out;
    })
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/**
 * The /api/sync/push body for what's waiting. Same row shape the Android app
 * sends (src/lib/sync.js), so the server merge path is the one already in use.
 * server_id comes from the mirror when the day exists there; the server also
 * resolves by (user, date), so a day first written offline still lands.
 */
const _noteOf = day => (typeof day?.notes === 'string' && day.notes.trim()) ? day.notes : null;

/** When an offline save changed the day's note: its time if the note
 *  differs from the day as the person saw it (`before`: the mirror plus
 *  what was already queued), else null. Kept on the queued op, so the
 *  flush knows what was edited here even if the mirror moved on since. */
export function noteChangedAt(before, day, at) {
  return _noteOf(day) !== _noteOf(before) ? at : null;
}

const _stats = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** The measurements an offline save of a day changed (set, changed or
 *  taken away), against the day as the person saw it. Kept on the queued
 *  op, so the server changes only those (body_stats_changed) and keeps a
 *  measurement made elsewhere meanwhile. */
export function statsChanged(before, day) {
  const a = _stats(before?.body_stats ?? before?.bodyStats), b = _stats(day?.body_stats ?? day?.bodyStats);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !sameValue(a[k], b[k]));
}

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
      // The day's note, only when it was changed offline, with the time of
      // that change: the newer note wins on the server. Otherwise the
      // server keeps its own. Ops queued before they recorded it fall back
      // to comparing with the server's copy this browser holds.
      ...(('note_at' in op ? op.note_at != null : _noteOf(op.day) !== _noteOf(known))
        ? { notes: _noteOf(op.day) || '', notes_updated_at: new Date(op.note_at || op.at || Date.now()).toISOString() }
        : {}),
      deleted_uuids: op.day?.deleted_uuids || { items: [], water: [] },
      // Only the measurements changed offline, when the queue knows them.
      ...(Array.isArray(op.stats_changed) ? { body_stats_changed: op.stats_changed } : {}),
      ...(Array.isArray(op.stats_changed) && op.stats_at ? { body_stats_edits: op.stats_at } : {}),
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

// ── Catalogue rows made or changed without a connection ─────────────
//
// Foods, meals and recipes all behave the same way: a row created offline gets
// a temporary negative id so the diary can reference it at once. The push
// sends it as client_id, the server answers with the real id, and every
// reference is rewritten before the diary goes up (offline-api.js), so nothing
// ends up pointing at an id that never existed. Recipes are meals with a flag,
// and the server keeps them in the same table.

let _tempSeq = 0;
/** A new id that cannot collide with a server one. */
export const newTempId = () => -(Date.now() * 1000 + (++_tempSeq % 1000));
export const isTempId = (id) => Number(id) < 0;

/** The catalogue with queued work applied: creates, edits and deletions. */
export function applyCatalogOps(rows, ops, table = 'foods') {
  const out = new Map();
  for (const r of rows || []) if (r && r.id != null) out.set(Number(r.id), { ...r });
  for (const op of ops || []) {
    if (!op || op.type !== 'catalog' || (op.table || 'foods') !== table) continue;
    const id = Number(op.id);
    if (op.action === 'delete') { out.delete(id); continue; }
    const base = out.get(id) || {};
    out.set(id, { ...base, ...op.data, id, _pending: true });
  }
  return out;
}

/**
 * One row per thing, newest state wins. Something created and then edited
 * offline goes up as a single create; created and then deleted never goes up.
 */
export function collapseCatalogOps(ops, table = 'foods') {
  const byId = new Map();
  for (const op of ops || []) {
    if (!op || op.type !== 'catalog' || (op.table || 'foods') !== table) continue;
    const id = Number(op.id);
    const prev = byId.get(id);
    if (op.action === 'delete') {
      if (isTempId(id) && prev?.action === 'create') byId.delete(id);
      else byId.set(id, { ...op, data: prev?.data });
      continue;
    }
    // What the edits changed, together, each with the time of the last
    // edit that changed it; null once one of them can't say.
    const changed = prev && prev.action !== 'create'
      ? (Array.isArray(prev.changed) && Array.isArray(op.changed) ? [...new Set([...prev.changed, ...op.changed])] : null)
      : (Array.isArray(op.changed) ? op.changed : null);
    const edits = changed ? { ...(prev?.edits || {}) } : null;
    if (edits) for (const f of op.changed) edits[f] = new Date(op.at || Date.now()).toISOString();
    byId.set(id, prev?.action === 'create'
      ? { ...prev, data: { ...prev.data, ...op.data }, seq: op.seq }
      : { ...op, data: { ...(prev?.data || {}), ...op.data }, changed, edits });
  }
  return [...byId.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

const _catalogRow = (op) => {
  const temp = isTempId(op.id);
  const when = new Date(op.at || Date.now()).toISOString();
  const own = { client_id: temp ? Number(op.id) : null, server_id: temp ? null : Number(op.id), updated_at: when, deleted_at: op.action === 'delete' ? when : null };
  // When this was done here, and whether it's a delete: never the times of
  // the copy it was made on, which the queued row carries too. Work queued
  // by the app before it said what changed (no `v`) goes as it always did.
  const row = op.v >= 2
    ? { ...pushShape(op.table || 'foods', op.data || {}), ...own }
    : { ...own, ...(op.data || {}) };
  if (row.imgUrl && !row.img_url) row.img_url = row.imgUrl;
  delete row.imgUrl;
  delete row._pending;
  delete row.changed_at;
  delete row.field_times;
  row.id = undefined;
  // The fields this edit changed, so the server leaves the rest as they are
  // there (a change made elsewhere meanwhile stays).
  if (!temp && op.action === 'update' && Array.isArray(op.changed)) {
    row.changed_fields = op.changed;
    if (op.edits && Object.keys(op.edits).length) row.field_edits = op.edits;
  }
  return row;
};

const _SYNC_TABLE = { foods: 'foods', meals: 'meals', activity: 'activity_log', fasts: 'fasts' };

/** A row as the sync push sends it: the server's names for a picture
 *  (img_url) and a food's category. */
export function pushShape(table, row) {
  const out = { ...(row || {}) };
  if ('imgUrl' in out) { if (!out.img_url) out.img_url = out.imgUrl || null; delete out.imgUrl; }
  if (table === 'foods' && Array.isArray(out.categories)) {
    out.category = out.categories[0] || out.category || null;
    delete out.categories;
  }
  return out;
}

/** The synced fields `after` changes in `before` (a row as this browser
 *  holds it): the fields an edit made on that copy changed. */
export function changedSince(table, before, after) {
  const t = _SYNC_TABLE[table] || table;
  const fields = SYNC_FIELDS[t] || [];
  const json = SYNC_JSON[t] || [];
  const a = pushShape(table, before), b = pushShape(table, after);
  return fields.filter(f => b[f] !== undefined && !sameValue(a[f], b[f], json.includes(f)));
}

/** The copy of a row a save was made on, as far as this browser can tell:
 *  the server's time of its last write. */
export const copyStamp = row => row?.changed_at || row?.updated_at || null;

/** Settings changed offline, one row per key, the last value winning. */
export function collapseSettingOps(ops) {
  const byKey = new Map();
  for (const op of ops || []) {
    if (!op || op.type !== 'setting' || !op.key) continue;
    byKey.set(op.key, { key: op.key, value: op.data, updated_at: new Date(op.at || Date.now()).toISOString() });
  }
  return [...byKey.values()];
}

/** The /api/sync/push body for queued catalogue work. */
export function buildCatalogPush(ops) {
  return {
    foods: collapseCatalogOps(ops, 'foods').map(_catalogRow),
    meals: collapseCatalogOps(ops, 'meals').map(_catalogRow),
    activity: collapseCatalogOps(ops, 'activity').map(_catalogRow),
    fasts: collapseCatalogOps(ops, 'fasts').map(_catalogRow),
    settings: collapseSettingOps(ops),
    diary: [], wellness: [], workouts: [],
  };
}

/** Temporary id to real id, from what the server answered, across both tables. */
export function createdIds(response) {
  const tables = response?.tables || response || {};
  const map = {};
  for (const name of ['foods', 'meals', 'activity', 'fasts']) {
    for (const r of Array.isArray(tables[name]) ? tables[name] : []) {
      if (r && r.client_id != null && r.server_id != null && isTempId(r.client_id)) map[Number(r.client_id)] = Number(r.server_id);
    }
  }
  return map;
}

/**
 * Point everything at the real ids: the rows themselves, and the diary entries
 * logged from something that only existed offline.
 */
export function remapIds(value, map) {
  if (!map || !Object.keys(map).length) return value;
  const swap = (id) => (id != null && map[Number(id)] != null ? map[Number(id)] : id);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = { ...v };
      for (const key of ['id', 'food_id', 'food_server_id', 'foodId', 'meal_id', 'meal_server_id']) {
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

/**
 * Which kept readings to let go of, oldest first, once there are more than
 * `keep`. The copy this browser holds has to have a ceiling: a database with
 * no room left would refuse the outbox too, and then nothing could be logged
 * offline at all, which is the one thing that must not happen.
 */
export function staleReadKeys(rows, keep) {
  const held = (rows || []).filter(r => r && r.key != null);
  if (held.length <= keep) return [];
  return held
    .slice()
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(0, held.length - keep)
    .map(r => r.key);
}

// ── Fasting, without a connection ───────────────────────────────────
//
// A fast is one row with a start and, once it's over, an end, so it queues
// like a catalogue row (table 'fasts'). What's queued is always the whole
// row rather than the field that changed, because the server's merge writes
// every column from what it's given.

const _byNewest = (a, b) => String(b.start_at || '').localeCompare(String(a.start_at || ''));
const _liveFasts = (rows, ops) =>
  [...applyCatalogOps(rows, ops, 'fasts').values()].filter(f => f && !f.deleted_at);

/** The fast still running, mirror plus queue, as /api/fasts/active answers. */
export function activeFastRow(rows, ops) {
  return _liveFasts(rows, ops).filter(f => !f.end_at).sort(_byNewest)[0] || null;
}

/** Recent fasts newest first, as /api/fasts answers. */
export function fastList(rows, ops, limit = 60) {
  return _liveFasts(rows, ops).sort(_byNewest).slice(0, Math.max(1, limit));
}

/**
 * The row a fast started offline begins as, following the server's own rules:
 * a goal it would accept, and a back-dated start only within the last day.
 */
export function newFastRow(body, now = Date.now()) {
  const goal = Number(body?.goal_hours);
  const asked = body?.start_at ? new Date(body.start_at).getTime() : NaN;
  const backdated = Number.isFinite(asked) && asked <= now && asked > now - 24 * 3600 * 1000;
  return {
    start_at: new Date(backdated ? asked : now).toISOString(),
    end_at: null,
    goal_hours: Number.isFinite(goal) && goal > 0 && goal <= 168 ? Math.round(goal * 10) / 10 : 16,
    notes: null,
  };
}

/** The whole fast as it would be after this change, ready to queue. */
export function fastWith(rows, ops, id, change) {
  const current = applyCatalogOps(rows, ops, 'fasts').get(Number(id));
  if (!current) return null;
  const { _pending, id: _id, ...rest } = current;
  return {
    start_at: rest.start_at,
    end_at: rest.end_at ?? null,
    goal_hours: rest.goal_hours ?? 16,
    notes: rest.notes ?? null,
    ...change,
  };
}
