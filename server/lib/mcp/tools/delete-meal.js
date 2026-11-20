/**
 * MCP tool: delete_meal (Phase 3, destructive)
 *
 * Soft-delete a saved meal or recipe, as the app's delete does: it
 * leaves the catalog and pickers, and syncs to other devices as a
 * delete. Diary entries already logged from it keep their snapshot.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';

export function registerDeleteMeal(server, { userId }) {
  server.registerTool(
    'delete_meal',
    {
      title: 'Delete Meal or Recipe',
      description:
        'Delete a saved meal or recipe from the catalog (meal_id from search_meals). ' +
        'Diary entries already logged from it are kept. Requires confirm=true.',
      inputSchema: {
        confirm: z.boolean(),
        meal_id: z.number().int().positive(),
      },
    },
    async ({ confirm, meal_id }) => {
      if (confirm !== true) {
        return toolError('delete_meal requires confirm=true. Set it and re-invoke if you\'re sure.');
      }
      const row = db.prepare(
        `SELECT id, name, is_recipe FROM meals WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
      ).get(userId, meal_id);
      if (!row) return toolError(`meal_id ${meal_id} not found in your catalog.`);
      db.prepare(
        `UPDATE meals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND id = ?`
      ).run(userId, meal_id);
      return toolResult({ ok: true, deleted: { id: row.id, name: row.name, is_recipe: !!row.is_recipe } });
    }
  );
}
