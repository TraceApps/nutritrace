<script>
  // A photo in a coaching conversation, fetched with the sign-in and kept
  // for a dead zone (lib/coach-photos.js).
  import { _ } from 'svelte-i18n';
  import { coachPhotoUrl } from '../../lib/coach-photos.js';

  export let path;
  let src = null, failed = false, loadedFor = null;

  $: if (path && path !== loadedFor) load(path);
  async function load(p) {
    loadedFor = p; failed = false; src = null;
    const url = await coachPhotoUrl(p);
    if (p !== loadedFor) return;
    if (url) src = url; else failed = true;
  }
</script>

{#if src}
  <img {src} alt={$_('coaching.chat.photo')} class="cp-img" loading="lazy" />
{:else}
  <div class="cp-wait" role="img" aria-label={$_('coaching.chat.photo')}>
    <span class="material-symbols-rounded" aria-hidden="true">{failed ? 'cloud_off' : 'image'}</span>
    {#if failed}<span>{$_('coaching.chat.photo_offline')}</span>{/if}
  </div>
{/if}

<style>
  .cp-img { display: block; max-width: min(260px, 100%); max-height: 320px; border-radius: 10px; object-fit: cover; }
  .cp-wait {
    width: 200px; max-width: 100%; height: 140px; border-radius: 10px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
    background: var(--surface-3); color: var(--text-3); font-size: 12px; text-align: center; padding: 8px;
  }
</style>
