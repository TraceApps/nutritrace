<script>
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

      <div style="text-align:center">
        <button class="recovery-toggle" on:click={() => push('/forgot-password')}>{$_('login.forgot_password')}</button>
      </div>

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
</style>
