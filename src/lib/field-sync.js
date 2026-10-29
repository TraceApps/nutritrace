/**
 * field-sync.js: two edits of one row meet field by field, and the newer
 * edit of each field stays.
 *
 * The same file in every Trace app that uses it, in src/lib and server/lib.
 * scripts/field-sync.test.js pins its hash: change every copy together. Each
 * app gives its own tables, fields and groups; nothing here knows them.
 *
 * Every synced row keeps when each of its fields last changed: field_times,
 * JSON { field: time, _base: time }. `_base` stands for every field with no
 * time of its own (when the row was made, or its last write before the
 * times began; a row with none yet counts from its updated_at). A table
 * whose rows are deleted softly lists deleted_at among its stamped fields
 * (fieldTimesSql), so a delete, and a row brought back, have their times.
 *
 * An edit arrives with when it was made (`at`, ms, on the server's clock:
 * each app puts a device's time right before it gets here) and the fields
 * it changed (`changed`). An edit that can't say which changed every field
 * it sends: a whole row from an older app counts as all of it, edited at
 * its own time. For each field it changed, or each group of fields that
 * belong together (a quantity and its unit):
 *   - changed here later than the edit: what's here stays;
 *   - otherwise the edit's value goes in, with the edit's time.
 * Fields the edit didn't change stay as they are here. A delete loses to an
 * edit made after it, and an edit made before a delete doesn't bring the
 * row back. Times count in whole seconds; a tie between two edits goes to
 * the one arriving, a tie between an edit and a delete to the delete.
 *
 * The phone (or browser) side keeps, per row, the copy the server has
 * (rowBase) and works out what it changed since (rowChanges), so it can
 * say which fields an edit changed.
 */

/** A time as ms: ISO 8601 with its zone (Z or an offset) is that instant;
 *  one with no zone, or SQLite's 'YYYY-MM-DD HH:MM:SS', is UTC. NaN when
 *  it isn't a time. */
export function instantMs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (v instanceof Date) return v.getTime();
  let s = String(v).trim();
  if (/^\d{4}-\d\d-\d\d$/.test(s)) s += 'T00:00:00';
  s = s.replace(/^(\d{4}-\d\d-\d\d) /, '$1T');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/i.test(s)) return NaN;
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) s += 'Z';
  return Date.parse(s);
}

/** A time as stored in field_times. */
export const isoTime = ms => new Date(ms).toISOString();

