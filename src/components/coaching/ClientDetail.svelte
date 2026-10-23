<script>
  // One client, as their coach sees them: Overview (the last 7 days against
  // their targets, and their weight), Diary (their days, read-only), Plans
  // (day plans), Targets and the conversation.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { NtApi } from '../../lib/api.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { energyUnit, weightUnit, dateFormat } from '../../stores/settings.js';
  import { formatDay, localDay, shiftDay, todayLocal, weekday, weightIn, coachingErrorText } from '../../lib/coaching-view.js';
  import WeightTrend from './WeightTrend.svelte';
  import Conversation from './Conversation.svelte';
  import TargetsEditor from './TargetsEditor.svelte';
  import PlanBuilder from './PlanBuilder.svelte';
  import { coachDraft, draftFor } from '../../stores/coaching.js';

  export let row;            // the list row: { id, status, client: { id, name }, ... }
  export let showBack = true;

  const dispatch = createEventDispatcher();
  const DEFAULT_MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const MACROS = [['proteins', 'coaching.macro.protein'], ['carbohydrates', 'coaching.macro.carbs'], ['fat', 'coaching.macro.fat']];

  let tab = 'overview';
  let overview = null, overviewErr = '';
  let day = null, dayErr = '', dayDate = todayLocal(), dayLoading = false;
  let loadedFor = null;

  $: clientId = row?.client?.id;
  $: if (clientId && clientId !== loadedFor) { loadedFor = clientId; tab = 'overview'; dayDate = todayLocal(); day = null; loadOverview(); loadRecs(); }
  // A draft Trace prepared and the coach opened: its tab.
  $: if (draftFor($coachDraft, 'targets', clientId)) tab = 'targets';
  $: if (draftFor($coachDraft, 'day_plan', clientId)) tab = 'plans';

  // What this coach recommended to this client (the Targets tab and the
  // cards in the conversation).
  let recs = [];
  async function loadRecs() {
    const id = clientId;
    try { const r = await NtApi.get(`/api/coaching/clients/${id}/recommendations`); if (id === clientId) recs = r || []; }
    catch { /* offline: the kept copy, if any, came back already */ }
  }
  // Answers arrive on the client's side: look again when these tabs open.
  let _recTab = null;
  $: if ((tab === 'targets' || tab === 'chat' || tab === 'plans') && tab !== _recTab) { _recTab = tab; loadRecs(); }
  $: if (tab !== 'targets' && tab !== 'chat' && tab !== 'plans') _recTab = null;
  $: if (tab === 'diary' && clientId && (!day || day.date !== dayDate || day._for !== clientId)) loadDay();

  async function loadOverview() {
    const id = clientId;
    overview = null; overviewErr = '';
    try {
      const r = await NtApi.get(`/api/coaching/clients/${id}/overview?today=${todayLocal()}`);
      if (id === clientId) overview = r;
    } catch (e) {
      if (id === clientId) overviewErr = coachingErrorText(e, $_);
      // No longer this coach's client: the copies kept for a dead zone go.
      if (!e?.offline && /not found/i.test(String(e?.message))) NtApi.forgetCoachingReads([]).catch(() => {});
    }
  }

  async function loadDay() {
    const id = clientId, date = dayDate;
    if (dayLoading === `${id}:${date}`) return;
    dayLoading = `${id}:${date}`; dayErr = '';
    try {
      const r = await NtApi.get(`/api/coaching/clients/${id}/diary/${date}`);
      if (id === clientId && date === dayDate) day = { ...r, _for: id };
    } catch (e) {
      if (id === clientId && date === dayDate) { day = { date, _for: id, failed: true }; dayErr = coachingErrorText(e, $_); }
    }
    dayLoading = false;
  }

  const energy = (kcal) => { const e = Nutrition.displayEnergy(Math.round(kcal || 0), $energyUnit); return `${e.value.toLocaleString()} ${e.unit}`; };
  const grams = (g) => `${Math.round(g || 0)} g`;
  const pct = (v, t) => (t > 0 ? Math.min(100, Math.round((v / t) * 100)) : 0);

  $: mealNames = Array.isArray(day?.meal_names) && day.meal_names.length ? day.meal_names : DEFAULT_MEALS;
  $: meals = (() => {
    if (!day?.items) return [];
    const by = new Map();
    for (const it of day.items) { const k = Number(it.meal) || 0; if (!by.has(k)) by.set(k, []); by.get(k).push(it); }
    const max = Math.max(mealNames.length - 1, ...by.keys());
    const out = [];
    for (let i = 0; i <= max; i++) {
      const items = by.get(i) || [];
      if (!items.length && i >= mealNames.length) continue;
      out.push({ name: mealNames[i] || $_('coaching.diary.meal_n', { values: { n: i + 1 } }), items, kcal: items.reduce((s, x) => s + (x.calories || 0), 0) });
    }
    return out;
  })();

  function openDay(date) { dayDate = date; tab = 'diary'; }
  $: canNext = dayDate < todayLocal();
  const amount = (it) => [it.quantity && it.quantity !== 1 ? `${it.quantity} ×` : '', it.portion != null ? `${it.portion}${it.unit ? ' ' + it.unit : ''}` : ''].filter(Boolean).join(' ');
