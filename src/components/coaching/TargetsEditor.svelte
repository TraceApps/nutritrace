<script>
  // The coach recommends targets: calories, protein, carbs and fat (grams or
  // percent of calories, the same every day or by weekday), or a calorie
  // goal mode instead of a number, with a note. It starts from the client's
  // targets now, with their adaptive TDEE and weight trend beside it. The
  // client accepts or declines; nothing changes for them before that.
  import { onMount, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { NtApi } from '../../lib/api.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { energyUnit, weightUnit, dateFormat, weekStartDay } from '../../stores/settings.js';
  import { weekdayOrder } from '../../lib/week.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { TARGET_KEYS } from '../../lib/coach-targets.js';
  import { coachingErrorText } from '../../lib/coaching-view.js';
  import WeightTrend from './WeightTrend.svelte';
  import { coachDraft, takeCoachDraft } from '../../stores/coaching.js';
  import TargetsCard from './TargetsCard.svelte';

  export let row;              // { id, client: { id, name } }
  export let weights = [];
  export let recommendations = [];

  const dispatch = createEventDispatcher();
  const LABEL = { calories: 'coaching.targets.calories', proteins: 'coaching.targets.protein', carbohydrates: 'coaching.targets.carbs', fat: 'coaching.targets.fat' };
  // Indexed by weekday (0 Sunday), as targets store their days. Shown from
  // the coach's own first day of the week; each value stays on its weekday (#232).
  const DAYS = Array.from({ length: 7 }, (_, d) => new Date(2026, 9, 11 + d).toLocaleDateString(undefined, { weekday: 'short' }));
  const KJ = 4.184;

  let current = null, loadErr = '', sending = false, note = '', mode = '';
  let ed = {};

  $: kj = $energyUnit === 'kJ';
  const toShown = (key, v) => (v == null ? '' : key === 'calories' && kj ? String(Math.round(v * KJ)) : String(Math.round(v * 10) / 10));
  const toKcal = (key, v) => {
    const n = parseFloat(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return null;
    return key === 'calories' && kj ? Math.round(n / KJ) : n;
  };

  function startFrom(goals) {
    ed = Object.fromEntries(TARGET_KEYS.map(key => {
      const g = goals?.[key];
      const shared = !g || g.sharedGoal !== false;
      return [key, {
        include: false,
        shared,
        isPercent: !!g?.isPercent,
        isMin: !!g?.isMin,
        value: toShown(key, g ? (g.isMin ? g.min : g.max) ?? g.max ?? g.min : null),
        days: Array.from({ length: 7 }, (_, d) => toShown(key, g ? (Array.isArray(g.days) ? g.days[d] : null) ?? g.max ?? g.min : null)),
      }];
    }));
  }

  async function load() {
    loadErr = '';
    try {
      current = await NtApi.get(`/api/coaching/clients/${row.client.id}/targets`);
      startFrom(current.goals);
    } catch (e) { loadErr = coachingErrorText(e, $_); }
  }
  onMount(load);

  // A draft Trace prepared, opened by the coach: the editor starts from it
  // (the coach still reviews and sends).
  let drafted = false;
  // Once this client's targets are here (also when the editor was already open).
  $: if (current && $coachDraft) fromDraft();
  function fromDraft() {
    const d = takeCoachDraft('targets', row.client.id);
    if (!d) return;
    for (const [key, g] of Object.entries(d.payload?.goals || {})) {
      if (!ed[key]) continue;
      const shared = g.sharedGoal !== false;
      ed[key] = { ...ed[key], include: true, shared, isPercent: !!g.isPercent, isMin: !!g.isMin,
        value: toShown(key, g.isMin ? g.min : g.max), days: Array.from({ length: 7 }, (_, i) => toShown(key, Array.isArray(g.days) ? g.days[i] : (g.max ?? g.min))) };
    }
    mode = d.payload?.mode || '';
    note = d.note || '';
    drafted = true;
  }
  function clearDraft() { drafted = false; note = ''; mode = ''; startFrom(current?.goals); }

  // Grams and percent of calories, converted at the calorie target being
  // recommended (else the client's), the way the Goals page converts.
  const DENSITY = { proteins: 4, carbohydrates: 4, fat: 9 };
  function _calFor(day) {
    const c = ed.calories;
    const v = c?.include ? toKcal('calories', c.shared ? c.value : c.days[day]) : null;
    if (v) return v;
    const g = current?.goals?.calories;
    return g ? (g.sharedGoal === false && Array.isArray(g.days) ? g.days[day] : g.max ?? g.min) : null;
  }
  function switchUnit(key, toPercent) {
    const e = ed[key];
    if (e.isPercent === toPercent) return;
    const conv = (v, day) => {
      const n = parseFloat(String(v).replace(',', '.')); const cal = _calFor(day);
      if (!Number.isFinite(n) || !cal) return v;
      return toPercent ? String(Math.round(n * DENSITY[key] / cal * 1000) / 10) : String(Math.round(cal * n / 100 / DENSITY[key]));
    };
    ed[key].value = conv(e.value, new Date().getDay());
    ed[key].days = e.days.map((v, d) => conv(v, d));
    ed[key].isPercent = toPercent;
    touch(key);
  }

  // Touching a target's value includes it.
  function touch(key) { ed[key].include = true; ed = ed; }

  $: payload = (() => {
    const goals = {};
    for (const key of TARGET_KEYS) {
      const e = ed[key];
      if (!e?.include) continue;
      const entry = { sharedGoal: e.shared, isMin: e.isMin, isPercent: key !== 'calories' && e.isPercent };
      if (e.shared) { const v = toKcal(key, e.value); entry[e.isMin ? 'min' : 'max'] = v; }
      else entry.days = e.days.map(v => toKcal(key, v));
      goals[key] = entry;
    }
    return { goals, ...(mode ? { mode } : {}) };
  })();
  $: canSend = !sending && (Object.keys(payload.goals).length > 0 || !!payload.mode);
  $: hasPending = recommendations.some(r => r.kind === 'targets' && r.status === 'pending');

  async function send() {
    if (!canSend) { showError($_('coaching.targets.nothing')); return; }
    sending = true;
    try {
      await NtApi.post(`/api/coaching/clients/${row.client.id}/recommendations`, { kind: 'targets', payload, note: note.trim() || undefined });
      showSuccess($_('coaching.targets.sent', { values: { name: row.client.name } }));
      note = ''; mode = ''; drafted = false;
      startFrom(current?.goals);
      dispatch('sent');
    } catch (e) { showError(coachingErrorText(e, $_)); }
    sending = false;
  }

  const adaptiveText = (a) => {
    if (!a) return null;
    if (!a.ready) return $_('coaching.targets.adaptive_wait', { values: { days: a.days_available ?? 0, required: a.days_required ?? 21 } });
    const e = Nutrition.displayEnergy(Math.round(a.tdee), $energyUnit);
    return $_('coaching.targets.adaptive_value', { values: { value: `${e.value.toLocaleString()} ${e.unit}`, confidence: Math.round((a.confidence || 0) * 100) } });
  };
</script>

{#if loadErr}
  <p class="te-msg">{loadErr}</p>
{:else if !current}
  <p class="te-msg">{$_('coaching.loading')}</p>
{:else}
  <section class="card te">
    <h3>{$_('coaching.targets.editor_title')}</h3>
    <p class="te-intro">{$_('coaching.targets.editor_intro', { values: { name: row.client.name } })}</p>
    {#if drafted}
      <p class="te-drafted" role="status">
        <span class="material-symbols-rounded" aria-hidden="true">auto_awesome</span>
        <span>{$_('coaching.trace.drafted')}</span>
        <button class="btn btn-ghost btn-sm" on:click={clearDraft}>{$_('coaching.trace.dismiss_draft')}</button>
      </p>
    {/if}

    {#each TARGET_KEYS as key (key)}
      {@const e = ed[key]}
      <div class="te-row" class:on={e.include}>
        <div class="te-row-head">
          <label class="te-include">
            <input type="checkbox" bind:checked={ed[key].include} />
            <span>{$_(LABEL[key])}</span>
          </label>
          <div class="te-controls">
            {#if key !== 'calories'}
              <div class="seg-control te-seg" role="group" aria-label={$_('coaching.targets.unit_toggle')} style="--seg-count:2;--seg-active:{e.isPercent ? 1 : 0}">
                <button class="seg-opt" class:seg-active={!e.isPercent} on:click={() => switchUnit(key, false)}>{$_('coaching.targets.grams')}</button>
                <button class="seg-opt" class:seg-active={e.isPercent} on:click={() => switchUnit(key, true)}>{$_('coaching.targets.percent')}</button>
              </div>
            {/if}
            <label class="te-weekday"><input type="checkbox" checked={!e.shared} on:change={(ev) => { ed[key].shared = !ev.target.checked; touch(key); }} /> {$_('coaching.targets.by_weekday')}</label>
          </div>
        </div>
        {#if e.shared}
          <div class="te-value">
            <input class="input" inputmode="decimal" aria-label={$_(LABEL[key])} bind:value={ed[key].value} on:input={() => touch(key)} />
            <span class="te-unit">{key === 'calories' ? (kj ? 'kJ' : 'kcal') : e.isPercent ? '%' : 'g'}</span>
          </div>
        {:else}
          <div class="te-days">
            {#each weekdayOrder($weekStartDay) as i}
              {@const d = DAYS[i]}
              <label class="te-day"><span>{d}</span><input class="input" inputmode="decimal" aria-label="{$_(LABEL[key])} {d}" bind:value={ed[key].days[i]} on:input={() => touch(key)} /></label>
            {/each}
          </div>
        {/if}
      </div>
    {/each}

    <div class="te-row">
      <label class="te-label" for="te-mode">{$_('coaching.targets.mode_label')}</label>
      <select id="te-mode" class="input" bind:value={mode}>
        <option value="">{$_('coaching.targets.mode_keep')}</option>
        <option value="fixed">{$_('coaching.targets.mode_fixed')}</option>
        <option value="dynamic">{$_('coaching.targets.mode_dynamic')}</option>
        <option value="adaptive">{$_('coaching.targets.mode_adaptive')}</option>
      </select>
      {#if mode === 'dynamic' || mode === 'adaptive'}<p class="te-hint">{$_('coaching.targets.mode_note', { values: { name: row.client.name } })}</p>{/if}
    </div>

    <label class="te-label" for="te-note">{$_('coaching.targets.note_label')}</label>
    <textarea id="te-note" class="input te-note" rows="2" maxlength="500" bind:value={note} placeholder={$_('coaching.targets.note_placeholder')}></textarea>
    {#if hasPending}<p class="te-hint">{$_('coaching.targets.pending_replaced_hint')}</p>{/if}
    <button class="btn btn-primary te-send" disabled={!canSend} on:click={send}>{$_('coaching.targets.send')}</button>
  </section>

  <section class="card te te-context">
    <h3>{$_('coaching.targets.context')}</h3>
    <p class="te-ctx-line"><strong>{$_('coaching.targets.mode_label')}:</strong> {$_(`coaching.targets.mode_${current.calorie_mode || 'fixed'}`)}</p>
    {#if current.adaptive}<p class="te-ctx-line"><strong>{$_('coaching.targets.adaptive')}:</strong> {adaptiveText(current.adaptive)}</p>{/if}
    <WeightTrend {weights} unit={$weightUnit === 'lb' ? 'lb' : 'kg'} dateFormat={$dateFormat} />
  </section>

  <section class="te-history">
    <h3>{$_('coaching.targets.history')}</h3>
    {#if recommendations.filter(r => r.kind === 'targets').length === 0}
      <p class="te-msg">{$_('coaching.targets.none_yet')}</p>
    {:else}
      {#each recommendations.filter(r => r.kind === 'targets') as rec (rec.id)}
        <TargetsCard {rec} compact coachView coachName={row.client.name} />
      {/each}
    {/if}
  </section>
{/if}

<style>
  .te-drafted { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; color: var(--text-2); }
  .te-drafted .material-symbols-rounded { color: var(--accent); font-size: 18px; }
  .te { padding: 14px 16px; margin-top: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .te h3, .te-history h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); margin: 0; font-weight: 700; }
  .te-history { margin-top: 16px; }
  .te-intro, .te-hint { margin: 0; color: var(--text-3); font-size: 13px; line-height: 1.45; }
  .te-msg { color: var(--text-3); text-align: center; margin: 16px 0; }
  .te-row { border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .te-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .te-include { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
  .te-row:not(.on) .te-include span { color: var(--text-3); }
  .te-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .te-seg { width: 96px; }
  .te-weekday { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); }
  .te-value { display: flex; align-items: center; gap: 8px; }
  .te-value .input { max-width: 160px; }
  .te-unit { color: var(--text-3); font-size: 13px; }
  .te-days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
  .te-day { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--text-3); text-align: center; }
  .te-day .input { padding: 6px 4px; text-align: center; min-width: 0; }
  .te-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .te-note { font: inherit; resize: vertical; }
  .te-send { width: 100%; }
  .te-ctx-line { margin: 0; font-size: 13px; color: var(--text-2); }
</style>
