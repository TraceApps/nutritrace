<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { addActivity, updateActivity } from '../../stores/activity.js';

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
  // Reset fields only on the false→true open transition; otherwise typing
  // in the inputs triggers a reactive cycle that wipes the user's edits.
  let _wasOpen = false;
  $: {
    if (open && !_wasOpen) {
      name        = entry?.name        ?? '';
      kcal        = entry?.kcal        != null ? String(entry.kcal) : '';
      durationMin = entry?.duration_min != null ? String(entry.duration_min) : '';
      distance    = entry?.distance    ?? '';
      error       = '';
    }
    _wasOpen = open;
  }

  $: titleText = entry ? $_('diary.activity.title_edit') : $_('diary.activity.title_add');

  async function save() {
    error = '';
    const trimmed = name.trim();
    if (!trimmed) { error = $_('diary.activity.errors.name_required'); return; }
    const kcalNum = Math.max(0, Math.round(Number(kcal) || 0));
    if (!kcalNum) { error = $_('diary.activity.errors.kcal_required'); return; }
    const dur = durationMin === '' ? null : Math.max(0, Math.round(Number(durationMin) || 0));
    const dist = distance.trim() || null;
    saving = true;
    try {
      if (entry?.id) {
        await updateActivity(entry.id, { name: trimmed, kcal: kcalNum, duration_min: dur, distance: dist });
      } else {
        await addActivity({ date, name: trimmed, kcal: kcalNum, duration_min: dur, distance: dist, source: 'manual_form' });
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
  }
</script>

<Sheet bind:open title={titleText} on:close>
  <div class="form" on:keydown={onKeydown}>
    <label class="field">
      <span class="field-label">{$_('diary.activity.field_name')}</span>
      <input class="input" type="text" bind:value={name} placeholder={$_('diary.activity.field_name_placeholder')} maxlength="80" />
    </label>

    <label class="field">
      <span class="field-label">{$_('diary.activity.field_kcal')}</span>
      <input class="input" type="number" bind:value={kcal} inputmode="numeric" min="0" placeholder={$_('diary.activity.field_kcal_placeholder')} />
    </label>

    <div class="row-2">
      <label class="field">
        <span class="field-label">{$_('diary.activity.field_duration')} <span class="hint">{$_('diary.activity.field_optional')}</span></span>
        <input class="input" type="number" bind:value={durationMin} inputmode="numeric" min="0" placeholder={$_('diary.activity.field_duration_placeholder')} />
      </label>
      <label class="field">
        <span class="field-label">{$_('diary.activity.field_distance')} <span class="hint">{$_('diary.activity.field_optional')}</span></span>
        <input class="input" type="text" bind:value={distance} placeholder={$_('diary.activity.field_distance_placeholder')} maxlength="40" />
      </label>
    </div>

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

<style>
  .form { display: flex; flex-direction: column; gap: 12px; padding-bottom: 8px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-label { font-size: 13px; color: var(--text-3); font-weight: 500; }
  .hint { font-weight: 400; opacity: 0.7; }
  .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .error { color: var(--danger, #e34); font-size: 13px; }
  .actions { margin-top: 4px; }
  .btn-block { width: 100%; }
</style>
