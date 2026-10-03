<script>
  import { _ } from 'svelte-i18n';
  import { setNativeMode, setServerUrl, setAuthToken, resolveAssetUrl, iconUrl, explainConnectError } from '../lib/platform.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { DB } from '../lib/db.js';

  // State machine:
  //   'choose'      → pick local vs server
  //   'server-url'  → enter URL, click Next → validate + discover auth methods
  //   'server-auth' → show password form + OIDC buttons per what the server supports
  //   'connecting'  → in-flight (transient during network calls)
  //
  // The two-step split (server-url → server-auth) is what unlocks OIDC-only
  // servers (#110): the old single form demanded username+password to submit,
  // so users of Authentik-backed / OIDC-only NT servers couldn't get past
  // this screen on a fresh install. Now the URL is validated first, then we
  // ask the server /api/auth/status which auth methods to render.
  let step = 'choose';
  let serverUrl = '';
  let validatedUrl = '';        // set after successful step-1 validation
  let providers = [];            // OIDC providers array from /api/auth/status
  let passwordLoginEnabled = true;
  let username = '';
  let password = '';
  let showPw = false;
  let connecting = false;

  async function chooseLocal() {
    setNativeMode('local');
    setServerUrl(null);
    // Reload — SQLite will initialize naturally when NtApiNative is first called
    window.location.reload();
  }

  function chooseServer() {
    step = 'server-url';
  }

  // Step 1 → step 2: validate server reachability + discover which auth
  // methods the server supports. Uses CapacitorHttp to bypass WebView CORS.
  async function validateAndNext() {
    if (!serverUrl.trim()) { showError($_('native_setup.errors.server_url_required')); return; }
    const url = serverUrl.trim().replace(/\/$/, '');
    connecting = true;
    try {
      const { CapacitorHttp } = await import('@capacitor/core');
      const healthRes = await CapacitorHttp.get({ url: `${url}/api/health` });
      if (healthRes.status < 200 || healthRes.status >= 300) {
        throw new Error('Server not reachable');
      }
      // Discover auth methods. /api/auth/status returns { oidc: { providers, enable_email_password_login } }.
      // If the endpoint fails or returns nothing OIDC-shaped, fall back to
      // password-only rendering (safe default; matches pre-fix behaviour).
      let discoveredProviders = [];
      let discoveredPasswordEnabled = true;
      try {
        const statusRes = await CapacitorHttp.get({ url: `${url}/api/auth/status` });
        if (statusRes.status >= 200 && statusRes.status < 300) {
          const data = typeof statusRes.data === 'string' ? JSON.parse(statusRes.data) : statusRes.data;
          if (data?.oidc) {
            discoveredProviders = Array.isArray(data.oidc.providers) ? data.oidc.providers : [];
            discoveredPasswordEnabled = data.oidc.enable_email_password_login !== false;
          }
        }
      } catch { /* leave defaults — safe fallback */ }
      validatedUrl = url;
      providers = discoveredProviders;
      passwordLoginEnabled = discoveredPasswordEnabled;
      step = 'server-auth';
    } catch (e) {
      showError(explainConnectError(e, url));
    } finally {
      connecting = false;
    }
  }

  // Step 2 (password branch): traditional username+password sign-in. Unchanged
  // in behaviour from the pre-fix single-form flow — only reached when the
  // server actually has password login enabled.
  async function loginWithPassword() {
    if (!username.trim() || !password.trim()) { showError($_('native_setup.errors.credentials_required')); return; }
    connecting = true;
    try {
      const { CapacitorHttp } = await import('@capacitor/core');
      const loginRes = await CapacitorHttp.post({
        url: `${validatedUrl}/api/auth/login`,
        headers: { 'Content-Type': 'application/json' },
        data: { username: username.trim(), password },
      });
      const loginData = typeof loginRes.data === 'string' ? JSON.parse(loginRes.data) : loginRes.data;
      if (loginRes.status < 200 || loginRes.status >= 300) throw new Error(loginData.error || $_('native_setup.errors.login_failed'));

      setServerUrl(validatedUrl);
      setAuthToken(loginData.token);
      setNativeMode('server');
      DB.setSetting('setupComplete', true);
      showSuccess($_('native_setup.errors.connected'));
      window.location.reload();
    } catch (e) {
      showError(explainConnectError(e, validatedUrl));
    } finally {
      connecting = false;
    }
  }

  // Step 2 (OIDC branch): opens the Authentik/Keycloak/etc. sign-in flow in
  // the Capacitor browser. Server URL + native mode + setupComplete are
  // persisted BEFORE opening the browser because the deep-link callback
  // (App.svelte appUrlOpen handler) sets only the auth token — it relies on
  // the app already knowing which server to talk to. If the user cancels
  // mid-OIDC (backs out of the browser), the app is in a "URL known, no
  // token" state and next launch lands on Login.svelte which correctly
  // renders the OIDC button now that getServerUrl() is populated.
  async function loginWithOidc(providerId) {
    setServerUrl(validatedUrl);
    setNativeMode('server');
    DB.setSetting('setupComplete', true);
    try {
      const ret = encodeURIComponent('#/');
      const { Browser } = await import('@capacitor/browser');
      const { appChallengeParam } = await import('../lib/oidc-app-handoff.js');
      await Browser.open({
        url: `${validatedUrl}/api/auth/oidc/login/${providerId}?mobile=1&return=${ret}${await appChallengeParam()}`,
        presentationStyle: 'popover',
      });
      // Deep-link callback (nutritrace://oidc-callback?token=…) handled by
      // App.svelte's appUrlOpen listener — it sets the token, calls
      // loadAuthState, redirects to '#/', and the main app renders.
    } catch (e) {
      showError($_('native_setup.errors.browser_open_failed'));
    }
  }

  function backToChoose() {
    step = 'choose';
    serverUrl = '';
    validatedUrl = '';
    providers = [];
    passwordLoginEnabled = true;
    username = '';
    password = '';
  }

  function backToServerUrl() {
    step = 'server-url';
    validatedUrl = '';
    providers = [];
    passwordLoginEnabled = true;
    username = '';
    password = '';
  }
