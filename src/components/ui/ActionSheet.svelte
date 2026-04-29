<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';

  // actions: [{ label, icon?, value, danger? }]
  export let open    = false;
  export let title   = '';
  export let actions = [];

  const dispatch = createEventDispatcher();
  let _locked = false;
  let _lockTimer;
  $: if (open) {
    clearTimeout(_lockTimer);
    _locked = true;
    _lockTimer = setTimeout(() => _locked = false, 400);
  }
  const pick     = (a) => { open = false; dispatch('select', a); };
  const cancel   = () => { if (!_locked) { open = false; dispatch('cancel'); } };
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="as-backdrop" on:click={cancel}
    in:fade={{ duration: 180 }} out:fade={{ duration: 140 }}>
    <div
      class="as-panel"
      in:fly={{ y: 60, duration: 260, easing: cubicOut }}
      out:fly={{ y: 60, duration: 180 }}
      on:click|stopPropagation
    >
      <div class="as-handle"></div>
      {#if title}
        <p class="as-title">{title}</p>
      {/if}
      {#each actions as action}
        <button
          class="as-btn"
          class:danger={action.danger}
          on:click={() => pick(action)}
        >
          {#if action.icon}
            <span class="material-symbols-rounded as-icon">{action.icon}</span>
          {/if}
          {action.label}
        </button>
      {/each}
      <button class="as-cancel" on:click={cancel}>{$_('common.cancel')}</button>
    </div>
  </div>
{/if}

<style>
  .as-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    z-index: 120;
    display: flex;
    align-items: flex-end;
  }
  .as-panel {
    width: 100%;
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-top: 1px solid var(--border);
    padding: 0 16px calc(16px + var(--safe-bottom));
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .as-handle {
    width: 36px; height: 4px;
    background: var(--border-strong);
    border-radius: 99px;
    margin: 12px auto 8px;
  }
  .as-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    text-align: center;
    padding: 4px 0 8px;
  }
  .as-btn {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 14px 16px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-1);
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .as-btn:active { background: var(--surface-3); }
  .as-btn.danger { color: var(--danger); }
  .as-icon { font-size: 20px; color: var(--text-2); }
  .as-btn.danger .as-icon { color: var(--danger); }
  .as-cancel {
    margin-top: 4px;
    padding: 14px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .as-cancel:active { background: var(--surface-3); }
</style>
