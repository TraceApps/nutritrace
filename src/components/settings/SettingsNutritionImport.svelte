<script>
  import { showError, showSuccess } from '../../stores/toast.js';
  import { apiUrl, resolveAssetUrl, isNative, getServerUrl, getAuthToken } from '../../lib/platform.js';
  import { loadEntry, currentDate } from '../../stores/diary.js';
  import { energyUnit } from '../../stores/settings.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { get } from 'svelte/store';

  // Auth headers for state-changing requests. PWA uses cookie + CSRF token
  // (server enforces both for write endpoints); native server mode uses
  // the Bearer JWT instead. Same shape as SettingsBackup.svelte's _fetchOpts.
  function _authHeaders() {
    const h = {};
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return h;
  }

  // ── State ────────────────────────────────────────────────────────────────
  let source = 'spreadsheet';
  let file = null;
  let fileInput;
  let preview = null;
  let busy = false;
  let onDuplicate = 'skip';

  const SOURCE_OPTIONS = [
    {
      id: 'spreadsheet',
      label: 'Generic Spreadsheet',
      hint: 'Any CSV with at least Date, Name, and Calories columns. Use our template for the easiest path.',
      accept: '.csv,text/csv',
    },
    {
      id: 'cronometer',
      label: 'Cronometer',
      hint: 'Profile → Account → Export Data → Servings (CSV). Free tier supported.',
      accept: '.csv,text/csv',
    },
    {
      id: 'loseit',
      label: 'Lose It!',
      hint: 'loseit.com → Insights → Weekly → Export to Spreadsheet. One CSV per week — concatenate first if importing multiple weeks.',
      accept: '.csv,text/csv',
    },
    {
      id: 'mfp',
      label: 'MyFitnessPal',
      hint: 'Go to myfitnesspal.com/reports/export, pick a date range, click Export, and wait for the email. Free and Premium both work. The export is aggregated per meal per day — one diary entry is created per meal with brand "MyFitnessPal", preserving the macro totals. Individual foods aren\'t in the export so they aren\'t reconstructed.',
      accept: '.csv,.zip,text/csv,application/zip',
    },
  ];
  $: currentSource = SOURCE_OPTIONS.find(s => s.id === source) || SOURCE_OPTIONS[0];

  function pickFile() { fileInput?.click(); }
  function onFile(e) {
    file = e.target.files?.[0] || null;
    preview = null;
  }
  function reset() {
    file = null;
    preview = null;
    if (fileInput) fileInput.value = '';
  }

  async function runPreview() {
    if (!file) return;
    busy = true;
    preview = null;
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('source', source);
      const res = await fetch(apiUrl('/api/nutrition-import/preview'), {
        method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
      });
      const data = await res.json();
      if (!res.ok) { showError(data?.error || 'Preview failed'); return; }
      preview = data;
    } catch (e) {
      showError('Could not reach server');
    } finally { busy = false; }
  }

  async function runCommit() {
    if (!file || !preview) return;
    busy = true;
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('source', source);
      fd.append('onDuplicate', onDuplicate);
      const res = await fetch(apiUrl('/api/nutrition-import/commit'), {
        method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
      });
      const data = await res.json();
      if (!res.ok) { showError(data?.error || 'Import failed'); return; }
      const verb = onDuplicate === 'merge' ? 'merged' : (onDuplicate === 'replace' ? 'replaced' : 'imported');
      showSuccess(`Imported ${data.imported + data.merged + data.replaced} day(s) — ${data.totalItems} items ${verb}`);
      // Refresh today's diary view in case the import touched today
      const today = get(currentDate);
      if (today) loadEntry(today);
      reset();
    } catch (e) {
      showError('Could not reach server');
    } finally { busy = false; }
  }
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:6px">
      <span class="setting-label" style="font-weight:600">Import Nutrition History</span>
      <p class="setting-desc" style="margin:0">
        Bring in past days from another tracker. Your existing diary is left alone unless you pick "replace" below.
      </p>
    </div>

    <div class="setting-divider"></div>

    <!-- Source picker -->
    <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
      <span class="setting-label">Source App</span>
      <div class="select-wrap" style="width:100%">
        <select class="select" bind:value={source} on:change={reset}>
          {#each SOURCE_OPTIONS as o (o.id)}
            <option value={o.id}>{o.label}</option>
          {/each}
        </select>
      </div>
      <p class="text-3 text-sm" style="margin:0">{currentSource.hint}</p>
      {#if source === 'spreadsheet'}
        <a class="text-link" href={resolveAssetUrl('/templates/nutrition-import-template.csv')} download>
          <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">download</span>
          Download template CSV
        </a>
      {/if}
    </div>

    <div class="setting-divider"></div>

    <!-- File picker -->
    <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
      <span class="setting-label">File</span>
      <input
        type="file"
        accept={currentSource.accept}
        bind:this={fileInput}
        on:change={onFile}
        style="display:none"
      />
      <div style="display:flex;gap:8px;align-items:center;width:100%">
        <button class="btn btn-secondary" on:click={pickFile} disabled={busy}>
          <span class="material-symbols-rounded" style="font-size:16px;vertical-align:middle">upload_file</span>
          {file ? 'Choose Different File' : 'Choose File'}
        </button>
        {#if file}
          <span class="text-3 text-sm" style="overflow-wrap:anywhere;min-width:0;flex:1">{file.name}</span>
          <button class="btn-icon" title="Clear" on:click={reset}>
            <span class="material-symbols-rounded">close</span>
          </button>
        {/if}
      </div>
      {#if file && !preview}
        <button class="btn btn-primary" style="width:100%" on:click={runPreview} disabled={busy}>
          {busy ? 'Reading…' : 'Preview'}
        </button>
      {/if}
    </div>

    {#if preview}
      <div class="setting-divider"></div>
      <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:10px">
        <span class="setting-label" style="font-weight:600">Preview</span>
        <div class="preview-stats">
          <div class="preview-stat"><strong>{preview.items}</strong><span>items</span></div>
          <div class="preview-stat"><strong>{preview.days}</strong><span>days</span></div>
          <div class="preview-stat" title="Days that already have a diary entry"><strong>{preview.duplicateDates.length}</strong><span>existing</span></div>
        </div>
        <p class="text-3 text-sm" style="margin:0">
          Range: {preview.dateRange.from} → {preview.dateRange.to}
        </p>

        {#if preview.unmappedMealLabels.length}
          <div class="warn-box">
            <strong>Unmapped meal labels</strong>
            <p class="text-3 text-sm" style="margin:4px 0">
              These labels didn't match any of your meal names ({preview.mealNames.join(' / ')}). They'll be imported into your last meal slot ({preview.mealNames[preview.mealNames.length - 1]}). Add custom meal names in Settings if you want them grouped separately.
            </p>
            <ul class="unmapped-list">
              {#each preview.unmappedMealLabels.slice(0, 6) as u}
                <li><code>{u.label}</code> · {u.count}</li>
              {/each}
              {#if preview.unmappedMealLabels.length > 6}<li class="text-3 text-sm">…and {preview.unmappedMealLabels.length - 6} more</li>{/if}
            </ul>
          </div>
        {/if}

        {#if preview.sample.length}
          <div class="sample-list">
            <div class="text-3 text-sm" style="margin-bottom:4px">First {preview.sample.length} items:</div>
            {#each preview.sample as s}
              {@const _e = Nutrition.displayEnergy(s.calories, $energyUnit)}
              <div class="sample-row">
                <span class="text-3 text-sm" style="flex-shrink:0">{s.date}</span>
                <span class="text-3 text-sm" style="flex-shrink:0;width:80px">{s.meal || '—'}</span>
                <span style="flex:1;min-width:0;overflow-wrap:anywhere">{s.brand ? s.brand + ' · ' : ''}{s.name}</span>
                <span class="text-3 text-sm" style="flex-shrink:0">{_e.value.toLocaleString()} {_e.unit}</span>
              </div>
            {/each}
          </div>
        {/if}

        {#if preview.duplicateDates.length}
          <div class="setting-row" style="padding:0;align-items:flex-start;flex-direction:column;gap:6px">
            <span class="setting-label">{preview.duplicateDates.length} day(s) already have entries</span>
            <div class="dupe-options">
              <label class="dupe-option">
                <input type="radio" bind:group={onDuplicate} value="skip" />
                <span><strong>Skip</strong> — leave existing days alone (safe)</span>
              </label>
              <label class="dupe-option">
                <input type="radio" bind:group={onDuplicate} value="merge" />
                <span><strong>Merge</strong> — append imported items to existing days</span>
              </label>
              <label class="dupe-option">
                <input type="radio" bind:group={onDuplicate} value="replace" />
                <span><strong>Replace</strong> — overwrite existing days (destructive)</span>
              </label>
            </div>
          </div>
        {/if}

        <div class="action-row">
          <button class="btn btn-ghost action-btn-cancel" on:click={reset} disabled={busy}>Cancel</button>
          <button class="btn btn-primary action-btn-import" on:click={runCommit} disabled={busy}>
            {busy ? 'Importing…' : `Import ${preview.items} item${preview.items === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Mirror Settings.svelte's scoped classes — Svelte scopes per component
     so each sub-component re-declares the same shapes. */
  .section-body { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }
  .settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
  .setting-label { font-size: 14px; font-weight: 500; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .setting-desc { font-size: 12px; color: var(--text-3); line-height: 1.5; font-weight: 400; }
  .text-link {
    color: var(--accent); font-size: 13px; text-decoration: none; display: inline-flex; align-items: center; gap: 4px;
  }
  .text-link:hover { text-decoration: underline; }

  .preview-stats { display: flex; gap: 16px; }
  .preview-stat {
    display: flex; flex-direction: column; align-items: center;
    padding: 8px 14px; background: var(--surface-2); border-radius: var(--radius-md);
    min-width: 60px;
  }
  .preview-stat strong { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .preview-stat span { font-size: 11px; color: var(--text-3); }

  .warn-box {
    padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--surface-2); width: 100%;
  }
  .warn-box strong { font-size: 13px; }
  .unmapped-list { margin: 4px 0 0; padding-left: 18px; font-size: 12px; }
  .unmapped-list code {
    background: var(--surface-1); padding: 1px 6px; border-radius: 4px; font-size: 11px;
  }

  .sample-list { width: 100%; }
  .sample-row {
    display: flex; gap: 10px; padding: 4px 0;
    border-bottom: 1px solid var(--border); font-size: 13px;
  }
  .sample-row:last-child { border-bottom: none; }

  .dupe-options { display: flex; flex-direction: column; gap: 6px; width: 100%; }
  .dupe-option {
    display: flex; gap: 8px; align-items: flex-start; cursor: pointer; font-size: 13px;
    padding: 8px 10px; border-radius: var(--radius-md);
    border: 1px solid var(--border); background: var(--surface-1);
  }
  .dupe-option:hover { background: var(--surface-2); }
  .dupe-option input { margin-top: 2px; }

  /* Bottom action row. Real class instead of inline style so Firefox can't
     fall back to a weird layout when flex-grow + nowrap + long button label
     interact (nomad64 #33 — Cancel/Import row rendered overlapping the
     duplicate-day radios on Firefox/Linux). Explicit row direction +
     nowrap + flex-shrink:0 + isolated stacking context lock the row into
     its intended position below the radios. */
  .action-row {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    gap: 8px;
    width: 100%;
    margin-top: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    position: relative;
    z-index: 1;
    flex-shrink: 0;
  }
  .action-btn-cancel { flex: 1 1 0; }
  .action-btn-import { flex: 2 1 0; min-width: 0; }
</style>
