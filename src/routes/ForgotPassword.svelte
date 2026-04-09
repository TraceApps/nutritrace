<script>
  import { push } from 'svelte-spa-router';
  import { apiUrl } from '../lib/platform.js';

  let email   = '';
  let loading = false;
  let sent    = false;
  let error   = '';

  async function submit() {
    if (!email.trim()) return;
    loading = true;
    error   = '';
    try {
      const res  = await fetch(apiUrl('/api/auth/forgot-password'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { error = data.error || 'Failed'; return; }
      sent = true;
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
      <h1 class="login-title">Reset Password</h1>
    </div>

    {#if sent}
      <div style="text-align:center;padding:8px 0;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--accent)">mark_email_read</span>
        <p style="color:var(--text-2);font-size:14px;line-height:1.5">
          If an account exists for <strong>{email}</strong>, a reset link has been sent. Check your inbox.
        </p>
        <button class="btn btn-secondary w-full" on:click={() => push('/login')}>Back to sign in</button>
      </div>
    {:else}
      <p class="text-3" style="font-size:14px;text-align:center">
        Enter your email address and we'll send you a link to reset your password.
      </p>

      <div class="form-group">
        <label class="form-label">Email address</label>
        <input class="input" type="email" autocomplete="email"
          bind:value={email}
          on:keydown={e => e.key === 'Enter' && submit()}
          placeholder="you@example.com" autofocus />
      </div>

      {#if error}
        <p class="error-msg">{error}</p>
      {/if}

      <button class="btn btn-primary w-full" on:click={submit} disabled={loading || !email.trim()}>
        {loading ? 'Sending…' : 'Send reset link'}
      </button>

      <div style="text-align:center">
        <button class="back-link" on:click={() => push('/login')}>← Back to sign in</button>
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
    margin-bottom: 4px;
    text-align: center;
  }
  .logo-img { width: 56px; height: 56px; border-radius: 14px; object-fit: cover; }
  .login-title { font-size: 1.4rem; font-weight: 700; margin: 0; }
  .error-msg { color: var(--danger); font-size: 13px; margin: 0; }
  .back-link {
    background: none; border: none; color: var(--text-3);
    font-size: 13px; cursor: pointer; text-decoration: underline;
    text-underline-offset: 3px; padding: 0;
  }
  .back-link:hover { color: var(--text-2); }
</style>
