/**
 * Exercise log weights are stored in the unit the user had selected at
 * write time (`weight_unit`), same tagging as diary body_stats.weight.
 */
import { convertWeight } from './body-stats-unit.js';

export function displayExerciseWeight(log, weightUnit) {
  if (!log || log.weight == null || log.weight === '') return null;
  const n = Number(log.weight);
  if (!Number.isFinite(n)) return null;
  const stored = log.weight_unit || weightUnit || 'kg';
  return convertWeight(n, stored, weightUnit || 'kg');
}

export function tagExerciseWeight(weight, weightUnit) {
  if (weight == null || weight === '') return { weight: null, weight_unit: null };
  const n = Number(weight);
  if (!Number.isFinite(n) || n < 0) return { weight: null, weight_unit: null };
  return { weight: n, weight_unit: weightUnit || 'kg' };
}
