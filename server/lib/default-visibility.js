/**
 * default-visibility.js — resolve a user's `defaultShareVisibility`
 * setting for newly-created foods / meals / recipes (#183).
 *
 * A user with the setting = 'group' expects every food, meal, and
 * recipe they create to be visible to their group by default without
 * having to visit the bulk-share screen and click Apply. This helper
 * is the single source of truth for that resolution and is called
 * from:
 *   - server/routes/foods.js  POST  /api/foods
 *   - server/routes/meals.js  POST  /api/meals
 *   - server/routes/sync.js   INSERT on new foods / meals
 *
 * Guardrails:
 *   - Explicit visibility on the request wins over the default.
 *   - Global sharing_enabled is authoritative — when the admin turns
 *     sharing off, every new row is forced to 'private' regardless of
 *     the per-user default. Prevents a stale user setting from leaking
 *     rows into 'group' after the admin flips the switch.
 *   - Anonymous callers (single-user mode, userId null) always land
 *     on 'private' — 'group' is meaningless without users.
 *   - Unknown / malformed values fall through to 'private'. 'specific'
 *     is treated as 'private' in this pass — the UI does not offer it,
 *     and 'specific' without a paired user list would silently share
 *     with nobody. If 'specific' is added later, this helper should
 *     also return the user-id list.
 */
import db from '../db.js';

const ALLOWED = new Set(['private', 'group']);

function _sharingEnabled() {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = 'sharing_enabled'`).get();
  return row?.value === 'true';
}

function _readUserDefault(userId) {
  if (userId == null) return 'private';
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE user_id = ? AND key = 'defaultShareVisibility' AND deleted_at IS NULL`
  ).get(userId);
  if (!row?.value) return 'private';
  // user_settings values are JSON-stringified by the client layer.
  let v = row.value;
  try { v = JSON.parse(row.value); } catch { /* raw string — accept as-is */ }
  if (typeof v !== 'string') return 'private';
  return ALLOWED.has(v) ? v : 'private';
}

/**
 * Resolve the visibility for a newly-created food / meal / recipe
 * when the client did NOT send an explicit visibility field. When the
 * client did send one, pass it through unchanged in the caller —
 * this helper only fills in the default.
 * @param {number|null} userId
 * @returns {'private'|'group'}
 */
export function resolveNewItemVisibility(userId) {
  const userDefault = _readUserDefault(userId);
  if (userDefault === 'group' && !_sharingEnabled()) return 'private';
  return userDefault;
}
