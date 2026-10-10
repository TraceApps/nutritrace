/**
 * MCP tool: get_body_composition
 *
 * Return persisted body-composition observations from wellness_data only.
 * Rows remain separate by source; metrics on the same date/source are grouped.
 */
import { z } from 'zod';
import db from '../../../db.js';
import {
  DATE_RE,
  resolveDateRange,
  toolResult,
  toolError,
  validateDateRange,
} from '../_util.js';

export const BODY_COMPOSITION_METRICS = Object.freeze([
  'weight_kg',
  'body_fat_pct',
  'muscle_mass_kg',
  'bone_mass_kg',
  'body_water_pct',
  'lean_mass_kg',
  'fat_mass_kg',
  'visceral_fat',
  'visceral_fat_index',
  'extracellular_water_kg',
  'intracellular_water_kg',
  'basal_metabolic_rate',
  'metabolic_age',
  'bmi',
  'protein',
  'bmr',
  'impedance',
  'body_score',
  'lean_mass_torso_kg',
  'lean_mass_left_leg_kg',
  'lean_mass_left_arm_kg',
  'lean_mass_right_leg_kg',
  'lean_mass_right_arm_kg',
  'muscle_mass_torso_kg',
  'muscle_mass_left_leg_kg',
  'muscle_mass_left_arm_kg',
  'muscle_mass_right_leg_kg',
  'muscle_mass_right_arm_kg',
]);

/**
 * Core lookup shared by MCP and GET /api/v1/body-composition.
 */
export function getBodyCompositionCore(userId, { start, end, source } = {}) {
  const rangeError = validateDateRange(start, end);
  if (rangeError) return { error: rangeError };
  const { start: rangeStart, end: rangeEnd } = resolveDateRange(start, end);

  const conditions = [
    'user_id = ?',
    `metric_type IN (${BODY_COMPOSITION_METRICS.map(() => '?').join(', ')})`,
    'value IS NOT NULL',
  ];
  const params = [userId, ...BODY_COMPOSITION_METRICS];
  if (rangeStart != null) {
    conditions.push('date >= ?');
    params.push(rangeStart);
  }
  if (rangeEnd != null) {
    conditions.push('date <= ?');
    params.push(rangeEnd);
  }
  if (source != null) {
    conditions.push('source = ?');
    params.push(source);
  }

  const rows = db.prepare(
    `SELECT date, source, metric_type, value FROM wellness_data
      WHERE ${conditions.join(' AND ')}
      ORDER BY date ASC, source ASC, metric_type ASC`
  ).all(...params);

  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.date}\u0000${row.source}`;
    let observation = grouped.get(key);
    if (!observation) {
      observation = { date: row.date, source: row.source, metrics: {} };
      grouped.set(key, observation);
    }
    observation.metrics[row.metric_type] = row.value;
  }
  const measurements = [...grouped.values()];
  return { start: rangeStart, end: rangeEnd, measurements, count: measurements.length };
}

export function registerGetBodyComposition(server, { userId }) {
  server.registerTool(
    'get_body_composition',
    {
      title: 'Get Body Composition',
      description:
        'Return persisted body-composition and scale observations from wellness data in an inclusive ' +
        'YYYY-MM-DD range. When both bounds are omitted, the range defaults to the last 90 days ' +
        "ending today in the server's timezone; a supplied bound leaves the other side open. " +
        'Rows are grouped by date and exact source, without merging, averaging, summing, or filling missing values.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        source: z.string().min(1).optional(),
      },
    },
    async ({ start, end, source }) => {
      const result = getBodyCompositionCore(userId, { start, end, source });
      if (result.error) return toolError(result.error);
      return toolResult(result);
    }
  );
}
