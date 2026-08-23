<script>
  /**
   * Diary → right column → Water widget.
   *
   * Replaces the top-right water icon → modal flow with an inline
   * always-visible widget: progress bar, quick-add container buttons,
   * expandable custom-amount input, and today's entries with a hover
   * remove control. Uses the same addWaterLog + remove callbacks the
   * existing Water Sheet uses, so plumbing is identical — this is a
   * different surface for the same actions.
   *
   * Rendered only inside .diary-right-col which is ≥1280px only.
   */
  import { slide } from 'svelte/transition';
  import { decimalInput, parseDecimal } from '../../lib/decimal-input.js';

  export let logs         = [];
  export let totalMl      = 0;
  export let goalMl       = 2000;
  export let unit         = 'ml';     // 'ml' | 'oz' | 'L' | 'G'
  export let containers   = [];
  export let onQuickAdd   = () => {};
  export let onRemove     = () => {};
  export let onOpen       = null;   // opens the full water sheet

  let customOpen = false;
  let customAmt  = '';
  let customInput;

  $: pct = goalMl > 0 ? Math.min(100, Math.round((totalMl / goalMl) * 100)) : 0;
  $: displayTotal = formatMl(totalMl);
  $: displayGoal  = formatMl(goalMl);

  // Brief pulse animation on the bar when totalMl grows (new log added
  // via a quick-add button). Increments a key so the class toggles even
  // for consecutive additions of the same amount.
  let _lastTotal = 0;
  let _pulseKey  = 0;
  $: if (totalMl > _lastTotal) { _pulseKey++; }
  $: _lastTotal = totalMl;

  function formatMl(ml) {
    if (unit === 'oz') return `${(ml / 29.5735).toFixed(0)} fl oz`;
    if (unit === 'L')  return `${(ml / 1000).toFixed(2)} L`;
    if (unit === 'G')  return `${(ml / 3785.41).toFixed(3)} G`;
    return `${ml} ml`;
  }
  function displayContainer(cont) {
    if (unit === 'oz') return `+${(cont.volumeMl / 29.5735).toFixed(0)} fl oz`;
    if (unit === 'L')  return `+${(cont.volumeMl / 1000).toFixed(2)} L`;
    if (unit === 'G')  return `+${(cont.volumeMl / 3785.41).toFixed(3)} G`;
    return `+${cont.volumeMl} ml`;
  }
  function displayLogAmount(amount) {
    return formatMl(amount);
  }

  async function openCustom() {
    customOpen = true;
    customAmt = '';
    await Promise.resolve();
    customInput?.focus();
  }
  function commitCustom() {
    const val = parseDecimal(customAmt);
    if (!val || val <= 0) { customOpen = false; return; }
    // Convert display unit back to ml
    let ml = val;
    if (unit === 'oz') ml = val * 29.5735;
    else if (unit === 'L')  ml = val * 1000;
    else if (unit === 'G')  ml = val * 3785.41;
    onQuickAdd(Math.round(ml));
    customAmt = '';
    customOpen = false;
  }
  function customKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitCustom(); }
    else if (e.key === 'Escape') { customOpen = false; customAmt = ''; }
  }
</script>

