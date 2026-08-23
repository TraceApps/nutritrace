/**
 * MCP tool: get_recent_meals
 *
 * Return the user's most-recently-used saved meals, ordered by
 * `last_used_at` (bumped by the client whenever a meal is logged and by
 * log_meal on this server). Parallel to get_recent_foods but uses the
 * meals table's own usage columns instead of scanning diary rows,
 * because meals get expanded into items on log so there's no direct
 * meal-id fingerprint in the diary.
 *
 * Recipes are excluded by default; log_meal doesn't accept them anyway.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult } from '../_util.js';

const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 10;

export function registerRecentMeals(server, { userId }) {
  server.registerTool(
    'get_recent_meals',
    {
      title: 'Get Recent Meals',
      description:
        "Return the user's most-recently-used saved meals, ordered by " +
        'last_used_at descending (then usage_count, then name). Recipes ' +
        '(is_recipe=1) are excluded by default. Same shape as search_meals ' +
        'results. Default limit 10, max 30.',
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        include_recipes: z.boolean().optional(),
      },
    },
    async ({ limit, include_recipes }) => {
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      const recipeClause = include_recipes ? '' : 'AND is_recipe = 0';
      const rows = db.prepare(
        `SELECT id, name, is_recipe, servings, portion, unit, nutrition,
                favorite, usage_count, last_used_at
           FROM meals
          WHERE user_id = ?
            AND deleted_at IS NULL
            AND last_used_at IS NOT NULL
            ${recipeClause}
          ORDER BY last_used_at DESC, usage_count DESC, name COLLATE NOCASE ASC
          LIMIT ?`
      ).all(userId, cap);
      const items = rows.map(r => ({
        id: r.id,
        name: r.name,
        is_recipe: !!r.is_recipe,
        servings: Number.isFinite(Number(r.servings)) ? Number(r.servings) : null,
        portion: Number.isFinite(Number(r.portion)) ? Number(r.portion) : null,
        unit: r.unit || null,
        nutrition: safeJson(r.nutrition, {}),
        favorite: !!r.favorite,
        usage_count: Number(r.usage_count) || 0,
        last_used_at: r.last_used_at || null,
      }));
      return toolResult({ count: items.length, limit: cap, items });
    }
  );
}
