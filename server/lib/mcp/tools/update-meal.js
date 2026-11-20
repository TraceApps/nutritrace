/**
 * MCP tool: update_meal (Phase 3, destructive)
 *
 * Patch a saved meal or recipe: rename, notes, servings, batch weight,
 * or replace its ingredient list. Nutrition is recomputed when items
 * change. Changing only a recipe's servings keeps the batch the same
 * and re-splits it, as MealEditor does. Diary entries already logged
 * keep their snapshot and don't change.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError } from '../_util.js';
import { mealItemSchema, buildMealItems, sumNutrition, totalGrams, perServing } from '../_meal-items.js';

export function registerUpdateMeal(server, { userId }) {
  server.registerTool(
    'update_meal',
    {
      title: 'Update Meal or Recipe',
      description:
        'Change a saved meal or recipe (meal_id from search_meals). Every field is optional: ' +
        'name, notes, items (replaces the whole ingredient list; same item shape as ' +
        'create_meal), and for recipes servings and total_weight (grams of the whole batch). ' +
        'New items recompute nutrition; new servings alone re-split the same batch. A recipe ' +
        'imported from CookTrace is overwritten by its next re-import. Already-logged diary ' +
        'entries are not changed. Requires confirm=true.',
      inputSchema: {
        confirm:      z.boolean(),
        meal_id:      z.number().int().positive(),
        name:         z.string().min(1).max(200).optional(),
        notes:        z.string().max(2000).nullable().optional(),
        servings:     z.number().int().min(1).max(1000).optional(),
        total_weight: z.number().positive().max(100000).optional(),
        items:        z.array(mealItemSchema).min(1).max(100).optional(),
      },
    },
    async ({ confirm, meal_id, name, notes, servings, total_weight, items }) => {
      if (confirm !== true) {
        return toolError('update_meal requires confirm=true. Set it and re-invoke if you\'re sure.');
      }
      const row = db.prepare(
        `SELECT id, name, nutrition, items, notes, is_recipe, portion, servings
           FROM meals
          WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
      ).get(userId, meal_id);
      if (!row) return toolError(`meal_id ${meal_id} not found in your catalog.`);
      const recipe = !!row.is_recipe;
      if (!recipe && (servings != null || total_weight != null)) {
        return toolError('servings and total_weight only apply to recipes.');
      }
      if (name == null && notes === undefined && servings == null && total_weight == null && !items) {
        return toolError('Nothing to change: pass at least one of name, notes, servings, total_weight, items.');
      }
      if (items?.some(it => it.recipe_id === meal_id)) {
        return toolError('A recipe cannot contain itself.');
      }

      const nextName = name?.trim() || row.name;
      if (name != null && nextName.toLowerCase() !== row.name.toLowerCase()) {
        const clash = db.prepare(
          `SELECT id FROM meals
            WHERE user_id = ? AND deleted_at IS NULL AND is_recipe = ? AND LOWER(name) = LOWER(?) AND id != ?
            LIMIT 1`
        ).get(userId, row.is_recipe, nextName, meal_id);
        if (clash) return toolError(`Another ${recipe ? 'recipe' : 'meal'} is already named '${nextName}' (id=${clash.id}).`);
      }

      const oldYields = row.servings || 1;
      const yields = recipe ? (servings ?? oldYields) : 1;
      let nextItems = safeJson(row.items, []);
      let nutrition = safeJson(row.nutrition, {});
      let portion = row.portion;

      if (items) {
        try { nextItems = buildMealItems(userId, items); } catch (e) { return toolError(e.message); }
        nutrition = perServing(sumNutrition(nextItems), yields);
        if (recipe) portion = ((total_weight ?? totalGrams(nextItems)) || 100) / yields;
      } else if (recipe && (servings != null || total_weight != null)) {
        const batch = perServing(nutrition, 1 / oldYields);
        nutrition = perServing(batch, yields);
        portion = (total_weight ?? (Number(row.portion) || 100) * oldYields) / yields;
      }
      if (recipe) portion = Math.round(portion * 100) / 100;

      db.prepare(
        `UPDATE meals SET name = ?, nutrition = ?, items = ?, notes = ?, portion = ?, servings = ?, updated_at = datetime('now')
          WHERE user_id = ? AND id = ?`
      ).run(
        nextName, JSON.stringify(nutrition), JSON.stringify(nextItems),
        notes === undefined ? row.notes : (notes || null),
        portion, recipe ? yields : row.servings, userId, meal_id,
      );

      return toolResult({
        ok: true,
        updated: {
          id: meal_id,
          name: nextName,
          is_recipe: recipe,
          servings: recipe ? yields : undefined,
          portion: recipe ? portion : undefined,
          nutrition,
          item_count: nextItems.length,
        },
      });
    }
  );
}
