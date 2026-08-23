/**
 * MCP tool: log_meal (Phase 2, write)
 *
 * Expand a saved meal's items into a diary day. Meals are stored in
 * the `meals` table with `is_recipe = 0`; recipes (is_recipe = 1) are
 * intentionally not supported here because "log a recipe" has different
 * semantics (portion of yield) and would need Phase-3-level UX to be
 * safe. Agents that want to log a recipe should call log_food on the
 * recipe's component foods instead.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, safeJson, todayLocal, toolResult, toolError } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';

export function registerLogMeal(server, { userId }) {
  server.registerTool(
    'log_meal',
    {
      title: 'Log Saved Meal',
      description:
        "Append every item from a saved meal to a diary day. meal_id must be " +
        "a saved meal (is_recipe = 0) from the user's meals table; recipes are " +
        'not supported by this tool. Meal slot defaults to 0 (Breakfast); the ' +
        'same slot is applied to every item. Date defaults to today.',
      inputSchema: {
        meal_id: z.number().int().positive(),
        date:    z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        meal:    z.number().int().min(0).max(9).optional(),
      },
    },
    async ({ meal_id, date, meal }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);

      const savedMeal = db.prepare(
        `SELECT id, name, items, is_recipe
           FROM meals
          WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
      ).get(userId, meal_id);
      if (!savedMeal) return toolError(`meal_id ${meal_id} not found in your catalog.`);
      if (savedMeal.is_recipe) {
        return toolError(
          `meal_id ${meal_id} is a recipe. Log its component foods with log_food, ` +
          'or use the app UI to log a recipe portion.'
        );
      }

      const sourceItems = safeJson(savedMeal.items, []);
      if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
        return toolError(`Meal '${savedMeal.name}' has no items to log.`);
      }

      const now = new Date().toISOString();
      // When caller supplies a `meal` slot, ALL items land in that slot
      // (explicit override). When omitted, preserve each item's own meal
      // assignment from the saved meal so a multi-meal prep pack stays
      // segmented in the diary. Fall back to 0 for items with no slot.
      const override = Number.isInteger(meal) ? meal : null;
      const cloned = sourceItems.map((it, i) => ({
        ...it,
        meal: override ?? (Number.isInteger(it.meal) ? it.meal : 0),
        // Stagger addedAt by 1ms per item so diary sort keeps composition order.
        addedAt: new Date(Date.parse(now) + i).toISOString(),
        // Preserve the item's original `source` (e.g. 'mfp_import',
        // 'off') so the diary provenance UI stays accurate. Only stamp
        // source_meal_id (the saved-meal ancestry, which is genuinely
        // new information for this diary entry).
        source: it.source || 'mcp:meal',
        source_meal_id: savedMeal.id,
      }));

      let next;
      try {
        next = mutateDiaryDay(userId, day, cur => ({
          ...cur,
          items: [...cur.items, ...cloned],
        }));
      } catch (e) {
        if (e instanceof DiaryTombstonedError) return toolError(e.message);
        throw e;
      }

      return toolResult({
        ok: true,
        date: day,
        logged: {
          meal_id: savedMeal.id,
          name: savedMeal.name,
          slot_override: override,
          item_count: cloned.length,
        },
        total_items_on_day: next.items.length,
      });
    }
  );
}
