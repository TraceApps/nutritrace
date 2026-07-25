<script>
  /**
   * SettingsEmail — SMTP form. Extracted from Settings.svelte to match
   * CookTrace + LiftTrace's per-component layout. Verbiage / classes
   * stay identical across the three apps so SMTP settings read the same
   * regardless of which app you're in.
   *
   * Used for password resets, user invites, and weekly summary email.
   * Server endpoints at /api/app-config (key/value writes) +
   * /api/app-config/test-email.
   */
  import { onMount, tick } from 'svelte';
  import Toggle from './Toggle.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { currentUser } from '../../stores/auth.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';

  // Build request headers matching Settings.svelte's _fetchOpts pattern.
  // On Android server-connected mode, uses Bearer auth. On PWA, uses
  // CSRF cookie + token. Without this, /api/app-config calls from the
  // Android app never route to the server, and the SMTP form shows up
  // empty even though the server has real config.
  function _authHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('nt:csrf') : null;
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return h;
  }

  export let envLocks = { smtp: false };

  let smtpHost = '';
  let smtpPort = '587';
  let smtpSecure = false;
  let smtpUser = '';
  let smtpPass = '';
  let smtpShowPass = false;
  let smtpFrom = '';
  let smtpSaving = false;
  let smtpSaved = false;
  let smtpTestStatus = '';
  let smtpTestRecipient = '';
  let smtpPassInputEl;

  // Server redacts stored passwords on GET and returns bullets as a
  // placeholder, the real value is never sent to the browser. Detect
  // that state so the toggle can't pretend to "reveal" a value we don't
  // have, and offer a clear Change action instead.
  const PASS_MASK = '••••••••';
  $: passIsStored = smtpPass === PASS_MASK;

  function changeSmtpPass() {
    smtpPass = '';
    smtpShowPass = false;
    setTimeout(() => smtpPassInputEl?.focus(), 0);
  }

  onMount(loadSmtpConfig);

  async function loadSmtpConfig() {
    try {
      const res = await fetch(apiUrl('/api/app-config'), {
        credentials: 'include',
        headers: _authHeaders(),
      });
      if (!res.ok) return;
      const cfg = await res.json();
      smtpHost   = cfg.smtp_host   || '';
      smtpPort   = cfg.smtp_port   || '587';
      smtpSecure = cfg.smtp_secure === 'true';
      smtpUser   = cfg.smtp_user   || '';
      smtpPass   = cfg.smtp_pass   || '';
      smtpFrom   = cfg.smtp_from   || '';
    } catch {}
  }

  async function saveSmtpField(key, value) {
    await fetch(apiUrl('/api/app-config'), {
      method: 'PUT', credentials: 'include',
      headers: _authHeaders(),
      body: JSON.stringify({ key, value: String(value) }),
    }).catch(() => {});
  }

  // Batch save via Save button. Nothing saves until the user explicitly
  // clicks Save, which avoids per-field-blur pitfalls: clicking Change
  // and tabbing away with an empty field can't wipe the stored password.
  async function saveSmtp() {
    smtpSaving = true;
    smtpSaved = false;
    try {
      await saveSmtpField('smtp_host',   smtpHost);
      await saveSmtpField('smtp_port',   String(smtpPort));
      await saveSmtpField('smtp_secure', String(smtpSecure));
      await saveSmtpField('smtp_user',   smtpUser);
      // Only push the password when the user actually typed a new one.
      if (smtpPass && smtpPass !== PASS_MASK) await saveSmtpField('smtp_pass', smtpPass);
      await saveSmtpField('smtp_from',   smtpFrom);
      smtpSaved = true;
      setTimeout(() => smtpSaved = false, 2000);
    } finally { smtpSaving = false; }
  }

  // Dialog state for Send Test: user picks the recipient at click time
  // (pre-filled from their account email if available). Prevents "sent
  // to nowhere" when smtp_from is a noreply@ that can't receive.
  let showTestDialog = false;
  let testRecipient = '';
  let testDialogInputEl;

  function openTestDialog() {
    if (!smtpHost) { smtpTestStatus = 'fail'; showError('SMTP test failed: host required'); return; }
    testRecipient = $currentUser?.email || '';
    showTestDialog = true;
    tick().then(() => testDialogInputEl?.focus());
  }

  function closeTestDialog() {
    showTestDialog = false;
  }

  async function confirmTestSmtp() {
    const to = (testRecipient || '').trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      showError('Enter a valid email address');
      return;
    }
    showTestDialog = false;
    smtpTestStatus = 'testing';
    smtpTestRecipient = '';
    try {
      const body = {
        smtp_host: smtpHost,
        smtp_port: String(smtpPort),
        smtp_secure: String(smtpSecure),
        smtp_user: smtpUser,
        smtp_from: smtpFrom,
        to,
      };
      if (smtpPass && smtpPass !== PASS_MASK) body.smtp_pass = smtpPass;
      const res = await fetch(apiUrl('/api/app-config/test-email'), {
        method: 'POST', credentials: 'include',
        headers: _authHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        smtpTestRecipient = data.to || to;
        smtpTestStatus = 'ok';
        showSuccess(`SMTP test email sent to ${smtpTestRecipient}`);
      } else {
        smtpTestStatus = 'fail';
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) detail = j.error; } catch {}
        showError(`SMTP test failed: ${detail}`);
      }
    } catch (e) {
      smtpTestStatus = 'fail';
      showError(`SMTP test failed: ${e?.message || 'network error'}`);
    }
  }

  const testSmtp = openTestDialog;

  // Banner status mirrors CookTrace + LiftTrace: SMTP is fire-and-forget
  // (not a persistent connection) so the banner shows "Configured" as
  // soon as host + from are filled in (creds entered, never verified),
  // and flips to "Last Test Sent" after a successful test. A failed
  // test takes priority.
  $: smtpBannerStatus = smtpTestStatus === 'testing' || smtpTestStatus === 'fail'
    ? smtpTestStatus
    : (smtpHost && smtpFrom ? 'ok' : '');
  $: smtpBannerLabel   = smtpTestStatus === 'ok' ? 'Last Test Sent' : 'Configured';
  $: smtpBannerSubtext = smtpTestStatus === 'ok'
    ? (smtpTestRecipient
        ? `Sent to ${smtpTestRecipient}. Use Send Test again any time to re-verify.`
        : 'Use Send Test again any time to re-verify')
    : 'No test has been sent yet';
