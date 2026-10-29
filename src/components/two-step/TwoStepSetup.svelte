<script>
  // Setting up two-step sign-in (#222): the QR code and key, the first code
  // that turns it on, then the recovery codes. Settings, Profile and the
  // sign-in step (when the admin requires it) both use this; they hand in
  // how to start and how to confirm.
  import { onMount, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { isNative } from '../../lib/platform.js';
  import { copyText } from '../../lib/clipboard.js';
  import { groupKey } from '../../lib/two-step.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import RecoveryCodes from './RecoveryCodes.svelte';

  /** () => Promise<{ secret, qr, otpauth_uri }> */
  export let start;
  /** (code) => Promise<{ recovery_codes, ... }> */
  export let confirm;
  export let account = '';

  const dispatch = createEventDispatcher();
  let setup = null;     // { secret, qr, otpauth_uri }
  let loading = true;
  let error = '';
  let code = '';
  let busy = false;
  let result = null;    // the confirm answer, once on
  let codeInput;

  onMount(async () => {
    try {
      setup = await start();
    } catch (e) {
      error = e?.message || $_('two_step.errors.generic');
      if (e?.restart) dispatch('restart');
    } finally {
      loading = false;
    }
  });

  async function turnOn() {
    if (busy || code.replace(/\D/g, '').length !== 6) return;
    busy = true;
    error = '';
    try {
      result = await confirm(code.replace(/\D/g, ''));
    } catch (e) {
      error = e?.message || $_('two_step.errors.generic');
      code = '';
      if (e?.restart) dispatch('restart');
      else codeInput?.focus();
    } finally {
      busy = false;
    }
  }

  async function copyKey() {
    try { await copyText(setup.secret); showSuccess($_('two_step.setup.key_copied')); }
    catch { showError($_('two_step.errors.copy_failed')); }
  }
</script>

{#if result}
  <RecoveryCodes codes={result.recovery_codes} {account} on:done={() => dispatch('done', result)} />
{:else if loading}
  <p class="ts-muted">{$_('two_step.setup.loading')}</p>
{:else if !setup}
  <p class="ts-error" role="alert">{error}</p>
{:else}
  <div class="ts-setup">
    <ol class="ts-steps">
      <li>
        <span>{$_('two_step.setup.scan')}</span>
        <img class="ts-qr" src={setup.qr} alt={$_('two_step.setup.qr_alt')} width="200" height="200" />
        {#if !isNative}
          <a class="ts-open-app" href={setup.otpauth_uri}>{$_('two_step.setup.open_app')}</a>
        {/if}
      </li>
      <li>
        <span>{$_('two_step.setup.key_intro')}</span>
        <div class="ts-key-row">
          <code class="ts-key">{groupKey(setup.secret)}</code>
          <button class="btn btn-secondary ts-small" type="button" on:click={copyKey}>
            <span class="material-symbols-rounded" aria-hidden="true">content_copy</span>{$_('two_step.setup.copy_key')}
          </button>
        </div>
        <span class="ts-muted ts-fine">{$_('two_step.setup.key_details')}</span>
      </li>
      <li>
        <label class="form-label" for="ts-setup-code">{$_('two_step.setup.code_label')}</label>
        <input id="ts-setup-code" class="input ts-code" bind:this={codeInput} bind:value={code}
          inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456"
          on:keydown={(e) => { if (e.key === 'Enter') turnOn(); }} />
      </li>
    </ol>
    {#if error}<p class="ts-error" role="alert">{error}</p>{/if}
    <div class="ts-actions">
      <slot name="cancel" />
      <button class="btn btn-primary" type="button" on:click={turnOn} disabled={busy || code.replace(/\D/g, '').length !== 6}>
        {busy ? $_('two_step.setup.turning_on') : $_('two_step.setup.turn_on')}
      </button>
    </div>
  </div>
{/if}

<style>
  .ts-setup { display: flex; flex-direction: column; gap: 12px; }
  .ts-steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 14px; font-size: 14px; color: var(--text-2); line-height: 1.5; }
  .ts-steps li { padding-left: 2px; }
  .ts-steps li > span:first-child { display: block; margin-bottom: 8px; }
  .ts-steps .form-label { display: block; margin-bottom: 6px; }
  .ts-qr {
    display: block; width: 200px; height: 200px; max-width: 100%;
    background: #fff; border-radius: 8px; padding: 0; image-rendering: pixelated;
    border: 1px solid var(--border);
  }
  .ts-open-app { display: inline-block; margin-top: 8px; font-size: 13px; color: var(--accent); }
  .ts-key-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .ts-key {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px;
    letter-spacing: 0.04em; padding: 8px 10px; border-radius: 8px;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1);
    word-break: normal; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all;
  }
  .ts-small { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; font-size: 13px; }
  .ts-small .material-symbols-rounded { font-size: 18px; }
  .ts-fine { display: block; margin-top: 6px; font-size: 12px; }
  .ts-code { max-width: 180px; font-size: 20px; letter-spacing: 0.2em; font-variant-numeric: tabular-nums; }
  .ts-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .ts-actions :global(.btn) { flex: 1 1 auto; }
  .ts-muted { color: var(--text-3); font-size: 13px; margin: 0; }
  .ts-error { color: var(--danger); font-size: 13px; margin: 0; }
</style>
