/**
 * MCP tool: list_diary_entries_range
 *
 * Return the food items logged for every diary row in an inclusive date
 * range. list_diary_entries remains the single-day compatibility API.
 */
import { z } from 'zod';
import db from '../../../db.js';
import {
  DATE_RE,
  safeJson,
  resolveDateRange,
  toolResult,
  toolError,
  validateDateRange,
} from '../_util.js';

// Full item lists are large, and an open range can span a whole diary.
// Past this many logged days the call asks for a narrower range instead of
// returning everything (or silently cutting it short).
export const MAX_RANGE_DAYS = 366;

export function registerListDiaryRange(server, { userId }) {
  server.registerTool(
    'list_diary_entries_range',
    {
      title: 'List Diary Entries by Date Range',
      description:
        'Return food items for every logged diary date in an inclusive ' +
        'YYYY-MM-DD range. When both are omitted, the range defaults to the ' +
        "last 90 days ending today in the server's timezone; a supplied bound " +
        `leaves the other side open. At most ${MAX_RANGE_DAYS} logged days per call; ` +
        'use get_daily_totals_range for longer spans.',
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
      const where = `WHERE user_id = ? AND ${conditions.join(' AND ')}`;
      const { days } = db.prepare(`SELECT COUNT(*) AS days FROM diary ${where}`).get(...params);
      if (days > MAX_RANGE_DAYS) {
        return toolError(
          `That range has ${days} logged days; the limit is ${MAX_RANGE_DAYS} per call. ` +
          'Narrow start/end, or use get_daily_totals_range for totals over longer spans.'
        );
      }
      const rows = db.prepare(
        `SELECT date, items FROM diary ${where}
          ORDER BY date ASC`
      ).all(...params);
      const entries = rows.map(row => {
        const items = safeJson(row.items, []);
        return { date: row.date, items, count: items.length };
      });
      return toolResult({ start: rangeStart, end: rangeEnd, entries, count: entries.length });
    }
  );
}
