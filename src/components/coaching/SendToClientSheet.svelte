<script>
  // Send to Client: a coach sends one of their meals or recipes to a client
  // as a recommendation. It goes as a copy, so it works with sharing off; on
  // Accept the client gets their own. Needs a connection.
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { NtApi } from '../../lib/api.js';
  import { serverIdFor } from '../../lib/share-item.js';
  import { coachingErrorText } from '../../lib/coaching-view.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  export let open = false;
  export let meal = null;
  export let isRecipe = false;

  let clients = null, err = '', pick = null, note = '', busy = false, sid = null;

  $: if (open && clients === null && !err) load();
  $: if (!open) { clients = null; err = ''; note = ''; }

  async function load() {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw Object.assign(new Error('offline'), { offline: true });
      sid = await serverIdFor('meals', meal);
      const rows = await NtApi.get('/api/coaching/clients');
      clients = (rows || []).filter(r => r.status === 'active');
      // With several clients, nobody is chosen for you.
      pick = clients.length === 1 ? clients[0].client.id : null;
    } catch (e) {
      err = e?.code === 'not_synced' ? $_('coaching.send.not_synced') : coachingErrorText(e, $_);
      clients = [];
    }
  }
  async function send() {
    if (busy || pick == null) return;
    busy = true;
    try {
      await NtApi.post(`/api/coaching/clients/${pick}/recommendations`, { kind: isRecipe ? 'recipe' : 'meal', meal_id: sid, note: note.trim() || undefined });
      const name = clients.find(c => c.client.id === pick)?.client?.name || '';
      showSuccess($_('coaching.send.sent', { values: { name } }));
      open = false;
    } catch (e) { showError(coachingErrorText(e, $_)); }
    busy = false;
  }
</script>

<Sheet bind:open title={$_(isRecipe ? 'coaching.send.title_recipe' : 'coaching.send.title_meal')}>
  <div class="sc">
    {#if err}
      <p class="sc-msg">{err}</p>
    {:else if clients === null}
      <p class="sc-msg">{$_('coaching.loading')}</p>
    {:else if !clients.length}
      <p class="sc-msg">{$_('coaching.send.no_clients')}</p>
    {:else}
      <p class="sc-msg">{$_(isRecipe ? 'coaching.send.intro_recipe' : 'coaching.send.intro_meal', { values: { name: meal?.name || '' } })}</p>
      <p class="sc-hint">{$_('coaching.send.saved_version')}</p>
      <fieldset class="sc-clients">
        <legend class="sc-label">{$_('coaching.send.to')}</legend>
        {#each clients as c (c.id)}
          <label class="sc-client"><input type="radio" name="sc-client" value={c.client.id} bind:group={pick} /> {c.client.name}</label>
        {/each}
      </fieldset>
      <label class="sc-label" for="sc-note">{$_('coaching.targets.note_label')}</label>
      <textarea id="sc-note" class="input" rows="2" maxlength="500" bind:value={note} placeholder={$_('coaching.send.note_placeholder')}></textarea>
      <button class="btn btn-primary w-full" disabled={busy || pick == null} on:click={send}>{$_('coaching.send.send')}</button>
    {/if}
  </div>
</Sheet>

<style>
  .sc { display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
  .sc-msg { margin: 0; font-size: 14px; color: var(--text-2); }
  .sc-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .sc-clients { border: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .sc-client { display: flex; align-items: center; gap: 10px; font-size: 15px; min-height: 44px; }
  .sc-hint { margin: 0; font-size: 12px; color: var(--text-3); }
  .sc textarea { font: inherit; resize: vertical; }
</style>
