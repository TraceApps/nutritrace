<script>
  /**
   * Diary → right column → Day Summary widget.
   *
   * Mirrors the Nutrition Summary sheet's design exactly: a compact
   * card with a percent/grams toggle, the MacroRing (calories +
   * segments) in the middle, the ring's own percent legend below, and
   * three macro pill cards at the bottom showing grams (or
   * grams/goal in g mode). Same visual grammar as the sheet so
   * desktop feels like "the sheet, but always visible" instead of a
   * different surface with its own conventions.
   *
   * Remaining/Eaten toggle removed (the sheet doesn't have one; the
   * ring center already shows eaten + goal, remaining is derivable).
   * open_in_full button opens the full sheet for the drill-in view of
   * every nutrient / contributors.
   */
  import MacroRing from './MacroRing.svelte';
  import { macroLegendMode } from '../../stores/settings.js';

  // Tweened animated totals from Diary.svelte
  export let eatenKcal    = 0;
  export let protein      = 0;
  export let carbs        = 0;
  export let fat          = 0;

  // Goals
  export let goalKcal         = 2000;
  export let proteinGoal      = null;
  export let carbGoal         = null;
  export let fatGoal          = null;

  // Interactive
  export let onOpenSummary    = () => {};
  // Optional trend drill-in. When provided, a small trending_up button
  // appears in the header next to open_in_full and routes to Statistics
  // for whichever metric the caller wires up (calories by default).
  export let onOpenTrends     = null;
</script>

<section class="day-summary-widget card">
  <header class="dsw-header">
    <button
      class="dsw-legend-toggle"
      on:click={() => macroLegendMode.set($macroLegendMode === 'grams' ? 'percent' : 'grams')}
      aria-label="Toggle macro display between percent and grams"
      title="Toggle percent / grams">
      <span class="dsw-lt-opt" class:dsw-lt-active={$macroLegendMode === 'percent'}>%</span>
      <span class="dsw-lt-opt" class:dsw-lt-active={$macroLegendMode === 'grams'}>g</span>
    </button>
    {#if onOpenTrends}
      <button class="dsw-open dsw-trend" on:click={onOpenTrends} title="View trend">
        <span class="material-symbols-rounded">trending_up</span>
      </button>
    {/if}
    <button class="dsw-open" on:click={onOpenSummary} title="Open full nutrition summary">
      <span class="material-symbols-rounded">open_in_full</span>
    </button>
  </header>

  <div class="dsw-ring">
    <MacroRing
      calories={eatenKcal}
      caloriesGoal={goalKcal}
      {protein}
      {carbs}
      {fat}
      {proteinGoal}
      {carbGoal}
      {fatGoal}
    />
  </div>

  <div class="dsw-macros">
    <div class="dsw-macro-pill" style="--pill-bg:var(--macro-protein-dim);--pill-fg:var(--macro-protein)">
      <span class="dsw-macro-val">
        {Math.round(protein)}{#if $macroLegendMode === 'grams' && proteinGoal != null}/{Math.round(proteinGoal)}{/if}g
      </span>
      <span class="dsw-macro-lbl">Protein</span>
    </div>
    <div class="dsw-macro-pill" style="--pill-bg:var(--macro-carbs-dim);--pill-fg:var(--macro-carbs)">
      <span class="dsw-macro-val">
        {Math.round(carbs)}{#if $macroLegendMode === 'grams' && carbGoal != null}/{Math.round(carbGoal)}{/if}g
      </span>
      <span class="dsw-macro-lbl">Carbs</span>
    </div>
    <div class="dsw-macro-pill" style="--pill-bg:var(--macro-fat-dim);--pill-fg:var(--macro-fat)">
      <span class="dsw-macro-val">
        {Math.round(fat)}{#if $macroLegendMode === 'grams' && fatGoal != null}/{Math.round(fatGoal)}{/if}g
      </span>
      <span class="dsw-macro-lbl">Fat</span>
    </div>
  </div>
</section>

<style>
  .day-summary-widget {
    padding: 12px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .dsw-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  /* Percent / grams pill toggle. Mirrors the ns-legend-toggle from the
     full nutrition sheet so the two surfaces feel like one control in
     different homes. Active side gets the accent tint. */
  .dsw-legend-toggle {
    display: inline-flex;
    align-items: center;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 2px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-3);
    line-height: 1;
    overflow: hidden;
  }
  .dsw-legend-toggle:hover { background: var(--surface-3); }
  .dsw-lt-opt {
    padding: 4px 12px;
    border-radius: var(--radius-full);
    transition: background 120ms ease, color 120ms ease;
    min-width: 20px;
    text-align: center;
  }
  .dsw-lt-active {
    background: var(--accent);
    color: var(--on-accent, #fff);
  }

  .dsw-open {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .dsw-open:hover { color: var(--text-1); background: var(--surface-2); }
  .dsw-open .material-symbols-rounded { font-size: 16px; }
  /* Trend affordance sits next to open_in_full but softer by default so
     it doesn't compete with the primary open action. */
  .dsw-trend { opacity: 0.5; }
  .dsw-trend:hover { opacity: 1; }
  .dsw-trend .material-symbols-rounded { font-size: 20px; }

  /* MacroRing centers itself + renders its percent legend below the
     ring when in %-mode. Block layout here lets both flow correctly. */
  .dsw-ring {
    text-align: center;
  }

  /* Three pill cards below the ring, matching the sheet's ns-macros
     row. Big value on top, tiny label under, tinted background per
     macro color. */
  .dsw-macros {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
  }
  .dsw-macro-pill {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 10px 6px;
    border-radius: var(--radius-md);
    background: var(--pill-bg, var(--surface-2));
  }
  .dsw-macro-val {
    font-size: 16px;
    font-weight: 700;
    color: var(--pill-fg, var(--text-1));
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
  }
  .dsw-macro-lbl {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }
</style>
