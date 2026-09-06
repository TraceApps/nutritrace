<script>
  import { onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Toggle from '../../components/settings/Toggle.svelte';
  import ConnectionStatus from '../../components/settings/ConnectionStatus.svelte';
  import { DB } from '../../lib/db.js';
  import { NtApi } from '../../lib/api.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { envLocks, scheduleSave } from '../../stores/settings.js';
  import { currentUser } from '../../stores/auth.js';

  function set(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

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

  // ── OFF ────────────────────────────────────────────────────────────────
  let offUsername   = DB.getSetting('offUsername',   '');
  let offPassword   = DB.getSetting('offPassword',   '');
  let offShowPass   = false;
  let offEnabled    = DB.getSetting('offEnabled',    true);

  const OFF_LANGUAGE_OPTS = [
    ['en','English'],['fr','French'],['de','German'],['es','Spanish'],['it','Italian'],
    ['pt','Portuguese'],['nl','Dutch'],['pl','Polish'],['ru','Russian'],['ja','Japanese'],
    ['zh','Chinese'],['ar','Arabic'],['ko','Korean']
  ];
  // Alphabetized (World stays first as the "no filter" default). Kept
  // aligned with the OFF regions where user demand actually shows up:
  // Anglosphere, Western Europe + Nordics, Central/Eastern Europe,
  // LATAM, APAC, and SA. Adding new entries: keep alphabetical order
  // and confirm the country has a corresponding en:<slug> tag on
  // openfoodfacts.org before shipping.
  const OFF_COUNTRY_OPTS = ['World',
    'Argentina','Australia','Austria','Belgium','Brazil','Canada','Chile','China',
    'Denmark','Finland','France','Germany','India','Ireland','Italy','Japan',
    'Mexico','Netherlands','New Zealand','Norway','Poland','Portugal','Singapore',
    'South Africa','South Korea','Spain','Sweden','Switzerland','United Kingdom',
    'United States'];
  let offSearchLanguage = DB.getSetting('offSearchLanguage', 'en');
  let offSearchCountry  = DB.getSetting('offSearchCountry',  'World');
  let offUploadCountry  = DB.getSetting('offUploadCountry',  'Auto');
  let offImportPortion  = DB.getSetting('offImportPortion',  'per100g');

  $: set('offEnabled',        offEnabled);
  $: set('offSearchLanguage', offSearchLanguage);
  $: set('offSearchCountry',  offSearchCountry);
  $: set('offUploadCountry',  offUploadCountry);
  $: set('offImportPortion',  offImportPortion);

  let offSaved    = false;
  function saveOff() {
    set('offUsername', offUsername);
    set('offPassword', offPassword);
    offSaved = true;
    setTimeout(() => offSaved = false, 2000);
  }

  // ── USDA ───────────────────────────────────────────────────────────────
  let usdaApiKey  = DB.getSetting('usdaApiKey', '');
  let usdaEnabled = DB.getSetting('usdaEnabled', false);
  let usdaSaved   = false;
  let usdaTestStatus = ''; // '', 'testing', 'ok', 'fail'
  $: set('usdaEnabled', usdaEnabled);
  $: usdaBannerStatus = (usdaTestStatus === 'testing' || usdaTestStatus === 'fail')
    ? usdaTestStatus
    : (usdaApiKey ? 'ok' : '');

  async function testUsdaConnection() {
    if (!usdaApiKey) { usdaTestStatus = 'fail'; showError('USDA test failed: API key required'); return; }
    usdaTestStatus = 'testing';
    try {
      // Direct call — USDA's FoodData Central API has open CORS, so the
      // browser can hit it without a server proxy. A 1-result probe query
      // is enough to verify the key.
      const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(usdaApiKey)}&query=apple&pageSize=1`;
      const res = await fetch(url);
      if (res.ok) {
        usdaTestStatus = 'ok';
        showSuccess('USDA API key verified');
      } else {
        usdaTestStatus = 'fail';
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error?.message) detail = j.error.message; } catch {}
        showError(`USDA test failed: ${detail}`);
      }
    } catch (e) {
      usdaTestStatus = 'fail';
      showError(`USDA test failed: ${e?.message || 'network error'}`);
    }
  }
  function saveUsda() {
    set('usdaApiKey', usdaApiKey);
    usdaSaved = true;
    setTimeout(() => usdaSaved = false, 2000);
    if (usdaApiKey && usdaTestStatus !== 'testing') testUsdaConnection();
  }

  // ── Mealie ─────────────────────────────────────────────────────────────
  let mealieEnabled    = DB.getSetting('mealieEnabled',   false);
  let mealieBaseUrl    = DB.getSetting('mealieBaseUrl',   '');
  let mealieApiToken   = DB.getSetting('mealieApiToken',  '');
  let mealieShowToken  = false;
  let mealieTestStatus = ''; // '', 'testing', 'ok', 'fail'
  let mealieSaved      = false;
  // Banner status: show "ok" as soon as both fields are populated so users
  // see the connection card immediately. Real test result overrides on
  // testing/fail. Same shape AI Assistant uses for its banner.
  $: mealieBannerStatus = (mealieTestStatus === 'testing' || mealieTestStatus === 'fail')
    ? mealieTestStatus
    : (mealieBaseUrl && mealieApiToken ? 'ok' : '');

  async function testMealieConnection() {
    if (!mealieBaseUrl || !mealieApiToken) {
      mealieTestStatus = 'fail';
      showError('Mealie test failed: URL and token both required');
      return;
    }
    mealieTestStatus = 'testing';
    try {
      // POST goes through the server's CSRF middleware; raw fetch needs the
      // X-CSRF-Token header (PWA cookie auth) or Authorization bearer (native
      // server mode). Issue #24: this was missing and every Test click 403'd.
      const headers = { 'Content-Type': 'application/json' };
      if (isNative && getServerUrl()) {
        const token = getAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } else if (!isNative) {
        const csrf = localStorage.getItem('nt:csrf');
        if (csrf) headers['X-CSRF-Token'] = csrf;
      }
      const res = await fetch(apiUrl('/api/mealie/proxy'), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          baseUrl: mealieBaseUrl,
          token:   mealieApiToken,
          path:    '/api/recipes?perPage=1&page=1',
        }),
      });
      if (res.ok) {
        mealieTestStatus = 'ok';
        showSuccess('Mealie connection verified');
      } else {
        mealieTestStatus = 'fail';
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) detail = j.error; } catch {}
        showError(`Mealie test failed: ${detail}`);
      }
    } catch (e) {
      mealieTestStatus = 'fail';
      showError(`Mealie test failed: ${e?.message || 'network error'}`);
    }
  }
  function saveMealie() {
    set('mealieBaseUrl', mealieBaseUrl);
    set('mealieApiToken', mealieApiToken);
    mealieSaved = true;
    setTimeout(() => mealieSaved = false, 2000);
    if (mealieBaseUrl && mealieApiToken && mealieTestStatus !== 'testing') {
      testMealieConnection();
    }
  }

  // CookTrace: same shape as Mealie above, but the token is a CT PAT
  // (ct_pat_...) with the read:recipes scope. The Test button hits
  // /api/cooktrace/proxy → /api/v1/me on the user's CT instance and
  // reports the signed-in CT username on success, or a specific
  // failure reason (missing scope, bad token, unreachable URL).
  let cooktraceEnabled    = DB.getSetting('cooktraceEnabled',   false);
  let cooktraceBaseUrl    = DB.getSetting('cooktraceBaseUrl',   '');
  let cooktraceApiToken   = DB.getSetting('cooktraceApiToken',  '');
  let cooktraceShowToken  = false;
  let cooktraceTestStatus = '';
  let cooktraceSaved      = false;
  $: cooktraceBannerStatus = (cooktraceTestStatus === 'testing' || cooktraceTestStatus === 'fail')
    ? cooktraceTestStatus
    : (cooktraceBaseUrl && cooktraceApiToken ? 'ok' : '');

  async function testCooktraceConnection() {
    if (!cooktraceBaseUrl || !cooktraceApiToken) {
      cooktraceTestStatus = 'fail';
      showError('CookTrace test failed: URL and token both required');
      return;
    }
    cooktraceTestStatus = 'testing';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (isNative && getServerUrl()) {
        const token = getAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } else if (!isNative) {
        const csrf = localStorage.getItem('nt:csrf');
        if (csrf) headers['X-CSRF-Token'] = csrf;
      }
      const res = await fetch(apiUrl('/api/cooktrace/proxy'), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          baseUrl: cooktraceBaseUrl,
          token:   cooktraceApiToken,
          path:    '/api/v1/me',
        }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
        if (!scopes.includes('read:recipes')) {
          cooktraceTestStatus = 'fail';
          showError('CookTrace token is valid but lacks the read:recipes scope. Mint a new token on CookTrace with that scope ticked.');
          return;
        }
        cooktraceTestStatus = 'ok';
        showSuccess(body?.user?.username ? `Connected as ${body.user.username}` : 'CookTrace connection verified');
      } else {
        cooktraceTestStatus = 'fail';
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) detail = j.error; } catch {}
        showError(`CookTrace test failed: ${detail}`);
      }
    } catch (e) {
      cooktraceTestStatus = 'fail';
      showError(`CookTrace test failed: ${e?.message || 'network error'}`);
    }
  }
  function saveCooktrace() {
    set('cooktraceBaseUrl', cooktraceBaseUrl);
    set('cooktraceApiToken', cooktraceApiToken);
    cooktraceSaved = true;
    setTimeout(() => cooktraceSaved = false, 2000);
    if (cooktraceBaseUrl && cooktraceApiToken && cooktraceTestStatus !== 'testing') {
      testCooktraceConnection();
    }
  }

  // ── OFF Local mirror status ────────────────────────────────────────────
  let offMirrorStatus = null;
  let offMirrorPoll = null;
  let offRefreshSaving = false;
  function _fmtGB(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  function _fmtAge(mtimeMs) {
    if (!mtimeMs) return '';
    const days = (Date.now() - mtimeMs) / (24 * 60 * 60 * 1000);
    if (days < 1) {
      const h = Math.max(1, Math.round(days * 24));
      return h === 1 ? 'Updated 1 hour ago' : `Updated ${h} hours ago`;
    }
    const d = Math.round(days);
    return d === 1 ? 'Updated 1 day ago' : `Updated ${d} days ago`;
  }
  async function _loadOffMirrorStatus() {
    try {
      offMirrorStatus = await NtApi.get('/api/off-local/status');
    } catch { /* leave previous value so the banner doesn't flicker on a transient blip */ }
  }
  let _offPollCadence = 30000;
  function _scheduleNextOffPoll() {
    if (offMirrorPoll) { clearTimeout(offMirrorPoll); offMirrorPoll = null; }
    if (!$envLocks?.off_local) return;
    offMirrorPoll = setTimeout(async () => {
      await _loadOffMirrorStatus();
      _offPollCadence = offMirrorStatus?.refresh?.state === 'downloading' ? 2000 : 30000;
      _scheduleNextOffPoll();
    }, _offPollCadence);
  }
  function _startOffMirrorPolling() {
    if (offMirrorPoll || !$envLocks?.off_local) return;
    _loadOffMirrorStatus().then(() => {
      _offPollCadence = offMirrorStatus?.refresh?.state === 'downloading' ? 2000 : 30000;
      _scheduleNextOffPoll();
    });
  }
  function _stopOffMirrorPolling() {
    if (offMirrorPoll) { clearTimeout(offMirrorPoll); offMirrorPoll = null; }
  }
  async function _triggerOffRefresh() {
    try {
      await NtApi.post('/api/off-local/refresh', {});
      await _loadOffMirrorStatus();
      _offPollCadence = 2000;
      _scheduleNextOffPoll();
    } catch (e) {
      showError(e.message || 'Refresh failed');
    }
  }
  async function _setOffRefreshInterval(value) {
    offRefreshSaving = true;
    try {
      await NtApi.put('/api/off-local/schedule', { interval: value });
      await _loadOffMirrorStatus();
    } catch (e) {
      showError(e.message || 'Could not update auto-refresh');
    } finally {
      offRefreshSaving = false;
    }
  }
  // Drill-in mount replaces `openSections.connectedServices` — start polling
  // as soon as the local mirror is env-locked. Reactive so it also fires when
  // envLocks resolves after mount (fetched from /api/app-config/env-locks).
  $: if ($envLocks?.off_local) _startOffMirrorPolling();
  onDestroy(() => { _stopOffMirrorPolling(); });

  // Banner derivation — kept here so the markup stays declarative.
  $: _offRefresh = offMirrorStatus?.refresh || null;
  $: _offDownloading = _offRefresh?.state === 'downloading';
  $: _offFailed     = _offRefresh?.state === 'failed';
  $: _offIntervalMs = ({ off: null, daily: 86_400_000, weekly: 604_800_000, monthly: 2_592_000_000 })[offMirrorStatus?.refresh_interval || 'weekly'];
  $: _offStale = !_offDownloading && !_offFailed
                  && offMirrorStatus?.mtime_ms != null
                  && _offIntervalMs != null
                  && (Date.now() - offMirrorStatus.mtime_ms) > _offIntervalMs;
  $: _offReady = offMirrorStatus?.size_bytes != null;
  $: _offBannerStatus = _offDownloading ? 'testing'
                      : (_offFailed && !_offReady) ? 'fail'
                      : _offFailed ? 'warn'
                      : _offStale ? 'warn'
                      : _offReady ? 'ok'
                      : 'testing';
  $: _offBannerOkLabel = 'Local Mirror';
  $: _offBadgePolicy = $envLocks?.off_local_only ? 'Air-Gap' : '';
  $: _offBadgeState = (_offFailed && _offReady) ? 'Refresh Failed'
                     : _offStale ? 'Stale'
                     : '';
  $: _offBannerBadge = [_offBadgePolicy, _offBadgeState].filter(Boolean).join(' · ');
  $: _offBannerSubtext = _offDownloading
        ? (offMirrorStatus?.size_bytes
            ? `Downloading update… ${Math.round((_offRefresh?.progress || 0) * 100)}% (${_fmtGB(_offRefresh?.bytes_done)} / ${_offRefresh?.bytes_total ? _fmtGB(_offRefresh.bytes_total) : '?'})`
            : `First download… ${Math.round((_offRefresh?.progress || 0) * 100)}% (${_fmtGB(_offRefresh?.bytes_done)} / ${_offRefresh?.bytes_total ? _fmtGB(_offRefresh.bytes_total) : '?'})`)
      : _offFailed
        ? `Last refresh failed: ${_offRefresh?.last_error || 'unknown error'}${offMirrorStatus?.size_bytes ? `; currently serving ${_fmtGB(offMirrorStatus.size_bytes)} from before` : ''}`
      : _offStale
        ? `${_fmtGB(offMirrorStatus?.size_bytes)} · ${_fmtAge(offMirrorStatus?.mtime_ms)}`
      : _offReady
        ? `${_fmtGB(offMirrorStatus?.size_bytes)} · ${_fmtAge(offMirrorStatus?.mtime_ms)}${$envLocks?.off_local_only ? ' · remote OFF API disabled' : ''}`
        : 'Lookups fall back to public OFF API until ready';
  $: _offRefreshBtnLabel = _offFailed ? 'Retry' : 'Refresh Now';
  $: _offRefreshTestingLabel = (!_offReady && _offDownloading) ? 'Downloading' : 'Syncing';
</script>

<div class="section-body">

  <p class="sub-label">{$_('settings.connected_services.off.header')}</p>
  <div class="card settings-card">
    {#if $envLocks.off_local}
      <ConnectionStatus
        status={_offBannerStatus}
        okLabel={_offBannerOkLabel}
        connectedAs={_offBannerBadge}
        subtext={_offBannerSubtext}
        testingLabel={_offRefreshTestingLabel}
        error={_offFailed ? '' : ''}
        onRetest={$currentUser?.role === 'admin' ? _triggerOffRefresh : null}
        retestDisabled={_offDownloading}
        retestLabel={_offRefreshBtnLabel}
      />
      <!-- ODbL disclosure for operators running the local OFF mirror.
           Only rendered when OFF_LOCAL_DB is env-locked on the server
           (envLocks.off_local === true), and only to admin users so
           non-admin household members don't see it. Share-alike
           obligations flow to the operator serving other users, not
           to NutriTrace itself. See LICENSES.md in the repo root. -->
      {#if $currentUser?.role === 'admin'}
        <div style="padding:12px 16px;display:flex;gap:10px;align-items:flex-start;background:color-mix(in srgb,#3b82f6 6%,transparent);border-left:3px solid #3b82f6">
          <span class="material-symbols-rounded" style="font-size:18px;color:#3b82f6;flex-shrink:0;margin-top:2px">info</span>
          <div class="setting-desc" style="margin:0;line-height:1.5">
            Local Open Food Facts mirror is active. OFF data is
            licensed under the
            <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener" class="about-link">Open Database License (ODbL)</a>.
            If you serve other users from this instance, share-alike
            obligations apply to your operation. See
            <a href="https://github.com/TraceApps/nutritrace/blob/main/LICENSES.md" target="_blank" rel="noopener" class="about-link">LICENSES.md</a>
            for details.
          </div>
        </div>
        <div class="setting-divider"></div>
      {/if}
      {#if $currentUser?.role === 'admin'}
        <div class="setting-row">
          <div>
            <span class="setting-label">{$_('settings.connected_services.off.auto_refresh')}</span>
            <div class="setting-desc">
              {$_('settings.connected_services.off.auto_refresh_desc')}
            </div>
          </div>
          <div class="select-wrap" style="width:130px">
            <select class="select sel-sm"
                    value={offMirrorStatus?.refresh_interval || 'weekly'}
                    disabled={offRefreshSaving}
                    on:change={e => _setOffRefreshInterval(e.currentTarget.value)}>
              <option value="off">{$_('settings.connected_services.off.auto_refresh_off')}</option>
              <option value="daily">{$_('settings.connected_services.off.auto_refresh_daily')}</option>
              <option value="weekly">{$_('settings.connected_services.off.auto_refresh_weekly')}</option>
              <option value="monthly">{$_('settings.connected_services.off.auto_refresh_monthly')}</option>
            </select>
          </div>
        </div>
        <div class="setting-divider"></div>
      {/if}
    {/if}
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings.connected_services.off.enable')}</span>
        <div class="setting-desc">
          {$_('settings.connected_services.off.enable_desc')}
        </div>
      </div>
      <Toggle checked={offEnabled} on:change={e => { offEnabled = e.detail; set('offEnabled', e.detail); }} />
    </div>
    {#if offEnabled}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings.connected_services.off.search_language')}</span>
        <div class="select-wrap" style="width:120px">
          <select class="select sel-sm" bind:value={offSearchLanguage}>
            {#each OFF_LANGUAGE_OPTS as [v,l]}<option value={v}>{l}</option>{/each}
          </select>
        </div>
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings.connected_services.off.search_country')}</span>
        <div class="select-wrap" style="width:150px">
          <select class="select sel-sm" bind:value={offSearchCountry}>
            {#each OFF_COUNTRY_OPTS as c}<option value={c}>{c}</option>{/each}
          </select>
        </div>
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings.connected_services.off.upload_country')}</span>
        <div class="select-wrap" style="width:150px">
          <select class="select sel-sm" bind:value={offUploadCountry}>
            <option value="Auto">{$_('settings.connected_services.off.upload_country_auto')}</option>
            {#each OFF_COUNTRY_OPTS.filter(c => c !== 'World') as c}<option value={c}>{c}</option>{/each}
          </select>
        </div>
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings.connected_services.off.import_portion')}</span>
          <div class="setting-desc">
            {$_('settings.connected_services.off.import_portion_desc')}
          </div>
        </div>
        <div class="select-wrap" style="width:150px">
          <select class="select sel-sm" bind:value={offImportPortion}>
            <option value="per100g">{$_('settings.connected_services.off.import_portion_100g')}</option>
            <option value="perServing">{$_('settings.connected_services.off.import_portion_serving')}</option>
          </select>
        </div>
      </div>
      <div class="setting-divider"></div>
      <div class="form-group" style="padding:10px 16px 14px">
        <label class="form-label" for="off-user">{$_('settings.connected_services.off.account_username')}</label>
        <div class="setting-desc" style="margin:0 0 8px 0;line-height:1.4">
          {$_('settings.connected_services.off.account_note')}
          <a href="https://world.openfoodfacts.org/cgi/user.pl" target="_blank" rel="noopener" class="about-link">{$_('settings.connected_services.off.account_create_link')}</a>
        </div>
        <input id="off-user" class="input" style="margin-bottom:8px" placeholder={$_('settings.connected_services.off.username_placeholder')} bind:value={offUsername} />
        <label class="form-label" for="off-pass">{$_('settings.connected_services.off.account_password')}</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          {#if offShowPass}
            <input id="off-pass" class="input" type="text" style="flex:1" placeholder={$_('settings.connected_services.off.password_placeholder')} bind:value={offPassword} />
          {:else}
            <input id="off-pass" class="input" type="password" style="flex:1" placeholder={$_('settings.connected_services.off.password_placeholder')} bind:value={offPassword} />
          {/if}
          <button class="btn-icon" on:click={() => offShowPass = !offShowPass} title={offShowPass ? 'Hide' : 'Show'}>
            <span class="material-symbols-rounded">{offShowPass ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
        <button class="btn btn-primary" style="height:36px;font-size:13px;align-self:flex-start" on:click={saveOff}>
          {#if offSaved}<span class="material-symbols-rounded" style="font-size:16px">check</span> Saved{:else}Save{/if}
        </button>
      </div>
    {/if}
  </div>

  <p class="sub-label">USDA FoodData Central</p>
  <div class="card settings-card">
    {#if usdaEnabled}
      <ConnectionStatus
        status={usdaBannerStatus}
        error={usdaTestStatus === 'fail' ? 'Check API key' : ''}
        onRetest={() => testUsdaConnection()}
        retestDisabled={usdaTestStatus === 'testing' || !usdaApiKey}
      />
    {/if}
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_integrations.enable_usda')}</span>
        <div class="setting-desc">
          Search the USDA nutrition database when adding foods.
          <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener" class="about-link">Get a free API key →</a>
        </div>
      </div>
      <Toggle checked={usdaEnabled} on:change={e => { usdaEnabled = e.detail; set('usdaEnabled', e.detail); }} />
    </div>
    {#if usdaEnabled}
      <div class="setting-divider"></div>
      <div class="form-group" style="padding:10px 16px 14px">
        <label class="form-label" for="usda-key">API Key</label>
        <input id="usda-key" class="input" type="text"
          placeholder={$_('wizard_deep.usda_key_ph')}
          bind:value={usdaApiKey}
          on:blur={saveUsda}
          autocomplete="off" style="width:100%" />
      </div>
    {/if}
  </div>

  <p class="sub-label">{$_('settings_integrations.mealie_section')}</p>
  <div class="card settings-card">
    {#if mealieEnabled}
      <ConnectionStatus
        status={mealieBannerStatus}
        error={mealieTestStatus === 'fail' ? 'Check URL and token' : ''}
        onRetest={() => testMealieConnection()}
        retestDisabled={mealieTestStatus === 'testing' || !mealieBaseUrl || !mealieApiToken}
      />
    {/if}
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_integrations.enable_mealie')}</span>
        <div class="setting-desc">Import recipes from your self-hosted Mealie instance</div>
      </div>
      <Toggle checked={mealieEnabled} on:change={e => { mealieEnabled = e.detail; set('mealieEnabled', e.detail); }} />
    </div>
    {#if mealieEnabled}
      <div class="setting-divider"></div>
      <div class="form-group" style="padding:10px 16px">
        <label class="form-label" for="mealie-base-url">{$_('settings_integrations.base_url')}</label>
        <input id="mealie-base-url" class="input" type="url"
          placeholder="https://mealie.example.com"
          bind:value={mealieBaseUrl}
          on:blur={saveMealie}
          style="width:100%" />
      </div>
      <div class="setting-divider"></div>
      <div class="form-group" style="padding:10px 16px">
        <label class="form-label" for="mealie-api-token">API Token</label>
        <div style="display:flex;gap:8px;align-items:center">
          {#if mealieShowToken}
            <input id="mealie-api-token" class="input" type="text"
              placeholder={$_('settings_main_deep.bearer_ph')}
              bind:value={mealieApiToken}
              on:blur={saveMealie}
              autocomplete="off" style="flex:1" />
          {:else}
            <input id="mealie-api-token" class="input" type="password"
              placeholder={$_('settings_main_deep.bearer_ph')}
              bind:value={mealieApiToken}
              on:blur={saveMealie}
              autocomplete="off" style="flex:1" />
          {/if}
          <button class="btn-icon" on:click={() => mealieShowToken = !mealieShowToken}
            title={mealieShowToken ? 'Hide' : 'Show'}>
            <span class="material-symbols-rounded">{mealieShowToken ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>
    {/if}
  </div>

  <p class="sub-label">{$_('settings_integrations.cooktrace_section')}</p>
  <div class="card settings-card">
    {#if cooktraceEnabled}
      <ConnectionStatus
        status={cooktraceBannerStatus}
        error={cooktraceTestStatus === 'fail' ? 'Check URL, token, and read:recipes scope' : ''}
        onRetest={() => testCooktraceConnection()}
        retestDisabled={cooktraceTestStatus === 'testing' || !cooktraceBaseUrl || !cooktraceApiToken}
      />
    {/if}
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_integrations.enable_cooktrace')}</span>
        <div class="setting-desc">{$_('settings_integrations.cooktrace_desc')}</div>
      </div>
      <Toggle checked={cooktraceEnabled} on:change={e => { cooktraceEnabled = e.detail; set('cooktraceEnabled', e.detail); }} />
    </div>
    {#if cooktraceEnabled}
      <div class="setting-divider"></div>
      <div class="form-group" style="padding:10px 16px">
        <label class="form-label" for="cooktrace-base-url">{$_('settings_integrations.base_url')}</label>
        <input id="cooktrace-base-url" class="input" type="url"
          placeholder="https://cooktrace.example.com"
          bind:value={cooktraceBaseUrl}
          on:blur={saveCooktrace}
          style="width:100%" />
      </div>
      <div class="setting-divider"></div>
      <div class="form-group" style="padding:10px 16px">
        <label class="form-label" for="cooktrace-api-token">API Token</label>
        <div style="display:flex;gap:8px;align-items:center">
          {#if cooktraceShowToken}
            <input id="cooktrace-api-token" class="input" type="text"
              placeholder="ct_pat_..."
              bind:value={cooktraceApiToken}
              on:blur={saveCooktrace}
              autocomplete="off" style="flex:1" />
          {:else}
            <input id="cooktrace-api-token" class="input" type="password"
              placeholder="ct_pat_..."
              bind:value={cooktraceApiToken}
              on:blur={saveCooktrace}
              autocomplete="off" style="flex:1" />
          {/if}
          <button class="btn-icon" on:click={() => cooktraceShowToken = !cooktraceShowToken}
            title={cooktraceShowToken ? 'Hide' : 'Show'}>
            <span class="material-symbols-rounded">{cooktraceShowToken ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
        <p class="setting-desc" style="margin-top:6px">
          Mint on CookTrace: Settings, API Tokens, New Token, tick <code>read:recipes</code>. Copy the token immediately: it is shown once.
        </p>
      </div>
    {/if}
  </div>
</div>