/** Whether time `a` is later than time `b`, in whole seconds (ms or text). */
export function laterThan(a, b) {
  const x = instantMs(a), y = instantMs(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.floor(x / 1000) > Math.floor(y / 1000);
}

/** A row's field_times (JSON text or an object) as a new plain object. */
export function readTimes(v) {
  if (v && typeof v === 'object') return { ...v };
  if (typeof v !== 'string' || !v) return {};
  try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/** A row's field_times, or for a row with none yet (from before the
 *  times began), its last write (`baseCol`) standing for every field.
 *  baseCol null: a row's last write stands for none of them. */
export function rowTimes(existing, baseCol = 'updated_at') {
  const t = readTimes(existing?.field_times);
  if (baseCol && !Object.keys(t).length && existing?.[baseCol] != null) t._base = existing[baseCol];
  return t;
}

/** When a field last changed here (ms): its own time, else `_base`. NaN
 *  for a row with no times at all. */
export function fieldTime(times, f) {
  const own = instantMs(times?.[f]);
  return Number.isFinite(own) ? own : instantMs(times?._base);
}

function _stable(v) {
  if (Array.isArray(v)) return `[${v.map(_stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${_stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * A value as compared. Text is compared as written: '007' and '7', or two
 * spellings of the same JSON in a note, are different values. Only what
 * the app and the server store differently counts the same: null and '',
 * true and 1, a number and the same number as text. A field holding JSON
 * (`json`) is compared by what it holds, as text or parsed, an empty list
 * or object being nothing.
 */
export function valueKey(v, json = false) {
  if (v === undefined || v === '') v = null;
  if (v === true) v = 1;
  else if (v === false) v = 0;
  if (json) {
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { /* not JSON: as text */ } }
    if (Array.isArray(v) && v.length === 0) v = null;
    else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) v = null;
  } else if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  return _stable(v);
}

export const sameValue = (a, b, json = false) => valueKey(a, json) === valueKey(b, json);

/** The fields that meet as one: each group (only its fields in `fields`),
 *  then every other field on its own. */
export function fieldUnits(fields, groups = []) {
  const inGroup = new Set();
  const units = [];
  for (const g of groups || []) {
    const u = g.filter(f => fields.includes(f));
    if (u.length) { units.push(u); u.forEach(f => inGroup.add(f)); }
  }
  for (const f of fields) if (!inGroup.has(f)) units.push([f]);
  return units;
}

/**
 * One edit meeting the row here.
 *   existing: the row here (null: a new row, all of the edit goes in).
 *   values:   the edit's values by field, as stored (undefined: not sent).
 *   fields:   the fields that merge (not deleted_at); groups: lists of them.
 *   changed:  the fields the edit changed (array or Set), or null: every
 *             field it sends. A new row takes every field it sends.
 *   at:       when the edit was made (ms or a time).
 *   fieldAt:  when each field was edited, where the sender knows ({ field:
 *             time }, on the same clock as `at`): a field edited before a
 *             later edit of another field keeps its own time.
 *   times:    the row's field_times (default: rowTimes(existing)).
 *   json:     the fields that hold JSON (compared by what they hold).
 *   same:     (field, a, b) => equal, for values an app compares its own way.
 * Returns {
 *   row:     each field's value afterwards (the edit's or the row's),
 *   applied: fields whose value the edit changed here,
 *   lost:    fields the edit changed that stayed as they are here,
 *   times:   field_times afterwards (object; the edit's fields stamped),
 *   write:   whether anything changed,
 *   differs: whether the row afterwards isn't what the edit sent (its
 *            sender should take the row back),
 * }.
 */
export function mergeEdit({ existing, values, fields, groups = [], changed = null, at, fieldAt = null, times, json = [], same }) {
  const isJson = new Set(json);
  const eq = typeof same === 'function' ? same : (f, a, b) => sameValue(a, b, isJson.has(f));
  const atMs = Number.isFinite(instantMs(at)) ? instantMs(at) : Date.now();
  // A field's own edit time, never later than the edit's.
  const ownAt = f => { const x = instantMs(fieldAt?.[f]); return Number.isFinite(x) ? Math.min(x, atMs) : atMs; };
  const said = changed == null || !existing ? null : new Set(changed);
  const sent = f => values[f] !== undefined;
  const edited = f => sent(f) && (!said || said.has(f));
  const here = existing || {};
  const t = times !== undefined ? readTimes(times) : rowTimes(existing);
  const row = {};
  const applied = [], lost = [];
  for (const unit of fieldUnits(fields, groups)) {
    for (const f of unit) row[f] = here[f];
    const touched = unit.filter(f => edited(f) && (!existing || !eq(f, values[f], here[f])));
    if (!touched.length) continue;
    // When this edit changed the unit: the latest of its fields' own times.
    const unitAt = Math.max(...touched.map(ownAt));
    if (existing) {
      const latest = Math.max(...unit.map(f => fieldTime(t, f)).filter(Number.isFinite), -Infinity);
      if (Number.isFinite(latest) && laterThan(latest, unitAt)) { lost.push(...touched); continue; }
    }
    // The edit's whole group, as it sent it, so the group stays whole.
    const stamp = isoTime(unitAt);
    for (const f of unit) {
      if (!sent(f) || !(edited(f) || unit.length > 1)) continue;
      row[f] = values[f];
      t[f] = stamp;
      if (!existing || !eq(f, values[f], here[f])) applied.push(f);
    }
  }
  const differs = fields.some(f => sent(f) && !eq(f, row[f], values[f]));
  return { row, applied, lost, times: t, write: applied.length > 0, differs };
}

/**
 * A delete meeting the row here: it loses when one of `fields` (the row's
 * content), or the row's own deleted_at (brought back), changed after the
 * delete was made. Returns the time (ms) of that later change, or null
 * when the delete goes ahead. A tie goes to the delete.
 */
export function deleteLoses({ existing, fields, at, times }) {
  if (!existing) return null;
  const t = times !== undefined ? readTimes(times) : rowTimes(existing);
  const atMs = instantMs(at);
  if (!Number.isFinite(atMs)) return null;
  const all = fields.includes('deleted_at') ? fields : [...fields, 'deleted_at'];
  const latest = Math.max(...all.map(f => fieldTime(t, f)).filter(Number.isFinite), -Infinity);
  return Number.isFinite(latest) && laterThan(latest, atMs) ? latest : null;
}

/**
 * An edit meeting a row deleted here: it brings the row back only when it
 * was made after the delete (`deletedAt`: the delete's time, its stamp in
 * field_times when it has one). A tie keeps the delete.
 */
export function editRevives({ existing, at, deletedAt, times }) {
  const t = times !== undefined ? readTimes(times) : readTimes(existing?.field_times);
  const del = Number.isFinite(instantMs(t.deleted_at)) ? t.deleted_at : (deletedAt ?? existing?.deleted_at);
  if (!Number.isFinite(instantMs(del))) return true;
  return laterThan(at, del);
}

/** field_times with `fields` stamped at `at` (a delete: ['deleted_at']). */
export function stampTimes(times, fields, at) {
  const t = readTimes(times);
  const ms = instantMs(at);
  const stamp = isoTime(Number.isFinite(ms) ? ms : Date.now());
  for (const f of fields) t[f] = stamp;
  return t;
}

/** A new row's field_times: made at `at`, the time every field counts
 *  from until it changes. */
export const createdTimes = at => {
  const ms = instantMs(at);
  return { _base: isoTime(Number.isFinite(ms) ? ms : Date.now()) };
};

/**
 * SQLite statements that keep field_times on every write, so no write path
 * can miss it: a write that changes one of `fields` stamps it with the
 * time it happened, unless the write sets field_times itself (a merged
 * edit stamps its own). A new row with none counts from when it was made
 * (its `baseCol`, as written: a restored row from its own time, not the
 * restore's). A row from before the times keeps none until its first write, which
 * starts them from its last one (`baseCol`), as rowTimes reads it: no row
 * is written to start them, so nothing else the app keeps on a write (a
 * pull's cursor) moves. baseCol null: they start with none.
 */
export function fieldTimesSql(table, fields, { baseCol = 'updated_at' } = {}) {
  const now = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  // field_times as it is, unless it's missing (or not JSON: started again).
  const kept = `CASE WHEN json_valid(field_times) AND field_times != '{}' THEN field_times END`;
  const start = baseCol
    ? `COALESCE(${kept}, json_object('_base', OLD.${baseCol}))`
    : `COALESCE(${kept}, '{}')`;
  const out = [
    `DROP TRIGGER IF EXISTS fs_${table}_ins;`,
    `CREATE TRIGGER fs_${table}_ins AFTER INSERT ON ${table} FOR EACH ROW WHEN NEW.field_times IS NULL
     BEGIN UPDATE ${table} SET field_times = json_object('_base', ${baseCol ? `COALESCE(NEW.${baseCol}, ${now})` : now}) WHERE rowid = NEW.rowid; END;`,
  ];
  for (const f of fields) {
    out.push(
      `DROP TRIGGER IF EXISTS fs_${table}_${f};`,
      `CREATE TRIGGER fs_${table}_${f} AFTER UPDATE OF ${f} ON ${table} FOR EACH ROW
       WHEN OLD.${f} IS NOT NEW.${f} AND NEW.field_times IS OLD.field_times
       BEGIN UPDATE ${table} SET field_times = json_set(${start}, '$.${f}', ${now}) WHERE rowid = NEW.rowid; END;`,
    );
  }
  return out.join('\n');
}

/**
 * The phone's side. rowBase: a row's fields as short keys, kept with the
 * row for the copy the server has. rowChanges: the fields a row changed
 * since that copy, or null when there is none to compare (every field
 * then counts). `json`: the fields that hold JSON, as for mergeEdit.
 */
function _key(v, json) {
  const s = valueKey(v, json);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

export function rowBase(fields, row, json = []) {
  return JSON.stringify(Object.fromEntries(fields.map(f => [f, _key(row?.[f], json.includes(f))])));
}

export function rowChanges(fields, row, base, json = []) {
  let b = base;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== 'object') return null;
  return fields.filter(f => b[f] !== _key(row?.[f], json.includes(f)));
}
