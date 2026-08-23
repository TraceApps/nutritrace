<script>
  /**
   * Diary → right column → Body Stats widget (combined weight +
   * measurements). Replaces the two separate WeightWidget +
   * BodyMeasurementsWidget cards with a single unified card so the
   * rail stack is shorter and body-related data lives in one place.
   *
   * Layout:
   *   Weight row      — value + inline edit, or "Not logged today"
   *   Divider
   *   Measurements    — list of logged fields, or "No measurements"
   *   Log Stats CTA   — opens the full Body Stats sheet
   */
  import { slide } from 'svelte/transition';
  import { decimalInput, parseDecimal } from '../../lib/decimal-input.js';

  export let currentWeight = null;
  export let weightUnit    = 'kg';
  export let stats         = {};
  export let lengthUnit    = 'cm';
  export let onSaveWeight  = async (_val) => {};
  export let onOpen        = () => {};

  const ROWS = [
    { key: 'waist',  label: 'Waist'  },
    { key: 'hips',   label: 'Hips'   },
    { key: 'chest',  label: 'Chest'  },
    { key: 'neck',   label: 'Neck'   },
    { key: 'thighs', label: 'Thighs' },
    { key: 'biceps', label: 'Biceps' },
    { key: 'calves', label: 'Calves' },
  ];

  $: measurementRows = ROWS
    .filter(r => stats[r.key] != null && stats[r.key] !== '')
    .map(r => ({ ...r, value: stats[r.key] }));
  $: hasMeasurements = measurementRows.length > 0;

  let editing = false;
  let inputVal = '';
  let inputEl;
  let saving = false;

  async function startEditWeight() {
    editing = true;
    inputVal = currentWeight != null ? String(currentWeight) : '';
    await Promise.resolve();
    inputEl?.focus();
    inputEl?.select();
  }
  async function commitWeight() {
    // Empty field or 0 = "clear the weight" — propagate as null so the
    // parent can remove it. Previously this branch silently cancelled and
    // there was no way to delete a weight via the widget (#168 B). Any
    // other unparseable input (letters, etc.) still just cancels.
    const trimmed = String(inputVal ?? '').trim();
    let payload;
    if (trimmed === '') {
      payload = null;
    } else {
      const val = parseDecimal(trimmed);
      if (!Number.isFinite(val)) { cancelWeight(); return; }
      if (val <= 0) payload = null;
      else          payload = val;
    }
    saving = true;
    try { await onSaveWeight(payload); editing = false; inputVal = ''; }
    finally { saving = false; }
  }
  function cancelWeight() { editing = false; inputVal = ''; }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitWeight(); }
    else if (e.key === 'Escape') { cancelWeight(); }
  }
</script>

<section class="bs-widget card">
  <header class="bs-header">
    <span class="material-symbols-rounded bs-icon">monitor_weight</span>
    <span class="bs-title">Body Stats</span>
    <button class="bs-open" on:click={onOpen} title="Open Body Stats sheet">
      <span class="material-symbols-rounded">open_in_full</span>
    </button>
  </header>

  <!-- Weight row -->
  <div class="bs-weight-row">
    {#if !editing}
      {#if currentWeight != null}
        <div class="bs-weight-value">
          <span class="bs-w-num">{currentWeight}</span>
          <span class="bs-w-unit">{weightUnit}</span>
        </div>
        <button class="bs-edit-inline" on:click={startEditWeight} title="Edit today's weight">
          <span class="material-symbols-rounded">edit</span>
        </button>
      {:else}
        <span class="bs-weight-empty">Weight not logged</span>
        <button class="bs-quick-log" on:click={startEditWeight}>Log</button>
      {/if}
    {:else}
      <div class="bs-edit-form" transition:slide={{ duration: 160 }}>
        <input
          bind:this={inputEl}
          bind:value={inputVal}
          on:keydown={onKey}
          type="text"
          inputmode="decimal"
          use:decimalInput
          placeholder={weightUnit}
          class="input bs-edit-input"
          disabled={saving}
        />
        <button class="btn btn-primary bs-save" on:click={commitWeight} disabled={saving}>
          {saving ? '…' : 'Save'}
        </button>
        <button class="btn btn-ghost bs-cancel" on:click={cancelWeight} disabled={saving}>
          Cancel
        </button>
      </div>
    {/if}
  </div>

  <div class="bs-divider"></div>

  <!-- Measurements section -->
  {#if hasMeasurements}
    <ul class="bs-list">
      {#each measurementRows as row (row.key)}
        <li class="bs-row">
          <span class="bs-label">{row.label}</span>
          <span class="bs-value">{row.value} <span class="bs-unit">{lengthUnit}</span></span>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="bs-empty">No measurements logged today</div>
  {/if}

  <button class="btn btn-primary bs-log-btn" on:click={onOpen}>
    Log Stats
  </button>
</section>

<style>
  .bs-widget {
    padding: 16px 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bs-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .bs-icon { color: var(--accent); font-size: 20px; }
  .bs-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.01em;
    flex: 1;
  }
  .bs-open {
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
  .bs-open:hover { color: var(--text-1); background: var(--surface-2); }
  .bs-open .material-symbols-rounded { font-size: 16px; }

  .bs-weight-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 34px;
  }
  .bs-weight-value {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }
  .bs-w-num {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
    color: var(--text-1);
    font-variant-numeric: tabular-nums;
  }
  .bs-w-unit {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-3);
  }
  .bs-weight-empty {
    font-size: 13px;
    color: var(--text-3);
    font-style: italic;
  }
  .bs-edit-inline {
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
  .bs-edit-inline:hover { color: var(--text-1); background: var(--surface-2); }
  .bs-edit-inline .material-symbols-rounded { font-size: 14px; }
  .bs-quick-log {
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .bs-quick-log:hover { background: var(--accent); color: white; }

  .bs-edit-form {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 6px;
    width: 100%;
    align-items: center;
  }
  .bs-edit-input {
    padding: 6px 10px;
    font-size: 14px;
    font-weight: 600;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    width: 100%;
  }
  .bs-edit-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .bs-save, .bs-cancel {
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  .bs-divider {
    height: 1px;
    background: var(--border);
    margin: 2px 0;
  }

  .bs-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .bs-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 5px 10px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
  .bs-label { color: var(--text-2); font-weight: 500; }
  .bs-value {
    color: var(--text-1);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .bs-unit {
    color: var(--text-3);
    font-weight: 500;
    font-size: 11px;
    margin-left: 2px;
  }

  .bs-empty {
    font-size: 12px;
    color: var(--text-3);
    font-style: italic;
    padding: 4px 2px;
  }

  .bs-log-btn {
    width: 100%;
    padding: 9px 12px;
    font-size: 13px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
</style>
