/** fold-core.js: size classes, and fold reports turned into { posture, start, end }. Pure, and tested. */

export const MEDIUM_MIN = 600;
export const EXPANDED_MIN = 1024;

/** compact under 600px, medium to 1023px, expanded from 1024px. */
export function sizeClassFor(width) {
  return width < MEDIUM_MIN ? 'compact' : width < EXPANDED_MIN ? 'medium' : 'expanded';
}

/** A plugin payload ({ features: [...] }) to a fold, or null. Pure. */
export function foldFromFeatures(payload) {
  const f = (payload?.features || []).find(x => x.state === 'half_opened' || x.separating);
  if (!f) return null;
  const vertical = f.orientation === 'vertical';
  const start = Math.round(vertical ? f.left : f.top);
  const end = Math.round(vertical ? f.right : f.bottom);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { posture: vertical ? 'book' : 'tabletop', start, end };
}

/** Viewport segments (DOMRect-like) to a fold, or null. Pure. */
export function foldFromSegments(segments) {
  if (!segments || segments.length !== 2) return null;
  const [a, b] = segments;
  if (b.x >= a.x + a.width - 1 && Math.abs(a.y - b.y) < 2) return { posture: 'book', start: Math.round(a.x + a.width), end: Math.round(b.x) };
  if (b.y >= a.y + a.height - 1 && Math.abs(a.x - b.x) < 2) return { posture: 'tabletop', start: Math.round(a.y + a.height), end: Math.round(b.y) };
  return null;
}

/**
 * Card columns either side of a book fold, or null when the crease does not
 * cross this box, or leaves too little room on one side to be worth it.
 *
 * A masonry grid across a half-open foldable puts cards over the crease, with
 * their text split by it. Dealing into separate column runs either side, with
 * the hinge as an empty track between them, keeps every card on one panel.
 *
 * `left` is the box's own x on screen, since the fold is reported in screen
 * coordinates and the grid may sit beside a sidebar.
 */
export function columnsAcrossFold({ width, left = 0, gap, minCard, fold }) {
  if (!fold || fold.posture !== 'book') return null;
  if (!(width > 0) || !(minCard > 0)) return null;
  const start = fold.start - left;
  const end = fold.end - left;
  // Entirely to one side of this grid: nothing to do.
  if (!(start > 0 && end < width)) return null;
  const fit = (available) => Math.floor((available + gap) / (minCard + gap));
  const l = fit(start);
  const r = fit(width - end);
  // A single column that would be squeezed to nothing is worse than a card
  // crossing the crease, so the split only happens when both sides work.
  if (l < 1 || r < 1) return null;
  return { left: l, right: r, hinge: Math.max(0, Math.round(end - start)) };
}

/**
 * Slide a floating panel off a crease, along the axis the crease runs across.
 *
 * A menu or picker is placed in script rather than by a stylesheet, so nothing
 * else can move it off the fold, and unlike a scrolling list it cannot be
 * nudged out of the way by the reader. `pos` and `size` are the panel's near
 * edge and its length; `start` and `end` are the crease; `min` and `max` bound
 * the screen.
 *
 * Whichever side the panel already leans towards is tried first. If it fits on
 * neither, it is left where the caller put it: half off the screen is worse
 * than across a crease.
 */
export function keepOffCrease({ pos, size, start, end, min, max }) {
  if (!Number.isFinite(pos) || !Number.isFinite(size) || !(end > start)) return pos;
  if (pos + size <= start || pos >= end) return pos;
  const leansEarly = pos + size / 2 < (start + end) / 2;
  const before = start - size;
  const after = end;
  for (const candidate of leansEarly ? [before, after] : [after, before]) {
    if (candidate >= min && candidate + size <= max) return candidate;
  }
  return pos;
}

/**
 * Where a menu anchored to a field should open: below it, or flipped above.
 *
 * A list that opens below a field and runs under a horizontal crease is split
 * in half by the hinge, and unlike the page behind it there is no scrolling it
 * clear. The crease is treated as the edge of the available space, so the menu
 * either stops short of it or opens on the other side of the field.
 *
 * Sideways is deliberately left alone: these menus match the width of the
 * field they belong to, and a list that slid away from its own field would
 * look broken rather than considerate.
 *
 * Returns the top to place it at, the height it may use, and which way it
 * went. With no fold it behaves as an ordinary flip-when-short menu.
 */
export function placeAnchoredMenu({
  anchorTop, anchorBottom, viewportHeight,
  maxHeight = 320, gap = 4, margin = 8, fold,
}) {
  const t = fold?.posture === 'tabletop' ? fold : null;

  // The run of screen below the field: it ends at the crease, or begins after
  // it when the field itself reaches into the crease.
  let belowStart = anchorBottom + gap;
  let belowEnd = viewportHeight - margin;
  if (t) {
    if (belowStart < t.start) belowEnd = Math.min(belowEnd, t.start);
    else belowStart = Math.max(belowStart, t.end);
  }
  // And the run above it, the same way round.
  let aboveStart = margin;
  let aboveEnd = anchorTop - gap;
  if (t) {
    if (aboveEnd > t.end) aboveStart = Math.max(aboveStart, t.end);
    else aboveEnd = Math.min(aboveEnd, t.start);
  }

  const below = Math.max(0, belowEnd - belowStart);
  const above = Math.max(0, aboveEnd - aboveStart);
  const openAbove = below < Math.min(maxHeight, 200) && above > below;
  const height = Math.min(maxHeight, openAbove ? above : below);
  const top = openAbove ? aboveEnd - height : belowStart;
  return { top: Math.round(top), maxHeight: Math.round(height), above: openAbove };
}

/**
 * A grid template with an empty track where the crease is, or the fallback.
 *
 * `columnsAcrossFold` says how many card columns fit either side; this turns
 * that into the template, and `columnForIndex` puts each card in a column that
 * is not the hinge. Cards keep their reading order across the two pages, and
 * without a fold nothing changes.
 */
export function gridTemplateAcrossFold(split, fallback) {
  if (!split) return fallback;
  return `repeat(${split.left}, minmax(0, 1fr)) ${split.hinge}px repeat(${split.right}, minmax(0, 1fr))`;
}

/** Which column a card takes, counting past the hinge track. */
export function columnForIndex(index, split) {
  if (!split) return 'auto';
  const perRow = split.left + split.right;
  const place = index % perRow;
  // Tracks are 1-based and the hinge is the one after the left-hand page.
  return String(place < split.left ? place + 1 : place + 2);
}
