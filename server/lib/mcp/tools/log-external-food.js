/**
 * MCP tool: log_external_food (write, #314)
 *
 * Log a product found with search_external_foods. Diary entries point at a
 * catalog food (offline use, sync, edits and backups all rely on it), so the
 * product becomes one first, exactly once:
 *   1. a food this tool made for the product before (source_app 'off' or
 *      'usda' + the barcode or FoodData Central id), or
 *   2. one the user saved in the app (an OFF product under its barcode, a
 *      USDA one as fdcId_<id>), or
 *   3. a new food, read fresh from the source and saved with the fields the
 *      app's own import writes (server/lib/external-foods.js).
 * Then it is logged with log_food's core. A food the user already has is
 * never fetched or changed, so past days stay as they were.
 */
import { z } from 'zod';
import { DATE_RE, isCalendarDate, todayLocal, toolResult, toolError } from '../_util.js';
import { isDiaryDayTombstoned, DiaryTombstonedError } from '../_diary-write.js';
import { logFoodCore } from './log-food.js';
import { ensureCatalogFood, parseRef } from '../../external-foods.js';

function _unitError(name, foodUnit, unit) {
  return new Error(
    `Cross-unit portions are not supported: '${name}' is measured in '${foodUnit}', ` +
    `caller supplied '${unit}'. Convert to '${foodUnit}' first or omit the unit.`
  );
}

export async function logExternalFoodCore(userId, { ref, date, meal, quantity, portion, unit, notes } = {}) {
  const parsed = parseRef(ref);
  if (!parsed) throw new Error(`Invalid ref '${ref}'; expected off:<barcode> or usda:<fdcId> from search_external_foods.`);
  // Checked before anything is saved, so a bad call never leaves a food behind.
  if (date != null && !isCalendarDate(date)) throw new Error(`Invalid date '${date}'; expected YYYY-MM-DD.`);
  if (isDiaryDayTombstoned(userId, date || todayLocal())) throw new DiaryTombstonedError(date || todayLocal());
  const sameUnit = (a, b) => !a || !b || String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  const { food, created, matched_by } = await ensureCatalogFood(userId, parsed, {
    beforeCreate: (product) => {
      if (!sameUnit(unit, product.unit)) throw _unitError(product.name, product.unit, unit);
    },
  });
  let logged;
  try {
    logged = logFoodCore(userId, { food_id: food.id, date, meal, quantity, portion, unit, notes }, { sameUnitPortion: true });
  } catch (e) {
    // Say what did happen: the food is saved and a retry will use it.
    if (created) throw new Error(`${e.message} The product was saved to the catalog as food_id ${food.id}; log it with log_food or call this again.`);
    throw e;
  }
  return {
    ...logged,
    food: {
      id: food.id,
      name: food.name,
      brand: food.brand || null,
      portion: food.portion,
      unit: food.unit,
      ref: `${parsed.source}:${parsed.id}`,
      created,
      // How an existing food was found: 'source' (saved by this tool
      // before) or 'barcode' (saved in the app). Null when just created.
      reused_by: created ? null : matched_by,
    },
  };
}

export function registerLogExternalFood(server, { userId }) {
  server.registerTool(
    'log_external_food',
    {
      title: 'Log Food from Open Food Facts or USDA',
      description:
        'Log a product found with search_external_foods, by its ref (off:<barcode> or ' +
        "usda:<fdcId>). If the user's catalog already has the product (saved in the app or " +
        'by this tool) that food is used as it is; otherwise the product is read from its ' +
        'source and saved to the catalog once, then logged. Never creates a second food for ' +
        "the same product. Portion + unit default to the product's portion (usually 100 g or " +
        "100 ml); give portion in that unit to log another amount (e.g. portion 200, unit 'g'). " +
        'Quantity multiplies the portion. Date defaults to today in the server timezone. Meal ' +
        'slot is 0-indexed (0=Breakfast, 1=Lunch, 2=Dinner, 3=Snacks by default). Refuses a ' +
        'product its source has no calories for, rather than logging 0 kcal.',
      inputSchema: {
        ref:      z.string().trim().regex(/^(off|usda):\d{1,24}$/, 'off:<barcode> or usda:<fdcId>'),
        date:     z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        meal:     z.number().int().min(0).max(9).optional(),
        // Same caps as log_food.
        quantity: z.number().positive().max(999).optional(),
        portion:  z.number().positive().max(10000).optional(),
        unit:     z.string().max(20).optional(),
        notes:    z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return toolResult(await logExternalFoodCore(userId, args));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
