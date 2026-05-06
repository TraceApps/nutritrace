<script>
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { currentUser, userMgmtActive } from '../../stores/auth.js';
  import { isNative, getServerUrl, resolveAssetUrl, apiUrl, getAuthToken } from '../../lib/platform.js';

  // ── OIDC providers (admin) ───────────────────────────────────────────────
  let oidcProviders = [];
  let enablePasswordLogin = true;
  let oidcEditing = null;     // null | { ...providerFields } (id present = edit; absent = create)
  let oidcTestResult = null;
  let oidcBusy = false;
  let oidcSelectedPreset = 'custom'; // dropdown state during create

  // ────────────────────────────────────────────────────────────────────────
  // ⚠ KEEP IN LOCKSTEP WITH LIFTTRACE
  //   sister file: ../../../../lifttrace/src/components/settings/SettingsUserManagement.svelte
  //   This PROVIDER_PRESETS array, _getPreset, applyPreset, _detectPreset,
  //   and the OIDC editor template are intentionally identical across the two
  //   apps. When you add/remove a preset, change a default, or fix a bug
  //   here, mirror the change to LiftTrace's copy in the same commit.
  //   See `feedback_traceapps_brand.md` for the cohesion principle.
  //
  //   NutriTrace-specific: this code lives in SettingsAuth.svelte (own
  //   top-level Settings section). LiftTrace still has it inside
  //   SettingsUserManagement.svelte. When syncing, copy the PRESETS /
  //   editor template across; the surrounding Svelte structure differs.
  // ────────────────────────────────────────────────────────────────────────
  const PROVIDER_PRESETS = [
    {
      id: 'auth0',
      name: 'Auth0',
      icon: 'cloud',
      defaults: {
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_post',
        admin_group_claim: '',
        display_name: 'Auth0',
        logo_url: 'https://cdn.simpleicons.org/auth0/EB5424',
      },
      issuer_hint: 'https://<your-tenant>.auth0.com/',
      help: 'Auth0 adds custom claims under a namespaced URL like "https://nutritrace.app/roles" — leave the admin claim blank for now and contact your tenant admin to set up a rule that exposes role membership.',
      hides: [],
    },
    {
      id: 'authelia',
      name: 'Authelia',
      icon: 'lock',
      defaults: {
        scope: 'openid profile email groups',
        token_endpoint_auth_method: 'client_secret_post',
        admin_group_claim: 'groups',
        display_name: 'Authelia',
        logo_url: 'https://cdn.simpleicons.org/authelia/000000',
      },
      issuer_hint: 'https://auth.example.com',
      help: 'Authelia\'s issuer URL is the root URL where Authelia is served — no path suffix.',
      hides: [],
    },
    {
      id: 'authentik',
      name: 'Authentik',
      icon: 'verified_user',
      defaults: {
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_post',
        admin_group_claim: 'groups',
        display_name: 'Authentik',
        logo_url: '/icons/sso/authentik.svg',
      },
      issuer_hint: 'https://auth.example.com/application/o/<your-app-slug>/',
      help: 'Issuer URL is the "OpenID Configuration Issuer" shown on the Provider page in Authentik. Make sure your Application uses an OAuth2/OIDC Provider and you\'ve added the redirect URI shown above to its allowed list.',
      hides: [],
    },
    {
      id: 'google',
      name: 'Google',
      icon: 'account_circle',
      defaults: {
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_post',
        admin_group_claim: '',
        admin_group_value: '',
        display_name: 'Google',
        logo_url: 'https://cdn.simpleicons.org/google/4285F4',
      },
      issuer_hint: 'https://accounts.google.com',
      help: 'Google\'s issuer URL is fixed. Group/role claims are not available with standard scopes — admin role mapping is hidden for this provider; promote Google users manually after first login.',
      hides: ['admin_group_claim', 'admin_group_value'],
    },
    {
      id: 'keycloak',
      name: 'Keycloak',
      icon: 'shield',
      defaults: {
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
        admin_group_claim: 'groups',
        display_name: 'Keycloak',
        logo_url: 'https://cdn.simpleicons.org/keycloak/4D4D4D',
      },
      issuer_hint: 'https://auth.example.com/realms/<your-realm>',
      help: 'Add a "groups" mapper to your client\'s default scope so the groups claim is included in the ID token.',
      hides: [],
    },
    {
      id: 'pocket-id',
      name: 'Pocket ID',
      icon: 'fingerprint',
      defaults: {
        scope: 'openid profile email groups',
        token_endpoint_auth_method: 'client_secret_post',
        admin_group_claim: 'groups',
        display_name: 'Pocket ID',
        logo_url: '/icons/sso/pocket-id.svg',
      },
      issuer_hint: 'https://id.example.com',
      help: 'Pocket ID uses passkeys for primary auth — your users won\'t need a password at the IdP either. Add the redirect URI shown above to the OIDC client in Pocket ID admin.',
      hides: [],
    },
    {
      id: 'custom',
      name: 'Custom / Generic OIDC',
      icon: 'badge',
      defaults: {
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_post',
        admin_group_claim: '',
        display_name: '',
        logo_url: '',
      },
      issuer_hint: 'https://your-idp.example.com',
      help: 'Any OpenID Connect 1.0 compliant provider that supports Authorization Code Flow + PKCE + Discovery should work here.',
      hides: [],
    },
  ];

  function _getPreset(id) {
    return PROVIDER_PRESETS.find(p => p.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
  }

  $: oidcPreset = _getPreset(oidcSelectedPreset);

  function applyPreset() {
    if (!oidcEditing || oidcEditing.id) return;
    const p = _getPreset(oidcSelectedPreset);
    oidcEditing = {
      ...oidcEditing,
      ...p.defaults,
      issuer_url: oidcEditing.issuer_url,
      client_id: oidcEditing.client_id,
      client_secret: oidcEditing.client_secret,
      redirect_uris: oidcEditing.redirect_uris,
      auto_link_verified_email: oidcEditing.auto_link_verified_email,
      auto_register_new_users: oidcEditing.auto_register_new_users,
      is_active: oidcEditing.is_active,
    };
  }
  $: if (oidcSelectedPreset && oidcEditing && !oidcEditing.id) applyPreset();

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

  // Exposed: parent (Settings.svelte) calls this on section open via bind:this.
  export async function loadData() {
    if (!$userMgmtActive || $currentUser?.role !== 'admin') return;
    try {
      const r = await fetch(apiUrl('/api/admin/oidc/providers'), { credentials: 'include', headers: _csrfHeaders() });
      if (r.ok) {
        const data = await r.json();
        oidcProviders = data?.providers || [];
        enablePasswordLogin = data?.enable_email_password_login !== false;
      }
    } catch {}
  }

  function startCreateProvider() {
    oidcSelectedPreset = 'custom';
    const p = _getPreset('custom');
    oidcEditing = {
      issuer_url: '',
      client_id: '',
      client_secret: '',
      redirect_uris: [_defaultRedirectUri()],
      auto_link_verified_email: 1,
      auto_register_new_users:  0,
      admin_group_value: '',
      is_active: 1,
      ...p.defaults,
    };
    oidcTestResult = null;
  }

  function _defaultRedirectUri() {
    if (typeof window === 'undefined') return '';
    const basePath = window.__NT_CONFIG__?.basePath || '';
    const id = oidcEditing?.id || ':providerId';
    return `${window.location.origin}${basePath}/api/auth/oidc/callback/${id}`;
  }

  function startEditProvider(p) {
    oidcEditing = {
      ...p,
      client_secret: '',
      redirect_uris: Array.isArray(p.redirect_uris) ? [...p.redirect_uris] : [],
    };
    oidcSelectedPreset = _detectPreset(p);
    oidcTestResult = null;
  }

  function _detectPreset(p) {
    const dn = (p.display_name || '').toLowerCase();
    const issuer = (p.issuer_url || '').toLowerCase();
    if (dn.includes('authentik') || issuer.includes('/application/o/')) return 'authentik';
    if (dn.includes('keycloak')  || issuer.includes('/realms/'))         return 'keycloak';
    if (dn.includes('authelia'))                                          return 'authelia';
    if (dn.includes('pocket'))                                            return 'pocket-id';
    if (dn.includes('auth0')     || issuer.includes('.auth0.com'))       return 'auth0';
    if (dn.includes('google')    || issuer.includes('accounts.google'))  return 'google';
    return 'custom';
  }

  function cancelProviderEdit() {
    oidcEditing = null;
    oidcTestResult = null;
  }

  async function saveProvider() {
    if (oidcBusy) return;
    if (!oidcEditing.issuer_url?.trim() || !oidcEditing.client_id?.trim()) {
      showError('Issuer URL and Client ID are required');
      return;
    }
    if (!oidcEditing.redirect_uris?.filter(Boolean).length) {
      showError('At least one redirect URI is required');
      return;
    }
    oidcBusy = true;
    try {
      const isEdit = !!oidcEditing.id;
      const url = isEdit
        ? apiUrl(`/api/admin/oidc/providers/${oidcEditing.id}`)
        : apiUrl(`/api/admin/oidc/providers`);
      const body = { ...oidcEditing };
      if (isEdit && !body.client_secret) delete body.client_secret;
      const r = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        credentials: 'include',
        headers: _csrfHeaders(),
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) { showError(data?.error || 'Save failed'); return; }
      showSuccess(isEdit ? 'Provider updated' : 'Provider created');
      oidcEditing = null;
      await loadData();
    } catch (e) {
      showError('Could not reach server');
    } finally {
      oidcBusy = false;
    }
  }

  async function testProvider(id) {
    oidcBusy = true;
    oidcTestResult = null;
    try {
      const r = await fetch(apiUrl(`/api/admin/oidc/providers/${id}/test`), {
        method: 'POST', credentials: 'include', headers: _csrfHeaders(),
      });
      oidcTestResult = await r.json();
    } catch (e) {
      oidcTestResult = { ok: false, error: 'Could not reach server' };
    } finally { oidcBusy = false; }
  }

  async function deleteProvider(p) {
    if (!confirm(`Delete provider "${p.display_name || p.issuer_url}"? Linked users will lose this sign-in option.`)) return;
    oidcBusy = true;
    try {
      const r = await fetch(apiUrl(`/api/admin/oidc/providers/${p.id}`), {
        method: 'DELETE', credentials: 'include', headers: _csrfHeaders(),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        showError(data?.error || 'Delete failed'); return;
      }
      showSuccess('Provider deleted');
      await loadData();
    } catch { showError('Could not reach server'); }
    finally { oidcBusy = false; }
  }

  async function togglePasswordLogin() {
    const next = !enablePasswordLogin;
    if (!next && !oidcProviders.some(p => p.is_active)) {
      showError('Add at least one active OIDC provider before disabling password login.');
      return;
    }
    if (!next && !confirm('Disable password login? Users without an OIDC link will not be able to sign in until you re-enable it. RECOVERY_TOKEN will still work.')) return;
    try {
      const r = await fetch(apiUrl('/api/admin/oidc/password-login'), {
        method: 'PUT', credentials: 'include', headers: _csrfHeaders(),
        body: JSON.stringify({ enabled: next }),
      });
      const data = await r.json();
      if (!r.ok) { showError(data?.error || 'Save failed'); return; }
      enablePasswordLogin = !!data.enable_email_password_login;
      showSuccess(enablePasswordLogin ? 'Password login enabled' : 'Password login disabled');
    } catch { showError('Could not reach server'); }
  }

  function addRedirectUri() {
    if (!oidcEditing) return;
    oidcEditing.redirect_uris = [...(oidcEditing.redirect_uris || []), ''];
  }
  function removeRedirectUri(i) {
    if (!oidcEditing) return;
    oidcEditing.redirect_uris = oidcEditing.redirect_uris.filter((_, idx) => idx !== i);
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>
  {#if !$userMgmtActive}
    <div class="card settings-card">
      <div class="setting-row">
        <div>
          <span class="setting-label">User Management is required</span>
          <div class="setting-desc">Single Sign-On is scoped to user accounts, so User Management has to be enabled first. Set it up in <strong>Settings → User Management</strong>, then come back here.</div>
        </div>
      </div>
    </div>
  {:else if $currentUser?.role !== 'admin'}
    <div class="card settings-card">
      <div class="setting-row">
        <div>
          <span class="setting-label">Admin only</span>
          <div class="setting-desc">Only admins can configure identity providers. If you need this access, ask the admin of this NutriTrace instance to promote your account.</div>
        </div>
      </div>
    </div>
  {:else}
    <div class="card settings-card">
      <div class="setting-row" style="display:flex;flex-direction:column;align-items:stretch;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div>
            <span class="setting-label">OIDC providers (Single Sign-On)</span>
            <div class="setting-desc">Authentik, Keycloak, Pocket ID, Authelia, Auth0, Google, etc. Users sign in with their existing identity provider.</div>
          </div>
          <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px;white-space:nowrap" on:click={startCreateProvider}>
            + Add provider
          </button>
        </div>

        {#each oidcProviders as p (p.id)}
          <div class="oidc-row">
            {#if p.logo_url}<img src={resolveAssetUrl(p.logo_url)} alt="" class="oidc-logo" />{:else}<span class="material-symbols-rounded oidc-icon">verified_user</span>{/if}
            <div class="oidc-info">
              <span class="oidc-name">
                {p.display_name || p.issuer_url}
                {#if p.env_locked}
                  <span class="env-lock-badge" title="Configured via environment variables — edit your .env / docker-compose to change">
                    <span class="material-symbols-rounded" style="font-size:12px">lock</span>
                    env
                  </span>
                {/if}
              </span>
              <span class="text-3 text-sm">{p.issuer_url} · link {p.auto_link_verified_email ? 'on' : 'off'} · register {p.auto_register_new_users ? 'on' : 'off'}{!p.is_active ? ' · disabled' : ''}</span>
            </div>
            <div class="oidc-actions">
              <button class="btn-icon" title="Test discovery" on:click={() => testProvider(p.id)} disabled={oidcBusy}>
                <span class="material-symbols-rounded">network_check</span>
              </button>
              {#if p.env_locked}
                <button class="btn-icon" title="Configured via environment — read-only" disabled>
                  <span class="material-symbols-rounded" style="opacity:0.4">lock</span>
                </button>
              {:else}
                <button class="btn-icon" title="Edit" on:click={() => startEditProvider(p)} disabled={oidcBusy}>
                  <span class="material-symbols-rounded">edit</span>
                </button>
                <button class="btn-icon" title="Delete" on:click={() => deleteProvider(p)} disabled={oidcBusy}>
                  <span class="material-symbols-rounded" style="color:var(--danger)">delete</span>
                </button>
              {/if}
            </div>
          </div>
        {/each}

        {#if !oidcProviders.length}
          <p class="text-3 text-sm" style="margin:0">No providers configured yet. Click <strong>+ Add provider</strong> to set one up, or define them in your <code>.env</code> using the <code>OIDC_*</code> variables (see README).</p>
        {/if}

        {#if oidcTestResult}
          <div class="oidc-test-result" class:ok={oidcTestResult.ok}>
            {#if oidcTestResult.ok}
              <strong>Discovery OK</strong>
              <div class="text-3 text-sm">issuer: {oidcTestResult.issuer}</div>
              <div class="text-3 text-sm">authorization_endpoint: {oidcTestResult.authorization_endpoint || '—'}</div>
              <div class="text-3 text-sm">token_endpoint: {oidcTestResult.token_endpoint || '—'}</div>
              <div class="text-3 text-sm">end_session_endpoint: {oidcTestResult.end_session_endpoint || '—'}</div>
            {:else}
              <strong style="color:var(--danger)">Discovery failed</strong>
              <div class="text-3 text-sm">{oidcTestResult.error}</div>
            {/if}
          </div>
        {/if}

        {#if oidcEditing}
          <div class="oidc-form" transition:slide={{ duration: 180 }}>
            {#if !oidcEditing.id}
              <div class="form-group">
                <label class="form-label">Provider Type</label>
                <div class="oidc-preset-grid">
                  {#each PROVIDER_PRESETS as preset (preset.id)}
                    <button
                      type="button"
                      class="oidc-preset-card"
                      class:selected={oidcSelectedPreset === preset.id}
                      on:click={() => oidcSelectedPreset = preset.id}
                      title={preset.name}
                    >
                      {#if preset.defaults.logo_url}
                        <img src={resolveAssetUrl(preset.defaults.logo_url)} alt="" class="oidc-preset-logo" />
                      {:else}
                        <span class="material-symbols-rounded oidc-preset-icon">{preset.icon}</span>
                      {/if}
                      <span class="oidc-preset-name">{preset.name}</span>
                    </button>
                  {/each}
                </div>
                {#if oidcPreset.help}
                  <div class="text-3 text-sm" style="margin-top:8px;line-height:1.4">
                    <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">info</span>
                    {oidcPreset.help}
                  </div>
                {/if}
              </div>
            {/if}
            <div class="form-group">
              <label class="form-label">Display Name</label>
              <input class="input" bind:value={oidcEditing.display_name} placeholder={oidcPreset.defaults.display_name || 'Authentik / Pocket ID / Google'} />
            </div>
            <div class="form-group">
              <label class="form-label">Issuer URL *</label>
              <input class="input" bind:value={oidcEditing.issuer_url} placeholder={oidcPreset.issuer_hint} autocomplete="url" />
            </div>
            <div class="form-group">
              <label class="form-label">Client ID *</label>
              <input class="input" bind:value={oidcEditing.client_id} autocomplete="off" />
            </div>
            <div class="form-group">
              <label class="form-label">Client secret {oidcEditing.id ? '(leave blank to keep existing)' : '*'}</label>
              <input class="input" type="password" bind:value={oidcEditing.client_secret} autocomplete="off" />
            </div>
            <div class="form-group">
              <label class="form-label">Redirect URIs *</label>
              {#each oidcEditing.redirect_uris as uri, i}
                <div style="display:flex;gap:6px;margin-bottom:4px">
                  <input class="input" style="flex:1" bind:value={oidcEditing.redirect_uris[i]} placeholder="https://nutritrace.app/api/auth/oidc/callback/{oidcEditing.id || ':providerId'}" />
                  {#if oidcEditing.redirect_uris.length > 1}
                    <button class="btn-icon" on:click={() => removeRedirectUri(i)} title="Remove"><span class="material-symbols-rounded">close</span></button>
                  {/if}
                </div>
              {/each}
              <button class="btn btn-ghost btn-sm" type="button" on:click={addRedirectUri}>+ Add redirect URI</button>
              <div class="text-3 text-sm" style="margin-top:4px">Must match exactly what your IdP has configured. The path is <code>/api/auth/oidc/callback/&lt;provider-id&gt;</code> under your NutriTrace base URL.</div>
            </div>
            <div class="form-group">
              <label class="form-label">Scope</label>
              <input class="input" bind:value={oidcEditing.scope} />
            </div>
            <div class="form-group">
              <label class="form-label">Token endpoint auth method</label>
              <select class="select" bind:value={oidcEditing.token_endpoint_auth_method}>
                <option value="client_secret_post">client_secret_post (default)</option>
                <option value="client_secret_basic">client_secret_basic</option>
                <option value="none">none (PKCE-only public client)</option>
              </select>
            </div>
            <div class="setting-row" style="padding:0">
              <div>
                <span class="setting-label">Auto-Link Existing Users (Verified Email)</span>
                <div class="setting-desc">When the IdP says <code>email_verified=true</code> and the email matches an existing NutriTrace user, link them silently on first SSO sign-in. Recommended ON for any IdP you trust to verify emails.</div>
              </div>
              <Toggle checked={!!oidcEditing.auto_link_verified_email} on:change={e => oidcEditing.auto_link_verified_email = e.detail ? 1 : 0} />
            </div>
            <div class="setting-row" style="padding:0">
              <div>
                <span class="setting-label">Auto-Register New Users</span>
                <div class="setting-desc">Allow anyone with an account at this IdP to create a brand-new NutriTrace account on first sign-in. OFF = admin must invite first. Leave OFF for shared IdPs (Google, work SSO) unless you actually want blanket onboarding.</div>
              </div>
              <Toggle checked={!!oidcEditing.auto_register_new_users} on:change={e => oidcEditing.auto_register_new_users = e.detail ? 1 : 0} />
            </div>
            <div class="setting-row" style="padding:0">
              <div>
                <span class="setting-label">Provider Active</span>
                <div class="setting-desc">Inactive providers won't show on the Login page.</div>
              </div>
              <Toggle checked={!!oidcEditing.is_active} on:change={e => oidcEditing.is_active = e.detail ? 1 : 0} />
            </div>
            {#if !oidcPreset.hides?.includes('admin_group_claim')}
              <div class="form-group">
                <label class="form-label">Admin group claim (optional)</label>
                <input class="input" bind:value={oidcEditing.admin_group_claim} placeholder="groups" />
                <div class="text-3 text-sm">Name of the claim that lists user groups. Common: <code>groups</code>.</div>
              </div>
            {/if}
            {#if !oidcPreset.hides?.includes('admin_group_value')}
              <div class="form-group">
                <label class="form-label">Admin group value (optional)</label>
                <input class="input" bind:value={oidcEditing.admin_group_value} placeholder="NutriTraceAdmins" />
                <div class="text-3 text-sm">If a user's groups claim contains this value, they're set to admin on each login.</div>
              </div>
            {/if}
            <div class="form-group">
              <label class="form-label">Logo URL (optional)</label>
              <input class="input" bind:value={oidcEditing.logo_url} placeholder="https://…/authentik.png" />
            </div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn btn-ghost" style="flex:1" on:click={cancelProviderEdit}>Cancel</button>
              <button class="btn btn-primary" style="flex:1" on:click={saveProvider} disabled={oidcBusy}>
                {oidcBusy ? 'Saving…' : (oidcEditing.id ? 'Save changes' : 'Create provider')}
              </button>
            </div>
          </div>
        {/if}
      </div>

      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Allow Password Login</span>
          <div class="setting-desc">When off, users sign in only via OIDC. Recovery still works via the <code>RECOVERY_TOKEN</code> env var.</div>
        </div>
        <Toggle checked={enablePasswordLogin} on:change={togglePasswordLogin} />
      </div>
    </div>
  {/if}
</div>

<style>
  /* Mirror Settings.svelte scoped styles so cards look identical */
  .section-body { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }
  .settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
  .setting-label { font-size: 14px; font-weight: 500; flex: 1; }
  .setting-desc  { font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .oidc-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md);
  }
  .oidc-logo { width: 22px; height: 22px; object-fit: contain; flex: 0 0 auto; }
  .oidc-icon { font-size: 22px; flex: 0 0 auto; color: var(--text-3); }
  .oidc-info { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .oidc-info > * { min-width: 0; word-break: break-word; overflow-wrap: anywhere; }
  .oidc-name { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .oidc-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .env-lock-badge {
    display: inline-flex; align-items: center; gap: 2px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: var(--radius-sm, 4px);
    background: color-mix(in srgb, var(--text-3) 18%, transparent);
    color: var(--text-3);
  }
  .oidc-test-result {
    padding: 10px; border-radius: var(--radius-md);
    background: var(--surface-2); border: 1px solid var(--border);
  }
  .oidc-test-result.ok { border-color: var(--success, #22c55e); }
  .oidc-form {
    display: flex; flex-direction: column; gap: 8px;
    padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .oidc-preset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 8px;
  }
  .oidc-preset-card {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 12px 8px;
    border: 1.5px solid var(--border); border-radius: var(--radius-md);
    background: var(--surface-1, var(--bg));
    cursor: pointer;
    color: inherit; font: inherit;
    transition: border-color 120ms, background 120ms;
  }
  .oidc-preset-card:hover { border-color: var(--accent); }
  .oidc-preset-card.selected {
    border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .oidc-preset-logo, .oidc-preset-icon { width: 28px; height: 28px; }
  .oidc-preset-icon { font-size: 28px !important; color: var(--text-3); }
  .oidc-preset-card.selected .oidc-preset-icon { color: var(--accent); }
  .oidc-preset-name { font-size: 12px; font-weight: 600; text-align: center; }
</style>
