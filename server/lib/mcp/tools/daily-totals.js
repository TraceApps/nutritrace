/**
 * MCP tool: get_daily_totals
 *
 * Sum the nutrition of the food items in a day's diary row. Returns
 * calories, protein, carbs, fat, plus any micronutrients present on
 * the items. Water is returned separately as it lives in its own
 * column on the diary row. Mirrors what the Diary top-bar displays.
 *
 * Delegates to the client's Nutrition.calculate + Nutrition.sum so
 * exploded-recipe split items and legacy flat-nutrition items are
 * handled the same way the frontend does. src/lib/nutrition.js has no
 * browser/Svelte deps so it's safe to import from server-side code.
 *
 * Filters out tombstoned diary rows (deleted_at IS NOT NULL).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { Nutrition } from '../../../../src/lib/nutrition.js';
import { DATE_RE, safeJson, todayLocal, toolResult, toolError } from '../_util.js';

export function registerDailyTotals(server, { userId }) {
  server.registerTool(
    'get_daily_totals',
    {
      title: 'Get Daily Totals',
      description:
        "Sum the nutrition of a day's diary entries. Returns calories (kcal), " +
        'macros (protein / carbs / fat / etc. in grams), any micronutrients ' +
        "present on the logged items, and total water in millilitres. Date " +
        "defaults to today in the SERVER's timezone; pass an explicit YYYY-MM-DD " +
        'for calendar accuracy from a different TZ.',
      inputSchema: {
        date: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ date }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) {
        return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);
      }
      const row = db.prepare(
        `SELECT items, water FROM diary
          WHERE user_id = ? AND date = ? AND deleted_at IS NULL`
      ).get(userId, day);
      const items = row?.items ? safeJson(row.items, []) : [];
      const waterLogs = row?.water ? safeJson(row.water, []) : [];
      const totals = Nutrition.sum(items.map(i => Nutrition.calculate(i)));
      // Round to 1 decimal place — matches how the diary top-bar renders.
      for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 10) / 10;
      const water_ml = waterLogs.reduce((s, l) => s + (Number(l.amount) || 0), 0);
      return toolResult({ date: day, totals, water_ml, item_count: items.length });
    }
  );
}
