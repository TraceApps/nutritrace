<script>
  import { _, locale } from 'svelte-i18n';
  import Toggle from '../../components/settings/Toggle.svelte';
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import { DB } from '../../lib/db.js';
  import { mealIcon } from '../../lib/mealIcon.js';
  import {
    mealNames,
    diaryShowBrands, diaryShowTimestamps, diaryShowThumbnails, diaryShowAllNutrients, dailyTargetsEnabled,
    diaryShowNutritionUnits, diaryShowMacroSummary, diaryPromptQuantity,
    diaryShowPortionSize, warnUnitMismatch, showUnitMetadata, diaryShowNotes, diaryShowCompletion, diaryDefaultField,
    diaryShowActivity, manualActivityPolicy, calorieAdjustFromActivity,
    showQuickCalories, quickCaloriesDisplay,
    diaryShowNutritionBar,
    diaryRailShowSummary, diaryRailShowWater, diaryRailShowBodyStats,
    diaryRailShowActivity as diaryRailShowActivityWidget,
    diaryRailShowNotes,
    healthConnectEnabled,
    fastingEnabled, fastingDefaultHours, fastingNotifyOnGoal,
    fastingScheduleEnabled, fastingScheduleTime, fastingScheduleDays, fastingScheduleGoal,
    weekStartDay,
  } from '../../stores/settings.js';
  import { weekdayOrder } from '../../lib/week.js';

  // Fasting days are stored by weekday (0 Sunday); shown from the week's
  // first day (#232).
  const _weekdayName = (idx, lang, width = 'long') =>
    new Intl.DateTimeFormat(lang || 'en', { weekday: width, timeZone: 'UTC' })
      .format(new Date(Date.UTC(2023, 0, 1 + idx)));
  $: _dayOrder = weekdayOrder($weekStartDay);
  import { isNative, getServerUrl } from '../../lib/platform.js';

  // Same rule the parent shell derives.
  $: isNativeLocal = isNative && !getServerUrl();

  // ── Meal names ─────────────────────────────────────────────────────────────
  let meals = [...(DB.getSetting('mealNames', ['Breakfast','Lunch','Dinner','Snacks']))];

  function autoSaveMeals() {
    const toSave = meals.filter(m => m.trim());
    if (toSave.length) mealNames.set(toSave);
  }

  // Drag-to-reorder for meal names
  let mealDragFrom = null, mealDragOver = null, mealDragDelta = 0, mealRowHeights = [];
  function onMealDragDown(e, i) {
    const list = e.currentTarget.closest('.drag-list');
    const rows = [...list.querySelectorAll('.drag-row')];
    mealRowHeights = rows.map(r => r.getBoundingClientRect().height);
    mealDragFrom = i; mealDragOver = i; mealDragDelta = 0;
    list.setPointerCapture(e.pointerId);
    list._dragStartY = e.clientY;
  }
  function onMealDragMove(e) {
    if (mealDragFrom === null) return;
    mealDragDelta = e.clientY - e.currentTarget._dragStartY;
    const rows = [...e.currentTarget.querySelectorAll('.drag-row')];
    const y = e.clientY;
    let best = mealDragOver;
    for (let idx = 0; idx < rows.length; idx++) {
      if (idx === mealDragFrom) continue;
      const r = rows[idx].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { best = idx; break; }
    }
    mealDragOver = best;
  }
  function onMealDragUp() {
    if (mealDragFrom !== null && mealDragOver !== null && mealDragFrom !== mealDragOver) {
      const reordered = [...meals];
      const [removed] = reordered.splice(mealDragFrom, 1);
      reordered.splice(mealDragOver, 0, removed);
      meals = reordered;
      autoSaveMeals();
    }
    mealDragFrom = null; mealDragOver = null; mealDragDelta = 0; mealRowHeights = [];
  }

  function dragShift(i, from, over, heights) {
    if (from === null || over === null || i === from || from === over) return 0;
    const h = heights[from] || 52;
    if (from < over && i > from && i <= over) return -h;
    if (from > over && i >= over && i < from) return h;
    return 0;
  }
