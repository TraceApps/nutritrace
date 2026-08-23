/**
 * MCP tool: list_diary_entries
 *
 * Return the food items logged on a given date. Reads from the same
 * diary row the frontend does (JSON blob per day). Returns items in
 * the order they were added, with resolved nutrition + timestamps.
 *
 * date defaults to today (server-local time). Format: YYYY-MM-DD.
 * Callers whose users are in a different timezone should pass an
 * explicit date rather than rely on the "today" default.
 *
 * Filters out tombstoned diary rows (deleted_at IS NOT NULL) so
 * agents don't see items the user has since deleted.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, safeJson, todayLocal, toolResult, toolError } from '../_util.js';

export function registerListDiary(server, { userId }) {
  server.registerTool(
    'list_diary_entries',
    {
      title: 'List Diary Entries',
      description:
        'Return the food items logged on a given date (YYYY-MM-DD, defaults to today in the SERVER\'s timezone). ' +
        'Each item includes name, meal slot, portion, unit, quantity, nutrition, and the ' +
        'timestamp it was added. Pass an explicit date for agents that need calendar accuracy in a different TZ.',
      inputSchema: {
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ date }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) {
        return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);
      }
      const row = db.prepare(
        `SELECT items FROM diary
          WHERE user_id = ? AND date = ? AND deleted_at IS NULL`
      ).get(userId, day);
      const items = row?.items ? safeJson(row.items, []) : [];
      return toolResult({ date: day, items, count: items.length });
    }
  );
}
