/**
 * MCP tool: edit_diary_entry (Phase 3, destructive)
 *
 * Patch one food item on a diary day. Only user-editable fields are
 * mutable: quantity, portion, unit, meal slot, notes. Name / nutrition
 * come from the food row and are intentionally NOT patchable here —
 * agents that want to change the food itself should delete_diary_entry
 * + log_food a different food.
 *
 * Portion change re-scales nutrition proportionally, same math as
 * log_food. Unit change is refused (cross-unit converts are the food-
 * row editor's job).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, safeJson, todayLocal, toolResult, toolError } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';

export function registerEditDiaryEntry(server, { userId }) {
  server.registerTool(
    'edit_diary_entry',
    {
      title: 'Edit Diary Entry',
      description:
        'Patch one food item on a diary day by its 0-based index. Editable ' +
        'fields: quantity, portion, meal slot, notes. Name and nutrition come ' +
        'from the food catalog and are not patchable here — swap to a different ' +
        'food by deleting and re-logging. Portion change re-scales nutrition. ' +
        'Requires confirm=true.',
      inputSchema: {
        entry_index: z.number().int().min(0),
        date:        z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        confirm:     z.boolean(),
        patch: z.object({
          quantity: z.number().positive().optional(),
          portion:  z.number().positive().optional(),
          meal:     z.number().int().min(0).max(9).optional(),
          notes:    z.string().max(500).nullable().optional(),
        }).refine(
          o => Object.keys(o || {}).length > 0,
          'patch must contain at least one editable field'
        ),
      },
    },
    async ({ entry_index, date, confirm, patch }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);
      if (confirm !== true) {
        return toolError(
          'edit_diary_entry requires confirm=true. This safeguards against ' +
          'accidental destructive tool calls. Set the confirm argument to true ' +
          "and re-invoke if you're sure."
        );
      }

      let before = null;
      let after  = null;
      let next;
      try {
        next = mutateDiaryDay(userId, day, cur => {
          if (entry_index >= cur.items.length) {
            throw new RangeError(
              `entry_index ${entry_index} out of range: day ${day} has ${cur.items.length} item(s).`
            );
          }
          const original = cur.items[entry_index];
          before = { ...original };

          const merged = { ...original };
          if (patch.meal     !== undefined) merged.meal     = patch.meal;
          if (patch.quantity !== undefined) merged.quantity = patch.quantity;
          if (patch.notes    !== undefined) merged.notes    = patch.notes;
          if (patch.portion  !== undefined) {
            // Recipe-split items store their real nutrition in _splitItems;
            // Nutrition.calculate short-circuits to sum(_splitItems) and
            // ignores the top-level `nutrition` field entirely. Patching
            // portion + top-level nutrition would leave totals unchanged
            // and mislead the caller. Refuse.
            if (Array.isArray(original._splitItems) && original._splitItems.length > 0) {
              throw new RangeError(
                'Entry is a recipe-split with per-ingredient nutrition; portion patch ' +
                'would not affect daily totals. Edit the recipe in the app, or delete + ' +
                're-log with the desired portion.'
              );
            }
            // Refuse portion patch when the source food has alt_units
            // defined — client-side portion math is nonlinear for those
            // (issues #69/#70) and a pure numeric rescale would silently
            // disagree with UI-produced values. Same guard log_food uses.
            if (typeof original.food_server_id === 'number') {
              const foodRow = db.prepare(
                `SELECT alt_units FROM foods WHERE user_id = ? AND id = ? AND deleted_at IS NULL`
              ).get(userId, original.food_server_id);
              const parsedAlt = foodRow?.alt_units ? safeJson(foodRow.alt_units, null) : null;
              if (Array.isArray(parsedAlt) && parsedAlt.length > 0) {
                throw new RangeError(
                  "Source food has alt_units defined (non-linear per-unit conversions); " +
                  "portion patch can't be scaled correctly here. Delete + re-log via the " +
                  "app to pick a different alt-unit portion."
                );
              }
            }
            // Nested `nutrition:{}` is the modern shape; legacy items
            // stored their nutriments as flat top-level fields (calories,
            // protein, ...). Refuse portion patch on legacy flat items —
            // scaling only the (empty) nested object would leave the flat
            // fields untouched and daily totals wrong.
            const rawNutrition = original.nutrition && typeof original.nutrition === 'object'
              ? original.nutrition
              : null;
            if (!rawNutrition || Object.keys(rawNutrition).length === 0) {
              throw new RangeError(
                'Entry has no nested nutrition object (legacy flat-fields shape). ' +
                'Portion patch is unsafe here — delete + re-log to update the portion.'
              );
            }
            const oldPortion = Number(original.portion) || null;
            if (!oldPortion) {
              throw new RangeError(
                `Entry has no baseline portion, so a portion patch can't scale nutrition. ` +
                'Delete + re-log with the desired portion instead.'
              );
            }
            const factor = patch.portion / oldPortion;
            merged.portion = patch.portion;
            merged.nutrition = Object.fromEntries(
              Object.entries(rawNutrition).map(([k, v]) =>
                [k, typeof v === 'number' ? Math.round(v * factor * 100) / 100 : v]
              )
            );
          }

          after = merged;
          const items = cur.items.slice();
          items[entry_index] = merged;
          return { ...cur, items };
        });
      } catch (e) {
        if (e instanceof DiaryTombstonedError) return toolError(e.message);
        if (e instanceof RangeError)           return toolError(e.message);
        throw e;
      }

      return toolResult({
        ok: true,
        date: day,
        entry_index,
        before: {
          quantity: before?.quantity,
          portion:  before?.portion,
          meal:     before?.meal,
          notes:    before?.notes,
        },
        after: {
          quantity: after?.quantity,
          portion:  after?.portion,
          meal:     after?.meal,
          notes:    after?.notes,
        },
      });
    }
  );
}
