<script>
  // The coach's day plan builder: one plan per date, in the client's own
  // meal names, with the day's totals against the client's targets. Items
  // come from the client's catalog, the coach's own or Open Food Facts, each
  // a copy. Send, or Copy to Other Days (the same plan for each day chosen).
  // Below, what was sent and where each plan stands (Accepted, Declined,
  // Expired, and which meals the client logged).
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { NtApi } from '../../lib/api.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { energyUnit, dateFormat } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { decimalInput, parseDecimal } from '../../lib/decimal-input.js';
  import { cleanPlanPayload, planTotals, mealTotals, itemTotals, shownStatus } from '../../lib/coach-plans.js';
  import { formatDay, shiftDay, todayLocal, today, weekday, coachingErrorText } from '../../lib/coaching-view.js';
  import Sheet from '../ui/Sheet.svelte';
  import PlanItemPicker from './PlanItemPicker.svelte';
  import PlanCard from './PlanCard.svelte';
  import { coachDraft, takeCoachDraft } from '../../stores/coaching.js';

  export let row;                  // { id, client: { id, name } }
  export let recommendations = [];

  const dispatch = createEventDispatcher();
  const DEFAULT_MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const MACROS = [['proteins', 'coaching.macro.protein'], ['carbohydrates', 'coaching.macro.carbs'], ['fat', 'coaching.macro.fat']];

  let date = todayLocal();
  let day = null, dayErr = '';
  let draft = {};          // meal slot -> items
  let note = '';
  let draftFor = null;     // `${client}:${date}:${plan id}` the draft started from
  let busy = false;
  let pickerOpen = false, pickerSlot = 0;
  let copyOpen = false, copyDays = new Set();

  $: clientId = row?.client?.id;
  $: name = row?.client?.name || '';
  $: plans = (recommendations || []).filter(r => r.kind === 'day_plan');
  // The plan for this date (one per date): the newest still standing.
  $: current = plans.find(r => r.date === date && r.status !== 'replaced' && r.status !== 'withdrawn') || null;
  $: if (clientId && (!day || day._for !== `${clientId}:${date}`)) loadDay(clientId, date);
  $: _startFrom(clientId, date, current);

  // A draft Trace prepared, opened by the coach: its date, meals and note
  // (the coach still reviews and sends).
  let drafted = false, _draftAt = null;   // `${client}:${date}` the Trace draft is for
  $: if ($coachDraft && clientId) _takeDraft();
  function _takeDraft() {
    const t = takeCoachDraft('day_plan', clientId);
    if (!t) return;
    date = t.date;
    draft = {};
    for (const m of t.payload?.meals || []) draft[m.meal] = m.items.map(it => ({ ...it }));
    note = t.note || '';
    drafted = true;
    _draftAt = `${clientId}:${t.date}`;
  }

  function _startFrom(cid, d, plan) {
    const key = `${cid}:${d}:${plan?.id ?? '-'}`;
    if (key === draftFor) return;
    draftFor = key;
    // The draft stays while its day is shown, also when that day's plans
    // load after it (the coach replaces that plan by sending).
    if (drafted && _draftAt === `${cid}:${d}`) return;
    draft = {};
    drafted = false; _draftAt = null;
    for (const m of plan?.payload?.meals || []) draft[m.meal] = m.items.map(it => ({ ...it }));
    note = plan?.note || '';
  }
  function clearDraft() { draftFor = null; drafted = false; _draftAt = null; _startFrom(clientId, date, current); }

  async function loadDay(cid, d) {
    const key = `${cid}:${d}`;
    dayErr = '';
    try {
      const r = await NtApi.get(`/api/coaching/clients/${cid}/diary/${d}`);
      if (key === `${clientId}:${date}`) day = { ...r, _for: key };
    } catch (e) {
      if (key === `${clientId}:${date}`) { day = { _for: key, targets: {}, meal_names: null }; dayErr = coachingErrorText(e, $_); }
    }
  }

  $: mealNames = Array.isArray(day?.meal_names) && day.meal_names.length ? day.meal_names : DEFAULT_MEALS;
  $: slots = [...new Set([...mealNames.map((_, i) => i), ...Object.keys(draft).map(Number)])].sort((a, b) => a - b);
  $: mealName = (slot) => mealNames[slot] || $_('coaching.diary.meal_n', { values: { n: slot + 1 } });
  $: payload = { meals: slots.filter(s => draft[s]?.length).map(s => ({ meal: s, items: draft[s] })) };
  $: total = planTotals(payload);
  $: count = payload.meals.reduce((n, m) => n + m.items.length, 0);
  $: past = date < $today;
  $: targets = day?.targets || {};

  const energy = (v) => { const e = Nutrition.displayEnergy(Math.round(v || 0), $energyUnit); return `${e.value.toLocaleString()} ${e.unit}`; };
  const grams = (v) => `${Math.round(v || 0)} g`;
  const pct = (v, t) => (t > 0 ? Math.min(100, Math.round((v / t) * 100)) : 0);
  const amount = (it) => `${Math.round(it.portion * 10) / 10} ${it.unit || 'g'}`;

  function addTo(slot) { pickerSlot = slot; pickerOpen = true; }
  function onPick(e) {
    draft = { ...draft, [pickerSlot]: [...(draft[pickerSlot] || []), ...e.detail.items] };
    showSuccess($_('coaching.plans.added', { values: { name: e.detail.name } }));
  }
  function remove(slot, i) {
    const items = [...(draft[slot] || [])];
    items.splice(i, 1);
    draft = { ...draft, [slot]: items };
  }
  function setServings(slot, i, v) {
    const q = parseDecimal(v);
    if (!(q > 0 && q <= 100)) return;
    const items = [...(draft[slot] || [])];
    items[i] = { ...items[i], quantity: q };
    draft = { ...draft, [slot]: items };
  }

  async function send(dates) {
    if (busy) return;
    // Items are checked as they're added; this is the last look.
    if (cleanPlanPayload(payload).error) { showError($_('coaching.plans.cant_send')); return; }
    busy = true;
    try {
      const made = await NtApi.post(`/api/coaching/clients/${clientId}/recommendations`, { kind: 'day_plan', dates, payload, note: note.trim() || undefined });
      const n = Array.isArray(made) ? made.length : 1;
      showSuccess(n > 1 ? $_('coaching.plans.sent_days', { values: { name, count: n } }) : $_('coaching.plans.sent', { values: { name } }));
      copyOpen = false;
      drafted = false; _draftAt = null;
      dispatch('sent');
    } catch (e) { showError(coachingErrorText(e, $_)); }
    busy = false;
  }

  // Copy to Other Days: this day and the two weeks after it, to choose from.
  $: copyChoices = Array.from({ length: 15 }, (_, i) => shiftDay(date, i)).filter(d => d >= $today);
  function openCopy() { copyDays = new Set(past ? [] : [date]); copyOpen = true; }
  function toggleDay(d) { const s = new Set(copyDays); s.has(d) ? s.delete(d) : s.add(d); copyDays = s; }

  $: history = plans.filter(r => r.status !== 'replaced').slice(0, 30);
