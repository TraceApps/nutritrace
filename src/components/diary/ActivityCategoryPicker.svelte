<script>
  // Two-level browse sheet for the activity compendium (#77):
  // level 1 = category grid, level 2 = the picked category's entries.
  // Emits `pick` with the chosen { id, category, name, met } row.
  // Cancel/back returns to the calling AddActivitySheet, closing this
  // sheet without a pick.

  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { groupedByCategory, search as searchCompendium } from '../../lib/activity-picker.js';

  export let open = false;

  const dispatch = createEventDispatcher();
  const groups = groupedByCategory();

  let selected = null;         // category name when drilled into level 2
  let searchQ = '';            // top-of-sheet global search

  $: level2Items = selected
    ? (groups.find(g => g.category === selected)?.items || [])
    : [];
  $: searchResults = searchQ.trim() ? searchCompendium(searchQ).slice(0, 40) : [];

  function drill(category) {
    selected = category;
    searchQ = '';
  }
  function back() {
    selected = null;
  }
  function pick(a) {
    dispatch('pick', a);
    // Sheet is closed by parent via bind:open when the pick handler runs.
    selected = null;
    searchQ = '';
  }
  function onOpenChange() {
    // Reset level when the sheet reopens fresh.
    if (!open) { selected = null; searchQ = ''; }
  }
  $: open, onOpenChange();
</script>

<Sheet bind:open title={selected || $_('diary.activity.browse.title')}>
  <div class="bp-body">
    {#if selected}
      <button type="button" class="bp-back" on:click={back}>
        <span class="material-symbols-rounded">arrow_back</span>
        <span>{$_('diary.activity.browse.all_categories')}</span>
      </button>
    {:else}
      <input class="input bp-search" type="text" bind:value={searchQ}
        placeholder={$_('diary.activity.browse.search_placeholder')} autocomplete="off" />
    {/if}

    {#if searchQ.trim() && !selected}
      <!-- Global-search mode: flat list ignoring categories -->
      {#if searchResults.length === 0}
        <div class="bp-empty">{$_('diary.activity.browse.no_matches', { values: { q: searchQ } })}</div>
      {:else}
        <ul class="bp-list">
          {#each searchResults as a (a.id)}
            <li>
              <button type="button" class="bp-row" on:click={() => pick(a)}>
                <span class="bp-row-name">{a.name}</span>
                <span class="bp-row-cat">{a.category}</span>
                <span class="bp-row-met">MET {a.met.toFixed(1)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if selected}
      <ul class="bp-list">
        {#each level2Items as a (a.id)}
          <li>
            <button type="button" class="bp-row" on:click={() => pick(a)}>
              <span class="bp-row-name">{a.name}</span>
              <span class="bp-row-met">MET {a.met.toFixed(1)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <ul class="bp-cats">
        {#each groups as g}
          <li>
            <button type="button" class="bp-cat" on:click={() => drill(g.category)}>
              <span class="material-symbols-rounded bp-cat-icon">{g.icon}</span>
              <span class="bp-cat-name">{g.category}</span>
              <span class="bp-cat-count">{g.items.length}</span>
              <span class="material-symbols-rounded bp-cat-chev">chevron_right</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Sheet>

<style>
  .bp-body { display: flex; flex-direction: column; gap: 8px; padding-bottom: 8px; }
  .bp-search { width: 100%; margin-bottom: 4px; }
  .bp-back {
    display: inline-flex; align-items: center; gap: 4px;
    background: none; border: none; padding: 4px 0;
    color: var(--text-2); cursor: pointer; font-size: 13px;
    align-self: flex-start;
  }
  .bp-back:hover { color: var(--text-1); }
  .bp-back .material-symbols-rounded { font-size: 18px; }

  .bp-cats, .bp-list {
    list-style: none;
    display: flex; flex-direction: column;
    gap: 6px;
    padding: 0; margin: 0;
  }
  .bp-cat {
    display: flex; align-items: center; gap: 12px;
    width: 100%;
    padding: 12px 14px;
    background: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius, 10px);
    cursor: pointer;
    color: var(--text-1);
    font-size: 15px;
  }
  .bp-cat:hover { background: var(--surface-3); }
  .bp-cat-icon { font-size: 22px; color: var(--accent, rgb(99,102,241)); }
  .bp-cat-name { flex: 1; text-align: left; font-weight: 500; }
  .bp-cat-count {
    font-size: 12px; color: var(--text-3);
    background: var(--surface-1);
    padding: 2px 8px;
    border-radius: 999px;
    min-width: 24px;
    text-align: center;
  }
  .bp-cat-chev { color: var(--text-3); font-size: 20px; }

  .bp-row {
    display: flex; align-items: center; gap: 10px;
    width: 100%;
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius, 10px);
    cursor: pointer;
    color: var(--text-1);
    text-align: left;
    font-size: 14px;
  }
  .bp-row:hover { background: var(--surface-3); }
  .bp-row-name { flex: 1; }
  .bp-row-cat {
    font-size: 11px; color: var(--text-3);
    background: var(--surface-1);
    padding: 2px 6px; border-radius: 999px;
    flex-shrink: 0;
  }
  .bp-row-met {
    font-size: 11px; font-weight: 700;
    color: var(--accent, rgb(99,102,241));
    flex-shrink: 0;
    min-width: 52px;
    text-align: right;
  }

  .bp-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-3);
    font-size: 14px;
  }
</style>
