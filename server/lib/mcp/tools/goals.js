/**
 * MCP tool: get_goals
 *
 * With no arguments, preserves the long-standing current-goals response.
 * With date or start/end, returns effective-dated historical targets from
 * NutriTrace's own goal history, including resolved daily calorie/macro goals.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError, DATE_RE } from '../_util.js';
import { effectiveGoalsForDate, effectiveGoalsForRange } from '../../goal-history.js';

/**
 * Shared core for MCP + GET /api/v1/goals.
 *
 * No query args intentionally returns the exact legacy shape:
 *   { goals, water_goal_ml }
 *
 * Historical forms:
 *   { date: YYYY-MM-DD }
 *   { start: YYYY-MM-DD, end: YYYY-MM-DD }
 */
export function getGoalsCore(userId, { date, start, end } = {}) {
  if (date) {
    if (start || end) throw new Error('Use either date or start/end, not both.');
    return effectiveGoalsForDate(userId, date);
  }
  if (start || end) {
    if (!start || !end) throw new Error('Both start and end are required for a goal-history range.');
    return effectiveGoalsForRange(userId, start, end);
  }

  const row = db.prepare(
    `SELECT value FROM user_settings
      WHERE user_id = ? AND key = 'goals' AND deleted_at IS NULL`
  ).get(userId);
  const water = db.prepare(
    `SELECT value FROM user_settings
      WHERE user_id = ? AND key = 'waterGoalMl' AND deleted_at IS NULL`
  ).get(userId);
  const goals = row?.value ? safeJson(row.value, {}) : {};

  let waterGoalMl = null;
  if (water?.value != null) {
    const parsed = safeJson(water.value, null);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) waterGoalMl = parsed;
  }
  return { goals, water_goal_ml: waterGoalMl };
}

export function registerGetGoals(server, { userId }) {
  server.registerTool(
    'get_goals',
    {
      title: 'Get Goals',
      description:
        "Return the user's nutrition goals. With no arguments this preserves the current-goals " +
        "response (goals + water_goal_ml). Pass date for the targets effective on one local " +
        "calendar day, or start+end for an inclusive range. Historical results resolve weekday " +
        "splits, percent macros, Dynamic/Adaptive calorie modes, and activity adjustment using " +
        "NutriTrace data. A snapshot is effective from its YYYY-MM-DD date through the day before " +
        "the next snapshot; multiple edits on one day collapse to that day's final configuration. " +
        "Dates before history_available_from return known=false rather than guessing today's goals.",
      inputSchema: {
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        start: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        end: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async (args = {}) => {
      try {
        return toolResult(getGoalsCore(userId, args));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
