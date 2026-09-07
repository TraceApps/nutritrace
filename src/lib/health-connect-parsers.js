/**
 * health-connect-parsers.js
 *
 * Pure parsers for record values returned by @devmaxime/capacitor-health-connect
 * 1.1.0. That plugin only custom-converts a handful of types (Weight, Steps,
 * Sleep, RestingHeartRate); everything else arrives in JavaScript as the
 * AndroidX `connect-client` 1.1.0 Kotlin `toString()` representation, a
 * plain string like `mass=25.4 kilograms` or `basalMetabolicRate=1650.0 Watts`.
 *
 * Every parser returns a positive Number on success, `null` on failure.
 * Callers must treat null as "no data" and OMIT the wellness_data key,
 * NOT write 0. missing != zero, per #206: writing 0 for a real metric
 * (BMR, Lean Body Mass, Bone Mass) is user-visible-wrong.
 *
 * BMR power is converted from Watts to kcal/day here (Health Connect's
 * canonical unit is kcal/day but the string form ships Watts).
 * Conversion factor: 1 W * 86400 s/day / 4184 J/kcal = 20.6501 kcal/day.
 */

/** Watts to kcal/day. Uses the thermochemical calorie (4184 J/kcal). */
const WATTS_TO_KCAL_PER_DAY = 86400 / 4184; // 20.6501...

/**
 * Return a positive number or null. Rejects 0, negative, NaN, non-finite
 * so callers can uniformly treat null as "omit this metric".
 */
function _positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Extract mass in kilograms from a record. Accepts:
 *   - Object shapes: { mass: { inKilograms } }, { weight: { inKilograms } },
 *                    { mass: <number> }, { value: <number> }.
 *   - String shape (Kotlin toString): 'mass=25.4 kilograms',
 *                                     'weight=79.3 kilograms',
 *                                     'mass=25400.0 grams'.
 * Returns kg (Number > 0) or null.
 */
export function parseMassKg(rec) {
  if (rec == null) return null;
  if (typeof rec === 'string') {
    // Kilograms wins whenever present, whichever wrapper the plugin uses.
    // Patterns covered: `mass=1.5 kilograms`, `Mass{value=1.5, unit=KILOGRAMS}`,
    // `Mass(inKilograms=1.5)`, `mass=1.5kg`.
    let m = rec.match(/(?:mass|weight)=([\d.]+)\s*kilograms\b/i)
         || rec.match(/(?:mass|weight)=([\d.]+)\s*kg\b/i)
         || rec.match(/(?:mass|weight)[\s\S]{0,60}?value=([\d.]+)[^A-Za-z]{0,20}unit=KILOGRAMS/i)
         || rec.match(/(?:mass|weight)[\s\S]{0,60}?inKilograms=([\d.]+)/i);
    if (m) return _positive(m[1]);
    // Grams path (both `1500 grams` and `1500g`).
    m = rec.match(/(?:mass|weight)=([\d.]+)\s*grams\b/i)
     || rec.match(/(?:mass|weight)=([\d.]+)\s*g\b/i)
     || rec.match(/(?:mass|weight)[\s\S]{0,60}?value=([\d.]+)[^A-Za-z]{0,20}unit=GRAMS/i);
    if (m) {
      const v = Number(m[1]);
      return Number.isFinite(v) && v > 0 ? v / 1000 : null;
    }
    // Pounds path (US Health Connect users occasionally sync in lbs).
    m = rec.match(/(?:mass|weight)=([\d.]+)\s*pounds\b/i)
     || rec.match(/(?:mass|weight)[\s\S]{0,60}?value=([\d.]+)[^A-Za-z]{0,20}unit=POUNDS/i);
    if (m) {
      const v = Number(m[1]);
      return Number.isFinite(v) && v > 0 ? v * 0.45359237 : null;
    }
    // Unitless last resort: only trust when the number looks like kg
    // (typical body composition: 0.1 to 200). Rejects nonsense like a
    // stray timestamp fragment that starts with digits.
    m = rec.match(/(?:mass|weight)=([\d.]+)/i);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0 && v < 500) return v;
    }
    return null;
  }
  if (typeof rec === 'object') {
    return _positive(
      rec.mass?.inKilograms
      ?? rec.weight?.inKilograms
      ?? rec.mass?.value
      ?? rec.weight?.value
      ?? (typeof rec.mass === 'number' ? rec.mass : null)
      ?? (typeof rec.weight === 'number' ? rec.weight : null)
      ?? rec.value
    );
  }
  return null;
}

/**
 * Extract a percentage value from a record. Accepts:
 *   - Object shapes: { percentage: { value } }, { percentage: <number> }, { value }.
 *   - String shape: 'percentage=18.5%'.
 * Returns the percent (Number > 0) or null.
 */
export function parsePercent(rec) {
  if (rec == null) return null;
  if (typeof rec === 'string') {
    // Covers `percentage=18.5%`, `Percentage{value=18.5}`, `percentage=18.5`.
    const m = rec.match(/percentage=([\d.]+)\s*%/i)
           || rec.match(/percentage[\s\S]{0,40}?value=([\d.]+)/i)
           || rec.match(/percentage=([\d.]+)/i);
    return m ? _positive(m[1]) : null;
  }
  if (typeof rec === 'object') {
    return _positive(
      rec.percentage?.value
      ?? (typeof rec.percentage === 'number' ? rec.percentage : null)
      ?? rec.value
    );
  }
  return null;
}

