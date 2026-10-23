<script>
  // A coach's day plan: its meals (in the client's own meal names), items
  // and totals. The client accepts or declines; once accepted, on the Diary
  // day it is for, each meal has Log This (Logged once its items are in the
  // Diary; deleting them brings Log This back) and Log All, and tapping an
  // item opens the usual add sheet filled in. Elsewhere (the Coach tab, the
  // conversation) it says where it stands and opens that Diary day.
  import { createEventDispatcher } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
  import { energyUnit, dateFormat, mealNames as myMealNames } from '../../stores/settings.js';
  import { currentDate } from '../../stores/diary.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { planTotals, mealTotals, itemTotals, shownStatus, itemKey } from '../../lib/coach-plans.js';
  import { answerPlan } from '../../lib/coach-recommendations.js';
  import { formatDay, today } from '../../lib/coaching-view.js';

  export let rec;
  export let coachName = '';
  export let compact = false;
  /** The coach's own copy: no answers, what it is and which meals were logged. */
  export let coachView = false;
  /** The client's meal names (the coach passes theirs; the client has their own). */
  export let mealNames = null;
  /** On the Diary day: the items logged ("<meal>.<n>" keys; null while the day loads), and logging. */
  export let diary = false;
  export let logged = null;

  const dispatch = createEventDispatcher();
  let busy = false, declining = false, declineNote = '', logging = null;

  $: names = (Array.isArray(mealNames) && mealNames.length ? mealNames : $myMealNames) || [];
  $: mealName = (slot) => names[slot] || $_('coaching.diary.meal_n', { values: { n: slot + 1 } });
  $: status = shownStatus(rec, $today);
  $: meals = rec.payload?.meals || [];
  $: total = planTotals(rec.payload);
  // Meals with every item logged: on the Diary from the day's items; for
  // the coach, as the server worked it out.
  $: loggedSet = coachView ? new Set(rec.logged_meals || [])
    : new Set(meals.filter(m => m.items.every((_, i) => logged?.has(itemKey(m.meal, i)))).map(m => m.meal));
  $: unlogged = meals.filter(m => !loggedSet.has(m.meal));

  const energy = (v) => { const e = Nutrition.displayEnergy(Math.round(v || 0), $energyUnit); return `${e.value.toLocaleString()} ${e.unit}`; };
  const grams = (v) => `${Math.round(v || 0)} g`;
  const amount = (it) => {
    const a = `${Math.round(it.portion * 10) / 10} ${it.unit || 'g'}`;
    return it.quantity && it.quantity !== 1 ? $_('coaching.plans.item_amount', { values: { n: Math.round(it.quantity * 100) / 100, amount: a } }) : a;
  };

  async function answer(kind) {
    if (busy) return;
    busy = true;
    try {
      const r = await answerPlan(rec, kind, { note: kind === 'declined' ? declineNote : '' });
      declining = false; declineNote = '';
      if (r.refused) showError($_('coaching.plans.refused'));
      else if (kind === 'accepted') showSuccess(r.offline ? $_('coaching.plans.accepted_offline', { values: { name: coachName } }) : $_('coaching.plans.accepted'));
      else showSuccess($_('coaching.plans.declined'));
      dispatch('answered');
    } catch { showError($_('coaching.something_failed')); }
    busy = false;
  }

  async function logMeal(slot) {
    if (logging != null) return;
    logging = slot;
    try {
      const { logPlanMeal } = await import('../../lib/coach-plan-log.js');
      await logPlanMeal(rec, slot, logged);
      showSuccess($_('coaching.plans.logged_meal', { values: { meal: mealName(slot) } }));
    } catch { showError($_('coaching.plans.log_failed')); }
    logging = null;
  }
  async function logAll() {
    if (logging != null) return;
    logging = 'all';
    try {
      const { logPlanAll } = await import('../../lib/coach-plan-log.js');
      await logPlanAll(rec, logged);
      showSuccess($_('coaching.plans.logged_all'));
    } catch { showError($_('coaching.plans.log_failed')); }
    logging = null;
  }
  async function openItem(slot, i, item) {
    const { openPlanItem } = await import('../../lib/coach-plan-log.js');
    openPlanItem(rec, slot, i, item).catch(() => showError($_('coaching.plans.log_failed')));
  }
  function openDiary() {
    currentDate.set(rec.date);
    push('/');
  }

  $: canLog = diary && !!logged && !coachView && rec.status === 'accepted';
</script>

