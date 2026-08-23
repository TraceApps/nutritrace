<script>
  /**
   * UpdateBanner — top-of-app dismissible banner announcing an available
   * update. Renders in App.svelte, above the page content, on every
   * screen post-login.
   *
   * Platforms:
   *   Android: shows APK-update banner (deep-links to Settings → Updates
   *            for install action).
   *   PWA:     shows PWA-bundle-update banner when a new service worker
   *            is ready (tap "Reload" activates it) — see App.svelte's
   *            SW hook for the trigger.
   *
   * Server-update banner (admin only) lives inside SettingsUpdates
   * rather than at the app top, to avoid nagging admins on every screen.
   *
   * Skip-this-version behavior: user can dismiss and never see the same
   * version again. Reset happens automatically the moment a newer
   * version appears (getSkippedVersion returns the exact string; any
   * newer tag doesn't match).
   */
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { isNative } from '../lib/platform.js';
  import { portal } from '../lib/portal.js';
  import {
    checkForUpdate, getAutoCheck,
    updateAvailable, dismissForVersion, refreshUpdateAvailableStore,
  } from '../lib/updates.js';
  import { pwaUpdateReady, applyPwaUpdate } from '../lib/pwa-update.js';
  import {
    isUpdateNotificationPermissionGranted, showUpdateNotification,
  } from '../lib/notifications.js';

  // Remembers which version we already posted the OS notification for
  // so we don't re-post on every app open (re-posting with the same ID
  // replaces the notification and resets the user's dismissal).
  const NOTIFIED_KEY = 'nt_updates_notified_version';

  // Two triggers can raise the banner:
  //  1. A GitHub-tag check found a newer release (native + PWA).
  //  2. The service worker has a fresh bundle waiting (PWA only).
  // Both funnel into `visible` via the reactive block below.
  // The GitHub side is persistently dismissable via skipVersion (never
  // returns for that version). The PWA-SW side has no version to skip,
  // so a dismiss just hides it for this session — a full page reload
  // will surface it again next time.
  let _pwaSessionDismissed = false;
  $: latest  = $updateAvailable.latest;
  $: visible = $updateAvailable.available || ($pwaUpdateReady && !_pwaSessionDismissed);

  onMount(async () => {
    // Hydrate the store from any cached check first so the banner /
    // Settings-nav dot can appear before the async check completes.
    refreshUpdateAvailableStore();
    if (!getAutoCheck()) return;
    try {
      const found = await checkForUpdate({ force: false });
      // On native, ALSO post a one-shot OS notification alongside the
      // in-app banner (was previously EITHER banner OR notification).
      // Both channels active means a user who backgrounds the app still
      // sees the shade notification, and returns to a banner they can
      // dismiss in one tap.
      if (isNative && found && $updateAvailable.available) {
        try {
          if (await isUpdateNotificationPermissionGranted()) {
            if (_getNotifiedVersion() !== found.version) {
              const posted = await showUpdateNotification(found);
              if (posted) _setNotifiedVersion(found.version);
            }
          }
        } catch { /* notification is best-effort */ }
      }
    } catch { /* silent — banner still surfaces via a later check */ }
  });

  function _getNotifiedVersion() {
    try { return localStorage.getItem(NOTIFIED_KEY) || ''; } catch { return ''; }
  }
  function _setNotifiedVersion(v) {
    try { localStorage.setItem(NOTIFIED_KEY, v); } catch {}
  }

  function goToUpdates() {
    // PWA bundle refresh applies immediately — no need to deep-link to
    // Settings. GitHub-release path deep-links to the Updates section
    // (Settings.svelte drives currentSection from the URL param, so
    // /settings/updates lands on the expanded panel directly instead of
    // the section index).
    if ($pwaUpdateReady) { applyPwaUpdate(); return; }
    push('/settings/updates');
    dismissForVersion(latest?.version);
  }
  function dismiss() {
    // PWA bundle: no version to skip, just hide for this session; a
    // page reload will resurface it. GitHub-release path: persist the
    // skip so this version never nags again.
    if ($pwaUpdateReady) { _pwaSessionDismissed = true; return; }
    dismissForVersion(latest?.version);
  }
</script>

{#if visible && (latest || $pwaUpdateReady)}
  <div
    class="update-banner"
    use:portal
    transition:fade={{ duration: 200 }}
    role="status"
    aria-live="polite"
  >
    <span class="material-symbols-rounded icon" aria-hidden="true">system_update</span>
    <div class="body">
      <div class="title">
        {#if latest}
          {$_('updates.available_headline', { values: { version: latest.version } })}
        {:else}
          {$_('updates.available_generic', { default: 'A New Version Is Available' })}
        {/if}
      </div>
      <div class="sub">{$_('updates.banner_cta')}</div>
    </div>
    <button class="btn primary" on:click={goToUpdates}>
      {$pwaUpdateReady ? $_('updates.banner_reload', { default: 'Reload' }) : $_('updates.banner_view')}
    </button>
    <button class="dismiss" on:click={dismiss} aria-label={$_('updates.skip_this_version')}>
      <span class="material-symbols-rounded">close</span>
    </button>
  </div>
{/if}

<style>
  /* Portaled to document.body so page transforms can't trap it in a
     lower stacking context (same pattern as .sync-connection-banner in
     App.svelte). Sits just below the status bar / camera cutout via
     the safe-area inset — was previously position:sticky top:0 which
     rendered behind Android system chrome on notched displays. */
  .update-banner {
    position: fixed;
    top: var(--safe-top, env(safe-area-inset-top, 0px));
    left: calc(var(--sidebar-w, 0px) + 12px);
    right: 12px;
    z-index: 250;
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--accent) 15%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    border-radius: var(--radius-lg, 12px);
    box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.25));
    color: var(--text-1);
    transition: left 0.25s ease;
  }
  .icon { color: var(--accent); flex-shrink: 0; }
  .body { flex: 1; min-width: 0; }
  .title { font-weight: 600; font-size: 14px; }
  .sub   { font-size: 12px; color: var(--text-2); }
  .btn.primary {
    background: var(--accent); color: white; border: none;
    padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
    flex-shrink: 0;
  }
  .dismiss {
    background: transparent; border: none; padding: 4px; cursor: pointer;
    display: flex; align-items: center; color: var(--text-2);
    flex-shrink: 0;
  }
  .dismiss:hover { color: var(--text-1); }
</style>
