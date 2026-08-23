/**
 * MCP tool: get_meal_details
 *
 * Return one saved meal's full contents: the meta plus every item in
 * its items[] array (name, portion, unit, quantity, per-item
 * nutrition, source food id when known). Useful for agents that want
 * to reason about what's IN a meal before logging it — e.g. "log this
 * meal minus the rice" (via a subsequent log_food per remaining item)
 * or "how much protein is in the chicken component".
 *
 * Does not expand ingredient trees for recipes; the items[] of a
 * recipe row lists its ingredients as stored, not their own sub-
 * ingredients.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError } from '../_util.js';

export function registerGetMealDetails(server, { userId }) {
  server.registerTool(
    'get_meal_details',
    {
      title: 'Get Meal Details',
      description:
        'Return one saved meal or recipe with its full items[] contents ' +
        '(name, portion, unit, quantity, per-item nutrition, source food ' +
        'id when known) plus the meal-level meta (servings, nutrition, ' +
        'notes, favorite, usage_count, last_used_at, is_recipe).',
      inputSchema: {
        meal_id: z.number().int().positive(),
      },
    },
    async ({ meal_id }) => {
      const row = db.prepare(
        `SELECT id, name, is_recipe, servings, portion, unit, notes, nutrition, items,
                favorite, usage_count, last_used_at, created_at, updated_at
           FROM meals
          WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
      ).get(userId, meal_id);
      if (!row) return toolError(`meal_id ${meal_id} not found in your catalog.`);
      const items = safeJson(row.items, []).map(it => ({
        id: typeof it?.id === 'number' ? it.id : null,
        food_server_id: typeof it?.food_server_id === 'number' ? it.food_server_id : null,
        name: it?.name || null,
        brand: it?.brand || null,
        portion: Number.isFinite(Number(it?.portion)) ? Number(it.portion) : null,
        unit: it?.unit || null,
        quantity: Number.isFinite(Number(it?.quantity)) ? Number(it.quantity) : null,
        nutrition: it?.nutrition || {},
      }));
      return toolResult({
        id: row.id,
        name: row.name,
        is_recipe: !!row.is_recipe,
        servings: Number.isFinite(Number(row.servings)) ? Number(row.servings) : null,
        portion: Number.isFinite(Number(row.portion)) ? Number(row.portion) : null,
        unit: row.unit || null,
        notes: row.notes || null,
        nutrition: safeJson(row.nutrition, {}),
        favorite: !!row.favorite,
        usage_count: Number(row.usage_count) || 0,
        last_used_at: row.last_used_at || null,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        item_count: items.length,
        items,
      });
    }
  );
}
