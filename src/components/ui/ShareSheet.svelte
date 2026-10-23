<script>
  // Share one food, meal or recipe: the same Private, Everyone or Specific
  // People choice as Bulk Share in Settings, for this item only. Sharing is
  // kept on the server, so with no connection the sheet says so.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from './Sheet.svelte';
  import { loadShare, saveShare } from '../../lib/share-item.js';
  import { noteSharingStatus } from '../../stores/sharing.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  export let open = false;
  export let kind = 'foods';     // 'foods' | 'meals' (recipes are meals)
  export let item = null;

  const dispatch = createEventDispatcher();
  let visibility = 'private', userIds = [], users = [];
  let loading = false, saving = false, err = '';
  let loadedFor = null;

  // Loaded once per opening (keyed on the item's id, not the object).
  $: if (open && item && loadedFor !== item.id) load();
  $: if (!open) loadedFor = null;

  const _offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
  function _why(e) {
    if (e?.code === 'not_synced') return $_('share_item.not_synced');
    if (e?.code === 'off' || Number(e?.status) === 403) return $_('share_item.off');
    if (e?.offline || _offline()) return $_('share_item.needs_connection');
    return $_('share_item.failed');
  }

  async function load() {
    loadedFor = item.id;
    err = ''; loading = true;
    try {
      if (_offline()) throw Object.assign(new Error('offline'), { offline: true });
      const s = await loadShare(kind, item);
      // What the server says now: an admin may have turned sharing off.
      if (s.status) noteSharingStatus(s.status);
      if (s.off) throw Object.assign(new Error('off'), { code: 'off' });
      visibility = s.visibility; userIds = s.user_ids; users = s.users;
    } catch (e) { err = _why(e); }
    loading = false;
  }
  function toggle(id) { userIds = userIds.includes(id) ? userIds.filter(u => u !== id) : [...userIds, id]; }
  async function save() {
    if (saving) return;
    saving = true;
    try {
      await saveShare(kind, item, visibility, userIds);
      showSuccess($_('share_item.saved'));
      dispatch('shared', { visibility });
      open = false;
    } catch (e) {
      if (Number(e?.status) === 403) noteSharingStatus({ sharing_enabled: false });
      showError(_why(e));
    }
    saving = false;
  }
</script>

<Sheet bind:open title={$_('share_item.title')}>
  <div class="ss">
    {#if err}
      <p class="ss-msg">{err}</p>
    {:else if loading}
      <p class="ss-msg">{$_('share_item.loading')}</p>
    {:else}
      <p class="ss-intro">{$_('share_item.intro')}</p>
      <label class="ss-label" for="ss-vis">{$_('share_item.who')}</label>
      <div class="select-wrap">
        <select id="ss-vis" class="select" bind:value={visibility}>
          <option value="private">{$_('settings_integrations.vis_private')}</option>
          <option value="group">{$_('settings_integrations.vis_group')}</option>
          <option value="specific">{$_('settings_integrations.vis_specific')}</option>
        </select>
      </div>
      {#if visibility === 'specific'}
        <div class="ss-people" role="group" aria-label={$_('share_item.people')}>
          <span class="ss-label">{$_('share_item.people')}</span>
          {#each users as u (u.id)}
            <button class="chip" class:chip-active={userIds.includes(u.id)} aria-pressed={userIds.includes(u.id)} on:click={() => toggle(u.id)}>
              {#if userIds.includes(u.id)}<span class="material-symbols-rounded" style="font-size:14px" aria-hidden="true">check</span>{/if}
              {u.name}
            </button>
          {:else}
            <span class="ss-msg">{$_('share_item.no_people')}</span>
          {/each}
        </div>
      {/if}
      <button class="btn btn-primary w-full" disabled={saving || (visibility === 'specific' && !userIds.length)} on:click={save}>{$_('share_item.save')}</button>
    {/if}
  </div>
</Sheet>

<style>
  .ss { display: flex; flex-direction: column; gap: 12px; padding-top: 4px; }
  .ss-intro, .ss-msg { margin: 0; font-size: 14px; color: var(--text-2); }
  .ss-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .ss-people { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .ss-people .ss-label { flex-basis: 100%; }
</style>
