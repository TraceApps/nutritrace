/**
 * MCP tool: get_goals
 *
 * Returns the user's macro / micronutrient / water goal targets. Same
 * source of truth as the Goals page (user_settings.goals key). All
 * energy values are returned in kcal (canonical storage per #146); the
 * caller can convert to kJ if it prefers.
 *
 * Filters out tombstoned user_settings rows (deleted_at IS NOT NULL)
 * so agents don't see values a user has since reset.
 *
 * With no arguments the response is the current-goals one, as it always
 * was. `date` and `start`+`end` read the targets that were in effect on a
 * past day (lib/goal-history.js), which is what a report on older intake
 * needs: today's goal is not the target of last month.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError, DATE_RE } from '../_util.js';
import { describeGoals } from '../../../../src/lib/goal-resolver.js';
import { currentUserToday, effectiveGoalsForDate, effectiveGoalsForRange } from '../../goal-history.js';

/**
 * Core lookup, shared by the MCP tool below, the public REST API at
 * GET /api/v1/goals, and the goal.achieved webhook's target lookup in
 * routes/diary.js.
 *
 * No query args intentionally returns the current-goals shape:
 *   { goals, water_goal_ml, weekday_order, goals_by_weekday, today }
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
  // Preserve legitimate 0 (user explicitly cleared their water goal),
  // don't treat it as falsy. But also don't collapse a JSON `null`
  // value into 0 via `Number(null)`, parse first, then keep the
  // result only if it's actually a finite number.
  let waterGoalMl = null;
  if (water?.value != null) {
    const parsed = safeJson(water.value, null);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) waterGoalMl = parsed;
  }
  // #285: weekday goals by name and today's targets, added beside the
  // stored goals (which stay as they are for existing readers). The day is
  // the one this answer always used (the account's zone, else the server's);
  // the dated forms use UTC when the account has no zone, so they agree with
  // the phone (goal-history.js currentUserToday).
  return { goals, water_goal_ml: waterGoalMl, ...describeGoals(goals, currentUserToday(userId)) };
}

export function registerGetGoals(server, { userId }) {
  server.registerTool(
    'get_goals',
    {
      title: 'Get Goals',
      description:
        "Return the user's nutrition goals. With no arguments this preserves the current-goals " +
        "response (goals + water_goal_ml). Pass date for the targets effective on one local " +
        "calendar day, or start+end for an inclusive range; a past day's targets are the ones " +
        "in effect then, with weekday splits, percent macros, Dynamic/Adaptive calorie modes and " +
        "the activity adjustment already resolved. A snapshot is effective from its YYYY-MM-DD " +
        "date through the day before the next snapshot; several changes in one day collapse to " +
        "that day's final configuration. A date before history_available_from returns " +
        "known=false rather than today's goals. " +
        "A goal with sharedGoal false has a target per weekday: its `days` list starts on Sunday " +
        "(index 0 = Sunday ... 6 = Saturday) and its max/min is the week's highest, not a day's target. " +
        "Read goals_by_weekday for the targets by named day and today.targets for today's.",
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
