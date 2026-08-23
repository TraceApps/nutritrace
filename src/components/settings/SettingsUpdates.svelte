<script>
  /**
   * SettingsUpdates — in-app update UX. Layout modeled on Fathom's
   * lib/screens/updates_screen.dart so the mental model transfers.
   *
   * Platforms:
   *   Android APK  : channel picks which GH release to check + download
   *                  (Stable = /releases/latest, Beta = /releases/tags/dev-latest).
   *   PWA          : channel picks which GH release the server-update
   *                  banner compares against (self-hosters on `:dev`
   *                  Docker tag want Beta so they see when a newer
   *                  dev-latest is out; users on `:latest` want Stable).
   *                  Client-bundle updates come via the service worker
   *                  independent of this panel.
   *
   * Title casing per feedback_title_case: labels/buttons/headings use
   * Chicago title case. Body prose stays sentence case.
   */
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Toggle from './Toggle.svelte';
  import { APP_VERSION } from '../../lib/version.js';
  import { isNative } from '../../lib/platform.js';
  import { currentUser } from '../../stores/auth.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import {
    checkForUpdate, isUpdateAvailable, downloadAndInstallApk,
    getChannel, setChannel, getAutoCheck, setAutoCheck,
    getLastChecked, formatAgo, checkServerUpdate,
    skipVersion, getUpdateCacheInfo, clearUpdateCache, formatBytes,
  } from '../../lib/updates.js';
  import { updateCheckInterval } from '../../stores/settings.js';

  // Options for the "how often to check" picker. Values match what
  // _throttleMs() in updates.js reads directly from the setting (hours,
  // 0 = manual only). Keep in sync with the same choices in LT/CT.
  const CHECK_INTERVAL_OPTIONS = [
    { value: 1,  key: 'updates.interval.hourly'    },
    { value: 4,  key: 'updates.interval.every_4h'  },
    { value: 12, key: 'updates.interval.every_12h' },
    { value: 24, key: 'updates.interval.daily'     },
    { value: 0,  key: 'updates.interval.manual'    },
  ];

  let channel     = _normalizeChannel(getChannel());
  let cacheInfo   = null;         // { files, totalBytes } — populated onMount on native only
  let clearing    = false;
  // Channel values are internally 'stable' | 'dev'. Older stored
  // values might be 'beta' (from the pre-rename UI); normalize on
  // load so the radio + backend queries stay consistent.
  let autoCheck   = getAutoCheck();
  let checking    = false;
  let latest      = null;
  let serverInfo  = null;
  let lastChecked = getLastChecked();
  let error       = '';
  let downloading = false;
  let downloadPct = 0;
  let installFailed = '';

  $: isAdmin        = $currentUser?.role === 'admin';
  $: available      = latest && isUpdateAvailable(latest);
  $: showApkPanel   = isNative;
  $: showServerPanel= !isNative && isAdmin;

  function _normalizeChannel(v) {
    if (v === 'beta') { setChannel('dev'); return 'dev'; }
    return v === 'dev' ? 'dev' : 'stable';
  }

  onMount(async () => {
    if (autoCheck) {
      await Promise.all([
        isNative ? doCheck(false) : Promise.resolve(),
        !isNative && isAdmin ? doServerCheck() : Promise.resolve(),
      ]);
    }
    if (isNative) await refreshCacheInfo();
  });

  async function refreshCacheInfo() {
    cacheInfo = await getUpdateCacheInfo();
  }

  async function doClearCache() {
    clearing = true;
    try {
      await clearUpdateCache();
      await refreshCacheInfo();
      showSuccess($_('updates.storage.cleared'));
    } catch (e) {
      showError(e?.message || String(e));
    } finally {
      clearing = false;
    }
  }

  async function doCheck(force = true) {
    checking = true;
    error = '';
    try {
      if (isNative) {
        latest = await checkForUpdate({ force });
        lastChecked = getLastChecked();
        if (!latest) error = $_('updates.check_failed');
      } else if (isAdmin) {
        await doServerCheck({ force });
        lastChecked = new Date();
      }
    } finally {
      checking = false;
    }
  }

  async function doServerCheck({ force = false } = {}) {
    try {
      serverInfo = await checkServerUpdate({ force });
    } catch { serverInfo = null; }
  }

  function onChannelChange(next) {
    channel = next;
    setChannel(next);
    latest = null;
    serverInfo = null;
    doCheck(true);
  }

  function onAutoCheckToggle(e) {
    autoCheck = e.detail;
    setAutoCheck(autoCheck);
  }

  async function doInstall() {
    if (!latest?.apkAsset) return;
    downloading = true;
    downloadPct = 0;
    installFailed = '';
    try {
      await downloadAndInstallApk(latest, pct => { downloadPct = pct; });
      showSuccess($_('updates.install_starting'));
      await refreshCacheInfo();
      // System installer is now up — clear the shade notification so the
      // user isn't left with a stale "update available" once they've
      // acted on it.
      try {
        const { cancelUpdateNotification } = await import('../../lib/notifications.js');
        await cancelUpdateNotification();
      } catch { /* silent */ }
    } catch (e) {
      installFailed = e?.message || String(e);
      showError($_('updates.install_failed'));
    } finally {
      downloading = false;
    }
  }

  function doSkip() {
    if (!latest?.version) return;
    skipVersion(latest.version);
    latest = null;
  }

  /** Primary-button state machine. One button drives the panel: check → detect
   *  → download → install. The label + click handler + colour change with
   *  state so the panel never shows two competing "do the thing" controls. */
  $: primaryState = downloading      ? 'downloading'
                  : checking         ? 'checking'
                  : (showApkPanel && available) ? 'install'
                                         : 'check';

  /** Minimal markdown → HTML for GitHub release notes. Not a full renderer;
   *  covers what our own release notes actually use: **bold**, `code`,
   *  [text](url), - bullets, ### headings, blank-line paragraphs, and line
   *  breaks. Escapes raw text FIRST so user-provided release bodies can't
   *  inject arbitrary HTML. Deliberately no external markdown lib (~5KB
   *  saving; scope is small enough to hand-roll safely). */
  function _renderNotes(md) {
    if (!md) return '';
    const esc = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const lines = esc.split('\n');
    const out = [];
    let inList = false;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.startsWith('- ') || line.startsWith('* ')) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + _renderInline(line.slice(2)) + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        if (!line.trim()) { out.push('<br />'); }
        else if (line.startsWith('### '))      out.push('<h4>' + _renderInline(line.slice(4)) + '</h4>');
        else if (line.startsWith('## '))       out.push('<h3>' + _renderInline(line.slice(3)) + '</h3>');
        else if (line.startsWith('# '))        out.push('<h3>' + _renderInline(line.slice(2)) + '</h3>');
        else                                    out.push('<p>' + _renderInline(line) + '</p>');
      }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }
  function _renderInline(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g,       '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  async function copyDockerCommand() {
    const cmd = 'docker-compose pull && docker-compose up -d';
    try {
      await navigator.clipboard.writeText(cmd);
      showSuccess($_('updates.server.copied'));
    } catch {
      showError($_('updates.server.copy_failed'));
    }
  }
