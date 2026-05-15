<script>
  import { onMount } from 'svelte';
  import { currentUser, userMgmtActive, loadAuthState } from '../stores/auth.js';
  import { loadServerSettings } from '../stores/settings.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { push } from 'svelte-spa-router';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { apiUrl, isNative, getServerUrl, setAuthToken, resolveAssetUrl } from '../lib/platform.js';

  let username = '';
  let password = '';
  let loading  = false;

  let showRecovery  = false;
  let recovering    = false;
  let recoveryDone  = false;
  let recoveryToken = '';

  // OIDC providers + password-login flag are returned by /api/auth/status.
  // Native (Capacitor server-mode) routes the auth flow through
  // @capacitor/browser; the IdP redirects back via a nutritrace://oidc-callback
  // deep link which App.svelte handles. Native local mode skips OIDC entirely
  // since there's no server to talk to.
  let oidcProviders = [];
  let passwordLoginEnabled = true;
  // Biometric sign-in (Android server-mode only). Ready when hardware supports
  // it AND the user has previously logged in with biometric enabled (so a
  // saved JWT exists in Preferences ready to be unlocked).
  let _biometricReady = false;
  onMount(async () => {
    if (isNative && !getServerUrl()) return; // standalone — skip
    try {
      const r = await fetch(apiUrl('/api/auth/status'), { credentials: 'include' });
      if (r.ok) {
        const data = await r.json();
        if (data?.oidc) {
          oidcProviders = Array.isArray(data.oidc.providers) ? data.oidc.providers : [];
          passwordLoginEnabled = data.oidc.enable_email_password_login !== false;
        }
      }
    } catch {}
    // Probe biometric availability + saved-token presence concurrently
    if (isNative && getServerUrl()) {
      try {
        const bio = await import('../lib/biometric.js');
        const [available, saved] = await Promise.all([bio.isAvailable(), bio.readSavedToken()]);
        _biometricReady = available && !!saved;
      } catch {}
    }
  });

  async function biometricLogin() {
    try {
      const bio = await import('../lib/biometric.js');
      const ok = await bio.authenticate('Sign in to NutriTrace');
      if (!ok) return;
      const saved = await bio.readSavedToken();
      if (!saved) { showError('No saved sign-in. Please use your password once first.'); return; }
      setAuthToken(saved);
      // Bring the auth state up by hitting /me — also refreshes CSRF token.
      await loadAuthState();
      const cached = JSON.parse(localStorage.getItem('nt:cachedUser') || 'null');
      if (cached) currentUser.set(cached);
      await loadServerSettings();
      push('/');
    } catch (e) {
      showError('Biometric sign-in failed. Use your password instead.');
    }
  }

  async function startOidc(providerId) {
    const ret = encodeURIComponent(window.location.hash || '#/');
    if (isNative) {
      // Capacitor: open in @capacitor/browser. The mobile=1 flag tells
      // the server to redirect via the nutritrace://oidc-callback deep
      // link instead of setting an HttpOnly cookie + SPA hash redirect.
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({
        url: apiUrl(`/api/auth/oidc/login/${providerId}?mobile=1&return=${ret}`),
        presentationStyle: 'popover',
      });
      return;
    }
    window.location.href = apiUrl(`/api/auth/oidc/login/${providerId}?return=${ret}`);
  }

  async function login() {
    if (!username.trim() || !password) return;
    loading = true;
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || $_('login.errors.failed')); return; }
      // Store auth token for native server mode
      if (isNative && data.token) setAuthToken(data.token);
      // If biometric login is enabled, stash the JWT so the next launch
      // can unlock with fingerprint/face instead of typing the password.
      if (isNative && data.token) {
        try {
          const { biometricLoginEnabled } = await import('../stores/settings.js');
          const { saveTokenForBiometric } = await import('../lib/biometric.js');
          const { get } = await import('svelte/store');
          if (get(biometricLoginEnabled)) await saveTokenForBiometric(data.token);
        } catch {}
      }
      // Cache user for offline fallback
      localStorage.setItem('wl:userId', String(data.user.id));
      localStorage.setItem('nt:cachedUser', JSON.stringify(data.user));
      localStorage.setItem('nt:cachedUserMgmt', '1');
      currentUser.set(data.user);
      // Refresh CSRF token from /api/auth/me before any state-changing request
      // can fire (otherwise reactive settings saves would use a stale csrf from
      // a previous session and 403). loadAuthState() handles the fetch and
      // populates localStorage.nt:csrf as a side effect.
      await loadAuthState();
      await loadServerSettings();
      push('/');
    } catch(e) {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      loading = false;
    }
  }

  async function recover() {
    if (!confirm($_('login.recovery.confirm'))) return;
    recovering = true;
    try {
      const res = await fetch(apiUrl('/api/auth/recover'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: recoveryToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || $_('login.recovery.failed')); return; }
      localStorage.removeItem('wl:userId');
      await loadAuthState();
      recoveryDone = true;
      showSuccess($_('login.recovery.success'));
    } catch(e) {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      recovering = false;
    }
  }

  function onKey(e) { if (e.key === 'Enter') login(); }
