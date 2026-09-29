/**
 * POST /api/v1/body-measurements — record body composition from an
 * external smart-scale integration (Home Assistant, Node-RED,
 * Gadgetbridge-on-server, ESPHome BLE bridges, etc.).
 *
 * Fills the "headless server" gap that Health Connect can't cover:
 * BLE scale → HA (running on your NAS/Pi) → JSON → this endpoint.
 * Same day, Withings/Fitbit users can keep syncing via their existing
 * OAuth flows; this is the wire for scales that never touch a phone.
 *
 * Storage: writes to `diary.body_stats` for the day derived from
 * measured_at. Uses "overwrite only what's sent" semantics: fields
 * present in the payload replace whatever was there, but any keys
 * already in body_stats that the payload doesn't mention are
 * preserved untouched. So manual `notes` don't get clobbered when HA
 * pushes a scale reading, and multiple readings the same day update
 * to the newest value (opposite tradeoff from Withings' passive
 * "fill-if-empty" sync, and matches the user intent behind
 * deliberately setting up the federation integration).
 *
 * Wire contract:
 *   {
 *     measured_at:   "2026-07-25T16:10:51Z",   // required, ISO 8601
 *     source:        "home-assistant",         // optional, free text, ≤64 chars
 *
 *     // Standard body-composition fields — mapped to NT's native keys:
 *     weight:        76.9,   // kg   → body_stats.weight_kg
 *     body_fat:      21.2,   // %    → body_stats.body_fat_pct
 *     muscle_mass:   56.14,  // kg   → body_stats.muscle_mass_kg
 *     bone_mass:     3.01,   // kg   → body_stats.bone_mass_kg
 *     body_water:    54,     // %    → body_stats.body_water_pct
 *     lean_body_mass:60,     // kg   → body_stats.lean_mass_kg
 *
 *     // Extra metrics NT doesn't render (yet). Preserved in body_stats
 *     // JSON under the same key names so nothing is lost:
 *     bmi:           24.3,
 *     visceral_fat:  11,
 *     protein:       20.7,
 *     bmr:           1590,
 *     metabolic_age: 28,
 *     impedance:     465,
 *     body_score:    73
 *   }
 *
 * Both camelCase (measuredAt, bodyFat) and snake_case (measured_at,
 * body_fat) are accepted on input for convenience — snake_case wins
 * on collision. Everything is stored snake_case internally.
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { getBodyCompositionCore } from '../../../lib/mcp/tools/get-body-composition.js';

const router = Router();

// Map wire field → body_stats key. Anything not in this table but
// present in the payload gets stored under its snake_case wire name
// verbatim (so extras like `bmi`, `visceral_fat`, `body_score` land
// safely without needing a schema change every time a new scale
// vendor invents a metric).
//
// Key names match what the Wellness → Body UI reads and what the
// Withings sync writes (server/routes/withings.js BODY_STAT_TYPES +
// WELLNESS_TYPES) so the same metric from either integration ends up
// under the same key.
const FIELD_MAP = {
  weight:         'weight_kg',
  body_fat:       'body_fat_pct',
  muscle_mass:    'muscle_mass_kg',
  bone_mass:      'bone_mass_kg',
  body_water:     'body_water_pct',
  lean_body_mass: 'lean_mass_kg',      // matches Wellness UI + Withings
};

// Rough sanity ranges so a mis-configured integration posting garbage
// (e.g. weight in grams instead of kg → 76900) doesn't corrupt the
// diary. Reject the whole request on any out-of-range value rather
// than silently dropping fields.
const RANGES = {
  weight:         [10, 500],     // kg
  body_fat:       [1, 80],       // %
  muscle_mass:    [5, 200],      // kg
  bone_mass:      [0.5, 20],     // kg
  body_water:     [1, 90],       // %
  lean_body_mass: [10, 300],     // kg
  bmi:            [5, 100],
  visceral_fat:   [0, 100],
  protein:        [1, 60],       // %
  bmr:            [400, 5000],   // kcal/day
  metabolic_age:  [5, 120],      // years
  impedance:      [50, 2000],    // ohms
  body_score:     [0, 100],
};

/** Read a numeric field from the payload, accepting camelCase and
 *  snake_case names. Returns null when absent; throws when present
 *  but non-numeric or out of range. */
function _readField(body, snakeKey) {
  const camelKey = snakeKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const raw = body[snakeKey] ?? body[camelKey];
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    const err = new Error(`${snakeKey} must be a number`);
    err.code = 'bad_field';
    err.field = snakeKey;
    throw err;
  }
  const [lo, hi] = RANGES[snakeKey] || [-Infinity, Infinity];
  if (n < lo || n > hi) {
    const err = new Error(`${snakeKey} out of range (${lo}..${hi})`);
    err.code = 'out_of_range';
    err.field = snakeKey;
    throw err;
  }
  return n;
}

