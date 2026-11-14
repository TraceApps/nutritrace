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
 *
 * #207 completion marks are included read-only, so clients can tell a
 * day the user has closed from one still being logged:
 *   completion_enabled  the user's Show Day Completion preference as the
 *                       server has it stored: true / false, or null when
 *                       it has never reached the server (see below)
 *   completed_at        the day's stored mark, passed through as stored,
 *                       or null when the day is open / has no row
 *   completed_meals     marked meal slot indexes, sorted; [] when none
 * A non-null completed_at is the mark itself; completion_enabled only
 * tells a client whether a null one means "open" or "not tracked".
 *
 * null rather than the app's default (false) because the server can lack
 * the preference while the app has it on: single-user mode keeps settings
 * in the browser only, and enabling user management moves them to the new
 * account's local prefix (SettingsUserManagement → migrateSettingsPrefix)
 * without sending them to the server. Reporting false there would say
 * "not tracked" about days the user is closing.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, safeJson, todayLocal, toolResult, toolError, isCalendarDate } from '../_util.js';

/**
 * Core lookup, shared by the MCP tool below and the public REST API at
 * GET /api/v1/diary/:date. Throws a plain Error on bad input so callers
 * on either side can decide how to surface it.
 */
export function listDiaryCore(userId, { date } = {}) {
  const day = date || todayLocal();
  if (!isCalendarDate(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);

  const row = db.prepare(
    `SELECT items, completed_at, completed_meals FROM diary
      WHERE user_id = ? AND date = ? AND deleted_at IS NULL`
  ).get(userId, day);
  const items = row?.items ? safeJson(row.items, []) : [];
  return {
    date: day, items, count: items.length,
    completion_enabled: completionEnabled(userId),
    completed_at: row?.completed_at || null,
    completed_meals: completedMeals(row?.completed_meals),
  };
}

// Same validation as the Diary route's parse(): a malformed value reads
// as no marked meals rather than failing the whole request.
function completedMeals(raw) {
  const arr = raw ? safeJson(raw, []) : [];
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter(n => Number.isInteger(n) && n >= 0 && n <= 31))].sort((a, b) => a - b);
}

function completionEnabled(userId) {
  const row = db.prepare(
    `SELECT value FROM user_settings
      WHERE user_id = ? AND key = 'diaryShowCompletion' AND deleted_at IS NULL`
  ).get(userId);
  const value = row?.value ? safeJson(row.value, null) : null;
  return typeof value === 'boolean' ? value : null;
}

export function registerListDiary(server, { userId }) {
  server.registerTool(
    'list_diary_entries',
    {
      title: 'List Diary Entries',
      description:
        'Return the food items logged on a given date (YYYY-MM-DD, defaults to today in the SERVER\'s timezone). ' +
        'Each item includes name, meal slot, portion, unit, quantity, nutrition, and the ' +
        'timestamp it was added. Pass an explicit date for agents that need calendar accuracy in a different TZ. ' +
        'Also returns the day\'s completion marks: completed_at (null while open), completed_meals (marked meal slots) ' +
        'and completion_enabled (whether the user tracks completion at all; null when not known to the server).',
      inputSchema: {
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ date }) => {
      try {
        return toolResult(listDiaryCore(userId, { date }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
