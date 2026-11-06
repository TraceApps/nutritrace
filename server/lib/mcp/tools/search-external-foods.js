/**
 * MCP tool: search_external_foods (read, #314)
 *
 * Search Open Food Facts and USDA FoodData Central by name or barcode, the
 * way the Foods page does: the user's OFF language, country and Import
 * Portion As; USDA only with USDA turned on and an API key saved; the local
 * OFF mirror when the server has one, and no network when it is air-gapped.
 * Results use the app's ranking and numbers (server/lib/external-foods.js).
 *
 * Nothing is saved. log_external_food logs a result by its `ref`.
 */
import { z } from 'zod';
import { toolResult, toolError } from '../_util.js';
import { searchExternalFoods, BARCODE_RE } from '../../external-foods.js';

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

export function registerSearchExternalFoods(server, { userId }) {
  server.registerTool(
    'search_external_foods',
    {
      title: 'Search Open Food Facts and USDA',
      description:
        'Search Open Food Facts and USDA FoodData Central by product name (query) or barcode, ' +
        "for foods that are not in the user's catalog yet (try search_foods first). Uses the " +
        "user's own settings, like the app's food search. Each result has a ref (off:<barcode> or " +
        'usda:<fdcId>) for log_external_food, plus name, brand, barcode, portion, unit, serving, ' +
        'and nutrition for that portion (usually per 100 g or 100 ml). nutrients_reported lists the ' +
        'nutrients the source actually has; others read 0 because the source left them blank. ' +
        'USDA needs USDA turned on with an API key in Settings > Connected Services; with source ' +
        '"all" a source that cannot answer is reported in sources[] instead. Limit is per source, ' +
        `default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
      inputSchema: {
        query:   z.string().trim().min(1).max(200).optional(),
        barcode: z.string().trim().regex(BARCODE_RE, '4 to 24 digits').optional(),
        source:  z.enum(['all', 'off', 'usda']).optional(),
        limit:   z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, barcode, source, limit }) => {
      const q = String(query || '').trim();
      const code = String(barcode || '').trim();
      if (!q === !code) return toolError('Give either query (a product name) or barcode, not both.');
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      const out = await searchExternalFoods(userId, {
        query: q || undefined,
        barcode: code || undefined,
        source: source || 'all',
        limit: cap,
      });
      const answered = out.sources.some(s => s.status === 'ok' || s.status === 'no_match');
      if (!answered) return toolError(out.sources.map(s => s.message).join(' '));
      return toolResult({
        ...(q ? { query: q } : { barcode: code }),
        limit: cap,
        count: out.items.length,
        sources: out.sources,
        items: out.items,
      });
    }
  );
}
