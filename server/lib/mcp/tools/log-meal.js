/**
 * MCP tool: log_meal (Phase 2, write)
 *
 * Expand a saved meal's items into a diary day. A recipe
 * (is_recipe = 1) is logged the way the app logs one (#331): a single
 * diary entry with the servings as its quantity, its per-serving
 * nutrition and portion, not its ingredients one by one.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, safeJson, todayLocal, toolResult, toolError, isCalendarDate } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';
import { dispatchWebhookEvent } from '../../webhooks.js';
import { checkNutritionGoalCrossing } from '../../goal-webhook.js';
import { getGoalsCore } from './goals.js';
import { dailyTotalsCore } from './daily-totals.js';

/**
 * Core write, shared by the MCP tool below and the public REST API at
 * POST /api/v1/diary/:date/meal. Throws a plain Error on bad input.
 */
// #277: which food (or recipe) an ingredient is, by the server's id, so a
// logged item names it the way log_food's do. A meal saved in the browser
// keeps the server's id in `id`; one saved in the Android app keeps the
// phone's own there and the server's in `server_id` (null: not on the
// server yet, so the phone's id is all it has). Same rule as
// src/lib/coach-plans.js ingredientFoodId.
function ingredientServerId(it) {
  if (!it || typeof it !== 'object') return null;
  if (typeof it.food_server_id === 'number') return it.food_server_id;
  if ('server_id' in it) return typeof it.server_id === 'number' ? it.server_id : null;
  return typeof it.id === 'number' ? it.id : null;
}

export function logMealCore(userId, { meal_id, date, meal, servings } = {}) {
  const day = date || todayLocal();
  if (!isCalendarDate(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);

  const savedMeal = db.prepare(
    `SELECT id, name, items, is_recipe, nutrition, portion, unit, img_url
       FROM meals
      WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
  ).get(userId, meal_id);
  if (!savedMeal) throw new Error(`meal_id ${meal_id} not found in your catalog.`);
  if (servings != null && !(typeof servings === 'number' && servings > 0 && servings <= 100)) {
    throw new Error('servings must be a number above 0 and at most 100.');
  }
  if (servings != null && !savedMeal.is_recipe) {
    throw new Error(`meal_id ${meal_id} is a meal, not a recipe; servings is for recipes.`);
  }

  const now = new Date().toISOString();
  const override = Number.isInteger(meal) ? meal : null;
  let cloned;
  if (savedMeal.is_recipe) {
    // One entry, as the app adds a recipe: per-serving nutrition and
    // portion, the servings eaten as its quantity.
    cloned = [{
      id: savedMeal.id,
      food_server_id: savedMeal.id,
      is_recipe: 1,
      name: savedMeal.name,
      meal: override ?? 0,
      quantity: servings ?? 1,
      portion: Number(savedMeal.portion) || undefined,
      unit: savedMeal.unit || undefined,
      nutrition: safeJson(savedMeal.nutrition, {}),
      imgUrl: savedMeal.img_url || undefined,
      addedAt: now,
      source: 'mcp:meal',
      source_meal_id: savedMeal.id,
    }];
  } else {
    const sourceItems = safeJson(savedMeal.items, []);
    if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
      throw new Error(`Meal '${savedMeal.name}' has no items to log.`);
    }
    cloned = sourceItems.map((it, i) => ({
      ...it,
      food_server_id: ingredientServerId(it),
      meal: override ?? (Number.isInteger(it.meal) ? it.meal : 0),
      addedAt: new Date(Date.parse(now) + i).toISOString(),
      source: it.source || 'mcp:meal',
      source_meal_id: savedMeal.id,
    }));
  }

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
      is_recipe: !!savedMeal.is_recipe,
      servings: savedMeal.is_recipe ? (servings ?? 1) : undefined,
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
        "Log a saved meal or recipe from the user's meals table to a diary " +
        'day. A meal adds every one of its items; a recipe adds one entry, ' +
        'servings of it (default 1, may be a fraction: 1 of a 4-serving ' +
        'recipe is a quarter of it). Meal slot defaults to 0 (Breakfast); the ' +
        'same slot is applied to every item. Date defaults to today.',
      inputSchema: {
        meal_id: z.number().int().positive(),
        date:    z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        meal:    z.number().int().min(0).max(9).optional(),
        servings: z.number().positive().max(100).optional(),
      },
    },
    async ({ meal_id, date, meal, servings }) => {
      try {
        return toolResult(logMealCore(userId, { meal_id, date, meal, servings }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
