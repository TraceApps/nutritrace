/**
 * body-stats-unit.js — manual body_stats values are stored in the unit
 * the user had selected at write time, alongside a tag (`weight_unit`,
 * `lengths_unit`) so a later switch of `weightUnit` / `lengthUnit` no
 * longer reinterprets historical numbers in the new unit.
 *
 * - readBodyStat(bs, metric, weightUnit, lengthUnit)
 *     Returns the value of `bs[metric]` converted into the caller's
 *     display unit. Untagged legacy rows are assumed to already be in
 *     the display unit (preserves existing behaviour — no regression).
 *
 * - tagBodyStats(stats, weightUnit, lengthUnit)
 *     Adds `weight_unit` / `lengths_unit` tags to a partial body_stats
 *     blob that's about to be saved. Tags are only added when the
 *     corresponding field is present, so a "save just body fat" merge
 *     doesn't clobber an existing weight tag.
 *
 * Body fat (%) is unit-agnostic and ignored here.
 */

export const LENGTH_KEYS = ['neck','waist','hips','chest','thighs','biceps','calves'];

const KG_PER_LB = 1 / 2.20462;
const CM_PER_IN = 2.54;

function _convertWeight(n, from, to) {
  if (from === to) return n;
  if (from === 'lb' && to === 'kg') return Math.round(n * KG_PER_LB * 10) / 10;
  if (from === 'kg' && to === 'lb') return Math.round(n * 2.20462  * 10) / 10;
  return n;
}
function _convertLength(n, from, to) {
  if (from === to) return n;
  if (from === 'in' && to === 'cm') return Math.round(n * CM_PER_IN * 10) / 10;
  if (from === 'cm' && to === 'in') return Math.round(n / CM_PER_IN * 10) / 10;
  return n;
}

export function readBodyStat(bs, metric, weightUnit, lengthUnit) {
  if (!bs) return null;
  const raw = bs[metric];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (metric === 'weight') {
    const stored = bs.weight_unit || weightUnit || 'kg';
    return _convertWeight(n, stored, weightUnit || 'kg');
  }
  if (LENGTH_KEYS.includes(metric)) {
    const stored = bs.lengths_unit || lengthUnit || 'in';
    return _convertLength(n, stored, lengthUnit || 'in');
  }
  return n;
}

export function tagBodyStats(stats, weightUnit, lengthUnit) {
  const out = { ...stats };
  const hasWeight = out.weight != null && out.weight !== '';
  const hasLength = LENGTH_KEYS.some(k => out[k] != null && out[k] !== '');
  if (hasWeight) out.weight_unit  = weightUnit || 'kg';
  if (hasLength) out.lengths_unit = lengthUnit || 'in';
  return out;
}