<section class="pc card" class:compact aria-label={coachView ? $_('coaching.plans.card_title_coach') : $_('coaching.plans.card_title', { values: { name: coachName } })}>
  <div class="pc-head">
    <span class="material-symbols-rounded pc-icon" aria-hidden="true">restaurant_menu</span>
    <div class="pc-titles">
      <h3 class="pc-title">{coachView ? $_('coaching.plans.card_title_coach') : $_('coaching.plans.card_title', { values: { name: coachName } })}</h3>
      <div class="pc-date">{$_('coaching.plans.for_day', { values: { date: formatDay(rec.date, $dateFormat) } })}</div>
    </div>
  </div>
  {#if rec.note}<blockquote class="pc-note">{rec.note}</blockquote>{/if}

  {#each meals as m (m.meal)}
    <div class="pc-meal">
      <div class="pc-meal-head">
        <span class="pc-meal-name">{mealName(m.meal)}</span>
        <span class="pc-meal-kcal">{energy(mealTotals(m).calories)}</span>
        {#if canLog}
          {#if loggedSet.has(m.meal)}
            <span class="pc-logged"><span class="material-symbols-rounded" aria-hidden="true">check_circle</span>{$_('coaching.plans.logged')}</span>
          {:else}
            <button class="btn btn-secondary pc-log" disabled={logging != null} on:click={() => logMeal(m.meal)}>{$_('coaching.plans.log_this')}</button>
          {/if}
        {:else if (coachView || !diary) && rec.status === 'accepted' && loggedSet.has(m.meal)}
          <span class="pc-logged"><span class="material-symbols-rounded" aria-hidden="true">check_circle</span>{$_('coaching.plans.logged')}</span>
        {/if}
      </div>
      <ul class="pc-items">
        {#each m.items as it, i (i)}
          <li>
            {#if canLog && logged?.has(itemKey(m.meal, i))}
              <div class="pc-item pc-item-done">
                <span class="pc-item-name"><span class="material-symbols-rounded pc-check" aria-label={$_('coaching.plans.logged')}>check</span>{it.name}{#if it.brand}<span class="pc-brand">{' · '}{it.brand}</span>{/if}</span>
                <span class="pc-item-amt">{amount(it)}</span>
                <span class="pc-item-kcal">{energy(itemTotals(it).calories)}</span>
              </div>
            {:else if canLog}
              <button class="pc-item pc-item-btn" on:click={() => openItem(m.meal, i, it)}>
                <span class="pc-item-name">{it.name}{#if it.brand}<span class="pc-brand">{' · '}{it.brand}</span>{/if}</span>
                <span class="pc-item-amt">{amount(it)}</span>
                <span class="pc-item-kcal">{energy(itemTotals(it).calories)}</span>
              </button>
            {:else}
              <div class="pc-item">
                <span class="pc-item-name">{it.name}{#if it.brand}<span class="pc-brand">{' · '}{it.brand}</span>{/if}</span>
                <span class="pc-item-amt">{amount(it)}</span>
                <span class="pc-item-kcal">{energy(itemTotals(it).calories)}</span>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/each}

  <div class="pc-total">
    <span class="pc-total-label">{$_('coaching.plans.day_total')}</span>
    <span class="pc-total-val">{energy(total.calories)}</span>
    <span class="pc-macros">
      {$_('coaching.macro.protein')} {grams(total.proteins)} · {$_('coaching.macro.carbs')} {grams(total.carbohydrates)} · {$_('coaching.macro.fat')} {grams(total.fat)}
    </span>
  </div>

  {#if coachView}
    <p class="pc-status">
      {$_(`coaching.plans.status_${status}`)}{#if rec.response_note}{' · '}{$_('coaching.targets.response_note', { values: { note: rec.response_note } })}{/if}
    </p>
    {#if rec.status === 'accepted'}
      <p class="pc-status">{loggedSet.size ? $_('coaching.plans.logged_meals', { values: { meals: meals.filter(m => loggedSet.has(m.meal)).map(m => mealName(m.meal)).join(', ') } }) : $_('coaching.plans.logged_none')}</p>
    {/if}
  {:else if status === 'pending'}
    {#if declining}
      <div class="pc-decline" transition:slide={{ duration: 150 }}>
        <label class="pc-label" for="pc-note-{rec.id}">{$_('coaching.targets.decline_note')}</label>
        <textarea id="pc-note-{rec.id}" class="input" rows="2" maxlength="500" bind:value={declineNote}
          placeholder={$_('coaching.targets.decline_note_placeholder', { values: { name: coachName } })}></textarea>
        <div class="pc-actions">
          <button class="btn btn-secondary" disabled={busy} on:click={() => declining = false}>{$_('common.cancel')}</button>
          <button class="btn btn-primary" disabled={busy} on:click={() => answer('declined')}>{$_('coaching.targets.send_decline')}</button>
        </div>
      </div>
    {:else}
      <div class="pc-actions">
        <button class="btn btn-secondary" disabled={busy} on:click={() => declining = true}>{$_('coaching.plans.decline')}</button>
        <button class="btn btn-primary" disabled={busy} on:click={() => answer('accepted')}>{$_('coaching.plans.accept')}</button>
      </div>
    {/if}
  {:else if canLog}
    {#if unlogged.length}
      <p class="pc-hint">{$_('coaching.plans.tap_hint')}</p>
      {#if meals.length > 1}
        <button class="btn btn-primary pc-log-all" disabled={logging != null} on:click={logAll}>{$_('coaching.plans.log_all')}</button>
      {/if}
    {/if}
  {:else}
    <div class="pc-foot">
      <p class="pc-status">{$_(`coaching.plans.status_${status}`)}</p>
      {#if !diary && rec.status === 'accepted'}
        <button class="btn btn-ghost" on:click={openDiary}>{$_('coaching.plans.open_diary')}</button>
      {/if}
    </div>
  {/if}
  {#if !coachView && rec.sync_status === 'pending'}
    <p class="pc-status">{$_('coaching.targets.answer_waiting', { values: { name: coachName } })}</p>
  {/if}
</section>

<style>
  .pc { padding: 14px 16px; margin-top: 12px; border-left: 3px solid var(--accent); min-width: 0; }
  .pc.compact { padding: 12px 14px; }
  .pc-head { display: flex; align-items: center; gap: 10px; }
  .pc-icon { color: var(--accent); font-size: 22px; flex-shrink: 0; }
  .pc-titles { flex: 1; min-width: 0; }
  .pc-title { font-size: 15px; font-weight: 700; margin: 0; }
  .pc-date { font-size: 12px; color: var(--text-3); margin-top: 2px; }
  .pc-note { margin: 10px 0 0; padding: 8px 12px; border-left: 3px solid var(--border-strong); background: var(--surface-2); border-radius: var(--radius-sm); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
  .pc-meal { margin-top: 12px; }
  .pc-meal-head { display: flex; align-items: center; gap: 8px; min-height: 32px; }
  .pc-meal-name { font-weight: 700; font-size: 14px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .pc-meal-kcal { font-size: 13px; color: var(--text-2); white-space: nowrap; }
  .pc-log { padding: 6px 12px; min-height: 32px; font-size: 13px; flex-shrink: 0; }
  .pc-logged { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--accent); font-weight: 600; flex-shrink: 0; }
  .pc-logged .material-symbols-rounded { font-size: 18px; }
  .pc-items { list-style: none; margin: 4px 0 0; padding: 0; }
  .pc-item { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 4px 10px; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; width: 100%; text-align: left; }
  .pc-item-btn { background: none; border-left: none; border-right: none; border-bottom: none; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  .pc-item-btn:hover .pc-item-name { color: var(--accent); }
  .pc-item-name { min-width: 0; overflow-wrap: anywhere; }
  .pc-brand { color: var(--text-3); }
  .pc-check { font-size: 16px; color: var(--accent); vertical-align: -3px; margin-right: 4px; }
  .pc-item-done .pc-item-name { color: var(--text-2); }
  .pc-item-amt { color: var(--text-3); white-space: nowrap; }
  .pc-item-kcal { color: var(--text-2); white-space: nowrap; }
  .pc-total { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-top: 12px; padding-top: 10px; border-top: 2px solid var(--border-strong); }
  .pc-total-label { font-weight: 700; font-size: 14px; }
  .pc-total-val { font-weight: 700; font-size: 14px; }
  .pc-macros { font-size: 12px; color: var(--text-3); flex-basis: 100%; }
  .pc-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 12px; }
  .pc-decline { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .pc-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .pc-decline textarea { font: inherit; resize: vertical; }
  .pc-hint { margin: 10px 0 0; font-size: 12px; color: var(--text-3); }
  .pc-log-all { width: 100%; margin-top: 10px; }
  .pc-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .pc-status { margin: 10px 0 0; font-size: 13px; color: var(--text-3); }
  .pc-foot .btn { margin-top: 10px; }
</style>
