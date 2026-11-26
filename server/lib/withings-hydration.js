// Withings sends body water (meastype 77, "Hydration") in kilograms, not
// percent (developer.withings.com, Notification categories: "77 Hydration
// (kg)"). Everywhere NutriTrace shows it, it's Body Water as a percentage of
// weight, as a scale shows it and as /api/v1/body-measurements takes it.

/** Hydration in kg as a percentage of the same reading's weight, one
 *  decimal; null when it can't be worked out (no weight, or not less than it). */
export function hydrationPct(hydrationKg, weightKg) {
  const h = Number(hydrationKg), w = Number(weightKg);
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0 || h >= w) return null;
  return Math.round(h / w * 1000) / 10;
}
