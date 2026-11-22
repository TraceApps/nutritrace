/**
 * MCP tool: update_food (Phase 3, destructive) — #331
 *
 * Fix a food in the user's catalog: its name, brand, portion and unit,
 * single nutrition values, categories, barcode or notes, so an assistant
 * can correct a mistaken entry without the user switching to the app.
 * Under mcp:destroy with confirm=true like create_food.
 *
 * Saved through the same code as PUT /api/foods/:id (lib/food-save.js)
 * with changed_fields, so an edit made on a phone in the meantime keeps
 * its other fields. Diary entries already logged keep their own copy.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError } from '../_util.js';
import { updateFood } from '../../food-save.js';
import { categoriesOut } from '../../categories.js';
import { cleanNutrition } from './create-food.js';

function foodOut(row) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand || null,
    portion: row.portion,
    unit: row.unit,
    nutrition: safeJson(row.nutrition, {}),
    categories: categoriesOut(row),
    barcode: row.barcode || null,
    notes: row.notes || null,
  };
}

export function registerUpdateFood(server, { userId }) {
  server.registerTool(
    'update_food',
    {
      title: 'Update Food',
      description:
        "Change a food in the user's catalog (food_id from search_foods). Send " +
        'only what changes. nutrition is merged into the stored values: a key ' +
        'set to a number replaces that value, a key set to null removes it; ' +
        'use canonical ids as in create_food. Values are per the food\'s portion, ' +
        'so changing portion or unit needs nutrition for the new portion too. ' +
        'brand "" clears the brand; categories replaces the list. Diary entries ' +
        'already logged keep their own values. Requires confirm=true. Returns ' +
        'the food before and after the change.',
      inputSchema: {
        confirm:    z.boolean(),
        food_id:    z.number().int().positive(),
        name:       z.string().min(1).max(200).optional(),
        brand:      z.string().max(100).optional(),
        portion:    z.number().positive().max(10000).optional(),
        unit:       z.string().min(1).max(20).optional(),
        nutrition:  z.record(z.string(), z.number().nullable()).optional(),
        categories: z.array(z.string().max(50)).max(20).optional(),
        barcode:    z.string().max(30).optional(),
        notes:      z.string().max(1000).optional(),
      },
    },
    async ({ confirm, food_id, name, brand, portion, unit, nutrition, categories, barcode, notes }) => {
      if (confirm !== true) {
        return toolError(
          'update_food requires confirm=true. This safeguards against accidental ' +
          "changes. Set the confirm argument to true and re-invoke if you're sure."
        );
      }
      const existing = db.prepare(
        'SELECT * FROM foods WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
      ).get(userId, food_id);
      if (!existing) return toolError(`food_id ${food_id} not found in your catalog.`);

      const body = { changed_fields: [] };
      const set = (field, value) => { body[field] = value; body.changed_fields.push(field); };

      const portionChanges = portion != null && portion !== Number(existing.portion);
      const unitChanges = unit != null && unit.trim() !== existing.unit;
      if ((portionChanges || unitChanges) && !nutrition) {
        return toolError(
          "Nutrition values are per the food's portion. Changing portion or unit " +
          'needs nutrition for the new portion as well (at least calories).'
        );
      }

      if (name != null || brand != null) {
        const nextName = name != null ? name.trim() : existing.name;
        const nextBrand = brand != null ? (brand.trim() || null) : (existing.brand || null);
        if (!nextName) return toolError('name cannot be blank.');
        const taken = db.prepare(
          `SELECT id FROM foods
            WHERE user_id = ? AND deleted_at IS NULL AND id != ?
              AND LOWER(name) = LOWER(?)
              AND ( (NULLIF(brand, '') IS NULL AND ? IS NULL) OR LOWER(brand) = LOWER(?) )
            LIMIT 1`
        ).get(userId, food_id, nextName, nextBrand, nextBrand);
        if (taken) {
          return toolError(`Another food already has this name${nextBrand ? ` and brand '${nextBrand}'` : ''} (id=${taken.id}).`);
        }
        if (name != null) set('name', nextName);
        // Cleared as the food editor clears it: an empty string (the shared
        // save keeps the stored value for null).
        if (brand != null) set('brand', nextBrand ?? '');
      }
      if (portion != null) set('portion', portion);
      if (unit != null) set('unit', unit.trim());

      let report = {};
      if (nutrition) {
        const removed = Object.keys(nutrition).filter(k => nutrition[k] === null);
        const values = Object.fromEntries(Object.entries(nutrition).filter(([, v]) => v !== null));
        const { clean, rejected, aliased } = cleanNutrition(values);
        if (rejected.length) {
          return toolError(`Nothing saved: rejected nutrition ${rejected.join('; ')}. Canonical keys: calories, proteins, carbohydrates, fat, ...`);
        }
        const merged = { ...safeJson(existing.nutrition, {}), ...clean };
        delete merged._derived;
        for (const k of removed) delete merged[k];
        if (!Object.keys(merged).some(k => Number.isFinite(parseFloat(merged[k])))) {
          return toolError('A food needs at least one nutrition value; that change would leave none.');
        }
        set('nutrition', merged);
        report = { aliased_nutriments: aliased.length ? aliased : undefined };
      }
      if (categories) {
        body.categories = categories;
        body.changed_fields.push('category', 'categories');
      }
      if (barcode != null) set('barcode', barcode.trim());
      if (notes != null) set('notes', notes.trim());

      if (body.changed_fields.length === 0) {
        return toolError('Nothing to change: send at least one field besides food_id.');
      }

      const row = updateFood(existing, body, existing.img_url);
      return toolResult({ ok: true, before: foodOut(existing), after: foodOut(row), ...report });
    }
  );
}
