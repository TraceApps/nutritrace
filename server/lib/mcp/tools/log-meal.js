/**
 * MCP tool: log_meal (Phase 2, write)
 *
 * Expand a saved meal's items into a diary day. A recipe (is_recipe = 1)
 * is logged the way the app's Foods picker logs it: one diary item for
 * `servings` servings of the recipe's per-serving nutrition.
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

export function buildMealEntry(userId, { meal_id, date, meal, servings, notes } = {}) {
  const day = date || todayLocal();
  if (!isCalendarDate(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);

  const savedMeal = db.prepare(
    `SELECT id, name, items, is_recipe, portion, unit, nutrition
       FROM meals
      WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
  ).get(userId, meal_id);
  if (!savedMeal) throw new Error(`meal_id ${meal_id} not found in your catalog.`);
  if (servings != null && !(Number.isFinite(servings) && servings > 0 && servings <= 100)) {
    throw new Error('servings must be a number above 0 and at most 100.');
  }
  if (notes != null && (typeof notes !== 'string' || notes.length > 500)) {
    throw new Error('notes must be a string of at most 500 characters.');
  }
  if (servings != null && !savedMeal.is_recipe) {
    throw new Error(`servings only applies to recipes; '${savedMeal.name}' is a meal.`);
  }

  const now = new Date().toISOString();
  const override = Number.isInteger(meal) ? meal : null;
  let cloned;
  if (savedMeal.is_recipe) {
    cloned = [{
      id: savedMeal.id,
      food_server_id: savedMeal.id,
      is_recipe: 1,
      name: savedMeal.name,
      meal: override ?? 0,
      quantity: servings ?? 1,
      portion: savedMeal.portion ?? 100,
      unit: savedMeal.unit || 'g',
      nutrition: safeJson(savedMeal.nutrition, {}),
      notes: notes || undefined,
      addedAt: now,
      source: 'mcp',
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
      ...(i === 0 && notes ? { notes } : {}),
    }));
  }
  return { day, cloned, savedMeal, override };
}

export function logMealCore(userId, args = {}) {
  const { day, cloned, savedMeal, override } = buildMealEntry(userId, args);
  const { servings } = args;

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
        'Log a saved meal or recipe (meal_id from search_meals; pass include_recipes ' +
        'to find recipes) to a diary day. A meal appends each of its items; a recipe ' +
        'appends one item for `servings` servings (default 1, fractions allowed). ' +
        'notes go on the recipe item, or on the first item of a meal. Meal slot ' +
        'defaults to 0 (Breakfast); the same slot is applied to every item. Date ' +
        'defaults to today.',
      inputSchema: {
        meal_id: z.number().int().positive(),
        date:    z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        meal:    z.number().int().min(0).max(9).optional(),
        servings: z.number().positive().max(100).optional(),
        notes:   z.string().max(500).optional(),
      },
    },
    async ({ meal_id, date, meal, servings, notes }) => {
      try {
        return toolResult(logMealCore(userId, { meal_id, date, meal, servings, notes }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
