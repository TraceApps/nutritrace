/**
 * MCP tool: search_foods
 *
 * Text-search the user's local foods catalog. Same shape as the
 * /api/v1/foods federation endpoint but returned via MCP.
 *
 * External sources (OFF, USDA) are intentionally NOT queried here
 * to keep the tool response fast + deterministic. They have their own
 * tool, search_external_foods (#314), and log_external_food logs one.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError } from '../_util.js';
import { foldText } from '../../search-text.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export function registerSearchFoods(server, { userId }) {
  server.registerTool(
    'search_foods',
    {
      title: 'Search Foods (Local Catalog)',
      description:
        "Text-search the user's local foods catalog by name or brand. Returns id, " +
        'name, brand, barcode, portion, unit, and per-portion nutrition for each match. ' +
        'Does not query external sources: for Open Food Facts or USDA products the user ' +
        'has not saved yet, use search_external_foods. Default limit 20, max 50.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ query, limit }) => {
      const q = String(query || '').trim();
      if (!q) return toolError('query is required and cannot be empty.');
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      // Escape LIKE wildcards (%, _, \) in user input so a food named
      // "100% Whole Wheat" is searchable by "100%" without matching every
      // row. Uses backslash escaping under an explicit ESCAPE clause so
      // we don't collide with the SQLite default.
      const escaped = q.replace(/[\\%_]/g, c => '\\' + c);
      const like = `%${foldText(escaped)}%`;
      const rows = db.prepare(
        `SELECT id, name, brand, barcode, portion, unit, nutrition, category
           FROM foods
          WHERE user_id = ?
            AND deleted_at IS NULL
            AND (fold(name) LIKE ? ESCAPE '\\' OR fold(brand) LIKE ? ESCAPE '\\')
          ORDER BY name COLLATE NOCASE ASC
          LIMIT ?`
      ).all(userId, like, like, cap);
      const items = rows.map(r => ({
        id: r.id,
        name: r.name,
        brand: r.brand || null,
        barcode: r.barcode || null,
        portion: Number.isFinite(Number(r.portion)) ? Number(r.portion) : null,
        unit: r.unit || null,
        category: r.category || null,
        nutrition: safeJson(r.nutrition, {}),
      }));
      return toolResult({ query: q, count: items.length, limit: cap, items });
    }
  );
}
