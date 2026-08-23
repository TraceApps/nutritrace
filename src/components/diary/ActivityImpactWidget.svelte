<script>
  /**
   * Diary → right column → Activity Impact widget.
   *
   * Conditional widget that only renders when a wearable connection is
   * shifting today's calorie budget — either via the "activity earned
   * back" mechanic (any calorie-goal mode + wearable active kcal), OR
   * because the user is in Dynamic / Adaptive mode which derives their
   * whole goal from wearable data.
   *
   * Bridges Wellness and Diary: users on Dynamic/Adaptive mode today
   * have to open the Wellness page (or expand the bottom bar) to see
   * *why* their goal moved. This widget puts that story next to the
   * meals, so a glance at the diary shows "you have 855 left because
   * your Fitbit says you burned 512 extra today."
   *
   * Hidden entirely when activeKcal is 0 AND we're not in a
   * dynamic/adaptive mode (nothing meaningful to show).
   */
  import { Nutrition } from '../../lib/nutrition.js';

  export let activeKcal        = 0;         // _effectiveActive
  export let baseGoalKcal      = 2000;      // caloriesGoal
  export let adjustedGoalKcal  = 2000;      // caloriesGoalAdjusted
  export let energyUnit        = 'kcal';
  export let calorieGoalMode   = 'fixed';   // 'fixed' | 'dynamic' | 'adaptive'
  export let dynamicCaloriesOut = null;     // raw wearable burn
  export let adaptiveTdee       = null;     // learned TDEE

  $: hasActivity = activeKcal > 0;
  $: isDynamicOrAdaptive = calorieGoalMode === 'dynamic' || calorieGoalMode === 'adaptive';
  $: shouldRender = hasActivity || isDynamicOrAdaptive;

  $: activeE   = Nutrition.displayEnergy(activeKcal, energyUnit);
  $: baseE     = Nutrition.displayEnergy(baseGoalKcal, energyUnit);
  $: adjustedE = Nutrition.displayEnergy(adjustedGoalKcal, energyUnit);
  $: burnE     = Nutrition.displayEnergy(dynamicCaloriesOut ?? 0, energyUnit);
  $: tdeeE     = Nutrition.displayEnergy(adaptiveTdee ?? 0, energyUnit);
</script>

{#if shouldRender}
  <section class="activity-widget card">
    <header class="aw-header">
      <span class="material-symbols-rounded aw-icon">directions_run</span>
      <span class="aw-title">Activity impact</span>
      {#if calorieGoalMode === 'dynamic'}
        <span class="aw-mode" title="Dynamic goal moves with your wearable's burn">⚡ Dynamic</span>
      {:else if calorieGoalMode === 'adaptive'}
        <span class="aw-mode" title="Adaptive goal is learned from your weight trend">📈 Adaptive</span>
      {/if}
    </header>

    {#if calorieGoalMode === 'dynamic' && dynamicCaloriesOut != null}
      <div class="aw-body">
        <div class="aw-row">
          <span class="aw-label">Wearable burn (yesterday)</span>
          <span class="aw-val">{burnE.value.toLocaleString()} {burnE.unit}</span>
        </div>
        <div class="aw-row">
          <span class="aw-label">Base goal</span>
          <span class="aw-val">{baseE.value.toLocaleString()} {baseE.unit}</span>
        </div>
        {#if hasActivity}
          <div class="aw-row">
            <span class="aw-label"><span class="aw-plus">+</span> Today's active</span>
            <span class="aw-val aw-val-active">{activeE.value.toLocaleString()} {activeE.unit}</span>
          </div>
        {/if}
        <div class="aw-row aw-row-total">
          <span class="aw-label">Adjusted goal</span>
          <span class="aw-val">{adjustedE.value.toLocaleString()} {adjustedE.unit}</span>
        </div>
      </div>
    {:else if calorieGoalMode === 'adaptive' && adaptiveTdee != null}
      <div class="aw-body">
        <div class="aw-row">
          <span class="aw-label">Learned TDEE (35-day)</span>
          <span class="aw-val">{tdeeE.value.toLocaleString()} {tdeeE.unit}</span>
        </div>
        {#if hasActivity}
          <div class="aw-row">
            <span class="aw-label"><span class="aw-plus">+</span> Today's active</span>
            <span class="aw-val aw-val-active">{activeE.value.toLocaleString()} {activeE.unit}</span>
          </div>
        {/if}
        <div class="aw-row aw-row-total">
          <span class="aw-label">Adjusted goal</span>
          <span class="aw-val">{adjustedE.value.toLocaleString()} {adjustedE.unit}</span>
        </div>
      </div>
    {:else if hasActivity}
      <div class="aw-body">
        <div class="aw-row">
          <span class="aw-label">Today's active kcal</span>
          <span class="aw-val aw-val-active">{activeE.value.toLocaleString()} {activeE.unit}</span>
        </div>
        <div class="aw-row">
          <span class="aw-label">Base goal</span>
          <span class="aw-val">{baseE.value.toLocaleString()} {baseE.unit}</span>
        </div>
        <div class="aw-row aw-row-total">
          <span class="aw-label">Adjusted goal</span>
          <span class="aw-val">{adjustedE.value.toLocaleString()} {adjustedE.unit}</span>
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .activity-widget {
    padding: 16px 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .aw-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .aw-icon {
    color: #4FFFB0;
    font-size: 20px;
  }
  .aw-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.01em;
    flex: 1;
  }
  .aw-mode {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    white-space: nowrap;
  }

  .aw-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .aw-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    font-size: 12px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .aw-row-total {
    background: color-mix(in srgb, #4FFFB0 12%, transparent);
    font-weight: 700;
    margin-top: 4px;
  }
  .aw-label {
    color: var(--text-2);
  }
  .aw-val {
    color: var(--text-1);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .aw-val-active {
    color: #4FFFB0;
  }
  .aw-plus {
    color: #4FFFB0;
    font-weight: 700;
    margin-right: 2px;
  }
</style>