</script>

<p class="sub-label" style="padding-bottom:4px">Used for password resets and user invites</p>
{#if envLocks.smtp}
  <div class="env-lock-banner">
    <span class="material-symbols-rounded" style="font-size:16px">lock</span>
    Configured via environment variables — changes are disabled.
  </div>
{/if}
<div class="card settings-card">
  {#if !envLocks.smtp}
    <ConnectionStatus
      status={smtpBannerStatus}
      okLabel={smtpBannerLabel}
      subtext={smtpBannerSubtext}
      error={smtpTestStatus === 'fail' ? 'Check host, credentials, and from address' : ''}
      onRetest={testSmtp}
      retestDisabled={smtpTestStatus === 'testing' || !smtpHost}
      retestLabel="Send Test"
    />
  {/if}
  <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
    <div class="form-group">
      <label class="form-label">SMTP Host</label>
      <input class="input" type="text" placeholder="e.g. smtp.example.com"
        bind:value={smtpHost} disabled={envLocks.smtp} />
    </div>
    <div style="display:flex;gap:10px">
      <div class="form-group" style="flex:1">
        <label class="form-label">Port</label>
        <input class="input" type="number" placeholder="587"
          bind:value={smtpPort} disabled={envLocks.smtp} />
      </div>
      <div class="form-group" style="display:flex;flex-direction:column;gap:6px;justify-content:flex-end;padding-bottom:2px">
        <label class="form-label">TLS</label>
        <Toggle checked={smtpSecure} on:change={e => smtpSecure = e.detail} disabled={envLocks.smtp} />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Username</label>
      <input class="input" type="text" autocomplete="off" placeholder="SMTP username or email"
        bind:value={smtpUser} disabled={envLocks.smtp} />
    </div>
    <div class="form-group">
      <label class="form-label">Password</label>
      <div style="display:flex;gap:8px;align-items:center">
        <!-- Single input masked via CSS text-security instead of a
             type-swap: on some Android WebView builds the swap left
             stale password dots visible. When passIsStored is true
             the field is read-only + the toggle is replaced with a
             Change button, because the server redacts the real value
             and there's nothing meaningful to "reveal". -->
        <input bind:this={smtpPassInputEl}
          class="input smtp-pass" class:masked={!smtpShowPass && !passIsStored}
          style="flex:1" type="text" autocomplete="new-password"
          placeholder="SMTP password or app password"
          bind:value={smtpPass}
          disabled={envLocks.smtp || passIsStored} />
        {#if passIsStored}
          <button type="button" class="btn-icon change-btn"
            on:click={changeSmtpPass}
            title="Change password"
            aria-label="Change password">
            Change
          </button>
        {:else}
          <button type="button" class="btn-icon"
            on:click={() => smtpShowPass = !smtpShowPass}
            title={smtpShowPass ? 'Hide' : 'Show'}
            aria-label={smtpShowPass ? 'Hide password' : 'Show password'}>
            <span class="material-symbols-rounded">{smtpShowPass ? 'visibility_off' : 'visibility'}</span>
          </button>
        {/if}
      </div>
      {#if passIsStored}
        <p class="pass-hint">Password saved. Tap Change to replace it.</p>
      {/if}
    </div>
    <div class="form-group">
      <label class="form-label">From Address</label>
      <input class="input" type="email" placeholder='NutriTrace <noreply@example.com>'
        bind:value={smtpFrom} disabled={envLocks.smtp} />
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <button class="btn btn-primary" style="height:36px;font-size:13px"
        on:click={saveSmtp} disabled={smtpSaving || envLocks.smtp}>
        {#if smtpSaved}
          <span class="material-symbols-rounded" style="font-size:16px">check</span> Saved
        {:else}
          {smtpSaving ? 'Saving…' : 'Save'}
        {/if}
      </button>
    </div>
  </div>
</div>

{#if showTestDialog}
  <div class="test-dialog-overlay" on:click={closeTestDialog}
    on:keydown={(e) => e.key === 'Escape' && closeTestDialog()}>
    <div class="test-dialog" role="dialog" aria-labelledby="test-dialog-title"
      on:click|stopPropagation>
      <h3 id="test-dialog-title">Send Test Email</h3>
      <p>Where should we send the test?</p>
      <input bind:this={testDialogInputEl} class="input" type="email"
        placeholder="you@example.com" bind:value={testRecipient}
        on:keydown={(e) => e.key === 'Enter' && confirmTestSmtp()} />
      <div class="test-dialog-actions">
        <button class="btn btn-ghost" on:click={closeTestDialog}>Cancel</button>
        <button class="btn btn-primary" on:click={confirmTestSmtp}
          disabled={!testRecipient.trim()}>Send</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sub-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    padding: 4px 2px 2px; margin: 0;
  }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .env-lock-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; margin-bottom: 8px;
    background: color-mix(in srgb, var(--warning) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 25%, transparent);
    border-radius: var(--radius-md);
    font-size: 13px; color: var(--warning);
  }
  .smtp-pass.masked {
    -webkit-text-security: disc;
    text-security: disc;
    font-family: text-security-disc, monospace;
    letter-spacing: 0.1em;
  }
  .smtp-pass:disabled {
    color: var(--text-3);
    cursor: not-allowed;
  }
  .btn-icon.change-btn {
    width: auto;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 700;
    color: var(--accent);
    border-color: var(--accent);
  }
  .pass-hint {
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--text-3);
  }

  /* Send Test recipient dialog */
  .test-dialog-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0, 0, 0, 0.5);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .test-dialog {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    width: 100%; max-width: 380px;
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
  }
  .test-dialog h3 {
    margin: 0 0 6px;
    font-size: 16px; font-weight: 700; color: var(--text-1);
  }
  .test-dialog p {
    margin: 0 0 14px;
    font-size: 13px; color: var(--text-2);
  }
  .test-dialog-actions {
    display: flex; gap: 8px; justify-content: flex-end;
    margin-top: 16px;
  }
</style>
