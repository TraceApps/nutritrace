<script>
  import { createEventDispatcher } from 'svelte';
  export let tabs   = [];   // [{ label, value }]
  export let active = 0;

  const dispatch = createEventDispatcher();
  function select(i) { active = i; dispatch('change', tabs[i]); }

  $: _pillLeft  = `calc(3px + ${active} * (100% - 6px) / ${tabs.length})`;
  $: _pillWidth = `calc((100% - 6px) / ${tabs.length})`;
</script>

<div class="tabs-bar" role="tablist">
  <div class="tabs-pill" style="left:{_pillLeft};width:{_pillWidth}"></div>
  {#each tabs as tab, i}
    <button
      class="tab-btn"
      class:active={i === active}
      role="tab"
      aria-selected={i === active}
      on:click={() => select(i)}
    >
      {tab.label}
    </button>
  {/each}
</div>

<style>
  .tabs-bar {
    display: flex;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    padding: 3px;
    position: relative;
  }
  .tabs-pill {
    position: absolute;
    top: 3px;
    bottom: 3px;
    border-radius: calc(var(--radius-md) - 3px);
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
    transition: left var(--dur-base, 220ms) var(--ease-inout, cubic-bezier(.4,0,.2,1));
    pointer-events: none;
    z-index: 0;
  }
  .tab-btn {
    flex: 1;
    padding: 8px 12px;
    border-radius: calc(var(--radius-md) - 3px);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    transition: color var(--dur-fast);
    cursor: pointer;
    white-space: nowrap;
    position: relative;
    z-index: 1;
  }
  .tab-btn.active {
    color: var(--accent);
  }
</style>
