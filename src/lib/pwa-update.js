/**
 * pwa-update.js — bridge between Vite PWA's `virtual:pwa-register` and
 * the Svelte UI. Fills the gap the old UpdateBanner comment promised
 * but never implemented (banner said "PWA-bundle-update banner when a
 * new service worker is ready" but the code returned before rendering).
 *
 * How it works:
 * - vite.config.js sets registerType: 'prompt', so the SW downloads new
 *   bundles but WAITS for us to activate them.
 * - On mount (from App.svelte's onMount) we call registerPwaSw(), which
 *   registers `virtual:pwa-register`'s onNeedRefresh callback.
 * - When Vite tells us a new SW is waiting, we set `pwaUpdateReady`
 *   true. UpdateBanner subscribes to that store and pops the banner.
 * - When the user taps View/Update, we call `applyPwaUpdate()`. That
 *   hands off to the registered `updateSW(true)` function, which
 *   activates the waiting SW and reloads the page. Fresh bundle live.
 *
 * On native (Capacitor) this is a no-op — the APK-update path is what
 * matters there. Guarded by isNative in registerPwaSw().
 */
import { writable } from 'svelte/store';
import { isNative } from './platform.js';

export const pwaUpdateReady = writable(false);

let _updateSW = null;   // populated by registerSW's return value
let _registered = false;

/** Wire virtual:pwa-register once per session. Safe to call multiple
 *  times; only the first has an effect. */
export function registerPwaSw() {
  if (_registered || isNative) return;
  _registered = true;
  // Dynamic import so PWA plugin's virtual module doesn't blow up in
  // dev / SSR contexts where it may not resolve. Failure is silent —
  // GitHub-tag check still works.
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      _updateSW = registerSW({
        immediate: true,
        onNeedRefresh() { pwaUpdateReady.set(true); },
        onOfflineReady() { /* first-install cache complete — no user-visible signal needed */ },
        onRegisterError(err) { console.warn('[pwa-update] SW register failed:', err?.message || err); },
      });
    })
    .catch((err) => {
      console.warn('[pwa-update] virtual:pwa-register unavailable:', err?.message || err);
    });
}

/** Force the browser to re-fetch sw.js and check for a new bundle.
 *  Without this, the browser only checks the SW file once per navigation
 *  or every 24 hours (whichever comes first), so a long-lived tab would
 *  never see a fresh deploy. Called on the same cadence as the GitHub-
 *  tag check + on visibility change (see App.svelte). No-op if the SW
 *  isn't registered yet (silent). */
export function checkForPwaUpdate() {
  if (!_updateSW || isNative) return;
  try { _updateSW(); } catch (e) { console.warn('[pwa-update] check failed:', e?.message || e); }
}

/** Activate the waiting service worker and reload. Called by the banner
 *  when the user picks View/Update. No-op if nothing's waiting. */
export function applyPwaUpdate() {
  if (!_updateSW) return;
  try { _updateSW(true); } catch (e) { console.warn('[pwa-update] activate failed:', e?.message || e); }
}
