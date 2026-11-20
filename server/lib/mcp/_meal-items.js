/**
 * Shared helpers for the MCP meal/recipe catalog tools (create_meal,
 * update_meal). Builds ingredient items in the same shape MealEditor
 * stores them: a snapshot of the food (or recipe) row, `portion` holding
 * the total amount, `quantity: 1`, and nutrition already scaled to it.
 */
import { z } from 'zod';
import db from '../../db.js';
import { safeJson } from './_util.js';

export const mealItemSchema = z.object({
  food_id:   z.number().int().positive().optional(),
  recipe_id: z.number().int().positive().optional(),
  portion:   z.number().positive().max(100000).optional(),
  quantity:  z.number().positive().max(999).optional(),
});

const scale = (nutrition, factor) => Object.fromEntries(
  Object.entries(nutrition || {})
    .filter(([k, v]) => k !== '_derived' && typeof v === 'number')
    .map(([k, v]) => [k, Math.round(v * factor * 100) / 100])
);

function foodItem(userId, { food_id, portion, quantity }) {
  const food = db.prepare(
    `SELECT id, name, brand, portion, unit, nutrition, alt_units
       FROM foods
      WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
  ).get(userId, food_id);
  if (!food) throw new Error(`food_id ${food_id} not found in your catalog.`);
  const base = Number(food.portion) || null;
  const alt = safeJson(food.alt_units, null);
  if (portion != null && Array.isArray(alt) && alt.length) {
    throw new Error(`Food '${food.name}' has alt-units; omit portion and use quantity instead.`);
  }
  if (portion != null && !base) {
    throw new Error(`Food '${food.name}' has no base portion; omit portion and use quantity instead.`);
  }
  const each = portion ?? base ?? 100;
  const qty = quantity ?? 1;
  return {
    id: food.id,
    food_server_id: food.id,
    name: food.name,
    brand: food.brand || undefined,
    portion: Math.round(each * qty * 100) / 100,
    unit: food.unit || 'g',
    quantity: 1,
    nutrition: scale(safeJson(food.nutrition, {}), (base ? each / base : 1) * qty),
  };
}

function recipeItem(userId, { recipe_id, portion, quantity }) {
  if (portion != null) throw new Error('Recipe ingredients take quantity (servings), not portion.');
  const recipe = db.prepare(
    `SELECT id, name, portion, unit, nutrition
       FROM meals
      WHERE user_id = ? AND id = ? AND is_recipe = 1 AND deleted_at IS NULL`
  ).get(userId, recipe_id);
  if (!recipe) throw new Error(`recipe_id ${recipe_id} not found in your recipes.`);
  const servings = quantity ?? 1;
  return {
    id: recipe.id,
    food_server_id: recipe.id,
    is_recipe: 1,
    name: recipe.name,
    portion: Math.round((Number(recipe.portion) || 100) * servings * 100) / 100,
    unit: recipe.unit || 'g',
    quantity: 1,
    nutrition: scale(safeJson(recipe.nutrition, {}), servings),
  };
}

export function buildMealItems(userId, specs) {
  return specs.map((spec, i) => {
    const hasFood = spec.food_id != null;
    const hasRecipe = spec.recipe_id != null;
    if (hasFood === hasRecipe) throw new Error(`items[${i}]: give exactly one of food_id or recipe_id.`);
    return hasFood ? foodItem(userId, spec) : recipeItem(userId, spec);
  });
}

export function sumNutrition(items) {
  const total = {};
  for (const it of items) {
    for (const [k, v] of Object.entries(it.nutrition || {})) {
      if (typeof v === 'number') total[k] = (total[k] || 0) + v;
    }
  }
  return total;
}

const GRAMS_PER = { g: 1, kg: 1000, ml: 1, l: 1000 };

// MealEditor's recipe amount default: the ingredients' summed weight.
// Ingredients in units with no gram equivalent here are left out.
export function totalGrams(items) {
  return items.reduce((s, it) => s + (Number(it.portion) || 0) * (GRAMS_PER[String(it.unit).toLowerCase()] || 0), 0);
}

export function perServing(nutrition, servings) {
  return Object.fromEntries(Object.entries(nutrition).map(([k, v]) => [k, Math.round((v / servings) * 100) / 100]));
}