/**
 * Extract Basal Metabolic Rate as kcal/day. Accepts:
 *   - Object shape: { basalMetabolicRate: { inKilocaloriesPerDay } }
 *                   or { basalMetabolicRate: { inWatts } }, or { value }.
 *   - String shape: 'basalMetabolicRate=1650.0 Watts',
 *                   'basalMetabolicRate=1650.0 kilocaloriesPerDay'.
 * Returns kcal/day (Number > 0) or null.
 */
export function parseBmrKcalPerDay(rec) {
  if (rec == null) return null;
  if (typeof rec === 'string') {
    // Kilocalories-per-day form (already correct units).
    let m = rec.match(/basalMetabolicRate=([\d.]+)\s*kilocaloriesPerDay/i)
         || rec.match(/basalMetabolicRate[\s\S]{0,60}?inKilocaloriesPerDay=([\d.]+)/i)
         || rec.match(/basalMetabolicRate[\s\S]{0,60}?value=([\d.]+)[^A-Za-z]{0,20}unit=KILOCALORIES_PER_DAY/i);
    if (m) return _positive(m[1]);
    // Watts form: convert.
    m = rec.match(/basalMetabolicRate=([\d.]+)\s*watts/i)
     || rec.match(/basalMetabolicRate[\s\S]{0,60}?inWatts=([\d.]+)/i)
     || rec.match(/basalMetabolicRate[\s\S]{0,60}?value=([\d.]+)[^A-Za-z]{0,20}unit=WATTS/i);
    if (m) {
      const w = Number(m[1]);
      return Number.isFinite(w) && w > 0 ? w * WATTS_TO_KCAL_PER_DAY : null;
    }
    return null;
  }
  if (typeof rec === 'object') {
    const kcal = rec.basalMetabolicRate?.inKilocaloriesPerDay ?? rec.value;
    if (_positive(kcal) != null) return _positive(kcal);
    const watts = rec.basalMetabolicRate?.inWatts;
    if (_positive(watts) != null) return _positive(watts) * WATTS_TO_KCAL_PER_DAY;
    return null;
  }
  return null;
}

/**
 * Extract temperature in Celsius. Accepts:
 *   - Object shape: { temperature: { inCelsius } }, { value }.
 *   - String shape: 'temperature=36.5 celsius' or 'temperature=97.7 fahrenheit'.
 * Returns Celsius (Number, may be < 0 in cold-climate weird cases so we
 * only reject null / NaN, not zero for this one) or null.
 *
 * Callers that require a positive value can still gate on the returned
 * value; body temperature realistically is always > 30 so any null-check
 * plus a sanity floor is defensible on their side.
 */
export function parseTemperatureC(rec) {
  if (rec == null) return null;
  if (typeof rec === 'string') {
    let m = rec.match(/temperature=([\d.]+)\s*celsius/i)
         || rec.match(/temperature[\s\S]{0,60}?inCelsius=([\d.]+)/i)
         || rec.match(/temperature[\s\S]{0,60}?value=([\d.]+)[^A-Za-z]{0,20}unit=CELSIUS/i);
    if (m) {
      const v = Number(m[1]);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    m = rec.match(/temperature=([\d.]+)\s*fahrenheit/i)
     || rec.match(/temperature[\s\S]{0,60}?inFahrenheit=([\d.]+)/i)
     || rec.match(/temperature[\s\S]{0,60}?value=([\d.]+)[^A-Za-z]{0,20}unit=FAHRENHEIT/i);
    if (m) {
      const f = Number(m[1]);
      return Number.isFinite(f) && f > 0 ? (f - 32) * 5 / 9 : null;
    }
    return null;
  }
  if (typeof rec === 'object') {
    const c = rec.temperature?.inCelsius;
    if (_positive(c) != null) return _positive(c);
    const f = rec.temperature?.inFahrenheit;
    if (_positive(f) != null) return _positive((f - 32) * 5 / 9);
    return _positive(rec.value);
  }
  return null;
}

/**
 * Extract respiratory rate in breaths per minute. Accepts:
 *   - Object: { rate }, { value }.
 *   - String: 'rate=15.0'.
 */
export function parseRespiratoryRate(rec) {
  if (rec == null) return null;
  if (typeof rec === 'string') {
    const m = rec.match(/rate=([\d.]+)/i);
    return m ? _positive(m[1]) : null;
  }
  if (typeof rec === 'object') {
    return _positive(rec.rate ?? rec.value);
  }
  return null;
}

/**
 * Extract VO2 Max in mL/kg/min. Accepts:
 *   - Object: { vo2MillilitersPerMinuteKilogram }, { value }.
 *   - String: 'vo2MillilitersPerMinuteKilogram=42.5'.
 */
export function parseVo2Max(rec) {
  if (rec == null) return null;
  if (typeof rec === 'string') {
    const m = rec.match(/vo2MillilitersPerMinuteKilogram=([\d.]+)/i);
    return m ? _positive(m[1]) : null;
  }
  if (typeof rec === 'object') {
    return _positive(rec.vo2MillilitersPerMinuteKilogram ?? rec.value);
  }
  return null;
}

export const _internal = { WATTS_TO_KCAL_PER_DAY };
