<script>
  // Ask to coach someone: a name list (id and name only, like the sharing
  // picker) and an optional note. Nothing is visible until they accept.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { NtApi } from '../../lib/api.js';
  import { foldText } from '../../lib/search-text.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { coachingErrorText } from '../../lib/coaching-view.js';

  export let open = false;
  const dispatch = createEventDispatcher();
  const NOTE_MAX = 500;

  let people = null, loadErr = '';
  let query = '', picked = null, note = '', sending = false;

  $: if (open) load();
  async function load() {
    people = null; loadErr = ''; picked = null; note = ''; query = '';
    try { people = await NtApi.get('/api/coaching/candidates'); }
    catch (e) { loadErr = coachingErrorText(e, $_); people = []; }
  }

  $: shown = (people || []).filter(p => !query.trim() || foldText(p.name).includes(foldText(query.trim())));

  async function send() {
    if (!picked || sending) return;
    sending = true;
    try {
      await NtApi.post('/api/coaching/requests', { client_id: picked.id, note: note.trim() || undefined });
      showSuccess($_('coaching.request.sent', { values: { name: picked.name } }));
      open = false;
      dispatch('sent', picked);
    } catch (e) { showError(coachingErrorText(e, $_)); }
    sending = false;
  }
</script>

<Sheet bind:open title={$_('coaching.request.title')} on:close>
  <div class="rq">
    <p class="rq-intro">{$_('coaching.request.intro')}</p>
    <input class="input" type="search" bind:value={query} placeholder={$_('coaching.request.search')} aria-label={$_('coaching.request.search')} />
    {#if people === null}
      <p class="rq-msg">{$_('coaching.loading')}</p>
    {:else if loadErr}
      <p class="rq-msg">{loadErr}</p>
    {:else if shown.length === 0}
      <p class="rq-msg">{$_('coaching.request.nobody')}</p>
    {:else}
      <ul class="rq-list" role="listbox" aria-label={$_('coaching.request.people')}>
        {#each shown as p (p.id)}
          <li>
            <button class="rq-person" class:picked={picked?.id === p.id} role="option" aria-selected={picked?.id === p.id} on:click={() => picked = p}>
              <span class="rq-avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
              <span class="rq-name">{p.name}</span>
              {#if picked?.id === p.id}<span class="material-symbols-rounded rq-check" aria-hidden="true">check_circle</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <label class="rq-label" for="rq-note">{$_('coaching.request.note_label')}</label>
    <textarea id="rq-note" class="input rq-note" rows="3" maxlength={NOTE_MAX} bind:value={note} placeholder={$_('coaching.request.note_placeholder')}></textarea>
    <button class="btn btn-primary rq-send" disabled={!picked || sending} on:click={send}>
      {picked ? $_('coaching.request.send_to', { values: { name: picked.name } }) : $_('coaching.request.send')}
    </button>
  </div>
</Sheet>

<style>
  .rq { display: flex; flex-direction: column; gap: 10px; padding-bottom: 8px; }
  .rq-intro { margin: 0; color: var(--text-3); font-size: 13px; line-height: 1.45; }
  .rq-msg { color: var(--text-3); text-align: center; margin: 16px 0; }
  .rq-list { list-style: none; margin: 0; padding: 0; max-height: 40vh; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
  .rq-person {
    width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    background: none; border: none; border-top: 1px solid var(--border); font: inherit; color: inherit; text-align: left; cursor: pointer;
  }
  .rq-list li:first-child .rq-person { border-top: none; }
  .rq-person.picked { background: var(--accent-dim); }
  .rq-avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-3); font-weight: 700; flex-shrink: 0; }
  .rq-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .rq-check { color: var(--accent); }
  .rq-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .rq-note { resize: vertical; min-height: 72px; font: inherit; }
  .rq-send { width: 100%; }
</style>
