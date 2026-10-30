<script>
  // Before linking a sign-in provider (#222): the password, and the
  // two-step code when it's on, buy a one-time grant the link starts with
  // (server/lib/link-grant.js). A single sign-on account has no password:
  // the server takes a recent sign-in instead, and says so when it's not.
  // Sends 'grant' with { provider, grant } once the server agrees.
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Dialog from '../ui/Dialog.svelte';
  import { twoStepCall, callError } from '../../lib/two-step.js';

  export let open = false;
  /** { id, display_name } */
  export let provider = null;

  const dispatch = createEventDispatcher();
  let status = null;
  let password = '';
  let code = '';
  let busy = false;
  let error = '';
  let shown = false;

  $: if (open && !shown) prepare();
  $: if (!open) shown = false;

  async function prepare() {
    shown = true;
    password = ''; code = ''; error = ''; status = null;
    try {
      const r = await twoStepCall('/status', { method: 'GET' });
      status = r.status === 200 ? r.data : { has_password: true, enabled: false };
    } catch {
      status = { has_password: true, enabled: false };
    }
  }

  $: name = provider?.display_name || 'SSO';
  $: hasPassword = status ? status.has_password !== false : true;
  $: needsCode = !!status?.enabled;
  $: ready = !!status && !busy && (!hasPassword || (!!password && (!needsCode || !!code.trim())));

  async function confirm() {
    if (!ready) return;
    busy = true;
    error = '';
    try {
      const r = await twoStepCall('/link-grant', { body: { password: password || undefined, code: code.trim() || undefined } });
      if (r.status !== 200 || !r.data?.grant) { error = callError(r, $_('two_step.errors.generic')).message; code = ''; return; }
      open = false;
      dispatch('grant', { provider, grant: r.data.grant });
    } catch {
      error = $_('common.errors.cant_reach_server');
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title={$_('two_step.link.title', { values: { provider: name } })}
  message={hasPassword ? $_('two_step.link.message', { values: { provider: name } }) : $_('two_step.link.message_sso', { values: { provider: name } })}
  confirmText={busy ? $_('two_step.link.checking') : $_('two_step.link.continue')}
  cancelText={$_('common.cancel')}
  manualClose={true}
  confirmDisabled={!ready}
  on:cancel={() => { open = false; }}
  on:confirm={confirm}>
  <div class="lc-form">
    {#if status && hasPassword}
      <label class="form-label" for="lc-pw">{$_('two_step.link.password_label')}</label>
      <input id="lc-pw" class="input" type="password" autocomplete="current-password" bind:value={password}
        on:keydown={(e) => { if (e.key === 'Enter') confirm(); }} />
      {#if needsCode}
        <label class="form-label" for="lc-code">{$_('two_step.link.code_label')}</label>
        <input id="lc-code" class="input" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" bind:value={code}
          on:keydown={(e) => { if (e.key === 'Enter') confirm(); }} />
      {/if}
    {/if}
    {#if error}<p class="lc-error" role="alert">{error}</p>{/if}
  </div>
</Dialog>

<style>
  .lc-form { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 8px; }
  .lc-error { margin: 0; color: var(--danger); font-size: 13px; line-height: 1.5; }
</style>