<section class="water-widget card">
  <header class="ww-header">
    <span class="material-symbols-rounded ww-icon">water_drop</span>
    <span class="ww-title">Water</span>
    <span class="ww-total">{displayTotal} <span class="ww-of">of {displayGoal}</span></span>
    {#if onOpen}
      <button class="ww-open" on:click={onOpen} title="Open water sheet" aria-label="Open water sheet">
        <span class="material-symbols-rounded">open_in_full</span>
      </button>
    {/if}
  </header>

  <div class="ww-bar-track" title="{pct}%">
    {#key _pulseKey}
      <div class="ww-bar-fill ww-bar-fill-pulse" style="width:{pct}%"></div>
    {/key}
  </div>

  <div class="ww-buttons">
    {#each containers as cont (cont.id ?? cont.volumeMl)}
      <button class="ww-btn" on:click={() => onQuickAdd(cont.volumeMl)} title={cont.name}>
        {displayContainer(cont)}
      </button>
    {/each}
    <button class="ww-btn ww-btn-ghost ww-btn-full" on:click={openCustom} class:active={customOpen}>
      + Custom
    </button>
  </div>

  {#if customOpen}
    <div class="ww-custom-row" transition:slide={{ duration: 160 }}>
      <input
        bind:this={customInput}
        bind:value={customAmt}
        on:keydown={customKeydown}
        type="text"
        inputmode="decimal"
        use:decimalInput
        placeholder={unit === 'ml' ? 'ml' : unit === 'oz' ? 'fl oz' : unit}
        class="input ww-custom-input"
      />
      <button class="ww-custom-save btn btn-primary" on:click={commitCustom}>Add</button>
    </div>
  {/if}

  {#if logs.length > 0}
    <ul class="ww-logs">
      {#each logs as log, i (i + '-' + log.amount + '-' + log.time)}
        <li class="ww-log-row">
          <span class="ww-log-amount">{displayLogAmount(log.amount)}</span>
          <span class="ww-log-time">{log.time || ''}</span>
          <button
            class="ww-log-remove"
            on:click={() => onRemove(i)}
            title="Remove this entry"
            aria-label="Remove entry"
          >
            <span class="material-symbols-rounded">close</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  :global(:root) { --water-blue: #2196F3; }

  .water-widget {
    padding: 16px 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .ww-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ww-icon { color: var(--water-blue); font-size: 20px; }
  .ww-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.01em;
    flex: 1;
  }
  .ww-total {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
  }
  .ww-of {
    font-weight: 400;
    color: var(--text-3);
    margin-left: 2px;
  }
  .ww-open {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    margin-left: 4px;
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ww-open:hover { color: var(--text-1); background: var(--surface-2); }
  .ww-open .material-symbols-rounded { font-size: 16px; }

  .ww-bar-track {
    height: 8px;
    background: var(--surface-3);
    border-radius: var(--radius-full);
    overflow: hidden;
  }
  .ww-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #42A5F5, var(--water-blue));
    border-radius: var(--radius-full);
    transition: width 0.4s cubic-bezier(0.34, 1.2, 0.64, 1);
  }
  /* Pulse animation fires whenever _pulseKey bumps (i.e. totalMl grew).
     A brief brightness + subtle scale on the fill signals the value
     just changed, so the user sees their tap register even mid-scroll. */
  .ww-bar-fill-pulse {
    animation: ww-fill-pulse 620ms ease-out;
  }
  @keyframes ww-fill-pulse {
    0%   { filter: brightness(1);    box-shadow: 0 0 0 rgba(33,150,243,0); }
    30%  { filter: brightness(1.35); box-shadow: 0 0 12px rgba(33,150,243,0.55); }
    100% { filter: brightness(1);    box-shadow: 0 0 0 rgba(33,150,243,0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ww-bar-fill-pulse { animation: none; }
  }

  .ww-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 2px;
  }
  /* Custom button always spans the full width of the grid, no matter
     how many container buttons are configured. Handles odd counts (3
     containers → last container alone on row 2, custom full-width on
     row 3) and even counts (4 containers → 2x2, custom full-width row 3)
     without leaving a stray empty slot. */
  .ww-btn-full { grid-column: 1 / -1; }
  .ww-btn {
    background: color-mix(in srgb, var(--water-blue) 12%, transparent);
    color: var(--text-1);
    border: 1px solid color-mix(in srgb, var(--water-blue) 30%, transparent);
    border-radius: var(--radius-md);
    padding: 8px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
    text-align: center;
  }
  .ww-btn:hover {
    background: color-mix(in srgb, var(--water-blue) 22%, transparent);
    border-color: var(--water-blue);
  }
  .ww-btn-ghost {
    background: transparent;
    border-color: var(--border);
    color: var(--text-2);
  }
  .ww-btn-ghost:hover {
    background: var(--surface-2);
    color: var(--text-1);
  }
  .ww-btn-ghost.active {
    background: var(--surface-2);
    color: var(--text-1);
    border-color: var(--water-blue);
  }

  .ww-custom-row {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .ww-custom-input {
    flex: 1;
    padding: 8px 10px;
    font-size: 13px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
  }
  .ww-custom-input:focus {
    outline: 2px solid var(--water-blue);
    outline-offset: -1px;
  }
  .ww-custom-save {
    padding: 8px 14px;
    font-size: 12px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .ww-logs {
    list-style: none;
    padding: 0;
    margin: 4px 0 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 168px;
    overflow-y: auto;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .ww-log-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-2);
  }
  .ww-log-row:hover { background: var(--surface-2); }
  .ww-log-amount {
    color: var(--water-blue);
    font-weight: 600;
    min-width: 60px;
  }
  .ww-log-time { flex: 1; color: var(--text-3); font-size: 11px; }
  .ww-log-remove {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease;
    padding: 2px;
    border-radius: var(--radius-sm);
  }
  .ww-log-row:hover .ww-log-remove { opacity: 1; }
  .ww-log-remove:hover { color: var(--danger); background: var(--surface-3); }
  .ww-log-remove .material-symbols-rounded { font-size: 14px; }
</style>
