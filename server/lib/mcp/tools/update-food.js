/**
 * MCP tool: update_food (Phase 3, destructive)
 *
 * Patch a food in the user's catalog. Nutrition is merged key by key
 * (null clears a key) and validated like create_food. Changing portion
 * does not rescale nutrition: the values describe whatever portion is
 * stored. Diary entries and saved meals keep their snapshot.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { safeJson, toolResult, toolError } from '../_util.js';
import { cleanNutrition } from './create-food.js';

export function registerUpdateFood(server, { userId }) {
  server.registerTool(
    'update_food',
    {
      title: 'Update Food',
      description:
        "Change a food in the user's catalog (food_id from search_foods). Every field is " +
        'optional. nutrition is merged into the stored values (canonical keys as in ' +
        'create_food; null removes a key). Nutrition stays per the stored portion, so when ' +
        'changing portion send the matching nutrition too. brand, notes, category and barcode ' +
        'accept null to clear. Already-logged diary entries are not changed. Requires confirm=true.',
      inputSchema: {
        confirm:   z.boolean(),
        food_id:   z.number().int().positive(),
        name:      z.string().min(1).max(200).optional(),
        brand:     z.string().max(100).nullable().optional(),
        portion:   z.number().positive().max(10000).optional(),
        unit:      z.string().min(1).max(20).optional(),
        nutrition: z.record(z.string(), z.number().nullable()).optional(),
        category:  z.string().max(50).nullable().optional(),
        barcode:   z.string().max(30).nullable().optional(),
        notes:     z.string().max(1000).nullable().optional(),
      },
    },
    async ({ confirm, food_id, ...patch }) => {
      if (confirm !== true) {
        return toolError('update_food requires confirm=true. Set it and re-invoke if you\'re sure.');
      }
      if (!Object.values(patch).some(v => v !== undefined)) {
        return toolError('Nothing to change: pass at least one field to update.');
      }
      const row = db.prepare(
        `SELECT id, name, brand, portion, unit, nutrition, category, categories, barcode, notes
           FROM foods
          WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
      ).get(userId, food_id);
      if (!row) return toolError(`food_id ${food_id} not found in your catalog.`);

      const name = patch.name?.trim() || row.name;
      const brand = patch.brand === undefined ? row.brand : (patch.brand?.trim() || null);
      if (name !== row.name || brand !== row.brand) {
        const clash = db.prepare(
          `SELECT id FROM foods
            WHERE user_id = ? AND deleted_at IS NULL AND id != ?
              AND LOWER(name) = LOWER(?)
              AND ( (brand IS NULL AND ? IS NULL) OR LOWER(brand) = LOWER(?) )
            LIMIT 1`
        ).get(userId, food_id, name, brand, brand);
        if (clash) return toolError(`Another food already has this name and brand (id=${clash.id}).`);
      }

      const nutrition = safeJson(row.nutrition, {});
      let report = {};
      if (patch.nutrition) {
        const { clean, rejected, aliased, removed } = cleanNutrition(patch.nutrition);
        if (rejected.length && !Object.keys(clean).length && !removed.length) {
          return toolError(`No valid nutriments to update. Rejected: ${rejected.join('; ')}.`);
        }
        Object.assign(nutrition, clean);
        for (const k of removed) delete nutrition[k];
        report = {
          rejected_nutriments: rejected.length ? rejected : undefined,
          aliased_nutriments: aliased.length ? aliased : undefined,
          removed_nutriments: removed.length ? removed : undefined,
        };
      }

      const category = patch.category === undefined ? row.category : (patch.category?.trim() || null);
      const categories = patch.category === undefined ? row.categories : (category ? JSON.stringify([category]) : null);
      const next = {
        name, brand,
        portion: patch.portion ?? row.portion,
        unit: patch.unit ?? row.unit,
        nutrition,
        category,
        barcode: patch.barcode === undefined ? row.barcode : (patch.barcode || null),
        notes: patch.notes === undefined ? row.notes : (patch.notes || null),
      };

      db.prepare(
        `UPDATE foods SET name = ?, brand = ?, portion = ?, unit = ?, nutrition = ?, category = ?, categories = ?,
                          barcode = ?, notes = ?, updated_at = datetime('now')
          WHERE user_id = ? AND id = ?`
      ).run(
        next.name, next.brand, next.portion, next.unit, JSON.stringify(next.nutrition),
        next.category, categories, next.barcode, next.notes, userId, food_id,
      );

      return toolResult({ ok: true, updated: { id: food_id, ...next }, ...report });
    }
  );
}
