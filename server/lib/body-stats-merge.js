/**
 * A diary day's measurements (body_stats: { weight, body_fat, ... }) meet
 * one by one, as fields of their own (lib/field-sync.js): weight logged on
 * the phone and body fat on the web both stay, and the newer edit of each
 * stays. The day's field_times keeps each as `body_stats.<key>`: stamped
 * here at the edit's time, and by a trigger (db.js) on every other write
 * that changes one (an import, Trace, the wearable mirror).
 *
 * Used by the sync push and PUT /api/diary/:date. A request says which
 * measurements it changed (`body_stats_changed`); one that can't say
 * changed every measurement it sends, and took away the ones it left out,
 * as a whole-object write always did. An empty object (or none) changes
 * nothing, as before (#81).
 */
import { mergeEdit, readTimes, instantMs, isoTime } from './field-sync.js';
import { DIARY_STAT_PREFIX } from './sync-fields.js';

const _obj = v => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } }
  return {};
};

/** A list a request sent (of strings), or null when it sent none. */
export function changedList(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : null;
}

/**
 * existingRow: the day here (or null). incoming: the request's body_stats.
 * Options: at (ms, when the edit was made), changed (array or null),
 * fieldAt ({ key: ms }: when each measurement was edited, where known).
 * Returns { json: body_stats to store, times: the day's field_times
 * (object), applied, lost, differs } or null when the request changes no
 * measurement (keep the day's as it is).
 */
export function mergeBodyStats(existingRow, incoming, { at, changed = null, fieldAt = null } = {}) {
  const inc = _obj(incoming);
  const keys = Object.keys(inc);
  const said = changedList(changed);
  if (!keys.length && !(said && said.length)) return null;
  const here = existingRow ? _obj(existingRow.body_stats) : {};
  const dayTimes = readTimes(existingRow?.field_times);
  const fields = [...new Set([...Object.keys(here), ...keys, ...(said || [])])];
  // The edit's values: what it sends, and for one it leaves out, nothing
  // (taken away), when it says so or can't say.
  const values = {};
  for (const k of fields) {
    if (k in inc) values[k] = inc[k];
    else if (!said || said.includes(k)) values[k] = null;
  }
  // Each measurement's time here: its own. Never the day's: logging a food
  // makes the day, and moves it, and that's no edit of a measurement.
  const times = {};
  for (const k of fields) {
    const own = instantMs(dayTimes[DIARY_STAT_PREFIX + k]);
    if (Number.isFinite(own)) times[k] = isoTime(own);
  }
  const m = mergeEdit({
    existing: existingRow ? here : null, values, fields, changed: said, at, fieldAt, times,
  });
  const out = {};
  for (const k of fields) if (m.row[k] != null) out[k] = m.row[k];
  const next = { ...dayTimes };
  for (const k of fields) if (m.times[k] && m.times[k] !== times[k]) next[DIARY_STAT_PREFIX + k] = m.times[k];
  return { json: JSON.stringify(out), times: next, applied: m.applied, lost: m.lost, differs: m.differs };
}

