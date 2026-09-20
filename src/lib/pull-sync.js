/**
 * pull-sync.js: which touches may start the Android pull-to-refresh.
 *
 * Pull-to-refresh listens to every touch on the page (so it also works over
 * the fixed top bar). Anything that uses a downward drag for its own purpose
 * must be left out, or dragging it down while the page is at the top reads
 * as a pull and syncs (#225: moving the Trace button toward the bottom of
 * the screen refreshed the Diary).
 *
 *   dialogs, sheets, sidebar, bottom bar and dock: their own touch handling
 *   .ai-fab       the draggable Trace button
 *   .drag-handle  reorder handles (meal names, nutrients, body stats,
 *                 Statistics categories, Meal Editor ingredients)
 *   .crop-box     the photo cropper
 *   [data-no-pull-sync]  opt-out for anything draggable added later
 */
export const PULL_SYNC_EXEMPT = [
  '[role="dialog"]', '.sheet-backdrop', '.sidebar-panel', '.sidebar-backdrop',
  '.bottom-nav', '.bottom-dock',
  '.ai-fab', '.drag-handle', '.crop-box', '[data-no-pull-sync]',
].join(', ');

/** True when a touch on `target` must not start a pull-to-refresh. */
export function isPullSyncExempt(target) {
  return !!(target && typeof target.closest === 'function' && target.closest(PULL_SYNC_EXEMPT));
}
