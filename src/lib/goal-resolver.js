/**
 * goal-resolver.js
 *
 * Resolve a goal entry to its numeric target. Split into two shapes:
 *
 *   resolveGoalFor(g, dateStr):
 *     Single-day resolver, used by Diary. Returns the target for the
 *     specific calendar date `dateStr` (YYYY-MM-DD). Per-weekday goals
 *     (sharedGoal === false with `days[]` populated) resolve to
 *     days[weekday]; shared goals fall through to max ?? min.
 *
 *   resolveRangeGoal(g):
 *     Range resolver, used by Statistics. Returns a single representative
 *     target for a period. Per-weekday goals resolve to the AVERAGE of
 *     days[] because Statistics summarises a range and a "vs goal" chip
 *     against the weekly PEAK is misleading (mixed-target users would
 *     read under-target days as on-target). Shared goals fall through.
 *
 * Bug context: #203. Goals.svelte's saveGoal() stores the weekly PEAK
 * in g.max / g.min even when sharedGoal === false, treating max/min as
 * an aggregate cache alongside the authoritative g.days[]. Every reader
 * that reached for `g.max ?? g.min` was silently seeing the peak, so
 * Diary's Remaining and Statistics' Goal line were wrong on every
 * non-peak weekday.
 */

/**
 * Resolve a goal entry to the target for one specific calendar date.
 * Returns a positive number, 0, or null when the entry has no usable
 * target. Never throws: bad input returns null and callers can fall
 * back to their own default (e.g. 2000 kcal).
 *
 * @param {object|null|undefined} g       Goal entry from the goals store.
 * @param {string|null|undefined} dateStr YYYY-MM-DD (local calendar date).
 * @returns {number|null}
 */
export function resolveGoalFor(g, dateStr) {
  if (!g) return null;
  if (g.sharedGoal !== false) {
    return g.max ?? g.min ?? null;
  }
  if (Array.isArray(g.days) && g.days.length === 7 && dateStr) {
    // Parse as local midnight so getDay() reads the calendar weekday
    // the user sees on the date bar, not a UTC-shifted one that would
    // flip near midnight in negative-offset time zones.
    const d = new Date(`${dateStr}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      const v = g.days[d.getDay()];
      if (v != null) return v;
    }
  }
  return g.max ?? g.min ?? null;
}

/**
 * Resolve a goal entry to a single representative target for a date
 * range. Shared goals return the saved value (max ?? min). Per-weekday
 * goals return the AVERAGE of the seven days[] entries so a chart line
 * and "vs goal" delta reflect the typical target, not the weekly peak.
 *
 * @param {object|null|undefined} g Goal entry from the goals store.
 * @returns {number|null}
 */
export function resolveRangeGoal(g) {
  if (!g) return null;
  if (g.sharedGoal !== false) {
    return g.max ?? g.min ?? null;
  }
  if (Array.isArray(g.days) && g.days.length) {
    const vals = g.days
      .map(v => Number(v))
      .filter(v => Number.isFinite(v) && v > 0);
    if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return g.max ?? g.min ?? null;
}
