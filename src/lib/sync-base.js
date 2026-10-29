/**
 * sync-base.js: which fields this device changed in a row since the copy
 * the server has, so the server can keep the newer edit of each field
 * (lib/field-sync.js, server/routes/sync.js).
 *
 * Each synced row keeps that copy as `server_base` (short keys, rowBase):
 * set when a row comes from the server (a pull, the server's answer to a
 * push) and when a push of it lands. A row without one (from before, or
 * never on a server) says nothing, and the server takes it as a whole, as
 * it always has. Rows are compared as the push sends them (src/lib/sync.js).
 * A diary day's measurements (body_stats) are compared key by key.
 */
import { rowBase, rowChanges } from './field-sync.js';
import { SYNC_FIELDS, SYNC_JSON } from './sync-fields.js';

/** A row's copy as the server has it, to keep as server_base. */
export const baseOf = (table, row) => rowBase(SYNC_FIELDS[table], row, SYNC_JSON[table]);

/** The fields of `row` changed since `base`; null when there's no base. */
export const changesOf = (table, row, base) => rowChanges(SYNC_FIELDS[table], row, base, SYNC_JSON[table]);

const _obj = v => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } }
  return {};
};

/** A day's measurements as the server has them. */
export const statsBase = bodyStats => { const o = _obj(bodyStats); return rowBase(Object.keys(o), o); };

/** The measurements changed (set, changed or taken away) since `base`;
 *  null when there's no base. */
export function statsChanges(bodyStats, base) {
  let b = base;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const o = _obj(bodyStats);
  return rowChanges([...new Set([...Object.keys(b), ...Object.keys(o)])], o, b);
}
