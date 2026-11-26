<script>
  // Defaults for Everyone (nutritrace#326): the language, date and time,
  // energy unit and food search that anyone who hasn't chosen their own
  // starts with. Not the body units (server/lib/regional-options.js). Admins only (Settings > Users). Nothing is written into anyone's
  // settings: a person's own choice always wins, and a change here reaches
  // everyone who still hasn't chosen. "Each Device" leaves it to the
  // browser or phone. One set in the server's environment (DEFAULT_*)
  // shows here, locked.
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../../i18n/index.js';
  import { REGIONAL_OPTIONS } from '../../../server/lib/regional-options.js';
  import { applyInstanceDefaults } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';

  let values = {};
  let locked = [];
  let loaded = false;
  let loadFailed = false;
  let busy = false;

  const langLabel = c => AVAILABLE_LOCALES.find(l => l.code === c)?.label || c;
  const OFF_LANGUAGE_NAMES = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', ja: 'Japanese', zh: 'Chinese', ar: 'Arabic', ko: 'Korean' };
  // The same words the Regional & Units and Connected Services pickers show.
  $: ROWS = [
    { key: 'language', label: $_('settings.regional.language'), opts: REGIONAL_OPTIONS.language.values.map(v => [v, langLabel(v)]) },
    { key: 'dateFormat', label: $_('settings.regional.date_format'), opts: [['ISO', 'YYYY-MM-DD'], ['US', 'MM/DD/YYYY'], ['EU', 'DD/MM/YYYY'], ['natural', 'D MMM YYYY']] },
    { key: 'timeFormat', label: $_('settings.regional.time_format'), opts: [['12h', $_('settings.regional.time_12h')], ['24h', $_('settings.regional.time_24h')]] },
    { key: 'energyUnit', label: $_('settings.regional.energy'), opts: [['kcal', $_('settings.regional.energy_kcal')], ['kJ', $_('settings.regional.energy_kj')]] },
    { key: 'offSearchLanguage', label: $_('settings.connected_services.off.search_language'), opts: REGIONAL_OPTIONS.offSearchLanguage.values.map(v => [v, OFF_LANGUAGE_NAMES[v] || v]) },
    { key: 'offSearchCountry', label: $_('settings.connected_services.off.search_country'), opts: REGIONAL_OPTIONS.offSearchCountry.values.map(v => [v, v]) },
  ];

  function _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return h;
  }

  function _take(body) {
    values = body?.values || {};
    locked = Array.isArray(body?.locked) ? body.locked : [];
    applyInstanceDefaults(values);
  }

  onMount(async () => {
    try {
      const res = await fetch(apiUrl('/api/app-config/defaults'), { credentials: 'include', headers: _headers() });
      if (!res.ok) throw new Error(String(res.status));
      _take(await res.json());
    } catch {
      // Offline or refused: say so, rather than rows that look unset and
      // unlocked (one the environment holds would be refused on save).
      loadFailed = true;
    }
    loaded = true;
  });

  async function save(key, value) {
    const before = values;
    values = { ...values };
    if (value) values[key] = value; else delete values[key];
    busy = true;
    try {
      const res = await fetch(apiUrl('/api/app-config/defaults'), {
        method: 'PUT', credentials: 'include', headers: _headers(),
        body: JSON.stringify({ values: { [key]: value || null } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `${res.status}`);
      _take(body);
      showSuccess($_('settings_defaults.saved'));
    } catch (e) {
      values = before;
      showError($_('settings_defaults.save_failed', { values: { msg: e?.message || '' } }));
    } finally { busy = false; }
  }
</script>

<div class="setting-divider"></div>
<div class="setting-row defaults-head">
  <div>
    <span class="setting-label">{$_('settings_defaults.title')}</span>
    <div class="setting-desc">{$_('settings_defaults.desc')}</div>
  </div>
</div>
{#if loadFailed}
  <p class="setting-desc defaults-failed">{$_('settings_defaults.load_failed')}</p>
{:else if loaded}
  {#each ROWS as row}
    <div class="setting-row defaults-row">
      <div>
        <span class="setting-label">{row.label}</span>
        {#if locked.includes(row.key)}
          <div class="setting-desc">{$_('settings_defaults.locked', { values: { env: REGIONAL_OPTIONS[row.key].env } })}</div>
        {/if}
      </div>
      <div class="select-wrap">
        <select class="select sel-sm" value={values[row.key] || ''} disabled={busy || locked.includes(row.key)}
                aria-label={row.label} on:change={e => save(row.key, e.target.value)}>
          <option value="">{$_('settings_defaults.device_choice')}</option>
          {#each row.opts as [v, label]}<option value={v}>{label}</option>{/each}
        </select>
      </div>
    </div>
  {/each}
{/if}

<style>
  .defaults-head { padding-bottom: 4px; }
  .defaults-failed { padding: 0 16px 12px; }
  .defaults-row { padding-left: 28px; }
  .defaults-row .select-wrap { width: 170px; flex-shrink: 0; }
  .select:disabled { opacity: 0.6; cursor: default; }
  .sel-sm { height: 36px; font-size: 13px; }
  @media (max-width: 480px) {
    .defaults-row { padding-left: 16px; }
    .defaults-row .select-wrap { width: 160px; }
  }
</style>
