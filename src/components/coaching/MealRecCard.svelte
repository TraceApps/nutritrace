<script>
  // A meal or recipe a coach sent (Send to Client): what it is, its
  // ingredients and nutrition. The client accepts (their own copy goes into
  // their Meals or Recipes, made by the server, so it reaches every device)
  // or declines; with no connection the answer waits and the copy follows.
  import { createEventDispatcher } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { energyUnit } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { answerPlan } from '../../lib/coach-recommendations.js';
  import { isNative } from '../../lib/platform.js';

  export let rec;
  export let coachName = '';
  export let compact = false;
  export let coachView = false;

  const dispatch = createEventDispatcher();
  let busy = false, declining = false, declineNote = '';

  $: m = rec.payload?.meal || {};
  $: recipe = rec.kind === 'recipe';
  $: n = m.nutrition || {};
  const energy = (v) => { const e = Nutrition.displayEnergy(Math.round(Number(v) || 0), $energyUnit); return `${e.value.toLocaleString()} ${e.unit}`; };
  const grams = (v) => `${Math.round(Number(v) || 0)} g`;
  const amount = (it) => {
    const a = it.portion != null ? `${Math.round(Number(it.portion) * 10) / 10} ${it.unit || 'g'}` : '';
    return it.quantity && Number(it.quantity) !== 1 ? `${Math.round(Number(it.quantity) * 100) / 100} × ${a}` : a;
  };

  async function answer(kind) {
    if (busy) return;
    busy = true;
    try {
      const r = await answerPlan(rec, kind, { note: kind === 'declined' ? declineNote : '' });
      declining = false; declineNote = '';
      // The copy is made on the server: on Android a sync brings it now.
      if (kind === 'accepted' && !r.offline && !r.refused && isNative) import('../../lib/sync.js').then(s => s.fullSync(true)).catch(() => {});
      if (r.refused) showError($_('coaching.send.refused'));
      else if (kind === 'accepted') showSuccess(r.offline ? $_('coaching.send.accepted_offline', { values: { name: coachName } }) : $_(recipe ? 'coaching.send.accepted_recipe' : 'coaching.send.accepted_meal'));
      else showSuccess($_('coaching.send.declined'));
      dispatch('answered');
    } catch { showError($_('coaching.something_failed')); }
    busy = false;
  }
</script>

<section class="mc card" class:compact aria-label={coachView ? m.name : $_(recipe ? 'coaching.send.card_recipe' : 'coaching.send.card_meal', { values: { name: coachName } })}>
  <div class="mc-head">
    <span class="material-symbols-rounded mc-icon" aria-hidden="true">{recipe ? 'menu_book' : 'lunch_dining'}</span>
    <div class="mc-titles">
      <h3 class="mc-title">{m.name}</h3>
      <div class="mc-sub">{coachView ? $_(recipe ? 'coaching.send.kind_recipe' : 'coaching.send.kind_meal') : $_(recipe ? 'coaching.send.card_recipe' : 'coaching.send.card_meal', { values: { name: coachName } })}</div>
    </div>
  </div>
  {#if rec.note}<blockquote class="mc-note">{rec.note}</blockquote>{/if}
  {#if m.items?.length}
    <ul class="mc-items">
      {#each m.items as it, i (i)}
        <li><span class="mc-name">{it.name}{#if it.brand}<span class="mc-brand">{' · '}{it.brand}</span>{/if}</span><span class="mc-amt">{amount(it)}</span></li>
      {/each}
    </ul>
  {/if}
  <div class="mc-total">
    <span class="mc-total-label">{recipe ? $_('coaching.send.per_serving', { values: { amount: `${Math.round(Number(m.portion) * 10) / 10} ${m.unit || 'g'}` } }) : $_('coaching.send.total')}</span>
    <span class="mc-total-val">{energy(n.calories)}</span>
    <span class="mc-macros">{$_('coaching.macro.protein')} {grams(n.proteins)} · {$_('coaching.macro.carbs')} {grams(n.carbohydrates)} · {$_('coaching.macro.fat')} {grams(n.fat)}</span>
  </div>

  {#if coachView}
    <p class="mc-status">{$_(`coaching.send.status_${rec.status}`)}{#if rec.response_note}{' · '}{$_('coaching.targets.response_note', { values: { note: rec.response_note } })}{/if}</p>
  {:else if rec.status === 'pending'}
    {#if declining}
      <div class="mc-decline" transition:slide={{ duration: 150 }}>
        <label class="mc-label" for="mc-note-{rec.id}">{$_('coaching.targets.decline_note')}</label>
        <textarea id="mc-note-{rec.id}" class="input" rows="2" maxlength="500" bind:value={declineNote}
          placeholder={$_('coaching.targets.decline_note_placeholder', { values: { name: coachName } })}></textarea>
        <div class="mc-actions">
          <button class="btn btn-secondary" disabled={busy} on:click={() => declining = false}>{$_('common.cancel')}</button>
          <button class="btn btn-primary" disabled={busy} on:click={() => answer('declined')}>{$_('coaching.targets.send_decline')}</button>
        </div>
      </div>
    {:else}
      <div class="mc-actions">
        <button class="btn btn-secondary" disabled={busy} on:click={() => declining = true}>{$_('coaching.targets.decline')}</button>
        <button class="btn btn-primary" disabled={busy} on:click={() => answer('accepted')}>{$_('coaching.targets.accept')}</button>
      </div>
    {/if}
  {:else if rec.sync_status === 'pending'}
    <!-- Answered with no connection: it goes (and an accepted copy comes) once back online. -->
    <p class="mc-status">{rec.status === 'accepted' ? $_('coaching.send.copy_waiting', { values: { name: coachName } }) : $_('coaching.targets.answer_waiting', { values: { name: coachName } })}</p>
  {:else}
    <p class="mc-status">{$_(`coaching.send.client_status_${rec.status}`)}</p>
  {/if}
</section>

<style>
  .mc { padding: 14px 16px; margin-top: 12px; border-left: 3px solid var(--accent); min-width: 0; }
  .mc.compact { padding: 12px 14px; }
  .mc-head { display: flex; align-items: center; gap: 10px; }
  .mc-icon { color: var(--accent); font-size: 22px; flex-shrink: 0; }
  .mc-titles { flex: 1; min-width: 0; }
  .mc-title { font-size: 15px; font-weight: 700; margin: 0; overflow-wrap: anywhere; }
  .mc-sub { font-size: 12px; color: var(--text-3); margin-top: 2px; }
  .mc-note { margin: 10px 0 0; padding: 8px 12px; border-left: 3px solid var(--border-strong); background: var(--surface-2); border-radius: var(--radius-sm); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
  .mc-items { list-style: none; margin: 10px 0 0; padding: 0; }
  .mc-items li { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; }
  .mc-name { min-width: 0; overflow-wrap: anywhere; }
  .mc-brand { color: var(--text-3); }
  .mc-amt { color: var(--text-3); white-space: nowrap; }
  .mc-total { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-top: 10px; padding-top: 10px; border-top: 2px solid var(--border-strong); }
  .mc-total-label, .mc-total-val { font-weight: 700; font-size: 14px; }
  .mc-macros { font-size: 12px; color: var(--text-3); flex-basis: 100%; }
  .mc-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 12px; }
  .mc-decline { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .mc-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .mc-decline textarea { font: inherit; resize: vertical; }
  .mc-status { margin: 10px 0 0; font-size: 13px; color: var(--text-3); }
</style>
