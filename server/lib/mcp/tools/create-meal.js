/**
 * MCP tool: create_meal (Phase 3, destructive)
 *
 * Save a meal (a bundle of foods logged together) or a recipe (a dish
 * split into servings) to the user's catalog, the same row MealEditor
 * saves. Ingredients come from the user's own foods (food_id) or recipes
 * (recipe_id). Nutrition is computed from them: a meal stores the total,
 * a recipe stores one serving's share.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { resolveNewItemVisibility } from '../../default-visibility.js';
import { mealItemSchema, buildMealItems, sumNutrition, totalGrams, perServing } from '../_meal-items.js';

export function registerCreateMeal(server, { userId }) {
  server.registerTool(
    'create_meal',
    {
      title: 'Create Meal or Recipe',
      description:
        "Save a meal or recipe to the user's catalog. Each item is a food_id (from " +
        'search_foods) with an optional portion in the food\'s unit and/or quantity, or a ' +
        'recipe_id (from search_meals with include_recipes) with quantity = servings. ' +
        'is_recipe=false (default) saves a meal: log_meal adds each item to the diary. ' +
        'is_recipe=true saves a recipe with `servings` (default 1): nutrition is stored per ' +
        'serving and log_meal adds it as one diary item. total_weight (grams of the whole ' +
        'cooked batch) sets the per-serving weight; it defaults to the ingredients\' summed ' +
        'weight. Refuses a duplicate name. Requires confirm=true.',
      inputSchema: {
        confirm:      z.boolean(),
        name:         z.string().min(1).max(200),
        is_recipe:    z.boolean().optional(),
        servings:     z.number().int().min(1).max(1000).optional(),
        total_weight: z.number().positive().max(100000).optional(),
        items:        z.array(mealItemSchema).min(1).max(100),
        notes:        z.string().max(2000).optional(),
      },
    },
    async ({ confirm, name, is_recipe, servings, total_weight, items, notes }) => {
      if (confirm !== true) {
        return toolError('create_meal requires confirm=true. Set it and re-invoke if you\'re sure.');
      }
      const cleanName = name.trim();
      if (!cleanName) return toolError('name is required and cannot be blank.');
      const recipe = is_recipe === true;
      if (!recipe && (servings != null || total_weight != null)) {
        return toolError('servings and total_weight only apply to recipes (is_recipe=true).');
      }

      const existing = db.prepare(
        `SELECT id FROM meals
          WHERE user_id = ? AND deleted_at IS NULL AND is_recipe = ? AND LOWER(name) = LOWER(?)
          LIMIT 1`
      ).get(userId, recipe ? 1 : 0, cleanName);
      if (existing) {
        return toolError(`A ${recipe ? 'recipe' : 'meal'} named '${cleanName}' already exists (id=${existing.id}). Use update_meal to change it.`);
      }

      let built;
      try { built = buildMealItems(userId, items); } catch (e) { return toolError(e.message); }

      const totals = sumNutrition(built);
      const yields = recipe ? (servings ?? 1) : 1;
      const nutrition = recipe ? perServing(totals, yields) : perServing(totals, 1);
      const portion = recipe ? Math.round(((total_weight ?? totalGrams(built)) || 100) / yields * 100) / 100 : 100;

      const result = db.prepare(
        `INSERT INTO meals (user_id, name, nutrition, items, notes, is_recipe, portion, unit, servings, visibility, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'g', ?, ?, datetime('now'))`
      ).run(
        userId, cleanName, JSON.stringify(nutrition), JSON.stringify(built), notes || null,
        recipe ? 1 : 0, portion, recipe ? yields : null, resolveNewItemVisibility(userId),
      );

      return toolResult({
        ok: true,
        created: {
          id: result.lastInsertRowid,
          name: cleanName,
          is_recipe: recipe,
          servings: recipe ? yields : undefined,
          portion: recipe ? portion : undefined,
          unit: recipe ? 'g' : undefined,
          nutrition,
          items: built.map(it => ({ name: it.name, portion: it.portion, unit: it.unit, is_recipe: !!it.is_recipe })),
        },
      });
    }
  );
}
