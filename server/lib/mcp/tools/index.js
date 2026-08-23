/**
 * MCP tool registrar. Called once per request when the McpServer is
 * built. Each tool is registered against the user identified by
 * ctx.userId — the token that hit the MCP endpoint owns the scope
 * of every query. No cross-user access is possible from an MCP
 * handler; every DB query in each tool prepends `WHERE user_id = ?`.
 *
 * Write tools are registered ONLY when the request context reports
 * `writes: true` — that requires BOTH the server-side MCP_WRITE_ENABLED
 * flag AND the caller's token holding the `mcp:write` scope. If either
 * is absent the write tools don't appear in tools/list at all, so an
 * agent has no way to attempt them.
 */
import { registerGetGoals } from './goals.js';
import { registerListDiary } from './list-diary.js';
import { registerDailyTotals } from './daily-totals.js';
import { registerSearchFoods } from './search-foods.js';
import { registerRecentFoods } from './recent-foods.js';
import { registerSearchMeals } from './search-meals.js';
import { registerRecentMeals } from './recent-meals.js';
import { registerGetMealDetails } from './get-meal-details.js';
import { registerLogFood } from './log-food.js';
import { registerLogWater } from './log-water.js';
import { registerLogMeal } from './log-meal.js';
import { registerLogBodyStat } from './log-body-stat.js';
import { registerDeleteDiaryEntry } from './delete-diary-entry.js';
import { registerEditDiaryEntry } from './edit-diary-entry.js';
import { registerCreateFood } from './create-food.js';

export function registerReadTools(server, ctx) {
  registerGetGoals(server, ctx);
  registerListDiary(server, ctx);
  registerDailyTotals(server, ctx);
  registerSearchFoods(server, ctx);
  registerRecentFoods(server, ctx);
  registerSearchMeals(server, ctx);
  registerRecentMeals(server, ctx);
  registerGetMealDetails(server, ctx);
}

export function registerWriteTools(server, ctx) {
  registerLogFood(server, ctx);
  registerLogWater(server, ctx);
  registerLogMeal(server, ctx);
  registerLogBodyStat(server, ctx);
}

export function registerDestroyTools(server, ctx) {
  registerDeleteDiaryEntry(server, ctx);
  registerEditDiaryEntry(server, ctx);
  registerCreateFood(server, ctx);
}
