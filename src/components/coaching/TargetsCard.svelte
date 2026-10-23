<script>
  // A coach's recommended targets, as the client sees them: now,
  // recommended and the change for each target, then Accept or Decline.
  // Accepted: "Applied" with Undo (the template saved first). Shown on
  // Goals, once on the Diary, and in the conversation.
  import { createEventDispatcher } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { goals, calorieGoalMode, calorieGoalFactor, energyUnit, dateFormat, goalTemplates, weekStartDay } from '../../stores/settings.js';
  import { inWeekOrder } from '../../lib/week.js';
  import { NtApi } from '../../lib/api.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { comparisonRows, acceptSwitchesToFixed } from '../../lib/coach-targets.js';
  import { acceptTargets, declineTargets, undoTargets, templateFor, isUndone } from '../../lib/coach-recommendations.js';
  import { formatDay, localDay, todayLocal } from '../../lib/coaching-view.js';

  export let rec;
  export let coachName = '';
  export let compact = false;
  /** The coach's own copy in the conversation: no answers, just what it is. */
  export let coachView = false;
  export let dismissible = false;

  const dispatch = createEventDispatcher();
  const LABEL = { calories: 'coaching.targets.calories', proteins: 'coaching.targets.protein', carbohydrates: 'coaching.targets.carbs', fat: 'coaching.targets.fat' };
  const MODE = { fixed: 'coaching.targets.mode_fixed', dynamic: 'coaching.targets.mode_dynamic', adaptive: 'coaching.targets.mode_adaptive' };

  let busy = false, declining = false, declineNote = '', showDays = false;

  $: tpl = ($goalTemplates, templateFor(rec));
  // What "now" means: today's goals while pending; what they were before
  // Accept once it's applied.
  $: base = coachView ? {} : rec.status === 'accepted' && tpl ? tpl.goals : $goals;
  // With Dynamic or Adaptive, "now" for calories is today's effective goal
  // (what the Diary shows), labeled with the mode.
  $: effectiveMode = !coachView && rec.status === 'pending' && ($calorieGoalMode === 'dynamic' || $calorieGoalMode === 'adaptive') ? $calorieGoalMode : null;
  let effectiveRaw = null, _effectiveFor = '';
  $: _loadEffective(effectiveMode);
  async function _loadEffective(mode) {
    const key = mode ? `${mode}:${todayLocal()}` : '';
    if (key === _effectiveFor) return;
    _effectiveFor = key; effectiveRaw = null;
    if (!mode) return;
    try {
      const r = mode === 'dynamic'
        ? (await NtApi.get(`/api/wellness/calories-out?date=${todayLocal()}`))?.calories_out
        : await NtApi.get('/api/goals/adaptive-tdee').then(a => (a?.ready ? a.tdee : null));
      if (_effectiveFor === key) effectiveRaw = r ?? null;
    } catch { /* the stored goal is shown */ }
  }
  $: caloriesNow = effectiveMode && effectiveRaw != null ? Math.round(effectiveRaw * ($calorieGoalFactor || 1)) : null;
  $: rows = comparisonRows(base, rec.payload, undefined, { caloriesNow });
  $: switches = rec.status === 'pending' && !coachView && acceptSwitchesToFixed($calorieGoalMode, rec.payload);
  // Undo is offered wherever Accept changed the goals (also when the server
  // later refused it and they weren't put back automatically).
  $: undone = !!tpl && isUndone(rec, $goals, $calorieGoalMode);

  const energy = (v) => { if (v == null) return null; const e = Nutrition.displayEnergy(Math.round(v), $energyUnit); return `${e.value.toLocaleString()} ${e.unit}`; };
  const fmt = (row, v) => (v == null ? $_('coaching.targets.not_set') : row.key === 'calories' ? energy(v) : `${Math.round(v)} g`);
  const diff = (row) => {
    if (row.diff == null || row.diff === 0) return row.diff === 0 ? '0' : '';
    const sign = row.diff > 0 ? '+' : '';
    if (row.key === 'calories') { const e = Nutrition.displayEnergy(Math.round(row.diff), $energyUnit); return `${sign}${e.value.toLocaleString()} ${e.unit}`; }
    return `${sign}${Math.round(row.diff)} g`;
  };
  // Indexed by weekday (0 Sunday), like the day values; shown from the
  // viewer's first day of the week (#232).
  const DAYS = Array.from({ length: 7 }, (_, d) => new Date(2026, 9, 11 + d).toLocaleDateString(undefined, { weekday: 'short' }));

  async function accept() {
    if (busy) return;
    busy = true;
    try {
      const r = await acceptTargets(rec, { t: $_, date: formatDay(todayLocal(), $dateFormat) });
      if (r.refused) showError($_('coaching.targets.refused'));
      else if (r.applied) showSuccess(r.offline ? $_('coaching.targets.accepted_offline', { values: { name: coachName } }) : $_('coaching.targets.accepted'));
      dispatch('answered');
    } catch { showError($_('coaching.something_failed')); }
    busy = false;
  }
  async function decline() {
    if (busy) return;
    busy = true;
    try {
      await declineTargets(rec, { note: declineNote });
      declining = false; declineNote = '';
      showSuccess($_('coaching.targets.declined'));
      dispatch('answered');
    } catch { showError($_('coaching.something_failed')); }
    busy = false;
  }
  function undo() {
    if (undoTargets(rec)) { showSuccess($_('coaching.targets.undone')); dispatch('answered'); }
  }