</script>

<div class="login-page">
  <div class="login-card card">
    <div class="login-logo">
      <img src={resolveAssetUrl('/icons/logo.png')} alt="NutriTrace" class="logo-img" />
      <h1 class="login-title">NutriTrace</h1>
      <p class="text-3 text-sm">{$_('login.subtitle')}</p>
    </div>

    {#if !recoveryDone}
      {#if oidcProviders.length}
        <div class="sso-row">
          {#each oidcProviders as p (p.id)}
            <button class="btn btn-secondary sso-btn" on:click={() => startOidc(p.id)} type="button">
              {#if p.logo_url}
                <img src={resolveAssetUrl(p.logo_url)} alt="" class="sso-logo" />
              {:else}
                <span class="material-symbols-rounded sso-icon">login</span>
              {/if}
              <span>{$_('login.sso_sign_in_with', { values: { provider: p.display_name || 'SSO' } })}</span>
            </button>
          {/each}
        </div>
        {#if passwordLoginEnabled}
          <div class="sso-divider"><span>{$_('login.sso_or')}</span></div>
        {/if}
      {/if}

      {#if passwordLoginEnabled}
        <div class="form-group">
          <label class="form-label">{$_('login.username')}</label>
          <input class="input" type="text" autocomplete="username"
            bind:value={username} on:keydown={onKey}
            placeholder={$_('login.username_placeholder')} autofocus />
        </div>

        <div class="form-group">
          <label class="form-label">{$_('login.password')}</label>
          <input class="input" type="password" autocomplete="current-password"
            bind:value={password} on:keydown={onKey}
            placeholder={$_('login.password_placeholder')} />
        </div>

        <button class="btn btn-primary w-full" class:loading on:click={login} disabled={loading || !username || !password}>
          {loading ? $_('login.signing_in') : $_('login.sign_in')}
        </button>

        {#if _biometricReady}
          <button class="btn btn-secondary w-full" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px"
            on:click={biometricLogin} disabled={loading}>
            <span class="material-symbols-rounded" style="font-size:20px">fingerprint</span>
            <span>Sign In with Biometric</span>
          </button>
        {/if}

        <div style="text-align:center">
          <button class="recovery-toggle" on:click={() => push('/forgot-password')}>{$_('login.forgot_password')}</button>
        </div>
      {:else if !oidcProviders.length}
        <p class="text-3 text-sm" style="text-align:center">{$_('login.no_signin_methods')}</p>
      {/if}

      <!-- Locked out recovery -->
      <button class="recovery-toggle" on:click={() => showRecovery = !showRecovery}>
        {showRecovery ? $_('common.hide') : $_('login.locked_out')}
      </button>

      {#if showRecovery}
        <div class="recovery-box" transition:slide={{ duration: 180 }}>
          <span class="material-symbols-rounded" style="font-size:20px;color:var(--warning,#f59e0b)">warning</span>
          <p>{@html $_('login.recovery.explainer')}</p>
          <p style="margin:0">{$_('login.recovery.token_prompt')}</p>
          <input class="input" type="password" bind:value={recoveryToken} placeholder={$_('login.recovery.token_placeholder')} />
          <button class="btn btn-secondary" style="width:100%;border-color:var(--danger);color:var(--danger)"
            on:click={recover} disabled={recovering || !recoveryToken.trim()}>
            {recovering ? $_('login.recovery.disabling') : $_('login.recovery.action')}
          </button>
        </div>
      {/if}
    {:else}
      <div style="text-align:center;padding:8px 0">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--accent)">check_circle</span>
        <p style="margin-top:8px;color:var(--text-2)">{@html $_('login.recovery.done')}</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .login-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
  }
  .login-card {
    width: 100%;
    max-width: 360px;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .login-logo {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    text-align: center;
  }
  .logo-img {
    width: 72px;
    height: 72px;
    border-radius: 16px;
    object-fit: cover;
  }
  .login-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0;
  }
  .recovery-toggle {
    background: none;
    border: none;
    color: var(--text-3);
    font-size: 13px;
    cursor: pointer;
    text-align: center;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .recovery-toggle:hover { color: var(--text-2); }
  .recovery-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.5;
  }
  .sso-row { display: flex; flex-direction: column; gap: 8px; }
  .sso-btn { display: flex; align-items: center; gap: 10px; justify-content: center; width: 100%; }
  .sso-logo { width: 18px; height: 18px; object-fit: contain; }
  .sso-icon { font-size: 18px; }
  .sso-divider {
    display: flex; align-items: center; gap: 12px;
    color: var(--text-3); font-size: 12px;
    margin: 4px 0;
  }
  .sso-divider::before, .sso-divider::after {
    content: ''; flex: 1; height: 1px; background: var(--border);
  }
</style>
