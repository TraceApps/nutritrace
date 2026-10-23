<script>
  // The plain-HTTP sheet (#194): the warning before connecting to a server on
  // your own network over http://, or why an http:// server elsewhere is
  // refused. Android only; always mounted in App.svelte, like the confirm
  // dialog, so it works on the setup screen too.
  import { _ } from 'svelte-i18n';
  import Sheet from './Sheet.svelte';
  import { plainHttpRequest } from '../../stores/plainHttp.js';
  import { HTTPS_GUIDE_URL } from '../../lib/plain-http.js';

  let open = false;
  let current = null;

  $: if ($plainHttpRequest) {
    current = $plainHttpRequest;
    open = true;
  }

  function finish(result) {
    const req = current;
    open = false;
    current = null;
    plainHttpRequest.set(null);
    req?.resolve?.(result);
  }

  async function openGuide() {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url: HTTPS_GUIDE_URL });
    } catch {
      window.open(HTTPS_GUIDE_URL, '_blank', 'noopener');
    }
  }
</script>

{#if current}
  <Sheet
    bind:open
    title={current.kind === 'refuse' ? $_('plain_http.refused_title') : $_('plain_http.warning_title')}
    on:close={() => finish(false)}
  >
    <div class="plain-http" data-kind={current.kind}>
      <p class="ph-url">{current.url}</p>
      <div class="ph-note" role="alert">
        <span class="material-symbols-rounded ph-icon" aria-hidden="true">{current.kind === 'refuse' ? 'block' : 'lock_open'}</span>
        <div class="ph-text">
          {#if current.kind === 'refuse'}
            <p>{$_('plain_http.refused_body')}</p>
            {#if current.stored}<p>{$_('plain_http.refused_stored')}</p>{/if}
          {:else}
            <p>{$_('plain_http.warning_body')}</p>
            <p><strong>{$_('plain_http.warning_advice')}</strong></p>
            {#if current.stored}<p>{$_('plain_http.warning_stored')}</p>{/if}
          {/if}
        </div>
      </div>
      <div class="ph-actions">
        {#if current.kind === 'refuse'}
          <button class="btn btn-primary w-full" on:click={openGuide}>{$_('plain_http.https_guide')}</button>
          <button class="btn btn-ghost w-full" on:click={() => finish(false)}>{$_('common.close')}</button>
        {:else}
          <button class="btn btn-danger w-full" on:click={() => finish(true)}>{$_('plain_http.connect_anyway')}</button>
          <button class="btn btn-ghost w-full" on:click={() => finish(false)}>{$_('common.cancel')}</button>
        {/if}
      </div>
    </div>
  </Sheet>
{/if}

<style>
  .plain-http { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 8px; }
  .ph-url {
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--radius-md, 12px);
    background: var(--surface-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    color: var(--text-1);
    overflow-wrap: anywhere;
  }
  .ph-note {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 12px 14px;
    border-radius: var(--radius-md, 12px);
    border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 45%, transparent);
    background: color-mix(in srgb, var(--warning, #f59e0b) 10%, var(--surface-2));
    font-size: 14px;
    line-height: 1.45;
    color: var(--text-1);
  }
  .ph-icon { font-size: 22px; color: var(--warning, #f59e0b); flex: none; margin-top: 1px; }
  .ph-text { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .ph-text p { margin: 0; }
  .ph-actions { display: flex; flex-direction: column; gap: 8px; }
</style>
