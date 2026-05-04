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
  import { apiUrl, isNative, getServerUrl, getAuthToken } from '../../lib/platform.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';

  // NT sub-components are body-only — the section-toggle button is
  // rendered externally in Settings.svelte. This component only renders
  // its body, gated by `expanded` from the parent (no `visible`/`onToggle`
  // contract here, matches SettingsAuth / SettingsBackup / SettingsTrace).
  export let expanded = false;
  export async function loadData() { return load(); }

  let tokens = [];
  let knownScopes = [];
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
      if (!r.ok) throw new Error('Failed to load tokens');
      const data = await r.json();
      tokens = data.tokens || [];
      knownScopes = data.known_scopes || [];
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
    if (!newName.trim()) { showError('Name required'); return; }
    if (newScopes.size === 0) { showError('At least one scope required'); return; }

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
      if (!r.ok) { showError(data.error || 'Create failed'); return; }

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
      title: `Revoke "${t.name}"?`,
      message: 'Apps using this token will immediately stop working. This cannot be undone — you would need to mint a new token and update each connected app.',
      confirmText: 'Revoke',
      dangerous: true,
    })) return;
    try {
      const r = await fetch(apiUrl(`/api/admin/api-tokens/${t.id}`), {
        method: 'DELETE', credentials: 'include', headers: _csrfHeaders(),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        showError(data.error || 'Revoke failed'); return;
      }
      showSuccess('Token revoked');
      await load();
    } catch (e) {
      showError(e.message);
    }
  }

  async function copyRaw() {
    try {
      await navigator.clipboard.writeText(justCreatedRaw);
      showSuccess('Token copied to clipboard');
    } catch {
      showError('Could not copy. Select and copy manually.');
    }
  }

  function dismissJustCreated() {
    justCreatedRaw = '';
    justCreatedName = '';
  }

  function _fmtRelative(iso) {
    if (!iso) return 'never';
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return iso;
    const ms = Date.now() - d.getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
    return d.toLocaleDateString();
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>
      <p class="sub-label" style="padding:0 0 6px">
        Bearer tokens for sister TraceApps (CookTrace, LiftTrace) or other authorized
        integrations to read your data via the federation API at <code>/api/v1/</code>.
        See <a href="https://github.com/traceapps/nutritrace/blob/main/docs/federation.md" target="_blank" rel="noopener">docs/federation.md</a>.
      </p>

      {#if justCreatedRaw}
        <div class="just-created" transition:slide={{ duration: 160 }}>
          <div class="just-created-title">
            <span class="material-symbols-rounded">key</span>
            New token: <strong>{justCreatedName}</strong>
          </div>
          <p class="just-created-warn">
            Copy this token now. You won't be able to see it again.
          </p>
          <div class="just-created-row">
            <code class="just-created-value" title={justCreatedRaw}>{justCreatedRaw}</code>
            <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px" on:click={copyRaw}>
              <span class="material-symbols-rounded" style="font-size:14px">content_copy</span>
              Copy
            </button>
          </div>
          <button class="btn btn-ghost" style="margin-top:8px;width:100%" on:click={dismissJustCreated}>
            I've saved it
          </button>
        </div>
      {/if}

      <div class="card settings-card">
        {#if loading && tokens.length === 0}
          <div class="setting-row"><span class="text-3 text-sm">Loading…</span></div>
        {:else if tokens.length === 0}
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:4px;padding:14px 16px">
            <span class="setting-label">No tokens yet</span>
            <span class="setting-desc">Create one below to let an external app read your data.</span>
          </div>
        {:else}
          {#each tokens as t, i (t.id)}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="token-row">
              <div class="token-info">
                <span class="token-name">{t.name}</span>
                <span class="token-meta text-3 text-sm">
                  scopes: {t.scopes.join(', ') || 'none'}
                  · last used {_fmtRelative(t.last_used_at)}
                  {#if t.expires_at} · expires {_fmtRelative(t.expires_at)}{/if}
                </span>
              </div>
              <button class="btn-icon" title="Revoke" on:click={() => revokeOne(t)}>
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
              New token
            </button>
          {:else}
            <div class="create-form" transition:slide={{ duration: 160 }}>
              <div class="form-group">
                <label class="form-label">Name *</label>
                <input class="input" type="text" placeholder="e.g. CookTrace, my homelab dashboard" bind:value={newName} />
              </div>
              <div class="form-group">
                <label class="form-label">Scopes *</label>
                <div class="scope-grid">
                  {#each knownScopes as s (s)}
                    <label class="scope-option">
                      <input type="checkbox" checked={newScopes.has(s)} on:change={() => toggleScope(s)} />
                      <code>{s}</code>
                    </label>
                  {/each}
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Expires after (days, optional)</label>
                <input class="input" type="number" min="1" placeholder="Leave empty to never expire" bind:value={newExpiresDays} />
              </div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-ghost" style="flex:1" on:click={() => { showCreateForm = false; newName = ''; }}>Cancel</button>
                <button class="btn btn-primary" style="flex:2" on:click={createNewToken} disabled={creating}>
                  {creating ? 'Creating…' : 'Create token'}
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
</style>
