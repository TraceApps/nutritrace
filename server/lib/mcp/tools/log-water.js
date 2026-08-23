/**
 * MCP tool: log_water (Phase 2, write)
 *
 * Append a water log entry to a diary day. Amount is in millilitres
 * to match the storage canonical unit; agents can convert oz on their
 * side (1 fl oz = 29.5735 ml) before calling.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, safeJson, todayLocal, toolResult, toolError } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';

const MAX_ML_PER_ENTRY = 5000;   // 5 L in one log = obvious agent bug or typo

// Accept the two shapes the client emits: "9:15 AM" (12h) or "21:15" (24h).
// Reject anything else so a hallucinated "morningish" doesn't land in the diary
// where the water widget would render it as garbage.
const TIME_RE = /^(1[0-2]|0?[1-9]):[0-5]\d\s?(AM|PM|am|pm)$|^([01]?\d|2[0-3]):[0-5]\d$/;

function _formatTime(date, use24) {
  const hh = date.getHours();
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (use24) return `${String(hh).padStart(2, '0')}:${mm}`;
  return `${(hh % 12) || 12}:${mm} ${hh >= 12 ? 'PM' : 'AM'}`;
}

export function registerLogWater(server, { userId }) {
  server.registerTool(
    'log_water',
    {
      title: 'Log Water',
      description:
        'Append a water log entry to a diary day. Amount is in millilitres ' +
        '(convert oz: 1 fl oz = 29.5735 ml). Date defaults to today in the ' +
        'server timezone. Time is a human string like "2:15 PM" and defaults ' +
        'to now if omitted.',
      inputSchema: {
        amount_ml: z.number().positive().max(MAX_ML_PER_ENTRY),
        date:      z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        time:      z.string().max(20).optional(),
      },
    },
    async ({ amount_ml, date, time }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);
      if (time && !TIME_RE.test(time)) {
        return toolError(
          `Invalid time '${time}'; expected "h:mm AM/PM" (e.g. "9:15 AM") or "HH:mm" (e.g. "21:15").`
        );
      }

      // Default time to now ONLY when the log is for today; backdated
      // entries default to noon to avoid a stamp that reads as "logged
      // 9 AM on that day" when it was actually filed later.
      //
      // Format manually — toLocaleTimeString respects the server locale
      // (LC_ALL), so a French-locale server would return '14:15' or a
      // narrow-no-break-space AM/PM even for a 12h user. Formatting
      // manually keeps every MCP-logged entry consistent with the
      // client-produced strings ('9:15 AM' / '21:15').
      // Look up the timeFormat setting lazily — only when we need to
      // synthesise a default. Every explicit-time call skips the query.
      let logTime = time;
      if (!logTime) {
        const isToday = day === todayLocal();
        const tfRow = db.prepare(
          `SELECT value FROM user_settings
            WHERE user_id = ? AND key = 'timeFormat' AND deleted_at IS NULL`
        ).get(userId);
        const use24 = safeJson(tfRow?.value, '12h') === '24h';
        logTime = isToday ? _formatTime(new Date(), use24) : (use24 ? '12:00' : '12:00 PM');
      }
      const log = { amount: Math.round(amount_ml), time: logTime };

      let next;
      try {
        next = mutateDiaryDay(userId, day, cur => ({
          ...cur,
          water: [...cur.water, log],
        }));
      } catch (e) {
        if (e instanceof DiaryTombstonedError) return toolError(e.message);
        throw e;
      }

      const total_ml = next.water.reduce((s, l) => s + (Number(l.amount) || 0), 0);
      return toolResult({
        ok: true,
        date: day,
        logged: log,
        total_ml_on_day: total_ml,
        entry_count_on_day: next.water.length,
      });
    }
  );
}
