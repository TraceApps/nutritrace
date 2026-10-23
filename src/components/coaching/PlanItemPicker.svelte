<script>
  // Adding to a day plan's meal: from the client's foods, meals and recipes,
  // the coach's own, or Open Food Facts (through the server, and its local
  // mirror when it has one). Every pick becomes a copy in the plan; a meal
  // adds its ingredients, as the Diary does.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { NtApi, API } from '../../lib/api.js';
  import { Nutrition } from '../../lib/nutrition.js';
  import { energyUnit } from '../../stores/settings.js';
  import { planItemFrom, planItemsFromMeal, cleanPlanPayload } from '../../lib/coach-plans.js';
  import { showError } from '../../stores/toast.js';
  import { coachingErrorText } from '../../lib/coaching-view.js';

  export let open = false;
  export let clientId;
  export let clientName = '';
  export let mealName = '';

  const dispatch = createEventDispatcher();
  let source = 'client', kind = 'foods', query = '';
  let clientCat = null, mine = null, err = '', loading = false;
  let offQuery = '', offResults = null, offBusy = false;
  let _for = null;

  $: if (clientId !== _for) { _for = clientId; clientCat = null; }
  $: if (open && source === 'client' && !clientCat && !loading) loadClient();
  $: if (open && source === 'mine' && !mine && !loading) loadMine();

  async function loadClient() {
    loading = true; err = '';
    try { clientCat = await NtApi.get(`/api/coaching/clients/${clientId}/catalog`); }
    catch (e) { err = coachingErrorText(e, $_); }
    loading = false;
  }
  async function loadMine() {
    loading = true; err = '';
    try {
      const [foods, meals, recipes] = await Promise.all([NtApi.getFoods(), NtApi.getMeals(), NtApi.getRecipes()]);
      mine = { foods: foods || [], meals: (meals || []).filter(m => !m.is_recipe), recipes: recipes || [] };
    } catch (e) { err = coachingErrorText(e, $_); }
    loading = false;
  }
  async function searchOff() {
    const q = offQuery.trim();
    if (!q || offBusy) return;
    offBusy = true; err = '';
    // Open Food Facts needs the network: say so rather than "Nothing found".
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { err = $_('coaching.needs_connection'); offBusy = false; return; }
    try { offResults = await API.searchByName(q, 1); }
    catch (e) { err = coachingErrorText(e, $_); offResults = []; }
    offBusy = false;
  }

  $: cat = source === 'client' ? clientCat : source === 'mine' ? mine : null;
  $: needle = query.trim().toLowerCase();
  $: list = (cat?.[kind] || []).filter(x => !needle || `${x.name} ${x.brand || ''}`.toLowerCase().includes(needle)).slice(0, 200);

  const energy = (v) => { const e = Nutrition.displayEnergy(Math.round(Number(v) || 0), $energyUnit); return `${e.value.toLocaleString()} ${e.unit}`; };
  const sub = (x) => (kind === 'meals'
    ? $_('coaching.plans.meal_items', { values: { count: (x.items || []).length } })
    : `${Math.round((Number(x.portion) || 100) * 10) / 10} ${x.unit || 'g'} · ${energy(x.nutrition?.calories)}`);

  function pick(x) {
    const whose = source === 'client' ? 'client' : 'coach';
    let items;
    if (source === 'off') items = [planItemFrom(x, 'off')];
    else if (kind === 'meals') items = planItemsFromMeal(x, whose);
    else items = [planItemFrom(x, `${whose}_${kind === 'recipes' ? 'recipe' : 'food'}`)];
    // Only what a plan can carry: an Open Food Facts product needs its
    // barcode, a food its id on the server (one made on a phone and not
    // synced yet has none).
    if (!items.length || cleanPlanPayload({ meals: [{ meal: 0, items }] }).error) { showError($_('coaching.plans.cant_add', { values: { name: x.name } })); return; }
    dispatch('pick', { items, name: x.name });
    open = false;
  }
</script>

