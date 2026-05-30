<script>
  /**
   * Spinner.svelte — shared loading indicator.
   *
   * Three sizes (sm/md/lg) and three layouts (block / inline / row) so the
   * same primitive covers "small spinner inside a button" and "centred
   * loading state for a whole route." Respects prefers-reduced-motion by
   * falling back to a pulsing opacity instead of rotation.
   *
   * Ported from LiftTrace's GA polish pass (LT commit 452a3ad). Kept
   * byte-identical so TraceApps loading states feel cohesive.
   */
  export let size = 'md';        // 'sm' | 'md' | 'lg'
  export let label = '';         // optional caption shown next to / below the spinner
  export let block = false;      // when true, the spinner centres itself in a min-height block
  export let inline = false;     // when true, renders inline (for use inside button text)
</script>

{#if block}
  <div class="spinner-block" role="status" aria-live="polite">
    <span class="material-symbols-rounded spinner-icon size-{size}">progress_activity</span>
    {#if label}<span class="spinner-label">{label}</span>{/if}
  </div>
{:else if inline}
  <span class="material-symbols-rounded spinner-icon size-{size} inline" role="status" aria-live="polite">progress_activity</span>
{:else}
  <span class="spinner-row" role="status" aria-live="polite">
    <span class="material-symbols-rounded spinner-icon size-{size}">progress_activity</span>
    {#if label}<span class="spinner-label">{label}</span>{/if}
  </span>
{/if}

<style>
  .spinner-block {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px;
    min-height: 180px;
    padding: 32px 16px;
    color: var(--text-3);
  }
  .spinner-row {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--text-3);
  }
  .spinner-icon {
    display: inline-block;
    color: var(--accent);
    animation: spinner-rot 1.2s linear infinite;
    transform-origin: center;
  }
  .spinner-icon.inline { vertical-align: middle; }
  .size-sm { font-size: 16px; }
  .size-md { font-size: 28px; }
  .size-lg { font-size: 44px; }
  .spinner-label { font-size: 13px; color: var(--text-3); }

  @keyframes spinner-rot {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner-icon { animation: spinner-pulse 1.4s ease-in-out infinite; }
    @keyframes spinner-pulse {
      0%, 100% { opacity: 0.4; }
      50%      { opacity: 1; }
    }
  }
</style>
