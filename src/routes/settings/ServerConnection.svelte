<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { DB } from '../../lib/db.js';
  import {
    isNative, getServerUrl, setServerUrl, setNativeMode, getNativeMode,
    setAuthToken, getAuthToken, apiUrl, explainConnectError,
  } from '../../lib/platform.js';
  import { currentUser, userMgmtActive } from '../../stores/auth.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  // ── Sync state + manual trigger ────────────────────────────────────────
  // Native server mode only. lastSyncAt comes from sync_meta on mount and is
  // kept in sync with the live syncState.lastSync as background syncs fire.
  let lastSyncAt = null;
  let _nowTick = Date.now(); // re-render the "X ago" label every 30s
  let _syncing = false;
  let _liveSyncState = { online: true, connectionIssue: null };
  $: _serverReachable = _liveSyncState.online && !_liveSyncState.connectionIssue;
  $: _syncBusy = _syncing || _liveSyncState.syncing;

  async function manualSync() {
    if (_syncBusy) return;
    _syncing = true;
    // Let Svelte paint the busy label even if fullSync returns immediately.
    await tick();
    try {
      const { fullSync } = await import('../../lib/sync.js');
      const result = await fullSync(false, true, true);
      if (result?.reason === 'busy') {
        console.info('[sync] manual refresh skipped because another sync is already running');
      }
    } catch (e) {
      console.error('[sync] settings refresh failed:', e);
    } finally {
      _syncing = false;
    }
  }

  function _fmtTimeAgo(iso, translate) {
    if (!iso) return translate('sync.time.never');
    const ms = _nowTick - new Date(iso).getTime();
    if (ms < 0) return translate('sync.time.just_now');
    const s = Math.floor(ms / 1000);
    if (s < 10)  return translate('sync.time.just_now');
    if (s < 60)  return translate('sync.time.seconds_ago', { values: { count: s } });
    const m = Math.floor(s / 60);
    if (m < 60)  return translate('sync.time.minutes_ago', { values: { count: m } });
    const h = Math.floor(m / 60);
    if (h < 24)  return translate('sync.time.hours_ago', { values: { count: h } });
    const d = Math.floor(h / 24);
    return translate('sync.time.days_ago', { values: { count: d } });
  }

  // ── Server Connection (native only) ─────────────────────────────────────
  let serverUrlInput = getServerUrl() || '';
  let serverUsername = '';
  let serverPassword = '';
  let serverShowPw = false;
  let serverConnecting = false;
  let serverMode = getNativeMode(); // 'local' | 'server'

  // ── Server connect/merge flow ──────────────────────────────────────────────
  let mergeStep = null;  // null | 'ask-settings' | 'syncing' | 'summary'
  let mergeProgress = '';
  let mergeProgressPct = 0;
  let mergeStage = '';   // current stage label for progress bar
  let _pendingServerUrl = '';
  let _pendingToken = null; // cookie is set by login, but we keep the URL
  let localCounts = null;   // { foods, meals, recipes, diary, settings, total } | null
  let migrationSummary = null;  // { success, errors, totalSuccess, total } | null

  async function connectServer() {
    if (!serverUrlInput.trim()) { showError('Enter a server URL'); return; }
    if (!serverUsername.trim() || !serverPassword.trim()) { showError('Enter credentials'); return; }
    const url = serverUrlInput.trim().replace(/\/$/, '');
    serverConnecting = true;
    try {
      // Use CapacitorHttp on native to bypass CORS (WebView fetch can't reach external origins)
      let loginData;
      if (isNative) {
        const { CapacitorHttp } = await import('@capacitor/core');
        const healthRes = await CapacitorHttp.get({ url: `${url}/api/health` });
        if (healthRes.status < 200 || healthRes.status >= 300) throw new Error('Server not reachable');
        const loginRes = await CapacitorHttp.post({
          url: `${url}/api/auth/login`,
          headers: { 'Content-Type': 'application/json' },
          data: { username: serverUsername.trim(), password: serverPassword },
        });
        loginData = typeof loginRes.data === 'string' ? JSON.parse(loginRes.data) : loginRes.data;
        if (loginRes.status < 200 || loginRes.status >= 300) throw new Error(loginData.error || 'Login failed');
      } else {
        const healthRes = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
        if (!healthRes.ok) throw new Error('Server not reachable');
        const loginRes = await fetch(`${url}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: serverUsername.trim(), password: serverPassword }),
        });
        loginData = await loginRes.json();
        if (!loginRes.ok) throw new Error(loginData.error || 'Login failed');
      }

      _pendingServerUrl = url;
      if (loginData.token) setAuthToken(loginData.token);

      // Count local data so the merge dialog can show what's about to move
      const { countLocalData } = await import('../../lib/migrate.js');
      localCounts = await countLocalData();

      if (localCounts.total > 0) {
        mergeStep = 'ask-settings';
      } else {
        // No local data — just connect directly
        _finalizeConnect();
      }
    } catch (e) {
      showError(explainConnectError(e, url));
    } finally {
      serverConnecting = false;
    }
  }

  async function _mergeAndConnect(mode) {
    mergeStep = 'syncing';
    mergeProgress = '';
    mergeProgressPct = 0;
    mergeStage = '';
    migrationSummary = null;

    const url = _pendingServerUrl;
    const token = getAuthToken();

    try {
      if (mode === 'upload' || mode === 'merge') {
        const { uploadLocalToServer } = await import('../../lib/migrate.js');
        const stageLabels = {
          settings: 'settings',
          foods:    'foods',
          meals:    'meals',
          recipes:  'recipes',
          diary:    'diary entries',
        };
        migrationSummary = await uploadLocalToServer({
          serverUrl: url,
          authToken: token,
          onProgress: (stage, current, total) => {
            mergeStage = stageLabels[stage] || stage;
            mergeProgress = `Uploading ${mergeStage} (${current + 1} / ${total})`;
            mergeProgressPct = total > 0 ? Math.round(((current + 1) / total) * 100) : 0;
          },
        });
      }

      // mode === 'download' or 'merge': server data is pulled on reload via
      // loadServerSettings + NtApiCached.
      // mode === 'upload': server settings stay, local data pushed up.

      // If anything was uploaded, show the summary before finalizing so the
      // user can see per-table results and any errors. Otherwise (download
      // mode, or no errors and nothing to report) finalize directly.
      if (migrationSummary && (migrationSummary.errors.length > 0 || migrationSummary.totalSuccess > 0)) {
        mergeStep = 'summary';
      } else {
        _finalizeConnect();
      }
    } catch (e) {
      mergeStep = null;
      showError('Sync failed: ' + (e.message || 'Unknown error'));
    }
  }

  function _finalizeConnect() {
    setServerUrl(_pendingServerUrl);
    setNativeMode('server');
    DB.setSetting('setupComplete', true);
    serverMode = 'server';
    mergeStep = null;
    showSuccess('Connected to server');
    setTimeout(() => window.location.reload(), 600);
  }

  function cancelMerge() {
    mergeStep = null;
    _pendingServerUrl = '';
    localCounts = null;
    migrationSummary = null;
  }

  async function disconnectServer() {
    // Clear server-mode infrastructure
    setServerUrl(null);
    setAuthToken(null);
    setNativeMode('local');

    // Clear cached auth state so loadAuthState's local branch runs cleanly
    // after the reload. Without this, the cached user + userMgmtActive flag
    // survives in localStorage and the UI keeps showing Sign Out / connected
    // state even though no server is reachable.
    localStorage.removeItem('wl:userId');
    localStorage.removeItem('nt:cachedUser');
    localStorage.removeItem('nt:cachedUserMgmt');
    localStorage.removeItem('nt:csrf');

    // Reset Svelte stores immediately so any open Settings panels
    // re-render to the disconnected state before the reload kicks in.
    currentUser.set(null);
    userMgmtActive.set(false);

    // Local UI state
    serverMode = 'local';
    serverUrlInput = '';
    serverUsername = '';
    serverPassword = '';

    showSuccess('Disconnected — using local storage');
    setTimeout(() => window.location.reload(), 600);
  }

  async function logoutServer() {
    document.body.style.transition = 'opacity 0.3s';
    document.body.style.opacity = '0';
    // Use the proper logout flow so the server-side JWT cookie is invalidated.
    try {
      const { logout } = await import('../../stores/auth.js');
      await logout();
    } catch {}
    setTimeout(() => window.location.reload(), 300);
  }

  // ── Sync-state subscription + tick interval ────────────────────────────
  // Parent shell used to do all of this on Settings mount; drill-in moves
  // the responsibility here since this file owns the Last Synced UI.
  let _syncStoreUnsub = null;
  let _tickInterval = null;
  let _mounted = true;
  onMount(() => {
    if (isNative && getServerUrl()) {
      import('../../lib/sync.js').then(({ syncState }) => {
        if (!_mounted) return;
        _syncStoreUnsub = syncState.subscribe(s => {
          _liveSyncState = s;
          if (s.lastSync) lastSyncAt = s.lastSync;
        });
      }).catch(() => {});
      import('../../lib/db-native.js').then(({ dbGetSyncMeta }) => dbGetSyncMeta('last_sync_at'))
        .then(value => { if (_mounted && value) lastSyncAt = value; })
        .catch(() => {});
      // Re-render the "X ago" label every 30s so it stays accurate without
      // requiring a manual refresh.
      _tickInterval = setInterval(() => { _nowTick = Date.now(); }, 30000);
    }
  });

  onDestroy(() => {
    _mounted = false;
    if (_syncStoreUnsub) _syncStoreUnsub();
    if (_tickInterval) clearInterval(_tickInterval);
  });
</script>

<div class="section-body">
  <div class="card settings-card">
    {#if serverMode === 'server' && getServerUrl()}
      <div class="setting-row">
        <div>
          <span class="setting-label">{_serverReachable ? $_('sync.connected') : $_('sync.server_unavailable')}</span>
          <div class="setting-desc">{getServerUrl()}</div>
        </div>
        <span class="material-symbols-rounded" style:color={_serverReachable ? 'var(--success, #22c55e)' : 'var(--danger)'} style="font-size:22px">
          {_serverReachable ? 'cloud_done' : 'cloud_off'}
        </span>
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('sync.last_synced')}</span>
          <div class="setting-desc">
            {#key _nowTick}{_fmtTimeAgo(lastSyncAt, $_)}{/key}
          </div>
        </div>
        <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px;display:flex;align-items:center;gap:6px" on:click={manualSync} disabled={_syncBusy}>
          <span class="material-symbols-rounded server-sync-icon" class:spin={_syncBusy} style="font-size:16px">autorenew</span>
          {_syncBusy ? $_('sync.syncing') : (_serverReachable ? $_('sync.sync_now') : $_('sync.retry'))}
        </button>
      </div>
      <div class="setting-divider"></div>
      <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-ghost w-full" on:click={logoutServer}>
          <span class="material-symbols-rounded" style="font-size:18px">logout</span>
          Log Out
        </button>
        <button class="btn btn-ghost w-full" style="color:var(--danger)" on:click={disconnectServer}>
          <span class="material-symbols-rounded" style="font-size:18px">link_off</span>
          Disconnect &amp; Use Locally
        </button>
      </div>
    {:else}
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_integrations.local_mode')}</span>
          <div class="setting-desc">{$_('settings_integrations.local_mode_desc')}</div>
        </div>
        <span class="material-symbols-rounded" style="color:var(--text-3);font-size:22px">smartphone</span>
      </div>
      <div class="setting-divider"></div>
      <div style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
        <div class="form-group" style="margin:0">
          <label class="form-label">{$_('settings_integrations.server_url')}</label>
          <input class="input" type="url" placeholder="https://nutritrace.example.com" bind:value={serverUrlInput} />
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">{$_('settings_integrations.username')}</label>
          <input class="input" type="text" placeholder={$_('settings_main_deep.server_username_ph')} bind:value={serverUsername} autocapitalize="off" />
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">{$_('settings_integrations.password')}</label>
          <div style="position:relative">
            {#if serverShowPw}
              <input class="input" type="text" placeholder={$_('settings_main_deep.server_password_ph')} bind:value={serverPassword} style="padding-right:40px" />
            {:else}
              <input class="input" type="password" placeholder={$_('settings_main_deep.server_password_ph')} bind:value={serverPassword} style="padding-right:40px" />
            {/if}
            <button type="button" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-3);padding:4px" on:click={() => serverShowPw = !serverShowPw}>
              <span class="material-symbols-rounded" style="font-size:20px">{serverShowPw ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
        </div>
        <button class="btn btn-primary w-full" on:click={connectServer} disabled={serverConnecting}>
          {serverConnecting ? 'Connecting…' : 'Connect to Server'}
        </button>
      </div>
    {/if}
  </div>
</div>

<!-- Merge dialog (shown when connecting to server with existing local data) -->
{#if mergeStep === 'ask-settings'}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 style="margin:0 0 6px;font-size:18px;color:var(--text-1)">{$_('settings_merge.title')}</h3>
      <p style="font-size:13px;color:var(--text-3);margin:0 0 12px;line-height:1.5">
        You have data on this phone. How should it be handled when connecting?
      </p>
      {#if localCounts && localCounts.total > 0}
        <div class="merge-counts" style="margin:0 0 16px">
          <div class="merge-counts-title">On this phone:</div>
          <div class="merge-counts-grid">
            {#if localCounts.foods    > 0}<div><strong>{localCounts.foods}</strong> {localCounts.foods === 1 ? 'food' : 'foods'}</div>{/if}
            {#if localCounts.meals    > 0}<div><strong>{localCounts.meals}</strong> {localCounts.meals === 1 ? 'meal' : 'meals'}</div>{/if}
            {#if localCounts.recipes  > 0}<div><strong>{localCounts.recipes}</strong> {localCounts.recipes === 1 ? 'recipe' : 'recipes'}</div>{/if}
            {#if localCounts.diary    > 0}<div><strong>{localCounts.diary}</strong> diary {localCounts.diary === 1 ? 'day' : 'days'}</div>{/if}
            {#if localCounts.settings > 0}<div><strong>{localCounts.settings}</strong> settings</div>{/if}
          </div>
        </div>
      {/if}
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="merge-option" on:click={() => _mergeAndConnect('upload')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">cloud_upload</span>
          <div>
            <div class="merge-option-title">{$_('settings_merge.upload')}</div>
            <div class="merge-option-desc">Send this phone's foods, diary, and settings to the server. Existing server data stays.</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('download')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">cloud_download</span>
          <div>
            <div class="merge-option-title">{$_('settings_merge.download')}</div>
            <div class="merge-option-desc">Replace this phone's data with everything from the server. Local data is discarded.</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('merge')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">sync</span>
          <div>
            <div class="merge-option-title">{$_('settings_merge.merge')}</div>
            <div class="merge-option-desc">Upload phone data to the server AND download server data. Nothing is lost, but duplicates are possible.</div>
          </div>
        </button>
        <button class="btn btn-ghost w-full" style="color:var(--text-3);margin-top:4px" on:click={cancelMerge}>{$_('settings_merge.cancel')}</button>
      </div>
    </div>
  </div>
{:else if mergeStep === 'syncing'}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog" style="text-align:center">
      <span class="material-symbols-rounded" style="font-size:36px;color:var(--accent);animation:spin 1.2s linear infinite">autorenew</span>
      <p style="font-size:15px;color:var(--text-1);margin:12px 0 4px;font-weight:600">Syncing…</p>
      <p style="font-size:13px;color:var(--text-3);margin:0">{mergeProgress || 'Preparing…'}</p>
      {#if mergeProgressPct > 0}
        <div class="merge-progress-bar" style="margin-top:14px">
          <div class="merge-progress-fill" style="width:{mergeProgressPct}%"></div>
        </div>
      {/if}
    </div>
  </div>
{:else if mergeStep === 'summary' && migrationSummary}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 style="margin:0 0 6px;font-size:18px;color:var(--text-1)">
        {migrationSummary.errors.length === 0 ? 'Upload complete' : 'Upload finished with issues'}
      </h3>
      <p style="font-size:13px;color:var(--text-3);margin:0 0 14px;line-height:1.5">
        {migrationSummary.totalSuccess} of {migrationSummary.total} {migrationSummary.total === 1 ? 'item' : 'items'} uploaded successfully.
      </p>
      <div class="merge-counts" style="margin:0 0 14px">
        <div class="merge-counts-title">Uploaded to server:</div>
        <div class="merge-counts-grid">
          {#if migrationSummary.success.foods    > 0}<div><strong>{migrationSummary.success.foods}</strong> {migrationSummary.success.foods === 1 ? 'food' : 'foods'}</div>{/if}
          {#if migrationSummary.success.meals    > 0}<div><strong>{migrationSummary.success.meals}</strong> {migrationSummary.success.meals === 1 ? 'meal' : 'meals'}</div>{/if}
          {#if migrationSummary.success.recipes  > 0}<div><strong>{migrationSummary.success.recipes}</strong> {migrationSummary.success.recipes === 1 ? 'recipe' : 'recipes'}</div>{/if}
          {#if migrationSummary.success.diary    > 0}<div><strong>{migrationSummary.success.diary}</strong> diary {migrationSummary.success.diary === 1 ? 'day' : 'days'}</div>{/if}
          {#if migrationSummary.success.settings > 0}<div><strong>{migrationSummary.success.settings}</strong> settings</div>{/if}
        </div>
      </div>
      {#if migrationSummary.errors.length > 0}
        <div style="margin:0 0 14px">
          <div class="merge-counts-title" style="color:var(--danger,#e57373)">
            {migrationSummary.errors.length} {migrationSummary.errors.length === 1 ? 'error' : 'errors'}
            {#if migrationSummary.errors.length > 5}(showing first 5){/if}
          </div>
          <ul style="font-size:12px;color:var(--text-3);padding-left:18px;margin:6px 0 0;line-height:1.5">
            {#each migrationSummary.errors.slice(0, 5) as err}
              <li><strong>{err.stage}</strong> · {err.name}: {err.message}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <button class="btn btn-primary w-full" on:click={_finalizeConnect}>{$_('settings_merge.continue')}</button>
    </div>
  </div>
{/if}

<style>
  /* ── Merge dialog ── */
  .merge-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .merge-dialog {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    padding: 20px; width: 100%; max-width: 360px;
  }
  .merge-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 12px);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s;
  }
  .merge-option:hover { border-color: var(--accent); }
  .merge-option-title { font-size: 14px; font-weight: 600; color: var(--text-1); margin-bottom: 2px; }
  .merge-option-desc { font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .merge-counts {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
  }
  .merge-counts-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .merge-counts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 4px 12px;
    font-size: 13px;
    color: var(--text-2);
  }
  .merge-counts-grid strong { color: var(--text-1); font-weight: 600; }
  .merge-progress-bar {
    height: 6px;
    background: var(--surface-2);
    border-radius: 3px;
    overflow: hidden;
  }
  .merge-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1s linear infinite; display: inline-block; }
  @keyframes server-sync-spin {
    to { transform: rotate(360deg); }
  }
  .server-sync-icon.spin {
    transform-origin: center;
    animation: server-sync-spin 0.8s linear infinite;
  }
</style>
