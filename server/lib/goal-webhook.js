/**
 * server/lib/goal-webhook.js
 *
 * Shared goal.achieved crossing-detection, used by every diary write
 * path (the UI's PUT /:date merge in routes/diary.js, and the MCP/REST
 * single-item writes in lib/mcp/tools/{log-food,log-meal,log-water}.js)
 * so the per-metric loop lives in one place instead of drifting across
 * three near-identical copies.
 *
 * Both `before` and `after` totals are rounded the same way
 * dailyTotalsCore rounds them (1 decimal place) before comparing. Diffing
 * a raw, unrounded `before` against a rounded `after` lets a total that
 * sits just under a rounding boundary (e.g. 1999.96 vs a 2000 target)
 * read as "not yet met" on every subsequent save that doesn't touch food
 * items, firing goal.achieved again on each one instead of once on the
 * actual crossing.
 */
import { dispatchWebhookEvent } from './webhooks.js';

function _round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * Fire goal.achieved once per macro/calorie metric that crosses from
 * under-target to at-or-above-target between `before` and `after`.
 */
export function checkNutritionGoalCrossing(userId, date, goals, before, after) {
  for (const metric of ['calories', 'protein', 'carbs', 'fat']) {
    const target = Number(goals?.[metric]);
    if (!Number.isFinite(target) || target <= 0) continue;
    const beforeVal = _round1(before?.[metric]);
    const actual = _round1(after?.[metric]);
    if (beforeVal < target && actual >= target) {
      dispatchWebhookEvent(userId, 'goal.achieved', { date, metric, target, actual });
    }
  }
}

/** Fire goal.achieved for the water goal crossing from under to at-or-above target. */
export function checkWaterGoalCrossing(userId, date, waterGoalMl, beforeWaterMl, afterWaterMl) {
  const target = Number(waterGoalMl);
  if (!Number.isFinite(target) || target <= 0) return;
  const before = Number(beforeWaterMl) || 0;
  const actual = Number(afterWaterMl) || 0;
  if (before < target && actual >= target) {
    dispatchWebhookEvent(userId, 'goal.achieved', { date, metric: 'water', target, actual });
  }
}
