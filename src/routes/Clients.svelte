<script>
  // The Clients tab, for coaches: the list (with requests waiting for an
  // answer) and one client opened. Side by side once there is room for both
  // (720 px of content, the shared rule), one at a time on a phone.
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { push, replace } from 'svelte-spa-router';
  import { NtApi } from '../lib/api.js';
  import { bannerStyle, dateFormat } from '../stores/settings.js';
  import { coachingNeedsServer, refreshCoaching, clientsTab, coachingState, coachingSupported } from '../stores/coaching.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { formatDay, localDay, todayLocal, coachingErrorText } from '../lib/coaching-view.js';
  import CoachingTabs from '../components/coaching/CoachingTabs.svelte';
  import CoachingNeedsServer from '../components/coaching/CoachingNeedsServer.svelte';
  import ClientDetail from '../components/coaching/ClientDetail.svelte';
  import RequestSheet from '../components/coaching/RequestSheet.svelte';

  export let params = {};

  const needsServer = coachingNeedsServer();
  let rows = null, listErr = '';
  let requestOpen = false;
  let loaded = false;

  $: selectedId = params?.id != null ? Number(params.id) : null;
  $: selected = (rows || []).find(r => r.client.id === selectedId && r.status === 'active') || null;
  // A link to someone who isn't an active client opens the list.
  $: if (rows && selectedId != null && !selected) replace('/goals/clients');

  onMount(async () => {
    if (needsServer) { loaded = true; return; }
    // A server from before coaching: nothing to show here.
    if (!$coachingSupported) { replace('/goals'); return; }
    await Promise.all([loadList(), refreshCoaching()]);
    loaded = true;
  });
  // No longer coaching anyone (the Coach role taken away, an admin's last
  // client gone): back to Goals rather than an empty page.
  $: if (loaded && !needsServer && $coachingState && !$clientsTab) replace('/goals');

  // A message read or arrived (the unread count moved): the list's counts follow.
  let _lastUnread;
  $: if (loaded && $coachingState?.as_coach && $coachingState.as_coach.unread !== _lastUnread) {
    const first = _lastUnread === undefined;
    _lastUnread = $coachingState.as_coach.unread;
    if (!first) loadList();
  }

  async function loadList() {
    listErr = '';
    try {
      rows = await NtApi.get(`/api/coaching/clients?today=${todayLocal()}`);
      // Copies kept for a dead zone go with a client who is no longer yours.
      NtApi.forgetCoachingReads(rows.filter(r => r.status === 'active').map(r => r.client.id)).catch(() => {});
    }
    catch (e) { listErr = coachingErrorText(e, $_); rows = rows || []; }
  }

  async function end(row, { pending = false } = {}) {
    const name = row.client.name;
    if (!await confirmDialog({
      title: $_(pending ? 'coaching.clients.cancel_title' : 'coaching.clients.end_title', { values: { name } }),
      message: $_(pending ? 'coaching.clients.cancel_message' : 'coaching.clients.end_message', { values: { name } }),
      confirmText: $_(pending ? 'coaching.clients.cancel_request' : 'coaching.clients.end'),
      cancelText: $_('common.cancel'),
      dangerous: !pending,
    })) return;
    try {
      await NtApi.post(`/api/coaching/pairings/${row.id}/end`, {});
      showSuccess($_(pending ? 'coaching.clients.cancelled' : 'coaching.clients.ended', { values: { name } }));
      if (selectedId === row.client.id) replace('/goals/clients');
    } catch (e) { showError(coachingErrorText(e, $_)); }
    await Promise.all([loadList(), refreshCoaching()]);
  }

  const STATUS = { pending: 'coaching.clients.status_pending', declined: 'coaching.clients.status_declined', ended: 'coaching.clients.status_ended' };
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.goals.title')}</h1>
  </header>
  <CoachingTabs force />

  <div class="page-content clients-page">
    {#if needsServer}
      <CoachingNeedsServer />
    {:else}
      <div class="clients-layout" class:has-selection={!!selected || (selectedId != null && rows === null)}>
        <section class="clients-list-pane" aria-label={$_('coaching.clients.title')}>
          <div class="cl-head">
            <h2>{$_('coaching.clients.title')}</h2>
            <button class="btn btn-primary cl-add" on:click={() => requestOpen = true}>
              <span class="material-symbols-rounded" aria-hidden="true">person_add</span>
              {$_('coaching.clients.add')}
            </button>
          </div>
          {#if listErr}<p class="cl-msg">{listErr}</p>{/if}
          {#if rows === null}
            <p class="cl-msg">{$_('coaching.loading')}</p>
          {:else if rows.length === 0 && listErr}
            <!-- The message above says why. -->
          {:else if rows.length === 0}
            <div class="cl-empty">
              <span class="material-symbols-rounded" aria-hidden="true">groups</span>
              <p>{$_('coaching.clients.empty')}</p>
            </div>
          {:else}
            <ul class="cl-list">
              {#each rows as r (r.id)}
                <li class="cl-row" class:active={selected?.id === r.id}>
                  {#if r.status === 'active'}
                    <button class="cl-open" on:click={() => push(`/goals/clients/${r.client.id}`)}>
                      <span class="cl-avatar" aria-hidden="true">{r.client.name.slice(0, 1).toUpperCase()}</span>
                      <span class="cl-info">
                        <span class="cl-name">{r.client.name}{#if r.unread} <span class="cl-unread" aria-label={$_('coaching.unread', { values: { n: r.unread } })}>{r.unread}</span>{/if}</span>
                        <span class="cl-sub">
                          {r.last_logged ? $_('coaching.clients.last_logged', { values: { date: formatDay(r.last_logged, $dateFormat) } }) : $_('coaching.clients.never_logged')}
                          {#if r.week?.judged}· {$_('coaching.clients.on_target', { values: { on: r.week.on_target, days: r.week.judged } })}{/if}
                        </span>
                      </span>
                      <span class="material-symbols-rounded cl-chev" aria-hidden="true">chevron_right</span>
                    </button>
                  {:else}
                    <div class="cl-open cl-static">
                      <span class="cl-avatar muted" aria-hidden="true">{r.client.name.slice(0, 1).toUpperCase()}</span>
                      <span class="cl-info">
                        <span class="cl-name">{r.client.name}</span>
                        <span class="cl-sub">
                          <span class="cl-chip">{$_(STATUS[r.status])}</span>
                          {formatDay(localDay(r.status === 'pending' ? r.requested_at : (r.responded_at || r.ended_at)), $dateFormat)}
                        </span>
                      </span>
                      {#if r.status === 'pending'}
                        <button class="btn btn-ghost cl-cancel" on:click={() => end(r, { pending: true })}>{$_('coaching.clients.cancel_request')}</button>
                      {/if}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section class="client-pane">
          {#if selected}
            <ClientDetail row={selected} on:back={() => push('/goals/clients')} on:end={() => end(selected)} />
          {:else}
            <div class="cl-placeholder">
              <span class="material-symbols-rounded" aria-hidden="true">person_search</span>
              <p>{$_('coaching.clients.choose')}</p>
            </div>
          {/if}
        </section>
      </div>
    {/if}
  </div>
</div>

<RequestSheet bind:open={requestOpen} on:sent={() => { loadList(); refreshCoaching(); }} />

<style>
  .clients-layout { display: block; }
  .client-pane { display: none; }
  .clients-layout.has-selection .clients-list-pane { display: none; }
  .clients-layout.has-selection .client-pane { display: block; }

  /* Room for both: list and client side by side, each scrolling on its own. */
  :global(html.wide-content) .clients-layout {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    gap: 20px;
    align-items: start;
  }
  :global(html.wide-content) .clients-layout .clients-list-pane,
  :global(html.wide-content) .clients-layout .client-pane { display: block; }
  :global(html.wide-content) .client-pane :global(.cd-back) { display: none; }

  .cl-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
  .cl-head h2 { font-size: 17px; margin: 0; }
  .cl-add { display: inline-flex; align-items: center; gap: 6px; }
  .cl-add .material-symbols-rounded { font-size: 18px; }
  .cl-msg { color: var(--text-3); text-align: center; margin: 24px 0; }
  .cl-empty { text-align: center; color: var(--text-3); padding: 32px 16px; }
  .cl-empty .material-symbols-rounded { font-size: 40px; }
  .cl-list { list-style: none; margin: 12px 0 0; padding: 0; background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
  .cl-row + .cl-row { border-top: 1px solid var(--border); }
  .cl-row.active { background: var(--accent-dim); }
  .cl-open {
    width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 14px;
    background: none; border: none; font: inherit; color: inherit; text-align: left; cursor: pointer;
  }
  .cl-static { cursor: default; }
  .cl-avatar { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-dim); color: var(--accent); font-weight: 700; flex-shrink: 0; }
  .cl-avatar.muted { background: var(--surface-3); color: var(--text-3); }
  .cl-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .cl-name { font-weight: 600; overflow-wrap: anywhere; }
  .cl-sub { font-size: 12px; color: var(--text-3); }
  .cl-chip { display: inline-block; padding: 1px 8px; border-radius: var(--radius-full); background: var(--surface-3); color: var(--text-2); font-weight: 600; margin-right: 4px; }
  .cl-chev { color: var(--text-3); }
  .cl-unread { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: var(--radius-full); background: var(--accent); color: var(--accent-text, #fff); font-size: 11px; font-weight: 700; text-align: center; vertical-align: 1px; }
  .cl-cancel { flex-shrink: 0; font-size: 13px; }
  .cl-placeholder { text-align: center; color: var(--text-3); padding: 64px 16px; }
  .cl-placeholder .material-symbols-rounded { font-size: 40px; }
</style>
