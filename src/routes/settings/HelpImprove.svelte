<script>
  import { copyText } from '../../lib/clipboard.js';
  import { _ } from 'svelte-i18n';
  import Toggle from '../../components/settings/Toggle.svelte';
  import Sheet from '../../components/ui/Sheet.svelte';
  import {
    getLogBufferText, clearLogBuffer,
    isVerboseLogging, setVerboseLogging,
    getLogFileUri, getLastCrashFileUri, hasCrashReport, clearCrashReport,
  } from '../../lib/log-capture.js';
  import { APP_VERSION } from '../../lib/version.js';
  import { isNative } from '../../lib/platform.js';
  import { NtApi } from '../../lib/api.js';
  import { showError } from '../../stores/toast.js';

  // ── Diagnostics: in-app log capture ──────────────────────────────────────
  let _logsSheet = false;
  let _logsText = '';
  let _logsCopied = false;
  let _verboseLogging = isVerboseLogging();
  let _hasCrashReport = false;

  function _openLogsSheet() {
    _logsText = getLogBufferText() || $_('settings_diagnostics.no_logs_yet');
    _logsCopied = false;
    _hasCrashReport = hasCrashReport();
    _logsSheet = true;
  }
  async function _copyLogs() {
    try {
      await copyText(_logsText);
      _logsCopied = true;
      setTimeout(() => _logsCopied = false, 2000);
    } catch (e) {
      showError($_('settings_diagnostics.copy_failed'));
    }
  }
  async function _shareLogs() {
    try {
      if (isNative) {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title: $_('settings_diagnostics.share_logs_title'),
          text: _logsText,
          dialogTitle: $_('settings_diagnostics.share_logs_dialog'),
        });
      } else if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: $_('settings_diagnostics.share_logs_title'), text: _logsText });
      } else {
        await _copyLogs();
      }
    } catch (e) {
      // User cancelled — silent.
    }
  }
  // Share a file from Directory.Data via the Android share intent. Direct
  // file:// URIs into private app data fail silently on Android target SDK
  // 24+: the receiving app gets the intent but can't read the URI, so it
  // falls back to the share intent's text field and saves THAT as the file
  // contents (the title-only file bug from #60). Fix: copy the source file
  // into Directory.Cache first; Capacitor's auto-generated FileProvider XML
  // whitelists the cache directory and translates the file URI into a
  // content:// URI the receiving app can actually read.
  async function _shareFileViaCache({ srcPath, cacheBasename, title, text, dialogTitle }) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const src = await Filesystem.readFile({ path: srcPath, directory: Directory.Data, encoding: Encoding.UTF8 });
    const cachePath = `${cacheBasename}-${Date.now()}.txt`;
    await Filesystem.writeFile({ path: cachePath, data: src.data, directory: Directory.Cache, encoding: Encoding.UTF8 });
    const { uri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache });
    const { Share } = await import('@capacitor/share');
    await Share.share({ title, text, url: uri, dialogTitle });
  }
  // Share the persistent log file as a real file attachment (native only,
  // and only useful when verbose / diagnostic mode has been on long enough
  // to write something to disk).
  async function _shareLogFile() {
    try {
      const f = await getLogFileUri();
      if (!f) { showError($_('settings_diagnostics.no_log_file')); return; }
      await _shareFileViaCache({
        srcPath: f.path,
        cacheBasename: 'nutritrace-log',
        title: $_('settings_diagnostics.share_logs_title'),
        text: $_('settings_diagnostics.log_file_title'),
        dialogTitle: $_('settings_diagnostics.share_log_file_dialog'),
      });
    } catch (e) {
      // User cancelled or share unsupported — silent.
    }
  }
  // Share the most recent crash report file. Only visible when one exists
  // (cleared on next successful share or via the explicit Clear button).
  async function _shareCrashReport() {
    try {
      const f = await getLastCrashFileUri();
      if (!f) { _hasCrashReport = false; return; }
      await _shareFileViaCache({
        srcPath: f.path,
        cacheBasename: 'nutritrace-crash',
        title: $_('settings_diagnostics.crash_report_title'),
        text: $_('settings_diagnostics.crash_report_title'),
        dialogTitle: $_('settings_diagnostics.share_crash_dialog'),
      });
    } catch (e) {
      // User cancelled — silent.
    }
  }
  function _clearCrashReport() {
    clearCrashReport();
    _hasCrashReport = false;
  }
  function _clearLogs() {
    clearLogBuffer();
    _logsText = $_('settings_diagnostics.cleared');
  }
  function _toggleVerbose(on) {
    _verboseLogging = on;
    setVerboseLogging(on);
  }

  // ── Diagnostics: anonymized calibration export ───────────────────────────
  let _calibExportSheet = false;
  let _calibExportJson  = '';
  let _calibExportCount = 0;
  let _calibDeviceLabel = ''; // user-supplied free-text, e.g. "Pixel Watch 4"
  let _calibCopied = false;

  async function _generateCalibExport() {
    try {
      // Pull last 30 days of Fitbit/Garmin data via the existing /data endpoint.
      // Window is today-29 → today inclusive (30 days ending today). Previously
      // used today-30 → today-1, which silently dropped today even though
      // today's seeded actuals are typically what the user just paste-confirmed.
      const today = new Date();
      const from  = new Date(today); from.setDate(from.getDate() - 29);
      const fmt   = d => d.toLocaleDateString('sv-SE');
      const fromStr = fmt(from), toStr = fmt(today);

      let fitbitRows = {}, garminRows = {};
      try { fitbitRows = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`) || {}; } catch {}
      try { garminRows = await NtApi.get(`/api/wellness/garmin/data?from=${fromStr}&to=${toStr}`) || {}; } catch {}

      // Build deterministic day list, oldest → newest
      const dates = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date(from); d.setDate(from.getDate() + i);
        dates.push(fmt(d));
      }

      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const days = dates.map((d, i) => {
        const f = fitbitRows[d] || {};
        const g = garminRows[d] || {};
        const wd = new Date(d + 'T12:00:00').getDay();
        // Only include fields useful for calibration. No user_id, no exact
        // dates, no PII. Numeric biometrics + scores only.
        const row = {
          dayIndex: i + 1,
          dayOfWeek: dayNames[wd],
          // Fitbit actuals (only present if user has been seeding via /seed-scores).
          // Most useful for tuning — these are Fitbit's own published scores.
          fitbit_sleep_actual:     f.sleep_score_actual     ?? null,
          fitbit_readiness_actual: f.readiness_score_actual ?? null,
          fitbit_stress_actual:    f.stress_score_actual    ?? null,
          // Our calculated scores (server-side for sleep, client-side for readiness/stress).
          sleep_calc:       (f.sleep_score_actual ? null : f.sleep_score)         ?? null,
          readiness_calc:   (f.readiness_score_actual ? null : f.readiness_score) ?? null,
          stress_calc:      (f.stress_score_actual ? null : f.stress_score)       ?? null,
          // Garmin's device-native scores (Garmin exposes these directly — no calc needed).
          // Stress is conceptually different (continuous-measurement avg, not a morning score).
          garmin_sleep:     g.sleep_score    ?? null,
          garmin_stress:    g.stress_avg     ?? null,
          // Raw biometrics — relevant for ANY device, useful for cross-device validation
          hrv:              f.hrv_daily_rmssd ?? g.hrv_daily_rmssd ?? null,
          rhr:              f.resting_hr      ?? g.resting_hr      ?? null,
          sleep_min:        f.sleep_duration_min ?? g.sleep_duration_min ?? null,
          deep_min:         f.sleep_deep_min  ?? g.sleep_deep_min  ?? null,
          rem_min:          f.sleep_rem_min   ?? g.sleep_rem_min   ?? null,
          efficiency:       f.sleep_efficiency ?? null,
          spo2:             f.spo2_avg        ?? null,
          calories_out:     f.calories_out    ?? g.calories_out    ?? null,
        };
        // Drop the day if there's no biometric data at all
        const hasData = row.fitbit_sleep_actual != null || row.sleep_calc != null ||
                        row.garmin_sleep != null || row.hrv != null || row.rhr != null;
        return hasData ? row : null;
      }).filter(Boolean);

      const payload = {
        version: 1,
        exportedAt: new Date().toISOString().slice(0, 10),
        device: _calibDeviceLabel.trim() || '(unspecified)',
        appVersion: APP_VERSION,
        days,
      };
      _calibExportJson  = JSON.stringify(payload, null, 2);
      _calibExportCount = days.length;
      _calibCopied = false;
    } catch (e) {
      showError($_('settings_diagnostics.export_failed', { values: { reason: e.message || '' } }));
    }
  }

  async function _copyCalibExport() {
    try {
      await copyText(_calibExportJson);
      _calibCopied = true;
      setTimeout(() => _calibCopied = false, 2000);
    } catch (e) {
      showError($_('settings_diagnostics.copy_failed'));
    }
  }
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_diagnostics.diag_mode')}</span>
        <div class="setting-desc">{isNative ? $_('settings_diagnostics.mode_description_native') : $_('settings_diagnostics.mode_description_web')}</div>
      </div>
      <Toggle checked={_verboseLogging} on:change={e => _toggleVerbose(e.detail)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
      <span class="setting-label">{$_('settings_diagnostics.view_logs')}</span>
      <p class="setting-desc" style="line-height:1.5">
        {@html $_('settings_diagnostics.logs_desc_web')}{isNative ? $_('settings_diagnostics.logs_desc_android') : ''} {$_('settings_diagnostics.logs_note')}
      </p>
      <button class="btn btn-secondary" style="height:40px;font-size:13px" on:click={_openLogsSheet}>
        <span class="material-symbols-rounded" style="font-size:16px">terminal</span>
        {$_('extracted.settings.view_logs_456')}{hasCrashReport() ? $_('settings_diagnostics.crash_report_available_suffix') : ''}
      </button>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
      <span class="setting-label">{$_('settings_diagnostics.calibration_export')}</span>
      <p class="setting-desc" style="line-height:1.5">
        {$_('extracted.settings.anonymized_30_day_json_of_your_wellness_data_h_457')}
      </p>
      <div class="form-group" style="width:100%;padding:0">
        <label class="form-label" for="calib-device">{$_('extracted.settings.your_device_optional_free_text_458')}</label>
        <input id="calib-device" class="input" placeholder={$_('extracted.settings.e_g_pixel_watch_4_fitbit_charge_6_sense_2_459')}
          bind:value={_calibDeviceLabel} />
      </div>
      <button class="btn btn-primary" style="height:40px;font-size:13px" on:click={() => { _generateCalibExport(); _calibExportSheet = true; }}>
        <span class="material-symbols-rounded" style="font-size:16px">data_object</span>
        {$_('extracted.settings.generate_calibration_export_460')}
      </button>
    </div>
  </div>
</div>

<!-- Diagnostic logs viewer -->
<Sheet bind:open={_logsSheet} title={$_('extracted.settings.diagnostic_logs_461')}>
  <div style="padding:0 4px 8px">
    <p class="setting-desc" style="line-height:1.5;margin-bottom:10px">
      {$_('settings_diagnostics.log_help')}
    </p>
    <textarea readonly style="width:100%;height:280px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:var(--surface-2);color:var(--text-1);resize:vertical;white-space:pre">{_logsText}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-primary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_copyLogs}>
        {#if _logsCopied}
          <span class="material-symbols-rounded" style="font-size:16px">check</span> {$_('settings_wellness.common.copied')}
        {:else}
          <span class="material-symbols-rounded" style="font-size:16px">content_copy</span> {$_('settings.users.copy')}
        {/if}
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_shareLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">share</span> {$_('extracted.settings.share_text_464')}
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_clearLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">delete</span> {$_('bulk_import.clear')}
      </button>
    </div>
    {#if isNative && _verboseLogging}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-secondary" style="flex:1;height:40px;font-size:13px" on:click={_shareLogFile}>
          <span class="material-symbols-rounded" style="font-size:16px">description</span> {$_('extracted.settings.share_log_file_465')}
        </button>
      </div>
      <p class="setting-desc" style="margin-top:6px;font-size:11px">
        {$_('extracted.settings.today_s_persisted_log_on_disk_rotates_daily_la_466')}
      </p>
    {/if}
    {#if isNative && _hasCrashReport}
      <div style="margin-top:14px;padding:10px;background:color-mix(in srgb,var(--danger) 8%, transparent);border-left:3px solid var(--danger);border-radius:var(--radius-sm,6px)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger)">warning</span>
          <strong style="color:var(--danger);font-size:14px">{$_('settings_diagnostics.crash_available')}</strong>
        </div>
        <p class="setting-desc" style="margin:0 0 8px;font-size:12px">
          {$_('extracted.settings.the_app_captured_an_uncaught_error_share_the_r_467')}
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1;height:36px;font-size:12px" on:click={_shareCrashReport}>
            <span class="material-symbols-rounded" style="font-size:14px">share</span> {$_('extracted.settings.share_crash_report_468')}
          </button>
          <button class="btn btn-ghost" style="flex:1;height:36px;font-size:12px" on:click={_clearCrashReport}>
            {$_('coaching.targets.dismiss')}
          </button>
        </div>
      </div>
    {/if}
  </div>
</Sheet>

<!-- Calibration Export preview -->
<Sheet bind:open={_calibExportSheet} title={$_('extracted.settings.calibration_export_review_469')}>
  <div style="padding:0 4px 8px">
    <p class="setting-desc" style="line-height:1.5;margin-bottom:10px">
      {$_('settings_diagnostics.export_days_review', { values: { count: _calibExportCount } })}
    </p>
    <textarea readonly style="width:100%;height:240px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:var(--surface-2);color:var(--text-1);resize:vertical">{_calibExportJson}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn btn-primary" style="flex:1;height:40px;font-size:13px" on:click={_copyCalibExport}>
        {#if _calibCopied}
          <span class="material-symbols-rounded" style="font-size:16px">check</span> {$_('settings_wellness.common.copied')}
        {:else}
          <span class="material-symbols-rounded" style="font-size:16px">content_copy</span> {$_('extracted.settings.copy_json_472')}
        {/if}
      </button>
    </div>
  </div>
</Sheet>
