/**
 * scroll-anchor.js: find the element that actually scrolls.
 *
 * The window never scrolls in this app. Pages live inside
 * `.page-transition`, which is `position: fixed` with `overflow-y: auto`,
 * so `window.scrollY` is always 0. Code that measured a position against it
 * (#217) read the right number only while the page sat at the top: once the
 * user had scrolled, the Foods filter rail and detail pane were re-measured
 * on the next list resize and pinned over the header and search bar. The
 * same reading also made "return to where you were" after editing a food
 * always land back at the top.
 */

/** The nearest scrollable ancestor, or the page's own scroller. */
export function pageScroller(el) {
  if (typeof document === 'undefined') return null;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.classList?.contains('page-transition')) return node;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    if (style && /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.querySelector('.page-transition');
}

/** How far the page is scrolled, whichever element is doing the scrolling. */
export function pageScrollTop(el) {
  const scroller = pageScroller(el);
  if (scroller) return scroller.scrollTop || 0;
  if (typeof window === 'undefined') return 0;
  return window.scrollY || document.documentElement?.scrollTop || 0;
}

/** Scroll the page back to a saved offset. */
export function pageScrollTo(el, top) {
  const scroller = pageScroller(el);
  if (scroller) scroller.scrollTop = top;
  else if (typeof window !== 'undefined') window.scrollTo(0, top);
}

/**
 * Scroll back to a saved offset once the list is tall enough to reach it.
 * Returning from the food editor re-renders the list, and a single attempt
 * lands short because the rows are not all in the DOM yet: the browser
 * clamps the scroll to whatever has rendered. Keep trying for a few frames,
 * and stop as soon as the offset sticks or the frames run out.
 */
export function restorePageScroll(el, top, frames = 20) {
  if (!(top > 0)) return;
  pageScrollTo(el, top);
  if (frames <= 0 || Math.abs(pageScrollTop(el) - top) <= 2) return;
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => restorePageScroll(el, top, frames - 1));
}
