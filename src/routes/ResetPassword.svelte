<script>
  import { onMount } from 'svelte';
  import { push, querystring } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { currentUser } from '../stores/auth.js';
  import { loadServerSettings } from '../stores/settings.js';
  import { validatePassword, passwordStrength } from '../lib/validation.js';
  import { apiUrl, resolveAssetUrl } from '../lib/platform.js';

  $: pwScore = passwordStrength(password);

  let token    = '';
  let username = '';
  let password = '';
  let confirm  = '';
  let loading  = false;
  let validating = true;
  let tokenValid = false;
  let error    = '';
  let done     = false;

  onMount(async () => {
    const params = new URLSearchParams($querystring);
    token = params.get('token') || '';
    if (!token) { validating = false; return; }
    try {
      const res  = await fetch(apiUrl(`/api/auth/validate-token?token=${token}&type=reset`), { credentials: 'include' });
      const data = await res.json();
      if (res.ok) { tokenValid = true; username = data.username || ''; }
    } finally {
      validating = false;
    }
  });

  async function submit() {
    if (!password) { error = $_('reset_password.errors.required'); return; }
    const pwErr = validatePassword(password);
    if (pwErr) { error = pwErr; return; }
    if (password !== confirm) { error = $_('reset_password.errors.mismatch'); return; }
    loading = true; error = '';
    try {
      const res  = await fetch(apiUrl('/api/auth/reset-password'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) { error = data.error || $_('reset_password.errors.failed'); return; }
      localStorage.setItem('wl:userId', String(data.user.id));
      currentUser.set(data.user);
      await loadServerSettings();
      done = true;
      setTimeout(() => push('/'), 2000);
    } catch {
      error = $_('common.errors.cant_reach_server');
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-page">
  <div class="login-card card">
    <div class="login-logo">
      <img src={resolveAssetUrl('/icons/logo.png')} alt="NutriTrace" class="logo-img" />
      <h1 class="login-title">{$_('reset_password.title')}</h1>
    </div>

    {#if validating}
      <p class="text-3" style="text-align:center;font-size:14px">{$_('reset_password.verifying')}</p>

    {:else if !tokenValid}
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--danger)">link_off</span>
        <p style="color:var(--text-2);font-size:14px">{$_('reset_password.invalid_link')}</p>
        <button class="btn btn-secondary w-full" on:click={() => push('/forgot-password')}>{$_('reset_password.request_new')}</button>
      </div>

    {:else if done}
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--accent)">check_circle</span>
        <p style="color:var(--text-2);font-size:14px">{$_('reset_password.success')}</p>
      </div>

    {:else}
      {#if username}
        <p class="text-3" style="font-size:14px;text-align:center">
          {@html $_('reset_password.set_for', { values: { username } })}
        </p>
      {/if}

      <div class="form-group">
        <label class="form-label">{$_('reset_password.new_password')}</label>
        <input class="input" type="password" autocomplete="new-password"
          bind:value={password} placeholder={$_('reset_password.password_placeholder')} autofocus />
        {#if password}
          <div class="pw-strength" class:s-0={pwScore.score === 0} class:s-1={pwScore.score === 1} class:s-2={pwScore.score === 2} class:s-3={pwScore.score === 3} class:s-4={pwScore.score === 4}>
            <div class="pw-bar"><div class="pw-fill" style:width={`${(pwScore.score / 4) * 100}%`}></div></div>
            <span class="pw-label">{pwScore.label}</span>
          </div>
        {/if}
      </div>
      <div class="form-group">
        <label class="form-label">{$_('reset_password.confirm_password')}</label>
        <input class="input" type="password" autocomplete="new-password"
          bind:value={confirm}
          on:keydown={e => e.key === 'Enter' && submit()} />
        {#if confirm && password !== confirm}
          <p class="pw-mismatch">{$_('reset_password.errors.mismatch')}</p>
        {/if}
      </div>

      {#if error}
        <p class="error-msg">{error}</p>
      {/if}

      <button class="btn btn-primary w-full" on:click={submit} disabled={loading || !password || !confirm}>
        {loading ? $_('reset_password.saving') : $_('reset_password.submit')}
      </button>
    {/if}
  </div>
</div>

<style>
  .login-page {
    min-height: 100dvh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; background: var(--bg);
  }
  .login-card {
    width: 100%; max-width: 360px;
    padding: 32px 24px;
    display: flex; flex-direction: column; gap: 16px;
  }
  .login-logo {
    display: flex; flex-direction: column; align-items: center;
    gap: 6px; margin-bottom: 4px; text-align: center;
  }
  .logo-img { width: 56px; height: 56px; border-radius: 14px; object-fit: cover; }
  .login-title { font-size: 1.4rem; font-weight: 700; margin: 0; }
  .error-msg { color: var(--danger); font-size: 13px; margin: 0; }

  /* Password strength indicator — shared pattern across auth pages */
  .pw-strength { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .pw-bar { flex: 1; height: 4px; background: var(--surface-2); border-radius: var(--radius-full); overflow: hidden; }
  .pw-fill { height: 100%; border-radius: var(--radius-full); transition: width var(--dur-base), background var(--dur-fast); }
  .pw-strength.s-0 .pw-fill, .pw-strength.s-1 .pw-fill { background: var(--danger, #ef4444); }
  .pw-strength.s-2 .pw-fill { background: #f59e0b; }
  .pw-strength.s-3 .pw-fill { background: var(--accent); }
  .pw-strength.s-4 .pw-fill { background: var(--success, #22c55e); }
  .pw-label { font-size: 11px; font-weight: 600; color: var(--text-3); min-width: 64px; text-align: right; }
  .pw-strength.s-4 .pw-label { color: var(--success, #22c55e); }
  .pw-strength.s-0 .pw-label, .pw-strength.s-1 .pw-label { color: var(--danger, #ef4444); }
  .pw-mismatch { color: var(--danger, #ef4444); font-size: 11px; margin: 4px 0 0; }
</style>
