<script>
  import { _ } from 'svelte-i18n';
  import { DB } from '../../lib/db.js';
  import { AVAILABLE_LOCALES } from '../../i18n/index.js';
  import { scheduleSave } from '../../stores/settings.js';
  import {
    language, dateFormat, timeFormat, energyUnit,
  } from '../../stores/settings.js';

  const ENERGY_OPTS = [
    { value: 'kcal', label: 'Calories (kcal)' },
    { value: 'kJ',   label: 'Kilojoules (kJ)'  },
  ];

  // Save-on-change helper — matches parent's `set()` helper.
  function set(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  let weightUnit  = DB.getSetting('weightUnit',  'lb');
  let heightUnit  = DB.getSetting('heightUnit',  'ft');
  let lengthUnit  = DB.getSetting('lengthUnit',  'in');
  let distUnitVal = DB.getSetting('distUnit',    'km');
  let tempUnitVal = DB.getSetting('tempUnit',    'F');

  $: set('weightUnit',  weightUnit);
  $: set('heightUnit',  heightUnit);
  $: set('lengthUnit',  lengthUnit);
  $: set('distUnit',    distUnitVal);
  $: set('tempUnit',    tempUnitVal);
</script>

<div class="section-body">

  <!-- Group: Language & Formats -->
  <p class="settings-group-heading">Language &amp; Formats</p>
  <p class="settings-group-sub">Interface language and how dates and times are shown.</p>
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
  </div>

  <!-- Group: Units — metric / imperial preferences across the app -->
  <p class="settings-group-heading">Units</p>
  <p class="settings-group-sub">Unit choices apply everywhere the value shows.</p>
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
        <select class="select sel-sm" bind:value={weightUnit}>
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
        <select class="select sel-sm" bind:value={heightUnit}>
          <option value="cm">cm</option>
          <option value="ft">ft / in</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.circumference')}</span>
      <div class="select-wrap" style="width:100px">
        <select class="select sel-sm" bind:value={lengthUnit}>
          <option value="in">in</option>
          <option value="cm">cm</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.distance')}</span>
      <div class="select-wrap" style="width:100px">
        <select class="select sel-sm" bind:value={distUnitVal}>
          <option value="km">km</option>
          <option value="mi">mi</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings.regional.temperature')}</span>
      <div class="select-wrap" style="width:100px">
        <select class="select sel-sm" bind:value={tempUnitVal}>
          <option value="F">°F</option>
          <option value="C">°C</option>
        </select>
      </div>
    </div>
  </div>

</div>
