<script>
  import { createEventDispatcher } from 'svelte';
  import { portal } from '../../lib/portal.js';
  import { timeFormat } from '../../stores/settings.js';

  export let value = '12:00'; // HH:MM (24h internal)
  export let label = '';
  export let placeholder = '';

  const dispatch = createEventDispatcher();

  let open = false;
  let selHour = 12;
  let selMinute = 0;
  let selAmPm = 'AM';

  $: is24 = $timeFormat === '24h';

  // Parse value into hour/minute/ampm
  function _parse(v) {
    const [h, m] = (v || '12:00').split(':').map(Number);
    selMinute = m || 0;
    if (is24) {
      selHour = h;
    } else {
      if (h === 0) { selHour = 12; selAmPm = 'AM'; }
      else if (h === 12) { selHour = 12; selAmPm = 'PM'; }
      else if (h > 12) { selHour = h - 12; selAmPm = 'PM'; }
      else { selHour = h; selAmPm = 'AM'; }
    }
  }

  $: _parse(value);

  function _to24() {
    let h;
    if (is24) {
      h = selHour;
    } else {
      h = selHour;
      if (selAmPm === 'AM' && h === 12) h = 0;
      else if (selAmPm === 'PM' && h !== 12) h += 12;
    }
    return `${String(h).padStart(2, '0')}:${String(selMinute).padStart(2, '0')}`;
  }

  function _confirm() {
    value = _to24();
    dispatch('change', value);
    open = false;
  }

  function _display(v) {
    if (!v && placeholder) return placeholder;
    const [h, m] = (v || '12:00').split(':').map(Number);
    if (is24) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  $: HOURS = is24
    ? Array.from({ length: 24 }, (_, i) => i)
    : [1,2,3,4,5,6,7,8,9,10,11,12];
  const MINUTES = [0,5,10,15,20,25,30,35,40,45,50,55];
</script>

<button class="tp-trigger" on:click={() => { _parse(value); open = true; }}>
  {#if label}<span class="tp-label">{label}</span>{/if}
  <span class="tp-value" class:tp-placeholder={!value && placeholder}>{_display(value)}</span>
  <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3)">schedule</span>
</button>

{#if open}
  <div use:portal class="tp-backdrop" role="dialog" aria-modal="true"
    on:click|self={() => open = false} on:keydown={() => {}}>
    <div class="tp-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="tp-handle"></div>

      <!-- Preview -->
      <div class="tp-preview">
        {#if is24}
          {String(selHour).padStart(2, '0')}:{String(selMinute).padStart(2, '0')}
        {:else}
          {selHour}:{String(selMinute).padStart(2, '0')} {selAmPm}
        {/if}
      </div>

      <!-- Hour / Minute / AM-PM columns -->
      <div class="tp-columns">
        <div class="tp-col">
          <div class="tp-col-label">Hour</div>
          <div class="tp-grid" class:tp-grid-4={!is24} class:tp-grid-6={is24}>
            {#each HOURS as h}
              <button class="tp-cell" class:tp-sel={selHour === h} on:click={() => selHour = h}>
                {is24 ? String(h).padStart(2, '0') : h}
              </button>
            {/each}
          </div>
        </div>

        <div class="tp-col">
          <div class="tp-col-label">Minute</div>
          <div class="tp-grid tp-grid-4">
            {#each MINUTES as m}
              <button class="tp-cell" class:tp-sel={selMinute === m} on:click={() => selMinute = m}>{String(m).padStart(2, '0')}</button>
            {/each}
          </div>
        </div>

        {#if !is24}
          <div class="tp-col tp-col-ampm">
            <div class="tp-col-label">&nbsp;</div>
            <div class="tp-ampm">
              <button class="tp-cell tp-cell-ampm" class:tp-sel={selAmPm === 'AM'} on:click={() => selAmPm = 'AM'}>AM</button>
              <button class="tp-cell tp-cell-ampm" class:tp-sel={selAmPm === 'PM'} on:click={() => selAmPm = 'PM'}>PM</button>
            </div>
          </div>
        {/if}
      </div>

      <!-- Actions -->
      <div class="tp-actions">
        <button class="btn btn-ghost" on:click={() => open = false}>Cancel</button>
        <button class="btn btn-primary" on:click={_confirm}>Set Time</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tp-trigger {
    display: flex; align-items: center; gap: 8px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 8px 12px;
    cursor: pointer; font-size: 14px; color: var(--text-1);
    transition: border-color var(--dur-fast);
  }
  .tp-trigger:hover { border-color: var(--accent); }
  .tp-label { font-size: 12px; color: var(--text-3); }
  .tp-value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .tp-placeholder { color: var(--text-3); font-weight: 400; }

  .tp-backdrop {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
    display: flex; align-items: flex-end; justify-content: center;
  }
  .tp-sheet {
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 400px; margin: 0 auto;
    padding: 0 16px 16px;
  }
  .tp-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 10px auto 12px; }

  .tp-preview {
    text-align: center; font-size: 32px; font-weight: 800;
    color: var(--accent); padding: 8px 0 16px;
    font-variant-numeric: tabular-nums;
  }

  .tp-columns { display: flex; gap: 12px; }
  .tp-col { flex: 1; }
  .tp-col-ampm { flex: 0 0 auto; width: 56px; }
  .tp-col-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-3); margin-bottom: 8px; text-align: center; }

  .tp-grid { display: grid; gap: 4px; }
  .tp-grid-4 { grid-template-columns: repeat(4, 1fr); }
  .tp-grid-6 { grid-template-columns: repeat(6, 1fr); }

  .tp-cell {
    padding: 8px 4px; border-radius: var(--radius-md);
    background: var(--surface-2); border: 1.5px solid transparent;
    color: var(--text-2); font-size: 14px; font-weight: 500;
    cursor: pointer; text-align: center;
    transition: border-color var(--dur-fast), background var(--dur-fast), color var(--dur-fast);
  }
  .tp-cell:hover { border-color: var(--accent); color: var(--text-1); }
  .tp-sel {
    border-color: var(--accent); background: var(--accent-dim);
    color: var(--accent); font-weight: 700;
  }

  .tp-ampm { display: flex; flex-direction: column; gap: 4px; }
  .tp-cell-ampm { padding: 12px 8px; font-size: 15px; }

  .tp-actions {
    display: flex; justify-content: flex-end; gap: 8px;
    padding-top: 16px; border-top: 1px solid var(--border); margin-top: 16px;
  }

  @media (min-width: 500px) {
    .tp-backdrop { align-items: center; }
    .tp-sheet { border-radius: var(--radius-xl); }
  }
</style>
