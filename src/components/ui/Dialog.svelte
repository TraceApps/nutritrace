<script>
  import { scale, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import { portal } from '../../lib/portal.js';

  export let open    = false;
  export let title   = '';
  export let message = '';
  export let confirmText = 'OK';
  export let cancelText  = 'Cancel';
  export let dangerous   = false;
  export let confirmDisabled = false;
  /** When true, dispatches 'confirm' but doesn't auto-close — caller controls
   *  open lifecycle (used for async confirms that may fail and want to keep
   *  the dialog open). Default false preserves the original auto-close. */
  export let manualClose = false;

  const dispatch = createEventDispatcher();
  let _locked = false;
  let _lockTimer;
  $: if (open) {
    clearTimeout(_lockTimer);
    _locked = true;
    _lockTimer = setTimeout(() => _locked = false, 400);
  }
  const confirm  = () => {
    if (confirmDisabled) return;
    if (!manualClose) open = false;
    dispatch('confirm');
  };
  const cancel   = () => { if (!_locked) { open = false; dispatch('cancel'); } };
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="dialog-backdrop" on:click={cancel}
    in:fade={{ duration: 180 }} out:fade={{ duration: 140 }}>
    <div
      class="dialog-box"
      in:scale={{ start: 0.88, duration: 220, easing: cubicOut }}
      out:scale={{ start: 0.88, duration: 160 }}
      on:click|stopPropagation
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dlg-title"
    >
      {#if title}
        <h3 class="dialog-title" id="dlg-title">{title}</h3>
      {/if}
      {#if message}
        <p class="dialog-msg">{message}</p>
      {/if}
      <slot />
      <div class="dialog-actions">
        <button class="btn btn-secondary" on:click={cancel}>{cancelText}</button>
        <button
          class="btn {dangerous ? 'btn-danger' : 'btn-primary'}"
          disabled={confirmDisabled}
          on:click={confirm}>{confirmText}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    z-index: 150;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .dialog-box {
    background: var(--surface-1);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    padding: 24px;
    width: 100%;
    max-width: 340px;
    box-shadow: var(--shadow-lg);
  }
  .dialog-title {
    font-size: 17px;
    font-weight: 700;
    margin-bottom: 10px;
  }
  .dialog-msg {
    font-size: 14px;
    color: var(--text-2);
    line-height: 1.5;
    margin-bottom: 20px;
  }
  .dialog-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
  .dialog-actions .btn { flex: 1; }
</style>
