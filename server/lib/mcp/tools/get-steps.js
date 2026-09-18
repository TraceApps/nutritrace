/**
 * MCP tool: get_steps
 *
 * Return persisted daily step observations from wellness_data. A row is
 * returned per source; values are never merged across providers and a
 * missing day is not represented as zero. Workout rows are intentionally
 * excluded because workouts.steps is a different source-owned record.
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

/**
 * Core lookup, shared by the MCP tool below and the public REST API at
 * GET /api/v1/steps.
 */
export function getStepsCore(userId, { start, end, source } = {}) {
  const rangeError = validateDateRange(start, end);
  if (rangeError) return { error: rangeError };
  const { start: rangeStart, end: rangeEnd } = resolveDateRange(start, end);

  const conditions = ['user_id = ?', 'metric_type = ?'];
  const params = [userId, 'steps'];
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
    `SELECT date, source, value, synced_at FROM wellness_data
      WHERE ${conditions.join(' AND ')}
      ORDER BY date ASC, source ASC`
  ).all(...params);

  const steps = rows.map(row => ({
    date: row.date,
    source: row.source,
    steps: row.value,
    synced_at: row.synced_at,
  }));
  return { start: rangeStart, end: rangeEnd, steps, count: steps.length };
}

export function registerGetSteps(server, { userId }) {
  server.registerTool(
    'get_steps',
    {
      title: 'Get Daily Steps',
      description:
        'Return persisted daily step observations from wellness data in an inclusive ' +
        'YYYY-MM-DD range. When both bounds are omitted, the range defaults to the ' +
        "last 90 days ending today in the server's timezone; a supplied bound leaves " +
        'the other side open. There is no maximum range. Each source is returned as a ' +
        'separate observation; values are not combined across sources, missing days are ' +
        'not returned as zero, and workout step fields are excluded.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        source: z.string().min(1).optional(),
      },
    },
    async ({ start, end, source }) => {
      const result = getStepsCore(userId, { start, end, source });
      if (result.error) return toolError(result.error);
      return toolResult(result);
    }
  );
}
