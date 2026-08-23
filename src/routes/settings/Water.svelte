<script>
  import { _ } from 'svelte-i18n';
  import Toggle from '../../components/settings/Toggle.svelte';
  import { showError } from '../../stores/toast.js';
  import { decimalInput, parseDecimal } from '../../lib/decimal-input.js';
  import {
    waterUnit, waterShowInDiary, waterShowInStats, waterContainers,
  } from '../../stores/settings.js';

  function _mlToDisplay(ml, unit) {
    if (unit === 'oz') return +(ml / 29.5735).toFixed(1);
    if (unit === 'L')  return +(ml / 1000).toFixed(2);
    if (unit === 'G')  return +(ml / 3785.41).toFixed(3);
    return ml;
  }
  function _displayToMl(val, unit) {
    const n = Number(val);
    if (unit === 'oz') return Math.round(n * 29.5735);
    if (unit === 'L')  return Math.round(n * 1000);
    if (unit === 'G')  return Math.round(n * 3785.41);
    return Math.round(n);
  }

  let _newContName   = '';
  let _newContVolume = '';
  let _newContUnit   = 'ml';
  function addContainer() {
    const name = _newContName.trim();
    const vol  = parseDecimal(_newContVolume);
    if (!name || !vol || vol <= 0) { showError('Enter a valid name and volume'); return; }
    waterContainers.set([...$waterContainers, { id: Date.now().toString(), name, volumeMl: _displayToMl(vol, _newContUnit) }]);
    _newContName = ''; _newContVolume = '';
  }
  function removeContainer(id) { waterContainers.set($waterContainers.filter(c => c.id !== id)); }
</script>

<div class="section-body">

  <!-- Group: Display -->
  <p class="settings-group-heading">Display</p>
  <p class="settings-group-sub">Unit shown for water values and where the water card appears.</p>
  <div class="card settings-card">
    <div class="setting-row">
      <span class="setting-label">{$_('settings_water.display_unit')}</span>
      <div class="select-wrap" style="width:180px">
        <select class="select sel-sm" value={$waterUnit} on:change={e => waterUnit.set(e.target.value)}>
          <option value="ml">Milliliters (ml)</option>
          <option value="oz">Fluid ounces (fl oz)</option>
          <option value="L">Liters (L)</option>
          <option value="G">Gallons (G)</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_water.show_in_diary')}</span>
      <Toggle checked={$waterShowInDiary} on:change={e => waterShowInDiary.set(e.detail)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_water.show_in_statistics')}</span>
      <Toggle checked={$waterShowInStats} on:change={e => waterShowInStats.set(e.detail)} />
    </div>
  </div>

  <!-- Group: Containers -->
  <p class="settings-group-heading">{$_('settings_water.containers_title')}</p>
  <p class="settings-group-sub">Quick-add buttons shown in the Diary for logging water intake.</p>
  <div class="card settings-card">
    {#each $waterContainers as container, i}
      {#if i > 0}<div class="setting-divider"></div>{/if}
      <div class="setting-row">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <span class="material-symbols-rounded" style="color:var(--accent);font-size:20px;flex-shrink:0">water_drop</span>
          <div style="min-width:0">
            <div class="setting-label">{container.name}</div>
            <div class="setting-desc">{_mlToDisplay(container.volumeMl, $waterUnit)} {$waterUnit}</div>
          </div>
        </div>
        <button class="btn-icon" on:click={() => removeContainer(container.id)} title="Remove">
          <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3)">delete</span>
        </button>
      </div>
    {/each}
    {#if $waterContainers.length === 0}
      <p class="text-3 text-sm" style="padding:16px;text-align:center">{$_('settings_water.no_containers')}</p>
    {/if}
    <div class="setting-divider"></div>
    <div style="padding:12px 16px 14px">
      <p class="setting-label" style="margin-bottom:10px">{$_('settings_water.add_container')}</p>
      <input class="input" type="text" placeholder={$_('settings_main_deep.container_name_ph')}
        bind:value={_newContName} style="margin-bottom:8px" />
      <div style="display:flex;gap:8px;align-items:center">
        <input class="input" type="text" inputmode="decimal" use:decimalInput placeholder={$_('settings_main_deep.volume_ph')}
          bind:value={_newContVolume} style="flex:1" />
        <select class="select sel-sm" bind:value={_newContUnit} style="width:86px">
          <option value="ml">ml</option>
          <option value="oz">fl oz</option>
          <option value="L">L</option>
          <option value="G">G</option>
        </select>
        <button class="btn btn-primary" style="height:42px;white-space:nowrap" on:click={addContainer}>Add</button>
      </div>
    </div>
  </div>
</div>