</script>

<div class="client-detail">
  <div class="cd-head">
    {#if showBack}
      <button class="btn-icon cd-back" on:click={() => dispatch('back')} aria-label={$_('coaching.clients.back')} title={$_('coaching.clients.back')}>
        <span class="material-symbols-rounded">arrow_back</span>
      </button>
    {/if}
    <div class="cd-title">
      <h2>{row.client.name}</h2>
      {#if overview?.since}<div class="cd-since">{$_('coaching.clients.coaching_since', { values: { date: formatDay(localDay(overview.since), $dateFormat) } })}</div>{/if}
    </div>
    <button class="btn btn-ghost cd-end" on:click={() => dispatch('end', row)}>{$_('coaching.clients.end')}</button>
  </div>

  <div class="cd-tabs" role="tablist">
    <button class="cd-tab" class:active={tab === 'overview'} role="tab" aria-selected={tab === 'overview'} on:click={() => tab = 'overview'}>{$_('coaching.clients.tab_overview')}</button>
    <button class="cd-tab" class:active={tab === 'diary'} role="tab" aria-selected={tab === 'diary'} on:click={() => tab = 'diary'}>{$_('coaching.clients.tab_diary')}</button>
    <button class="cd-tab" class:active={tab === 'plans'} role="tab" aria-selected={tab === 'plans'} on:click={() => tab = 'plans'}>{$_('coaching.clients.tab_plans')}</button>
    <button class="cd-tab" class:active={tab === 'targets'} role="tab" aria-selected={tab === 'targets'} on:click={() => tab = 'targets'}>{$_('coaching.clients.tab_targets')}</button>
    <button class="cd-tab" class:active={tab === 'chat'} role="tab" aria-selected={tab === 'chat'} on:click={() => tab = 'chat'}>
      {$_('coaching.clients.tab_conversation')}{#if row.unread && tab !== 'chat'} <span class="cd-unread" aria-label={$_('coaching.unread', { values: { n: row.unread } })}>{row.unread}</span>{/if}
    </button>
  </div>

  <!-- A new client starts every tab afresh (no editor kept from the last one). -->
  {#key clientId}
  {#if tab === 'chat'}
    <Conversation conv={{ pairingId: row.id, side: 'coach', clientId: row.client.id }} otherName={row.client.name} recommendations={recs} mealNames={overview?.meal_names || DEFAULT_MEALS} />
  {:else if tab === 'plans'}
    <PlanBuilder {row} recommendations={recs} on:sent={loadRecs} />
  {:else if tab === 'targets'}
    <TargetsEditor {row} weights={overview?.weights || []} recommendations={recs} on:sent={loadRecs} />
  {:else if tab === 'overview'}
    {#if overviewErr}
      <p class="cd-msg">{overviewErr}</p>
    {:else if !overview}
      <p class="cd-msg">{$_('coaching.loading')}</p>
    {:else}
      <section class="card cd-card">
        <h3>{$_('coaching.overview.last_7')}</h3>
        <p class="cd-summary">
          {#if overview.week.judged > 0}
            {$_('coaching.overview.on_target', { values: { on: overview.week.on_target, days: overview.week.judged } })} ·
          {:else if overview.week.logged > 0}
            {$_('coaching.overview.no_target_days')} ·
          {/if}
          {$_('coaching.overview.logged', { values: { logged: overview.week.logged } })}
        </p>
        {#if overview.calorie_mode && overview.calorie_mode !== 'fixed'}
          <p class="cd-mode">{$_(overview.calorie_mode === 'adaptive' ? 'coaching.overview.mode_adaptive' : 'coaching.overview.mode_dynamic')}</p>
        {/if}
        <ul class="cd-days">
          {#each [...overview.days].reverse() as d (d.date)}
            <li>
              <button class="cd-day" on:click={() => openDay(d.date)}>
                <span class="cd-day-name">{weekday(d.date)}<span class="cd-day-date">{formatDay(d.date, $dateFormat)}</span></span>
                {#if d.logged}
                  <span class="cd-day-main">
                    <span class="cd-day-kcal"><span class="nw">{energy(d.totals.calories)}</span>{#if d.targets.calories}<span class="cd-of nw">{' / '}{energy(d.targets.calories)}</span>{/if}</span>
                    {#if d.targets.calories}
                      <span class="cd-bar" aria-hidden="true"><span style="width:{pct(d.totals.calories, d.targets.calories)}%"></span></span>
                    {/if}
                    <span class="cd-day-macros">
                      {#each MACROS as [k, label]}
                        <span class="nw">{$_(label)} {grams(d.totals[k])}{#if d.targets[k] != null}{' / '}{grams(d.targets[k])}{/if}</span>
                      {/each}
                    </span>
                  </span>
                  {#if d.on_target != null}
                    <span class="cd-flag" class:on={d.on_target}>
                      <span class="material-symbols-rounded" aria-hidden="true">{d.on_target ? 'check_circle' : 'radio_button_unchecked'}</span>
                      {$_(d.on_target ? 'coaching.overview.day_on' : 'coaching.overview.day_off')}
                    </span>
                  {/if}
                {:else}
                  <span class="cd-day-none">{$_('coaching.overview.not_logged')}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </section>
      <section class="card cd-card">
        <h3>{$_('coaching.overview.weight')}</h3>
        <WeightTrend weights={overview.weights} unit={$weightUnit === 'lb' ? 'lb' : 'kg'} dateFormat={$dateFormat} />
      </section>
    {/if}
  {:else}
    <div class="cd-daynav">
      <button class="btn-icon" on:click={() => dayDate = shiftDay(dayDate, -1)} aria-label={$_('coaching.diary.previous')} title={$_('coaching.diary.previous')}>
        <span class="material-symbols-rounded">chevron_left</span>
      </button>
      <div class="cd-daynav-label">
        <strong>{dayDate === todayLocal() ? $_('coaching.diary.today') : weekday(dayDate)}</strong>
        <span>{formatDay(dayDate, $dateFormat)}</span>
      </div>
      <button class="btn-icon" disabled={!canNext} on:click={() => dayDate = shiftDay(dayDate, 1)} aria-label={$_('coaching.diary.next')} title={$_('coaching.diary.next')}>
        <span class="material-symbols-rounded">chevron_right</span>
      </button>
    </div>
    {#if dayErr}
      <p class="cd-msg">{dayErr}</p>
    {:else if !day || day.date !== dayDate}
      <p class="cd-msg">{$_('coaching.loading')}</p>
    {:else}
      <section class="card cd-card cd-totals">
        <div class="cd-total-row">
          <span>{$_('coaching.diary.calories')}</span>
          <strong>{energy(day.totals.calories)}{#if day.targets.calories}<span class="cd-of">{' / '}{energy(day.targets.calories)}</span>{/if}</strong>
        </div>
        {#each MACROS as [k, label]}
          <div class="cd-total-row">
            <span>{$_(label)}</span>
            <span>{grams(day.totals[k])}{#if day.targets[k] != null}<span class="cd-of">{' / '}{grams(day.targets[k])}</span>{/if}</span>
          </div>
        {/each}
        {#if day.water_ml}
          <div class="cd-total-row"><span>{$_('coaching.diary.water')}</span><span>{Math.round(day.water_ml)} ml</span></div>
        {/if}
        {#if day.weight_kg != null}
          <div class="cd-total-row"><span>{$_('coaching.diary.weight')}</span><span>{weightIn(day.weight_kg, $weightUnit === 'lb' ? 'lb' : 'kg')} {$weightUnit === 'lb' ? 'lb' : 'kg'}</span></div>
        {/if}
      </section>
      {#if day.items.length === 0}
        <p class="cd-msg">{$_('coaching.diary.empty')}</p>
      {/if}
      {#each meals as m}
        {#if m.items.length}
          <section class="card cd-card cd-meal">
            <div class="cd-meal-head"><h3>{m.name}</h3><span>{energy(m.kcal)}</span></div>
            <ul class="cd-items">
              {#each m.items as it}
                <li>
                  <div class="cd-item-name">{it.name}{#if it.brand}<span class="cd-item-brand">{' · '}{it.brand}</span>{/if}</div>
                  <div class="cd-item-sub">{amount(it)}{amount(it) ? ' · ' : ''}{energy(it.calories)}</div>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      {/each}
      {#if day.notes}
        <section class="card cd-card">
          <h3>{$_('coaching.diary.notes')}</h3>
          <p class="cd-notes">{day.notes}</p>
        </section>
      {/if}
    {/if}
  {/if}
  {/key}
</div>

<style>
  .client-detail { min-width: 0; }
  .cd-head { display: flex; align-items: center; gap: 10px; }
  .cd-back { flex-shrink: 0; }
  .cd-title { flex: 1; min-width: 0; }
  .cd-title h2 { font-size: 19px; margin: 0; overflow-wrap: anywhere; }
  .cd-since { font-size: 13px; color: var(--text-3); }
  .cd-end { color: var(--danger); flex-shrink: 0; }
  .cd-tabs { display: flex; border-bottom: 1px solid var(--border); margin-top: 12px; overflow-x: auto; scrollbar-width: none; }
  .cd-tabs::-webkit-scrollbar { display: none; }
  .cd-tab {
    flex: 1 0 auto; padding: 10px 8px; font: inherit; font-size: 14px; font-weight: 600; white-space: nowrap;
    background: none; border: none; cursor: pointer; color: var(--text-3);
    border-bottom: 2px solid transparent;
  }
  .cd-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .cd-unread { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: var(--radius-full); background: var(--accent); color: var(--accent-text, #fff); font-size: 11px; font-weight: 700; }
  .cd-msg { color: var(--text-3); text-align: center; margin: 24px 0; }
  .card.cd-card { padding: 14px 16px; margin-top: 12px; }
  .cd-card h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); margin: 0 0 8px; font-weight: 700; }
  .cd-summary { margin: 0 0 4px; font-size: 14px; color: var(--text-1); }
  .cd-mode { margin: 0 0 4px; font-size: 12px; color: var(--text-3); }
  .cd-days { list-style: none; margin: 8px 0 0; padding: 0; }
  .cd-day {
    width: 100%; display: grid; grid-template-columns: 88px minmax(0, 1fr) auto; gap: 10px; align-items: center;
    padding: 10px 0; background: none; border: none; border-top: 1px solid var(--border);
    font: inherit; color: inherit; text-align: left; cursor: pointer;
  }
  .cd-days li:first-child .cd-day { border-top: none; }
  .cd-day-name { display: flex; flex-direction: column; font-weight: 600; font-size: 14px; }
  .cd-day-date { font-weight: 400; font-size: 12px; color: var(--text-3); }
  .cd-day-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .cd-day-kcal { font-size: 14px; font-weight: 600; }
  .cd-of { color: var(--text-3); font-weight: 400; }
  .nw { white-space: nowrap; }
  .cd-bar { display: block; height: 4px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
  .cd-bar span { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
  .cd-day-macros { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 12px; color: var(--text-3); }
  .cd-day-none { color: var(--text-3); font-size: 13px; grid-column: span 2; }
  .cd-flag { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-3); white-space: nowrap; }
  .cd-flag .material-symbols-rounded { font-size: 16px; }
  .cd-flag.on .material-symbols-rounded { color: var(--accent); }
  .cd-daynav { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
  .cd-daynav-label { display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .cd-daynav-label span { font-size: 12px; color: var(--text-3); }
  .cd-total-row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 14px; }
  .cd-meal-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .cd-meal-head span { font-size: 13px; color: var(--text-3); }
  .cd-items { list-style: none; margin: 0; padding: 0; }
  .cd-items li { padding: 8px 0; border-top: 1px solid var(--border); }
  .cd-items li:first-child { border-top: none; }
  .cd-item-name { font-size: 14px; overflow-wrap: anywhere; }
  .cd-item-brand { color: var(--text-3); }
  .cd-item-sub { font-size: 12px; color: var(--text-3); margin-top: 2px; }
  .cd-notes { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
