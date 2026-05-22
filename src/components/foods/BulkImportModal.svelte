<script>
  import { createEventDispatcher } from 'svelte';
  import Sheet from '../ui/Sheet.svelte';
  import Tabs from '../ui/Tabs.svelte';
  import { buildJsonTemplate, buildCsvTemplate } from '../../lib/food-import-template.js';
  import { parseJson, parseCsv } from '../../lib/food-import-parse.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { energyUnit } from '../../stores/settings.js';

  export let open = false;
  /** Array of existing barcodes for the current user — used for dedup-by-barcode. */
  export let existingBarcodes = [];

  const dispatch = createEventDispatcher();

  let activeTab = 0;
  let jsonText = '';
  let csvText = '';
  let _fileName = '';

  $: tabs = [{ label: 'JSON', value: 'json' }, { label: 'CSV', value: 'csv' }];
  $: currentText = activeTab === 0 ? jsonText : csvText;
  $: parsed = _parseCurrent(currentText, activeTab);

  $: existingBarcodeSet = new Set((existingBarcodes || []).filter(Boolean));
  $: results = _splitDuplicates(parsed, existingBarcodeSet);
  $: canCommit = results.valid.length > 0 && parsed.errors.length === 0;

  function _parseCurrent(text, tab) {
    if (!text?.trim()) return { valid: [], errors: [] };
    return tab === 0 ? parseJson(text) : parseCsv(text);
  }

  function _splitDuplicates({ valid = [], errors = [] }, barcodeSet) {
    const out = { valid: [], duplicates: [], errors };
    for (const f of valid) {
      if (f.barcode && barcodeSet.has(f.barcode)) out.duplicates.push(f);
      else out.valid.push(f);
    }
    return out;
  }

  function _downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadTemplate() {
    if (activeTab === 0) {
      _downloadBlob(
        new Blob([JSON.stringify(buildJsonTemplate(), null, 2)], { type: 'application/json' }),
        'nutritrace-food-import-template.json'
      );
    } else {
      _downloadBlob(
        new Blob([buildCsvTemplate()], { type: 'text/csv' }),
        'nutritrace-food-import-template.csv'
      );
    }
  }

  function pickFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = activeTab === 0 ? '.json,application/json' : '.csv,text/csv';
    input.onchange = async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      _fileName = file.name;
      const text = await file.text();
      if (activeTab === 0) jsonText = text;
      else csvText = text;
    };
    input.click();
  }

  function clearInput() {
    if (activeTab === 0) jsonText = '';
    else csvText = '';
    _fileName = '';
  }

  function commit() {
    if (!canCommit) return;
    dispatch('commit', { foods: results.valid, skipped: results.duplicates.length });
  }

  function close() {
    open = false;
    dispatch('close');
  }
</script>