</script>

<!-- ── Update settings card ────────────────────────────────────────── -->
<div class="card settings-card">
  <div class="body">
    <div class="row">
      <div class="row-label">
        <span class="material-symbols-rounded row-icon" aria-hidden="true">info</span>
        <div class="label-main">{$_('updates.current_version')}</div>
      </div>
      <div class="row-value version-chip">{APP_VERSION}</div>
    </div>

    <div class="divider"></div>
    <div class="channel-block">
      <div class="channel-header">
        <div class="label-main">{$_('updates.channel.label')}</div>
        <div class="label-desc">{$_('updates.channel.help')}</div>
      </div>
      <div class="channel-picker">
        <label class="channel-opt" class:selected={channel === 'stable'}>
          <input type="radio" name="update-channel" value="stable"
                 checked={channel === 'stable'} on:change={() => onChannelChange('stable')} />
          <span class="material-symbols-rounded" style="font-size:16px">verified</span>
          {$_('updates.channel.stable')}
        </label>
        <label class="channel-opt" class:selected={channel === 'dev'}>
          <input type="radio" name="update-channel" value="dev"
                 checked={channel === 'dev'} on:change={() => onChannelChange('dev')} />
          <span class="material-symbols-rounded" style="font-size:16px">science</span>
          {$_('updates.channel.dev')}
        </label>
      </div>
    </div>

    <div class="divider"></div>
    <div class="row">
      <div class="row-label label-stack">
        <div class="label-main">{$_('updates.auto_check')}</div>
        <div class="label-desc">{$_('updates.auto_check_desc')}</div>
      </div>
      <div class="row-value">
        <Toggle checked={autoCheck} on:change={onAutoCheckToggle} />
      </div>
    </div>

    {#if autoCheck}
      <div class="divider"></div>
      <div class="row">
        <div class="row-label label-stack">
          <div class="label-main">{$_('updates.interval.label')}</div>
          <div class="label-desc">{$_('updates.interval.desc')}</div>
        </div>
        <div class="row-value">
          <select
            class="select sel-sm"
            value={$updateCheckInterval}
            on:change={(e) => updateCheckInterval.set(Number(e.target.value))}
          >
            {#each CHECK_INTERVAL_OPTIONS as opt}
              <option value={opt.value}>{$_(opt.key)}</option>
            {/each}
          </select>
        </div>
      </div>
    {/if}

    <!-- Server status — PWA admin only. Inlined into the same card so
         there's a single "Updates" surface instead of two competing cards.
         Row mirrors the Current Version row: label + version chip on the
         right, plus a tiny status dot to make behind-vs-current scannable
         at a glance. Instructions collapse into a details block only when
         the server is actually behind. -->
    {#if showServerPanel && serverInfo}
      <div class="divider"></div>
      <div class="row">
        <div class="row-label label-stack">
          <div class="label-main">{$_('updates.server.heading')}</div>
          <div class="label-desc">
            {#if serverInfo.available}
              <span class="status-dot dot-warn"></span>
              {$_('updates.server.behind_desc', { values: { latest: serverInfo.latest } })}
            {:else}
              <span class="status-dot dot-ok"></span>
              {$_('updates.server.current_desc')}
            {/if}
          </div>
        </div>
        <div class="row-value version-chip" class:chip-warn={serverInfo.available}>{serverInfo.current}</div>
      </div>
    {/if}

    <!-- Single primary action. Label + colour swap with state
         (check-now / checking / download-and-install / downloading %)
         so the panel never shows two competing controls. -->
    <button
      class="btn-primary-action"
      class:is-install={primaryState === 'install'}
      class:is-busy={primaryState === 'checking' || primaryState === 'downloading'}
      disabled={primaryState === 'checking' || primaryState === 'downloading' || (primaryState === 'install' && !latest?.apkAsset)}
      on:click={() => primaryState === 'install' ? doInstall() : doCheck(true)}
    >
      {#if primaryState === 'downloading'}
        <div class="btn-progress-fill" style="width:{downloadPct}%"></div>
        <span class="btn-label">
          <span class="material-symbols-rounded spin">progress_activity</span>
          {$_('updates.downloading', { values: { percent: downloadPct } })}
        </span>
      {:else if primaryState === 'checking'}
        <span class="btn-label">
          <span class="material-symbols-rounded spin">progress_activity</span>
          {$_('updates.checking')}
        </span>
      {:else if primaryState === 'install'}
        <span class="btn-label">
          <span class="material-symbols-rounded">download</span>
          {$_('updates.download_install')}
        </span>
      {:else}
        <span class="btn-label">
          <span class="material-symbols-rounded">refresh</span>
          {$_('updates.check_now')}
        </span>
      {/if}
    </button>

    {#if primaryState === 'install'}
      <button class="btn-skip" on:click={doSkip}>
        {$_('updates.skip_this_version')}
      </button>
    {:else if primaryState === 'check'}
      <div class="last-checked">
        {$_('updates.last_checked')}:
        <strong>{lastChecked ? formatAgo(lastChecked) : $_('updates.last_checked_never')}</strong>
      </div>
    {/if}

    {#if error}
      <div class="alert alert-error">
        <span class="material-symbols-rounded" style="font-size:18px">error</span>
        {error}
      </div>
    {/if}
    {#if installFailed}
      <div class="alert alert-error">
        <span class="material-symbols-rounded" style="font-size:18px">error</span>
        {installFailed}
      </div>
    {/if}
  </div>

  <!-- "What's new" — only shown when an update is available on native.
       Collapsed by default; user taps to expand. Version + release age
       live in the summary so users see what they'd be installing before
       committing to reading the full notes. -->
  {#if showApkPanel && available}
    <details class="whats-new">
      <summary>
        <span class="material-symbols-rounded whats-new-chev">chevron_right</span>
        <span class="whats-new-title">
          {$_('updates.available_headline', { values: { version: latest.version } })}
        </span>
        {#if latest.publishedAt}
          <span class="whats-new-when">{formatAgo(latest.publishedAt)}</span>
        {/if}
      </summary>
      <div class="whats-new-body">
        {#if latest.notes}
          <div class="whats-new-md">{@html _renderNotes(latest.notes)}</div>
        {:else}
          <p class="note">{$_('updates.no_release_notes')}</p>
        {/if}
        {#if latest.notesUrl}
          <a class="update-link" href={latest.notesUrl} target="_blank" rel="noopener">
            {$_('updates.view_on_github')}
            <span class="material-symbols-rounded" style="font-size:14px">open_in_new</span>
          </a>
        {/if}
      </div>
    </details>
  {/if}

  <!-- Storage: what's cached under Directory.Data/updates/ (Android only) -->
  {#if showApkPanel && cacheInfo}
    <div class="divider" style="margin: 0 16px"></div>
    <div class="storage-block">
      <div class="storage-header">
        <div class="storage-title">
          <span class="material-symbols-rounded" style="font-size:18px">sd_storage</span>
          {$_('updates.storage.heading')}
        </div>
        <div class="storage-total">{formatBytes(cacheInfo.totalBytes)}</div>
      </div>

      {#if cacheInfo.files.length === 0}
        <div class="storage-empty">{$_('updates.storage.empty')}</div>
      {:else}
        <ul class="storage-list">
          {#each cacheInfo.files as f (f.name)}
            <li class="storage-item">
              <span class="storage-name" title={f.name}>{f.name}</span>
              <span class="storage-size">{formatBytes(f.size)}</span>
            </li>
          {/each}
        </ul>
        <button class="btn btn-secondary" on:click={doClearCache} disabled={clearing}>
          <span class="material-symbols-rounded" style="font-size:16px">delete_sweep</span>
          {clearing ? $_('updates.storage.clearing') : $_('updates.storage.clear_now')}
        </button>
      {/if}
    </div>
  {/if}
</div>

<!-- Server "how to update" expanders: only appear when a server update
     is actually available. Same card as the rest (attached via CSS —
     no visual break), so the panel stays a single surface even when
     it needs to show the docker-compose flow. -->
{#if showServerPanel && serverInfo?.available}
  <div class="card settings-card server-instructions-card">
    <div class="body server-instructions">
      <div class="server-headline">
        <span class="material-symbols-rounded" aria-hidden="true">system_update_alt</span>
        <div class="server-headline-text">
          <div class="label-main">
            {$_('updates.server.headline', { values: { latest: serverInfo.latest } })}
          </div>
          {#if serverInfo.published_at}
            <div class="label-desc">
              {$_('updates.released', { values: { when: formatAgo(serverInfo.published_at) } })}
            </div>
          {/if}
        </div>
      </div>

      {#if serverInfo.notes}
        <details class="whats-new" open>
          <summary>
            <span class="material-symbols-rounded whats-new-chev">chevron_right</span>
            <span class="whats-new-title">{$_('updates.release_notes_heading')}</span>
          </summary>
          <div class="whats-new-body">
            <div class="whats-new-md">{@html _renderNotes(serverInfo.notes)}</div>
            {#if serverInfo.notes_url}
              <a class="update-link" href={serverInfo.notes_url} target="_blank" rel="noopener">
                {$_('updates.view_on_github')}
                <span class="material-symbols-rounded" style="font-size:14px">open_in_new</span>
              </a>
            {/if}
          </div>
        </details>
      {/if}

      <div class="label-desc">{$_('updates.server.instructions')}</div>
      <pre class="server-cmd">docker-compose pull && docker-compose up -d</pre>
      <button class="btn btn-secondary" style="align-self:flex-start" on:click={copyDockerCommand}>
        <span class="material-symbols-rounded" style="font-size:16px">content_copy</span>
        {$_('updates.server.copy_command')}
      </button>
      <div class="channel-note">
        <span class="material-symbols-rounded" style="font-size:14px">info</span>
        {$_('updates.server.channel_note')}
      </div>
    </div>
  </div>
{/if}

<style>
  .body { padding: 16px; display: flex; flex-direction: column; gap: 4px; }

  .row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 10px 0;
  }
  .row-label {
    flex: 1; min-width: 0;
    display: flex; align-items: center; gap: 10px;
  }
  /* When the row has a label + description pair (no icon on the left),
     stack them vertically so the label always fits on one line and the
     description sits underneath it. Used by rows like Auto-Check. */
  .row-label.label-stack {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .row-icon { color: var(--accent); font-size: 20px; flex-shrink: 0; }
  .label-main { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .label-desc { font-size: 12px; color: var(--text-2); line-height: 1.35; }
  .row-value { flex-shrink: 0; }
  .divider {
    height: 1px; background: var(--border, rgba(255,255,255,0.08));
    margin: 4px 0;
  }

  .version-chip {
    font-size: 13px; font-weight: 600;
    padding: 4px 10px; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .version-chip.chip-warn {
    background: color-mix(in srgb, var(--warning, #f57c00) 15%, transparent);
    color: var(--warning, #f57c00);
  }
  /* Small status dot used in the server row's description line to
     make current-vs-behind scannable without color-blind users needing
     to parse the version numbers. */
  .status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }
  .status-dot.dot-ok   { background: var(--success, #2e7d32); }
  .status-dot.dot-warn { background: var(--warning, #f57c00); }

  .channel-block {
    display: flex; flex-direction: column; gap: 10px;
    padding: 10px 0;
  }
  .channel-header {
    display: flex; flex-direction: column; gap: 2px;
  }
  .channel-picker {
    display: flex; gap: 8px;
    background: var(--surface-2); border-radius: 10px;
    padding: 4px;
  }
  .channel-opt {
    flex: 1;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 10px 12px; border-radius: 8px; cursor: pointer;
    color: var(--text-2);
    font-size: 13px; font-weight: 600;
    transition: all 120ms ease;
    user-select: none;
  }
  .channel-opt input { display: none; }
  .channel-opt.selected {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent);
  }
  .channel-opt:hover:not(.selected) { color: var(--text-1); }

  /* Single primary action button — same visual slot across every state
     (check / checking / install / downloading). Accent-coloured by
     default so it reads as the panel's primary action; install state
     gets a stronger fill; progress bar grows across the background
     during download so the UI never shifts layout. */
  .btn-primary-action {
    position: relative;
    width: 100%;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 14px 16px; margin-top: 12px;
    border-radius: 10px; border: none; cursor: pointer;
    background: var(--accent); color: white;
    font-size: 14px; font-weight: 600;
    overflow: hidden;
    transition: background 160ms ease, opacity 120ms ease, transform 120ms ease;
  }
  .btn-primary-action.is-busy {
    background: var(--surface-2); color: var(--text-1);
  }
  .btn-primary-action.is-install {
    background: var(--accent); color: white;
  }
  .btn-primary-action:not(:disabled):hover { opacity: 0.92; }
  .btn-primary-action:not(:disabled):active { transform: scale(0.98); }
  .btn-primary-action:disabled { cursor: not-allowed; opacity: 0.88; }
  .btn-primary-action.is-busy { cursor: progress; opacity: 1; }
  .btn-primary-action .btn-label {
    position: relative; z-index: 1;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .btn-primary-action .material-symbols-rounded { font-size: 18px; }
  .btn-progress-fill {
    position: absolute; inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--accent) 60%, transparent);
    transition: width 200ms linear;
    z-index: 0;
  }

  /* Skip link. Small centered text button, sits under the install
     action when an update is available. Discoverable but low-emphasis
     so it doesn't compete with the primary action. */
  .btn-skip {
    display: block;
    margin: 8px auto 0;
    padding: 6px 12px;
    border: none; background: transparent; cursor: pointer;
    font-size: 12px; color: var(--text-2);
    text-decoration: underline; text-underline-offset: 3px;
  }
  .btn-skip:hover { color: var(--text-1); }

  .last-checked {
    text-align: center;
    font-size: 12px; color: var(--text-2);
    margin-top: 8px;
  }
  .last-checked strong { color: var(--text-1); font-weight: 600; }

  /* Collapsible release-notes panel. Chevron rotates when open; body
     is markdown-rendered inline. */
  .whats-new {
    margin: 0 16px 16px;
    border-radius: 10px;
    background: var(--surface-2);
    border: 1px solid var(--border, rgba(255,255,255,0.06));
    overflow: hidden;
  }
  .whats-new summary {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px;
    cursor: pointer;
    list-style: none;
    font-size: 13px; font-weight: 600; color: var(--text-1);
  }
  .whats-new summary::-webkit-details-marker { display: none; }
  .whats-new-chev {
    font-size: 20px; color: var(--text-2);
    transition: transform 160ms ease;
  }
  .whats-new[open] .whats-new-chev { transform: rotate(90deg); }
  .whats-new-title { flex: 1; min-width: 0; }
  .whats-new-when {
    font-size: 11px; font-weight: 500; color: var(--text-2);
  }
  .whats-new-body {
    padding: 4px 16px 16px;
    display: flex; flex-direction: column; gap: 10px;
    border-top: 1px solid var(--border, rgba(255,255,255,0.06));
    max-height: 320px; overflow: auto;
  }
  .whats-new-md {
    font-size: 13px; color: var(--text-1); line-height: 1.5;
  }
  .whats-new-md h3 { font-size: 14px; margin: 12px 0 4px; }
  .whats-new-md h4 { font-size: 13px; margin: 10px 0 4px; color: var(--text-2); }
  .whats-new-md p { margin: 0 0 6px; }
  .whats-new-md ul { margin: 4px 0 8px; padding-left: 20px; }
  .whats-new-md li { margin: 2px 0; }
  .whats-new-md code {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    padding: 1px 5px; border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .whats-new-md a { color: var(--accent); }
  .whats-new-md strong { font-weight: 700; }

  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px;
  }

  .alert {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; border-radius: 8px;
    margin: 8px 0 0;
    font-size: 13px;
  }
  .alert-error {
    background: color-mix(in srgb, var(--danger, #d32f2f) 10%, transparent);
    color: var(--danger, #d32f2f);
  }

  .update-avail-card {
    margin: 0 16px 16px;
    padding: 16px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    display: flex; flex-direction: column; gap: 12px;
  }
  .update-avail-head {
    display: flex; align-items: flex-start; gap: 10px;
    color: var(--accent);
  }
  .update-avail-headings { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .update-avail-title { font-size: 15px; font-weight: 700; }
  .update-avail-sub { font-size: 12px; color: var(--text-2); font-weight: 500; }

  .update-notes summary {
    cursor: pointer; font-size: 13px; color: var(--accent); font-weight: 600;
    padding: 6px 0;
  }
  .update-notes pre {
    white-space: pre-wrap; word-wrap: break-word;
    font-size: 12px; padding: 12px; margin-top: 6px;
    background: var(--surface-1); border-radius: 8px;
    max-height: 260px; overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-1);
  }

  .update-link {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--accent); font-size: 13px; text-decoration: none; font-weight: 500;
  }
  .update-link:hover { text-decoration: underline; }

  .update-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .note { font-size: 13px; color: var(--text-2); font-style: italic; }

  .dl-progress { display: flex; flex-direction: column; gap: 6px; }
  .dl-bar {
    height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden;
  }
  .dl-fill {
    height: 100%; background: var(--accent);
    transition: width 200ms linear;
  }
  .dl-pct { font-size: 12px; color: var(--text-2); font-weight: 500; }

  .storage-block {
    padding: 14px 16px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .storage-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
  }
  .storage-title {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 13px; font-weight: 600; color: var(--text-1);
  }
  .storage-total {
    font-size: 13px; font-weight: 600; color: var(--text-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .storage-empty {
    font-size: 12px; color: var(--text-2); font-style: italic;
  }
  .storage-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 4px;
    background: var(--surface-2);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .storage-item {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px;
    font-size: 12px;
  }
  .storage-name {
    flex: 1; min-width: 0;
    color: var(--text-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .storage-size {
    flex-shrink: 0;
    color: var(--text-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .uptodate-tag {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px;
    margin: 0 16px 16px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--success, #2e7d32) 10%, transparent);
    color: var(--success, #2e7d32);
    font-size: 13px; font-weight: 600;
    width: fit-content;
  }

  /* Server instructions card — a lightweight continuation of the main
     Updates card, only shown when the server actually needs updating.
     Nudged flush against the card above via negative margin + tinted
     border so it reads as "the actionable follow-up" rather than a
     second island. */
  .server-instructions-card {
    margin-top: -8px;
    border: 1px solid color-mix(in srgb, var(--warning, #f57c00) 25%, transparent);
    background: color-mix(in srgb, var(--warning, #f57c00) 6%, var(--surface-1));
  }
  .server-instructions { display: flex; flex-direction: column; gap: 12px; }
  .server-headline {
    display: flex; align-items: flex-start; gap: 12px;
    color: var(--warning, #f57c00);
  }
  .server-headline .material-symbols-rounded { font-size: 22px; margin-top: 2px; }
  .server-headline-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .server-headline-text .label-main { color: var(--text-1); }
  .server-when { font-size: 12px; color: var(--text-2); font-weight: 500; }
  .server-cmd {
    background: var(--surface-2); padding: 12px 14px; border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    white-space: pre-wrap; word-break: break-all; margin: 0;
    color: var(--text-1);
    border: 1px solid var(--border, rgba(255,255,255,0.06));
  }
  .channel-note {
    display: flex; align-items: flex-start; gap: 6px;
    font-size: 12px; font-style: italic; color: var(--text-2);
    line-height: 1.4;
  }

  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .badge-warn {
    background: color-mix(in srgb, var(--warning, #f57c00) 15%, transparent);
    color: var(--warning, #f57c00);
  }
  .badge-ok {
    background: color-mix(in srgb, var(--success, #2e7d32) 15%, transparent);
    color: var(--success, #2e7d32);
  }

  .spin { animation: spin 1s linear infinite; }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  /* No narrow-screen wrap. Version chips and toggles are small enough
     to stay right-aligned even at 320px width; wrapping punts controls
     onto their own line under their own label/description, which reads
     as broken layout. */
</style>
