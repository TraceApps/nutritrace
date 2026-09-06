/**
 * POST /api/v1/recipes
 *
 * Federation entry point for external apps (currently CookTrace) to
 * publish a completed recipe as an NT `meals` row with `is_recipe=1`.
 * The row shows up in every NT surface that lists recipes: the
 * MealEditor picker, the Foods > Recipes tab, and Trace AI's meal
 * search.
 *
 * Design notes:
 *
 *  - **Upsert by (user_id, source_app, source_external_id).** The
 *    caller supplies both source_app (e.g. 'cooktrace') and a stable
 *    external id (e.g. the CT recipe id, prefixed however the caller
 *    likes). Re-posting the same triple updates the existing row in
 *    place rather than duplicating. The unique index on
 *    meals(user_id, source_app, source_external_id) enforces this at
 *    the storage layer.
 *
 *  - **`items[]` are ingredient snapshots, not links.** Each item
 *    carries its own name, portion, unit, quantity, and nutrition
 *    object. When the caller can, it also passes `food_server_id`
 *    (the NT foods.id that the ingredient corresponds to when the
 *    upstream pantry item was originally imported from NT); NT will
 *    freshen images and nutrition from that live row at diary time.
 *    Items without food_server_id land as loose entries, matching
 *    how the MealEditor already stores hand-typed items.
 *
 *  - **`nutrition` is the caller's rollup.** NT does not re-compute.
 *    The caller (CookTrace) already has a `computeRecipeNutrition`
 *    that handles unit conversions, sodium/salt derivation, and
 *    variant-of-generic lookup. Trusting the caller's rollup keeps
 *    the endpoint dumb and lets the source app own the semantics of
 *    "how do I turn a recipe into a nutrition object". Servings-
 *    scaling is at the caller's discretion; NT stores what arrives.
 *
 *  - **`import_warnings`** is an optional string[] surfaced verbatim
 *    on the NT recipe row so the user knows the total may be a lower
 *    bound (e.g. "2 ingredients missing nutrition data"). Serialized
 *    to JSON in the meals.import_warnings column.
 *
 *  - **Anonymous / single-user mode.** Diary and meals in single-user
 *    mode use user_id IS NULL, mirroring the pattern in the rest of
 *    the diary/meal routes. wellness_data uses 0 as the sentinel;
 *    that inconsistency is not this endpoint's problem.
 *
 * Wire contract:
 *   {
 *     source_app:          "cooktrace",              // required
 *     source_external_id:  "recipe:42",              // required, per-source stable id
 *     source_url:          "https://ct.example/…",   // optional, deep link back
 *     name:                "Chicken curry",          // required, <=200 chars
 *     items: [                                       // required, >=1 entry
 *       {
 *         name:            "Chicken thigh",          // required per item
 *         brand:           "",                       // optional
 *         portion:         100,                      // per-serving grams for the item
 *         unit:            "g",
 *         quantity:        4,                        // number of `portion`s used
 *         food_server_id:  421,                      // optional, NT foods.id
 *         nutrition:       { calories: 165, proteins: 27, ... }  // optional
 *       },
 *       …
 *     ],
 *     nutrition:      { calories: 850, proteins: 88, ... },  // caller's rollup
 *     servings:       4,                             // optional, default 1
 *     portion:        1200,                          // optional grams for full recipe
 *     unit:           "g",                           // optional, default "g"
 *     img_url:        "…",                           // optional
 *     import_warnings: [                             // optional
 *       "1 ingredient missing nutrition data (Turmeric); totals underestimated"
 *     ]
 *   }
 *
 * Response:
 *   201 { ok: true, meal_id: 87,  updated: false, source_app, source_external_id }
 *   200 { ok: true, meal_id: 87,  updated: true,  source_app, source_external_id }
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';

const router = Router();

router.post('/', requireScope('write:recipes'), wrap((req, res) => {
  const b = req.body || {};

  // ── Validate ──────────────────────────────────────────────────────────
  const sourceApp = String(b.source_app || '').trim().slice(0, 40);
  if (!sourceApp) {
    return res.status(400).json({ error: 'source_app required', code: 'bad_source_app' });
  }
  const sourceExtId = String(b.source_external_id || '').trim().slice(0, 128);
  if (!sourceExtId) {
    return res.status(400).json({ error: 'source_external_id required for upsert idempotency', code: 'bad_source_external_id' });
  }
  const cleanName = String(b.name || '').trim().slice(0, 200);
  if (!cleanName) {
    return res.status(400).json({ error: 'name required', code: 'bad_name' });
  }
  if (!Array.isArray(b.items) || b.items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array', code: 'bad_items' });
  }
  // Sanity-cap items so a runaway caller can't push a 100k-ingredient
  // recipe. Matches the 200-ish size real recipes ever reach.
  if (b.items.length > 500) {
    return res.status(413).json({ error: 'items array capped at 500 entries', code: 'items_too_many' });
  }

  const nutrition = (b.nutrition && typeof b.nutrition === 'object' && !Array.isArray(b.nutrition))
    ? b.nutrition : {};
  const items = b.items.map(_sanitizeItem).filter(Boolean);
  if (items.length === 0) {
    return res.status(400).json({ error: 'items are all malformed', code: 'bad_items_content' });
  }

  const servings = (() => {
    const n = Number(b.servings);
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
  })();
  const portion = (() => {
    const n = Number(b.portion);
    return Number.isFinite(n) && n > 0 ? n : 100;
  })();
  const unit = String(b.unit || 'g').trim().slice(0, 16) || 'g';
  const imgUrl = b.img_url != null ? String(b.img_url).trim().slice(0, 2048) || null : null;
  const sourceUrl = b.source_url != null ? String(b.source_url).trim().slice(0, 2048) || null : null;

  let warnings = null;
  if (Array.isArray(b.import_warnings) && b.import_warnings.length) {
    // Cap the warning list so it can't become a payload-vector into the
    // client. 20 lines is plenty for even a heavy skipped-ingredients
    // report, 400 chars per line matches the CT format.
    const cleaned = b.import_warnings
      .map(w => String(w || '').slice(0, 400))
      .filter(Boolean)
      .slice(0, 20);
    warnings = cleaned.length ? JSON.stringify(cleaned) : null;
  }

  const userId = req.apiUser.id;
  const u = (userId === 0 || userId == null) ? null : userId;

  // ── Upsert by (user, source_app, source_external_id) ─────────────────
  const existing = u == null
    ? db.prepare(`SELECT id FROM meals WHERE user_id IS NULL AND source_app = ? AND source_external_id = ? AND deleted_at IS NULL`).get(sourceApp, sourceExtId)
    : db.prepare(`SELECT id FROM meals WHERE user_id = ? AND source_app = ? AND source_external_id = ? AND deleted_at IS NULL`).get(u, sourceApp, sourceExtId);

  const itemsJson = JSON.stringify(items);
  const nutritionJson = JSON.stringify(nutrition);

  let mealId;
  if (existing) {
    db.prepare(`
      UPDATE meals
         SET name = ?,
             nutrition = ?,
             items = ?,
             img_url = ?,
             portion = ?,
             unit = ?,
             servings = ?,
             is_recipe = 1,
             source_url = ?,
             import_warnings = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(cleanName, nutritionJson, itemsJson, imgUrl, portion, unit, servings, sourceUrl, warnings, existing.id);
    mealId = existing.id;
  } else {
    const r = db.prepare(`
      INSERT INTO meals (
        user_id, name, nutrition, items, img_url, is_recipe,
        portion, unit, servings,
        source_app, source_external_id, source_url, import_warnings,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(u, cleanName, nutritionJson, itemsJson, imgUrl, portion, unit, servings,
      sourceApp, sourceExtId, sourceUrl, warnings);
    mealId = r.lastInsertRowid;
  }

  res.status(existing ? 200 : 201).json({
    ok: true,
    meal_id: mealId,
    updated: !!existing,
    source_app: sourceApp,
    source_external_id: sourceExtId,
  });
}));

/**
 * Strip an incoming item down to fields we store, with per-field
 * validation. Returns null when the item is unusable (no name) so
 * the caller can filter.
 */
function _sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 200);
  if (!name) return null;
  const out = {
    name,
    brand:    raw.brand    != null ? String(raw.brand).trim().slice(0, 120) : '',
    unit:     raw.unit     != null ? String(raw.unit).trim().slice(0, 16) : 'g',
    portion:  _num(raw.portion,  100, { min: 0, max: 100000 }),
    quantity: _num(raw.quantity, 1,   { min: 0, max: 100000 }),
  };
  if (Number.isFinite(Number(raw.food_server_id))) {
    out.food_server_id = Number(raw.food_server_id);
  }
  if (raw.nutrition && typeof raw.nutrition === 'object' && !Array.isArray(raw.nutrition)) {
    // Whitelist numeric-looking values; drop anything else silently so
    // a caller can't stash arbitrary data in the item blob.
    const clean = {};
    for (const [k, v] of Object.entries(raw.nutrition)) {
      const n = Number(v);
      if (Number.isFinite(n)) clean[String(k).slice(0, 60)] = n;
    }
    out.nutrition = clean;
  }
  return out;
}

function _num(v, fallback, { min, max }) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

export default router;
