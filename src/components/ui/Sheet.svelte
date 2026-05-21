<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut }  from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';

  export let open   = false;
  export let title  = '';
  export let height = 'auto';  // 'auto' | 'full' | '60vh' etc.
  /** Render a floating close button pinned to the panel even when title is
   *  empty. Useful for sheets that draw their own header/banner inside the
   *  slot and need the X to stay visible while the content scrolls. */
  export let overlayClose = false;

  const dispatch = createEventDispatcher();
  let _locked = false;
  let _lockTimer;
  $: if (open) {
    clearTimeout(_lockTimer);
    _locked = true;
    _lockTimer = setTimeout(() => _locked = false, 400);
  }

  function close() {
    open = false;
    dispatch('close');
  }

  function onBackdropClick(e) {
    if (_locked) return;
    if (e.target === e.currentTarget) close();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="sheet-backdrop" on:click={onBackdropClick}
    in:fade={{ duration: 200 }} out:fade={{ duration: 160 }}>
    <div
      class="sheet-panel"
      class:sheet-full={height === 'full'}
      style={height !== 'auto' && height !== 'full' ? `height:${height}` : ''}
      in:fly={{ y: 80, duration: 280, easing: cubicOut }}
      out:fly={{ y: 80, duration: 200 }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <!-- Handle bar -->
      <div class="sheet-handle"></div>

      {#if title}
        <div class="sheet-header">
          <h3 class="sheet-title">{title}</h3>
          <button class="btn-icon" on:click={close} aria-label={$_('common.close')} title={$_('common.close')}>
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      {:else if overlayClose}
        <button class="btn-icon sheet-overlay-close" on:click={close}
          aria-label={$_('common.close')} title={$_('common.close')}>
          <span class="material-symbols-rounded">close</span>
        </button>
      {/if}

      <div class="sheet-body" class:no-title={!title}>
        <slot />
      </div>
    </div>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    z-index: 100;
    display: flex;
    align-items: flex-end;
  }
  .sheet-panel {
    width: 100%;
    max-height: 90dvh;
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-top: 1px solid var(--border);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding-bottom: var(--safe-bottom);
    position: relative;
  }
  .sheet-overlay-close {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 5;
    color: var(--text-2);
  }
  .sheet-full { height: 90dvh; }
  .sheet-handle {
    width: 36px; height: 4px;
    background: var(--border-strong);
    border-radius: var(--radius-full);
    margin: 12px auto 0;
    flex-shrink: 0;
  }
  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    flex-shrink: 0;
  }
  .sheet-title { font-size: 17px; font-weight: 600; }
  .sheet-body {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 20px 20px;
  }
  .sheet-body.no-title { padding-top: 16px; }
</style>
