/**
 * fold.js: where a foldable's fold is, when it matters.
 *
 * `fold` is null on ordinary screens and on a foldable opened flat. Half open,
 * it's { posture, start, end }:
 *   'book'     the fold runs top to bottom; start/end are x positions
 *   'tabletop' the fold runs side to side;  start/end are y positions
 *
 * The Android app gets this from the Fold plugin (Jetpack WindowManager). A
 * browser that supports the Viewport Segments API reports it the same way.
 * The <html> element gets fold-book or fold-tabletop and --fold-start/--fold-end.
 */
import { writable } from 'svelte/store';
import { isNative } from './platform.js';

export const fold = writable(null);

import { foldFromFeatures, foldFromSegments } from './fold-core.js';
export { foldFromFeatures, foldFromSegments };

function apply(next) {
  const root = document.documentElement;
  root.classList.toggle('fold-book', next?.posture === 'book');
  root.classList.toggle('fold-tabletop', next?.posture === 'tabletop');
  root.style.setProperty('--fold-start', next ? `${next.start}px` : '0px');
  root.style.setProperty('--fold-end', next ? `${next.end}px` : '0px');
  fold.set(next);
}

let started = false;
export async function initFold() {
  if (started || typeof window === 'undefined') return;
  started = true;
  if (isNative) {
    try {
      const { registerPlugin } = await import('@capacitor/core');
      const Fold = registerPlugin('Fold');
      await Fold.addListener('change', (data) => apply(foldFromFeatures(data)));
      apply(foldFromFeatures(await Fold.getState()));
    } catch { /* an older app build without the plugin */ }
    return;
  }
  if (window.viewport && 'segments' in window.viewport) {
    const read = () => apply(foldFromSegments(window.viewport.segments));
    window.addEventListener('resize', read);
    window.matchMedia?.('(horizontal-viewport-segments: 2)').addEventListener?.('change', read);
    window.matchMedia?.('(vertical-viewport-segments: 2)').addEventListener?.('change', read);
    read();
  }
}
