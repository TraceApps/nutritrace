<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import Sheet from '../components/ui/Sheet.svelte';
  import DateInput from '../components/ui/DateInput.svelte';
  import { NtApi } from '../lib/api.js';
  import { localDateStr } from '../lib/db.js';
  import { displayExerciseWeight, tagExerciseWeight } from '../lib/exercise-weight.js';
  import { parsePeople, normalizePerson, pickLogPerson } from '../lib/exercise-people.js';
  import { currentDate } from '../stores/diary.js';
  import { exerciseMuscles, catName as _catName, catDisplay as _catDisplay, bannerStyle, weightUnit } from '../stores/settings.js';
  import { showSuccess, showError } from '../stores/toast.js';

  let list = [];
  let loading = true;
  let loadError = false;
  let search = '';
  let muscleFilter = '';

  $: filtered = list.filter(ex => {
    if (muscleFilter && ex.muscle !== muscleFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (ex.name || '').toLowerCase().includes(q)
      || (ex.muscle || '').toLowerCase().includes(q)
      || (ex.notes || '').toLowerCase().includes(q)
      || parsePeople(ex.people).some(p => p.toLowerCase().includes(q));
  });

  $: muscles = $exerciseMuscles || [];

  async function load() {
    loading = true;
    loadError = false;
    try {
      list = await NtApi.getExercises() || [];
    } catch (e) {
      loadError = true;
      list = [];
    } finally {
      loading = false;
    }
  }

  function openEditor(ex) {
    push(ex?.id ? `/exercises/edit/${ex.id}` : '/exercises/edit');
  }

  function lastWeightLabel(ex) {
    const w = displayExerciseWeight({
      weight: ex.last_weight,
      weight_unit: ex.last_weight_unit,
    }, $weightUnit);
    if (w == null) return '';
    return `${w} ${$weightUnit || 'kg'}`;
  }

  function lastMeta(ex) {
    const parts = [];
    if (ex.last_person) parts.push(ex.last_person);
    const w = lastWeightLabel(ex);
    if (w) parts.push(w);
    if (ex.last_difficulty) parts.push(`${ex.last_difficulty}/5`);
    return parts.join(' · ');
  }

  // ── Quick log sheet ────────────────────────────────────────────────────
  let logOpen = false;
  let logEx = null;
  let logDate = '';
  let logWeight = '';
  let logDifficulty = 0;
  let logSaving = false;

  let logPerson = '';

  function openLog(ex) {
    logEx = ex;
    logDate = $currentDate || localDateStr();
    const people = parsePeople(ex.people);
    logPerson = pickLogPerson(people);
    const w = displayExerciseWeight({
      weight: ex.last_weight,
      weight_unit: ex.last_weight_unit,
    }, $weightUnit);
    logWeight = w != null ? String(w) : '';
    logDifficulty = ex.last_difficulty || 0;
    logOpen = true;
  }

  async function saveLog() {
    if (!logEx) return;
    const people = parsePeople(logEx.people);
    if (people.length && !normalizePerson(logPerson)) {
      showError($_('exercises.person_required'));
      return;
    }
    const tagged = tagExerciseWeight(logWeight, $weightUnit);
    if (tagged.weight == null && !logDifficulty) {
      showError($_('exercises.log_required'));
      return;
    }
    logSaving = true;
    try {
      await NtApi.upsertExerciseLog(logEx.id, logDate, {
        person: normalizePerson(logPerson),
        weight: tagged.weight,
        weight_unit: tagged.weight_unit,
        difficulty: logDifficulty || null,
      });
      showSuccess($_('exercises.log_saved'));
      logOpen = false;
      await load();
    } catch (e) {
      showError(e.message || $_('common.errors.save_failed'));
    } finally {
      logSaving = false;
    }
  }

  onMount(load);
</script>

<div class="page-shell">
  <header class="page-header"
    class:banner-gradient={$bannerStyle === 'gradient'}
    class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.exercises.title')}</h1>
    <button class="btn-icon accent" on:click={() => openEditor(null)}
      aria-label={$_('exercises.add_new')} title={$_('exercises.add_new')}>
      <span class="material-symbols-rounded">add</span>
    </button>
  </header>

  <div class="ex-search">
    <span class="material-symbols-rounded ex-search-icon">search</span>
    <input class="ex-search-input" type="search"
      placeholder={$_('exercises.search_placeholder')}
      bind:value={search} />
  </div>

  {#if muscles.length > 0}
    <div class="cat-filter-row">
      <button class="cat-chip" class:active={!muscleFilter}
        on:click={() => muscleFilter = ''}>{$_('exercises.all_muscles')}</button>
      {#each muscles as m}
        <button class="cat-chip" class:active={muscleFilter === _catName(m)}
          on:click={() => muscleFilter = muscleFilter === _catName(m) ? '' : _catName(m)}>
          {_catDisplay(m)}
        </button>
      {/each}
    </div>
  {/if}

  {#if loadError}
    <div class="server-error-banner">
      <span class="material-symbols-rounded">cloud_off</span>
      <span>{$_('exercises.cant_reach')}
        <button class="server-error-retry" on:click={load}>{$_('sync.retry')}</button>
      </span>
    </div>
  {/if}

  <div class="page-content">
    {#if loading}
      <div class="empty-state">
        <span class="material-symbols-rounded spin">refresh</span>
      </div>
    {:else if filtered.length === 0}
      <div class="empty-state">
        <span class="material-symbols-rounded empty-icon">fitness_center</span>
        <p>{search || muscleFilter ? $_('exercises.empty_filtered') : $_('exercises.empty')}</p>
        {#if !search && !muscleFilter}
          <p class="empty-hint">{$_('exercises.empty_hint')}</p>
          <button class="btn btn-primary" on:click={() => openEditor(null)}>{$_('exercises.add_new')}</button>
        {/if}
      </div>
    {:else}
      <ul class="ex-list">
        {#each filtered as ex (ex.id)}
          <li class="ex-item card" in:fade={{ duration: 140 }}>
            <button class="ex-item-btn" on:click={() => openEditor(ex)}>
              {#if ex.imgUrl}
                <img class="ex-thumb" src={ex.imgUrl} alt="" loading="lazy" referrerpolicy="no-referrer"
                  on:error={e => e.target.style.display='none'} />
              {:else}
                <div class="ex-thumb-placeholder">
                  <span class="material-symbols-rounded">fitness_center</span>
                </div>
              {/if}
              <div class="ex-info">
                <span class="ex-name">{ex.name}</span>
                <span class="ex-meta">
                  {#if ex.muscle}{ex.muscle}{/if}
                  {#if ex.muscle && lastMeta(ex)} · {/if}
                  {lastMeta(ex)}
                </span>
              </div>
            </button>
            <button class="btn-icon accent" on:click={() => openLog(ex)}
              aria-label={$_('exercises.log_today')} title={$_('exercises.log_today')}>
              <span class="material-symbols-rounded">add_circle</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<Sheet bind:open={logOpen} title={logEx ? $_('exercises.log_title', { values: { name: logEx.name } }) : $_('exercises.log_today')}>
  {#if logEx}
    <div class="log-form">
      <div class="form-group">
        <label class="form-label">{$_('exercises.date')}</label>
        <DateInput bind:value={logDate} max={localDateStr()} />
      </div>
      {#if parsePeople(logEx.people).length}
        <div class="form-group">
          <label class="form-label">{$_('exercises.person')}</label>
          <div class="diff-row" style="flex-wrap:wrap">
            {#each parsePeople(logEx.people) as p}
              <button class="cat-chip" class:active={logPerson === p} type="button"
                on:click={() => logPerson = p}>{p}</button>
            {/each}
          </div>
        </div>
      {/if}
      <div class="form-group">
        <label class="form-label">{$_('exercises.weight')} ({$weightUnit || 'kg'})</label>
        <input class="input" type="number" step="0.5" min="0" bind:value={logWeight}
          placeholder={$_('exercises.weight_placeholder')} />
      </div>
      <div class="form-group">
        <label class="form-label">{$_('exercises.difficulty')}</label>
        <div class="diff-row">
          {#each [1,2,3,4,5] as n}
            <button class="diff-btn" class:active={logDifficulty === n} type="button"
              on:click={() => logDifficulty = logDifficulty === n ? 0 : n}>{n}</button>
          {/each}
        </div>
        <div class="diff-hint">{$_('exercises.difficulty_hint')}</div>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:8px" disabled={logSaving} on:click={saveLog}>
        {logSaving ? $_('common.saving') : $_('common.save')}
      </button>
    </div>
  {/if}
</Sheet>

<style>
  .ex-search {
    display: flex; align-items: center; gap: 8px;
    padding: 0 16px 10px;
  }
  .ex-search-icon { color: var(--text-3); font-size: 20px; }
  .ex-search-input {
    flex: 1; height: 40px; border: 1px solid var(--border);
    border-radius: var(--radius-md); background: var(--surface-2);
    color: var(--text-1); padding: 0 12px; font-size: 15px;
  }
  .cat-filter-row {
    display: flex; gap: 8px; overflow-x: auto; padding: 0 16px 12px;
    -webkit-overflow-scrolling: touch;
  }
  .cat-chip {
    flex-shrink: 0; padding: 6px 12px; border-radius: 99px;
    border: 1.5px solid var(--border); background: transparent;
    color: var(--text-2); font-size: 13px; cursor: pointer;
  }
  .cat-chip.active {
    border-color: var(--accent); background: var(--accent-dim);
    color: var(--accent); font-weight: 600;
  }
  .ex-list { list-style: none; display: flex; flex-direction: column; gap: 8px; padding: 0 16px 24px; }
  .ex-item { display: flex; align-items: stretch; overflow: hidden; }
  .ex-item-btn {
    flex: 1; display: flex; align-items: center; gap: 12px;
    padding: 12px 14px; background: none; border: none; text-align: left;
    cursor: pointer; color: inherit; min-width: 0;
  }
  .ex-item-btn:active { background: var(--surface-2); }
  .ex-thumb, .ex-thumb-placeholder {
    width: 52px; height: 52px; border-radius: var(--radius-sm);
    object-fit: cover; flex-shrink: 0; background: var(--accent-dim);
  }
  .ex-thumb-placeholder {
    display: flex; align-items: center; justify-content: center;
    color: var(--accent);
  }
  .ex-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ex-name { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ex-meta { font-size: 12px; color: var(--text-3); }
  .empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; padding: 48px 24px; text-align: center; color: var(--text-3);
  }
  .empty-icon { font-size: 48px; opacity: 0.35; }
  .empty-hint { font-size: 13px; max-width: 280px; line-height: 1.45; }
  .log-form { display: flex; flex-direction: column; gap: 14px; padding: 4px 4px 16px; }
  .diff-row { display: flex; gap: 8px; }
  .diff-btn {
    flex: 1; height: 40px; border-radius: var(--radius-md);
    border: 1.5px solid var(--border); background: transparent;
    color: var(--text-2); font-weight: 600; cursor: pointer;
  }
  .diff-btn.active {
    border-color: var(--accent); background: var(--accent-dim); color: var(--accent);
  }
  .diff-hint { font-size: 12px; color: var(--text-3); margin-top: 4px; }
</style>