<Sheet bind:open height="full" title="Bulk Import Foods" on:close={close}>
  <div class="wrap">
    <Tabs {tabs} bind:active={activeTab} />

    <div class="hint">
      Paste or upload a {activeTab === 0 ? 'JSON' : 'CSV'} file. Each row needs at minimum
      a <code>name</code> and <code>calories</code>; other nutrients are optional.
      <button class="link-btn" type="button" on:click={downloadTemplate}>Download Template</button>
    </div>

    {#if activeTab === 0}
      <textarea
        class="paste-area"
        placeholder={'{ "foods": [ { "name": "...", "nutrition": { "calories": 200 } } ] }'}
        bind:value={jsonText}
        spellcheck="false"
      ></textarea>
    {:else}
      <div class="upload-area">
        <p class="upload-note">CSV files don't paste cleanly. Use the upload button.</p>
        {#if csvText}
          <p class="filename">Loaded: {_fileName || 'pasted'}</p>
        {/if}
      </div>
    {/if}

    <div class="row-actions">
      <button class="btn btn-secondary" type="button" on:click={pickFile}>
        <span class="material-symbols-rounded" style="font-size:18px">upload_file</span>
        Upload file
      </button>
      {#if currentText}
        <button class="btn btn-secondary" type="button" on:click={clearInput}>Clear</button>
      {/if}
    </div>

    <!-- Preview -->
    {#if currentText}
      <div class="preview">
        <div class="preview-summary">
          <span class="chip ok">{results.valid.length} ready</span>
          {#if results.duplicates.length > 0}
            <span class="chip warn">{results.duplicates.length} duplicate barcode{results.duplicates.length === 1 ? '' : 's'}</span>
          {/if}
          {#if parsed.errors.length > 0}
            <span class="chip err">{parsed.errors.length} error{parsed.errors.length === 1 ? '' : 's'}</span>
          {/if}
        </div>

        {#if results.valid.length > 0}
          <p class="preview-section-label">Will Import</p>
          <ul class="preview-list">
            {#each results.valid as f}
              {@const _e = Nutrition.displayEnergy(f.nutrition.calories || 0, $energyUnit)}
              <li>
                <span class="food-name">{f.name}</span>
                {#if f.brand}<span class="food-brand">{f.brand}</span>{/if}
                <span class="food-meta">{_e.value} {_e.unit} · {f.portion}{f.unit}</span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if results.duplicates.length > 0}
          <p class="preview-section-label warn">Skipped (barcode already in your catalog)</p>
          <ul class="preview-list">
            {#each results.duplicates as f}
              <li>
                <span class="food-name">{f.name}</span>
                <span class="food-meta">barcode {f.barcode}</span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if parsed.errors.length > 0}
          <p class="preview-section-label err">Errors (fix or remove these rows before importing)</p>
          <ul class="preview-list err-list">
            {#each parsed.errors as e}
              <li>Row {e.row}: {e.message}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    <div class="footer">
      <button class="btn btn-secondary" type="button" on:click={close}>Cancel</button>
      <button class="btn btn-primary" type="button" on:click={commit} disabled={!canCommit}>
        Import {results.valid.length || ''}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-bottom: 12px;
  }
  .hint {
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.5;
  }
  .hint code {
    background: var(--surface-2);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12px;
  }
  .link-btn {
    background: none;
    border: none;
    color: var(--accent);
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    padding: 0;
    margin-left: 4px;
    text-decoration: underline;
  }
  .paste-area {
    width: 100%;
    min-height: 160px;
    max-height: 280px;
    padding: 10px 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--text-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    resize: vertical;
  }
  .upload-area {
    padding: 18px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    text-align: center;
    color: var(--text-2);
    background: var(--surface-2);
  }
  .upload-note { font-size: 13px; margin: 0; }
  .filename { font-size: 12px; color: var(--accent); margin-top: 6px; }
  .row-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .row-actions .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .preview {
    background: var(--surface-2);
    border-radius: var(--radius-md);
    padding: 12px;
  }
  .preview-summary {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .chip {
    font-size: 12px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 999px;
  }
  .chip.ok   { background: var(--success-bg, rgba(40,180,80,.15)); color: var(--success, #2bb24c); }
  .chip.warn { background: var(--warning-bg, rgba(220,160,30,.15)); color: var(--warning, #d49a2b); }
  .chip.err  { background: var(--danger-bg, rgba(220,60,60,.15)); color: var(--danger, #d04848); }
  .preview-section-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin: 10px 0 4px;
    color: var(--text-2);
  }
  .preview-section-label.warn { color: var(--warning, #d49a2b); }
  .preview-section-label.err  { color: var(--danger, #d04848); }
  .preview-list {
    margin: 0;
    padding-left: 0;
    list-style: none;
    max-height: 200px;
    overflow-y: auto;
  }
  .preview-list li {
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
  }
  .preview-list li:last-child { border-bottom: none; }
  .food-name { font-weight: 600; color: var(--text-1); }
  .food-brand { font-size: 12px; color: var(--text-2); }
  .food-meta { font-size: 12px; color: var(--text-2); margin-left: auto; }
  .err-list li { color: var(--danger, #d04848); }
  .footer {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .footer .btn { min-width: 100px; }
</style>
