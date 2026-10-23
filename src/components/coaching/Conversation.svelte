<script>
  // A coach and a client's conversation: text up to 4,000 characters and one
  // photo per message. Kept on the device, so it opens with no connection;
  // a message written offline waits and goes once (its uuid). Checked for
  // news when opened, when the app comes back to the front, and every 10
  // seconds only while it is on screen.
  import { onMount, onDestroy, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { timeFormat, dateFormat } from '../../stores/settings.js';
  import { refreshCoaching } from '../../stores/coaching.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { showError } from '../../stores/toast.js';
  import {
    MESSAGE_MAX, loadConversation, refreshConversation, markConversationRead,
    sendMessage, deleteOwnMessage, flushCoachMessages,
  } from '../../lib/coach-messages.js';
  import { embeddableDataUrl } from '../../lib/image-embed.js';
  import { formatDay } from '../../lib/coaching-view.js';
  import AttachImageButton from '../ai/AttachImageButton.svelte';
  import CoachPhoto from './CoachPhoto.svelte';
  import RecommendationCard from './RecommendationCard.svelte';

  /** { pairingId, side: 'client' | 'coach', clientId } */
  export let conv;
  export let otherName = '';
  /** Ended coaching: the client still reads it, nobody writes. */
  export let readOnly = false;
  /** Recommendations of this pairing: one in the conversation shows as its card. */
  export let recommendations = [];
  /** The client's meal names, for a day plan on the coach's side. */
  export let mealNames = null;

  const POLL_MS = 10_000;
  const me = Number(localStorage.getItem('wl:userId')) || null;
  let messages = [];
  let canSend = !readOnly;
  let offline = false;
  let text = '';
  let photo = null;          // data URL waiting to go with the next message
  let sending = false;
  let listEl, timer = null, mounted = false;
  let loadedFor = null;

  $: key = `${conv?.side}:${conv?.pairingId}`;
  $: if (mounted && key !== loadedFor) { loadedFor = key; start(); }

  const _utc = (ts) => new Date(String(ts || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z'));
  $: timeOf = (ts) => _utc(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: $timeFormat !== '24h' });
  const dayOf = (ts) => _utc(ts).toLocaleDateString('sv-SE');

  async function reload({ scroll = false } = {}) {
    const atBottom = !listEl || listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
    messages = await loadConversation(conv);
    await tick();
    if ((scroll || atBottom) && listEl) listEl.scrollTop = listEl.scrollHeight;
  }

  let _checking = false;
  async function check({ read = true } = {}) {
    if (_checking || !conv) return;
    _checking = true;
    try {
      const f = await flushCoachMessages().catch(() => null);
      if (f?.offline) offline = true;
      const r = await refreshConversation(conv);
      offline = false;
      if (!readOnly) canSend = r.can_send;
      await reload();
      const unread = messages.some(m => m.sender_id !== me && !m.read_at && !m.deleted_at);
      if (read && unread && document.visibilityState === 'visible') {
        if (await markConversationRead(conv)) { await refreshConversation(conv).catch(() => {}); await reload(); refreshCoaching(); }
      }
    } catch (e) {
      offline = !!e?.offline || offline;
    } finally { _checking = false; }
  }

  async function start() {
    messages = [];
    canSend = !readOnly;
    await reload({ scroll: true });
    await check();
    await reload({ scroll: true });
  }

  function onVisible() {
    if (document.visibilityState === 'visible') check();
  }
  const onNews = () => reload();

  onMount(() => {
    mounted = true;
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('nt:coach-messages', onNews);
    // Only while this conversation is open and the app is in front.
    timer = setInterval(() => { if (document.visibilityState === 'visible') check(); }, POLL_MS);
  });
  onDestroy(() => {
    mounted = false;
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('nt:coach-messages', onNews);
  });

  async function onFiles(e) {
    const file = e.detail?.[0];
    if (!file) return;
    try { photo = await embeddableDataUrl(file); }
    catch { showError($_('coaching.chat.photo_unreadable')); }
  }

  async function send() {
    if (sending || !canSend) return;
    const body = text.replace(/\s+$/, '');
    if (!body.trim() && !photo) return;
    if (body.length > MESSAGE_MAX) { showError($_('coaching.chat.too_long', { values: { max: MESSAGE_MAX.toLocaleString() } })); return; }
    sending = true;
    try {
      const sent = await sendMessage(conv, { body, image: photo });
      offline = sent.offline;
      text = ''; photo = null;
      await reload({ scroll: true });
    } catch { showError($_('coaching.something_failed')); }
    sending = false;
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  }

  async function remove(m) {
    if (!await confirmDialog({
      title: $_('coaching.chat.delete_title'),
      message: $_('coaching.chat.delete_message', { values: { name: otherName } }),
      confirmText: $_('coaching.chat.delete'),
      cancelText: $_('common.cancel'),
      dangerous: true,
    })) return;
    await deleteOwnMessage(m);
    await reload();
  }

  // The newest of my messages the other person has read: "Read" goes there.
  $: lastRead = [...messages].reverse().find(m => m.sender_id === me && m.read_at && !m.deleted_at)?.uuid;
  $: rows = messages.map((m, i) => ({ m, day: dayOf(m.created_at), newDay: i === 0 || dayOf(messages[i - 1].created_at) !== dayOf(m.created_at) }));
</script>

<section class="chat" aria-label={$_('coaching.chat.aria', { values: { name: otherName } })}>
  <div class="chat-list" bind:this={listEl} role="log" aria-live="polite">
    {#if rows.length === 0}
      <p class="chat-empty">{readOnly ? $_('coaching.chat.empty_closed') : $_('coaching.chat.empty', { values: { name: otherName } })}</p>
    {/if}
    {#each rows as { m, day, newDay } (m.uuid)}
      {#if newDay}<div class="chat-day">{formatDay(day, $dateFormat)}</div>{/if}
      {#if m.recommendation_id}
        {@const rec = recommendations.find(r => r.id === m.recommendation_id)}
        <div class="msg msg-rec" class:mine={m.sender_id === me}>
          {#if rec}
            <RecommendationCard {rec} compact coachView={conv.side === 'coach'} coachName={otherName} {mealNames} on:answered />
          {:else}
            <div class="bubble"><span class="deleted-text">{$_('coaching.targets.card_title_coach')}</span></div>
          {/if}
          <div class="msg-meta"><span>{timeOf(m.created_at)}</span></div>
        </div>
      {:else}
      <div class="msg" class:mine={m.sender_id === me}>
        <div class="bubble" class:deleted={!!m.deleted_at}>
          {#if m.deleted_at}
            <span class="deleted-text">{$_('coaching.chat.deleted')}</span>
          {:else}
            {#if m.image_local || m.image}<CoachPhoto path={m.image_local || m.image} />{/if}
            {#if m.body}<p class="msg-body">{m.body}</p>{/if}
          {/if}
        </div>
        <div class="msg-meta">
          <span>{timeOf(m.created_at)}</span>
          {#if m.sync_status === 'pending'}<span class="msg-state">· {$_(offline ? 'coaching.chat.waiting' : 'coaching.chat.sending')}</span>{/if}
          {#if m.sync_status === 'failed'}<span class="msg-state failed">· {$_('coaching.chat.not_sent')}</span>{/if}
          {#if m.uuid === lastRead}<span class="msg-state">· {$_('coaching.chat.read')}</span>{/if}
          {#if m.sender_id === me && !m.deleted_at}
            <button class="msg-del" on:click={() => remove(m)} aria-label={$_('coaching.chat.delete')} title={$_('coaching.chat.delete')}>
              <span class="material-symbols-rounded" aria-hidden="true">delete</span>
            </button>
          {/if}
        </div>
      </div>
      {/if}
    {/each}
  </div>

  {#if readOnly || !canSend}
    <p class="chat-closed">{$_('coaching.chat.closed')}</p>
  {:else}
    {#if photo}
      <div class="chat-photo">
        <img src={photo} alt={$_('coaching.chat.photo')} />
        <button class="btn-icon" on:click={() => photo = null} aria-label={$_('coaching.chat.remove_photo')} title={$_('coaching.chat.remove_photo')}>
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
    {/if}
    <div class="composer">
      <AttachImageButton title={$_('coaching.chat.add_photo')} disabled={sending || !!photo} on:files={onFiles} />
      <textarea class="input composer-input" rows="1" bind:value={text} on:keydown={onKey}
        maxlength={MESSAGE_MAX} placeholder={$_('coaching.chat.placeholder', { values: { name: otherName } })}
        aria-label={$_('coaching.chat.placeholder', { values: { name: otherName } })}></textarea>
      <button class="btn btn-primary composer-send" disabled={sending || (!text.trim() && !photo)} on:click={send}
        aria-label={$_('coaching.chat.send')} title={$_('coaching.chat.send')}>
        <span class="material-symbols-rounded" aria-hidden="true">send</span>
      </button>
    </div>
    {#if text.length > MESSAGE_MAX - 400}
      <p class="composer-count">{$_('coaching.chat.count', { values: { n: text.length.toLocaleString(), max: MESSAGE_MAX.toLocaleString() } })}</p>
    {/if}
    {#if offline}<p class="composer-offline">{$_('coaching.chat.offline')}</p>{/if}
  {/if}
</section>

<style>
  .chat { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; min-width: 0; }
  .chat-list {
    display: flex; flex-direction: column; gap: 6px;
    max-height: min(60vh, 560px); min-height: 160px; overflow-y: auto;
    padding: 12px; background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
  }
  .chat-empty, .chat-closed { color: var(--text-3); font-size: 13px; text-align: center; margin: 16px 0; }
  .chat-closed { margin: 4px 0; }
  .chat-day { align-self: center; font-size: 11px; color: var(--text-3); background: var(--surface-2); padding: 2px 10px; border-radius: var(--radius-full); margin: 6px 0; }
  .msg { display: flex; flex-direction: column; align-items: flex-start; max-width: 85%; }
  .msg.mine { align-self: flex-end; align-items: flex-end; }
  .msg-rec { max-width: min(100%, 520px); width: 100%; }
  .msg-rec :global(.tc) { margin-top: 0; width: 100%; }
  .bubble {
    background: var(--surface-2); color: var(--text-1); padding: 8px 12px; border-radius: 14px 14px 14px 4px;
    display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 100%;
  }
  .msg.mine .bubble { background: var(--accent-dim); border-radius: 14px 14px 4px 14px; }
  .bubble.deleted { background: none; border: 1px dashed var(--border-strong); }
  .deleted-text { color: var(--text-3); font-style: italic; font-size: 13px; }
  .msg-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.4; }
  .msg-meta { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); margin-top: 2px; }
  .msg-state.failed { color: var(--danger); }
  .msg-del { background: none; border: none; padding: 0 2px; color: var(--text-3); cursor: pointer; display: inline-flex; }
  .msg-del .material-symbols-rounded { font-size: 15px; }
  .msg-del:hover { color: var(--danger); }
  .composer { display: flex; align-items: flex-end; gap: 8px; }
  .composer-input { flex: 1; min-width: 0; resize: none; min-height: 40px; max-height: 140px; font: inherit; field-sizing: content; }
  .composer-send { width: 44px; height: 40px; padding: 0; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .composer-count, .composer-offline { margin: 0; font-size: 12px; color: var(--text-3); }
  .chat-photo { position: relative; align-self: flex-start; }
  .chat-photo img { display: block; max-width: 160px; max-height: 120px; border-radius: 10px; }
  .chat-photo .btn-icon { position: absolute; top: -8px; right: -8px; width: 28px; height: 28px; }
</style>
