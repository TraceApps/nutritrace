<script>
  // Goals | Coach | Clients, for people in coaching only. Everyone else gets
  // nothing here, so Goals looks exactly as it did.
  import { _ } from 'svelte-i18n';
  import { location, push } from 'svelte-spa-router';
  import { coachTab, clientsTab, inCoaching, coachUnread, clientsUnread } from '../../stores/coaching.js';

  // Shown on the Coach and Clients pages even while the state is still
  // loading, so arriving there by link never strands anyone.
  export let force = false;

  $: current = $location.startsWith('/goals/clients') ? 'clients'
    : $location.startsWith('/goals/coach') ? 'coach' : 'goals';
  $: tabs = [
    { key: 'goals', path: '/goals', icon: 'flag', label: $_('coaching.tabs.goals'), unread: 0 },
    ...($coachTab || (force && current === 'coach') ? [{ key: 'coach', path: '/goals/coach', icon: 'sports', label: $_('coaching.tabs.coach'), unread: $coachUnread }] : []),
    ...($clientsTab || (force && current === 'clients') ? [{ key: 'clients', path: '/goals/clients', icon: 'groups', label: $_('coaching.tabs.clients'), unread: $clientsUnread }] : []),
  ];
</script>

{#if $inCoaching || force}
  <div class="coaching-tabs" role="tablist" aria-label={$_('coaching.tabs.aria')}
    style="--seg-count:{tabs.length};--seg-active:{Math.max(0, tabs.findIndex(t => t.key === current))}">
    {#each tabs as t (t.key)}
      <button class="coaching-tab" class:active={current === t.key} role="tab" aria-selected={current === t.key}
        on:click={() => { if (current !== t.key) push(t.path); }}>
        <span class="material-symbols-rounded" aria-hidden="true">{t.icon}</span>
        <span>{t.label}</span>
        {#if t.unread}<span class="tab-unread" aria-label={$_('coaching.unread', { values: { n: t.unread } })}>{t.unread}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .coaching-tabs {
    display: grid;
    grid-template-columns: repeat(var(--seg-count), minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    margin: 12px var(--page-px, 16px) 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
  }
  .coaching-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    padding: 9px 8px;
    background: none;
    border: none;
    border-radius: var(--radius-md, 10px);
    color: var(--text-3);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .coaching-tab .material-symbols-rounded { font-size: 18px; flex-shrink: 0; }
  .tab-unread { min-width: 18px; padding: 0 6px; border-radius: var(--radius-full); background: var(--accent); color: var(--accent-text, #fff); font-size: 11px; font-weight: 700; line-height: 18px; }
  .coaching-tab:hover:not(.active) { color: var(--text-1); }
  .coaching-tab.active {
    background: var(--surface-1);
    color: var(--accent);
    box-shadow: 0 1px 3px rgba(0,0,0,0.18), inset 0 0 0 1px var(--border);
  }
</style>
