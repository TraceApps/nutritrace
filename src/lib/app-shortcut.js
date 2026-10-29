/**
 * app-shortcut.js (#278): the app icon's shortcuts.
 *
 * Long-press the app icon (Android, or the installed web app) for Scan
 * Barcode, Log Food, Log Water and Log Weight. Android opens
 * nutritrace://new/<kind> (res/xml/shortcuts.xml), which App.svelte sends to
 * /?new=<kind>; the web app's manifest opens ./#/?new=<kind> directly. The
 * Diary reads it there (shortcutFromQuery) and opens what was asked for, for
 * today:
 *
 *   barcode  the scanner, on the add screen the Diary's + opens, for the
 *            meal of this time of day (lib/meal-by-time.js)
 *   food     that add screen, on the Foods, Meals or Recipes tab used last
 *   water    the water card
 *   weight   the body stats sheet
 *
 * Signed out, the address waits under the sign-in screen and the Diary
 * opens it once signed in (Login.svelte leaves it in place).
 */

export const SHORTCUT_KINDS = ['barcode', 'food', 'water', 'weight'];

/** The kind a /?new=<kind> query asks for, or null. */
export function shortcutFromQuery(qs) {
  const kind = new URLSearchParams(String(qs || '').replace(/^\?/, '')).get('new');
  return SHORTCUT_KINDS.includes(kind) ? kind : null;
}

/** The kind a nutritrace://new/<kind> link (from parseAppLink) asks for, or null. */
export function shortcutFromAppLink(link) {
  if (!link || link.scheme !== 'nutritrace' || link.host !== 'new') return null;
  const kind = String(link.path || '').replace(/^\/+|\/+$/g, '').toLowerCase();
  return SHORTCUT_KINDS.includes(kind) ? kind : null;
}

/** True for a page address (location.hash) that is a shortcut waiting to open. */
export function isShortcutHash(hash) {
  const m = /^#?\/?(\?.*)?$/.exec(String(hash || ''));
  return !!m && !!shortcutFromQuery(m[1] || '');
}

/**
 * How to go to a shortcut's route from the page address (location.hash):
 * 'replace' on the first page with nothing else asked for (the app just
 * started), so Back from the first page doesn't stop on a copy of it;
 * 'push' anywhere else, so Back returns there.
 */
export function shortcutNav(hash) {
  return /^#?\/?$/.test(String(hash || '')) ? 'replace' : 'push';
}

// The launch URL stays the same for as long as the app runs, through every
// page reload (signing out, restoring a backup): only the first page that
// reads it opens it. sessionStorage lasts through a reload and starts empty
// in a new start of the app; a fresh start brings the link again anyway.
const LAUNCH_KEY = 'nt:launchShortcutRead';
/** True the first time this page session reads the launch URL's shortcut. */
export function firstLaunchRead(store = globalThis.sessionStorage) {
  try {
    if (store?.getItem(LAUNCH_KEY)) return false;
    store?.setItem(LAUNCH_KEY, '1');
  } catch {}
  return true;
}

// A shortcut that starts the app arrives twice on Android: as the launch URL
// and as appUrlOpen. The second within a few seconds is the same tap.
let _last = null;
/** The route for a shortcut's kind, or null for a repeat of the one just sent. */
export function shortcutRoute(kind, now = Date.now()) {
  if (!SHORTCUT_KINDS.includes(kind)) return null;
  if (_last && _last.kind === kind && now - _last.at < 3000) return null;
  _last = { kind, at: now };
  return `/?new=${kind}`;
}

/**
 * The add screen a Scan Barcode or Log Food shortcut opens: the Diary's +
 * (pick mode), marked as from a shortcut so it names where the food goes
 * and lets the meal and day change.
 */
export function shortcutPickRoute({ kind, meal, date }) {
  const q = new URLSearchParams({ pick: '1', meal: String(Number(meal) || 0), date: String(date || ''), via: 'shortcut' });
  if (kind === 'barcode') q.set('scan', '1');
  return '/foods?' + q.toString();
}

// The Foods, Meals or Recipes tab last used on the Foods page, on this device.
const TAB_KEY = 'nt:foodsLastTab';
export function rememberFoodsTab(tab, store = globalThis.localStorage) {
  if (![0, 1, 2].includes(tab)) return;
  try { store?.setItem(TAB_KEY, String(tab)); } catch {}
}
export function lastFoodsTab(store = globalThis.localStorage) {
  try {
    const n = Number(store?.getItem(TAB_KEY));
    return [0, 1, 2].includes(n) ? n : 0;
  } catch { return 0; }
}