</script>

<div class="section-body">

  <!-- Group: Food Row Display — what shows on each logged food row -->
  <p class="settings-group-heading">{$_('extracted.settings.food_row_display_415')}</p>
  <p class="settings-group-sub">{$_('extracted.settings.fields_shown_beneath_each_food_entry_in_the_di_416')}</p>
  <div class="card settings-card">
    <SettingRow label={$_('settings_diary.show_brand')} desc={$_('settings_diary.show_brand_desc')} divider={false}>
      <Toggle checked={$diaryShowBrands} on:change={e => diaryShowBrands.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.show_timestamps')} desc={$_('settings_diary.show_timestamps_desc')}>
      <Toggle checked={$diaryShowTimestamps} on:change={e => diaryShowTimestamps.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.show_thumbnails')} desc={$_('settings_diary.show_thumbnails_desc')}>
      <Toggle checked={$diaryShowThumbnails} on:change={e => diaryShowThumbnails.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.show_all_nutrients')} desc={$_('settings_diary.show_all_nutrients_desc')}>
      <Toggle checked={$diaryShowAllNutrients} on:change={e => diaryShowAllNutrients.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.daily_targets')} desc={$_('settings_diary.daily_targets_desc')}>
      <Toggle checked={$dailyTargetsEnabled} on:change={e => dailyTargetsEnabled.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.show_units')} desc={$_('settings_diary.show_units_desc')}>
      <Toggle checked={$diaryShowNutritionUnits} on:change={e => diaryShowNutritionUnits.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.show_portion')} desc={$_('settings_diary.show_portion_desc')}>
      <Toggle checked={$diaryShowPortionSize} on:change={e => diaryShowPortionSize.set(e.detail)} />
    </SettingRow>
  </div>

  <!-- Group: Meal Card Layout — controls on the meal card itself -->
  <p class="settings-group-heading">{$_('extracted.settings.meal_card_layout_417')}</p>
  <p class="settings-group-sub">{$_('extracted.settings.header_footer_and_interaction_on_each_meal_car_418')}</p>
  <div class="card settings-card">
    <SettingRow label={$_('settings_diary.show_macro_summary')} desc={$_('settings_diary.show_macro_summary_desc')} divider={false}>
      <Toggle checked={$diaryShowMacroSummary} on:change={e => diaryShowMacroSummary.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.ask_quantity')} desc={$_('settings_diary.ask_quantity_desc')}>
      <Toggle checked={$diaryPromptQuantity} on:change={e => diaryPromptQuantity.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.default_field')} desc={$_('settings_diary.default_field_desc')}>
      <div class="select-wrap" style="width:170px">
        <select class="select sel-sm" value={$diaryDefaultField} on:change={e => diaryDefaultField.set(e.currentTarget.value)}>
          <option value="servings">{$_('settings_diary.opt_num_servings')}</option>
          <option value="portion">{$_('settings_diary.opt_serving_size')}</option>
        </select>
      </div>
    </SettingRow>
    <SettingRow label={$_('settings_diary.show_progress_bar')} desc={$_('settings_diary.show_progress_bar_desc')}>
      <Toggle checked={$diaryShowNutritionBar} on:change={e => diaryShowNutritionBar.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.show_daily_notes')} desc={$_('settings_diary.show_daily_notes_desc')}>
      <Toggle checked={$diaryShowNotes} on:change={e => diaryShowNotes.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.show_completion')} desc={$_('settings_diary.show_completion_desc')}>
      <Toggle checked={$diaryShowCompletion} on:change={e => diaryShowCompletion.set(e.detail)} />
    </SettingRow>
  </div>

  <!-- Group: Nutrition Units — advanced serving/basis controls -->
  <p class="settings-group-heading">{$_('extracted.settings.nutrition_units_419')}</p>
  <p class="settings-group-sub">{$_('extracted.settings.off_by_default_turn_on_if_you_log_open_food_fa_420')}</p>
  <div class="card settings-card">
    <SettingRow label={$_('settings_diary.unit_metadata')} desc={$_('settings_diary.unit_metadata_desc')} divider={false}>
      <Toggle checked={$showUnitMetadata} on:change={e => showUnitMetadata.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings_diary.warn_conversions')} desc={$_('settings_diary.warn_conversions_desc')}>
      <Toggle checked={$warnUnitMismatch} on:change={e => warnUnitMismatch.set(e.detail)} />
    </SettingRow>
  </div>

  <!-- Group: Rail Widgets — ≥1280px only -->
  <p class="settings-group-heading">{$_('extracted.settings.rail_widgets_421')}</p>
  <p class="settings-group-sub">{$_('extracted.settings.widgets_in_the_right_column_on_wide_screens_12_422')}</p>
  <div class="card settings-card">
    <SettingRow label={$_('extracted.settings.day_summary_423')} desc="Calorie ring + macro cards." divider={false}>
      <Toggle checked={$diaryRailShowSummary} on:change={e => diaryRailShowSummary.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings.water.section')}>
      <Toggle checked={$diaryRailShowWater} on:change={e => diaryRailShowWater.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('settings.body_stats.section')} desc="Weight + measurements in one card.">
      <Toggle checked={$diaryRailShowBodyStats} on:change={e => diaryRailShowBodyStats.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('extracted.settings.activity_impact_425')} desc="Only renders when a wearable is connected.">
      <Toggle checked={$diaryRailShowActivityWidget} on:change={e => diaryRailShowActivityWidget.set(e.detail)} />
    </SettingRow>
    <SettingRow label={$_('diary_deep.day_notes')} desc="Puts the notes card in the rail instead of at the bottom of the meal list.">
      <Toggle checked={$diaryRailShowNotes} on:change={e => diaryRailShowNotes.set(e.detail)} />
    </SettingRow>
  </div>

  <!-- Group: Quick Calories -->
  <p class="settings-group-heading">{$_('diary.quick_calories.title')}</p>
  <p class="settings-group-sub">{$_('extracted.settings.one_tap_calorie_entries_when_you_don_t_want_a_427')}</p>
  <div class="card settings-card">
    <SettingRow label={$_('settings_diary.show_quick_cals')} desc={$_('settings_diary.show_quick_cals_desc')} divider={false}>
      <Toggle checked={$showQuickCalories} on:change={e => showQuickCalories.set(e.detail)} />
    </SettingRow>
    {#if $showQuickCalories}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div><span class="setting-label">{$_('settings_diary.quick_cals_display')}</span><div class="setting-desc">{$_('settings_diary.quick_cals_display_desc')}</div></div>
        <div class="select-wrap" style="width:130px">
          <select class="select sel-sm" value={$quickCaloriesDisplay} on:change={e => quickCaloriesDisplay.set(e.currentTarget.value)}>
            <option value="summed">{$_('settings_diary.opt_summed')}</option>
            <option value="separate">{$_('settings_diary.opt_separate')}</option>
          </select>
        </div>
      </div>
    {/if}
  </div>

  <!-- Group: Activity Section — manual activity logging & policy -->
  <p class="settings-group-heading">{$_('extracted.settings.activity_section_428')}</p>
  <p class="settings-group-sub">{$_('extracted.settings.manual_workout_logging_shown_as_its_own_sectio_429')}</p>
  <div class="card settings-card">
    <SettingRow label={$_('settings_diary.show_activity')} desc={$_('settings_diary.show_activity_desc')} divider={false}>
      <Toggle checked={$diaryShowActivity} on:change={e => diaryShowActivity.set(e.detail)} />
    </SettingRow>
    {#if $diaryShowActivity}
      <SettingRow label={$_('settings_diary.adjust_calorie_goal')} desc={$_('settings_diary.adjust_calorie_goal_desc')}>
        <Toggle checked={$calorieAdjustFromActivity} on:change={e => calorieAdjustFromActivity.set(e.detail)} />
      </SettingRow>
    {/if}
    {#if $diaryShowActivity && $calorieAdjustFromActivity && (!isNativeLocal || $healthConnectEnabled)}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div style="flex:1">
          <span class="setting-label">{$_('extracted.settings.when_wearable_manual_entries_both_exist_430')}</span>
          <div class="setting-desc">{isNativeLocal ? 'How to combine your manually-logged activity with Health Connect active calories on days you have both.' : 'How to combine your manually-logged activity with calories from Fitbit / Garmin / Withings / Health Connect on days you have both.'}</div>
          <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
            <label style="display:flex; gap:8px; align-items:flex-start;">
              <input type="radio" name="activityPolicy" value="wearable_wins" checked={$manualActivityPolicy === 'wearable_wins'} on:change={() => manualActivityPolicy.set('wearable_wins')} />
              <span><strong>{$_('settings_diary.policy_wearable_wins')}</strong> <span class="setting-desc">{$_('settings_diary.policy_wearable_desc')}</span></span>
            </label>
            <label style="display:flex; gap:8px; align-items:flex-start;">
              <input type="radio" name="activityPolicy" value="manual_wins" checked={$manualActivityPolicy === 'manual_wins'} on:change={() => manualActivityPolicy.set('manual_wins')} />
              <span><strong>{$_('settings_diary.policy_manual_wins')}</strong> <span class="setting-desc">{$_('settings_diary.policy_manual_desc')}</span></span>
            </label>
            <label style="display:flex; gap:8px; align-items:flex-start;">
              <input type="radio" name="activityPolicy" value="additive" checked={$manualActivityPolicy === 'additive'} on:change={() => manualActivityPolicy.set('additive')} />
              <span><strong>{$_('settings_diary.policy_add')}</strong> <span class="setting-desc">{$_('settings_diary.policy_add_desc')}</span></span>
            </label>
          </div>
          <div class="setting-desc" style="margin-top:8px">{$_('extracted.settings.when_no_wearable_data_exists_for_a_day_manual_431')}</div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Group: Fasting -->
  <p class="settings-group-heading">{$_('fasting_insights.title')}</p>
  <p class="settings-group-sub">{$_('extracted.settings.intermittent_fasting_section_with_an_optional_433')}</p>
  <div class="card settings-card">
    <SettingRow label={$_('settings_diary.show_fasting')} desc={$_('settings_diary.show_fasting_desc')} divider={false}>
      <Toggle checked={$fastingEnabled} on:change={e => fastingEnabled.set(e.detail)} />
    </SettingRow>
    {#if $fastingEnabled}
      <div class="setting-divider"></div>
      <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <span class="setting-label">{$_('settings_diary.default_fast_goal')}</span>
        <div class="seg-control" style="width:100%;--seg-count:5;--seg-active:{[14,16,18,20,23].indexOf($fastingDefaultHours)}">
          {#each [14,16,18,20,23] as h}
            <button class="seg-opt" class:seg-active={$fastingDefaultHours === h}
              on:click={() => fastingDefaultHours.set(h)}>
              {h === 23 ? 'OMAD' : `${h}:${24 - h}`}
            </button>
          {/each}
        </div>
      </div>
      <SettingRow label={$_('settings_diary.notify_goal')} desc={$_('settings_diary.notify_goal_desc')}>
        <Toggle checked={$fastingNotifyOnGoal} on:change={e => fastingNotifyOnGoal.set(e.detail)} />
      </SettingRow>

      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_diary.recurring_schedule')}</span>
          <div class="setting-desc">{$_('extracted.settings.auto_start_a_fast_at_a_fixed_time_each_day_the_434')}</div>
        </div>
        <Toggle checked={$fastingScheduleEnabled} on:change={e => fastingScheduleEnabled.set(e.detail)} />
      </div>
      {#if $fastingScheduleEnabled}
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">{$_('settings_diary.start_time')}</span>
          <input class="input" type="time" style="width:120px;text-align:center"
            value={$fastingScheduleTime}
            on:change={e => fastingScheduleTime.set(e.target.value)} />
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <span class="setting-label">{$_('settings_diary.repeat_on')}</span>
          <div class="seg-control multi" style="width:100%;--seg-count:7">
            {#each _dayOrder as idx}
              {@const label = _weekdayName(idx, $locale, 'narrow')}
              <button class="seg-opt" type="button"
                aria-label={_weekdayName(idx, $locale)}
                class:seg-active={$fastingScheduleDays?.includes(idx)}
                on:click={() => {
                  const cur = $fastingScheduleDays || [];
                  const next = cur.includes(idx) ? cur.filter(d => d !== idx) : [...cur, idx].sort((a,b)=>a-b);
                  fastingScheduleDays.set(next);
                }}>{label}</button>
            {/each}
          </div>
          <div class="setting-desc" style="margin:0">
            {$_('settings_diary.fasting_toggle_days_hint', { values: { first: _weekdayName(_dayOrder[0], $locale), last: _weekdayName(_dayOrder[6], $locale) } })}
          </div>
        </div>
        <div class="setting-divider"></div>
        <div class="setting-row">
          <span class="setting-label">{$_('settings_diary.schedule_goal')}</span>
          <input class="input" type="number" min="1" max="168" step="0.5"
            style="width:90px;text-align:center"
            value={$fastingScheduleGoal}
            on:change={e => fastingScheduleGoal.set(Number(e.target.value) || 16)} />
        </div>
      {/if}
    {/if}
  </div>

  <!-- Group: Meal Names — reorderable list of meal slots -->
  <p class="settings-group-heading">{$_('settings_diary.meal_names')}</p>
  <p class="settings-group-sub">{$_('extracted.settings.drag_to_reorder_order_sets_the_sequence_meals_436')}</p>
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="card settings-card drag-list"
    on:pointermove={onMealDragMove}
    on:pointerup={onMealDragUp}
    on:pointercancel={onMealDragUp}>
    {#each meals as _m, i}
      {#if i > 0}<div class="setting-divider"></div>{/if}
      <div class="setting-row drag-row"
        class:dragging={mealDragFrom === i}
        class:drag-target={mealDragFrom !== null && mealDragFrom !== i && mealDragOver === i}
        style={mealDragFrom !== null
          ? mealDragFrom === i
            ? `transform:scale(1.04) translateY(${mealDragDelta}px);transition:box-shadow 200ms ease,opacity 200ms ease`
            : `transform:translateY(${dragShift(i,mealDragFrom,mealDragOver,mealRowHeights)}px)`
          : ''}>
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <span class="drag-handle material-symbols-rounded" on:pointerdown={e => onMealDragDown(e, i)}>drag_indicator</span>
        <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3);flex-shrink:0">{mealIcon(meals[i])}</span>
        <input class="input" style="flex:1;height:36px;min-width:0" placeholder={$_('settings_main_deep.meal_placeholder', { values: { n: i+1 } })} bind:value={meals[i]} on:blur={autoSaveMeals} />
        {#if meals.length > 1}
          <button class="btn-icon" style="width:32px;height:32px;color:var(--danger);flex-shrink:0"
            on:click={() => { meals = meals.filter((_,j) => j !== i); autoSaveMeals(); }} title={$_('extracted.settings.remove_meal_437')}>
            <span class="material-symbols-rounded" style="font-size:16px">remove</span>
          </button>
        {/if}
      </div>
    {/each}
    <div style="padding:8px 16px 14px">
      <button class="btn btn-secondary" style="height:36px;font-size:13px;width:100%;display:flex;align-items:center;justify-content:center;gap:4px"
        on:click={() => meals = [...meals.filter(m => m.trim()), '']}>
        <span class="material-symbols-rounded" style="font-size:16px">add</span> {$_('foods.empty.add_meal')}
      </button>
    </div>
  </div>
</div>
