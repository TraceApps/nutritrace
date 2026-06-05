<script>
  import { tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import Dialog from '../ui/Dialog.svelte';
  import TimePicker from '../ui/TimePicker.svelte';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { DB } from '../../lib/db.js';
  import { NtApi } from '../../lib/api.js';
  import { currentUser, userMgmtActive } from '../../stores/auth.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';
  // Local-mode scheduled-backup settings (mirror the server-side admin
  // config but stored per-device since there's no server in local mode).
  // See src/lib/local-backup-scheduler.js for the JS-side tick that
  // consumes these.
  import {
    localBackupSchedule, localBackupTime, localBackupRetention,
    localBackupLastRun, localBackupLastError,
  } from '../../stores/settings.js';

  const isNativeLocal = isNative && !getServerUrl();

  function _fetchOpts(extra = {}) {
    const h = { ...extra };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return { credentials: 'include', headers: h };
  }

  // ── Backup state ─────────────────────────────────────────────────────────────

  // Native: use Capacitor Filesystem for downloads
  async function _nativeDownload(blob, filename) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const reader = new FileReader();
    const base64 = await new Promise((res, rej) => {
      reader.onload = () => res(reader.result.split(',')[1]);
      reader.onerror = rej;
      reader.readAsDataURL(blob);
    });
    await Filesystem.writeFile({ path: `Download/${filename}`, data: base64, directory: Directory.ExternalStorage, recursive: true });
    showSuccess(`Saved to Download/${filename}`);
  }

  function _downloadBlob(blob, filename) {
    if (isNative) { _nativeDownload(blob, filename); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Local Full Backup (.zip with embedded images) ──────────────────────────
  let localZipBusy = false;
  let localZipStatus = '';
  let localBackups = [];
  const LOCAL_BACKUP_DIR = 'nutritrace-backups';

  export async function loadLocalBackups() {
    if (!isNativeLocal) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      try {
        await Filesystem.mkdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents, recursive: true });
      } catch {}
      const list = await Filesystem.readdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents });
      localBackups = (list.files || [])
        .filter(f => f.name && f.name.endsWith('.zip'))
        .map(f => ({
          filename: f.name,
          size: f.size || 0,
          createdAt: f.mtime ? new Date(f.mtime).toISOString() : new Date().toISOString(),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (e) {
      console.warn('[backup] list failed:', e.message);
      localBackups = [];
    }
  }

  async function exportLocalZip() {
    if (localZipBusy || !isNativeLocal) return;
    localZipBusy = true;
    localZipStatus = 'Starting…';
    try {
      const { exportLocalBackup } = await import('../../lib/local-backup.js');
      const blob = await exportLocalBackup({
        onProgress: (pct, label) => { localZipStatus = `${Math.round(pct)}% — ${label}`; },
      });
      const filename = `nutritrace-backup-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.zip`;
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      const b64 = btoa(binary);
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.mkdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents, recursive: true }).catch(() => {});
      await Filesystem.writeFile({
        path: `${LOCAL_BACKUP_DIR}/${filename}`,
        data: b64,
        directory: Directory.Documents,
      });
      localZipStatus = '';
      showSuccess('Backup created');
      await loadLocalBackups();
    } catch (e) {
      console.error('[backup] export failed:', e);
      localZipStatus = '';
      showError('Backup failed: ' + e.message);
    } finally {
      localZipBusy = false;
    }
  }

  async function importLocalZip() {
    if (localZipBusy) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip,application/x-zip-compressed';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await _runImport(file);
    };
    input.click();
  }

  async function restoreLocalBackup(filename) {
    if (localZipBusy) return;
    const yes = confirm(`Restore "${filename}"? Existing data is merged, not erased.`);
    if (!yes) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const result = await Filesystem.readFile({
        path: `${LOCAL_BACKUP_DIR}/${filename}`,
        directory: Directory.Documents,
      });
      const b64 = typeof result.data === 'string' ? result.data : await _blobToB64(result.data);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await _runImport(new Blob([bytes], { type: 'application/zip' }));
    } catch (e) {
      console.error('[backup] restore failed:', e);
      showError('Restore failed: ' + e.message);
    }
  }

  async function _blobToB64(blob) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
      r.readAsDataURL(blob);
    });
  }

  async function _runImport(file) {
    localZipBusy = true;
    localZipStatus = 'Reading…';
    try {
      const { importLocalBackup } = await import('../../lib/local-backup.js');
      const result = await importLocalBackup(file, {
        onProgress: (pct, label) => { localZipStatus = `${Math.round(pct)}% — ${label}`; },
      });
      const c = result.counts;
      showSuccess(`Restored ${c.foods} foods · ${c.meals} meals · ${c.recipes} recipes · ${c.diary} days · ${c.wellness} metrics`);
      localZipStatus = '';
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      console.error('[backup] import failed:', e);
      localZipStatus = '';
      showError('Restore failed: ' + e.message);
    } finally {
      localZipBusy = false;
    }
  }

  async function deleteLocalBackup(filename) {
    const yes = confirm(`Delete "${filename}"? This cannot be undone.`);
    if (!yes) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.deleteFile({
        path: `${LOCAL_BACKUP_DIR}/${filename}`,
        directory: Directory.Documents,
      });
      showSuccess('Backup deleted');
      await loadLocalBackups();
    } catch (e) {
      console.error('[backup] delete failed:', e);
      showError($_('common.errors.delete_failed') + ': ' + e.message);
    }
  }

  async function shareLocalBackup(filename) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const uri = await Filesystem.getUri({
        path: `${LOCAL_BACKUP_DIR}/${filename}`,
        directory: Directory.Documents,
      });
      try {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title: 'NutriTrace Backup',
          text: filename,
          url: uri.uri,
          dialogTitle: 'Share backup',
        });
      } catch {
        showSuccess(`Saved at: ${uri.uri}`);
      }
    } catch (e) {
      console.error('[backup] share failed:', e);
      showError('Share failed: ' + e.message);
    }
  }

  // ── Full Backup (server mode, admin only) ──────────────────────────────────
  let fullBackups        = [];
  let fullBackupBusy     = false;
  let restoreTarget      = null;
  let deleteTarget       = null;
  let showRestoreDialog  = false;
  let showDeleteBkDialog = false;
  let restoreStatus      = null;
  let restoreProgressEl  = null;

  // Auto Backup schedule (admin-global setting in app_config, env-lockable
  // via BACKUP_SCHEDULE / BACKUP_TIME / BACKUP_RETENTION). Loaded on mount
  // and after each save. Off by default.
  let scheduleCfg = null;
  let scheduleBusy = false;

  export async function loadSchedule() {
    if (isNativeLocal) return;
    try {
      const res = await fetch(apiUrl('/api/full-backup/schedule'), _fetchOpts());
      if (!res.ok) return; // not admin; or env not yet wired — silent
      scheduleCfg = await res.json();
    } catch {}
  }

  async function saveSchedule(patch) {
    if (!scheduleCfg || scheduleCfg.envLocked) return;
    scheduleBusy = true;
    try {
      // _fetchOpts() returns { credentials, headers: { csrf | bearer } }
      // and spreading it last would override an inline `headers` key —
      // dropping Content-Type so the server can't parse the body and
      // setScheduleConfig({}) silently no-ops, reverting the UI to off.
      // Pass Content-Type via the extras param so it merges into the
      // same headers object the auth pieces use.
      const res = await fetch(apiUrl('/api/full-backup/schedule'), {
        method: 'PUT',
        body: JSON.stringify(patch),
        ..._fetchOpts({ 'Content-Type': 'application/json' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || $_('common.errors.save_failed'));
        await loadSchedule(); // re-sync so the UI reflects what's actually stored
        return;
      }
      scheduleCfg = data;
    } catch (e) {
      showError(e?.message || $_('common.errors.save_failed'));
    } finally {
      scheduleBusy = false;
    }
  }

  // Local-mode schedule: same shape as the server-side scheduleCfg above
  // but sourced from the per-device settings stores instead of a fetch.
  // Reactive so changes from anywhere (other tabs, the scheduler itself
  // updating lastRun/lastError) flow into the UI live.
  $: localScheduleCfg = isNativeLocal ? {
    schedule:      $localBackupSchedule  || 'off',
    time:          $localBackupTime      || '03:00',
    retention:     parseInt($localBackupRetention, 10) || 7,
    lastAutoRun:   $localBackupLastRun   || null,
    lastAutoError: $localBackupLastError || null,
    envLocked:     false,
  } : null;

  function saveLocalSchedule(patch) {
    if (!isNativeLocal) return;
    if (patch.schedule != null) {
      if (!['off','daily','weekly','monthly'].includes(patch.schedule)) return;
      localBackupSchedule.set(patch.schedule);
    }
    if (patch.time != null) {
      if (!/^\d{1,2}:\d{2}$/.test(patch.time)) return;
      const [h, m] = patch.time.split(':').map(n => parseInt(n, 10));
      if (h < 0 || h > 23 || m < 0 || m > 59) return;
      localBackupTime.set(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    }
    if (patch.retention != null) {
      const r = parseInt(patch.retention, 10);
      if (Number.isFinite(r) && r >= 1 && r <= 99) localBackupRetention.set(r);
    }
  }

  // Status helpers — phrasing the "next due" and "last run" lines so the
  // admin can see at a glance what the scheduler is going to do.
  function _formatRelative(iso) {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const hours = ms / 3_600_000;
    if (hours < 1)   return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
    if (hours < 36)  return `${Math.round(hours)} hr ago`;
    return `${Math.round(hours / 24)} days ago`;
  }
  function _nextDueLabel(cfg) {
    if (!cfg || cfg.schedule === 'off') return null;
    const [hh, mm] = cfg.time.split(':').map(n => parseInt(n, 10));
    const intervalDays = { daily: 1, weekly: 7, monthly: 28 }[cfg.schedule] || 1;
    const now = new Date();
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
    // If today's scheduled time hasn't passed AND we haven't run inside the
    // interval boundary, next due is today. Otherwise step forward.
    if (cfg.lastAutoRun) {
      const last = new Date(cfg.lastAutoRun).getTime();
      while (next.getTime() <= now.getTime() || (next.getTime() - last) / 86_400_000 < intervalDays - 0.5) {
        next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1, hh, mm, 0);
      }
    } else if (next.getTime() <= now.getTime()) {
      next = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1, hh, mm, 0);
    }
    return next.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function _scrollToProgress() {
    await tick();
    restoreProgressEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  export async function loadFullBackups() {
    if (isNativeLocal) return;
    try {
      const res = await fetch(apiUrl('/api/full-backup'), _fetchOpts());
      if (!res.ok) {
        // Surface the server's error so the user knows the list is empty
        // because of a failure (not because there are no backups). The
        // catch block previously swallowed both fetch errors AND non-2xx
        // responses, leaving the user with a silent empty list.
        const body = await res.json().catch(() => ({}));
        showError(body?.error || `Couldn't load backups (${res.status})`);
        return;
      }
      fullBackups = await res.json();
    } catch (e) {
      showError(e?.message || $_('common.errors.cant_reach_server'));
    }
  }

  async function createFullBackup() {
    fullBackupBusy = true;
    try {
      const res  = await fetch(apiUrl('/api/full-backup'), { method: 'POST', ..._fetchOpts() });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Backup failed'); return; }
      showSuccess('Full backup created');
      await loadFullBackups();
    } catch { showError('Backup failed'); }
    finally   { fullBackupBusy = false; }
  }

  function downloadFullBackup(filename) {
    const a = document.createElement('a');
    a.href = apiUrl(`/api/full-backup/${encodeURIComponent(filename)}/download`);
    a.download = filename;
    a.click();
  }

  async function confirmRestoreFullBackup() {
    if (!restoreTarget) return;
    showRestoreDialog = false;
    const filename = restoreTarget;
    restoreTarget = null;
    fullBackupBusy = true;
    restoreStatus = { phase: 'restoring', percent: 40, label: 'Restoring backup…' };
    _scrollToProgress();
    try {
      const res  = await fetch(apiUrl(`/api/full-backup/${encodeURIComponent(filename)}/restore`), { method: 'POST', ..._fetchOpts() });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Restore failed'); restoreStatus = null; return; }
      restoreStatus = { phase: 'restoring', percent: 100, label: 'Restore complete — reloading…' };
      setTimeout(() => location.reload(), 1500);
    } catch (err) { showError('Restore failed: ' + (err.message || 'Unknown error')); restoreStatus = null; }
    finally   { fullBackupBusy = false; }
  }

  async function confirmDeleteFullBackup() {
    if (!deleteTarget) return;
    showDeleteBkDialog = false;
    const filename = deleteTarget;
    deleteTarget = null;
    try {
      const res = await fetch(apiUrl(`/api/full-backup/${encodeURIComponent(filename)}`), { method: 'DELETE', ..._fetchOpts() });
      if (res.ok) { showSuccess('Backup deleted'); await loadFullBackups(); }
      else showError($_('common.errors.delete_failed'));
    } catch { showError($_('common.errors.delete_failed')); }
  }

  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  let showUploadRestoreDialog = false;
  let uploadRestoreFile       = null;

  function pickUploadRestore() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.zip';
    input.onchange = e => {
      const file = e.target.files?.[0];
      if (!file) return;
      uploadRestoreFile = file;
      showUploadRestoreDialog = true;
    };
    input.click();
  }

  function confirmUploadRestore() {
    if (!uploadRestoreFile) return;
    showUploadRestoreDialog = false;
    fullBackupBusy = true;
    restoreStatus = { phase: 'uploading', percent: 0, label: 'Uploading backup…' };
    _scrollToProgress();

    const file = uploadRestoreFile;
    uploadRestoreFile = null;

    const form = new FormData();
    form.append('backup', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/full-backup/upload-restore'));
    xhr.withCredentials = true;

    xhr.upload.onprogress = ev => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 85);
        restoreStatus = { phase: 'uploading', percent: pct, label: `Uploading… ${pct}%` };
      }
    };

    xhr.onload = () => {
      fullBackupBusy = false;
      if (xhr.status >= 200 && xhr.status < 300) {
        let err = null;
        try { const d = JSON.parse(xhr.responseText); if (d.error) err = d.error; } catch {}
        if (err) { showError('Restore failed: ' + err); restoreStatus = null; return; }
        restoreStatus = { phase: 'restoring', percent: 95, label: 'Restoring on server…' };
        setTimeout(() => {
          restoreStatus = { phase: 'restoring', percent: 100, label: 'Restore complete — reloading…' };
          setTimeout(() => location.reload(), 1000);
        }, 600);
      } else if (xhr.status === 413) {
        showError('Upload failed: file exceeds the maximum size allowed by your server or reverse proxy. If accessing remotely, try uploading from your local network.');
        restoreStatus = null;
      } else {
        let msg = `Server error ${xhr.status}`;
        try { const d = JSON.parse(xhr.responseText); if (d.error) msg = d.error; } catch {}
        showError('Restore failed: ' + msg);
        restoreStatus = null;
      }
    };

    xhr.onerror = () => {
      fullBackupBusy = false;
      restoreStatus = null;
      showError($_('common.errors.network_error_upload'));
    };

    xhr.send(form);
  }

  // ── Danger zone ────────────────────────────────────────────────────────────
  let showClearDialog = false;
  let showClearSettingsDialog = false;

  async function clearAllData() {
    try {
      await NtApi.del('/api/data');
      showSuccess('All data cleared');
      const { loadAuthState } = await import('../../stores/auth.js');
      await loadAuthState();
    } catch(e) { showError('Clear failed: ' + e.message); }
  }

  async function clearAllSettings() {
    try {
      await fetch(apiUrl('/api/settings'), { method: 'DELETE', ..._fetchOpts() });
      const userId = localStorage.getItem('wl:userId');
      const prefix = userId ? `wl_u${userId}_` : 'wl_';
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
      DB.setSetting('setupComplete', true);
      showSuccess('All settings cleared');
      setTimeout(() => location.reload(), 800);
    } catch(e) { showError('Clear failed: ' + e.message); }
  }
