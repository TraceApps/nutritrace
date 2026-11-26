/**
 * MCP tool: create_meal (Phase 3, destructive) — #331
 *
 * Save a new meal or recipe from foods in the user's catalog, so an
 * assistant can keep a home-cooked dish with its ingredient list instead
 * of one create_food entry with summed nutrition. Under mcp:destroy with
 * confirm=true like create_food: the row persists and shows up in every
 * picker.
 *
 * Items and nutrition are built as the meal editor builds them
 * (_meal-items.js), and the row is saved through the same code as
 * POST /api/meals (lib/meal-save.js), so retries, sharing and sync
 * behave the same.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { createMeal } from '../../meal-save.js';
import { buildMealItems, mealTotals, itemSpec } from '../_meal-items.js';
import { getMealDetailsCore } from './get-meal-details.js';

export function registerCreateMeal(server, { userId }) {
  server.registerTool(
    'create_meal',
    {
      title: 'Create Meal or Recipe',
      description:
        "Save a new meal or recipe made of foods from the user's catalog. " +
        'Each item is a food_id with an optional portion (an amount in that ' +
        "food's own unit, default its portion) and quantity (multiplies the " +
        'portion, default 1); nutrition is worked out on the server. ' +
        'is_recipe=true saves a recipe: servings is how many servings the ' +
        'whole dish makes, and it stores per-serving nutrition, so logging ' +
        '1 with log_meal logs one serving. total_amount (grams) overrides the ' +
        'summed weight of the finished dish. Requires confirm=true. Refuses a ' +
        'name already used by a meal or recipe; call search_meals with ' +
        'include_recipes=true first.',
      inputSchema: {
        confirm:      z.boolean(),
        name:         z.string().min(1).max(200),
        is_recipe:    z.boolean().optional(),
        servings:     z.number().int().min(1).max(1000).optional(),
        total_amount: z.number().positive().max(100000).optional(),
        items:        z.array(itemSpec).min(1).max(100),
        notes:        z.string().max(1000).optional(),
      },
    },
    async ({ confirm, name, is_recipe, servings, total_amount, items, notes }) => {
      if (confirm !== true) {
        return toolError(
          'create_meal requires confirm=true. This safeguards against accidental ' +
          "catalog pollution. Set the confirm argument to true and re-invoke if you're sure."
        );
      }
      const cleanName = name.trim();
      if (!cleanName) return toolError('name is required and cannot be blank.');
      const isRecipe = !!is_recipe;
      if (!isRecipe && (servings != null || total_amount != null)) {
        return toolError('servings and total_amount are for recipes; set is_recipe=true or leave them out.');
      }

      const existing = db.prepare(
        `SELECT id, is_recipe FROM meals
          WHERE user_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?)
          LIMIT 1`
      ).get(userId, cleanName);
      if (existing) {
        return toolError(
          `A ${existing.is_recipe ? 'recipe' : 'meal'} named '${cleanName}' already exists ` +
          `(meal_id=${existing.id}). Use update_meal to change it, or pick another name.`
        );
      }

      const built = buildMealItems(userId, items);
      if (built.error) return toolError(built.error);
      const totals = mealTotals(built.items, { isRecipe, servings: servings ?? null, totalAmount: total_amount ?? null });

      const { row } = createMeal(userId, {
        name: cleanName,
        items: built.items,
        is_recipe: isRecipe,
        notes: notes?.trim() || null,
        ...totals,
      }, null);

      return toolResult({ ok: true, created: getMealDetailsCore(userId, { meal_id: row.id }) });
    }
  );
}
