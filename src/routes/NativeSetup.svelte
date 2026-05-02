<script>
  import { setNativeMode, setServerUrl, setAuthToken, resolveAssetUrl, explainConnectError } from '../lib/platform.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { DB } from '../lib/db.js';

  let step = 'choose'; // 'choose' | 'server-form' | 'connecting'
  let serverUrl = '';
  let username = '';
  let password = '';
  let showPw = false;
  let connecting = false;

  async function chooseLocal() {
    setNativeMode('local');
    setServerUrl(null);
    // Reload — SQLite will initialize naturally when NtApiNative is first called
    window.location.reload();
  }

  function chooseServer() {
    step = 'server-form';
  }

  async function connectToServer() {
    if (!serverUrl.trim()) { showError('Enter your server URL'); return; }
    if (!username.trim() || !password.trim()) { showError('Enter your credentials'); return; }

    const url = serverUrl.trim().replace(/\/$/, '');
    connecting = true;

    try {
      // Use CapacitorHttp to bypass CORS
      const { CapacitorHttp } = await import('@capacitor/core');
      const healthRes = await CapacitorHttp.get({ url: `${url}/api/health` });
      if (healthRes.status < 200 || healthRes.status >= 300) throw new Error('Server not reachable');

      const loginRes = await CapacitorHttp.post({
        url: `${url}/api/auth/login`,
        headers: { 'Content-Type': 'application/json' },
        data: { username: username.trim(), password },
      });
      const loginData = typeof loginRes.data === 'string' ? JSON.parse(loginRes.data) : loginRes.data;
      if (loginRes.status < 200 || loginRes.status >= 300) throw new Error(loginData.error || 'Login failed');

      // Success — save server URL, auth token, and mode
      setServerUrl(url);
      setAuthToken(loginData.token);
      setNativeMode('server');
      DB.setSetting('setupComplete', true);
      showSuccess('Connected to server');
      window.location.reload();
    } catch (e) {
      showError(explainConnectError(e, url));
    } finally {
      connecting = false;
    }
  }

  function backToChoose() {
    step = 'choose';
    serverUrl = '';
    username = '';
    password = '';
  }
</script>

<div class="setup-wrap">
  <div class="setup-inner">
    <!-- Logo / branding -->
    <div class="setup-brand">
      <img src={resolveAssetUrl('/icons/icon-192.png')} alt="NutriTrace" class="setup-logo" />
      <h1 class="setup-title">NutriTrace</h1>
      <p class="setup-subtitle">Trace Every Bite</p>
    </div>

    {#if step === 'choose'}
      <div class="setup-cards">
        <button class="setup-card" on:click={chooseLocal}>
          <span class="material-symbols-rounded setup-card-icon">smartphone</span>
          <div class="setup-card-title">Use Locally</div>
          <p class="setup-card-desc">
            All data stays on this device. Works offline, no server needed.
            You can connect to a server later in Settings.
          </p>
        </button>

        <button class="setup-card" on:click={chooseServer}>
          <span class="material-symbols-rounded setup-card-icon">cloud_sync</span>
          <div class="setup-card-title">Connect to Server</div>
          <p class="setup-card-desc">
            Sync with your NutriTrace server. Your data is available on all
            devices and the web app.
          </p>
        </button>
      </div>

    {:else if step === 'server-form'}
      <div class="setup-form">
        <div class="form-group">
          <label class="form-label">Server URL</label>
          <input
            class="input"
            type="url"
            placeholder="https://nutritrace.example.com"
            bind:value={serverUrl}
            autocapitalize="off"
            autocorrect="off"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Username</label>
          <input
            class="input"
            type="text"
            placeholder="Your username"
            bind:value={username}
            autocapitalize="off"
            autocorrect="off"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <div style="position:relative">
            {#if showPw}
              <input class="input" type="text" placeholder="Your password" bind:value={password} style="padding-right:40px" />
            {:else}
              <input class="input" type="password" placeholder="Your password" bind:value={password} style="padding-right:40px" />
            {/if}
            <button type="button" class="pw-toggle" on:click={() => showPw = !showPw}>
              <span class="material-symbols-rounded" style="font-size:20px">{showPw ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
        </div>

        <div class="setup-form-actions">
          <button class="btn btn-ghost" on:click={backToChoose} disabled={connecting}>
            Back
          </button>
          <button class="btn btn-primary" on:click={connectToServer} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .setup-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: 24px;
    background: var(--bg, #0A0B0F);
  }
  .setup-inner {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  .setup-brand {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .setup-logo {
    width: 80px;
    height: 80px;
    border-radius: 20px;
  }
  .setup-title {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-1);
    margin: 0;
  }
  .setup-subtitle {
    font-size: 14px;
    color: var(--text-3);
    margin: 0;
  }
  .setup-cards {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .setup-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px 20px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    cursor: pointer;
    text-align: center;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }
  .setup-card:hover {
    background: var(--surface-2);
    border-color: var(--accent, #3b82f6);
  }
  .setup-card:active {
    transform: scale(0.98);
  }
  .setup-card-icon {
    font-size: 40px;
    color: var(--accent, #3b82f6);
  }
  .setup-card-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-1);
  }
  .setup-card-desc {
    font-size: 13px;
    color: var(--text-3);
    margin: 0;
    line-height: 1.5;
  }
  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .setup-form-actions {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }
  .setup-form-actions .btn {
    flex: 1;
  }
  .pw-toggle {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; color: var(--text-3); padding: 4px;
  }
</style>
