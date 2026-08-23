/**
 * MCP tool: log_body_stat (Phase 2, write)
 *
 * Set one or more body-stat values on a diary day. Storage is the
 * diary row's `body_stats` JSON object; the shape merges with any
 * existing values (setting `weight` doesn't clear `body_fat`).
 *
 * Units are canonical (kg for mass, cm for lengths, percent as 0-100).
 * Agents that receive user input in lb/inches must convert first;
 * mirrors the client-side saveBodyStats() contract.
 */
import { z } from 'zod';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';
import { mutateDiaryDay, DiaryTombstonedError } from '../_diary-write.js';

const LENGTH_KEYS = ['waist', 'hips', 'neck', 'chest', 'thighs', 'biceps', 'calves'];

// Module-scope sentinel so future refactors can import + rethrow it
// from _diary-write.js (mirrors how DiaryTombstonedError is scoped).
class LegacyBodyStatsError extends Error {
  constructor(message) { super(message); this.name = 'LegacyBodyStatsError'; }
}

// Allowed body-stat keys with { min, max } sanity ranges. Keys match
// EXACTLY what the frontend BodyStats editor writes (see LENGTH_KEYS in
// src/lib/body-stats-unit.js): plural forms hips/thighs/calves/biceps,
// not singular. Anything outside this set is rejected — otherwise a
// write to 'hip' would silently orphan (row saved but never displayed
// because the UI only reads 'hips'). muscle_mass / water_pct / bone_mass
// / visceral_fat aren't in body_stats at all — those live in wellness_data
// from Withings/Garmin, which this tool doesn't touch.
//
// Ranges are generous — clinically implausible but physically plausible —
// because the MCP tool is a data pipe, not a validator; the app UI catches
// finer input mistakes.
const STAT_RANGES = {
  weight:   { min: 0.5, max: 500, kind: 'weight' },   // kg
  body_fat: { min: 0,   max: 80,  kind: 'percent' }, // %
  waist:    { min: 30,  max: 250, kind: 'length' },  // cm
  hips:     { min: 30,  max: 250, kind: 'length' },
  neck:     { min: 15,  max: 100, kind: 'length' },
  chest:    { min: 40,  max: 250, kind: 'length' },
  biceps:   { min: 10,  max: 100, kind: 'length' },
  thighs:   { min: 20,  max: 150, kind: 'length' },
  calves:   { min: 15,  max: 100, kind: 'length' },
};
const ALLOWED_STATS = new Set(Object.keys(STAT_RANGES));

export function registerLogBodyStat(server, { userId }) {
  server.registerTool(
    'log_body_stat',
    {
      title: 'Log Body Stat',
      description:
        "Set one or more body-stat values on a diary day. Units are canonical: " +
        'weight in kg, waist / hips / neck / chest / biceps / thighs / calves ' +
        'in cm, body_fat as percent (0-100). Merges into existing stats (setting ' +
        'weight does not clear body_fat). Keys must match the app exactly (plural ' +
        'forms for length metrics: hips not hip, thighs not thigh, calves not ' +
        'calf, biceps not arm). Values are stored with unit tags (weight_unit=kg, ' +
        'lengths_unit=cm) so display in a lb/in user profile converts correctly.',
      inputSchema: {
        stats: z.record(z.string(), z.number()).refine(
          o => Object.keys(o || {}).length > 0,
          'stats must be a non-empty object'
        ),
        date:  z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
      },
    },
    async ({ stats, date }) => {
      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);

      const clean = {};
      const rejected = [];
      let hasWeightWrite = false;
      let hasLengthWrite = false;
      for (const [k, v] of Object.entries(stats || {})) {
        if (!ALLOWED_STATS.has(k)) { rejected.push(`${k} (unknown key; allowed: ${[...ALLOWED_STATS].join(', ')})`); continue; }
        if (!Number.isFinite(v))   { rejected.push(`${k} (not a number)`); continue; }
        const { min, max, kind } = STAT_RANGES[k];
        if (v < min || v > max)    { rejected.push(`${k} (${v} outside ${min}-${max})`); continue; }
        clean[k] = Math.round(v * 100) / 100;   // 2-decimal cap
        if (kind === 'weight') hasWeightWrite = true;
        if (kind === 'length') hasLengthWrite = true;
      }
      if (Object.keys(clean).length === 0) {
        return toolError(
          `No valid stats. Allowed keys: ${[...ALLOWED_STATS].join(', ')}. ` +
          `Rejected: ${rejected.join('; ')}`
        );
      }
      // Unit tag handling is safety-critical because the tag is SHARED
      // across all fields of its kind (7 length metrics share lengths_unit).
      //
      //  a) Row already tagged: convert canonical kg/cm into the row's
      //     stored unit so the tag stays consistent.
      //  b) Row has same-kind values but NO tag (legacy pre-tagging
      //     row): REFUSE. Guessing the historical unit from the user's
      //     CURRENT display preference is unsafe — users switch units
      //     over time. Ask them to edit the day once in the app to
      //     attach unit tags, then MCP writes will preserve them.
      //  c) Row has no values of that kind: stamp 'kg'/'cm' and write
      //     canonical values directly.
      let next;
      try {
        next = mutateDiaryDay(userId, day, cur => {
          const merged = { ...cur.bodyStats, ...clean };
          const bs = cur.bodyStats || {};

          if (hasWeightWrite) {
            const tagged = !!bs.weight_unit;
            const hasLegacy = !tagged && bs.weight != null;
            if (hasLegacy) {
              throw new LegacyBodyStatsError(
                `Day ${day} has an untagged legacy weight value; cannot safely tag it as ` +
                'kg or lb from MCP. Open the day in the app and re-save the weight once ' +
                '(this attaches the unit tag), then MCP writes will merge correctly.'
              );
            }
            const effectiveUnit = tagged ? bs.weight_unit : 'kg';       // (a) or (c)
            if (effectiveUnit === 'lb') {
              merged.weight = Math.round(clean.weight * 2.20462 * 10) / 10;
            }
            merged.weight_unit = effectiveUnit;
          }

          if (hasLengthWrite) {
            const tagged = !!bs.lengths_unit;
            const anyLegacy = !tagged && LENGTH_KEYS.some(k => bs[k] != null);
            if (anyLegacy) {
              throw new LegacyBodyStatsError(
                `Day ${day} has untagged legacy length values; cannot safely tag them as ` +
                'cm or in from MCP. Open the day in the app and re-save any length once ' +
                '(this attaches the unit tag), then MCP writes will merge correctly.'
              );
            }
            const effectiveUnit = tagged ? bs.lengths_unit : 'cm';      // (a) or (c)
            if (effectiveUnit === 'in') {
              for (const k of LENGTH_KEYS) {
                if (k in clean) merged[k] = Math.round((clean[k] / 2.54) * 10) / 10;
              }
            }
            merged.lengths_unit = effectiveUnit;
          }

          return { ...cur, bodyStats: merged };
        });
      } catch (e) {
        if (e instanceof DiaryTombstonedError)    return toolError(e.message);
        if (e instanceof LegacyBodyStatsError)    return toolError(e.message);
        throw e;
      }

      return toolResult({
        ok: true,
        date: day,
        set: clean,
        rejected: rejected.length ? rejected : undefined,
        current_stats: next.bodyStats,
      });
    }
  );
}
