/**
 * MCP tool: search_meals
 *
 * Text-search the user's saved meals catalog. Mirrors search_foods but
 * against the `meals` table. Motivated by issue #103 (thanks
 * @javydekoning): without a name→id lookup for meals, log_meal is a
 * dead end for any agent that wasn't handed the numeric id up front.
 *
 * By default only returns is_recipe=0 rows — those are the ones log_meal
 * can consume. Callers who want recipes as well can pass include_recipes.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult } from '../_util.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export function registerSearchMeals(server, { userId }) {
  server.registerTool(
    'search_meals',
    {
      title: 'Search or List Saved Meals',
      description:
        "Search the user's saved meals catalog by name, or list all saved " +
        'meals when no query is given. Returns id, name, is_recipe, servings, ' +
        'portion, unit, per-meal nutrition, favorite, usage_count, and ' +
        'last_used_at for each match. Meals (is_recipe=0) can be logged ' +
        'directly via log_meal; recipes (is_recipe=1) are excluded by default ' +
        'because log_meal does not accept them. Default limit 20, max 50.',
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        include_recipes: z.boolean().optional(),
      },
    },
    async ({ query, limit, include_recipes }) => {
      const q = String(query || '').trim();
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      const recipeClause = include_recipes ? '' : 'AND is_recipe = 0';
      let rows;
      if (!q) {
        // No query — browse all meals ordered by favorite / usage / name.
        rows = db.prepare(
          `SELECT id, name, is_recipe, servings, portion, unit, nutrition,
                  favorite, usage_count, last_used_at
             FROM meals
            WHERE user_id = ?
              AND deleted_at IS NULL
              ${recipeClause}
            ORDER BY favorite DESC, usage_count DESC, name COLLATE NOCASE ASC
            LIMIT ?`
        ).all(userId, cap);
      } else {
        // Escape LIKE wildcards so a meal named "50% Reduced Fat" is searchable
        // by "50%" without matching every row. Same convention as search_foods.
        const escaped = q.replace(/[\\%_]/g, c => '\\' + c);
        const like = `%${escaped}%`;
        rows = db.prepare(
          `SELECT id, name, is_recipe, servings, portion, unit, nutrition,
                  favorite, usage_count, last_used_at
             FROM meals
            WHERE user_id = ?
              AND deleted_at IS NULL
              ${recipeClause}
              AND name LIKE ? ESCAPE '\\'
            ORDER BY favorite DESC, usage_count DESC, name COLLATE NOCASE ASC
            LIMIT ?`
        ).all(userId, like, cap);
      }
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
      return toolResult({ query: q || null, count: items.length, limit: cap, items });
    }
  );
}
