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
 */
import db from '../../../db.js';
import { safeJson, toolResult } from '../_util.js';
import { describeGoals } from '../../../../src/lib/goal-resolver.js';
import { isValidTimeZone, processTimeZone, zonedParts } from '../../zoned-time.js';

// Today in the person's own time zone (Settings), else the server's.
function _userToday(userId) {
  let tz = null;
  try {
    const row = db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'timezone' AND deleted_at IS NULL`).get(userId);
    tz = row?.value ? safeJson(row.value, null) : null;
  } catch { /* fall back below */ }
  const p = zonedParts(Date.now(), typeof tz === 'string' && isValidTimeZone(tz) ? tz : processTimeZone());
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Core lookup, shared by the MCP tool below, the public REST API at
 * GET /api/v1/goals, and the goal.achieved webhook's target lookup in
 * routes/diary.js.
 */
export function getGoalsCore(userId) {
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
  // stored goals (which stay as they are for existing readers).
  return { goals, water_goal_ml: waterGoalMl, ...describeGoals(goals, _userToday(userId)) };
}

export function registerGetGoals(server, { userId }) {
  server.registerTool(
    'get_goals',
    {
      title: 'Get Goals',
      description:
        "Return the user's current macro / micronutrient / water goal targets. " +
        "Energy is always in kcal. Includes water goal in millilitres. " +
        "A goal with sharedGoal false has a target per weekday: its `days` list starts on Sunday " +
        "(index 0 = Sunday ... 6 = Saturday) and its max/min is the week's highest, not a day's target. " +
        "Read goals_by_weekday for the targets by named day and today.targets for today's.",
      inputSchema: {},
    },
    async () => {
      return toolResult(getGoalsCore(userId));
    }
  );
}