<Sheet bind:open title={$_('coaching.plans.picker_title', { values: { meal: mealName } })} height="80vh">
  <div class="pp">
    <div class="pp-tabs" role="tablist">
      <button class="pp-tab" class:active={source === 'client'} role="tab" aria-selected={source === 'client'} on:click={() => source = 'client'}>{$_('coaching.plans.source_client', { values: { name: clientName } })}</button>
      <button class="pp-tab" class:active={source === 'mine'} role="tab" aria-selected={source === 'mine'} on:click={() => source = 'mine'}>{$_('coaching.plans.source_mine')}</button>
      <button class="pp-tab" class:active={source === 'off'} role="tab" aria-selected={source === 'off'} on:click={() => source = 'off'}>{$_('coaching.plans.source_off')}</button>
    </div>

    {#if source === 'off'}
      <form class="pp-search" on:submit|preventDefault={searchOff}>
        <input class="input" type="search" bind:value={offQuery} placeholder={$_('coaching.plans.search_off')} aria-label={$_('coaching.plans.search_off')} />
        <button class="btn btn-primary" type="submit" disabled={offBusy || !offQuery.trim()}>{$_('coaching.plans.search')}</button>
      </form>
      {#if err}<p class="pp-msg">{err}</p>
      {:else if offBusy}<p class="pp-msg">{$_('coaching.loading')}</p>
      {:else if offResults && !offResults.length}<p class="pp-msg">{$_('coaching.plans.no_results')}</p>
      {:else if offResults}
        <ul class="pp-list">
          {#each offResults.slice(0, 50) as x, i (x.barcode || i)}
            <li><button class="pp-row" on:click={() => pick(x)}>
              <span class="pp-name">{x.name}{#if x.brand}<span class="pp-brand">{' · '}{x.brand}</span>{/if}</span>
              <span class="pp-sub">{Math.round((Number(x.portion) || 100) * 10) / 10} {x.unit || 'g'} · {energy(x.nutrition?.calories)}</span>
            </button></li>
          {/each}
        </ul>
      {/if}
    {:else}
      <div class="pp-kinds" role="tablist">
        {#each ['foods', 'meals', 'recipes'] as k}
          <button class="pp-kind" class:active={kind === k} role="tab" aria-selected={kind === k} on:click={() => kind = k}>{$_(`coaching.plans.kind_${k}`)}</button>
        {/each}
      </div>
      <input class="input pp-filter" type="search" bind:value={query} placeholder={$_('coaching.plans.search')} aria-label={$_('coaching.plans.search')} />
      {#if err}<p class="pp-msg">{err}</p>
      {:else if !cat}<p class="pp-msg">{$_('coaching.loading')}</p>
      {:else if !list.length}<p class="pp-msg">{$_('coaching.plans.no_results')}</p>
      {:else}
        <ul class="pp-list">
          {#each list as x (x.id)}
            <li><button class="pp-row" on:click={() => pick(x)}>
              <span class="pp-name">{x.name}{#if x.brand}<span class="pp-brand">{' · '}{x.brand}</span>{/if}</span>
              <span class="pp-sub">{sub(x)}</span>
            </button></li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</Sheet>

<style>
  .pp { display: flex; flex-direction: column; gap: 10px; padding-top: 4px; min-width: 0; }
  .pp-tabs { display: flex; border-bottom: 1px solid var(--border); }
  .pp-tab { flex: 1; padding: 10px 4px; font: inherit; font-size: 14px; font-weight: 600; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-3); cursor: pointer; min-width: 0; overflow-wrap: anywhere; }
  .pp-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .pp-kinds { display: flex; gap: 6px; flex-wrap: wrap; }
  .pp-kind { padding: 6px 12px; border-radius: var(--radius-full); border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); font: inherit; font-size: 13px; cursor: pointer; }
  .pp-kind.active { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .pp-search { display: flex; gap: 8px; }
  .pp-search .input { flex: 1; min-width: 0; }
  .pp-list { list-style: none; margin: 0; padding: 0; }
  .pp-row { width: 100%; display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 10px 2px; background: none; border: none; border-top: 1px solid var(--border); font: inherit; color: inherit; cursor: pointer; }
  .pp-list li:first-child .pp-row { border-top: none; }
  .pp-row:hover .pp-name { color: var(--accent); }
  .pp-name { font-size: 14px; overflow-wrap: anywhere; }
  .pp-brand { color: var(--text-3); }
  .pp-sub { font-size: 12px; color: var(--text-3); }
  .pp-msg { color: var(--text-3); text-align: center; margin: 16px 0; }
</style>
