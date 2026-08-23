/**
 * MCP tool: delete_diary_entry (Phase 3, destructive)
 *
 * Remove ONE food item from a diary day by its 0-based index. The
 * caller must have list_diary_entries just before to know the current
 * index — indices shift after any delete/edit. Water and body_stats
 * have their own dedicated wipe tools if we add them later; this tool
 * only touches items[].
 *
 * Returns the removed entry in the response so an agent can offer
 * "undo" by calling log_food with the same fields.
 */
import { z } from 'zod';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';

export function registerDeleteDiaryEntry(server, { userId }) {
  server.registerTool(
    'delete_diary_entry',
    {
      title: 'Delete Diary Entry',
      description:
        'Remove one food item from a diary day by its 0-based index. ' +
        'Call list_diary_entries first to see current indices — they ' +
        'shift after any delete/edit, so re-list between multiple ops. ' +
        'Requires confirm=true to guard against accidental deletion. ' +
        'Returns the removed entry so you can offer "undo" via log_food.',
      inputSchema: {
        entry_index: z.number().int().min(0),
        date:        z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        confirm:     z.boolean(),
      },
    },
    async ({ entry_index, date, confirm }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);
      if (confirm !== true) {
        return toolError(
          'delete_diary_entry requires confirm=true. This safeguards against ' +
          'accidental destructive tool calls. Set the confirm argument to true ' +
          "and re-invoke if you're sure."
        );
      }

      let removed = null;
      let next;
      try {
        next = mutateDiaryDay(userId, day, cur => {
          if (entry_index >= cur.items.length) {
            throw new RangeError(
              `entry_index ${entry_index} out of range: day ${day} has ${cur.items.length} item(s).`
            );
          }
          removed = cur.items[entry_index];
          const items = cur.items.slice(0, entry_index).concat(cur.items.slice(entry_index + 1));
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
        removed: {
          name:            removed?.name,
          brand:           removed?.brand,
          meal:            removed?.meal,
          portion:         removed?.portion,
          unit:            removed?.unit,
          quantity:        removed?.quantity,
          food_server_id:  removed?.food_server_id,
        },
        remaining_items_on_day: next.items.length,
      });
    }
  );
}
