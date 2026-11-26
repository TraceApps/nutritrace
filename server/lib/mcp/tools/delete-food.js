/**
 * MCP tool: delete_food (Phase 3, destructive) — #331
 *
 * Remove a food from the user's catalog, so an assistant can take back a
 * mistaken create_food. A soft delete through the same code as
 * DELETE /api/foods/:id (lib/food-save.js), so phones sync it. Diary
 * entries and meals that use the food keep their own copy of it.
 *
 * Returns the removed food so an agent can offer "undo" via create_food.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError } from '../_util.js';
import { deleteFood } from '../../food-save.js';
import { ingredientServerId } from './log-meal.js';

export function registerDeleteFood(server, { userId }) {
  server.registerTool(
    'delete_food',
    {
      title: 'Delete Food',
      description:
        "Remove a food from the user's catalog (food_id from search_foods). " +
        'Diary entries and saved meals or recipes that use it keep their own ' +
        'copy; the response lists those meals. Requires confirm=true. Returns ' +
        'the removed food so you can offer "undo" via create_food.',
      inputSchema: {
        food_id: z.number().int().positive(),
        confirm: z.boolean(),
      },
    },
    async ({ food_id, confirm }) => {
      if (confirm !== true) {
        return toolError(
          'delete_food requires confirm=true. This safeguards against ' +
          'accidental destructive tool calls. Set the confirm argument to true ' +
          "and re-invoke if you're sure."
        );
      }
      const food = db.prepare(
        'SELECT * FROM foods WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
      ).get(userId, food_id);
      if (!food) return toolError(`food_id ${food_id} not found in your catalog.`);

      const usedIn = db.prepare(
        'SELECT id, name, is_recipe, items FROM meals WHERE user_id = ? AND deleted_at IS NULL'
      ).all(userId)
        .filter(m => safeJson(m.items, []).some(it => !it?.is_recipe && ingredientServerId(it) === food.id))
        .map(m => ({ meal_id: m.id, name: m.name, is_recipe: !!m.is_recipe }));

      deleteFood(food.id);
      return toolResult({
        ok: true,
        removed: {
          id: food.id,
          name: food.name,
          brand: food.brand || null,
          portion: food.portion,
          unit: food.unit,
          nutrition: safeJson(food.nutrition, {}),
          barcode: food.barcode || null,
          notes: food.notes || null,
        },
        still_in_meals: usedIn.length ? usedIn : undefined,
      });
    }
  );
}
