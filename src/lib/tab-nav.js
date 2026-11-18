// Moving between the main tabs (bottom bar, sidebar) in the Android app and
// the installed web app (from cooktrace#99). Every tab tap used to add to the back
// history, so back walked through each tab visited before it left. Now the
// history holds at most: Diary, the tab you're on, and the pages opened
// inside that tab. Back goes one step inside a tab, then to Diary, then
// leaves (the Android app asks "Tap again to exit" first). A browser tab
// keeps the browser's usual history.
//
// Each history entry is stamped with its depth (0 = where the app started),
// so a tab tap can first go back to depth 0 or 1, dropping the pages left
// open in the tab before, and then show the new tab.
import { push, replace } from 'svelte-spa-router';
import { isNative } from './platform.js';

export const HOME_TAB = '/';
const KEY = '__ctTabDepth';

let depth = 0;
let lastHref = '';

/** True in the Android app and in an installed (standalone) web app. */
export function isAppLike(native = isNative, win = typeof window !== 'undefined' ? window : null) {
  if (native) return true;
  try {
    return !!(win?.matchMedia?.('(display-mode: standalone)')?.matches || win?.navigator?.standalone);
  } catch {
    return false;
  }
}

/** True on the home tab's main page ('/' opens Diary too). */
export function isHomeTab(loc) {
  const base = String(loc || '/').split('?')[0];
  return base === '/' || base === HOME_TAB;
}

function currentLoc(win) {
  return (win.location.hash || '').replace(/^#/, '') || '/';
}

function stamp(win) {
  try { win.history.replaceState({ ...(win.history.state || {}), [KEY]: depth }, ''); } catch { /* ignore */ }
}

/** Start keeping each entry's depth. Call once at start-up. */
export function trackTabDepth(win = typeof window !== 'undefined' ? window : null) {
  if (!win || !isAppLike(isNative, win)) return;
  const s = win.history.state?.[KEY];
  depth = Number.isInteger(s) ? s : 0;
  lastHref = win.location.href;
  stamp(win);
  // A hash change fires popstate and hashchange; handle each move once.
  const onMove = (e) => {
    if (win.location.href === lastHref && e.type === 'hashchange') return;
    lastHref = win.location.href;
    // Back or forward lands on a stamped entry; a new page has no stamp yet.
    // (Pages that rewrite their address keep the state, so stamps stay.)
    const v = win.history.state?.[KEY];
    depth = Number.isInteger(v) ? v : depth + 1;
    stamp(win);
  };
  win.addEventListener('popstate', onMove);
  win.addEventListener('hashchange', onMove);
}

function travel(win, n) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      win.removeEventListener('popstate', finish);
      setTimeout(resolve, 0);
    };
    win.addEventListener('popstate', finish);
    win.history.go(n);
    setTimeout(finish, 500);
  });
}

export async function goTab(path, win = typeof window !== 'undefined' ? window : null) {
  if (!win || !isAppLike(isNative, win)) return push(path);
  if (isHomeTab(path)) {
    if (depth > 0) await travel(win, -depth);
    const here = currentLoc(win);
    // '/' already is Diary; anything else (another tab, or Diary with a
    // filter) becomes the tab's main page.
    if (here !== path && !(here === '/' && path === HOME_TAB)) return replace(path);
    return;
  }
  if (depth > 1) await travel(win, -(depth - 1));
  if (depth === 0 && isHomeTab(currentLoc(win))) return push(path);
  if (currentLoc(win) === path) return;
  return replace(path);
}

/** Test hook: the depth this page thinks it's at. */
export function _tabDepth() { return depth; }
