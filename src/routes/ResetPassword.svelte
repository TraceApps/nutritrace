<script>
  import { onMount } from 'svelte';
  import { push, querystring } from 'svelte-spa-router';
  import { currentUser } from '../stores/auth.js';
  import { loadServerSettings } from '../stores/settings.js';

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
      const res  = await fetch(`/api/auth/validate-token?token=${token}&type=reset`, { credentials: 'include' });
      const data = await res.json();
      if (res.ok) { tokenValid = true; username = data.username || ''; }
    } finally {
      validating = false;
    }
  });

  async function submit() {
    if (!password || password !== confirm) { error = 'Passwords do not match'; return; }
    if (password.length < 4) { error = 'Password must be at least 4 characters'; return; }
    loading = true; error = '';
    try {
      const res  = await fetch('/api/auth/reset-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) { error = data.error || 'Reset failed'; return; }
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
      <h1 class="login-title">New Password</h1>
    </div>

    {#if validating}
      <p class="text-3" style="text-align:center;font-size:14px">Verifying link…</p>

    {:else if !tokenValid}
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--danger)">link_off</span>
        <p style="color:var(--text-2);font-size:14px">This reset link is invalid or has expired.</p>
        <button class="btn btn-secondary w-full" on:click={() => push('/forgot-password')}>Request a new link</button>
      </div>

    {:else if done}
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--accent)">check_circle</span>
        <p style="color:var(--text-2);font-size:14px">Password updated. Redirecting…</p>
      </div>

    {:else}
      {#if username}
        <p class="text-3" style="font-size:14px;text-align:center">
          Set a new password for <strong>{username}</strong>
        </p>
      {/if}

      <div class="form-group">
        <label class="form-label">New password</label>
        <input class="input" type="password" autocomplete="new-password"
          bind:value={password} placeholder="At least 4 characters" autofocus />
      </div>
      <div class="form-group">
        <label class="form-label">Confirm password</label>
        <input class="input" type="password" autocomplete="new-password"
          bind:value={confirm}
          on:keydown={e => e.key === 'Enter' && submit()} />
      </div>

      {#if error}
        <p class="error-msg">{error}</p>
      {/if}

      <button class="btn btn-primary w-full" on:click={submit} disabled={loading || !password || !confirm}>
        {loading ? 'Saving…' : 'Set new password'}
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
</style>
