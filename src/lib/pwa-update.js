/**
 * pwa-update.js: the bridge between Vite PWA's `virtual:pwa-register` and
 * the Svelte UI.
 *
 * How it works:
 * - vite.config.js sets registerType: 'prompt', so the service worker
 *   downloads a new bundle but WAITS for us to activate it.
 * - registerPwaSw() (called from App.svelte) registers the callbacks and
 *   keeps the registration, which is the only thing that can ask the
 *   browser to look for a newer worker.
 * - When one is waiting, `pwaUpdateReady` goes true and the banner asks
 *   the user to reload.
 * - applyPwaUpdate() hands over to the waiting worker and reloads.
 *
 * Two things about `virtual:pwa-register` that this file exists to work
 * around, both learned from reading its source rather than its docs:
 *
 *   1. The function it returns takes a `reloadPage` argument and ignores
 *      it. All it does is post skip-waiting to a waiting worker. It is
 *      not, and never was, a way to check for an update: calling it when
 *      nothing is waiting does nothing at all, silently. Checking is
 *      `registration.update()`, which needs the registration, which only
 *      arrives through onRegisteredSW.
 *   2. The page reload after the handover comes from a `controlling`
 *      listener the library adds when it raises onNeedRefresh. If that
 *      handover never happens (no worker waiting any more, because
 *      another tab already took the update, or the worker activated while
 *      this tab sat open) then nothing happens and the button looks
 *      broken. So this reloads the page itself rather than trusting the
 *      handover to arrive.
 *
 * On native (Capacitor) this is a no-op: the APK path is what matters
 * there, and there is no bundle to swap.
 */
import { writable } from 'svelte/store';
import { isNative } from './platform.js';

export const pwaUpdateReady = writable(false);

let _updateSW = null;      // posts skip-waiting to the waiting worker
let _registration = null;  // the only handle that can ask for a check
let _registered = false;
let _reloading = false;

/** Reload once, whatever route we got here by. */
function _reloadOnce() {
  if (_reloading) return;
  _reloading = true;
  try { window.location.reload(); } catch { /* nothing else to try */ }
}

/** Wire virtual:pwa-register once per session. Safe to call repeatedly. */
export function registerPwaSw() {
  if (_registered || isNative) return;
  _registered = true;
  // Dynamic import so the plugin's virtual module can't blow up in dev or
  // SSR contexts where it may not resolve. Failure is silent: the release
  // check in Settings still works.
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      _updateSW = registerSW({
        immediate: true,
        onNeedRefresh() { pwaUpdateReady.set(true); },
        onRegisteredSW(_swUrl, registration) { _registration = registration || null; },
        onOfflineReady() { /* first install cached; nothing to say */ },
        onRegisterError(err) { console.warn('[pwa-update] SW register failed:', err?.message || err); },
      });
    })
    .catch((err) => {
      console.warn('[pwa-update] virtual:pwa-register unavailable:', err?.message || err);
    });
}

/**
 * Ask the browser to look for a newer worker.
 *
 * Without this a tab left open all day never notices a deploy: the browser
 * re-reads the worker on navigation, or every 24 hours, whichever comes
 * first. Called on the same cadence as the release check and when the tab
 * comes back to the front (see App.svelte).
 */
export async function checkForPwaUpdate() {
  if (isNative) return;
  try {
    const registration = _registration
      || (await navigator.serviceWorker?.getRegistration?.())
      || null;
    if (!registration) return;
    _registration = registration;
    await registration.update();
    // A worker already sitting there waiting, from a check made before this
    // tab was open: onNeedRefresh only fires on the transition, so without
    // this the banner would never appear for it.
    if (registration.waiting) pwaUpdateReady.set(true);
  } catch (e) {
    console.warn('[pwa-update] check failed:', e?.message || e);
  }
}

/**
 * Take the update: hand over to the waiting worker and reload.
 *
 * Reloading is unconditional. Either a worker is waiting, in which case it
 * is told to take over first so the reload lands on the new bundle, or
 * there is nothing waiting and a plain reload is both harmless and exactly
 * what the button says it does. A button that can do nothing is worse than
 * a reload that was not strictly needed.
 */
export async function applyPwaUpdate() {
  if (isNative) return;
  pwaUpdateReady.set(false);
  try {
    const registration = _registration
      || (await navigator.serviceWorker?.getRegistration?.())
      || null;
    if (registration?.waiting) {
      try { _updateSW?.(true); } catch { /* fall through to the reload */ }
      // The library reloads on handover; this is in case the handover never
      // lands, and it is a reload either way, so the worst case is one
      // reload rather than none.
      setTimeout(_reloadOnce, 1500);
      return;
    }
  } catch { /* no registration to talk to */ }
  _reloadOnce();
}
