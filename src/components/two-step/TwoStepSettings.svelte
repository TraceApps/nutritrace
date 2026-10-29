<script>
  // Settings, Profile: Two-Step Sign-In (#222). Set up, new recovery codes,
  // turn off. A single sign-on account is told its provider handles it.
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { currentUser } from '../../stores/auth.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { twoStepCall, callError } from '../../lib/two-step.js';
  import TwoStepSetup from './TwoStepSetup.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';

  let status = null;   // GET /status
  let loadFailed = false;
  // '' | 'password' (before setup) | 'setup' | 'codes' (new ones, password + code) | 'off' | 'show-codes'
  let mode = '';
  let password = '';
  let code = '';
  let busy = false;
  let error = '';
  let newCodes = [];

  async function load() {
    try {
      const r = await twoStepCall('/status', { method: 'GET' });
      if (r.status !== 200) throw callError(r, '');
      status = r.data;
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
  }
  onMount(load);

  function open(m) { mode = m; password = ''; code = ''; error = ''; }
  function close() { open(''); }

  // Setup asks the password again first (said under it when wrong), then
  // shows the QR code and key.
  let started = null;
  const startSetup = async () => started;
  async function confirmSetup(c) {
    const r = await twoStepCall('/setup/confirm', { body: { code: c } });
    if (r.status === 200) return r.data;
    throw callError(r, $_('two_step.errors.generic'));
  }
  async function passwordForSetup() {
    if (busy || !password) return;
    busy = true;
    error = '';
    try {
      const r = await twoStepCall('/setup/start', { body: { password } });
      if (r.status !== 200) { error = callError(r, $_('two_step.errors.generic')).message; return; }
      started = r.data;
      password = '';
      mode = 'setup';
    } catch {
      error = $_('common.errors.cant_reach_server');
    } finally {
      busy = false;
    }
  }
  async function setupDone() {
    close();
    showSuccess($_('two_step.settings.turned_on'));
    await load();
  }

  // Password and a code: new recovery codes, or off.
  async function submitWithCode() {
    if (busy || !password || !code.trim()) return;
    busy = true;
    error = '';
    try {
      const path = mode === 'off' ? '/disable' : '/recovery-codes';
      const r = await twoStepCall(path, { body: { password, code: code.trim() } });
      if (r.status !== 200) { error = callError(r, $_('two_step.errors.generic')).message; code = ''; return; }
      if (mode === 'off') {
        close();
        showSuccess($_('two_step.settings.turned_off'));
      } else {
        newCodes = r.data.recovery_codes || [];
        mode = 'show-codes';
      }
      await load();
    } catch {
      error = $_('common.errors.cant_reach_server');
    } finally {
      busy = false;
    }
  }

  $: enabledSince = status?.enabled_at ? new Date(status.enabled_at.replace(' ', 'T') + 'Z').toLocaleDateString() : '';
</script>

<div class="card settings-card ts-card">
  <div class="ts-title-row">
    <div class="editor-card-title">{$_('two_step.settings.title')}</div>
    {#if status?.has_password}
      <span class="ts-badge" class:on={status.enabled}>{status.enabled ? $_('two_step.settings.on') : $_('two_step.settings.off')}</span>
    {/if}
  </div>

  {#if loadFailed}
    <p class="ts-desc">{$_('two_step.settings.load_failed')}</p>
    <button class="btn btn-secondary" type="button" on:click={load}>{$_('server_signin.retry')}</button>
  {:else if !status}
    <p class="ts-desc">{$_('two_step.setup.loading')}</p>
  {:else if !status.has_password}
    <p class="ts-desc">{$_('two_step.settings.sso')}</p>
  {:else if mode === 'setup'}
    <div transition:slide={{ duration: 160 }}>
      <TwoStepSetup start={startSetup} confirm={confirmSetup} account={$currentUser?.username || ''}
        on:done={setupDone}>
        <button slot="cancel" class="btn btn-ghost" type="button" on:click={close}>{$_('common.cancel')}</button>
      </TwoStepSetup>
    </div>
  {:else if mode === 'show-codes'}
    <div transition:slide={{ duration: 160 }}>
      <RecoveryCodes codes={newCodes} account={$currentUser?.username || ''} on:done={() => { newCodes = []; close(); }} />
    </div>
  {:else}
    <p class="ts-desc">{$_('two_step.settings.desc')}</p>
    {#if status.required && !status.enabled}
      <p class="ts-note">{$_('two_step.settings.required_note')}</p>
    {/if}
    {#if status.key_problem}
      <p class="ts-warn" role="alert">
        <span class="material-symbols-rounded" aria-hidden="true">warning</span>
        <span>{$_('two_step.settings.key_problem')}</span>
      </p>
    {/if}

    {#if !status.enabled}
      {#if mode === 'password'}
        <div class="ts-form" transition:slide={{ duration: 160 }}>
          <label class="form-label" for="ts-pw">{$_('two_step.settings.password_label')}</label>
          <input id="ts-pw" class="input" type="password" autocomplete="current-password" bind:value={password}
            on:keydown={(e) => { if (e.key === 'Enter') passwordForSetup(); }} />
          {#if error}<p class="ts-error" role="alert">{error}</p>{/if}
          <div class="ts-actions">
            <button class="btn btn-ghost" type="button" on:click={close}>{$_('common.cancel')}</button>
            <button class="btn btn-primary" type="button" on:click={passwordForSetup} disabled={busy || !password}>{$_('two_step.settings.continue')}</button>
          </div>
        </div>
      {:else}
        {#if !status.can_set_up}<p class="ts-warn" role="alert"><span class="material-symbols-rounded" aria-hidden="true">warning</span><span>{$_('two_step.settings.cant_set_up')}</span></p>{/if}
        <button class="security-row" type="button" on:click={() => open('password')} disabled={!status.can_set_up}>
          <span class="material-symbols-rounded security-icon" aria-hidden="true">phonelink_lock</span>
          <span class="security-label">{$_('two_step.settings.set_up')}</span>
          <span class="material-symbols-rounded security-chev" aria-hidden="true">chevron_right</span>
        </button>
      {/if}
    {:else}
      <p class="ts-meta">
        {#if enabledSince}{$_('two_step.settings.on_since', { values: { date: enabledSince } })}{' · '}{/if}{$_('two_step.settings.codes_left', { values: { count: status.recovery_codes_left } })}
      </p>
      {#if status.recovery_codes_left <= 3}
        <p class="ts-note">{$_('two_step.settings.codes_low')}</p>
      {/if}
      {#if mode === 'codes' || mode === 'off'}
        <div class="ts-form" transition:slide={{ duration: 160 }}>
          <p class="ts-desc">{mode === 'off' ? $_('two_step.settings.off_explain') : $_('two_step.settings.codes_explain')}</p>
          <label class="form-label" for="ts-pw2">{$_('two_step.settings.password_label')}</label>
          <input id="ts-pw2" class="input" type="password" autocomplete="current-password" bind:value={password} />
          <label class="form-label" for="ts-code2">{$_('two_step.settings.code_label')}</label>
          <input id="ts-code2" class="input" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" bind:value={code}
            on:keydown={(e) => { if (e.key === 'Enter') submitWithCode(); }} />
          {#if error}<p class="ts-error" role="alert">{error}</p>{/if}
          <div class="ts-actions">
            <button class="btn btn-ghost" type="button" on:click={close}>{$_('common.cancel')}</button>
            <button class="btn {mode === 'off' ? 'btn-danger' : 'btn-primary'}" type="button" on:click={submitWithCode} disabled={busy || !password || !code.trim()}>
              {mode === 'off' ? $_('two_step.settings.turn_off') : $_('two_step.settings.new_codes')}
            </button>
          </div>
        </div>
      {:else}
        <button class="security-row" type="button" on:click={() => open('codes')}>
          <span class="material-symbols-rounded security-icon" aria-hidden="true">key</span>
          <span class="security-label">{$_('two_step.settings.new_codes')}</span>
          <span class="material-symbols-rounded security-chev" aria-hidden="true">chevron_right</span>
        </button>
        <button class="security-row" type="button" on:click={() => open('off')}>
          <span class="material-symbols-rounded security-icon ts-danger" aria-hidden="true">lock_open</span>
          <span class="security-label">{$_('two_step.settings.turn_off')}</span>
          <span class="material-symbols-rounded security-chev" aria-hidden="true">chevron_right</span>
        </button>
      {/if}
    {/if}
  {/if}
</div>

<style>
  /* As Profile's own cards (Profile.svelte .profile-body .settings-card):
     not clipped, never squeezed by the column, no hover lift. */
  .ts-card { padding: 16px; gap: 12px; overflow: visible; flex-shrink: 0; }
  .ts-card:hover { transform: none; box-shadow: none; }
  .ts-title-row .editor-card-title { font-size: 16px; font-weight: 600; margin: 0; }
  .ts-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ts-badge {
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 999px; color: var(--text-3); background: var(--surface-2); border: 1px solid var(--border);
  }
  .ts-badge.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .ts-desc { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2); }
  .ts-meta { margin: 0; font-size: 13px; color: var(--text-2); }
  .ts-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-3); }
  .ts-warn {
    display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: 10px 12px; font-size: 13px; line-height: 1.5; color: var(--text-2);
    background: color-mix(in srgb, #f59e0b 8%, transparent); border-left: 3px solid #f59e0b; border-radius: 4px;
  }
  .ts-warn .material-symbols-rounded { color: #f59e0b; font-size: 20px; flex-shrink: 0; }
  .ts-form { display: flex; flex-direction: column; gap: 8px; }
  .ts-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .ts-actions .btn { flex: 1 1 auto; }
  .ts-error { margin: 0; color: var(--danger); font-size: 13px; }
  /* Rows as in the Security card above (Profile.svelte). */
  .security-row {
    display: flex; align-items: center; gap: 12px;
    width: 100%; padding: 10px 8px;
    background: none; border: none; cursor: pointer;
    color: var(--text-1); font-family: inherit; font-size: 14px; text-align: left;
    border-radius: var(--radius-md);
    transition: background var(--dur-fast);
  }
  .security-row:hover { background: var(--surface-2); }
  .security-row:disabled { opacity: 0.5; cursor: default; }
  .security-icon { font-size: 20px; color: var(--accent); flex-shrink: 0; }
  .security-icon.ts-danger { color: var(--danger); }
  .security-label { flex: 1; font-weight: 500; }
  .security-chev { font-size: 20px; color: var(--text-3); flex-shrink: 0; }
</style>