</script>

<div class="pb">
  <p class="pb-intro">{$_('coaching.plans.intro', { values: { name } })}</p>
  {#if drafted}
    <p class="pb-drafted" role="status">
      <span class="material-symbols-rounded" aria-hidden="true">auto_awesome</span>
      <span>{$_('coaching.trace.drafted')}</span>
      <button class="btn btn-ghost btn-sm" on:click={clearDraft}>{$_('coaching.trace.dismiss_draft')}</button>
    </p>
  {/if}

  <div class="pb-daynav">
    <button class="btn-icon" on:click={() => date = shiftDay(date, -1)} aria-label={$_('coaching.diary.previous')} title={$_('coaching.diary.previous')}>
      <span class="material-symbols-rounded">chevron_left</span>
    </button>
    <div class="pb-daynav-label">
      <strong>{date === $today ? $_('coaching.diary.today') : weekday(date)}</strong>
      <span>{formatDay(date, $dateFormat)}</span>
    </div>
    <button class="btn-icon" on:click={() => date = shiftDay(date, 1)} aria-label={$_('coaching.diary.next')} title={$_('coaching.diary.next')}>
      <span class="material-symbols-rounded">chevron_right</span>
    </button>
  </div>

  {#if current}
    <PlanCard rec={current} compact coachView {mealNames} />
  {/if}
  {#if dayErr}<p class="pb-msg">{dayErr}</p>{/if}

  {#each slots as slot (slot)}
    <section class="card pb-meal">
      <div class="pb-meal-head">
        <h3>{mealName(slot)}</h3>
        <span>{energy(mealTotals({ items: draft[slot] || [] }).calories)}</span>
      </div>
      {#if draft[slot]?.length}
        <ul class="pb-items">
          {#each draft[slot] as it, i (i)}
            <li class="pb-item">
              <div class="pb-item-main">
                <span class="pb-item-name">{it.name}{#if it.brand}<span class="pb-brand">{' · '}{it.brand}</span>{/if}</span>
                <span class="pb-item-sub">{amount(it)} · {energy(itemTotals(it).calories)}</span>
              </div>
              <input class="input pb-qty" type="text" inputmode="decimal" use:decimalInput value={it.quantity}
                aria-label={$_('coaching.plans.servings', { values: { name: it.name } })} title={$_('coaching.plans.servings', { values: { name: it.name } })}
                on:change={(e) => setServings(slot, i, e.currentTarget.value)} />
              <button class="btn-icon pb-remove" on:click={() => remove(slot, i)} aria-label={$_('coaching.plans.remove_item', { values: { name: it.name } })} title={$_('coaching.plans.remove_item', { values: { name: it.name } })}>
                <span class="material-symbols-rounded">close</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="pb-empty">{$_('coaching.plans.empty_meal')}</p>
      {/if}
      <button class="btn btn-ghost pb-add" on:click={() => addTo(slot)}>
        <span class="material-symbols-rounded" aria-hidden="true">add</span>{$_('coaching.plans.add_item')}
      </button>
    </section>
  {/each}

  <section class="card pb-totals">
    <h3>{$_('coaching.plans.targets', { values: { name } })}</h3>
    <div class="pb-total-row">
      <span>{$_('coaching.diary.calories')}</span>
      <strong>{#if targets.calories}{$_('coaching.plans.of_target', { values: { value: energy(total.calories), target: energy(targets.calories) } })}{:else}{energy(total.calories)}{/if}</strong>
    </div>
    {#if targets.calories}<span class="pb-bar" aria-hidden="true"><span style="width:{pct(total.calories, targets.calories)}%"></span></span>{/if}
    {#each MACROS as [k, label]}
      <div class="pb-total-row">
        <span>{$_(label)}</span>
        <span>{#if targets[k] != null}{$_('coaching.plans.of_target', { values: { value: grams(total[k]), target: grams(targets[k]) } })}{:else}{grams(total[k])}{/if}</span>
      </div>
    {/each}
  </section>

  <label class="pb-label" for="pb-note">{$_('coaching.targets.note_label')}</label>
  <textarea id="pb-note" class="input" rows="2" maxlength="500" bind:value={note} placeholder={$_('coaching.plans.note_placeholder')}></textarea>
  {#if past}
    <p class="pb-hint">{$_('coaching.plans.past_day')}</p>
  {:else if current?.status === 'pending'}
    <p class="pb-hint">{$_('coaching.plans.replaces')}</p>
  {:else if current?.status === 'accepted'}
    <p class="pb-hint">{$_('coaching.plans.replaces_accepted', { values: { name } })}</p>
  {/if}
  <div class="pb-actions">
    <button class="btn btn-secondary" disabled={busy || !count} on:click={openCopy}>{$_('coaching.plans.copy')}</button>
    <button class="btn btn-primary" disabled={busy || !count || past} on:click={() => send([date])}>{$_('coaching.plans.send')}</button>
  </div>

  <section class="pb-history">
    <h3>{$_('coaching.plans.history')}</h3>
    {#if !history.length}
      <p class="pb-empty">{$_('coaching.plans.none_yet')}</p>
    {:else}
      <ul>
        {#each history as r (r.id)}
          <li>
            <button class="pb-hrow" class:active={r.date === date} on:click={() => date = r.date}>
              <span class="pb-hdate">{weekday(r.date)} {formatDay(r.date, $dateFormat)}</span>
              <span class="pb-hstatus">{$_(`coaching.plans.status_${shownStatus(r, $today)}`)}{#if r.status === 'accepted' && r.logged_meals?.length}{' · '}{$_('coaching.plans.logged_meals', { values: { meals: r.logged_meals.map(s => mealNames[s] || $_('coaching.diary.meal_n', { values: { n: s + 1 } })).join(', ') } })}{/if}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<PlanItemPicker bind:open={pickerOpen} {clientId} clientName={name} mealName={mealName(pickerSlot)} on:pick={onPick} />

<Sheet bind:open={copyOpen} title={$_('coaching.plans.copy')}>
  <div class="pb-copy">
    <p class="pb-hint">{$_('coaching.plans.copy_intro')}</p>
    <div class="pb-days">
      {#each copyChoices as d (d)}
        <button class="pb-day" class:active={copyDays.has(d)} aria-pressed={copyDays.has(d)} on:click={() => toggleDay(d)}>
          <span>{weekday(d)}</span><span class="pb-day-date">{formatDay(d, $dateFormat)}</span>
        </button>
      {/each}
    </div>
    <button class="btn btn-primary" disabled={busy || !copyDays.size} on:click={() => send([...copyDays])}>{$_('coaching.plans.copy_send', { values: { count: copyDays.size } })}</button>
  </div>
</Sheet>

<style>
  .pb { min-width: 0; }
  .pb-intro { margin: 12px 0 0; font-size: 13px; color: var(--text-3); }
  .pb-drafted { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; padding: 8px 12px; border-radius: var(--radius-md); background: var(--surface-2); font-size: 13px; color: var(--text-2); }
  .pb-drafted .material-symbols-rounded { color: var(--accent); font-size: 18px; }
  .pb-daynav { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
  .pb-daynav-label { display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .pb-daynav-label span { font-size: 12px; color: var(--text-3); }
  .pb-msg { color: var(--text-3); text-align: center; margin: 16px 0; }
  .card.pb-meal, .card.pb-totals { padding: 12px 14px; margin-top: 12px; }
  .pb-meal-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .pb-meal-head h3, .pb-totals h3, .pb-history h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-3); margin: 0; font-weight: 700; }
  .pb-meal-head span { font-size: 13px; color: var(--text-3); }
  .pb-items { list-style: none; margin: 6px 0 0; padding: 0; }
  .pb-item { display: grid; grid-template-columns: minmax(0, 1fr) 64px 36px; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--border); }
  .pb-item-main { display: flex; flex-direction: column; min-width: 0; }
  .pb-item-name { font-size: 14px; overflow-wrap: anywhere; }
  .pb-brand { color: var(--text-3); }
  .pb-item-sub { font-size: 12px; color: var(--text-3); }
  .pb-qty { text-align: center; padding: 6px; font-size: 14px; min-width: 0; }
  .pb-remove { width: 36px; height: 36px; }
  .pb-empty { margin: 6px 0 0; font-size: 13px; color: var(--text-3); }
  .pb-add { margin-top: 6px; padding-left: 0; display: inline-flex; align-items: center; gap: 4px; }
  .pb-total-row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 14px; flex-wrap: wrap; }
  .pb-totals h3 { margin-bottom: 6px; }
  .pb-bar { display: block; height: 4px; border-radius: 4px; background: var(--surface-3); overflow: hidden; margin: 2px 0 6px; }
  .pb-bar span { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
  .pb-label { display: block; margin-top: 14px; font-size: 13px; font-weight: 600; color: var(--text-2); }
  .pb textarea { width: 100%; margin-top: 6px; font: inherit; resize: vertical; }
  .pb-hint { margin: 8px 0 0; font-size: 12px; color: var(--text-3); }
  .pb-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 12px; }
  .pb-history { margin-top: 20px; }
  .pb-history ul { list-style: none; margin: 8px 0 0; padding: 0; }
  .pb-hrow { width: 100%; display: flex; justify-content: space-between; gap: 10px; padding: 10px 0; background: none; border: none; border-top: 1px solid var(--border); font: inherit; color: inherit; text-align: left; cursor: pointer; flex-wrap: wrap; }
  .pb-hrow.active .pb-hdate { color: var(--accent); }
  .pb-hdate { font-size: 14px; font-weight: 600; }
  .pb-hstatus { font-size: 13px; color: var(--text-3); }
  .pb-copy { display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
  .pb-days { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
  .pb-day { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 4px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); font: inherit; font-size: 13px; cursor: pointer; }
  .pb-day.active { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .pb-day-date { font-size: 11px; color: var(--text-3); }
</style>