</script>

<div class="section-body" transition:slide={{ duration: 180 }}>

  <!-- Full backup (admin only, server mode only — files stored on server) -->
  {#if $currentUser?.role === 'admin' && !isNativeLocal}
  <p class="sub-label">Full Backup</p>
  <div class="card settings-card">
    <div style="padding:12px 16px 4px">
      <p class="setting-desc" style="margin:0 0 12px">A complete snapshot of everything: all user data, diary, foods, meals, recipes, settings, and uploaded images. Saved on the server and available to download or restore at any time.</p>

      <!-- Auto Backup schedule. Admin sets it once; scheduler.js fires
           backups when due and prunes older archives past the retention
           limit. Env-lockable via BACKUP_SCHEDULE / BACKUP_TIME /
           BACKUP_RETENTION for ops-driven deployments. -->
      {#if scheduleCfg}
        <div class="auto-bk">
          <div class="auto-bk-head">
            <span class="auto-bk-title">Auto Backup</span>
            {#if scheduleCfg.envLocked}
              <span class="env-lock-pill" title="Locked by BACKUP_SCHEDULE / BACKUP_TIME / BACKUP_RETENTION env var">Locked by env</span>
            {/if}
          </div>
          <div class="auto-bk-fields">
            <label class="auto-bk-field">
              <span class="auto-bk-label">Schedule</span>
              <select class="select sel-sm"
                bind:value={scheduleCfg.schedule}
                disabled={scheduleCfg.envLocked || scheduleBusy}
                on:change={() => saveSchedule({ schedule: scheduleCfg.schedule })}>
                <option value="off">Off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            {#if scheduleCfg.schedule !== 'off'}
              <label class="auto-bk-field">
                <span class="auto-bk-label">Time</span>
                <TimePicker value={scheduleCfg.time}
                  disabled={scheduleCfg.envLocked || scheduleBusy}
                  on:change={(e) => saveSchedule({ time: e.detail })} />
              </label>
              <label class="auto-bk-field">
                <span class="auto-bk-label">Keep Last</span>
                <input class="input" type="number" min="1" max="99"
                  bind:value={scheduleCfg.retention}
                  disabled={scheduleCfg.envLocked || scheduleBusy}
                  on:change={() => saveSchedule({ retention: scheduleCfg.retention })} />
              </label>
            {/if}
          </div>
          {#if scheduleCfg.schedule !== 'off'}
            <div class="auto-bk-status">
              {#if scheduleCfg.lastAutoError}
                <div class="auto-bk-status-row error">
                  <span class="material-symbols-rounded" style="font-size:16px">error</span>
                  <span>Last auto-backup failed: {scheduleCfg.lastAutoError}</span>
                </div>
              {/if}
              {#if scheduleCfg.lastAutoRun}
                <div class="auto-bk-status-row">
                  <span class="material-symbols-rounded" style="font-size:16px">check_circle</span>
                  <span>Last auto-backup: {_formatRelative(scheduleCfg.lastAutoRun)}</span>
                </div>
              {/if}
              {#if _nextDueLabel(scheduleCfg)}
                <div class="auto-bk-status-row">
                  <span class="material-symbols-rounded" style="font-size:16px">schedule</span>
                  <span>Next: {_nextDueLabel(scheduleCfg)}</span>
                </div>
              {/if}
              {#if scheduleCfg.retention}
                <div class="auto-bk-status-row subtle">
                  Keeps the {scheduleCfg.retention} newest backup{scheduleCfg.retention === 1 ? '' : 's'}; older archives prune automatically after each run.
                </div>
              {/if}
            </div>
          {/if}
        </div>
        <div class="setting-divider" style="margin:0 -16px 12px"></div>
      {/if}

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <button class="btn btn-primary" style="height:36px;font-size:13px"
          on:click={createFullBackup} disabled={fullBackupBusy}>
          {#if fullBackupBusy}
            <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span> Working…
          {:else}
            <span class="material-symbols-rounded" style="font-size:16px">add_circle</span> Create Backup
          {/if}
        </button>
        <button class="btn btn-secondary" style="height:36px;font-size:13px"
          on:click={pickUploadRestore} disabled={fullBackupBusy}>
          <span class="material-symbols-rounded" style="font-size:16px">upload</span> Upload &amp; Restore
        </button>
      </div>
      {#if restoreStatus}
        <div class="restore-progress" bind:this={restoreProgressEl}>
          <div class="restore-progress-label">
            <span class="material-symbols-rounded spin" style="font-size:15px;flex-shrink:0">autorenew</span>
            {restoreStatus.label}
          </div>
          <div class="restore-progress-track">
            <div class="restore-progress-fill" style="width:{restoreStatus.percent}%"></div>
          </div>
        </div>
      {/if}
    </div>

    {#if fullBackups.length > 0}
      <div class="setting-divider"></div>
      <!-- Table header -->
      <div class="backup-table-header">
        <span>Name</span>
        <span>Created</span>
        <span>Size</span>
        <span></span>
      </div>
      <div class="setting-divider"></div>
      {#each fullBackups as bk, i}
        {#if i > 0}<div class="setting-divider"></div>{/if}
        <div class="backup-row">
          <span class="backup-name">{bk.filename}</span>
          <span class="backup-col-date">{new Date(bk.createdAt).toLocaleDateString()}</span>
          <span class="backup-col-size">{fmtBytes(bk.size)}</span>
          <div class="backup-actions">
            <button class="btn btn-secondary backup-action-btn"
              on:click={() => downloadFullBackup(bk.filename)}>
              <span class="material-symbols-rounded" style="font-size:15px">download</span> Download
            </button>
            <button class="btn btn-secondary backup-action-btn"
              on:click={() => { restoreTarget = bk.filename; showRestoreDialog = true; }} disabled={fullBackupBusy}>
              <span class="material-symbols-rounded" style="font-size:15px">restore</span> Restore
            </button>
            <button class="btn-icon" style="color:var(--danger);padding:0 4px"
              on:click={() => { deleteTarget = bk.filename; showDeleteBkDialog = true; }} title="Delete backup">
              <span class="material-symbols-rounded" style="font-size:20px">delete</span>
            </button>
          </div>
        </div>
      {/each}
    {:else}
      <div class="setting-divider"></div>
      <p style="padding:12px 16px;font-size:13px;color:var(--text-3);margin:0">No backups yet — click Create Backup to get started.</p>
    {/if}
  </div>
  {/if}

  {#if isNativeLocal}
  <p class="sub-label">Full Backup</p>
  <div class="card settings-card">
    <div style="padding:12px 16px 4px">
      <p class="setting-desc" style="margin:0 0 12px">A complete snapshot of everything: all foods, meals, recipes, diary, wellness data, workouts, settings, AND embedded image files. Saved to your device's Documents folder, ready for phone-to-phone transfer without needing a server.</p>

      <!-- Auto Backup (local mode). Runs JS-side while the app is open,
           fires when due, saves to Documents/nutritrace-backups/ with an
           auto- prefix. Retention prune only touches auto-prefixed files
           so manual exports are never deleted by the scheduler. Tick
           happens on app open + every ~5 min + on visibilitychange, so a
           daily schedule lands within minutes of the first time you open
           the app after the scheduled time. -->
      {#if localScheduleCfg}
        <div class="auto-bk">
          <div class="auto-bk-head">
            <span class="auto-bk-title">Auto Backup</span>
          </div>
          <div class="auto-bk-fields">
            <label class="auto-bk-field">
              <span class="auto-bk-label">Schedule</span>
              <select class="select sel-sm"
                value={localScheduleCfg.schedule}
                on:change={(e) => saveLocalSchedule({ schedule: e.target.value })}>
                <option value="off">Off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            {#if localScheduleCfg.schedule !== 'off'}
              <label class="auto-bk-field">
                <span class="auto-bk-label">Time</span>
                <TimePicker value={localScheduleCfg.time}
                  on:change={(e) => saveLocalSchedule({ time: e.detail })} />
              </label>
              <label class="auto-bk-field">
                <span class="auto-bk-label">Keep Last</span>
                <input class="input" type="number" min="1" max="99"
                  value={localScheduleCfg.retention}
                  on:change={(e) => saveLocalSchedule({ retention: e.target.value })} />
              </label>
            {/if}
          </div>
          {#if localScheduleCfg.schedule !== 'off'}
            <div class="auto-bk-status">
              {#if localScheduleCfg.lastAutoError}
                <div class="auto-bk-status-row error">
                  <span class="material-symbols-rounded" style="font-size:16px">error</span>
                  <span>Last auto-backup failed: {localScheduleCfg.lastAutoError}</span>
                </div>
              {/if}
              {#if localScheduleCfg.lastAutoRun}
                <div class="auto-bk-status-row">
                  <span class="material-symbols-rounded" style="font-size:16px">check_circle</span>
                  <span>Last auto-backup: {_formatRelative(localScheduleCfg.lastAutoRun)}</span>
                </div>
              {/if}
              {#if _nextDueLabel(localScheduleCfg)}
                <div class="auto-bk-status-row">
                  <span class="material-symbols-rounded" style="font-size:16px">schedule</span>
                  <span>Next: {_nextDueLabel(localScheduleCfg)} (fires when app is open)</span>
                </div>
              {/if}
              <div class="auto-bk-status-row subtle">
                Keeps the {localScheduleCfg.retention} newest auto-backup{localScheduleCfg.retention === 1 ? '' : 's'}; manual exports are never pruned.
              </div>
            </div>
          {/if}
        </div>
        <div class="setting-divider" style="margin:0 -16px 12px"></div>
      {/if}

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <button class="btn btn-primary" style="height:36px;font-size:13px"
          on:click={exportLocalZip} disabled={localZipBusy}>
          {#if localZipBusy}
            <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span> Working…
          {:else}
            <span class="material-symbols-rounded" style="font-size:16px">add_circle</span> Create Backup
          {/if}
        </button>
        <button class="btn btn-secondary" style="height:36px;font-size:13px"
          on:click={importLocalZip} disabled={localZipBusy}>
          <span class="material-symbols-rounded" style="font-size:16px">upload</span> Upload &amp; Restore
        </button>
      </div>
      {#if localZipStatus}
        <div class="restore-progress">
          <div class="restore-progress-label">
            <span class="material-symbols-rounded spin" style="font-size:15px;flex-shrink:0">autorenew</span>
            {localZipStatus}
          </div>
        </div>
      {/if}
    </div>

    {#if localBackups.length > 0}
      <div class="setting-divider"></div>
      <div class="backup-table-header">
        <span>Name</span>
        <span>Created</span>
        <span>Size</span>
        <span></span>
      </div>
      <div class="setting-divider"></div>
      {#each localBackups as bk, i}
        {#if i > 0}<div class="setting-divider"></div>{/if}
        <div class="backup-row">
          <span class="backup-name">{bk.filename}</span>
          <span class="backup-col-date">{new Date(bk.createdAt).toLocaleDateString()}</span>
          <span class="backup-col-size">{fmtBytes(bk.size)}</span>
          <div class="backup-actions">
            <button class="btn btn-secondary backup-action-btn"
              on:click={() => shareLocalBackup(bk.filename)}>
              <span class="material-symbols-rounded" style="font-size:15px">share</span> Share
            </button>
            <button class="btn btn-secondary backup-action-btn"
              on:click={() => restoreLocalBackup(bk.filename)} disabled={localZipBusy}>
              <span class="material-symbols-rounded" style="font-size:15px">restore</span> Restore
            </button>
            <button class="btn-icon" style="color:var(--danger);padding:0 4px"
              on:click={() => deleteLocalBackup(bk.filename)} title="Delete backup">
              <span class="material-symbols-rounded" style="font-size:20px">delete</span>
            </button>
          </div>
        </div>
      {/each}
    {:else}
      <div class="setting-divider"></div>
      <p style="padding:12px 16px;font-size:13px;color:var(--text-3);margin:0">No backups yet — tap Create Backup to get started.</p>
    {/if}
  </div>
  {/if}
  <!-- Danger zone -->
  <p class="sub-label danger-zone-label">Danger Zone</p>
  <div class="card settings-card danger-zone-card">
    <button class="setting-row setting-action danger" on:click={() => showClearDialog = true}>
      <span class="material-symbols-rounded si" style="color:var(--danger)">delete_forever</span>
      <div>
        <span class="setting-label" style="color:var(--danger)">Clear all data</span>
        <div class="setting-desc">Permanently deletes all diary entries, foods, meals, and body stats. Settings and credentials are kept.</div>
      </div>
      <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger);flex-shrink:0">chevron_right</span>
    </button>
    <div class="setting-divider"></div>
    <button class="setting-row setting-action danger" on:click={() => showClearSettingsDialog = true}>
      <span class="material-symbols-rounded si" style="color:var(--danger)">manage_history</span>
      <div>
        <span class="setting-label" style="color:var(--danger)">Clear all settings</span>
        <div class="setting-desc">Resets all preferences, credentials, and API keys to defaults. Food and diary data are kept.</div>
      </div>
      <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger);flex-shrink:0">chevron_right</span>
    </button>
    <!-- Delete my account lives in Profile → Danger zone (single source of truth). -->
  </div>

</div>

<Dialog bind:open={showClearDialog}
  title="Clear all data"
  message="This will permanently delete all diary entries, foods, meals, and body stats. Settings and credentials are kept. This cannot be undone."
  confirmText="Delete all data"
  cancelText="Cancel"
  dangerous
  on:confirm={clearAllData}
/>

<Dialog bind:open={showClearSettingsDialog}
  title="Clear all settings"
  message="This will reset all preferences, credentials, and API keys to defaults. Food and diary data are kept. This cannot be undone."
  confirmText="Clear all settings"
  cancelText="Cancel"
  dangerous
  on:confirm={clearAllSettings}
/>

<Dialog bind:open={showRestoreDialog}
  title="Restore backup?"
  message="This will replace all current data with the contents of this backup. This cannot be undone."
  confirmText="Restore"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmRestoreFullBackup}
/>

<Dialog bind:open={showUploadRestoreDialog}
  title="Restore from uploaded file?"
  message="This will replace all current data with the contents of the uploaded backup. This cannot be undone."
  confirmText="Restore"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmUploadRestore}
/>

<Dialog bind:open={showDeleteBkDialog}
  title="Delete backup?"
  message="This backup file will be permanently removed from the server."
  confirmText="Delete"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmDeleteFullBackup}
/>

<style>
  /* Auto Backup schedule block — compact stack of label+input pairs that
     wraps on narrow screens. Status rows below show last run / next due /
     retention note. Env-lock pill flags ops-controlled config. */
  .auto-bk {
    display: flex; flex-direction: column;
    gap: 10px;
    padding: 10px 0 14px;
  }
  .auto-bk-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
  }
  .auto-bk-title {
    font-size: 13px; font-weight: 600; color: var(--text-1);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .env-lock-pill {
    font-size: 11px; font-weight: 600;
    padding: 2px 8px;
    background: var(--surface-2); color: var(--text-3);
    border: 1px solid var(--border); border-radius: 999px;
  }
  .auto-bk-fields {
    display: flex; flex-wrap: wrap;
    gap: 10px;
  }
  .auto-bk-field {
    display: flex; flex-direction: column;
    gap: 4px;
    flex: 1 1 auto; min-width: 110px;
  }
  .auto-bk-label {
    font-size: 11px; color: var(--text-3);
    font-weight: 500;
  }
  .auto-bk-field .input,
  .auto-bk-field .select {
    width: 100%;
  }
  /* TimePicker trigger is a child <button> with class tp-trigger — make
     it fill the column the same way the sibling input/select do, so the
     three fields read as a uniform row instead of one shrunk-to-content
     button next to two wide inputs. */
  .auto-bk-field :global(.tp-trigger) {
    width: 100%;
    justify-content: space-between;
    height: 36px;
  }
  .auto-bk-status {
    display: flex; flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    font-size: 12px; color: var(--text-2);
  }
  .auto-bk-status-row {
    display: flex; align-items: center; gap: 6px;
  }
  .auto-bk-status-row.subtle { color: var(--text-3); font-size: 11.5px; }
  .auto-bk-status-row.error { color: var(--danger); }

  /* Mirror Settings.svelte scoped styles so cards look identical */
  .section-body { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }
  .settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
  .setting-label { font-size: 14px; font-weight: 500; flex: 1; }
  .setting-desc  { font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .sub-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 4px 2px 2px;
  }
  .danger-zone-label { color: var(--danger) !important; opacity: 0.85; }
  .danger-zone-card { border-color: color-mix(in srgb, var(--danger) 30%, transparent); }

  .setting-action {
    width: 100%; background: none; border: none; cursor: pointer;
    color: var(--text-1); text-align: left;
    transition: background var(--dur-fast);
  }
  .setting-action:active { background: var(--surface-2); }
  .setting-action.danger:hover { background: rgba(239,68,68,0.06); }

  .restore-progress {
    padding: 0 16px 14px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .restore-progress-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-2);
  }
  .restore-progress-track {
    height: 6px; border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .restore-progress-fill {
    height: 100%; border-radius: 3px;
    background: var(--accent);
    transition: width 300ms ease;
  }

  .backup-table-header {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 6px 16px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
  }
  .backup-row {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 10px 16px;
    align-items: center;
  }
  .backup-name {
    font-size: 12px; font-weight: 500; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .backup-col-date { font-size: 13px; color: var(--text-2); }
  .backup-col-size { font-size: 13px; color: var(--text-2); }
  .backup-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
  .backup-action-btn { height: 30px; font-size: 12px; padding: 0 10px; display: flex; align-items: center; gap: 4px; }

  @media (max-width: 480px) {
    .backup-table-header { display: none; }
    .backup-row {
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
      row-gap: 6px;
    }
    .backup-name { grid-column: 1; grid-row: 1; }
    .backup-col-date { grid-column: 1; grid-row: 2; font-size: 12px; }
    .backup-col-size { display: none; }
    .backup-actions { grid-column: 2; grid-row: 1 / 3; flex-direction: column; align-items: stretch; }
    .backup-action-btn { justify-content: center; }
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1s linear infinite; display: inline-block; }
</style>