/** Parse measured_at (or measuredAt) into a YYYY-MM-DD date string
 *  in the server's local timezone. That matches how Withings sync,
 *  the manual body-stats UI, and the diary all key entries. */
function _measurementDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // toISOString would give UTC; we want the date the user weighed in.
  // JS Date's local getters do exactly that.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

router.get('/', requireScope('read:body-measurements'), wrap((req, res) => {
  try {
    const result = getBodyCompositionCore(req.apiUser.id, {
      start: req.query.start,
      end: req.query.end,
      source: req.query.source,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.post('/', requireScope('write:body-measurements'), wrap((req, res) => {
  const body = req.body || {};
  const measuredAtRaw = body.measured_at ?? body.measuredAt;
  if (!measuredAtRaw) {
    return res.status(400).json({ error: 'measured_at required', code: 'bad_measured_at' });
  }
  const date = _measurementDate(measuredAtRaw);
  if (!date) {
    return res.status(400).json({ error: 'measured_at must be ISO 8601', code: 'bad_measured_at' });
  }

  // Assemble the update: mapped fields under their body_stats keys,
  // plus extras under their wire names. Only include what was
  // actually provided so absent fields stay unchanged in the DB.
  const updates = {};
  try {
    for (const [wireKey, storageKey] of Object.entries(FIELD_MAP)) {
      const v = _readField(body, wireKey);
      if (v !== null) updates[storageKey] = v;
    }
    for (const extra of ['bmi', 'visceral_fat', 'protein', 'bmr', 'metabolic_age', 'impedance', 'body_score']) {
      const v = _readField(body, extra);
      if (v !== null) updates[extra] = v;
    }
  } catch (e) {
    return res.status(400).json({ error: e.message, code: e.code || 'bad_field', field: e.field });
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      error: 'no measurement fields provided',
      code: 'no_fields',
    });
  }

  // Optional bookkeeping — record which integration pushed this so
  // multi-source setups (Xiaomi at home, Renpho at the gym) can be
  // told apart later. Stored under a namespaced key to avoid
  // colliding with any future first-class field.
  const source = String(body.source || '').trim().slice(0, 64);
  if (source) updates._last_source = source;
  updates._last_measured_at = new Date(measuredAtRaw).toISOString();

  const userId = req.apiUser.id;
  const u = (userId === 0 || userId == null) ? null : userId;

  const row = u == null
    ? db.prepare('SELECT body_stats FROM diary WHERE date = ? AND user_id IS NULL').get(date)
    : db.prepare('SELECT body_stats FROM diary WHERE date = ? AND user_id = ?').get(date, u);

  const existing = JSON.parse(row?.body_stats || '{}');
  const merged = { ...existing, ...updates };

  if (u == null) {
    db.prepare(`
      INSERT INTO diary (date, items, body_stats, water, updated_at)
      VALUES (?, '[]', ?, '[]', datetime('now'))
      ON CONFLICT(date, user_id) DO UPDATE SET
        body_stats = excluded.body_stats,
        updated_at = excluded.updated_at
    `).run(date, JSON.stringify(merged));
  } else {
    db.prepare(`
      INSERT INTO diary (user_id, date, items, body_stats, water, updated_at)
      VALUES (?, ?, '[]', ?, '[]', datetime('now'))
      ON CONFLICT(date, user_id) DO UPDATE SET
        body_stats = excluded.body_stats,
        updated_at = excluded.updated_at
    `).run(u, date, JSON.stringify(merged));
  }

  // Also mirror every numeric metric to wellness_data with
  // source='federation'. Wellness → Body reads from wellness_data
  // (not from diary.body_stats), so without this the fields would
  // land in the diary card but stay invisible in Wellness. Matches
  // the Withings sync pattern: it writes to BOTH tables so the
  // per-source Wellness views can render the data. Uses the same
  // (user_id, date, source, metric_type) uniqueness so re-posting
  // the same day upserts in place.
  const insertWellness = db.prepare(`
    INSERT INTO wellness_data (user_id, date, source, metric_type, value, metadata, synced_at)
    VALUES (?, ?, 'federation', ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, date, source, metric_type)
    DO UPDATE SET value = excluded.value, metadata = excluded.metadata, synced_at = excluded.synced_at
  `);
  const wellnessUid = u == null ? 0 : u;
  const wellnessMeta = source ? JSON.stringify({ source }) : '{}';
  for (const [key, value] of Object.entries(updates)) {
    if (key.startsWith('_')) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    insertWellness.run(wellnessUid, date, key, value, wellnessMeta);
  }

  res.status(201).json({
    ok: true,
    date,
    stored: Object.keys(updates).filter(k => !k.startsWith('_')),
  });
}));

export default router;
