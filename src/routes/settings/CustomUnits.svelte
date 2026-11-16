<script>
  import { get } from 'svelte/store';
  import { _ } from 'svelte-i18n';
  import { customUnits } from '../../stores/settings.js';
  import { UNIT_GROUPS } from '../../lib/units.js';

  let newUnitAbbr = '';
  let newUnitFull = '';

  function addCustomUnit() {
    const abbr = newUnitAbbr.trim();
    const full = newUnitFull.trim() || abbr;
    if (!abbr) return;
    const existing = get(customUnits) || [];
    // Dedup by abbr against both existing customs and the built-in catalog.
    const builtIn = new Set(UNIT_GROUPS.flatMap(g => g.units.map(u => u.abbr.toLowerCase())));
    if (builtIn.has(abbr.toLowerCase())) return; // already in catalog
    if (existing.some(c => c.abbr.toLowerCase() === abbr.toLowerCase())) return;
    customUnits.set([...existing, { abbr, full }]);
    newUnitAbbr = '';
    newUnitFull = '';
  }
  function removeCustomUnit(unit) {
    customUnits.set((get(customUnits) || []).filter(c => c.abbr !== unit.abbr));
  }
</script>

<div class="section-body">
  <div class="card settings-card">
    <div style="padding:12px 16px 0">
      <p class="setting-desc" style="margin:0 0 10px">
        {$_('extracted.settings.add_units_that_aren_t_in_the_built_in_catalog_410')}
      </p>
      <p class="setting-desc" style="margin:0 0 12px;color:var(--warning, #d49a2b)">
        <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">info</span>
        {$_('extracted.settings.custom_units_do_not_convert_by_mass_picking_on_411')}
      </p>
    </div>
    <div class="cat-chips-wrap" style="padding:0 16px 12px">
      {#each ($customUnits || []) as u}
        <div class="chip">
          {u.full} <span style="color:var(--text-3);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-left:6px">{u.abbr}</span>
          <button class="chip-x" on:click={() => removeCustomUnit(u)} aria-label={$_('diary.water.remove')}>
            <span class="material-symbols-rounded" style="font-size:14px">close</span>
          </button>
        </div>
      {/each}
      {#if (!$customUnits || $customUnits.length === 0)}
        <span class="text-3 text-sm">{$_('settings_stats.no_custom_units')}</span>
      {/if}
    </div>
    <div class="setting-divider"></div>
    <div class="cat-add-row">
      <div style="display:flex;flex-direction:column;gap:3px;width:80px">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">{$_('extracted.settings.abbr_412')}</span>
        <input class="input" style="height:40px" placeholder={$_('extracted.settings.shot_413')}
          bind:value={newUnitAbbr} on:keydown={e => e.key==='Enter' && addCustomUnit()} />
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;flex:1">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">{$_('settings_stats.full_name')}</span>
        <input class="input" style="height:40px" placeholder={$_('extracted.settings.shot_glass_414')}
          bind:value={newUnitFull} on:keydown={e => e.key==='Enter' && addCustomUnit()} />
      </div>
      <button class="btn btn-secondary" style="height:40px;padding:0 16px;align-self:flex-end" on:click={addCustomUnit}>{$_('diary.water.add')}</button>
    </div>
  </div>
</div>
