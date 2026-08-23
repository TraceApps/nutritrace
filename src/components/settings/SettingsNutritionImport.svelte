<script>
  import { _ } from 'svelte-i18n';
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

  $: SOURCE_OPTIONS = [
    {
      id: 'spreadsheet',
      label: $_('settings_nutrition_import.sources.spreadsheet_label'),
      hint:  $_('settings_nutrition_import.sources.spreadsheet_hint'),
      accept: '.csv,text/csv',
    },
    {
      id: 'cronometer',
      label: $_('settings_nutrition_import.sources.cronometer_label'),
      hint:  $_('settings_nutrition_import.sources.cronometer_hint'),
      accept: '.csv,text/csv',
    },
    {
      id: 'loseit',
      label: $_('settings_nutrition_import.sources.loseit_label'),
      hint:  $_('settings_nutrition_import.sources.loseit_hint'),
      accept: '.csv,text/csv',
    },
    {
      id: 'mfp',
      label: $_('settings_nutrition_import.sources.mfp_label'),
      hint:  $_('settings_nutrition_import.sources.mfp_hint'),
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
      if (!res.ok) { showError(data?.error || $_('settings_nutrition_import.preview_failed')); return; }
      preview = data;
    } catch (e) {
      showError($_('common.errors.cant_reach_server'));
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
      if (!res.ok) { showError(data?.error || $_('settings_nutrition_import.import_failed')); return; }
      const verb = $_(onDuplicate === 'merge' ? 'settings_nutrition_import.verb_merged'
                    : onDuplicate === 'replace' ? 'settings_nutrition_import.verb_replaced'
                    : 'settings_nutrition_import.verb_imported');
      showSuccess($_('settings_nutrition_import.imported_summary', { values: {
        days: data.imported + data.merged + data.replaced,
        items: data.totalItems,
        verb,
      } }));
      const today = get(currentDate);
      if (today) loadEntry(today);
      reset();
    } catch (e) {
      showError($_('common.errors.cant_reach_server'));
    } finally { busy = false; }
  }
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:6px">
      <span class="setting-label" style="font-weight:600">{$_('settings_nutrition_import.title')}</span>
      <p class="setting-desc" style="margin:0">
        {$_('settings_nutrition_import.desc')}
      </p>
    </div>

    <div class="setting-divider"></div>

    <!-- Source picker -->
    <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
      <span class="setting-label">{$_('settings_nutrition_import.source_app')}</span>
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
          {$_('settings_nutrition_import.download_template')}
        </a>
      {/if}
    </div>

    <div class="setting-divider"></div>

    <!-- File picker -->
    <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:8px">
      <span class="setting-label">{$_('settings_nutrition_import.file')}</span>
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
          {file ? $_('settings_nutrition_import.choose_different_file') : $_('settings_nutrition_import.choose_file')}
        </button>
        {#if file}
          <span class="text-3 text-sm" style="overflow-wrap:anywhere;min-width:0;flex:1">{file.name}</span>
          <button class="btn-icon" title={$_('settings_nutrition_import.clear')} on:click={reset}>
            <span class="material-symbols-rounded">close</span>
          </button>
        {/if}
      </div>
      {#if file && !preview}
        <button class="btn btn-primary" style="width:100%" on:click={runPreview} disabled={busy}>
          {busy ? $_('settings_nutrition_import.reading') : $_('settings_nutrition_import.preview')}
        </button>
      {/if}
    </div>

    {#if preview}
      <div class="setting-divider"></div>
      <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:10px">
        <span class="setting-label" style="font-weight:600">{$_('settings_nutrition_import.preview')}</span>
        <div class="preview-stats">
          <div class="preview-stat"><strong>{preview.items}</strong><span>{$_('settings_nutrition_import.stats_items')}</span></div>
          <div class="preview-stat"><strong>{preview.days}</strong><span>{$_('settings_nutrition_import.stats_days')}</span></div>
          <div class="preview-stat" title={$_('settings_nutrition_import.existing_hint')}><strong>{preview.duplicateDates.length}</strong><span>{$_('settings_nutrition_import.stats_existing')}</span></div>
        </div>
        <p class="text-3 text-sm" style="margin:0">
          {$_('settings_nutrition_import.range', { values: { from: preview.dateRange.from, to: preview.dateRange.to } })}
        </p>

        {#if preview.unmappedMealLabels.length}
          <div class="warn-box">
            <strong>{$_('settings_nutrition_import.unmapped_title')}</strong>
            <p class="text-3 text-sm" style="margin:4px 0">
              {$_('settings_nutrition_import.unmapped_desc', { values: { meals: preview.mealNames.join(' / '), lastMeal: preview.mealNames[preview.mealNames.length - 1] } })}
            </p>
            <ul class="unmapped-list">
              {#each preview.unmappedMealLabels.slice(0, 6) as u}
                <li><code>{u.label}</code> · {u.count}</li>
              {/each}
              {#if preview.unmappedMealLabels.length > 6}<li class="text-3 text-sm">{$_('settings_nutrition_import.and_more', { values: { n: preview.unmappedMealLabels.length - 6 } })}</li>{/if}
            </ul>
          </div>
        {/if}

        {#if preview.sample.length}
          <div class="sample-list">
            <div class="text-3 text-sm" style="margin-bottom:4px">{$_('settings_nutrition_import.first_items', { values: { n: preview.sample.length } })}</div>
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
            <span class="setting-label">{$_('settings_nutrition_import.dupes_days', { values: { n: preview.duplicateDates.length } })}</span>
            <div class="dupe-options">
              <label class="dupe-option">
                <input type="radio" bind:group={onDuplicate} value="skip" />
                <span><strong>{$_('settings_nutrition_import.dup_skip')}</strong>{$_('settings_nutrition_import.dup_skip_desc')}</span>
              </label>
              <label class="dupe-option">
                <input type="radio" bind:group={onDuplicate} value="merge" />
                <span><strong>{$_('settings_nutrition_import.dup_merge')}</strong>{$_('settings_nutrition_import.dup_merge_desc')}</span>
              </label>
              <label class="dupe-option">
                <input type="radio" bind:group={onDuplicate} value="replace" />
                <span><strong>{$_('settings_nutrition_import.dup_replace')}</strong>{$_('settings_nutrition_import.dup_replace_desc')}</span>
              </label>
            </div>
          </div>
        {/if}

        <div class="action-row">
          <button class="btn btn-ghost action-btn-cancel" on:click={reset} disabled={busy}>{$_('settings_nutrition_import.cancel')}</button>
          <button class="btn btn-primary action-btn-import" on:click={runCommit} disabled={busy}>
            {busy ? $_('settings_nutrition_import.importing') : $_(preview.items === 1 ? 'settings_nutrition_import.import_one' : 'settings_nutrition_import.import_n', { values: { n: preview.items } })}
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
