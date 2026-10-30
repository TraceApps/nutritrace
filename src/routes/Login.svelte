<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { currentUser, userMgmtActive, loadAuthState, signInProblem, authUnreachable, setupRequired, sessionEnded } from '../stores/auth.js';
  import { loadServerSettings } from '../stores/settings.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { push } from 'svelte-spa-router';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { apiUrl, isNative, getServerUrl, setAuthToken, resolveAssetUrl, iconUrl } from '../lib/platform.js';
  import { cookieBlockedByHttp, droppedCookieReason } from '../lib/cookie-check.js';
  import { responseJson, discoverSignIn, statusError, serverProblem } from '../lib/server-signin.js';
  import CookieWarning from '../components/ui/CookieWarning.svelte';
  import { isShortcutHash } from '../lib/app-shortcut.js';
  import { twoStepChallenge } from '../lib/two-step.js';
  import TwoStepChallenge from '../components/two-step/TwoStepChallenge.svelte';

  let username = '';
  let password = '';
  let loading  = false;

  let showRecovery  = false;
  let recovering    = false;
  let recoveryDone  = false;
  let recoveryToken = '';
  // Locked Out? can also reset two-step sign-in for one account (#222).
  let recoveryUsername = '';
  let resettingTwoStep = false;

  // Two-step sign-in (#222): after a right password, the server may ask for
  // a code ('verify') or for setup ('setup'). Null while it doesn't.
  let challenge = null;
  let challengeShortcut = false;

  // OIDC providers + password-login flag are returned by /api/auth/status.
  // Native (Capacitor server-mode) routes the auth flow through
  // @capacitor/browser; the IdP redirects back via a nutritrace://oidc-callback
  // deep link which App.svelte handles. Native local mode skips OIDC entirely
  // since there's no server to talk to.
  let oidcProviders = [];
  let passwordLoginEnabled = true;
  // Why signing in won't stick, if it won't: 'http' when this page is plain
  // HTTP and the server's cookie is HTTPS-only, 'dropped' when a sign-in
  // succeeded but the browser still didn't keep the cookie. See cookie-check.js.
  let authStatus = null;
  // Biometric sign-in (Android server-mode only). Ready when hardware supports
  // it AND the user has previously logged in with biometric enabled (so a
  // saved JWT exists in Preferences ready to be unlocked).
  let _biometricReady = false;
  // The server's sign-in options (lib/server-signin.js). When they couldn't
  // be loaded, the page says so with a Retry instead of quietly showing a
  // password form without single sign-on (#36).
  let optionsError = '';  // why the options couldn't be read (serverProblem), shown with Retry
  let optionsLoading = false;
  async function loadSignInOptions() {
    optionsLoading = true;
    try {
      // The app asks natively (no CORS, so a sign-in proxy's page is said as
      // such, not "Failed to fetch"); the web page asks its own origin.
      let data;
      if (isNative) data = (await discoverSignIn(getServerUrl())).status;
      else {
        const r = await fetch(apiUrl('/api/auth/status'), { credentials: 'include' });
        data = await responseJson(r);
        if (!r.ok) throw statusError(r.status, data);
      }
      authStatus = data;
      if (cookieBlockedByHttp(data, { native: isNative })) signInProblem.set('http');
      oidcProviders = Array.isArray(data?.oidc?.providers) ? data.oidc.providers : [];
      passwordLoginEnabled = data?.oidc?.enable_email_password_login !== false;
      optionsError = '';
    } catch (e) {
      console.warn('[login] sign-in options:', e?.status || e?.message);
      optionsError = serverProblem(e);
    } finally {
      optionsLoading = false;
    }
  }

  // The one reason the page shows (lib/server-signin.js serverProblem). A
  // proxy's page on the web means its own sign-in ran out; in the app, that
  // the app can't get past it.
  $: problem = $authUnreachable || optionsError || null;
  function problemText(why, t) {
    if (why === 'proxy') return isNative ? t('server_signin.web_page') : t('server_signin.proxy_web');
    if (why === 'server_error') return t('server_signin.server_error');
    if (why === 'unreachable') return t('server_signin.unreachable');
    return t('server_signin.options_failed');
  }

  // The server couldn't say who is signed in when the app opened (stores/
  // auth.js): Retry asks again, and a session that's still good opens the
  // app; otherwise the sign-in options load as usual.
  let retrying = false;
  async function retryServer() {
    retrying = true;
    try {
      await loadAuthState();
      // A fresh install now answering: its setup, as on a first visit.
      if (get(setupRequired)) { push('/wizard'); return; }
      if (!get(authUnreachable)) await loadSignInOptions();
    } finally {
      retrying = false;
    }
  }

  onMount(async () => {
    if (isNative && !getServerUrl()) return; // standalone: skip
    await loadSignInOptions();
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
    // An app icon shortcut waiting under this screen (#278) opens once signed in.
    const shortcutWaiting = isShortcutHash(window.location.hash);
    try {
      const bio = await import('../lib/biometric.js');
      const ok = await bio.authenticate($_('login.biometric.prompt'));
      if (!ok) return;
      const saved = await bio.readSavedToken();
      if (!saved) { showError($_('login.biometric.no_saved')); return; }
      setAuthToken(saved);
      // Bring the auth state up by hitting /me — also refreshes CSRF token.
      await loadAuthState();
      const cached = JSON.parse(localStorage.getItem('nt:cachedUser') || 'null');
      // If /me rejected the saved token (expired, JWT_SECRET rotated,
      // backup restored, server URL changed), loadAuthState cleared the
      // cached user. Without an explicit check the user would briefly
      // land on '/' and bounce right back to Login — looks like
      // biometric "did nothing." Surface the error + wipe the stale
      // stash so the next tap doesn't repeat the loop. Confirmed by
      // logcat 2026-06-09: token in biometric stash expired exactly at
      // the 30-day mark while user kept tapping biometric.
      if (!cached) {
        showError($_('login.biometric.expired'));
        await bio.clearSavedToken();
        return;
      }
      currentUser.set(cached);
      await loadServerSettings();
      if (!shortcutWaiting) push('/');
    } catch (e) {
      console.warn('[login] biometric flow failed:', e);
      showError($_('login.biometric.failed'));
    }
  }

  // One sign-in at a time: a second tap would open another browser and
  // replace the code's secret, so the first one's hand-off would fail.
  let ssoOpening = false;
  async function startOidc(providerId) {
    if (ssoOpening) return;
    const ret = encodeURIComponent(window.location.hash || '#/');
    if (isNative) {
      ssoOpening = true;
      try { await _openNativeSso(providerId, ret); }
      catch { showError($_('native_setup.errors.browser_open_failed')); }
      finally { ssoOpening = false; }
      return;
    }
    // The web page leaves for the sign-in page; the button stays off.
    ssoOpening = true;
    window.location.href = apiUrl(`/api/auth/oidc/login/${providerId}?return=${ret}`);
  }

  async function _openNativeSso(providerId, ret) {
    // Capacitor: open in @capacitor/browser. The mobile=1 flag tells
    // the server to redirect via the nutritrace://oidc-callback deep
    // link instead of setting an HttpOnly cookie + SPA hash redirect.
    const { Browser } = await import('@capacitor/browser');
    const { appChallengeParam } = await import('../lib/oidc-app-handoff.js');
    await Browser.open({
      url: apiUrl(`/api/auth/oidc/login/${providerId}?mobile=1&return=${ret}${await appChallengeParam()}`),
      presentationStyle: 'popover',
    });
  }

  async function login() {
    if (!username.trim() || !password) return;
    // An app icon shortcut waiting under this screen (#278) opens once signed
    // in: read now, as the Diary may take it (and change the address) first.
    const shortcutWaiting = isShortcutHash(window.location.hash);
    loading = true;
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      // A sign-in proxy's page in place of the answer says so (#36).
      let data;
      try { data = await responseJson(res); } catch (e) { showError(e.message); return; }
      const ch = twoStepChallenge(data);
      if (ch) { challenge = ch; challengeShortcut = shortcutWaiting; return; }
      if (!res.ok || !data.user) { showError(data.error || $_('login.errors.failed')); return; }
      await signedIn(data, shortcutWaiting);
    } catch(e) {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      loading = false;
    }
  }

  // The second step finished: signed in as with a password alone.
  async function twoStepDone(e) {
    const data = e.detail || {};
    loading = true;
    try {
      await signedIn(data, challengeShortcut);
      if (data.recovery_codes_left != null) {
        showSuccess($_('two_step.signin.recovery_used', { values: { count: data.recovery_codes_left } }));
      }
    } catch {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      loading = false;
    }
  }
  function twoStepRestart(e) {
    challenge = null;
    password = '';
    if (e.detail?.message) showError(e.detail.message);
  }

  // Signed in: the session (cookie on the web, token in the app), then the app.
  async function signedIn(data, shortcutWaiting) {
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
    // Web: don't set the user here. loadAuthState() below reads it back
    // from the server, so the app only appears once the session cookie has
    // actually stuck; setting it early flashed the app for a moment before
    // a dropped cookie sent the user back. Native signs in with a token.
    if (isNative) currentUser.set(data.user);
    // Refresh CSRF token from /api/auth/me before any state-changing request
    // can fire (otherwise reactive settings saves would use a stale csrf from
    // a previous session and 403). loadAuthState() handles the fetch and
    // populates localStorage.nt:csrf as a side effect.
    await loadAuthState();
    // The password was right but the session didn't stick: the browser
    // dropped the cookie. Say why here instead of looping back to sign-in.
    // get(), not $currentUser: setting the user above can tear this page
    // down, and a torn-down page's $store stops updating.
    challenge = null;
    if (!isNative && !get(currentUser)) {
      signInProblem.set(droppedCookieReason(authStatus, { native: isNative }));
      return;
    }
    signInProblem.set(null);
    await loadServerSettings();
    if (!shortcutWaiting) push('/');
  }

  // Locked Out?, the owner's way back in for one account: RECOVERY_TOKEN
  // turns two-step sign-in off for that account and changes nothing else.
  async function resetTwoStep() {
    if (!recoveryToken.trim() || !recoveryUsername.trim()) return;
    resettingTwoStep = true;
    try {
      const res = await fetch(apiUrl('/api/auth/two-step/recover'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: recoveryToken.trim(), username: recoveryUsername.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError(data.error || $_('two_step.locked_out.failed')); return; }
      showSuccess($_('two_step.locked_out.done', { values: { name: recoveryUsername.trim() } }));
      recoveryToken = '';
      showRecovery = false;
      username = recoveryUsername.trim();
      recoveryUsername = '';
    } catch {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      resettingTwoStep = false;
    }
  }

  async function recover() {
    if (!confirm($_('login.recovery.confirm_delete'))) return;
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
      <img src={iconUrl('/icons/logo.png')} alt="NutriTrace" class="logo-img" />
      <h1 class="login-title">NutriTrace</h1>
      <p class="text-3 text-sm">{$_('login.subtitle')}</p>
    </div>

    {#if $signInProblem}
      <CookieWarning reason={$signInProblem} />
    {/if}

    {#if $sessionEnded && !challenge}
      <!-- This device was signed out (a password change, Sign Out Everywhere: server/lib/session-version.js). -->
      <div class="session-ended" role="status">
        <span class="material-symbols-rounded">logout</span>
        <div>{$_('login.session_ended')}</div>
      </div>
    {/if}

    {#if challenge}
      <TwoStepChallenge {challenge} account={username.trim()} on:done={twoStepDone} on:restart={twoStepRestart} />
    {:else if !recoveryDone}
      <!-- One notice, one reason: the server couldn't say who is signed in
           when the app opened, or its sign-in options couldn't be read. -->
      {#if problem}
        <div class="options-failed" role="alert">
          <span class="material-symbols-rounded">{problem === 'options' ? 'warning' : 'cloud_off'}</span>
          <div>{problemText(problem, $_)}</div>
          <button class="btn btn-secondary options-retry" type="button" on:click={$authUnreachable ? retryServer : loadSignInOptions} disabled={retrying || optionsLoading}>{$_('server_signin.retry')}</button>
        </div>
      {/if}
      {#if oidcProviders.length}
        <div class="sso-row">
          {#each oidcProviders as p (p.id)}
            <button class="btn btn-secondary sso-btn" on:click={() => startOidc(p.id)} disabled={ssoOpening} type="button">
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
            <span>{$_('login.biometric.sign_in_button')}</span>
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
          <p style="margin:0">{@html $_('login.recovery.token_prompt')}</p>
          <input class="input" type="password" bind:value={recoveryToken} placeholder={$_('login.recovery.token_placeholder')} />

          <!-- The gentler way first: two-step sign-in off for one account. -->
          <div class="recovery-part">
            <strong class="recovery-heading">{$_('two_step.locked_out.title')}</strong>
            <p style="margin:0">{$_('two_step.locked_out.explain')}</p>
            <input class="input" type="text" autocomplete="off" autocapitalize="off" bind:value={recoveryUsername} placeholder={$_('two_step.locked_out.username_placeholder')} />
            <button class="btn btn-secondary" style="width:100%" on:click={resetTwoStep} disabled={resettingTwoStep || !recoveryToken.trim() || !recoveryUsername.trim()}>
              {resettingTwoStep ? $_('two_step.locked_out.resetting') : $_('two_step.locked_out.action')}
            </button>
          </div>

          <div class="recovery-part">
            <strong class="recovery-heading recovery-heading-danger">
              <span class="material-symbols-rounded" style="font-size:18px;color:var(--warning,#f59e0b)">warning</span>
              {$_('two_step.locked_out.disable_title')}
            </strong>
            <p style="margin:0">{@html $_('login.recovery.explainer_delete')}</p>
          </div>
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
  .recovery-part { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
  .recovery-heading { display: flex; align-items: center; gap: 6px; color: var(--text-1); font-size: 13px; }
  .sso-row { display: flex; flex-direction: column; gap: 8px; }
  .options-failed {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    padding: 12px 14px; background: color-mix(in srgb, #f59e0b 8%, transparent);
    border-left: 3px solid #f59e0b; border-radius: 4px;
    font-size: 13px; line-height: 1.5; color: var(--text-2);
  }
  .options-failed > div { flex: 1; min-width: 160px; }
  .session-ended {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 12px 14px; background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-left: 3px solid var(--accent); border-radius: 4px;
    font-size: 13px; line-height: 1.5; color: var(--text-2);
  }
  .session-ended .material-symbols-rounded { font-size: 20px; color: var(--accent); flex-shrink: 0; }
  .options-failed .material-symbols-rounded { font-size: 20px; color: #f59e0b; flex-shrink: 0; }
  .options-retry { height: 32px; font-size: 12px; padding: 0 12px; }
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