</script>

<section class="tc card" class:compact aria-label={$_('coaching.targets.card_title', { values: { name: coachName } })}>
  <div class="tc-head">
    <span class="material-symbols-rounded tc-icon" aria-hidden="true">flag</span>
    <h3 class="tc-title">{coachView ? $_('coaching.targets.card_title_coach') : $_('coaching.targets.card_title', { values: { name: coachName } })}</h3>
    {#if dismissible}
      <button class="btn-icon tc-dismiss" on:click={() => dispatch('dismiss')} aria-label={$_('coaching.targets.dismiss')} title={$_('coaching.targets.dismiss')}>
        <span class="material-symbols-rounded">close</span>
      </button>
    {/if}
  </div>
  {#if rec.note}<blockquote class="tc-note">{rec.note}</blockquote>{/if}

  {#if rows.length}
    <table class="tc-table">
      <thead>
        <tr>
          <th scope="col">{$_('coaching.targets.target')}</th>
          {#if !coachView}<th scope="col">{$_('coaching.targets.now')}</th>{/if}
          <th scope="col">{$_('coaching.targets.recommended')}</th>
          {#if !coachView}<th scope="col">{$_('coaching.targets.change')}</th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.key)}
          <tr>
            <th scope="row">{$_(LABEL[row.key])}</th>
            {#if !coachView}
              <td>{fmt(row, row.current)}{#if row.key === 'calories' && caloriesNow != null && row.current != null}<span class="tc-sub">{$_('coaching.targets.now_effective', { values: { mode: $_(MODE[effectiveMode]) } })}</span>{/if}{#if row.currentPercent != null}<span class="tc-sub">{$_('coaching.targets.percent_of', { values: { pct: row.currentPercent } })}</span>{/if}</td>
            {/if}
            <td class="tc-new">{fmt(row, row.proposed)}{#if row.proposedPercent != null}<span class="tc-sub">{$_('coaching.targets.percent_of', { values: { pct: row.proposedPercent } })}</span>{/if}</td>
            {#if !coachView}<td class="tc-diff">{diff(row)}</td>{/if}
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.some(r => r.byWeekday)}
      <button class="tc-days-toggle" on:click={() => showDays = !showDays} aria-expanded={showDays}>
        <span class="material-symbols-rounded" aria-hidden="true">{showDays ? 'expand_less' : 'expand_more'}</span>
        {$_('coaching.targets.by_weekday')}
      </button>
      <span class="tc-sub">{$_('coaching.targets.varies')}</span>
      {#if showDays}
        <div class="tc-days" transition:slide={{ duration: 150 }}>
          <table class="tc-table tc-week">
            <thead><tr><th></th>{#each inWeekOrder(DAYS, $weekStartDay) as d}<th scope="col">{d}</th>{/each}</tr></thead>
            <tbody>
              {#each rows.filter(r => r.byWeekday) as row (row.key)}
                {#if !coachView && row.currentDays}
                  <tr class="tc-old"><th scope="row">{$_(LABEL[row.key])} · {$_('coaching.targets.now')}</th>{#each inWeekOrder(row.currentDays, $weekStartDay) as v}<td>{v == null ? '' : row.key === 'calories' ? Math.round(Nutrition.displayEnergy(v, $energyUnit).value) : Math.round(v)}</td>{/each}</tr>
                {/if}
                <tr><th scope="row">{$_(LABEL[row.key])}</th>{#each inWeekOrder(row.proposedDays, $weekStartDay) as v}<td>{v == null ? '' : row.key === 'calories' ? Math.round(Nutrition.displayEnergy(v, $energyUnit).value) : Math.round(v)}</td>{/each}</tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  {/if}

  {#if rec.payload?.mode}
    <p class="tc-mode">{$_('coaching.targets.mode_recommended', { values: { mode: $_(MODE[rec.payload.mode]) } })}</p>
  {:else if switches}
    <p class="tc-mode tc-warn">
      <span class="material-symbols-rounded" aria-hidden="true">info</span>
      {$_('coaching.targets.mode_switch', { values: { mode: $_(MODE[$calorieGoalMode] || MODE.fixed) } })}
    </p>
  {/if}

  {#if coachView}
    <p class="tc-status">{$_(`coaching.targets.status_${rec.status}`)}{#if rec.response_note} · {$_('coaching.targets.response_note', { values: { note: rec.response_note } })}{/if}</p>
  {:else if rec.status === 'pending'}
    {#if declining}
      <div class="tc-decline" transition:slide={{ duration: 150 }}>
        <label class="tc-label" for="tc-note-{rec.id}">{$_('coaching.targets.decline_note')}</label>
        <textarea id="tc-note-{rec.id}" class="input" rows="2" maxlength="500" bind:value={declineNote}
          placeholder={$_('coaching.targets.decline_note_placeholder', { values: { name: coachName } })}></textarea>
        <div class="tc-actions">
          <button class="btn btn-secondary" disabled={busy} on:click={() => declining = false}>{$_('common.cancel')}</button>
          <button class="btn btn-primary" disabled={busy} on:click={decline}>{$_('coaching.targets.send_decline')}</button>
        </div>
      </div>
    {:else}
      <div class="tc-actions">
        <button class="btn btn-secondary" disabled={busy} on:click={() => declining = true}>{$_('coaching.targets.decline')}</button>
        <button class="btn btn-primary" disabled={busy} on:click={accept}>{$_('coaching.targets.accept')}</button>
      </div>
    {/if}
  {:else if rec.status === 'accepted'}
    <div class="tc-applied">
      <span class="tc-status">
        <span class="material-symbols-rounded" aria-hidden="true">check_circle</span>
        {undone ? $_('coaching.targets.undone_label') : $_('coaching.targets.applied', { values: { date: formatDay(localDay(rec.responded_at) || todayLocal(), $dateFormat) } })}
      </span>
      {#if tpl && !undone}<button class="btn btn-ghost" on:click={undo}>{$_('coaching.targets.undo')}</button>{/if}
    </div>
  {:else}
    <p class="tc-status">{$_(`coaching.targets.status_${rec.status}`)}</p>
    {#if tpl && !undone}
      <div class="tc-applied">
        <span class="tc-status">{$_('coaching.targets.still_applied')}</span>
        <button class="btn btn-ghost" on:click={undo}>{$_('coaching.targets.undo')}</button>
      </div>
    {/if}
  {/if}
  {#if !coachView && rec.sync_status === 'pending'}
    <p class="tc-status">{$_('coaching.targets.answer_waiting', { values: { name: coachName } })}</p>
  {/if}
</section>

<style>
  .tc { padding: 14px 16px; margin-top: 12px; border-left: 3px solid var(--accent); min-width: 0; }
  .tc.compact { padding: 12px 14px; }
  .tc-head { display: flex; align-items: center; gap: 10px; }
  .tc-icon { color: var(--accent); font-size: 22px; flex-shrink: 0; }
  .tc-title { font-size: 15px; font-weight: 700; margin: 0; flex: 1; min-width: 0; }
  .tc-dismiss { flex-shrink: 0; width: 32px; height: 32px; }
  .tc-note { margin: 10px 0 0; padding: 8px 12px; border-left: 3px solid var(--border-strong); background: var(--surface-2); border-radius: var(--radius-sm); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
  .tc-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
  .tc-table th, .tc-table td { text-align: left; padding: 6px 6px 6px 0; border-top: 1px solid var(--border); vertical-align: top; }
  .tc-table thead th { border-top: none; color: var(--text-3); font-weight: 600; font-size: 12px; }
  .tc-table tbody th { font-weight: 600; }
  .tc-new { font-weight: 700; }
  .tc-diff { color: var(--text-2); white-space: nowrap; }
  .tc-sub { display: block; font-size: 11px; color: var(--text-3); font-weight: 400; }
  .tc-days-toggle { display: inline-flex; align-items: center; gap: 4px; background: none; border: none; color: var(--accent); font: inherit; font-size: 13px; font-weight: 600; padding: 8px 0 0; cursor: pointer; white-space: nowrap; }
  .tc-days { overflow-x: auto; }
  .tc-week th, .tc-week td { text-align: center; padding: 4px; }
  .tc-week tbody th { text-align: left; white-space: nowrap; }
  .tc-old td, .tc-old th { color: var(--text-3); }
  .tc-mode { margin: 10px 0 0; font-size: 13px; color: var(--text-2); display: flex; gap: 6px; align-items: flex-start; }
  .tc-warn .material-symbols-rounded { font-size: 18px; color: var(--warning); }
  .tc-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 12px; }
  .tc-decline { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .tc-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .tc-decline textarea { font: inherit; resize: vertical; }
  .tc-applied { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
  .tc-status { margin: 10px 0 0; font-size: 13px; color: var(--text-3); display: inline-flex; align-items: center; gap: 6px; }
  .tc-applied .tc-status { margin: 0; color: var(--text-2); }
  .tc-applied .material-symbols-rounded { color: var(--accent); font-size: 18px; }
</style>
