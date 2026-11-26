/**
 * MCP tool: update_meal (Phase 3, destructive) — #331
 *
 * Change a saved meal or recipe: rename it, add, remove or replace items,
 * change a recipe's servings or total amount. Nutrition is worked out
 * again from the items the way the meal editor does (_meal-items.js), and
 * the row is saved through the same code as PUT /api/meals
 * (lib/meal-save.js) with changed_fields, so an edit made on a phone in
 * the meantime keeps its other fields.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError } from '../_util.js';
import { updateMeal } from '../../meal-save.js';
import { buildMealItems, mealTotals, itemSpec } from '../_meal-items.js';
import { getMealDetailsCore } from './get-meal-details.js';

export function registerUpdateMeal(server, { userId }) {
  server.registerTool(
    'update_meal',
    {
      title: 'Update Meal or Recipe',
      description:
        'Change a saved meal or recipe (meal_id from search_meals). Any of: ' +
        'name, notes; remove_item_indexes (0-based, as get_meal_details lists ' +
        'them); add_items or items (replaces every item), each a food_id with ' +
        'optional portion (in the food\'s own unit) and quantity, as in ' +
        "create_meal; for a recipe servings and total_amount (grams). Nutrition " +
        'is worked out again on the server. Requires confirm=true. Returns the ' +
        'meal before and after the change.',
      inputSchema: {
        confirm:             z.boolean(),
        meal_id:             z.number().int().positive(),
        name:                z.string().min(1).max(200).optional(),
        notes:               z.string().max(1000).optional(),
        servings:            z.number().int().min(1).max(1000).optional(),
        total_amount:        z.number().positive().max(100000).optional(),
        items:               z.array(itemSpec).min(1).max(100).optional(),
        add_items:           z.array(itemSpec).min(1).max(100).optional(),
        remove_item_indexes: z.array(z.number().int().min(0)).min(1).max(100).optional(),
      },
    },
    async ({ confirm, meal_id, name, notes, servings, total_amount, items, add_items, remove_item_indexes }) => {
      if (confirm !== true) {
        return toolError(
          'update_meal requires confirm=true. This safeguards against accidental ' +
          "changes. Set the confirm argument to true and re-invoke if you're sure."
        );
      }
      const existing = db.prepare(
        'SELECT * FROM meals WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
      ).get(userId, meal_id);
      if (!existing) return toolError(`meal_id ${meal_id} not found in your catalog.`);
      const isRecipe = !!existing.is_recipe;
      if (!isRecipe && (servings != null || total_amount != null)) {
        return toolError('servings and total_amount are for recipes; this is a meal.');
      }
      // A recipe imported from another app (CookTrace) keeps that app's
      // nutrition rollup; its items may carry none, so working it out again
      // here would lose it. The meal editor keeps the rollup too.
      if (existing.source_app && (servings != null || total_amount != null || items || add_items || remove_item_indexes)) {
        return toolError(`This recipe was imported from ${existing.source_app}; change its items or servings there or in the app. name and notes can be changed here.`);
      }
      if (items && (add_items || remove_item_indexes)) {
        return toolError('Send items (replaces every item) or add_items/remove_item_indexes, not both.');
      }
      if (name == null && notes == null && servings == null && total_amount == null
          && !items && !add_items && !remove_item_indexes) {
        return toolError('Nothing to change: send at least one of name, notes, servings, total_amount, items, add_items, remove_item_indexes.');
      }

      const body = { changed_fields: [] };
      if (name != null) {
        const cleanName = name.trim();
        if (!cleanName) return toolError('name cannot be blank.');
        const taken = db.prepare(
          `SELECT id FROM meals
            WHERE user_id = ? AND deleted_at IS NULL AND id != ? AND LOWER(name) = LOWER(?)
            LIMIT 1`
        ).get(userId, meal_id, cleanName);
        if (taken) return toolError(`Another meal or recipe is already named '${cleanName}' (meal_id=${taken.id}).`);
        body.name = cleanName;
        body.changed_fields.push('name');
      }
      if (notes != null) {
        body.notes = notes.trim();   // '' clears, as the editor does (null would keep it)
        body.changed_fields.push('notes');
      }

      // Items: the stored ones, minus removals, plus additions; or a new list.
      let nextItems = safeJson(existing.items, []);
      let itemsChanged = false;
      if (remove_item_indexes) {
        const drop = new Set(remove_item_indexes);
        const bad = [...drop].filter(i => i >= nextItems.length);
        if (bad.length) {
          return toolError(`remove_item_indexes ${bad.join(', ')} out of range: the meal has ${nextItems.length} item(s).`);
        }
        nextItems = nextItems.filter((_, i) => !drop.has(i));
        itemsChanged = true;
      }
      const specs = items || add_items;
      if (specs) {
        const built = buildMealItems(userId, specs);
        if (built.error) return toolError(built.error);
        nextItems = items ? built.items : [...nextItems, ...built.items];
        itemsChanged = true;
      }
      if (itemsChanged && nextItems.length === 0) {
        return toolError('A meal needs at least one item; that change would leave none.');
      }

      // Nutrition, worked out again whenever what it depends on changed. A
      // recipe's total amount follows its items when they change (the
      // editor's autoUpdateRecipeAmount), else stays what it was.
      if (itemsChanged || servings != null || total_amount != null) {
        const keepServings = servings ?? (existing.servings != null ? Number(existing.servings) : null);
        const keepTotal = total_amount
          ?? (itemsChanged ? null : (Number(existing.portion) || 0) * (Number(existing.servings) || 1) || null);
        // The summed amount is in grams, so a recipe whose items changed
        // takes 'g' as its unit, as autoUpdateRecipeAmount does.
        const totals = mealTotals(nextItems, {
          isRecipe, servings: keepServings, totalAmount: keepTotal,
          unit: itemsChanged ? 'g' : (existing.unit || 'g'),
        });
        Object.assign(body, totals);
        body.changed_fields.push('nutrition');
        if (isRecipe) body.changed_fields.push('portion', 'unit', 'servings');
        if (itemsChanged) {
          body.items = nextItems;
          body.changed_fields.push('items');
        }
      }

      const before = getMealDetailsCore(userId, { meal_id });
      updateMeal(existing, body, existing.img_url);
      return toolResult({ ok: true, before, after: getMealDetailsCore(userId, { meal_id }) });
    }
  );
}
