/**
 * MCP tool: delete_food (Phase 3, destructive)
 *
 * Soft-delete a food from the user's catalog, as the app's delete does.
 * Diary entries and saved meals that already contain it keep their
 * snapshot of it.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';

export function registerDeleteFood(server, { userId }) {
  server.registerTool(
    'delete_food',
    {
      title: 'Delete Food',
      description:
        "Delete a food from the user's catalog (food_id from search_foods). Diary entries " +
        'and saved meals that already contain it are kept. Requires confirm=true.',
      inputSchema: {
        confirm: z.boolean(),
        food_id: z.number().int().positive(),
      },
    },
    async ({ confirm, food_id }) => {
      if (confirm !== true) {
        return toolError('delete_food requires confirm=true. Set it and re-invoke if you\'re sure.');
      }
      const row = db.prepare(
        `SELECT id, name, brand FROM foods WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
      ).get(userId, food_id);
      if (!row) return toolError(`food_id ${food_id} not found in your catalog.`);
      db.prepare(
        `UPDATE foods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND id = ?`
      ).run(userId, food_id);
      return toolResult({ ok: true, deleted: { id: row.id, name: row.name, brand: row.brand || null } });
    }
  );
}
