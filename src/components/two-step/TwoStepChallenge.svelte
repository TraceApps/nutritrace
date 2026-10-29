<script>
  // The second step of signing in (#222), after a right password: a code
  // from the authenticator app or a recovery code ('verify'), or setting
  // two-step sign-in up when the admin requires it ('setup'). Sends 'done'
  // with the server's { user, token } once signed in, 'restart' to go back
  // to the password (a timed-out step, or Back).
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { twoStepCall, callError } from '../../lib/two-step.js';
  import TwoStepSetup from './TwoStepSetup.svelte';

  /** { kind: 'verify' | 'setup', pendingToken } */
  export let challenge;
  /** The Android app signing in to a server it isn't connected to yet. */
  export let serverUrl = null;
  export let account = '';

  const dispatch = createEventDispatcher();
  let code = '';
  let useRecovery = false;
  let busy = false;
  let error = '';
  let input;

  onMount(() => { input?.focus(); });

  $: ready = useRecovery ? code.replace(/[^a-z0-9]/gi, '').length === 16 : code.replace(/\D/g, '').length === 6;

  async function verify() {
    if (busy || !ready) return;
    busy = true;
    error = '';
    try {
      const r = await twoStepCall('/verify', { body: { pending_token: challenge.pendingToken, code: code.trim() }, serverUrl });
      if (r.status >= 200 && r.status < 300 && r.data?.user) { dispatch('done', r.data); return; }
      const e = callError(r, $_('two_step.errors.generic'));
      if (e.restart) { dispatch('restart', { message: e.message }); return; }
      error = e.message;
      code = '';
      await tick();
      input?.focus();
    } catch {
      error = $_('common.errors.cant_reach_server');
    } finally {
      busy = false;
    }
  }

  async function switchMode() {
    useRecovery = !useRecovery;
    code = '';
    error = '';
    await tick();
    input?.focus();
  }

  // Setup with the pending token: the password was just given.
  async function startSetup() {
    const r = await twoStepCall('/setup/start', { body: { pending_token: challenge.pendingToken }, serverUrl });
    if (r.status >= 200 && r.status < 300) return r.data;
    throw callError(r, $_('two_step.errors.generic'));
  }
  async function confirmSetup(c) {
    const r = await twoStepCall('/setup/confirm', { body: { pending_token: challenge.pendingToken, code: c }, serverUrl });
    if (r.status >= 200 && r.status < 300 && r.data?.user) return r.data;
    throw callError(r, $_('two_step.errors.generic'));
  }
</script>

<div class="tsc">
  <div class="tsc-head">
    <span class="material-symbols-rounded tsc-icon" aria-hidden="true">phonelink_lock</span>
    <h2 class="tsc-title">{challenge.kind === 'setup' ? $_('two_step.signin.setup_title') : $_('two_step.signin.title')}</h2>
  </div>

  {#if challenge.kind === 'setup'}
    <p class="tsc-text">{$_('two_step.signin.setup_intro')}</p>
    <TwoStepSetup start={startSetup} confirm={confirmSetup} {account}
      on:done={(e) => dispatch('done', e.detail)}
      on:restart={() => dispatch('restart', {})}>
      <button slot="cancel" class="btn btn-ghost" type="button" on:click={() => dispatch('restart', {})}>{$_('two_step.signin.back')}</button>
    </TwoStepSetup>
  {:else}
    <p class="tsc-text">{useRecovery ? $_('two_step.signin.recovery_intro') : $_('two_step.signin.intro')}</p>
    <div class="form-group">
      <label class="form-label" for="tsc-code">{useRecovery ? $_('two_step.signin.recovery_label') : $_('two_step.signin.code_label')}</label>
      {#if useRecovery}
        <input id="tsc-code" class="input tsc-recovery" bind:this={input} bind:value={code}
          autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx-xxxx"
          on:keydown={(e) => { if (e.key === 'Enter') verify(); }} />
      {:else}
        <input id="tsc-code" class="input tsc-code" bind:this={input} bind:value={code}
          inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456"
          on:keydown={(e) => { if (e.key === 'Enter') verify(); }} />
      {/if}
    </div>
    {#if error}<p class="tsc-error" role="alert">{error}</p>{/if}
    <button class="btn btn-primary w-full" type="button" on:click={verify} disabled={busy || !ready}>
      {busy ? $_('two_step.signin.verifying') : $_('two_step.signin.verify')}
    </button>
    <div class="tsc-links">
      <button class="tsc-link" type="button" on:click={switchMode}>
        {useRecovery ? $_('two_step.signin.use_app') : $_('two_step.signin.use_recovery')}
      </button>
      <button class="tsc-link" type="button" on:click={() => dispatch('restart', {})}>{$_('two_step.signin.back')}</button>
    </div>
    <p class="tsc-help">{$_('two_step.signin.lost_phone')}</p>
  {/if}
</div>

<style>
  .tsc { display: flex; flex-direction: column; gap: 14px; }
  .tsc-head { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }
  .tsc-icon { font-size: 36px; color: var(--accent); }
  .tsc-title { font-size: 1.2rem; font-weight: 700; margin: 0; }
  .tsc-text { margin: 0; font-size: 14px; line-height: 1.5; color: var(--text-2); text-align: center; }
  .tsc-code { font-size: 22px; letter-spacing: 0.25em; text-align: center; font-variant-numeric: tabular-nums; }
  .tsc-recovery { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-align: center; letter-spacing: 0.04em; }
  .tsc-error { margin: 0; color: var(--danger); font-size: 13px; line-height: 1.5; text-align: center; }
  .tsc-links { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .tsc-link {
    background: none; border: none; padding: 0; cursor: pointer; font: inherit; font-size: 13px;
    color: var(--text-3); text-decoration: underline; text-underline-offset: 3px;
  }
  .tsc-link:hover { color: var(--text-2); }
  .tsc-help { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-3); text-align: center; }
</style>
