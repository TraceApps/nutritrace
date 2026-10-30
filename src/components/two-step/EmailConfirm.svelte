<script>
  // Profile: an email changed here waits for the account to confirm it (#222).
  // Until then single sign-on never links by it and a password reset goes to
  // the address before it (server/lib/link-grant.js). Shows nothing when
  // there's nothing to confirm. `email` is the saved one: a change reloads.
  import { _ } from 'svelte-i18n';
  import { showSuccess } from '../../stores/toast.js';
  import { twoStepCall, callError } from '../../lib/two-step.js';

  export let email = '';

  let status = null;
  let password = '';
  let code = '';
  let busy = false;
  let error = '';

  async function load() {
    try {
      const r = await twoStepCall('/status', { method: 'GET' });
      status = r.status === 200 ? r.data : null;
    } catch {
      status = null;
    }
  }
  $: email, load();

  $: hasPassword = status ? status.has_password !== false : true;
  $: needsCode = !!status?.enabled;
  $: ready = !busy && (!hasPassword || (!!password && (!needsCode || !!code.trim())));

  async function confirm() {
    if (!ready) return;
    busy = true;
    error = '';
    try {
      const r = await twoStepCall('/confirm-email', { body: { password: password || undefined, code: code.trim() || undefined } });
      if (r.status !== 200) { error = callError(r, $_('two_step.errors.generic')).message; code = ''; return; }
      password = ''; code = '';
      showSuccess($_('two_step.email.confirmed'));
      await load();
    } catch {
      error = $_('common.errors.cant_reach_server');
    } finally {
      busy = false;
    }
  }
</script>

{#if status?.email_unconfirmed}
  <div class="ec" role="status">
    <div class="ec-head">
      <span class="material-symbols-rounded" aria-hidden="true">mark_email_unread</span>
      <strong>{$_('two_step.email.title')}</strong>
    </div>
    <p class="ec-text">{hasPassword ? $_('two_step.email.explain') : $_('two_step.email.explain_sso')}</p>
    {#if hasPassword}
      <label class="form-label" for="ec-pw">{$_('two_step.link.password_label')}</label>
      <input id="ec-pw" class="input" type="password" autocomplete="current-password" bind:value={password}
        on:keydown={(e) => { if (e.key === 'Enter') confirm(); }} />
      {#if needsCode}
        <label class="form-label" for="ec-code">{$_('two_step.link.code_label')}</label>
        <input id="ec-code" class="input" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" bind:value={code}
          on:keydown={(e) => { if (e.key === 'Enter') confirm(); }} />
      {/if}
    {/if}
    {#if error}<p class="ec-error" role="alert">{error}</p>{/if}
    <button class="btn btn-primary" type="button" on:click={confirm} disabled={!ready}>
      {busy ? $_('two_step.link.checking') : $_('two_step.email.confirm')}
    </button>
  </div>
{/if}

<style>
  .ec {
    display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; margin: 8px 0;
    border-radius: 8px; border-left: 3px solid #f59e0b; background: color-mix(in srgb, #f59e0b 8%, transparent);
  }
  .ec-head { display: flex; align-items: center; gap: 8px; color: var(--text-1); font-size: 14px; }
  .ec-head .material-symbols-rounded { color: #f59e0b; font-size: 20px; }
  .ec-text { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2); }
  .ec-error { margin: 0; color: var(--danger); font-size: 13px; line-height: 1.5; }
  .ec .btn { align-self: flex-start; }
</style>
