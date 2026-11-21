/**
 * server/lib/mcp/_meal-items.js
 *
 * Building a saved meal's or recipe's items[] and its nutrition the way
 * the meal editor does (src/routes/MealEditor.svelte), for create_meal and
 * update_meal:
 *
 * - each ingredient is the food with portion × quantity as its portion,
 *   quantity 1, its nutrition scaled to match, and food_server_id set
 *   (confirmMultiPortion);
 * - the meal's nutrition is Nutrition.sum of Nutrition.calculate per item;
 * - a recipe stores per-serving nutrition and portion: the total divided
 *   by its servings (save()).
 *
 * Items get a uuid like diary items (#239), so a later edit can tell them
 * apart.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import db from '../../db.js';
import { safeJson } from './_util.js';
import { Nutrition } from '../../../src/lib/nutrition.js';

// The meal editor's own conversion to grams (MealEditor.svelte toGrams),
// used for a recipe's total amount.
const TO_GRAMS = { g: 1, ml: 1, oz: 28.35, cup: 240, tbsp: 15, tsp: 5, piece: 100, serving: 100 };
function toGrams(amount, unit) {
  return (parseFloat(amount) || 0) * (TO_GRAMS[unit] || 1);
}

/**
 * Turn `[{ food_id, quantity?, portion? }]` into stored meal items. A food
 * must be one of the user's own (not deleted). `portion` is an amount in
 * the food's own unit (default: the food's portion); `quantity` multiplies
 * it (default 1). Returns `{ items }` or `{ error }`.
 */
export function buildMealItems(userId, specs) {
  const items = [];
  for (const [i, spec] of specs.entries()) {
    const food = db.prepare(
      `SELECT id, name, brand, portion, unit, nutrition, img_url
         FROM foods
        WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
    ).get(userId, spec.food_id);
    if (!food) return { error: `items[${i}]: food_id ${spec.food_id} not found in your catalog.` };
    const origPortion = parseFloat(food.portion) || 100;
    const unit = food.unit || 'g';
    const portion = spec.portion ?? origPortion;
    const quantity = spec.quantity ?? 1;
    const factor = (portion / origPortion) * quantity;
    const nutrition = Object.fromEntries(
      Object.entries(safeJson(food.nutrition, {}))
        .filter(([k]) => k !== '_derived')
        .map(([k, v]) => [k, (parseFloat(v) || 0) * factor])
    );
    items.push({
      uuid: randomUUID(),
      id: food.id,
      food_server_id: food.id,
      name: food.name,
      brand: food.brand || undefined,
      imgUrl: food.img_url || undefined,
      portion: portion * quantity,
      unit,
      quantity: 1,
      nutrition,
    });
  }
  return { items };
}

/**
 * The fields a meal or recipe saves from its items, as the editor's save():
 * a meal the summed nutrition; a recipe that divided by its servings, with
 * portion = total amount ÷ servings. `servings` null = unset (counts as 1),
 * `totalAmount` overrides the summed grams (water boiled off, for one).
 */
export function mealTotals(items, { isRecipe, servings = null, totalAmount = null, unit = 'g' } = {}) {
  const totals = Nutrition.sum(items.map(it => Nutrition.calculate(it)));
  if (!isRecipe) return { nutrition: totals };
  const totalGrams = totalAmount
    || Math.round(items.reduce((s, it) => s + toGrams(it.portion, it.unit), 0))
    || 100;
  const yields = servings != null ? Math.max(1, parseInt(servings) || 1) : 1;
  return {
    nutrition: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, (parseFloat(v) || 0) / yields])),
    portion: totalGrams / yields,
    unit,
    servings: servings != null ? yields : null,
  };
}

/** The item specs create_meal and update_meal take. */
export const itemSpec = z.object({
  food_id:  z.number().int().positive(),
  quantity: z.number().positive().max(1000).optional(),
  portion:  z.number().positive().max(100000).optional(),
});
