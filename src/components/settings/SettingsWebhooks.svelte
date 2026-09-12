<script>
  /**
   * SettingsWebhooks.svelte
   *
   * Admin-only Settings section for outgoing webhook management. Lists
   * existing webhooks, lets the admin create new ones (with a target
   * URL + event checkboxes + optional custom secret), test one without
   * waiting for a real event, and delete them.
   *
   * The shared secret is shown EXACTLY ONCE on creation (whether typed
   * in or auto-generated), same one-time-reveal contract
   * SettingsApiTokens.svelte uses for the raw token value. After that
   * the server only stores it encrypted at rest, it still needs the
   * plaintext to sign deliveries, so unlike a token this is decryptable
   * server-side, just never re-displayed to the browser.
   */
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { apiUrl } from '../../lib/platform.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import Spinner from '../ui/Spinner.svelte';

  // NT sub-components are body-only, the section-toggle button is
  // rendered externally in Settings.svelte. Matches SettingsApiTokens.
  export let expanded = false;
  export async function loadData() { return load(); }

  let webhooks = [];
  let knownEvents = [];
  let eventDescriptions = {};
  let webhooksEnabled = false;
  let loading = false;
  let creating = false;
  let testingId = null;

  // Create-form state
  let showCreateForm = false;
  let newUrl = '';
  let newEvents = new Set(['meal.logged']);
  let newSecret = ''; // '' = server generates one

  // The just-created raw secret, shown to the user once
  let justCreatedSecret = '';
  let justCreatedUrl = '';

  async function load() {
    loading = true;
    try {
      const r = await fetch(apiUrl('/api/admin/webhooks'), {
        credentials: 'include', headers: { 'Content-Type': 'application/json' },
      });
      if (!r.ok) throw new Error($_('settings_webhooks.toast.load_failed'));
      const data = await r.json();
      webhooks = data.webhooks || [];
      knownEvents = data.known_events || [];
      eventDescriptions = data.event_descriptions || {};
      webhooksEnabled = !!data.webhooks_enabled;
    } catch (e) {
      showError(e.message);
    } finally {
      loading = false;
    }
  }

  $: if (expanded) load();

  function toggleEvent(ev) {
    if (newEvents.has(ev)) newEvents.delete(ev);
    else newEvents.add(ev);
    newEvents = newEvents; // trigger reactivity
  }

  async function createNewWebhook() {
    if (creating) return;
    if (!newUrl.trim()) { showError($_('settings_webhooks.toast.url_required')); return; }
    if (newEvents.size === 0) { showError($_('settings_webhooks.toast.event_required')); return; }

    creating = true;
    try {
      const r = await fetch(apiUrl('/api/admin/webhooks'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: newUrl.trim(),
          events: Array.from(newEvents),
          secret: newSecret.trim() || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) { showError(data.error || $_('settings_webhooks.toast.create_failed')); return; }

      justCreatedSecret = data.secret;
      justCreatedUrl = data.webhook.url;
      showCreateForm = false;
      newUrl = '';
      newEvents = new Set(['meal.logged']);
      newSecret = '';
      await load();
    } catch (e) {
      showError(e.message);
    } finally {
      creating = false;
    }
  }

  async function deleteOne(w) {
    if (!await confirmDialog({
      title: $_('settings_webhooks.confirm.delete_title'),
      message: $_('settings_webhooks.confirm.delete_msg'),
      confirmText: $_('settings_webhooks.confirm.delete_confirm'),
      dangerous: true,
    })) return;
    try {
      const r = await fetch(apiUrl(`/api/admin/webhooks/${w.id}`), {
        method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        showError(data.error || $_('settings_webhooks.toast.delete_failed')); return;
      }
      showSuccess($_('settings_webhooks.toast.deleted'));
      await load();
    } catch (e) {
      showError(e.message);
    }
  }

  async function toggleEnabled(w) {
    try {
      const r = await fetch(apiUrl(`/api/admin/webhooks/${w.id}`), {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !w.enabled }),
      });
      const data = await r.json();
      if (!r.ok) { showError(data.error || $_('settings_webhooks.toast.update_failed')); return; }
      await load();
    } catch (e) {
      showError(e.message);
    }
  }

  async function testOne(w) {
    if (testingId) return;
    testingId = w.id;
    try {
      const r = await fetch(apiUrl(`/api/admin/webhooks/${w.id}/test`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) { showError(data.error || $_('settings_webhooks.toast.test_failed')); return; }
      if (data.ok) showSuccess($_('settings_webhooks.toast.test_delivered'));
      else showError(data.last_delivery_error || $_('settings_webhooks.toast.test_failed'));
      await load();
    } catch (e) {
      showError(e.message);
    } finally {
      testingId = null;
    }
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(justCreatedSecret);
      showSuccess($_('settings_webhooks.toast.copied'));
    } catch {
      showError($_('settings_webhooks.toast.copy_failed'));
    }
  }

  function dismissJustCreated() {
    justCreatedSecret = '';
    justCreatedUrl = '';
  }

  function _fmtRelative(iso) {
    if (!iso) return $_('settings_webhooks.row.never');
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return iso;
    const sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return $_('settings_webhooks.row.just_now');
    if (sec < 3600) return $_('settings_webhooks.row.min_ago', { values: { n: Math.floor(sec / 60) } });
    if (sec < 86400) return $_('settings_webhooks.row.hr_ago', { values: { n: Math.floor(sec / 3600) } });
    if (sec < 86400 * 30) return $_('settings_webhooks.row.day_ago', { values: { n: Math.floor(sec / 86400) } });
    return d.toLocaleDateString();
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>
      <p class="sub-label" style="padding:0 0 6px">
        {$_('settings_webhooks.intro')}
      </p>

      {#if justCreatedSecret}
        <div class="just-created" transition:slide={{ duration: 160 }}>
          <div class="just-created-title">
            <span class="material-symbols-rounded">webhook</span>
            {$_('settings_webhooks.just_created.title')} <strong>{justCreatedUrl}</strong>
          </div>
          <p class="just-created-warn">
            {$_('settings_webhooks.just_created.warn')}
          </p>
          <div class="just-created-row">
            <code class="just-created-value" title={justCreatedSecret}>{justCreatedSecret}</code>
            <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px" on:click={copySecret}>
              <span class="material-symbols-rounded" style="font-size:14px">content_copy</span>
              {$_('settings_webhooks.just_created.copy')}
            </button>
          </div>
          <button class="btn btn-ghost" style="margin-top:8px;width:100%" on:click={dismissJustCreated}>
            {$_('settings_webhooks.just_created.saved')}
          </button>
        </div>
      {/if}

      {#if !webhooksEnabled}
        <div class="webhooks-disabled-notice">
          {$_('settings_webhooks.disabled_notice')}
        </div>
      {/if}

      <div class="card settings-card">
        {#if loading && webhooks.length === 0}
          <Spinner block size="sm" />
        {:else if webhooks.length === 0}
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:4px;padding:14px 16px">
            <span class="setting-label">{$_('settings_webhooks.empty.title')}</span>
            <span class="setting-desc">{$_('settings_webhooks.empty.desc')}</span>
          </div>
        {:else}
          {#each webhooks as w, i (w.id)}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="webhook-row">
              <div class="webhook-info">
                <span class="webhook-url" title={w.url}>{w.url}</span>
                <span class="webhook-meta text-3 text-sm">
                  {w.events.join(', ')}
                  · {$_('settings_webhooks.row.last_delivery', { values: { when: _fmtRelative(w.last_delivery_at) } })}
                  {#if w.last_delivery_status === 'success'}
                    <span class="status-badge status-success">{$_('settings_webhooks.row.status_success')}</span>
                  {:else if w.last_delivery_status === 'failed'}
                    <span class="status-badge status-failed" title={w.last_delivery_error || ''}>{$_('settings_webhooks.row.status_failed')}</span>
                  {/if}
                </span>
              </div>
              <div class="webhook-actions">
                <button class="btn-icon" title={$_('settings_webhooks.row.test_title')} disabled={testingId === w.id} on:click={() => testOne(w)}>
                  <span class="material-symbols-rounded">{testingId === w.id ? 'hourglass_empty' : 'send'}</span>
                </button>
                <label class="webhook-toggle" title={$_('settings_webhooks.row.enabled_title')}>
                  <input type="checkbox" checked={w.enabled} on:change={() => toggleEnabled(w)} />
                </label>
                <button class="btn-icon" title={$_('settings_webhooks.row.delete_title')} on:click={() => deleteOne(w)}>
                  <span class="material-symbols-rounded" style="color:var(--danger)">delete</span>
                </button>
              </div>
            </div>
          {/each}
        {/if}
        <div class="setting-divider"></div>
        <div style="padding:12px 16px">
          {#if !showCreateForm}
            <button class="btn btn-secondary" style="width:100%" on:click={() => showCreateForm = true}>
              <span class="material-symbols-rounded" style="font-size:18px">add</span>
              {$_('settings_webhooks.form.new_webhook')}
            </button>
          {:else}
            <div class="create-form" transition:slide={{ duration: 160 }}>
              <div class="form-group">
                <label class="form-label">{$_('settings_webhooks.form.url')}</label>
                <input class="input" type="url" placeholder={$_('settings_webhooks.form.url_ph')} bind:value={newUrl} />
              </div>
              <div class="form-group">
                <label class="form-label">{$_('settings_webhooks.form.events')}</label>
                <div class="event-grid">
                  {#each knownEvents as ev (ev)}
                    <label class="event-option">
                      <input type="checkbox" checked={newEvents.has(ev)} on:change={() => toggleEvent(ev)} />
                      <div class="event-text">
                        <code>{ev}</code>
                        {#if eventDescriptions[ev]}
                          <span class="event-desc">{eventDescriptions[ev]}</span>
                        {/if}
                      </div>
                    </label>
                  {/each}
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{$_('settings_webhooks.form.secret_label')}</label>
                <input class="input" type="text" placeholder={$_('settings_webhooks.form.secret_ph')} bind:value={newSecret} />
              </div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-ghost" style="flex:1" on:click={() => { showCreateForm = false; newUrl = ''; }}>{$_('settings_webhooks.form.cancel')}</button>
                <button class="btn btn-primary" style="flex:2" on:click={createNewWebhook} disabled={creating}>
                  {creating ? $_('settings_webhooks.form.creating') : $_('settings_webhooks.form.create')}
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

<style>
  .just-created {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    margin-bottom: 4px;
  }
  .just-created-title {
    display: flex; align-items: center; gap: 6px;
    font-size: 14px; font-weight: 600; color: var(--text-1); margin-bottom: 4px;
  }
  .just-created-warn { font-size: 12px; color: var(--warning, var(--accent)); margin: 0 0 8px; }
  .just-created-row { display: flex; gap: 6px; align-items: center; }
  .just-created-value {
    flex: 1; font-family: var(--mono, monospace); font-size: 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    padding: 6px 8px; border-radius: var(--radius-sm);
    overflow-wrap: anywhere; word-break: break-all; min-width: 0;
  }
  .webhooks-disabled-notice {
    font-size: 12px; color: var(--text-3);
    padding: 8px 10px; margin-bottom: 8px;
    background: var(--surface-2); border-radius: var(--radius-sm);
  }
  .webhook-row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px;
  }
  .webhook-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
  .webhook-url { font-weight: 600; font-size: 13px; color: var(--text-1); font-family: var(--mono, monospace); word-break: break-all; }
  .webhook-meta { font-size: 11px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .webhook-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .webhook-toggle { display: flex; align-items: center; padding: 0 4px; }
  .status-badge { font-size: 10px; padding: 1px 6px; border-radius: var(--radius-full); font-weight: 600; }
  .status-success { background: color-mix(in srgb, var(--success, var(--accent)) 15%, transparent); color: var(--success, var(--accent)); }
  .status-failed { background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--danger); }
  .create-form { display: flex; flex-direction: column; gap: 10px; }
  .event-grid { display: flex; flex-direction: column; gap: 6px; }
  .event-option {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    cursor: pointer; font-size: 13px;
  }
  .event-option:hover { background: var(--surface-2); }
  .event-option code { font-size: 12px; color: var(--text-2); }
  .event-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .event-desc { font-size: 11px; color: var(--text-3); line-height: 1.3; }
</style>
