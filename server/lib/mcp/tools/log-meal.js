/**
 * MCP tool: log_meal (Phase 2, write)
 *
 * Expand a saved meal's items into a diary day. Meals are stored in
 * the `meals` table with `is_recipe = 0`; recipes (is_recipe = 1) are
 * intentionally not supported here because "log a recipe" has different
 * semantics (portion of yield) and would need Phase-3-level UX to be
 * safe. Agents that want to log a recipe should call log_food on the
 * recipe's component foods instead.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, safeJson, todayLocal, toolResult, toolError } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';
import { dispatchWebhookEvent } from '../../webhooks.js';
import { checkNutritionGoalCrossing } from '../../goal-webhook.js';
import { getGoalsCore } from './goals.js';
import { dailyTotalsCore } from './daily-totals.js';

/**
 * Core write, shared by the MCP tool below and the public REST API at
 * POST /api/v1/diary/:date/meal. Throws a plain Error on bad input.
 */
export function logMealCore(userId, { meal_id, date, meal } = {}) {
  const day = date || todayLocal();
  if (!DATE_RE.test(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);

  const savedMeal = db.prepare(
    `SELECT id, name, items, is_recipe
       FROM meals
      WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
  ).get(userId, meal_id);
  if (!savedMeal) throw new Error(`meal_id ${meal_id} not found in your catalog.`);
  if (savedMeal.is_recipe) {
    throw new Error(
      `meal_id ${meal_id} is a recipe. Log its component foods with log_food, ` +
      'or use the app UI to log a recipe portion.'
    );
  }

  const sourceItems = safeJson(savedMeal.items, []);
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    throw new Error(`Meal '${savedMeal.name}' has no items to log.`);
  }

  const now = new Date().toISOString();
  const override = Number.isInteger(meal) ? meal : null;
  const cloned = sourceItems.map((it, i) => ({
    ...it,
    meal: override ?? (Number.isInteger(it.meal) ? it.meal : 0),
    addedAt: new Date(Date.parse(now) + i).toISOString(),
    source: it.source || 'mcp:meal',
    source_meal_id: savedMeal.id,
  }));

  // Snapshot pre-write totals for the goal.achieved webhook, before the
  // mutation below changes them. Never let this block the actual write.
  let beforeTotals = null, goals = null;
  try {
    beforeTotals = dailyTotalsCore(userId, { date: day }).totals;
    ({ goals } = getGoalsCore(userId));
  } catch (e) { /* never let a webhook failure block the save */ }

  let next;
  try {
    next = mutateDiaryDay(userId, day, cur => ({
      ...cur,
      items: [...cur.items, ...cloned],
    }));
  } catch (e) {
    if (e instanceof DiaryTombstonedError) throw new Error(e.message);
    throw e;
  }

  try {
    dispatchWebhookEvent(userId, 'meal.logged', { date: day, items: cloned });
    if (beforeTotals && goals) {
      const after = dailyTotalsCore(userId, { date: day });
      checkNutritionGoalCrossing(userId, day, goals, beforeTotals, after.totals);
    }
  } catch (e) { /* never let a webhook failure block the save */ }

  return {
    ok: true,
    date: day,
    logged: {
      meal_id: savedMeal.id,
      name: savedMeal.name,
      slot_override: override,
      item_count: cloned.length,
    },
    total_items_on_day: next.items.length,
  };
}

export function registerLogMeal(server, { userId }) {
  server.registerTool(
    'log_meal',
    {
      title: 'Log Saved Meal',
      description:
        "Append every item from a saved meal to a diary day. meal_id must be " +
        "a saved meal (is_recipe = 0) from the user's meals table; recipes are " +
        'not supported by this tool. Meal slot defaults to 0 (Breakfast); the ' +
        'same slot is applied to every item. Date defaults to today.',
      inputSchema: {
        meal_id: z.number().int().positive(),
        date:    z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        meal:    z.number().int().min(0).max(9).optional(),
      },
    },
    async ({ meal_id, date, meal }) => {
      try {
        return toolResult(logMealCore(userId, { meal_id, date, meal }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
