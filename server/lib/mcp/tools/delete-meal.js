/**
 * MCP tool: delete_meal (Phase 3, destructive) — #331
 *
 * Remove a saved meal or recipe. A soft delete through the same code as
 * DELETE /api/meals/:id (lib/meal-save.js), so phones sync it. Diary
 * entries logged from it keep their own copy.
 *
 * Returns the removed meal with its items, enough to make it again with
 * create_meal.
 */
import { z } from 'zod';
import { toolResult, toolError } from '../_util.js';
import { deleteMeal } from '../../meal-save.js';
import { getMealDetailsCore } from './get-meal-details.js';

export function registerDeleteMeal(server, { userId }) {
  server.registerTool(
    'delete_meal',
    {
      title: 'Delete Meal or Recipe',
      description:
        'Remove a saved meal or recipe (meal_id from search_meals). Diary ' +
        'entries logged from it keep their own copy. Requires confirm=true. ' +
        'Returns the removed meal with its items, so you can offer "undo" ' +
        'via create_meal.',
      inputSchema: {
        meal_id: z.number().int().positive(),
        confirm: z.boolean(),
      },
    },
    async ({ meal_id, confirm }) => {
      if (confirm !== true) {
        return toolError(
          'delete_meal requires confirm=true. This safeguards against ' +
          'accidental destructive tool calls. Set the confirm argument to true ' +
          "and re-invoke if you're sure."
        );
      }
      let removed;
      try {
        removed = getMealDetailsCore(userId, { meal_id });
      } catch (e) {
        return toolError(e.message);
      }
      deleteMeal(removed.id);
      return toolResult({ ok: true, removed });
    }
  );
}
