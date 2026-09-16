/**
 * MCP tool: get_daily_totals_range
 *
 * Return calculated nutrition totals for every diary row in an inclusive
 * date range. get_daily_totals remains the single-day compatibility API.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { Nutrition } from '../../../../src/lib/nutrition.js';
import {
  DATE_RE,
  safeJson,
  resolveDateRange,
  toolResult,
  toolError,
  validateDateRange,
} from '../_util.js';

function totalsFor(row) {
  const items = safeJson(row.items, []);
  const waterLogs = safeJson(row.water, []);
  const totals = Nutrition.sum(items.map(i => Nutrition.calculate(i)));
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 10) / 10;
  const water_ml = waterLogs.reduce((sum, log) => sum + (Number(log.amount) || 0), 0);
  return { date: row.date, totals, water_ml, item_count: items.length };
}

export function registerDailyTotalsRange(server, { userId }) {
  server.registerTool(
    'get_daily_totals_range',
    {
      title: 'Get Daily Totals by Date Range',
      description:
        'Calculate nutrition totals for every logged diary date in an inclusive ' +
        'YYYY-MM-DD range. When both are omitted, the range defaults to the ' +
        "last 90 days ending today in the server's timezone; a supplied bound " +
        'leaves the other side open. There is no maximum range.',
      inputSchema: {
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ start, end }) => {
      const { start: rangeStart, end: rangeEnd } = resolveDateRange(start, end);
      const rangeError = validateDateRange(rangeStart, rangeEnd);
      if (rangeError) return toolError(rangeError);

      const conditions = ['deleted_at IS NULL'];
      const params = [userId];
      if (rangeStart != null) {
        conditions.push('date >= ?');
        params.push(rangeStart);
      }
      if (rangeEnd != null) {
        conditions.push('date <= ?');
        params.push(rangeEnd);
      }
      const rows = db.prepare(
        `SELECT date, items, water FROM diary
          WHERE user_id = ? AND ${conditions.join(' AND ')}
          ORDER BY date ASC`
      ).all(...params);
      const totals = rows.map(totalsFor);
      return toolResult({ start: rangeStart, end: rangeEnd, totals, count: totals.length });
    }
  );
}
