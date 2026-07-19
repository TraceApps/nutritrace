<script>
  import { createEventDispatcher, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { addActivity, updateActivity } from '../../stores/activity.js';
  import { energyUnit, distUnit, weightUnit } from '../../stores/settings.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { NtApi } from '../../lib/api.js';
  import { DB } from '../../lib/db.js';
  import { ACTIVITIES, search as searchCompendium, metKcal, findById } from '../../lib/activity-picker.js';
  import { readBodyStat } from '../../lib/body-stats-unit.js';
  import ActivityCategoryPicker from './ActivityCategoryPicker.svelte';

  export let open = false;
  export let date = '';        // YYYY-MM-DD
  export let entry = null;     // pass an existing activity_log row to edit

  const dispatch = createEventDispatcher();

  let name = '';
  let kcal = '';
  let durationMin = '';
  let distance = '';
  let saving = false;
  let error = '';
  let nameInput;
  let pastNames = [];              // recent name strings for the "Past entries" section
  let showBrowse = false;          // controls ActivityCategoryPicker sheet
  let showSuggestions = false;     // dropdown visibility
  let met = null;                  // set when picked from compendium or template
  let isTemplate = false;          // "Save as template" checkbox
  let templates = [];              // pinned templates from activity_log (is_template=1)
  let userWeightKg = null;         // for live kcal preview
  let userKcalOverridden = false;  // true once the user types a kcal manually
  // Reset fields only on the false→true open transition; otherwise typing
  // in the inputs triggers a reactive cycle that wipes the user's edits.
  let _wasOpen = false;
  $: {
    if (open && !_wasOpen) {
      name        = entry?.name        ?? '';
      kcal = entry?.kcal != null
        ? String($energyUnit === 'kJ' ? Math.round(entry.kcal * 4.184) : entry.kcal)
        : '';
      durationMin = entry?.duration_min != null ? String(entry.duration_min) : '';
      distance    = entry?.distance    ?? '';
      met         = entry?.met ?? null;
      isTemplate  = !!entry?.is_template;
      error       = '';
      userKcalOverridden = !!entry;      // editing an existing row = user's own number
      showSuggestions = false;
      // Weight source for the MET → kcal preview. Priority chain (#99):
      //   1. freshest of {body_stats.weight, wellness_data.weight_kg} — the
      //      wellness_data path covers users with a smart scale (Withings,
      //      Fitbit Aria, Garmin Index, HC BodyComp) whose weight never
      //      lands in the diary's body_stats blob.
      //   2. weight_kg setting from onboarding Wizard — static, set once.
      // Original fix only checked body_stats and missed reporter (#99)'s
      // Withings-scale case.
      //
      // Seed from the setting synchronously so the preview can render
      // immediately; then override async with whichever real weight-log
      // source has the most recent date. Any fetch failure silently keeps
      // the synchronous seed — never worse than before.
      try {
        const raw = DB.getSetting('weight_kg', null);
        userWeightKg = raw != null && !isNaN(Number(raw)) ? Number(raw) : null;
      } catch { userWeightKg = null; }
      Promise.all([
        NtApi.getAllDiary().catch(() => []),
        NtApi.getLatestWellness('weight_kg').catch(() => null),
      ]).then(([rows, wellnessLatest]) => {
        // Walk diary backward to find the most recent body_stats.weight
        // and its date; readBodyStat converts kg/lb tag to kg.
        let bodyLatest = null;
        if (Array.isArray(rows) && rows.length > 0) {
          const sorted = [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
          for (const r of sorted) {
            const bs = r.body_stats || r.bodyStats;
            if (bs && bs.weight != null && bs.weight !== '') {
              const wKg = readBodyStat(bs, 'weight', 'kg');
              if (wKg != null && wKg > 0) { bodyLatest = { date: r.date, wKg }; break; }
            }
          }
        }
        // Wellness value is already in kg (metric_type='weight_kg' is
        // canonical). Guard against 0/negative just in case.
        const wellVal = wellnessLatest && wellnessLatest.value > 0
          ? { date: wellnessLatest.date, wKg: Number(wellnessLatest.value) }
          : null;
        // Pick whichever source has the newer date. When both are on the
        // same day, prefer body_stats (user's most-recent manual weigh-in
        // wins over a passive scale sync).
        let pick = null;
        if (bodyLatest && wellVal) {
          pick = (bodyLatest.date >= wellVal.date) ? bodyLatest : wellVal;
        } else {
          pick = bodyLatest || wellVal;
        }
        if (pick && pick.wKg > 0) userWeightKg = pick.wKg;
      });
      // Past 90 days of names (existing behavior) + templates (new). Both
      // fire-and-forget so the sheet is usable even if the fetch fails.
      const today = new Date();
      const past = new Date(); past.setDate(past.getDate() - 90);
      const fmt = d => d.toISOString().slice(0, 10);
      NtApi.getActivityRange(fmt(past), fmt(today))
        .then(rows => {
          const seen = new Set();
          pastNames = (rows || [])
            .map(r => (r?.name || '').trim())
            .filter(n => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
            .slice(0, 50);
          const tplSeen = new Set();
          templates = (rows || [])
            .filter(r => r?.is_template)
            .filter(r => {
              const k = (r.name || '').toLowerCase();
              if (tplSeen.has(k)) return false;
              tplSeen.add(k);
              return true;
            })
            .slice(0, 12);
        })
        .catch(() => { pastNames = []; templates = []; });
      tick().then(() => nameInput?.focus());
    }
    _wasOpen = open;
  }

  $: titleText = entry ? $_('diary.activity.title_edit') : $_('diary.activity.title_add');

  // Live MET → kcal preview. Only fires when a compendium/template MET is
  // attached, weight is on file, and duration is set. When it fires and the
  // user hasn't manually overridden kcal, auto-fill so the form is one tap
  // from save. When they type over it, userKcalOverridden latches to true
  // and the preview becomes read-only guidance below the field.
  $: previewKcal = metKcal({ met, weightKg: userWeightKg, durationMin });
  $: {
    if (previewKcal != null && !userKcalOverridden) {
      const shown = $energyUnit === 'kJ' ? Math.round(previewKcal * 4.184) : previewKcal;
      kcal = String(shown);
    }
  }

  // Filter compendium + past names by current name input. Cap each source so
  // the dropdown never scrolls forever.
  $: q = name.trim();
  $: compendiumMatches = q ? searchCompendium(q).slice(0, 8) : [];
  $: pastMatches = q
    ? pastNames.filter(n => n.toLowerCase().includes(q.toLowerCase())).slice(0, 4)
    : [];
  $: hasSuggestions = showSuggestions && q.length > 0 &&
    (compendiumMatches.length > 0 || pastMatches.length > 0 || templates.length > 0);

  function pickCompendium(a) {
    name = a.name;
    met = a.met;
    userKcalOverridden = false;   // let auto-calc take over
    showSuggestions = false;
    tick().then(() => {
      // Focus duration next so the user can type "45" and hit save
      const durEl = document.getElementById('activity-duration-input');
      durEl?.focus();
    });
  }
  function pickPastName(n) {
    name = n;
    // Past-entry pick doesn't attach a MET (we don't know which compendium
    // entry it came from). User can browse or retype to attach one.
    met = null;
    showSuggestions = false;
  }
  function pickTemplate(t) {
    name = t.name;
    met = t.met ?? null;
    durationMin = t.duration_min != null ? String(t.duration_min) : durationMin;
    distance = t.distance || '';
    userKcalOverridden = false;   // let auto-calc rerun with template MET
    showSuggestions = false;
  }
  function onNameInput() {
    // Typing invalidates any previously-attached MET (the name may no
    // longer match a compendium row). User can re-pick from dropdown to
    // reattach.
    if (met != null) met = null;
    userKcalOverridden = false;   // typing may match a new compendium row
    showSuggestions = true;
  }
  function onKcalInput() {
    // Explicit user edit latches — auto-calc doesn't stomp again on this session.
    userKcalOverridden = true;
  }
  function browseOpen() {
    showBrowse = true;
    showSuggestions = false;
  }
  function onBrowsePicked(e) {
    const a = e.detail;
    pickCompendium(a);
    showBrowse = false;
  }

  async function save() {
    error = '';
    const trimmed = name.trim();
    if (!trimmed) { error = $_('diary.activity.errors.name_required'); return; }
    const rawNum = Math.max(0, Number(kcal) || 0);
    const kcalNum = Math.round($energyUnit === 'kJ' ? rawNum / 4.184 : rawNum);
    if (!kcalNum) { error = $_('diary.activity.errors.kcal_required'); return; }
    const dur = durationMin === '' ? null : Math.max(0, Math.round(Number(durationMin) || 0));
    const dist = distance.trim() || null;
    // Source promotes to 'compendium' when a MET is attached; otherwise
    // keeps whatever it was (or defaults to manual_form for new rows).
    const source = met != null ? 'compendium' : (entry?.source || 'manual_form');
    saving = true;
    try {
      if (entry?.id) {
        await updateActivity(entry.id, { name: trimmed, kcal: kcalNum, duration_min: dur, distance: dist, met, is_template: isTemplate ? 1 : 0, source });
      } else {
        await addActivity({ date, name: trimmed, kcal: kcalNum, duration_min: dur, distance: dist, source, met, is_template: isTemplate ? 1 : 0 });
      }
      open = false;
      dispatch('saved');
    } catch (e) {
      error = e?.message || 'Could not save';
    } finally {
      saving = false;
    }
  }

  function onKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { showSuggestions = false; }
  }
</script>

<Sheet bind:open title={titleText} on:close>
  <div class="form" on:keydown={onKeydown}>
    <label class="field field-with-suggest">
      <span class="field-label">{$_('diary.activity.field_name')}</span>
      <div class="name-row">
        <input class="input" type="text" bind:value={name} bind:this={nameInput}
          on:input={onNameInput}
          on:focus={() => { if (q) showSuggestions = true; }}
          on:blur={() => setTimeout(() => showSuggestions = false, 150)}
          placeholder={$_('diary.activity.field_name_placeholder')} maxlength="80"
          autocomplete="off" />
        <button type="button" class="btn-browse" on:click|preventDefault={browseOpen}
          aria-label={$_('diary.activity.browse.aria')} title={$_('diary.activity.browse.tooltip')}>
          <span class="material-symbols-rounded">apps</span>
        </button>
      </div>
      {#if met != null}
        <span class="met-tag">MET {met.toFixed(1)}</span>
      {/if}
      {#if hasSuggestions}
        <div class="suggest">
          {#if templates.length > 0 && !q}
            <div class="suggest-section-label">{$_('diary.activity.suggest.templates')}</div>
            {#each templates as t (t.id)}
              <button type="button" class="suggest-item" on:mousedown|preventDefault={() => pickTemplate(t)}>
                <span class="suggest-name">{t.name}</span>
                {#if t.met != null}<span class="suggest-met">MET {Number(t.met).toFixed(1)}</span>{/if}
                <span class="suggest-badge suggest-badge-template">{$_('diary.activity.suggest.template_badge')}</span>
              </button>
            {/each}
          {/if}
          {#if pastMatches.length > 0}
            <div class="suggest-section-label">{$_('diary.activity.suggest.past_entries')}</div>
            {#each pastMatches as n}
              <button type="button" class="suggest-item" on:mousedown|preventDefault={() => pickPastName(n)}>
                <span class="suggest-name">{n}</span>
              </button>
            {/each}
          {/if}
          {#if compendiumMatches.length > 0}
            <div class="suggest-section-label">{$_('diary.activity.suggest.compendium')}</div>
            {#each compendiumMatches as a (a.id)}
              <button type="button" class="suggest-item" on:mousedown|preventDefault={() => pickCompendium(a)}>
                <span class="suggest-name">{a.name}</span>
                <span class="suggest-met">MET {a.met.toFixed(1)}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </label>

    <div class="row-2">
      <label class="field">
        <span class="field-label">{$_('diary.activity.field_duration')} <span class="hint">{$_('diary.activity.field_optional')}</span></span>
        <input id="activity-duration-input" class="input" type="number" bind:value={durationMin}
          inputmode="numeric" min="0" placeholder={$_('diary.activity.field_duration_placeholder')} />
      </label>
      <label class="field">
        <span class="field-label">{$_('diary.activity.field_distance')} <span class="hint">{$_('diary.activity.field_optional')}</span></span>
        <input class="input" type="text" bind:value={distance} placeholder={`e.g. 10 ${$distUnit || 'mi'}`} maxlength="40" />
      </label>
    </div>

    <label class="field">
      <span class="field-label">{$_('diary.activity.field_kcal')} ({$energyUnit || 'kcal'})</span>
      <input class="input" type="number" bind:value={kcal} on:input={onKcalInput}
        inputmode="numeric" min="0" placeholder={$energyUnit === 'kJ' ? '500' : '120'} />
      {#if previewKcal != null && met != null}
        {@const _wKgRounded = userWeightKg.toFixed(1)}
        {@const _weightDisp = $weightUnit === 'lb'
          ? `${_wKgRounded} kg (${(userWeightKg * 2.20462).toFixed(1)} lb)`
          : `${_wKgRounded} kg`}
        <span class="kcal-hint">
          {$_('diary.activity.kcal_preview', { values: { met: met.toFixed(1), weight_display: _weightDisp, duration: durationMin, kcal: previewKcal } })}
        </span>
      {:else if met != null && userWeightKg == null}
        <span class="kcal-hint kcal-hint-warn">
          {$_('diary.activity.no_weight_hint')}
        </span>
      {/if}
    </label>

    <label class="checkbox-row">
      <input type="checkbox" bind:checked={isTemplate} />
      <span>{$_('diary.activity.save_as_template')} <span class="hint">{$_('diary.activity.save_as_template_hint')}</span></span>
    </label>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button class="btn btn-primary btn-block" on:click={save} disabled={saving}>
        {saving ? $_('diary.activity.saving') : (entry ? $_('diary.activity.save_changes') : $_('diary.activity.add_to_diary'))}
      </button>
    </div>
  </div>
</Sheet>

<ActivityCategoryPicker bind:open={showBrowse} on:pick={onBrowsePicked} />

<style>
  .form { display: flex; flex-direction: column; gap: 12px; padding-bottom: 8px; }
  .field { display: flex; flex-direction: column; gap: 4px; position: relative; }
  .field-with-suggest { position: relative; }
  .field-label { font-size: 13px; color: var(--text-3); font-weight: 500; }
  .hint { font-weight: 400; opacity: 0.7; }
  .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .error { color: var(--danger, #e34); font-size: 13px; }
  .actions { margin-top: 4px; }
  .btn-block { width: 100%; }

  .name-row {
    display: flex;
    align-items: stretch;
    gap: 6px;
  }
  .name-row .input { flex: 1; }
  .btn-browse {
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px;
    border-radius: var(--radius, 10px);
    background: var(--surface-2);
    border: 1px solid var(--surface-3);
    color: var(--text-2);
    cursor: pointer;
  }
  .btn-browse:hover { background: var(--surface-3); }
  .btn-browse .material-symbols-rounded { font-size: 20px; }

  .met-tag {
    display: inline-block;
    align-self: flex-start;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-dim, rgba(99,102,241,0.15));
    color: var(--accent, rgb(99,102,241));
    margin-top: 4px;
  }

  .suggest {
    position: absolute;
    top: 100%;
    left: 0; right: 0;
    background: var(--surface-1);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius, 10px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    z-index: 10;
    margin-top: 4px;
    max-height: 320px;
    overflow-y: auto;
  }
  .suggest-section-label {
    padding: 6px 12px 4px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
    background: var(--surface-2);
  }
  .suggest-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--surface-2);
    color: var(--text-1);
    text-align: left;
    cursor: pointer;
    font-size: 14px;
  }
  .suggest-item:last-child { border-bottom: none; }
  .suggest-item:hover { background: var(--surface-2); }
  .suggest-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .suggest-met {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .suggest-badge {
    font-size: 9px; font-weight: 700; letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 2px 6px; border-radius: 999px;
    flex-shrink: 0;
  }
  .suggest-badge-template {
    background: rgba(251, 146, 60, 0.14);
    color: rgb(234, 128, 42);
  }

  .kcal-hint {
    font-size: 11px;
    color: var(--text-3);
  }
  .kcal-hint-warn { color: var(--warning, #d97706); }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-2);
    cursor: pointer;
  }
  .checkbox-row input[type="checkbox"] {
    width: 16px; height: 16px;
    cursor: pointer;
  }
</style>
