<script>
  /**
   * Catalog-strict unit combobox.
   *
   * The displayed value is always one the user has explicitly picked from
   * the popover, never a free-text typed string. Typing only filters the
   * popover. Anything not in the merged catalog (built-in groups + the
   * user's customUnits setting) is rejected on blur — the input snaps
   * back to the last-picked value.
   *
   * Custom unit management lives in Settings → Custom Units. Custom
   * picks DO NOT get mass conversion (they're not in UNIT_TO_G), so
   * scaling falls back to the pure portion ratio.
   */
  import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { unitGroupsWithCustoms } from '../../lib/units.js';
  import { customUnits } from '../../stores/settings.js';
  import { portal } from '../../lib/portal.js';

  /** Stored abbreviation. Must be a member of the merged catalog. */
  export let value = '';
  export let placeholder = 'unit';
  export let disabled = false;

  const dispatch = createEventDispatcher();

  let inputEl;
  let popoverEl;
  let open = false;
  let highlight = -1;
  let _wrap;
  let popStyle = '';
  // Internal typing buffer. Separate from `value` so what the user types
  // never escapes into the saved value.
  let _query = '';

  $: orderedGroups = unitGroupsWithCustoms($customUnits);

  $: filteredGroups = _query
    ? orderedGroups
        .map(g => ({
          ...g,
          units: g.units.filter(u =>
            u.abbr.toLowerCase().includes(_query.toLowerCase()) ||
            u.full.toLowerCase().includes(_query.toLowerCase())
          ),
        }))
        .filter(g => g.units.length > 0)
    : orderedGroups;

  $: flatList = filteredGroups.flatMap(g => g.units.map(u => ({ ...u, groupLabel: g.label })));
  $: if (highlight >= flatList.length) highlight = flatList.length - 1;

  function pick(u) {
    value = u.abbr;
    _query = '';
    open = false;
    highlight = -1;
    dispatch('change', value);
    if (inputEl) setTimeout(() => inputEl.blur(), 0);
  }

  function onKey(e) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        open = true;
        highlight = 0;
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') { highlight = Math.min(flatList.length - 1, highlight + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { highlight = Math.max(0, highlight - 1); e.preventDefault(); }
    else if (e.key === 'Enter') {
      if (highlight >= 0 && flatList[highlight]) { pick(flatList[highlight]); e.preventDefault(); }
      else { open = false; _query = ''; }
    }
    else if (e.key === 'Escape') { open = false; highlight = -1; _query = ''; }
    else if (e.key === 'Tab') { open = false; _query = ''; }
  }

  function onInput(e) {
    // Typing filters; it never updates `value`. If they don't pick from
    // the popover, the typed text is discarded on blur.
    _query = e.target.value;
    open = true;
    highlight = 0;
  }

  function onFocus() {
    if (disabled) return;
    open = true;
    highlight = -1;
    _query = '';
    tick().then(_repositionPopover);
  }

  function _repositionPopover() {
    if (!inputEl) return;
    const r = inputEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const POP_MAX_H = 320;
    const POP_MIN_W = 220;
    const EDGE = 8;
    const GAP = 4;
    const spaceBelow = vh - r.bottom - EDGE;
    const spaceAbove = r.top - EDGE;
    const placeAbove = spaceBelow < 200 && spaceAbove > spaceBelow;
    const top = placeAbove
      ? Math.max(EDGE, r.top - GAP - Math.min(POP_MAX_H, spaceAbove))
      : r.bottom + GAP;
    const maxH = placeAbove ? Math.min(POP_MAX_H, spaceAbove) : Math.min(POP_MAX_H, spaceBelow);

    // Horizontal: the popover wants at least POP_MIN_W. Anchor to the input's
    // left edge by default; if that would overflow the right side, slide it
    // left so it sits flush against the right edge instead. Last resort: cap
    // width to the available viewport (rare on phones unless the viewport is
    // narrower than POP_MIN_W).
    const popWidth = Math.min(vw - EDGE * 2, Math.max(POP_MIN_W, r.width));
    let left = r.left;
    if (left + popWidth > vw - EDGE) left = Math.max(EDGE, vw - popWidth - EDGE);

    popStyle = `top:${top}px;left:${left}px;width:${popWidth}px;max-height:${maxH}px;`;
  }
  function _onScrollOrResize() { if (open) _repositionPopover(); }
  onMount(() => {
    window.addEventListener('resize', _onScrollOrResize);
    window.addEventListener('scroll', _onScrollOrResize, true);
  });
  onDestroy(() => {
    window.removeEventListener('resize', _onScrollOrResize);
    window.removeEventListener('scroll', _onScrollOrResize, true);
  });
  function onBlur() {
    setTimeout(() => {
      const a = document.activeElement;
      if (_wrap?.contains(a) || popoverEl?.contains(a)) return;
      // Discard any unselected typing — `value` was never touched by
      // onInput, so just clearing the query string restores the display.
      open = false;
      _query = '';
    }, 120);
  }
</script>

<div class="unit-picker" bind:this={_wrap}>
  <input
    bind:this={inputEl}
    class="input unit-input"
    type="text"
    {placeholder}
    {disabled}
    value={open ? _query : (value || '')}
    on:input={onInput}
    on:focus={onFocus}
    on:blur={onBlur}
    on:keydown={onKey}
    autocomplete="off"
    spellcheck="false"
    aria-haspopup="listbox"
    aria-expanded={open}
  />
  <span class="caret material-symbols-rounded">expand_more</span>
</div>

{#if open}
  <div use:portal class="popover" bind:this={popoverEl} role="listbox"
    style={popStyle} transition:fade={{ duration: 80 }}>
    {#if filteredGroups.length === 0}
      <p class="empty-line">No matches. Add custom units in Settings → Foods → Custom Units.</p>
    {:else}
      {#each filteredGroups as group}
        <p class="group-label">{group.label}</p>
        {#each group.units as u}
          {@const idx = flatList.findIndex(f => f.abbr === u.abbr && f.groupLabel === group.label)}
          <button
            type="button"
            class="opt"
            class:active={highlight === idx}
            role="option"
            aria-selected={value === u.abbr}
            on:mousedown|preventDefault={() => pick(u)}
            on:mouseenter={() => highlight = idx}
          >
            <span class="opt-full">{u.full}</span>
            <span class="opt-abbr">{u.abbr}</span>
          </button>
        {/each}
      {/each}
    {/if}
  </div>
{/if}

<style>
  .unit-picker { position: relative; }
  .unit-input { padding-right: 28px; box-sizing: border-box; width: 100%; }
  .caret {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    color: var(--text-3);
    font-size: 18px;
    pointer-events: none;
  }
  .popover {
    position: fixed;
    min-width: 220px;
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    z-index: 200;
    padding: 6px 0;
  }
  .group-label {
    margin: 6px 12px 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    font-weight: 700;
  }
  .opt {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    background: transparent;
    border: none;
    padding: 7px 12px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-1);
    text-align: left;
  }
  .opt:hover, .opt.active { background: var(--accent-dim); color: var(--accent); }
  .opt-full { flex: 1; }
  .opt-abbr {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }
  .opt.active .opt-abbr { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
  .empty-line {
    padding: 12px;
    margin: 0;
    color: var(--text-3);
    font-size: 12px;
    font-style: italic;
    text-align: center;
  }
</style>
