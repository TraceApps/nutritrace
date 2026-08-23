<script>
  /**
   * SettingsApiTokens.svelte
   *
   * Admin-only Settings section for federation API token management.
   * Lists existing tokens, lets the admin create new ones (with name +
   * scope checkboxes + optional expiry), and revoke them.
   *
   * The raw token value is shown EXACTLY ONCE on creation — the user
   * is responsible for copying it before dismissing the banner. After
   * that the server only stores a SHA-256 hash.
   *
   * See docs/federation.md for the wire contract these tokens unlock.
   */
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { apiUrl, isNative, getServerUrl, getAuthToken } from '../../lib/platform.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import Spinner from '../ui/Spinner.svelte';

  // NT sub-components are body-only — the section-toggle button is
  // rendered externally in Settings.svelte. This component only renders
  // its body, gated by `expanded` from the parent (no `visible`/`onToggle`
  // contract here, matches SettingsAuth / SettingsBackup / SettingsTrace).
  export let expanded = false;
  export async function loadData() { return load(); }

  let tokens = [];
  let knownScopes = [];
  let scopeDescriptions = {};
  let mcpState = { enabled: false, write: false, destroy: false };
  let loading = false;
  let creating = false;

  // Create-form state
  let showCreateForm = false;
  let newName = '';
  let newScopes = new Set(['read:foods']);
  let newExpiresDays = '';   // '' = never

  // The just-created raw token, shown to the user once
  let justCreatedRaw = '';
  let justCreatedName = '';

  function _csrfHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return h;
  }

  async function load() {
    loading = true;
    try {
      const r = await fetch(apiUrl('/api/admin/api-tokens'), {
        credentials: 'include', headers: _csrfHeaders(),
      });
      if (!r.ok) throw new Error($_('settings_api_tokens.toast.load_failed'));
      const data = await r.json();
      tokens = data.tokens || [];
      knownScopes = data.known_scopes || [];
      scopeDescriptions = data.scope_descriptions || {};
      mcpState = data.mcp_state || { enabled: false, write: false, destroy: false };
    } catch (e) {
      showError(e.message);
    } finally {
      loading = false;
    }
  }

  $: if (expanded) load();

  function toggleScope(s) {
    if (newScopes.has(s)) newScopes.delete(s);
    else newScopes.add(s);
    newScopes = newScopes; // trigger reactivity
  }

  async function createNewToken() {
    if (creating) return;
    if (!newName.trim()) { showError($_('common.errors.name_required')); return; }
    if (newScopes.size === 0) { showError($_('settings_api_tokens.toast.scope_required')); return; }

    creating = true;
    try {
      let expiresAt = null;
      const days = Number(newExpiresDays);
      if (Number.isFinite(days) && days > 0) {
        expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      }

      const r = await fetch(apiUrl('/api/admin/api-tokens'), {
        method: 'POST', credentials: 'include',
        headers: _csrfHeaders(),
        body: JSON.stringify({
          name: newName.trim(),
          scopes: Array.from(newScopes),
          expires_at: expiresAt,
        }),
      });
      const data = await r.json();
      if (!r.ok) { showError(data.error || $_('settings_api_tokens.toast.create_failed')); return; }

      justCreatedRaw = data.raw;
      justCreatedName = data.token.name;
      showCreateForm = false;
      newName = '';
      newScopes = new Set(['read:foods']);
      newExpiresDays = '';
      await load();
    } catch (e) {
      showError(e.message);
    } finally {
      creating = false;
    }
  }

  async function revokeOne(t) {
    if (!await confirmDialog({
      title: $_('settings_api_tokens.confirm.revoke_title', { values: { name: t.name } }),
      message: $_('settings_api_tokens.confirm.revoke_msg'),
      confirmText: $_('settings_api_tokens.confirm.revoke_confirm'),
      dangerous: true,
    })) return;
    try {
      const r = await fetch(apiUrl(`/api/admin/api-tokens/${t.id}`), {
        method: 'DELETE', credentials: 'include', headers: _csrfHeaders(),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        showError(data.error || $_('settings_api_tokens.toast.revoke_failed')); return;
      }
      showSuccess($_('settings_api_tokens.toast.revoked'));
      await load();
    } catch (e) {
      showError(e.message);
    }
  }

  async function copyRaw() {
    try {
      await navigator.clipboard.writeText(justCreatedRaw);
      showSuccess($_('settings_api_tokens.toast.copied'));
    } catch {
      showError($_('settings_api_tokens.toast.copy_failed'));
    }
  }

  function dismissJustCreated() {
    justCreatedRaw = '';
    justCreatedName = '';
  }

  function _fmtRelative(iso) {
    if (!iso) return $_('settings_api_tokens.row.never');
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return iso;
    const ms = Date.now() - d.getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return $_('settings_api_tokens.row.just_now');
    if (sec < 3600) return $_('settings_api_tokens.row.min_ago', { values: { n: Math.floor(sec / 60) } });
    if (sec < 86400) return $_('settings_api_tokens.row.hr_ago',  { values: { n: Math.floor(sec / 3600) } });
    if (sec < 86400 * 30) return $_('settings_api_tokens.row.day_ago', { values: { n: Math.floor(sec / 86400) } });
    return d.toLocaleDateString();
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>
      <p class="sub-label" style="padding:0 0 6px">
        {$_('settings_api_tokens.intro_before')} <em>{$_('settings_api_tokens.intro_dev')}</em>){$_('settings_api_tokens.intro_middle')}
        <code>/api/v1/</code>. {$_('settings_api_tokens.intro_see')}
        <a href="https://github.com/traceapps/nutritrace/blob/main/docs/federation.md" target="_blank" rel="noopener">docs/federation.md</a>.
      </p>

      {#if justCreatedRaw}
        <div class="just-created" transition:slide={{ duration: 160 }}>
          <div class="just-created-title">
            <span class="material-symbols-rounded">key</span>
            {$_('settings_api_tokens.just_created.title')} <strong>{justCreatedName}</strong>
          </div>
          <p class="just-created-warn">
            {$_('settings_api_tokens.just_created.warn')}
          </p>
          <div class="just-created-row">
            <code class="just-created-value" title={justCreatedRaw}>{justCreatedRaw}</code>
            <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px" on:click={copyRaw}>
              <span class="material-symbols-rounded" style="font-size:14px">content_copy</span>
              {$_('settings_api_tokens.just_created.copy')}
            </button>
          </div>
          <button class="btn btn-ghost" style="margin-top:8px;width:100%" on:click={dismissJustCreated}>
            {$_('settings_api_tokens.just_created.saved')}
          </button>
        </div>
      {/if}

      <div class="card settings-card">
        {#if loading && tokens.length === 0}
          <Spinner block size="sm" />
        {:else if tokens.length === 0}
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:4px;padding:14px 16px">
            <span class="setting-label">{$_('settings_api_tokens.empty.title')}</span>
            <span class="setting-desc">{$_('settings_api_tokens.empty.desc')}</span>
          </div>
        {:else}
          {#each tokens as t, i (t.id)}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="token-row">
              <div class="token-info">
                <span class="token-name">{t.name}</span>
                <span class="token-meta text-3 text-sm">
                  {$_('settings_api_tokens.row.scopes_label')} {t.scopes.join(', ') || $_('settings_api_tokens.row.scopes_none')}
                  · {$_('settings_api_tokens.row.last_used', { values: { when: _fmtRelative(t.last_used_at) } })}
                  {#if t.expires_at} · {$_('settings_api_tokens.row.expires', { values: { when: _fmtRelative(t.expires_at) } })}{/if}
                </span>
              </div>
              <button class="btn-icon" title={$_('settings_api_tokens.row.revoke_title')} on:click={() => revokeOne(t)}>
                <span class="material-symbols-rounded" style="color:var(--danger)">delete</span>
              </button>
            </div>
          {/each}
        {/if}
        <div class="setting-divider"></div>
        <div style="padding:12px 16px">
          {#if !showCreateForm}
            <button class="btn btn-secondary" style="width:100%" on:click={() => showCreateForm = true}>
              <span class="material-symbols-rounded" style="font-size:18px">add</span>
              {$_('settings_api_tokens.form.new_token')}
            </button>
          {:else}
            <div class="create-form" transition:slide={{ duration: 160 }}>
              <div class="form-group">
                <label class="form-label">{$_('settings_api_tokens.form.name')}</label>
                <input class="input" type="text" placeholder={$_('settings_api_tokens.form.name_ph')} bind:value={newName} />
              </div>
              <div class="form-group">
                <label class="form-label">{$_('settings_api_tokens.form.scopes')}</label>
                {#if mcpState.enabled || mcpState.write || mcpState.destroy}
                  <div class="mcp-status">
                    MCP on this server:
                    <span class:on={mcpState.enabled}>read {mcpState.enabled ? '✓' : '✗'}</span>
                    · <span class:on={mcpState.write}>write {mcpState.write ? '✓' : '✗'}</span>
                    · <span class:on={mcpState.destroy}>destroy {mcpState.destroy ? '✓' : '✗'}</span>
                  </div>
                {/if}
                <div class="scope-grid">
                  {#each knownScopes as s (s)}
                    <label class="scope-option">
                      <input type="checkbox" checked={newScopes.has(s)} on:change={() => toggleScope(s)} />
                      <div class="scope-text">
                        <code>{s}</code>
                        {#if scopeDescriptions[s]}
                          <span class="scope-desc">{scopeDescriptions[s]}</span>
                        {/if}
                      </div>
                    </label>
                  {/each}
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{$_('settings_api_tokens.form.expires_label')}</label>
                <input class="input" type="number" min="1" placeholder={$_('settings_api_tokens.form.expires_ph')} bind:value={newExpiresDays} />
              </div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-ghost" style="flex:1" on:click={() => { showCreateForm = false; newName = ''; }}>{$_('settings_api_tokens.form.cancel')}</button>
                <button class="btn btn-primary" style="flex:2" on:click={createNewToken} disabled={creating}>
                  {creating ? $_('settings_api_tokens.form.creating') : $_('settings_api_tokens.form.create')}
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
  .token-row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px;
  }
  .token-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
  .token-name { font-weight: 600; font-size: 14px; color: var(--text-1); }
  .token-meta { font-size: 11px; }
  .create-form { display: flex; flex-direction: column; gap: 10px; }
  .scope-grid { display: flex; flex-direction: column; gap: 6px; }
  .scope-option {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    cursor: pointer; font-size: 13px;
  }
  .scope-option:hover { background: var(--surface-2); }
  .scope-option code { font-size: 12px; color: var(--text-2); }
  .scope-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .scope-desc { font-size: 11px; color: var(--text-3); line-height: 1.3; }
  .mcp-status {
    font-size: 11px; color: var(--text-3);
    padding: 4px 8px; margin-bottom: 6px;
    background: var(--surface-2); border-radius: var(--radius-sm);
    display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  }
  .mcp-status span { color: var(--text-3); }
  .mcp-status span.on { color: var(--success, var(--accent)); font-weight: 500; }
</style>
