<script>
  import { _ } from 'svelte-i18n';
  import {
    calorieGoalMode, calorieGoalFactor,
    fitbitFamilyEnabled, garminEnabled,
  } from '../../stores/settings.js';

  // Mirror the parent-shell derivation: any wearable that reports calorie burn
  // unlocks Dynamic mode. Uses the shared derived fitbitFamilyEnabled so adding
  // a new source (e.g. future Polar/Suunto) doesn't silently leave the button
  // disabled for users of that source.
  $: _hasWearable = $fitbitFamilyEnabled || $garminEnabled;
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
      <div>
        <span class="setting-label">{$_('settings_goals.calorie_goal_mode')}</span>
        <div class="setting-desc">{$_('settings_goals.calorie_goal_mode_desc')}</div>
      </div>
      <div class="seg-control" style="width:100%;--seg-count:3;--seg-active:{$calorieGoalMode === 'fixed' ? 0 : $calorieGoalMode === 'dynamic' ? 1 : 2}">
        <button class="seg-opt" class:seg-active={$calorieGoalMode === 'fixed'}
          on:click={() => calorieGoalMode.set('fixed')}>{$_('settings_goals.mode_fixed')}</button>
        <button class="seg-opt" class:seg-active={$calorieGoalMode === 'dynamic'}
          disabled={!_hasWearable}
          title={!_hasWearable ? 'Connect a wearable in Wellness first' : ''}
          on:click={() => _hasWearable && calorieGoalMode.set('dynamic')}>{$_('settings_goals.mode_dynamic')}</button>
        <button class="seg-opt" class:seg-active={$calorieGoalMode === 'adaptive'}
          on:click={() => calorieGoalMode.set('adaptive')}>{$_('settings_goals.mode_adaptive')}</button>
      </div>
      {#if !_hasWearable}
        <p class="setting-desc" style="padding:4px 0 0;font-size:12px;line-height:1.4">
          {$_('settings_goals.dynamic_needs_wearable')} <a href="#/settings/wellness" class="about-link">{$_('settings_goals.dynamic_needs_wearable_setup')}</a>.
        </p>
      {/if}
    </div>
    {#if $calorieGoalMode === 'fixed'}
      <div class="setting-divider"></div>
      <p class="setting-desc" style="padding:8px var(--page-px)">
        {$_('extracted.settings.uses_the_calorie_target_from_your_goal_templat_450')}
      </p>
    {:else if $calorieGoalMode === 'dynamic'}
      <div class="setting-divider"></div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <span class="setting-label">{$_('settings_goals.goal_factor')}</span>
        <div class="seg-control" style="width:100%;--seg-count:3;--seg-active:{$calorieGoalFactor === 0.8 ? 0 : $calorieGoalFactor === 1.2 ? 2 : 1}">
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 0.8}  on:click={() => calorieGoalFactor.set(0.8)}>{$_('extracted.settings.lose_20_451')}</button>
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.0}  on:click={() => calorieGoalFactor.set(1.0)}>{$_('settings_goals.factor_maintain')}</button>
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.2}  on:click={() => calorieGoalFactor.set(1.2)}>{$_('extracted.settings.gain_20_452')}</button>
        </div>
      </div>
      <div class="setting-divider"></div>
      <p class="setting-desc" style="padding:8px var(--page-px)">
        {$_('extracted.settings.uses_yesterday_s_final_calorie_burn_from_your_453')}
      </p>
    {:else if $calorieGoalMode === 'adaptive'}
      <div class="setting-divider"></div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <span class="setting-label">{$_('settings_goals.goal_factor')}</span>
        <div class="seg-control" style="width:100%;--seg-count:3;--seg-active:{$calorieGoalFactor === 0.8 ? 0 : $calorieGoalFactor === 1.2 ? 2 : 1}">
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 0.8}  on:click={() => calorieGoalFactor.set(0.8)}>{$_('extracted.settings.lose_20_451')}</button>
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.0}  on:click={() => calorieGoalFactor.set(1.0)}>{$_('settings_goals.factor_maintain')}</button>
          <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.2}  on:click={() => calorieGoalFactor.set(1.2)}>{$_('extracted.settings.gain_20_452')}</button>
        </div>
      </div>
      <div class="setting-divider"></div>
      <p class="setting-desc" style="padding:8px var(--page-px);line-height:1.5">
        {$_('settings_goals.adaptive_note')} <a href="https://github.com/TraceApps/nutritrace#adaptive-tdee" target="_blank" rel="noopener" class="about-link">{$_('settings_goals.how_it_works')}</a>
      </p>
    {/if}
  </div>
</div>
