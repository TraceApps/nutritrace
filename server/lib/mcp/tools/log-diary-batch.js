/**
 * MCP tool: log_diary_batch (write)
 *
 * Log many foods, meals and recipes across any days in one call, as
 * log_food and log_meal would one by one. Every entry is checked before
 * anything is written, all days are written in one transaction, and
 * webhooks fire only after it commits: the whole batch lands or none of it.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, toolResult, toolError } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';
import { dispatchWebhookEvent } from '../../webhooks.js';
import { checkNutritionGoalCrossing } from '../../goal-webhook.js';
import { getGoalsCore } from './goals.js';
import { dailyTotalsCore } from './daily-totals.js';
import { buildFoodEntry } from './log-food.js';
import { buildMealEntry } from './log-meal.js';

const entrySchema = z.object({
  food_id:  z.number().int().positive().optional(),
  meal_id:  z.number().int().positive().optional(),
  date:     z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
  meal:     z.number().int().min(0).max(9).optional(),
  quantity: z.number().positive().max(999).optional(),
  portion:  z.number().positive().max(10000).optional(),
  unit:     z.string().max(20).optional(),
  servings: z.number().positive().max(100).optional(),
  notes:    z.string().max(500).optional(),
});

function buildEntry(userId, e) {
  if ((e.food_id == null) === (e.meal_id == null)) throw new Error('pass exactly one of food_id or meal_id.');
  if (e.food_id != null) {
    if (e.servings != null) throw new Error('servings applies to meal_id entries; use quantity or portion for a food.');
    const { day, item, food } = buildFoodEntry(userId, e);
    return { day, items: [item], foodId: food.id, summary: { food_id: food.id, name: food.name, date: day, meal: item.meal } };
  }
  if (e.quantity != null || e.portion != null || e.unit != null) {
    throw new Error('quantity, portion and unit apply to food_id entries; use servings for a recipe.');
  }
  const { day, cloned, savedMeal } = buildMealEntry(userId, e);
  return {
    day, items: cloned,
    summary: { meal_id: savedMeal.id, name: savedMeal.name, date: day, item_count: cloned.length },
  };
}

export function logDiaryBatchCore(userId, entries) {
  const built = entries.map((e, i) => {
    try { return buildEntry(userId, e); } catch (err) { throw new Error(`entries[${i}]: ${err.message}`); }
  });

  const byDay = new Map();
  for (const b of built) byDay.set(b.day, [...(byDay.get(b.day) || []), ...b.items]);

  let goals = null;
  const before = new Map();
  try {
    ({ goals } = getGoalsCore(userId));
    for (const day of byDay.keys()) before.set(day, dailyTotalsCore(userId, { date: day }).totals);
  } catch { /* never let a webhook failure block the save */ }

  try {
    db.transaction(() => {
      for (const [day, items] of byDay) {
        mutateDiaryDay(userId, day, cur => ({ ...cur, items: [...cur.items, ...items] }));
      }
      const bump = db.prepare(
        `UPDATE foods
            SET usage_count = usage_count + 1,
                last_used_at = MAX(COALESCE(last_used_at, ''), ?),
                updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`
      );
      for (const b of built) if (b.foodId) bump.run(b.day, b.foodId, userId);
    })();
  } catch (e) {
    if (e instanceof DiaryTombstonedError) throw new Error(e.message);
    throw e;
  }

  try {
    for (const [day, items] of byDay) {
      dispatchWebhookEvent(userId, 'meal.logged', { date: day, items });
      if (goals && before.has(day)) {
        checkNutritionGoalCrossing(userId, day, goals, before.get(day), dailyTotalsCore(userId, { date: day }).totals);
      }
    }
  } catch { /* never let a webhook failure block the save */ }

  return {
    ok: true,
    logged: built.map(b => b.summary),
    items_added: built.reduce((n, b) => n + b.items.length, 0),
    days: [...byDay.keys()].sort(),
  };
}

export function registerLogDiaryBatch(server, { userId }) {
  server.registerTool(
    'log_diary_batch',
    {
      title: 'Log Diary Batch',
      description:
        'Log up to 100 entries across any days in one call. Each entry is either a food ' +
        '(food_id, with optional quantity/portion/unit as in log_food) or a saved meal or ' +
        'recipe (meal_id, with optional servings for a recipe as in log_meal), plus optional ' +
        'date (default today), meal slot (default 0) and notes. All entries are checked ' +
        'first; if any is invalid nothing is written and the error names its index.',
      inputSchema: {
        entries: z.array(entrySchema).min(1).max(100),
      },
    },
    async ({ entries }) => {
      try {
        return toolResult(logDiaryBatchCore(userId, entries));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
