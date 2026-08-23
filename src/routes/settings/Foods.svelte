<script>
  import { _ } from 'svelte-i18n';
  import Toggle from '../../components/settings/Toggle.svelte';
  import { isNative } from '../../lib/platform.js';
  import {
    foodsShowCategories, foodsShowLabels, foodsShowNotes, foodsShowThumbnails,
    foodsShowYesterdayMeals, foodsSort, mealsSort, recipesSort,
    foodsDefaultSource, offEnabled, usdaEnabled,
    barcodeBeep, barcodeFlashlight, cropPhotos,
  } from '../../stores/settings.js';
  import { DB } from '../../lib/db.js';
  // Mealie is a plain localStorage flag (not a store), unlike OFF/USDA.
  const _mealieEnabled = DB.getSetting('mealieEnabled', false);
</script>

<div class="section-body">

  <!-- Group: Food Row Display — what shows on each row in the Foods / Meals list -->
  <p class="settings-group-heading">Food Row Display</p>
  <p class="settings-group-sub">Fields shown on each row in the Foods, Meals, and Recipes tabs.</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div><span class="setting-label">{$_('settings_foods_picker.show_thumbnails')}</span><div class="setting-desc">{$_('settings_foods_picker.show_thumbnails_desc')}</div></div>
      <Toggle checked={$foodsShowThumbnails} on:change={e => foodsShowThumbnails.set(e.detail)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div><span class="setting-label">{$_('settings_foods_picker.show_categories')}</span><div class="setting-desc">{$_('settings_foods_picker.show_categories_desc')}</div></div>
      <Toggle checked={$foodsShowCategories} on:change={e => foodsShowCategories.set(e.detail)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div><span class="setting-label">{$_('settings_foods_picker.show_category_labels')}</span><div class="setting-desc">{$_('settings_foods_picker.show_category_labels_desc')}</div></div>
      <Toggle checked={$foodsShowLabels} on:change={e => foodsShowLabels.set(e.detail)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div><span class="setting-label">{$_('settings_foods_picker.show_notes')}</span><div class="setting-desc">{$_('settings_foods_picker.show_notes_desc')}</div></div>
      <Toggle checked={$foodsShowNotes} on:change={e => foodsShowNotes.set(e.detail)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div><span class="setting-label">Show Yesterday's Meals</span><div class="setting-desc">Pin yesterday's meals as quick-add cards in the Meals tab. Tap the info icon to see what's in each one.</div></div>
      <Toggle checked={$foodsShowYesterdayMeals} on:change={e => foodsShowYesterdayMeals.set(e.detail)} />
    </div>
  </div>

  <!-- Group: Sort & Source — default search source + per-tab sort order -->
  <p class="settings-group-heading">Sort &amp; Source</p>
  <p class="settings-group-sub">Default source when searching, and ordering on each list.</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_foods_picker.default_source')}</span>
        <div class="setting-desc">{$_('settings_foods_picker.default_source_desc')}</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$foodsDefaultSource} on:change={e => foodsDefaultSource.set(e.target.value)}>
          <option value="all">{$_('foods.sources.all')}</option>
          <option value="local">{$_('foods.sources.local')}</option>
          {#if $offEnabled}<option value="off">OFF</option>{/if}
          {#if $usdaEnabled}<option value="usda">USDA</option>{/if}
          {#if _mealieEnabled}<option value="mealie">Mealie</option>{/if}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_foods_picker.foods_sort')}</span>
        <div class="setting-desc">How items are ordered in the Foods tab. Favorites are always pinned at the top regardless of sort.</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$foodsSort} on:change={e => foodsSort.set(e.target.value)}>
          <option value="recent">{$_('settings_foods_picker.opt_recent')}</option>
          <option value="most">{$_('settings_foods_picker.opt_most')}</option>
          <option value="alpha">{$_('settings_foods_picker.opt_alpha')}</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_foods_picker.meals_sort')}</span>
        <div class="setting-desc">How items are ordered in the Meals tab.</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$mealsSort} on:change={e => mealsSort.set(e.target.value)}>
          <option value="recent">{$_('settings_foods_picker.opt_recent')}</option>
          <option value="most">{$_('settings_foods_picker.opt_most')}</option>
          <option value="alpha">{$_('settings_foods_picker.opt_alpha')}</option>
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_scanner.recipes_sort')}</span>
        <div class="setting-desc">How items are ordered in the Recipes tab.</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$recipesSort} on:change={e => recipesSort.set(e.target.value)}>
          <option value="recent">{$_('settings_foods_picker.opt_recent')}</option>
          <option value="most">{$_('settings_foods_picker.opt_most')}</option>
          <option value="alpha">{$_('settings_foods_picker.opt_alpha')}</option>
        </select>
      </div>
    </div>
  </div>

  <!-- Group: Camera & Scanning — barcode scanner UX -->
  <p class="settings-group-heading">Camera &amp; Scanning</p>
  <p class="settings-group-sub">Barcode scanner audio, flashlight, and photo crop preferences.</p>
  <div class="card settings-card">
    <div class="setting-row"><span class="setting-label">{$_('settings_scanner.beep_on_scan')}</span><Toggle checked={$barcodeBeep} on:change={e => barcodeBeep.set(e.detail)} /></div>
    {#if isNative}
      <div class="setting-divider"></div>
      <div class="setting-row"><span class="setting-label">{$_('settings_scanner.use_flashlight')}</span><Toggle checked={$barcodeFlashlight} on:change={e => barcodeFlashlight.set(e.detail)} /></div>
    {/if}
    <div class="setting-divider"></div>
    <div class="setting-row"><span class="setting-label">{$_('settings_scanner.crop_photos')}</span><Toggle checked={$cropPhotos} on:change={e => cropPhotos.set(e.detail)} /></div>
  </div>

</div>