</script>

<div class="setup-wrap">
  <div class="setup-inner">
    <!-- Logo / branding -->
    <div class="setup-brand">
      <img src={iconUrl('/icons/icon-192.png')} alt="NutriTrace" class="setup-logo" />
      <h1 class="setup-title">NutriTrace</h1>
      <p class="setup-subtitle">{$_('native_setup.subtitle')}</p>
    </div>

    {#if step === 'choose'}
      <div class="setup-cards">
        <button class="setup-card" on:click={chooseLocal}>
          <span class="material-symbols-rounded setup-card-icon">smartphone</span>
          <div class="setup-card-title">{$_('native_setup.use_locally')}</div>
          <p class="setup-card-desc">{$_('native_setup.use_locally_desc')}</p>
        </button>

        <button class="setup-card" on:click={chooseServer}>
          <span class="material-symbols-rounded setup-card-icon">cloud_sync</span>
          <div class="setup-card-title">{$_('native_setup.connect_to_server')}</div>
          <p class="setup-card-desc">{$_('native_setup.connect_to_server_desc')}</p>
        </button>
      </div>

    {:else if step === 'server-url'}
      <div class="setup-form">
        <div class="form-group">
          <label class="form-label">{$_('native_setup.server_url')}</label>
          <input
            class="input"
            type="url"
            placeholder={$_('native_setup.server_url_placeholder')}
            bind:value={serverUrl}
            autocapitalize="off"
            autocorrect="off"
          />
          <p class="form-hint">{$_('native_setup.server_url_hint')}</p>
        </div>

        <div class="setup-form-actions">
          <button class="btn btn-ghost" on:click={backToChoose} disabled={connecting}>
            {$_('native_setup.back')}
          </button>
          <button class="btn btn-primary" on:click={validateAndNext} disabled={connecting}>
            {connecting ? $_('native_setup.checking') : $_('native_setup.next')}
          </button>
        </div>
      </div>

    {:else if step === 'server-auth'}
      <div class="setup-form">
        <p class="server-line">
          <span class="material-symbols-rounded server-icon">cloud_done</span>
          <span class="server-url">{validatedUrl}</span>
        </p>

        <!-- OIDC providers first — for OIDC-only servers this is the only
             option; for mixed servers it's the recommended flow anyway. -->
        {#if providers.length}
          <div class="oidc-list">
            {#each providers as p (p.id)}
              <button class="btn btn-primary oidc-btn" on:click={() => loginWithOidc(p.id)} disabled={connecting}>
                <!-- Provider logo when the admin configured a logo_url on this
                     OIDC provider (populated from PROVIDER_PRESETS in
                     SettingsAuth.svelte for known IdPs — Authentik, Keycloak,
                     Authelia, Google, Pocket ID, Auth0). Falls back to the
                     generic material 'login' icon when no logo is set (Custom
                     providers) or the image fails to load. Same pattern
                     Login.svelte uses for consistency. -->
                {#if p.logo_url}
                  <img src={resolveAssetUrl(p.logo_url)} alt="" class="oidc-logo" on:error={e => e.target.style.display='none'} />
                {:else}
                  <span class="material-symbols-rounded" style="font-size:20px">login</span>
                {/if}
                {$_('native_setup.oidc_sign_in_with', { values: { name: p.display_name || p.name || p.id } })}
              </button>
            {/each}
          </div>
        {/if}

        <!-- Password form only when the server has it enabled. Divider only
             shown when both auth methods are available. -->
        {#if passwordLoginEnabled && providers.length}
          <div class="auth-divider"><span>{$_('native_setup.or')}</span></div>
        {/if}
        {#if passwordLoginEnabled}
          <div class="form-group">
            <label class="form-label">{$_('native_setup.username')}</label>
            <input
              class="input"
              type="text"
              placeholder={$_('native_setup.username_placeholder')}
              bind:value={username}
              autocapitalize="off"
              autocorrect="off"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{$_('native_setup.password')}</label>
            <div style="position:relative">
              {#if showPw}
                <input class="input" type="text" placeholder={$_('native_setup.password_placeholder')} bind:value={password} style="padding-right:40px" />
              {:else}
                <input class="input" type="password" placeholder={$_('native_setup.password_placeholder')} bind:value={password} style="padding-right:40px" />
              {/if}
              <button type="button" class="pw-toggle" on:click={() => showPw = !showPw}>
                <span class="material-symbols-rounded" style="font-size:20px">{showPw ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>
        {/if}

        <!-- Edge case: server has neither password nor OIDC configured.
             Should be rare (server is misconfigured) but rendering a helpful
             message beats a blank form. -->
        {#if !providers.length && !passwordLoginEnabled}
          <div class="no-auth-warning">
            <span class="material-symbols-rounded">warning</span>
            <div>{$_('native_setup.no_auth_warning')}</div>
          </div>
        {/if}

        <div class="setup-form-actions">
          <button class="btn btn-ghost" on:click={backToServerUrl} disabled={connecting}>
            {$_('native_setup.back')}
          </button>
          {#if passwordLoginEnabled}
            <button class="btn btn-primary" on:click={loginWithPassword} disabled={connecting}>
              {connecting ? $_('native_setup.signing_in') : $_('native_setup.sign_in')}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .setup-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: 24px;
    background: var(--bg, #0A0B0F);
  }
  .setup-inner {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  .setup-brand {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .setup-logo {
    width: 80px;
    height: 80px;
    border-radius: 20px;
  }
  .setup-title {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-1);
    margin: 0;
  }
  .setup-subtitle {
    font-size: 14px;
    color: var(--text-3);
    margin: 0;
  }
  .setup-cards {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .setup-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px 20px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    cursor: pointer;
    text-align: center;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }
  .setup-card:hover {
    background: var(--surface-2);
    border-color: var(--accent, #3b82f6);
  }
  .setup-card:active {
    transform: scale(0.98);
  }
  .setup-card-icon {
    font-size: 40px;
    color: var(--accent, #3b82f6);
  }
  .setup-card-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-1);
  }
  .setup-card-desc {
    font-size: 13px;
    color: var(--text-3);
    margin: 0;
    line-height: 1.5;
  }
  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .form-hint {
    font-size: 12px;
    color: var(--text-3);
    margin: 6px 0 0;
    line-height: 1.5;
  }
  .setup-form-actions {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }
  .setup-form-actions .btn {
    flex: 1;
  }
  .pw-toggle {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; color: var(--text-3); padding: 4px;
  }
  .server-line {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    background: var(--surface-2);
    border-radius: 8px;
    font-size: 13px;
    color: var(--text-2);
  }
  .server-icon { font-size: 18px; color: var(--accent, #3b82f6); }
  .server-url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
  }
  .oidc-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .oidc-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
  }
  .oidc-logo {
    width: 20px;
    height: 20px;
    object-fit: contain;
  }
  .auth-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-3);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .auth-divider::before,
  .auth-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .no-auth-warning {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 12px 14px;
    background: color-mix(in srgb, #f59e0b 8%, transparent);
    border-left: 3px solid #f59e0b;
    border-radius: 4px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2);
  }
  .no-auth-warning .material-symbols-rounded {
    font-size: 20px;
    color: #f59e0b;
    flex-shrink: 0;
  }
</style>
