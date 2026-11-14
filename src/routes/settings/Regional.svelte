<script>
  import { _, locale } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../../i18n/index.js';
  import {
    language, dateFormat, timeFormat, energyUnit, firstDayOfWeek,
    weightUnit, heightUnit, lengthUnit, distUnit, tempUnit,
  } from '../../stores/settings.js';
  import { localeFirstDay } from '../../lib/week.js';

  // What Automatic comes to here, named in the app's language (#232).
  // 2023-01-01 was a Sunday.
  $: autoDayName = _dayName(localeFirstDay(), $language);
  function _dayName(day, lang) {
    const d = new Date(Date.UTC(2023, 0, 1 + day));
    try { return d.toLocaleDateString(String(lang || 'en').replace(/_/g, '-'), { weekday: 'long', timeZone: 'UTC' }); }
    catch { return d.toLocaleDateString('en', { weekday: 'long', timeZone: 'UTC' }); }
  }

  $: ENERGY_OPTS = $locale ? [
    { value: 'kcal', label: $_('settings.regional.energy_kcal') },
    { value: 'kJ',   label: $_('settings.regional.energy_kj') },
  ] : [
    { value: 'kcal', label: 'Calories (kcal)' },
    { value: 'kJ',   label: 'Kilojoules (kJ)' },
  ];
</script>

<div class="section-body">

  <!-- Group: Language & Formats -->
  <p class="settings-group-heading">{$_('settings.regional.formats_heading')}</p>
  <p class="settings-group-sub">{$_('settings.regional.formats_sub')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.language')}</span>
      <div class="select-wrap" style="width:150px">
        <select class="select sel-sm" bind:value={$language}>
          {#each AVAILABLE_LOCALES as l}<option value={l.code}>{l.label}</option>{/each}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.date_format')}</span>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$dateFormat} on:change={e => dateFormat.set(e.target.value)}>
          <option value="ISO">YYYY-MM-DD</option>
          <option value="US">MM/DD/YYYY</option>
          <option value="EU">DD/MM/YYYY</option>
          <option value="natural">D MMM YYYY</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.time_format')}</span>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$timeFormat} on:change={e => timeFormat.set(e.target.value)}>
          <option value="12h">{$_('settings.regional.time_12h')}</option>
          <option value="24h">{$_('settings.regional.time_24h')}</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings.regional.first_day')}</span>
        <div class="setting-desc">{$_('settings.regional.first_day_desc', { values: { day: autoDayName } })}</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$firstDayOfWeek} on:change={e => firstDayOfWeek.set(e.target.value)}>
          <option value="auto">{$_('settings.regional.first_day_auto')}</option>
          <option value="monday">{$_('settings.regional.first_day_monday')}</option>
          <option value="sunday">{$_('settings.regional.first_day_sunday')}</option>
          <option value="saturday">{$_('settings.regional.first_day_saturday')}</option>
        </select>
      </div>
    </div>
  </div>

  <!-- Group: Units — metric / imperial preferences across the app -->
  <p class="settings-group-heading">{$_('settings.regional.units_heading')}</p>
  <p class="settings-group-sub">{$_('settings.regional.units_sub')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.energy')}</span>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$energyUnit} on:change={e => energyUnit.set(e.target.value)}>
          {#each ENERGY_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.weight')}</span>
      <div class="select-wrap" style="width:100px">
        <select class="select sel-sm" value={$weightUnit} on:change={e => weightUnit.set(e.target.value)}>
          <option value="kg">kg</option>
          <option value="lb">lbs</option>
          <option value="st">st</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.height')}</span>
      <div class="select-wrap" style="width:100px">
        <select class="select sel-sm" value={$heightUnit} on:change={e => heightUnit.set(e.target.value)}>
          <option value="cm">cm</option>
          <option value="ft">ft / in</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.circumference')}</span>
      <div class="select-wrap" style="width:100px">
        <select class="select sel-sm" value={$lengthUnit} on:change={e => lengthUnit.set(e.target.value)}>
          <option value="in">in</option>
          <option value="cm">cm</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.distance')}</span>
      <div class="select-wrap" style="width:100px">
        <select class="select sel-sm" value={$distUnit} on:change={e => distUnit.set(e.target.value)}>
          <option value="km">km</option>
          <option value="mi">mi</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.temperature')}</span>
      <div class="select-wrap" style="width:100px">
        <select class="select sel-sm" value={$tempUnit} on:change={e => tempUnit.set(e.target.value)}>
          <option value="F">°F</option>
          <option value="C">°C</option>
        </select>
      </div>
    </div>
  </div>

</div>
