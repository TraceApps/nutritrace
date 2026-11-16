/**
 * Weight and measurements are saved with the unit they were entered in
 * (`weight_unit`, `lengths_unit`; src/lib/body-stats-unit.js). Days saved
 * before that (1.0 release candidates up to rc.17) have no tag, and readers
 * disagreed on what an untagged number means: the Diary, Goals and
 * Statistics read it in the account's current unit, while the adaptive TDEE,
 * coaching, the email digest, Add Activity and MCP read it as kg. So a
 * 180 lb weigh-in counted as 180 kg there, and changing the unit setting
 * made every untagged day read as the new unit.
 *
 * This tags each untagged day with the unit the account shows it in now.
 * The app says which (POST /api/diary/body-stats-units): only it knows for
 * sure, since a single-user server keeps no settings and an account's unit
 * can live in the browser without a server row. Nothing the account sees
 * changes, and from here on every reader agrees and a later unit change
 * can't reinterpret history.
 *
 * Idempotent and cheap (only rows with an untagged value are read), so the
 * app asks at every start; days a restore or an import brings in from an
 * older backup are tagged at the next one.
 */

import { LENGTH_KEYS, missingTags } from '../../src/lib/body-stats-unit.js';

const _has = v => v != null && v !== '';

// Rows with a weight or a measurement that has a value and no tag for it.
// The JS check (missingTags) decides; this keeps the scan to those rows, so
// a day with an empty or null value isn't read at every start.
const _val = k => `IFNULL(json_type(body_stats, '$.${k}'), 'null') != 'null' AND IFNULL(json_extract(body_stats, '$.${k}'), '') != ''`;
const _untagged = k => `IFNULL(json_extract(body_stats, '$.${k}'), '') = ''`;
const _WEIGHT = `(${_untagged('weight_unit')} AND ${_val('weight')})`;
const _LENGTHS = `(${_untagged('lengths_unit')} AND (${LENGTH_KEYS.map(k => `(${_val(k)})`).join(' OR ')}))`;

// A tag for a value with no edit time of its own is as old as can be: it
// loses to any edit, as the value does (lib/body-stats-merge.js).
const _OLDEST = '1970-01-01T00:00:00.000Z';

function _times(raw) {
  if (typeof raw !== 'string') return null;
  try { const o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

/**
 * Tag one account's untagged days with the units it shows them in
 * (`userId` null: the single-user days, which have no user_id). Either unit
 * can be left out (the app sends only the ones it knows). Returns how many
 * days changed.
 *
 * A tag gets the edit time of the value it describes, so it never beats a
 * newer edit of that value. Deleted days are left alone. updated_at moves
 * to now so phones pull the tagged day.
 */
export function tagUntaggedBodyStats(db, userId, { weightUnit, lengthUnit } = {}) {
  if (weightUnit != null && !['kg', 'lb'].includes(weightUnit)) throw new Error('weight_unit must be kg or lb');
  if (lengthUnit != null && !['cm', 'in'].includes(lengthUnit)) throw new Error('lengths_unit must be cm or in');
  const which = [weightUnit && _WEIGHT, lengthUnit && _LENGTHS].filter(Boolean);
  if (!which.length) return 0;
  const where = userId == null ? 'user_id IS NULL' : 'user_id = ?';
  const rows = db.prepare(`SELECT id, body_stats, field_times, updated_at FROM diary
    WHERE ${where} AND deleted_at IS NULL AND json_valid(body_stats) AND json_type(body_stats) = 'object'
      AND (${which.join(' OR ')})`).all(...(userId == null ? [] : [userId]));
  if (!rows.length) return 0;
  const update = db.prepare(`UPDATE diary SET body_stats = ?, field_times = ?, updated_at = datetime('now') WHERE id = ?`);

  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      let stats;
      try { stats = JSON.parse(row.body_stats); } catch { continue; }
      const m = missingTags(stats);
      const miss = { weight: m.weight && !!weightUnit, lengths: m.lengths && !!lengthUnit };
      if (!miss.weight && !miss.lengths) continue;
      // A day with no times at all keeps its time as the base, as the
      // trigger in db.js would give it.
      const dayAt = row.updated_at || '1970-01-01 00:00:00';
      const was = _times(row.field_times);
      const times = was && Object.keys(was).length ? { ...was } : { _base: dayAt };
      const at = key => times[`body_stats.${key}`] || _OLDEST;
      if (miss.weight) {
        stats.weight_unit = weightUnit;
        times['body_stats.weight_unit'] = at('weight');
      }
      if (miss.lengths) {
        stats.lengths_unit = lengthUnit;
        // The newest of the measurements it describes.
        const ts = LENGTH_KEYS.filter(k => _has(stats[k])).map(at).sort();
        times['body_stats.lengths_unit'] = ts[ts.length - 1];
      }
      update.run(JSON.stringify(stats), JSON.stringify(times), row.id);
      changed++;
    }
  })();
  return changed;
}
