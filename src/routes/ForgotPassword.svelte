<script>
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { apiUrl, resolveAssetUrl } from '../lib/platform.js';

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
      if (!res.ok) { error = data.error || $_('common.errors.failed'); return; }
      sent = true;
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
      <h1 class="login-title">{$_('forgot_password.title')}</h1>
    </div>

    {#if sent}
      <div style="text-align:center;padding:8px 0;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--accent)">mark_email_read</span>
        <p style="color:var(--text-2);font-size:14px;line-height:1.5">
          {@html $_('forgot_password.sent', { values: { email } })}
        </p>
        <button class="btn btn-secondary w-full" on:click={() => push('/login')}>{$_('forgot_password.back_to_signin')}</button>
      </div>
    {:else}
      <p class="text-3" style="font-size:14px;text-align:center">
        {$_('forgot_password.intro')}
      </p>

      <div class="form-group">
        <label class="form-label">{$_('forgot_password.email_label')}</label>
        <input class="input" type="email" autocomplete="email"
          bind:value={email}
          on:keydown={e => e.key === 'Enter' && submit()}
          placeholder="you@example.com" autofocus />
      </div>

      {#if error}
        <p class="error-msg">{error}</p>
      {/if}

      <button class="btn btn-primary w-full" on:click={submit} disabled={loading || !email.trim()}>
        {loading ? $_('forgot_password.sending') : $_('forgot_password.send_link')}
      </button>

      <div style="text-align:center">
        <button class="back-link" on:click={() => push('/login')}>← {$_('forgot_password.back_to_signin')}</button>
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
