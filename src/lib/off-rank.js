/**
 * off-rank.js: ordering for Open Food Facts name-search results.
 *
 * OFF's relevance often gives many results the same or nearly the same
 * score (a "nutella" search returns eleven entries tied at one score), and
 * within such a group its order says nothing about which entry is useful.
 * Those groups are sorted by quality signals, in priority order:
 *   1. has a photo (users pick with their eyes), public OFF only
 *   2. completeness (0-1, OFF's own "how filled in" metric)
 *   3. has a real Nutri-Score (enough data to compute one)
 * Missing signals count as 0, so thin entries sink but are never hidden.
 *
 * #213 (@NoBackups): quality signals used to reorder the whole page, so a
 * product OFF ranked first by a wide margin ("Blue Label Marie Biscuits",
 * score 77 against 18 for the next) sank to #38 because it had no photo and
 * 30% completeness, typical for regions OFF contributors photograph less.
 * Public OFF results carry a relevance score (`_score`), so results are now
 * grouped by it: OFF's order holds between clearly different scores, and
 * quality only decides within a group of close ones.
 *
 * #192 (@systems-monitor): a local OFF mirror (OFF_LOCAL_DB) returns no
 * score and its curated entries are typically photoless, so mirror results
 * are ordered by completeness and Nutri-Score without the photo tier.
 */

// How close scores must be to count as the same match quality: within 10%
// of the best score in the group.
export const OFF_RELEVANCE_BAND = 0.9;

export function hasNutriScore(food) {
  const g = food && food.nutriscore;
  return !!g && g !== 'unknown' && g !== 'not-applicable';
}

function _qualityCompare(a, b, photos) {
  if (photos) {
    const d = (b.imgUrl ? 1 : 0) - (a.imgUrl ? 1 : 0);
    if (d) return d;
  }
  const c = (b.completeness ?? 0) - (a.completeness ?? 0);
  if (c) return c;
  return (hasNutriScore(b) ? 1 : 0) - (hasNutriScore(a) ? 1 : 0);
}

/**
 * @param {{ food: object, score?: number }[]} entries mapped foods in the
 *   order OFF returned them, each with that hit's `_score` when it had one.
 *   The score stays beside the food rather than on it, because search
 *   results are copied into diary entries as they are.
 * @param {{ fromMirror?: boolean }} opts true when the response came from
 *   the local mirror (a `hits` envelope without scores).
 * @returns {object[]} the foods, ranked.
 */
export function rankOFFResults(entries, { fromMirror = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const scored = entries.every((e) => typeof e.score === 'number' && Number.isFinite(e.score));

  if (!scored) {
    // Mirror results, or an older envelope without scores: quality only.
    return entries.slice()
      .sort((a, b) => _qualityCompare(a.food, b.food, !fromMirror))
      .map((e) => e.food);
  }

  // OFF returns hits best first; sorting again (stable) just guards the
  // grouping below against an unsorted page.
  const byScore = entries.slice().sort((a, b) => b.score - a.score);
  const out = [];
  let group = [];
  let top = null;
  const flush = () => {
    group.sort((a, b) => _qualityCompare(a.food, b.food, true));
    for (const e of group) out.push(e.food);
    group = [];
  };
  for (const e of byScore) {
    if (top === null || e.score < top * OFF_RELEVANCE_BAND) {
      flush();
      top = e.score;
    }
    group.push(e);
  }
  flush();
  return out;
}
