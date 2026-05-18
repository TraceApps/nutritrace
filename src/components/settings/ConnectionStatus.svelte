<script>
  /**
   * ConnectionStatus — top-of-card banner for any integration that
   * connects to an external API (Trace AI today; ready for Mealie /
   * future integrations). Promotes a single look + affordance pattern
   * so every "is this thing actually working?" banner reads the same.
   *
   * Status values:
   *   'ok'      — green pill, "Connected" + provider badge, Re-test button
   *   'fail'    — red pill, error string inline, Re-test button
   *   'testing' — neutral pill with spinner, Re-test disabled
   *   '' / null — render nothing (idle / not yet configured)
   *
   * The banner does NOT render its own divider; it sits inside the card
   * BEFORE the first .setting-row so the existing .setting-divider chain
   * still works for the rows below.
   */
  export let status = '';
  /** Label shown in the badge chip after "Connected" on the ok branch. */
  export let connectedAs = '';
  /** Error string shown on the fail branch. */
  export let error = '';
  /** Callback for the Re-test button. */
  export let onRetest = null;
  /** Disable the Re-test button (use during in-flight tests/saves). */
  export let retestDisabled = false;
</script>

{#if status === 'ok'}
  <div class="status-pill ok">
    <span class="material-symbols-rounded">check_circle</span>
    <span>Connected</span>
    {#if connectedAs}
      <span class="status-badge">{connectedAs}</span>
    {/if}
    {#if onRetest}
      <button class="status-retest" on:click={onRetest} disabled={retestDisabled}>
        {retestDisabled ? 'Testing…' : 'Re-test'}
      </button>
    {/if}
  </div>
{:else if status === 'fail'}
  <div class="status-pill fail">
    <span class="material-symbols-rounded">error</span>
    <span>Not connected{error ? `: ${error}` : ''}</span>
    {#if onRetest}
      <button class="status-retest" on:click={onRetest} disabled={retestDisabled}>
        {retestDisabled ? 'Testing…' : 'Re-test'}
      </button>
    {/if}
  </div>
{:else if status === 'testing'}
  <div class="status-pill testing">
    <span class="material-symbols-rounded spin">progress_activity</span>
    <span>Testing connection…</span>
  </div>
{/if}

<style>
  .status-pill {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    font-size: 13px;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
  }
  .status-pill .material-symbols-rounded { font-size: 18px; }
  .status-pill.ok      { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .status-pill.ok      .material-symbols-rounded { color: var(--accent); }
  .status-pill.fail    { background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .status-pill.fail    .material-symbols-rounded { color: var(--danger); }
  .status-pill.testing { background: var(--surface-2); color: var(--text-2); }
  .status-pill.testing .material-symbols-rounded { color: var(--text-3); }

  /* Provider badge — compact accent-tinted chip in the platform-tag style. */
  .status-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    background: var(--accent-dim);
    color: var(--accent);
  }

  .status-retest {
    margin-left: auto;
    background: transparent; border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .status-retest:hover:not(:disabled) { color: var(--text-1); border-color: var(--text-3); }
  .status-retest:disabled { opacity: 0.5; cursor: default; }

  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
