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
import { dispatchWebhookEvent } from '../../webhooks.js';
import { checkWaterGoalCrossing } from '../../goal-webhook.js';
import { getGoalsCore } from './goals.js';
import { dailyTotalsCore } from './daily-totals.js';

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

/**
 * Core write, shared by the MCP tool below and the public REST API at
 * POST /api/v1/diary/:date/water. Throws a plain Error on bad input.
 */
export function logWaterCore(userId, { amount_ml, date, time } = {}) {
  const day = date || todayLocal();
  if (!DATE_RE.test(day)) throw new Error(`Invalid date '${day}'; expected YYYY-MM-DD.`);
  if (time && !TIME_RE.test(time)) {
    throw new Error(
      `Invalid time '${time}'; expected "h:mm AM/PM" (e.g. "9:15 AM") or "HH:mm" (e.g. "21:15").`
    );
  }

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

  // Snapshot pre-write water total for the goal.achieved webhook, before
  // the mutation below changes it. Never let this block the actual write.
  let beforeWaterMl = null, water_goal_ml = null;
  try {
    beforeWaterMl = dailyTotalsCore(userId, { date: day }).water_ml;
    ({ water_goal_ml } = getGoalsCore(userId));
  } catch (e) { /* never let a webhook failure block the save */ }

  let next;
  try {
    next = mutateDiaryDay(userId, day, cur => ({
      ...cur,
      water: [...cur.water, log],
    }));
  } catch (e) {
    if (e instanceof DiaryTombstonedError) throw new Error(e.message);
    throw e;
  }

  const total_ml = next.water.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  try {
    dispatchWebhookEvent(userId, 'water.logged', { date: day, water_ml: total_ml, added: [log] });
    if (beforeWaterMl != null) {
      checkWaterGoalCrossing(userId, day, water_goal_ml, beforeWaterMl, total_ml);
    }
  } catch (e) { /* never let a webhook failure block the save */ }

  return {
    ok: true,
    date: day,
    logged: log,
    total_ml_on_day: total_ml,
    entry_count_on_day: next.water.length,
  };
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
      try {
        return toolResult(logWaterCore(userId, { amount_ml, date, time }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
