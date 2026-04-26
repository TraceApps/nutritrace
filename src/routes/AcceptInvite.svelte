<script>
  import { onMount } from 'svelte';
  import { push, querystring } from 'svelte-spa-router';
  import { currentUser } from '../stores/auth.js';
  import { loadServerSettings } from '../stores/settings.js';
  import { validatePassword, passwordStrength } from '../lib/validation.js';

  $: pwScore = passwordStrength(password);

  let token      = '';
  let prefillEmail = '';
  let username   = '';
  let fullName   = '';
  let password   = '';
  let confirm    = '';
  let loading    = false;
  let validating = true;
  let tokenValid = false;
  let error      = '';
  let done       = false;

  onMount(async () => {
    const params = new URLSearchParams($querystring);
    token = params.get('token') || '';
    if (!token) { validating = false; return; }
    try {
      const res  = await fetch(`/api/auth/validate-token?token=${token}&type=invite`, { credentials: 'include' });
      const data = await res.json();
      if (res.ok) { tokenValid = true; prefillEmail = data.email || ''; }
    } finally {
      validating = false;
    }
  });

  async function submit() {
    if (!username.trim()) { error = 'Username is required'; return; }
    if (!password) { error = 'Password is required'; return; }
    const pwErr = validatePassword(password);
    if (pwErr) { error = pwErr; return; }
    if (password !== confirm) { error = 'Passwords do not match'; return; }
    loading = true; error = '';
    try {
      const res  = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, username: username.trim(), password, full_name: fullName.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { error = data.error || 'Failed to create account'; return; }
      localStorage.setItem('wl:userId', String(data.user.id));
      currentUser.set(data.user);
      await loadServerSettings();
      done = true;
      setTimeout(() => push('/'), 2000);
    } catch {
      error = 'Could not reach server';
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-page">
  <div class="login-card card">
    <div class="login-logo">
      <img src="/icons/logo.png" alt="NutriTrace" class="logo-img" />
      <h1 class="login-title">Create Account</h1>
    </div>

    {#if validating}
      <p class="text-3" style="text-align:center;font-size:14px">Verifying invite…</p>

    {:else if !tokenValid}
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--danger)">link_off</span>
        <p style="color:var(--text-2);font-size:14px">This invite link is invalid or has expired. Ask your admin for a new one.</p>
        <button class="btn btn-secondary w-full" on:click={() => push('/login')}>Back to sign in</button>
      </div>

    {:else if done}
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--accent)">check_circle</span>
        <p style="color:var(--text-2);font-size:14px">Account created! Redirecting…</p>
      </div>

    {:else}
      {#if prefillEmail}
        <p class="text-3" style="font-size:14px;text-align:center">
          You were invited as <strong>{prefillEmail}</strong>. Choose a username and password to get started.
        </p>
      {:else}
        <p class="text-3" style="font-size:14px;text-align:center">
          You've been invited to NutriTrace. Choose a username and password to get started.
        </p>
      {/if}

      <div class="form-group">
        <label class="form-label">Username *</label>
        <input class="input" type="text" autocomplete="username"
          bind:value={username} placeholder="Choose a username" autofocus />
      </div>
      <div class="form-group">
        <label class="form-label">Full name (optional)</label>
        <input class="input" type="text" autocomplete="name"
          bind:value={fullName} placeholder="Your name" />
      </div>
      <div class="form-group">
        <label class="form-label">Password *</label>
        <input class="input" type="password" autocomplete="new-password"
          bind:value={password} placeholder="8+ chars, upper, lower, number, symbol" />
        {#if password}
          <div class="pw-strength" class:s-0={pwScore.score === 0} class:s-1={pwScore.score === 1} class:s-2={pwScore.score === 2} class:s-3={pwScore.score === 3} class:s-4={pwScore.score === 4}>
            <div class="pw-bar"><div class="pw-fill" style:width={`${(pwScore.score / 4) * 100}%`}></div></div>
            <span class="pw-label">{pwScore.label}</span>
          </div>
        {/if}
      </div>
      <div class="form-group">
        <label class="form-label">Confirm password *</label>
        <input class="input" type="password" autocomplete="new-password"
          bind:value={confirm} on:keydown={e => e.key === 'Enter' && submit()} />
        {#if confirm && password !== confirm}
          <p class="pw-mismatch">Passwords don't match</p>
        {/if}
      </div>

      {#if error}
        <p class="error-msg">{error}</p>
      {/if}

      <button class="btn btn-primary w-full" on:click={submit} disabled={loading || !username || !password || !confirm}>
        {loading ? 'Creating account…' : 'Create account'}
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
