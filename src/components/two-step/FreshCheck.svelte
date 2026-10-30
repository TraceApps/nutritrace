<script>
  // A fresh check before something a session alone mustn't do (creating
  // an API token): the password, and the two-step code when it's on. A
  // single sign-on account has no password: the server takes a recent
  // sign-in instead, and says so when it's not. The same check as linking
  // a provider (LinkConfirm.svelte, server/routes/two-step.js freshCheck).
  // `run({ password, code })` sends it and resolves to null when the server
  // agreed, else the error to show; the dialog closes on null.
  import { _ } from 'svelte-i18n';
  import Dialog from '../ui/Dialog.svelte';
  import { twoStepCall } from '../../lib/two-step.js';

  export let open = false;
  export let title = '';
  export let message = '';
  export let messageSso = '';
  export let confirmText = '';
  export let run = async () => null;

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

  $: hasPassword = status ? status.has_password !== false : true;
  $: needsCode = !!status?.enabled;
  $: ready = !!status && !busy && (!hasPassword || (!!password && (!needsCode || !!code.trim())));

  async function confirm() {
    if (!ready) return;
    busy = true;
    error = '';
    try {
      const said = await run({ password: password || undefined, code: code.trim() || undefined });
      if (said) { error = said; code = ''; return; }
      open = false;
    } catch {
      error = $_('common.errors.cant_reach_server');
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  {title}
  message={hasPassword ? message : messageSso}
  confirmText={busy ? $_('two_step.link.checking') : confirmText}
  cancelText={$_('common.cancel')}
  manualClose={true}
  confirmDisabled={!ready}
  on:cancel={() => { open = false; }}
  on:confirm={confirm}>
  <div class="fc-form">
    {#if status && hasPassword}
      <label class="form-label" for="fc-pw">{$_('two_step.link.password_label')}</label>
      <input id="fc-pw" class="input" type="password" autocomplete="current-password" bind:value={password}
        on:keydown={(e) => { if (e.key === 'Enter') confirm(); }} />
      {#if needsCode}
        <label class="form-label" for="fc-code">{$_('two_step.link.code_label')}</label>
        <input id="fc-code" class="input" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" bind:value={code}
          on:keydown={(e) => { if (e.key === 'Enter') confirm(); }} />
      {/if}
    {/if}
    {#if error}<p class="fc-error" role="alert">{error}</p>{/if}
  </div>
</Dialog>

<style>
  .fc-form { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 8px; }
  .fc-error { margin: 0; color: var(--danger); font-size: 13px; line-height: 1.5; }
</style>
