<script>
  /**
   * ConnectionStatus — top-of-card banner for any integration that
   * connects to an external API. Promotes a single look + affordance
   * pattern so every "is this thing actually working?" banner reads
   * the same across Settings.
   *
   * Used by:
   *   - Trace AI (API key + provider, simple "Connected" state)
   *   - Mealie (URL + token)
   *   - Wellness OAuth: Fitbit / Garmin / Withings / Google Health
   *     (Linked + last sync, custom action via slot)
   *   - Health Connect (permission state)
   *
   * Status values:
   *   'ok'      — accent pill, "Connected" (or custom okLabel) + badge,
   *               default Test button (or slotted action via let:retest)
   *   'warn'    — amber pill, used for "healthy but stale" cases (OFF
   *               mirror past its refresh interval, etc.). Same shape as
   *               'ok' otherwise (badge + subtext + action button).
   *   'fail'    — danger pill, error string inline, Test button
   *   'testing' — neutral pill with spinner, button disabled
   *   '' / null — render nothing (idle / not yet configured)
   *
   * Optional subtext line renders below the main status row (used by
   * wellness to show "linked as joe@email.com · last sync 2h ago").
   *
   * The banner does NOT render its own divider; it sits inside the card
   * BEFORE the first .setting-row so the existing .setting-divider chain
   * still works for the rows below.
   */
  export let status = '';
  /** Label shown in the badge chip after "Connected" on the ok branch. */
  export let connectedAs = '';
  /** Optional override for the "Connected" label (e.g. "Linked", "Permission granted"). */
  export let okLabel = 'Connected';
  /** Optional sub-line below the main row (e.g. "last sync 2h ago"). */
  export let subtext = '';
  /** Error string shown on the fail branch. */
  export let error = '';
  /** Callback for the default Test button. Pass `null` to hide the default button (slot wins). */
  export let onRetest = null;
  /** Disable the default Test button (use during in-flight tests/saves). */
  export let retestDisabled = false;
  /** Button label override. Default "Test". */
  export let retestLabel = 'Test';
  /** Label override for the testing branch (default "Testing connection…").
   *  Used by callers whose "in-flight" state isn't a connection test —
   *  e.g. the OFF mirror banner shows "Syncing" during a refresh. */
  export let testingLabel = 'Testing connection…';
</script>

{#if status === 'ok'}
  <div class="status-pill ok">
    <div class="status-main">
      <span class="material-symbols-rounded">check_circle</span>
      <span>{okLabel}</span>
      {#if connectedAs}
        <span class="status-badge">{connectedAs}</span>
      {/if}
      <div class="status-actions">
        <slot name="action">
          {#if onRetest}
            <button class="status-retest" on:click={onRetest} disabled={retestDisabled}>
              {retestDisabled ? 'Testing…' : retestLabel}
            </button>
          {/if}
        </slot>
      </div>
    </div>
    {#if subtext}
      <div class="status-sub">{subtext}</div>
    {/if}
  </div>
{:else if status === 'warn'}
  <div class="status-pill warn">
    <div class="status-main">
      <span class="material-symbols-rounded">warning</span>
      <span>{okLabel}</span>
      {#if connectedAs}
        <span class="status-badge">{connectedAs}</span>
      {/if}
      <div class="status-actions">
        <slot name="action">
          {#if onRetest}
            <button class="status-retest" on:click={onRetest} disabled={retestDisabled}>
              {retestDisabled ? 'Testing…' : retestLabel}
            </button>
          {/if}
        </slot>
      </div>
    </div>
    {#if subtext}
      <div class="status-sub">{subtext}</div>
    {/if}
  </div>
{:else if status === 'fail'}
  <div class="status-pill fail">
    <div class="status-main">
      <span class="material-symbols-rounded">error</span>
      <span>Not connected{error ? `: ${error}` : ''}</span>
      <div class="status-actions">
        <slot name="action">
          {#if onRetest}
            <button class="status-retest" on:click={onRetest} disabled={retestDisabled}>
              {retestDisabled ? 'Testing…' : retestLabel}
            </button>
          {/if}
        </slot>
      </div>
    </div>
    {#if subtext}
      <div class="status-sub">{subtext}</div>
    {/if}
  </div>
{:else if status === 'testing'}
  <div class="status-pill testing">
    <div class="status-main">
      <span class="material-symbols-rounded spin">progress_activity</span>
      <span>{testingLabel}</span>
      <div class="status-actions">
        <slot name="action">
          {#if onRetest}
            <button class="status-retest" on:click={onRetest} disabled={true}>
              {retestLabel}
            </button>
          {/if}
        </slot>
      </div>
    </div>
    {#if subtext}
      <div class="status-sub">{subtext}</div>
    {/if}
  </div>
{/if}

<style>
  .status-pill {
    display: flex; flex-direction: column; gap: 4px;
    padding: 10px 14px;
    font-size: 13px;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
  }
  .status-main { display: flex; align-items: center; gap: 8px; }
  .status-pill .material-symbols-rounded { font-size: 18px; }
  .status-pill.ok      { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .status-pill.ok      .material-symbols-rounded { color: var(--accent); }
  .status-pill.warn    { background: color-mix(in srgb, #d68a00 12%, transparent); }
  .status-pill.warn    .material-symbols-rounded { color: #d68a00; }
  .status-pill.fail    { background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .status-pill.fail    .material-symbols-rounded { color: var(--danger); }
  .status-pill.testing { background: var(--surface-2); color: var(--text-2); }
  .status-pill.testing .material-symbols-rounded { color: var(--text-3); }

  /* Sub-line: smaller, muted, indented past the icon. */
  .status-sub {
    font-size: 12px;
    color: var(--text-3);
    padding-left: 26px;
  }

  /* Provider badge — compact accent-tinted chip. */
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

  .status-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* :global so slotted action buttons in callers (wellness, etc.) can
     use the same look without each caller re-styling. */
  :global(.status-retest) {
    background: transparent; border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  :global(.status-retest:hover:not(:disabled)) { color: var(--text-1); border-color: var(--text-3); }
  :global(.status-retest:disabled) { opacity: 0.5; cursor: default; }
  :global(.status-retest.status-danger) { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
  :global(.status-retest.status-danger:hover:not(:disabled)) { color: var(--danger); border-color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); }

  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
