<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import DatePicker from '../components/ui/DatePicker.svelte';
  import DateInput  from '../components/ui/DateInput.svelte';
  import { resolveAssetUrl, isNative, getServerUrl } from '../lib/platform.js';
  import { fade, slide, fly } from 'svelte/transition';
  import { tweened } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';

  import MacroRing    from '../components/diary/MacroRing.svelte';
  import AddActivitySheet from '../components/diary/AddActivitySheet.svelte';
  import QuickCaloriesSheet from '../components/diary/QuickCaloriesSheet.svelte';
  import FastingWidget from '../components/diary/FastingWidget.svelte';
  import { mealIcon } from '../lib/mealIcon.js';
  import Sheet        from '../components/ui/Sheet.svelte';
  import Dialog       from '../components/ui/Dialog.svelte';
  import ActionSheet  from '../components/ui/ActionSheet.svelte';
  import UnitPicker   from '../components/ui/UnitPicker.svelte';
  import { scaleFactor as _unitScaleFactor } from '../lib/units.js';
  import { showSuccess, showError, showInfo } from '../stores/toast.js';
  import {
    currentDate, currentEntry, diaryTotals, macroPercents,
    prevDay, nextDay, loadEntry, removeDiaryItem, updateDiaryItem, saveBodyStats,
    copyMealItems, moveMealItems, clearMealItems, copyMealToDate, saveDiaryNote,
    splitRecipeItem, removeSplitChild, updateSplitChild,
    diaryShowNutritionSummary, diaryShowBodyStats, diaryLoadError
  } from '../stores/diary.js';
  import { mealNames, goals, energyUnit, weightUnit, lengthUnit, navStyle,
           diaryShowBrands, diaryShowThumbnails,
           diaryShowTimestamps, diaryShowMacroSummary, diaryPromptQuantity,
           diaryShowPortionSize, diaryShowNotes, diaryShowNutritionBar, diaryTotalsMode, macroLegendMode, distUnit,
           diaryShowAllNutrients, diaryShowNutritionUnits, visibleNutriments, hiddenBodyStats,
           showQuickCalories, quickCaloriesDisplay,
           dateFormat, timeFormat, disableAnimations, goalCelebrations, pageBanners, bannerStyle,
           calorieGoalMode, calorieGoalFactor,
           diaryShowActivity, manualActivityPolicy, calorieAdjustFromActivity,
           fastingEnabled,
           wellnessEnabled } from '../stores/settings.js';
  import { dayActivity, activitySummary, loadActivity, deleteActivity } from '../stores/activity.js';
  import WaterBanner  from '../components/banners/WaterBanner.svelte';
  import { editorState } from '../stores/editorState.js';
  import { NtApi } from '../lib/api.js';
  import { DB, localDateStr } from '../lib/db.js';
  import { portal } from '../lib/portal.js';
  import { Nutrition, NUTRIMENTS } from '../lib/nutrition.js';
  import { readBodyStat, tagBodyStats, LENGTH_KEYS } from '../lib/body-stats-unit.js';

  let addMealIdx = 0;
  let showAddAction = false;
  // Activity logging state (gated on diaryShowActivity)
  let showActivitySheet = false;
  let editingActivity = null;
  let showActivityAction = false;
  let activityActionItem = null;
  async function onActivityDelete(a) {
    try {
      await deleteActivity(a.id);
      showSuccess($_('diary.toast.activity_removed'));
    } catch (e) {
      showError(e?.message || $_('diary.errors.activity_delete_failed'));
    }
  }
  function openActivityActionSheet(a) {
    activityActionItem = a;
    _lockAndOpen(() => showActivityAction = true);
  }
  function onActivityAction(e) {
    const val = e.detail?.value;
    showActivityAction = false;
    if (!activityActionItem) return;
    if (val === 'edit') {
      editingActivity = activityActionItem;
      _lockAndOpen(() => showActivitySheet = true);
    } else if (val === 'delete') {
      onActivityDelete(activityActionItem);
    }
    activityActionItem = null;
  }
  let showDeleteDialog = false;
  let pendingDeleteIdx = null;
  // showBodyStats and showNutritionSummary now live in diary.js stores (controlled from topbar)
  let editItem         = null;
  let editPortion      = 100;   // food's base serving size — reference only
  let editUnit         = 'g';
  let editQuantity     = 1;     // number of servings — drives nutrition calc
  let showEditSheet    = false;
  // Quick Calories edit fields. Mirror QuickCaloriesSheet's create flow so
  // the user can change kcal / name / optional macros after the entry is in
  // the diary. Serving Size / Number of Servings / Unit don't apply to
  // quick-cal entries (they store nutrition directly with no portion math),
  // so the edit sheet branches on editItem.type === 'quick_calories'.
  // editKcalDisplay is in the user's current energy unit (kcal or kJ) for
  // display; saved back to kcal at write time so internal storage stays
  // consistent the same way QuickCaloriesSheet does.
  let editName         = '';
  let editKcalDisplay  = '';
  let editProtein      = '';
  let editCarbs        = '';
  let editFat          = '';

  // Sheet lock helper - prevents backdrop click-through on mobile
  let _sheetLock = false;
  let _sheetLockTimer;
  function _lockAndOpen(setter) {
    clearTimeout(_sheetLockTimer);
    _sheetLock = true;
    setter();
    _sheetLockTimer = setTimeout(() => _sheetLock = false, 400);
  }

  // Body stats — values are stored in whatever unit the user was in when
  // they last saved (tagged via weight_unit / lengths_unit). On open, we
  // convert into the user's CURRENT unit so the inputs read sensibly even
  // after a unit toggle; on save, we re-tag with the current unit.
  let bodyStatsData = {};
  let weightInput;            // focus target when the sheet opens
  function openBodyStats() {
    const raw = entry.bodyStats || {};
    const wu = $weightUnit || 'kg';
    const lu = $lengthUnit || 'in';
    const out = { ...raw };
    if (raw.weight != null && raw.weight !== '') out.weight = readBodyStat(raw, 'weight', wu, lu);
    for (const k of LENGTH_KEYS) {
      if (raw[k] != null && raw[k] !== '') out[k] = readBodyStat(raw, k, wu, lu);
    }
    delete out.weight_unit;
    delete out.lengths_unit;
    bodyStatsData = out;
    _lockAndOpen(() => diaryShowBodyStats.set(true));
    // Land cursor in the weight input — most common reason to open the
    // sheet. Falls through silently if the user has hidden the weight row.
    tick().then(() => weightInput?.focus());
  }
  async function saveBodyStatsLocal() {
    const payload = tagBodyStats(bodyStatsData, $weightUnit || 'kg', $lengthUnit || 'in');
    await saveBodyStats(payload);
    diaryShowBodyStats.set(false);
    showSuccess($_('diary.toast.body_stats_saved'));
  }

  function openEditItem(item) {
    editItem     = item;
    editPortion  = item.portion || item.amount || 100;
    editUnit     = item.unit || 'g';
    editQuantity = item.quantity || 1;
    _editChildContext = null;
    if (item?.type === 'quick_calories') {
      const storedKcal = Math.round(item.nutrition?.calories || 0);
      // Display in user's current energy unit; saved back to kcal.
      editKcalDisplay = $energyUnit === 'kJ'
        ? String(Math.round(storedKcal * 4.184))
        : String(storedKcal);
      editName    = (item.name && item.name !== 'Quick Calories') ? item.name : '';
      editProtein = item.nutrition?.proteins      != null ? String(item.nutrition.proteins)      : '';
      editCarbs   = item.nutrition?.carbohydrates != null ? String(item.nutrition.carbohydrates) : '';
      editFat     = item.nutrition?.fat           != null ? String(item.nutrition.fat)           : '';
    }
    _lockAndOpen(() => showEditSheet = true);
  }

  // Open the same edit sheet but bound to a single ingredient inside a
  // split recipe parent. Saving routes through updateSplitChild so the
  // parent's _splitItems[] gets the change (and the parent's totals
  // recompute via Nutrition.calculate sum-of-children).
  function openEditChild(parentIdx, childIdx, child) {
    editItem     = child;
    editPortion  = child.portion || child.amount || 100;
    editUnit     = child.unit || 'g';
    editQuantity = child.quantity || 1;
    _editChildContext = { parentIdx, childIdx };
    _lockAndOpen(() => showEditSheet = true);
  }

  // null when editing a regular diary item; { parentIdx, childIdx } when
  // editing a split-recipe ingredient.
  let _editChildContext = null;

  async function saveEditItem() {
    if (!editItem) return;
    // Quick Calories items skip portion math entirely — nutrition is written
    // straight from the edit fields. Blank optional macros drop the key so
    // daily totals don't pick up zero-filled phantoms (same shape as
    // addQuickCalories in src/stores/diary.js).
    if (editItem.type === 'quick_calories') {
      const raw = Number(editKcalDisplay);
      if (!Number.isFinite(raw) || raw <= 0) {
        showError(`Enter a positive ${$energyUnit === 'kJ' ? 'kJ' : 'kcal'} value.`);
        return;
      }
      const kcal = $energyUnit === 'kJ' ? Math.round(raw / 4.184) : Math.round(raw);
      const _opt = v => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
      };
      const p = _opt(editProtein), c = _opt(editCarbs), f = _opt(editFat);
      const nutrition = { calories: kcal };
      if (p != null) nutrition.proteins      = p;
      if (c != null) nutrition.carbohydrates = c;
      if (f != null) nutrition.fat           = f;
      const trimmed = (editName || '').trim().slice(0, 60);
      const changes = {
        name: trimmed || 'Quick Calories',
        nutrition,
      };
      await updateDiaryItem(editItem._i, changes);
      showEditSheet = false;
      editItem = null;
      showSuccess($_('diary.toast.updated'));
      return;
    }
    const origPortion = parseFloat(editItem.portion) || 100;
    const origUnit    = editItem.unit || 'g';
    const newPortion  = parseFloat(editPortion)      || 100;
    // Pass editItem as the food so the scaler can consult per-food alt_units
    // (slice/cookie/bottle = X g) and density for cross-system conversion.
    // Issues #69 + #70.
    const portionFactor = _unitScaleFactor(origPortion, origUnit, newPortion, editUnit, editItem);
    let newNutrition = editItem.nutrition;
    if (editItem.nutrition && origPortion > 0) {
      newNutrition = Object.fromEntries(
        Object.entries(editItem.nutrition).map(([k, v]) => [k, (parseFloat(v) || 0) * portionFactor])
      );
    }
    const changes = {
      portion:   newPortion,
      unit:      editUnit,
      quantity:  parseFloat(editQuantity) || 1,
      nutrition: newNutrition,
    };
    if (_editChildContext) {
      await updateSplitChild(_editChildContext.parentIdx, _editChildContext.childIdx, changes);
    } else {
      await updateDiaryItem(editItem._i, changes);
    }
    showEditSheet = false;
    editItem = null;
    _editChildContext = null;
    showSuccess($_('diary.toast.updated'));
  }

  $: meals = $mealNames || ['Breakfast','Lunch','Dinner','Snacks'];
  $: editCalc = (() => {
    if (!editItem) return {};
    const origPortion   = parseFloat(editItem.portion) || 100;
    const origUnit      = editItem.unit || 'g';
    const newPortion    = parseFloat(editPortion)      || origPortion;
    // editItem carries the food's nutrition_basis / alt_units / density_g_ml
    // via the addDiaryItem spread, so passing it gives accurate cross-system
    // conversion when those fields are set. Issues #69 + #70.
    const portionFactor = _unitScaleFactor(origPortion, origUnit, newPortion, editUnit, editItem);
    const scaledNutrition = editItem.nutrition
      ? Object.fromEntries(Object.entries(editItem.nutrition).map(([k, v]) => [k, (parseFloat(v) || 0) * portionFactor]))
      : editItem.nutrition;
    return Nutrition.calculate({ ...editItem, nutrition: scaledNutrition, quantity: parseFloat(editQuantity) || 1 });
  })();
  $: _editEnergy = Nutrition.displayEnergy(editCalc.calories || 0, $energyUnit);
  // Only use currentEntry if it belongs to the currently-displayed date;
  // this prevents stale data from a previous date from showing when navigating
  $: entry = ($currentEntry && $currentEntry.date === $currentDate)
    ? $currentEntry
    : { items: [], bodyStats: {} };
  $: totals = $diaryTotals || {};

  // Nutrition Summary drill-down: tap a nutrient row → show top contributing
  // items for that nutrient sorted descending. Only one expanded at a time so
  // the modal stays compact. Auto-collapses when the modal closes. The
  // "+N more" rollup row is itself clickable — tap to swap from top-5 to the
  // full list.
  let _nsExpanded = null;
  let _nsShowAll  = false;
  $: if (!$diaryShowNutritionSummary) { _nsExpanded = null; _nsShowAll = false; }
  function _nsToggle(id) {
    _nsExpanded = (_nsExpanded === id) ? null : id;
    _nsShowAll  = false;
  }
  $: _nsContributors = (() => {
    if (!_nsExpanded || !entry?.items?.length) return null;
    const id = _nsExpanded;
    const rows = entry.items.map(it => {
      const calc = Nutrition.calculate(it);
      const value = calc[id] || 0;
      if (value <= 0) return null;
      const isQuick = it.type === 'quick_calories';
      const portion = isQuick ? null
        : `${Math.round((it.portion || it.amount || 100) * (it.quantity || 1) * 10) / 10}${it.unit || 'g'}`;
      return { name: it.name || 'Item', value, isQuick, portion };
    }).filter(Boolean).sort((a, b) => b.value - a.value);
    const visible    = _nsShowAll ? rows : rows.slice(0, 5);
    const hidden     = _nsShowAll ? []   : rows.slice(5);
    const hiddenSum  = hidden.reduce((s, c) => s + c.value, 0);
    return { visible, hiddenCount: hidden.length, hiddenSum, allShown: _nsShowAll };
  })();

  // Dynamic calorie goal — fetch yesterday's calories_out when mode = 'dynamic'
  let _dynamicCaloriesOut = null;   // raw burn from device (yesterday)
  let _dynamicGoalDate    = null;   // which diary date we fetched for
  // Adaptive TDEE — server-computed; cached once per page load
  let _adaptiveTdee = null;
  $: _fixedGoal = ($goals && $goals.calories) ? ($goals.calories.max || $goals.calories.min || 2000) : 2000;
  $: caloriesGoal =
       ($calorieGoalMode === 'dynamic' && _dynamicCaloriesOut != null)
         ? Math.round(_dynamicCaloriesOut * $calorieGoalFactor)
       : ($calorieGoalMode === 'adaptive' && _adaptiveTdee != null)
         ? Math.round(_adaptiveTdee * $calorieGoalFactor)
       : _fixedGoal;
  async function _loadDynamicGoal(date) {
    if ($calorieGoalMode !== 'dynamic') return;
    if (_dynamicGoalDate === date) return;
    _dynamicGoalDate = date;
    try {
      const r = await NtApi.get(`/api/wellness/calories-out?date=${date}`);
      _dynamicCaloriesOut = r.calories_out;
    } catch { _dynamicCaloriesOut = null; }
  }
  async function _loadAdaptiveTdee() {
    try {
      const r = await NtApi.get('/api/goals/adaptive-tdee');
      _adaptiveTdee = r?.ready ? r.tdee : null;
    } catch { _adaptiveTdee = null; }
  }

  $: if ($calorieGoalMode === 'dynamic' && $currentDate) _loadDynamicGoal($currentDate);
  $: if ($calorieGoalMode === 'adaptive' && _adaptiveTdee == null) _loadAdaptiveTdee();

  // Activity offset — load whenever date changes (gated on the toggle)
  $: if ($diaryShowActivity && $currentDate) loadActivity($currentDate);

  // Effective active calories from manual + wearable per policy.
  // Adjusts the displayed calories budget when calorieAdjustFromActivity is
  // on; otherwise the activity section still shows the burn but the goal
  // stays at its base value (cleanest for fixed-budget / cutting workflows).
  // Macro percentages always use the base goal so protein/carbs/fat targets
  // don't drift when you log a workout.
  $: _effectiveActive = ($diaryShowActivity && $calorieAdjustFromActivity ? ($activitySummary?.effective || 0) : 0);
  $: caloriesGoalAdjusted = caloriesGoal + _effectiveActive;

  $: _hasBottomNav = $navStyle === 'bottom' || $navStyle === 'both';
  $: barBottom     = _hasBottomNav ? 'calc(var(--nav-h) + env(safe-area-inset-bottom, 0px))' : 'env(safe-area-inset-bottom, 0px)';

  let barExpanded = false;
  let showWaterQuickAdd = false;
  $: _mp = Nutrition.macroPercents(totals);

  // Meal visual identity (icon + accent color per meal slot)
  // Icons are now computed per meal name via mealIcon(); colors cycle for any number of meals
  const MEAL_COLORS = ['#FFB347','#4FFFB0','#4FC3F7','#CE93D8','#FF7070','#80DEEA','#C5E1A5','#FFD54F','#FF80AB','#B39DDB'];
  const mealColor = i => MEAL_COLORS[i % MEAL_COLORS.length];

  // Tweened counters — animate numbers when food is added/removed
  // Pass duration dynamically so they respect "Disable animations"
  const _calTween  = tweened(0, { duration: 500, easing: cubicOut });
  const _protTween = tweened(0, { duration: 400, easing: cubicOut });
  const _carbTween = tweened(0, { duration: 400, easing: cubicOut });
  const _fatTween  = tweened(0, { duration: 400, easing: cubicOut });
  $: _calTween.set(Math.round(totals.calories || 0),       { duration: $disableAnimations ? 0 : 500 });
  // Animated calorie total formatted for the user's chosen energy unit (kcal/kJ)
  $: _sumEnergy = Nutrition.displayEnergy($_calTween, $energyUnit);

  // Restore scroll position after food added from Foods page
  $: if (editorState.lastMealAdded != null) {
    requestAnimationFrame(() => {
      const scrollContainer = document.querySelector('.page-transition');
      if (scrollContainer && editorState.diaryScrollY != null) {
        scrollContainer.scrollTop = editorState.diaryScrollY;
        editorState.diaryScrollY = null;
      }
      editorState.lastMealAdded = null;
    });
  }
  $: _protTween.set(Math.round((totals.proteins||0)*10)/10,       { duration: $disableAnimations ? 0 : 400 });
  $: _carbTween.set(Math.round((totals.carbohydrates||0)*10)/10,  { duration: $disableAnimations ? 0 : 400 });
  $: _fatTween.set(Math.round((totals.fat||0)*10)/10,             { duration: $disableAnimations ? 0 : 400 });

  // Bar fill-in on mount — bars start at 0 and animate to actual value
  let _barsMounted = false;

  // Goal celebration
  let _calGoalCelebrating   = false;
  let _waterGoalCelebrating = false;
  let _prevCalPct   = null;
  let _prevWaterPct = null;
  $: if (_prevCalPct !== null && $goalCelebrations && !$disableAnimations && calPct >= 100 && _prevCalPct < 100) {
    _calGoalCelebrating = true;
    setTimeout(() => { _calGoalCelebrating = false; }, 1200);
  }
  $: _prevCalPct = calPct;
  $: if (_prevWaterPct !== null && $goalCelebrations && !$disableAnimations && _waterPct >= 100 && _prevWaterPct < 100) {
    _waterGoalCelebrating = true;
    setTimeout(() => { _waterGoalCelebrating = false; }, 1200);
  }
  $: _prevWaterPct = _waterPct;
  $: _barExpandedExtra = barExpanded
    ? (52 + 48 + ($diaryShowNutritionBar && nutritionBarItems.length > 0 ? 8 + nutritionBarItems.length * 28 : 0) + 8 + (_waterShowInDiary ? 40 : 0))
    : 0;
  $: _barBaseH = 46 + (_waterShowInDiary ? 8 : 0);
  $: contentPad = _hasBottomNav
    ? `calc(var(--nav-h) + ${_barBaseH + _barExpandedExtra + 12}px)`
    : `${_barBaseH + _barExpandedExtra + 12}px`;

  // Per-macro goals (absolute) for bottom bar remaining display
  function _macroGoal(id) {
    const g = $goals?.[id]; if (!g) return null;
    const raw = g.max ?? g.min ?? null; if (raw == null) return null;
    if (g.isPercent) {
      const density = {fat:9,'saturated-fat':9,carbohydrates:4,sugars:4,proteins:4}[id];
      return density ? Math.round(caloriesGoal * raw / 100 / density) : raw;
    }
    return raw;
  }
  $: fatGoal   = _macroGoal('fat');
  $: carbGoal  = _macroGoal('carbohydrates');
  $: protGoal  = _macroGoal('proteins');
  $: calPct    = Math.min(100, ((totals.calories||0) / caloriesGoalAdjusted) * 100);

  function formatDate(d) {
    if (!d) return '';
    const dt = new Date(d + 'T12:00:00');
    const today = localDateStr();
    const yest  = localDateStr(new Date(Date.now() - 86400000));
    if (d === today) return 'Today';
    if (d === yest)  return 'Yesterday';
    return dt.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  }

  function formatDateSub(d, fmt) {
    if (!d) return '';
    const dt = new Date(d + 'T12:00:00');
    fmt = fmt || 'ISO';
    if (fmt === 'US') {
      const m = String(dt.getMonth()+1).padStart(2,'0');
      const dy = String(dt.getDate()).padStart(2,'0');
      return m + '/' + dy + '/' + dt.getFullYear();
    } else if (fmt === 'EU') {
      const m = String(dt.getMonth()+1).padStart(2,'0');
      const dy = String(dt.getDate()).padStart(2,'0');
      return dy + '/' + m + '/' + dt.getFullYear();
    } else if (fmt === 'natural') {
      return dt.toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
    }
    return d; // ISO default
  }

  function openAddFood(mealIdx) {
    addMealIdx = mealIdx;
    // Save scroll position so we can restore it when returning
    const scrollContainer = document.querySelector('.page-transition');
    editorState.diaryScrollY = scrollContainer ? scrollContainer.scrollTop : 0;
    push('/foods?pick=1&meal=' + mealIdx + '&date=' + $currentDate);
  }

  // ── Quick Calories sheet — Fitbit-style "log just a calorie number" entry
  // opened from the bolt button in each meal section. Items land in
  // diary.items as { type: 'quick_calories', name, nutrition: { calories } }
  // and render via the dedicated branch below (summed or separate per the
  // quickCaloriesDisplay setting). Issue #42 (roseyhead).
  let _quickSheetOpen = false;
  let _quickSheetMeal = 0;
  function openQuickCalories(mealIdx) {
    _quickSheetMeal = mealIdx;
    _quickSheetOpen = true;
  }

  // Smart Log entry point lives on the assistant FAB (hold-to-record). Diary
  // refreshes automatically via the global 'wl:setting' / sync events when
  // the modal saves new items. No local Smart Log state needed here.

  function confirmDelete(idx) {
    pendingDeleteIdx = idx;
    _lockAndOpen(() => showDeleteDialog = true);
  }

  async function doDelete() {
    if (pendingDeleteIdx !== null) {
      await removeDiaryItem(pendingDeleteIdx);
      showSuccess($_('diary.toast.item_removed'));
    }
    pendingDeleteIdx = null;
  }

  // Daily notes
  let notesExpanded = false;
  let _notesText = '';
  let _notesSaving = false;
  let _lastLoadedNotes = '';
  $: if (entry && (entry.notes || '') !== _lastLoadedNotes) {
    _lastLoadedNotes = entry.notes || '';
    _notesText = _lastLoadedNotes;
    // Auto-close when switching to a day with no note; keep open if note exists
    if (!_lastLoadedNotes) notesExpanded = false;
  }
  function toggleNotes() { notesExpanded = !notesExpanded; }
  async function commitNotes() {
    if ((_notesText || '') === (entry?.notes || '')) return;
    _notesSaving = true;
    try {
      await saveDiaryNote(_notesText);
    } catch (e) {
      showError(e?.message || $_('diary.errors.note_save_failed'));
    } finally {
      _notesSaving = false;
    }
  }

  // Per-meal nutrition totals popup (tap kcal text to open)
  let mealTotalsIdx = null;
  $: _mealTotalsItems = (mealTotalsIdx != null && entry?.items)
    ? getMealItems(entry.items, mealTotalsIdx) : [];
  $: _mealTotals = _mealTotalsItems.length
    ? Nutrition.sum(_mealTotalsItems.map(i => Nutrition.calculate(i)))
    : {};

  // Meal-level actions (⋮ on meal header)
  let showMealAction       = false;
  let actionMealIdx        = null;
  let mealActionMode       = 'move';   // 'move' — picks target meal (used by the same-date move sheet below)
  let showMealTargetPicker = false;
  let showClearMealDialog  = false;
  let showSaveAsMeal       = false;
  let saveAsMealName       = '';
  let saveAsMealSaving     = false;
  let saveAsMealNameInput;        // focus target on open

  function openMealActionSheet(mealIdx) {
    actionMealIdx = mealIdx;
    _lockAndOpen(() => showMealAction = true);
  }

  function onMealAction(e) {
    const val = e.detail?.value;
    if (val === 'move') { mealActionMode = 'move'; _lockAndOpen(() => showMealTargetPicker = true); }
    else if (val === 'copy_to') {
      // Same single-sheet date+meal picker the per-item Copy uses,
      // sharing one component for both flows. copyMode tells the
      // Copy handler whether to addDiaryItem (per-item) or
      // copyMealToDate (per-meal).
      //
      // Default target date = today (not the currently-viewed date).
      // The common copy-from-a-past-day case is "I ate the same lunch
      // today as I did on Monday" — so pre-filling today saves a tap.
      // The date picker in the sheet still lets the user pick anything.
      copyMode = 'meal';
      copyDate = localDateStr();
      copyMeal = Number(actionMealIdx) || 0;
      _lockAndOpen(() => showCopySheet = true);
    }
    else if (val === 'save_meal') {
      saveAsMealName = meals[actionMealIdx] || '';
      _lockAndOpen(() => showSaveAsMeal = true);
      tick().then(() => saveAsMealNameInput?.focus());
    }
    else if (val === 'clear') { _lockAndOpen(() => showClearMealDialog = true); }
  }

  async function doSaveAsMeal() {
    if (actionMealIdx == null) return;
    const name = (saveAsMealName || '').trim();
    if (!name) { showError($_('diary.errors.name_required')); return; }
    const items = getMealItems(entry.items, actionMealIdx).map(({ _i, ...it }) => it);
    if (!items.length) { showError($_('diary.errors.nothing_to_save')); return; }
    saveAsMealSaving = true;
    try {
      await NtApi.createMeal({ name, notes: '', categories: [], items, imgUrl: '' });
      showSuccess(`Saved "${name}" to Meals`);
      showSaveAsMeal = false;
    } catch (err) {
      showError(err?.message || 'Save failed');
    } finally {
      saveAsMealSaving = false;
    }
  }

  async function onMealTargetPick(e) {
    // Only 'move' uses this same-date target picker now; the old 'copy'
    // path was consolidated into the single Copy sheet (date+meal).
    const targetIdx = e.detail?.value;
    const from = actionMealIdx;
    if (targetIdx == null || from == null) return;
    try {
      if (targetIdx === from) { showInfo('Already in that meal'); return; }
      const n = await moveMealItems(from, targetIdx);
      if (n) showSuccess(`Moved ${n} item${n === 1 ? '' : 's'} to ${meals[targetIdx]}`);
    } catch (err) {
      showError(err?.message || 'Action failed');
    }
  }

  async function doClearMeal() {
    if (actionMealIdx == null) return;
    try {
      const n = await clearMealItems(actionMealIdx);
      if (n) showSuccess(`Cleared ${n} item${n === 1 ? '' : 's'} from ${meals[actionMealIdx]}`);
    } catch (err) {
      showError(err?.message || 'Clear failed');
    }
  }

  function getMealTotals(items) {
    if (!items || !items.length) return null;
    const t = Nutrition.sum(items.map(i => Nutrition.calculate(i)));
    const cal = t.calories || 0;
    if (!cal) return null;
    const p = Math.round((t.proteins || 0) * 4 / cal * 100);
    const c = Math.round((t.carbohydrates || 0) * 4 / cal * 100);
    const f = Math.round((t.fat || 0) * 9 / cal * 100);
    // cal stays as a number — the meal-macro-footer passes it through
    // Nutrition.displayEnergy() which does parseFloat() internally. Returning
    // a locale-formatted string like "29,710" used to break that parseFloat
    // (it'd stop at the comma and yield 29), truncating meal kcal totals
    // above 1000 to the leading digit(s). The template handles display-side
    // commas via _mtEnergy.value.toLocaleString() below. (Issue #51)
    return { cal: Math.round(cal), p, c, f };
  }

  function getMealItems(entryItems, mealIdx) {
    return (entryItems || []).map((it, i) => ({...it, _i: i}))
      .filter(it => {
        const m = (it.meal != null) ? it.meal : 0;
        return m === mealIdx || String(m) === String(mealIdx);
      });
  }

  function formatKcal(item) {
    const calc = Nutrition.calculate(item);
    return Math.round(calc.calories || 0);
  }

  // Date picker — calendar UI lives in src/components/ui/DatePicker.svelte
  let showDatePicker = false;
  let pickerDate = '';
  function openDatePicker() {
    pickerDate = $currentDate;
    _lockAndOpen(() => showDatePicker = true);
  }
  function goToDate() {
    if (pickerDate && /^\d{4}-\d{2}-\d{2}$/.test(pickerDate)) {
      loadEntry(pickerDate);
    }
    showDatePicker = false;
  }

  function nutrientBarColor(id) {
    if (id === 'fat' || id === 'saturated-fat') return 'var(--macro-fat)';
    if (id === 'carbohydrates' || id === 'sugars' || id === 'added-sugars' || id === 'fiber') return 'var(--macro-carbs)';
    if (id === 'proteins') return 'var(--macro-protein)';
    return 'var(--accent)';
  }

  // Totals toggle — use a local variable so Svelte reactivity is guaranteed
  // even inside the portalled bottom bar element
  let _totalsMode = $diaryTotalsMode || 'consumed';
  $: _totalsMode = $diaryTotalsMode || 'consumed';

  function toggleTotalsMode() {
    const next = _totalsMode === 'consumed' ? 'remaining' : 'consumed';
    _totalsMode = next;
    diaryTotalsMode.set(next);
  }

  // Nutrition bar: visible NUTRIMENTS that have goals set
  $: nutritionBarItems = (() => {
    if (!$diaryShowNutritionBar) return [];
    return NUTRIMENTS
      .filter(n => n.default && $goals[n.id] && $goals[n.id].showInDiary !== false)
      .slice(0, 8) // cap to prevent overflow
      .map(n => {
        const g = $goals[n.id];
        let tgt = null;
        if (g) {
          const raw = g.max ?? g.min ?? null;
          if (raw != null && g.isPercent) {
            const density = {fat:9,'saturated-fat':9,carbohydrates:4,sugars:4,proteins:4}[n.id];
            const calGoal = $goals.calories?.max ?? $goals.calories?.min ?? 2000;
            tgt = density ? Math.round(calGoal * raw / 100 / density) : raw;
          } else {
            tgt = raw;
          }
        }
        const cur = totals[n.id] || 0;
        const rem = tgt ? Math.max(0, tgt - cur) : null;
        const pct = tgt ? Math.min(100, cur / tgt * 100) : 0;
        const over = tgt && cur > tgt && !g?.isMin;
        let dispCur = cur, dispTgt = tgt, dispUnit = n.unit;
        if (n.id === 'calories' && $energyUnit === 'kJ') {
          dispCur = Nutrition.kcalToKj(cur);
          dispTgt = tgt != null ? Nutrition.kcalToKj(tgt) : tgt;
          dispUnit = 'kJ';
        }
        return { ...n, cur: dispCur, rem, tgt: dispTgt, pct, over, unit: dispUnit };
      });
  })();

  function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
      const use24 = $timeFormat === '24h';
      return new Date(isoStr).toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit', hour12: !use24
      });
    } catch { return ''; }
  }

  // Long-press action sheet
  let showItemAction = false;
  let actionItem     = null;
  let _lpTimer       = null;
  let showMoveToMeal = false;

  // ── Multi-select / bulk delete ──────────────────────────────────────────────
  let selectMode    = false;
  let selectedItems = new Set(); // stores _i (original item indices)
  let showMultiDeleteDialog = false;

  function enterSelectMode(item) {
    selectMode    = true;
    selectedItems = new Set([item._i]);
  }

  function toggleItemSelect(item) {
    if (selectedItems.has(item._i)) selectedItems.delete(item._i);
    else selectedItems.add(item._i);
    selectedItems = selectedItems;
    if (selectedItems.size === 0) selectMode = false;
  }

  function exitSelectMode() {
    selectMode    = false;
    selectedItems = new Set();
  }

  async function doDeleteSelected() {
    const count    = selectedItems.size;
    const toDelete = new Set(selectedItems);
    let ent = null;
    currentEntry.subscribe(v => ent = v)();
    if (!ent) return;
    const updated = { ...ent, items: ent.items.filter((_, i) => !toDelete.has(i)) };
    await NtApi.saveDiaryDate($currentDate, {
      items:       updated.items,
      body_stats:  updated.bodyStats || {},
      water:       updated.water,
    });
    await loadEntry($currentDate);
    showSuccess(`${count} item${count !== 1 ? 's' : ''} removed`);
    exitSelectMode();
  }

  function onItemTouchStart(e, item) {
    _lpTimer = setTimeout(() => {
      _lpTimer = null;
      if (selectMode) return;
      actionItem = item;
      _lockAndOpen(() => showItemAction = true);
    }, 500);
  }
  function onItemTouchMove() {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  }
  function onItemTouchEnd() {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  }
  function onItemAction(e) {
    const val = e.detail?.value;
    if (!actionItem) return;
    if (val === 'edit')        { openEditItem(actionItem); }
    if (val === 'replace')     { replaceItem(actionItem); }
    if (val === 'move')        { _lockAndOpen(() => showMoveToMeal = true); }
    if (val === 'copy_to') {
      // Open the shared Copy sheet in 'item' mode. Same single-sheet UX
      // the per-meal Copy uses; copyMode tells the Copy handler which
      // backend call to fire (addDiaryItem for items, copyMealToDate
      // for meals). Default target = today so copying a past item to
      // the current day takes one tap. See onMealAction for the same
      // rationale on the per-meal path.
      copyMode = 'item';
      copyDate = localDateStr();
      copyMeal = Number(actionItem.meal) || 0;
      _lockAndOpen(() => showCopySheet = true);
    }
    if (val === 'select')  { enterSelectMode(actionItem); }
    if (val === 'split')   { splitRecipe(actionItem); }
    if (val === 'delete')  { confirmDelete(actionItem._i); }
  }

  // Shared "Copy" sheet for both per-item AND per-meal copy actions.
  // copyMode === 'item' → uses addDiaryItem to copy actionItem.
  // copyMode === 'meal' → uses copyMealToDate to copy every item in
  // actionMealIdx. Same single-sheet date+meal picker for both flows
  // so the UX is identical (consolidated from the previous two-step
  // per-meal copy_date flow that the user found redundant).
  let showCopySheet = false;
  let copyMode = 'item'; // 'item' | 'meal'
  let copyDate = null;
  let copyMeal = 0;
  let copyBusy = false;

  $: copySourceName = copyMode === 'meal'
    ? (meals[actionMealIdx] || 'meal')
    : (actionItem?.name || 'item');

  async function onConfirmCopy() {
    if (!copyDate || copyBusy) return;
    copyBusy = true;
    try {
      const targetMeal = Number(copyMeal) || 0;
      const mealLabel  = meals[targetMeal] || 'meal';
      const sameDay    = copyDate === $currentDate;
      if (copyMode === 'meal') {
        const from = actionMealIdx;
        if (from == null) return;
        const n = await copyMealToDate(from, copyDate, targetMeal);
        if (n) showSuccess(sameDay
          ? `Copied ${n} item${n === 1 ? '' : 's'} to ${mealLabel}`
          : `Copied ${n} item${n === 1 ? '' : 's'} to ${mealLabel} on ${copyDate}`);
        else showInfo('Nothing to copy');
      } else {
        if (!actionItem) return;
        const { addDiaryItem } = await import('../stores/diary.js');
        // Shallow clone + scrub the fields that bind the item to its
        // current row. addDiaryItem generates a new index + id on the
        // destination day. Image references + notes are preserved.
        const { _i, id, ...rest } = actionItem;
        await addDiaryItem(rest, targetMeal, copyDate);
        showSuccess(sameDay
          ? `Copied to ${mealLabel}`
          : `Copied to ${mealLabel} on ${copyDate}`);
      }
      showCopySheet = false;
    } catch (err) {
      showError(err?.message || 'Copy failed');
    } finally {
      copyBusy = false;
    }
  }

  // Split a recipe diary item into its scaled ingredients. Saved recipe in
  // the library stays intact; only this diary day changes. The recipe row
  // stays visible (name + image) and its ingredients become an expandable
  // sub-list below it.
  async function splitRecipe(item) {
    if (!item || item._i == null) return;
    const ok = await splitRecipeItem(item._i);
    if (ok) {
      showSuccess('Recipe split into ingredients');
      // Auto-expand the just-split parent so the user immediately sees
      // what was unpacked and can act on individual ingredients.
      _splitExpanded.add(item._i);
      _splitExpanded = _splitExpanded;
    } else {
      showError("Couldn't split — no ingredients found on this item");
    }
  }

  // Tracks which split-recipe parents are currently expanded by their
  // diary index. Reset on date change since indices reshuffle.
  let _splitExpanded = new Set();
  function toggleSplitExpand(idx) {
    if (_splitExpanded.has(idx)) _splitExpanded.delete(idx);
    else                          _splitExpanded.add(idx);
    _splitExpanded = _splitExpanded;
  }
  $: if ($currentDate) _splitExpanded = new Set();

  // Tracks which summed Quick Calories rows are currently expanded, keyed
  // by the meal index (one summed row per meal). Lets users see + edit the
  // individual entries that contributed to the sum without leaving Summed
  // display mode. Same chevron + indented-children pattern as split
  // recipes above. (Issue #42 follow-up from roseyhead.)
  let _quickCalExpanded = new Set();
  function toggleQuickCalExpand(mealIdx) {
    if (_quickCalExpanded.has(mealIdx)) _quickCalExpanded.delete(mealIdx);
    else                                _quickCalExpanded.add(mealIdx);
    _quickCalExpanded = _quickCalExpanded;
  }
  $: if ($currentDate) _quickCalExpanded = new Set();

  async function onRemoveSplitChild(parentIdx, childIdx) {
    await removeSplitChild(parentIdx, childIdx);
  }

  // Whether the currently-selected action item is a recipe (so we should
  // surface the Split Recipe option in its action sheet). Recipes added to
  // the diary spread their `items[]` and `is_recipe=1` onto the diary
  // item; either signal is sufficient.
  $: _actionItemIsRecipe = !!(actionItem?.is_recipe
    || (Array.isArray(actionItem?.items) && actionItem.items.length > 0));

  function replaceItem(item) {
    // Store the item to replace, then navigate to food picker in pick mode
    const mealSlot = item.meal != null ? Number(item.meal) : 0;
    sessionStorage.setItem('nt:replaceItem', JSON.stringify({ index: item._i, meal: mealSlot }));
    push('/foods?pick=1&meal=' + mealSlot);
  }
  async function moveItemToMeal(e) {
    const mealIdx = e.detail?.value;
    if (!actionItem || mealIdx == null) return;
    await updateDiaryItem(actionItem._i, { meal: mealIdx });
    showMoveToMeal = false;
    showSuccess('Moved to ' + (meals[mealIdx] || 'meal'));
  }

  // ── Water ──────────────────────────────────────────────────────────────────
  let _waterGoalMl      = DB.getSetting('waterGoalMl',      2000);
  let _waterUnit        = DB.getSetting('waterUnit',        'ml');
  let _waterContainers  = DB.getSetting('waterContainers',  [
    { id: '1', name: 'Small Bottle',     volumeMl: 250  },
    { id: '2', name: 'Standard Bottle', volumeMl: 500  },
    { id: '3', name: 'Large Bottle',    volumeMl: 1000 },
    { id: '4', name: 'Gallon Jug',       volumeMl: 3785 },
  ]);
  let _waterShowInDiary = DB.getSetting('waterShowInDiary', true);

  // Water card state
  let _waterCustomAmt  = '';
  let _waterShowCustom = false;
  let _waterCustomInput;          // focus target when Custom panel opens
  function _toggleWaterCustom() {
    _waterShowCustom = !_waterShowCustom;
    if (_waterShowCustom) tick().then(() => _waterCustomInput?.focus());
  }
  let _waterEditIndex  = -1;   // which log row is being edited (-1 = none)
  let _waterEditAmt    = '';   // edit field value (in display unit)

  // SVG bottle fill geometry (fillable interior y=50→182, 132 units tall)
  const _WB_TOP = 50, _WB_BOTTOM = 182, _WB_H = 132;
  $: _waterFillY     = _WB_BOTTOM - (_waterPct / 100) * _WB_H;
  $: _waterOverflow  = _waterRawPct >= 100;

  function _reloadWaterSettings() {
    _waterGoalMl      = DB.getSetting('waterGoalMl',      2000);
    _waterUnit        = DB.getSetting('waterUnit',        'ml');
    _waterContainers  = DB.getSetting('waterContainers',  []);
    _waterShowInDiary = DB.getSetting('waterShowInDiary', true);
  }

  $: _waterLogs    = entry?.water || [];
  $: _waterTotal   = _waterLogs.reduce((s, l) => s + (l.amount || 0), 0);
  $: _waterRawPct  = _waterGoalMl > 0 ? Math.round(_waterTotal / _waterGoalMl * 100) : 0;
  $: _waterPct     = Math.min(100, _waterRawPct);

  function _waterDisplay(ml) {
    if (_waterUnit === 'oz') return (ml / 29.5735).toFixed(0)  + ' fl oz';
    if (_waterUnit === 'L')  return (ml / 1000).toFixed(2)     + ' L';
    if (_waterUnit === 'G')  return (ml / 3785.41).toFixed(3)  + ' G';
    return ml + ' ml';
  }
  function _waterDisplayGoal() {
    if (_waterUnit === 'oz') return Math.round(_waterGoalMl / 29.5735)    + ' fl oz';
    if (_waterUnit === 'L')  return (_waterGoalMl / 1000).toFixed(1)      + ' L';
    if (_waterUnit === 'G')  return (_waterGoalMl / 3785.41).toFixed(2)   + ' G';
    return _waterGoalMl + ' ml';
  }
  function _contDisplay(cont) {
    if (_waterUnit === 'oz') return (cont.volumeMl / 29.5735).toFixed(0) + ' fl oz';
    if (_waterUnit === 'L')  return (cont.volumeMl / 1000).toFixed(2)    + ' L';
    if (_waterUnit === 'G')  return (cont.volumeMl / 3785.41).toFixed(3) + ' G';
    return cont.volumeMl + ' ml';
  }

  // Custom water input — input value is in the user's chosen waterUnit
  // (fl oz / L / G / ml). Convert to ml before logging since storage is
  // always ml. Reported by cearum (#11) when in Imperial mode the input
  // was treated as ml regardless of the unit label.
  async function _addWaterCustom() {
    const raw = Number(_waterCustomAmt);
    if (!raw || raw <= 0) return;
    let ml = raw;
    if      (_waterUnit === 'oz') ml = raw * 29.5735;
    else if (_waterUnit === 'L')  ml = raw * 1000;
    else if (_waterUnit === 'G')  ml = raw * 3785.41;
    await _addWaterFromDiary(Math.round(ml));
    _waterCustomAmt = '';
  }

  async function _addWaterFromDiary(volumeMl) {
    const ml = Number(volumeMl);
    if (!ml || ml <= 0) return;
    let ent = null;
    currentEntry.subscribe(v => ent = v)();
    const _use24 = $timeFormat === '24h';
    const log = { amount: ml, time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !_use24 }) };
    const updated = { ...ent, water: [...(ent?.water || []), log] };
    await NtApi.saveDiaryDate($currentDate, {
      items: updated.items || [],
      body_stats: updated.bodyStats || {},
      water: updated.water,
    });
    await loadEntry($currentDate);
    _waterCustomAmt  = '';
    _waterShowCustom = false;
    // Check water + nutrition goals immediately
    const today = localDateStr();
    if ($currentDate === today) {
      try {
        const { checkGoals, requestPermission } = await import('../lib/notifications.js');
        await requestPermission(); // ensure we have permission
        const waterTotal = updated.water.reduce((s, l) => s + (l.amount || 0), 0);
        const waterGoal = DB.getSetting('waterGoalMl', 0);
        const goals = DB.getSetting('goals', {});
        if (waterGoal > 0) goals.water_ml = { min: waterGoal };
        const totals = Nutrition.sum((updated.items || []).map(i => Nutrition.calculate(i)));
        await checkGoals(goals, { ...totals, water_ml: waterTotal });
      } catch (e) {
        console.error('[diary] goal check error:', e);
      }
    }
  }

  async function _removeWaterLog(index) {
    let ent = null;
    currentEntry.subscribe(v => ent = v)();
    if (!ent) return;
    const water = (ent.water || []).filter((_, i) => i !== index);
    await NtApi.saveDiaryDate($currentDate, {
      items: ent.items || [],
      body_stats: ent.bodyStats || {},
      water,
    });
    await loadEntry($currentDate);
  }

  function _startWaterEdit(i) {
    const log = _waterLogs[i];
    // Convert stored ml back to display unit for the input
    if (_waterUnit === 'oz') _waterEditAmt = (log.amount / 29.5735).toFixed(0);
    else if (_waterUnit === 'L') _waterEditAmt = (log.amount / 1000).toFixed(2);
    else if (_waterUnit === 'G') _waterEditAmt = (log.amount / 3785.41).toFixed(3);
    else _waterEditAmt = String(log.amount);
    _waterEditIndex = i;
  }

  async function _saveWaterEdit(i) {
    const val = parseFloat(_waterEditAmt);
    if (!val || val <= 0) { _waterEditIndex = -1; return; }
    // Convert display unit back to ml
    let ml = val;
    if (_waterUnit === 'oz') ml = val * 29.5735;
    else if (_waterUnit === 'L') ml = val * 1000;
    else if (_waterUnit === 'G') ml = val * 3785.41;
    ml = Math.round(ml);
    let ent = null;
    currentEntry.subscribe(v => ent = v)();
    if (!ent) return;
    const water = (ent.water || []).map((l, idx) => idx === i ? { ...l, amount: ml } : l);
    await NtApi.saveDiaryDate($currentDate, {
      items: ent.items || [],
      body_stats: ent.bodyStats || {},
      water,
    });
    _waterEditIndex = -1;
    await loadEntry($currentDate);
  }

  // Whether this mount is a genuine first load (no cached entry yet) or a
  // re-mount triggered by App.svelte's {#key $location}. The fly-in
  // transitions on meal sections and diary items only fire when this is
  // true — otherwise every nav back to /diary plays a 300-600ms staggered
  // cascade that reads as "the page is refreshing" on slower WebViews.
  let _isInitialMount = false;
  onMount(async () => {
    const today = localDateStr();
    let storedDate;
    currentDate.subscribe(v => storedDate = v)();
    const targetDate = storedDate || today;
    // Skip the network round-trip when the store already holds this date —
    // App.svelte's {#key $location} unmounts + remounts Diary on every nav,
    // and refetching here causes a visible empty-then-populated flicker
    // every time you switch to /diary. The store retains data across the
    // remount; the reactive `$: entry = ...` shows it immediately. We still
    // call loadEntry when the date in the store doesn't match (first load,
    // or user picked a different day).
    let cur = null;
    currentEntry.subscribe(v => cur = v)();
    _isInitialMount = !cur;
    // Always re-fetch if the previous load errored (e.g. 401 before login)
    // — otherwise the "Could not reach server" banner can stick around even
    // after the user authenticates, because a synthetic empty entry from the
    // failed call would otherwise satisfy the date-match check below.
    let prevError = false;
    diaryLoadError.subscribe(v => prevError = v)();
    if (!cur || cur.date !== targetDate || prevError) {
      await loadEntry(targetDate);
    } else {
      // Make sure currentDate matches what's displayed (may be stale).
      currentDate.set(targetDate);
    }

    // Handle replace flow — food picker added the new item, now delete the old one
    const replaceData = sessionStorage.getItem('nt:replaceItem');
    if (replaceData) {
      sessionStorage.removeItem('nt:replaceItem');
      try {
        const { index } = JSON.parse(replaceData);
        const entry = $currentEntry;
        if (entry && entry.items && index < entry.items.length) {
          const updated = { ...entry, items: entry.items.filter((_, i) => i !== index) };
          await NtApi.saveDiaryDate($currentDate, {
            items: updated.items,
            body_stats: updated.bodyStats || updated.body_stats || {},
            water: updated.water || [],
          });
          await loadEntry($currentDate);
          showSuccess('Item replaced');
        }
      } catch (e) {
        console.warn('[diary] replace cleanup failed:', e.message);
      }
    }

    window.addEventListener('wl:setting', _reloadWaterSettings);
    // Trigger bar fill-in animation after first paint
    requestAnimationFrame(() => requestAnimationFrame(() => { _barsMounted = true; }));

    // Detect when user returns to the app on a new day (tab left open overnight)
    function _onVisibility() {
      if (document.visibilityState !== 'visible') return;
      const newToday = localDateStr();
      let stored = null;
      currentDate.subscribe(v => stored = v)();
      if (newToday !== stored) loadEntry(newToday);
    }
    document.addEventListener('visibilitychange', _onVisibility);

    // Native server mode: NtApiCached.getDiaryDate is local-first, so a
    // fresh post-connect mount can read empty SQLite before the background
    // sync finishes pulling diary entries down. Refresh after each
    // sync-complete event so the diary populates without requiring the
    // user to force-stop and reopen the app.
    let _onSyncComplete = null;
    if (isNative && getServerUrl()) {
      _onSyncComplete = () => {
        let cur = null;
        currentDate.subscribe(v => cur = v)();
        if (cur) loadEntry(cur);
      };
      window.addEventListener('nt:sync-complete', _onSyncComplete);
    }

    return () => {
      document.removeEventListener('visibilitychange', _onVisibility);
      window.removeEventListener('wl:setting', _reloadWaterSettings);
      if (_onSyncComplete) window.removeEventListener('nt:sync-complete', _onSyncComplete);
    };
  });
</script>

<div class="page-shell diary-page">
  <!-- Action icons — fixed at top-right, same level as hamburger -->
  <div use:portal class="diary-topbar-actions">
    {#if selectMode}
      <button class="btn-icon" on:click={exitSelectMode} aria-label={$_('diary.actions.cancel_selection')} title={$_('diary.actions.cancel_selection')}>
        <span class="material-symbols-rounded">close</span>
      </button>
      <button class="btn-icon" style="color:var(--danger)" disabled={selectedItems.size === 0}
        on:click={() => showMultiDeleteDialog = true} aria-label={$_('diary.actions.delete_selected')} title={$_('diary.actions.delete_selected')}>
        <span class="material-symbols-rounded">delete</span>
      </button>
    {:else}
      {#if _waterShowInDiary}
        <button class="btn-icon accent" on:click={() => showWaterQuickAdd = true} aria-label={$_('diary.actions.log_water')} title={$_('diary.actions.log_water_long')}>
          <span class="material-symbols-rounded">water_drop</span>
        </button>
      {/if}
      <button class="btn-icon accent" on:click={() => diaryShowNutritionSummary.set(true)} aria-label={$_('diary.actions.nutrition_summary')} title={$_('diary.actions.nutrition_summary_long')}>
        <span class="material-symbols-rounded">monitoring</span>
      </button>
      <button class="btn-icon accent" on:click={openBodyStats} aria-label={$_('diary.actions.body_stats')} title={$_('diary.actions.body_stats_long')}>
        <span class="material-symbols-rounded">scale</span>
      </button>
    {/if}
  </div>

  <!-- Standard page-header — identical to every other page -->
  <header class="page-header diary-header" class:banner-gradient={$bannerStyle === 'gradient' && !selectMode} class:banner-animated={$bannerStyle === 'animated' && !selectMode}>
    {#if selectMode}
      <h1 class="select-mode-title">{selectedItems.size} selected</h1>
    {:else}
      <h1>{$_('routes.diary.title')}</h1>
    {/if}
  </header>

  <!-- Date navigation — sticky sub-bar directly below the header -->
  <div class="diary-date-bar">
    <button class="btn-icon accent" on:click={prevDay} aria-label={$_('diary.nav.previous_day')} title={$_('diary.nav.previous_day')}>
      <span class="material-symbols-rounded">chevron_left</span>
    </button>
    <button class="date-btn" on:click={openDatePicker} title={$_('diary.nav.jump_to_date')}>
      <span class="date-label">
        {formatDate($currentDate)}
        {#if $diaryShowNotes && (entry?.notes || '').trim()}
          <span class="material-symbols-rounded date-note-indicator" title="Has notes">edit_note</span>
        {/if}
      </span>
      <span class="date-sub">{formatDateSub($currentDate, $dateFormat)}</span>
    </button>
    <button class="btn-icon accent" on:click={nextDay} aria-label={$_('diary.nav.next_day')} title={$_('diary.nav.next_day')}>
      <span class="material-symbols-rounded">chevron_right</span>
    </button>
  </div>

  <div class="page-content diary-content" style="padding-bottom:{contentPad}">
{#if $diaryLoadError}
      <div class="server-error-banner">
        <span class="material-symbols-rounded">cloud_off</span>
        <span>Could not reach server — <button class="server-error-retry" on:click={() => loadEntry($currentDate)}>Retry</button></span>
      </div>
    {/if}
    <!-- Intermittent fasting widget — opt-in via Settings → Diary -->
    {#if $fastingEnabled}
      <FastingWidget />
    {/if}
    <!-- Meal groups -->
    {#each meals as meal, mealIdx}
      {@const items = getMealItems(entry.items, mealIdx)}
      <section class="meal-group card" id="meal-{mealIdx}" in:fly={{ y: 18, duration: _isInitialMount && !$disableAnimations ? 280 : 0, delay: _isInitialMount && !$disableAnimations ? 60 + mealIdx * 55 : 0 }}>
        <div class="meal-header" style="--meal-color:{mealColor(mealIdx)}">
          <span class="meal-type-icon material-symbols-rounded">{mealIcon(meal)}</span>
          <span class="meal-name">{meal}</span>
          {#if items.length > 0 && !$diaryShowMacroSummary}
            {@const _mealKcal = items.reduce((s,it) => s + formatKcal(it), 0)}
            {@const _mealEnergy = Nutrition.displayEnergy(_mealKcal, $energyUnit)}
            <span class="meal-kcal text-3 text-sm">
              {_mealEnergy.value.toLocaleString()} {_mealEnergy.unit}
            </span>
          {/if}
          <button class="btn-icon ml-auto meal-menu-btn" on:click={() => openMealActionSheet(mealIdx)} aria-label="Meal actions for {meal}" title="Meal actions">
            <span class="material-symbols-rounded">more_vert</span>
          </button>
          {#if $showQuickCalories}
            <button class="btn-icon meal-quick-btn" on:click={() => openQuickCalories(mealIdx)} aria-label="Quick calories for {meal}" title="Quick Calories">
              <span class="material-symbols-rounded">bolt</span>
            </button>
          {/if}
          <button class="btn-icon accent" on:click={() => openAddFood(mealIdx)} aria-label="Add food to {meal}" title="Add food to {meal}">
            <span class="material-symbols-rounded">add</span>
          </button>
        </div>

        {#if items.length === 0}
          <button type="button" class="meal-empty" on:click={() => openAddFood(mealIdx)} aria-label="Add food to {meal}">
            <span class="material-symbols-rounded meal-empty-icon" style="color:{mealColor(mealIdx)}">add_circle</span>
            <span class="meal-empty-text">Tap to add food</span>
          </button>
        {:else}
          {@const _foodItems  = items.filter(it => it.type !== 'quick_calories')}
          {@const _quickItems = items.filter(it => it.type === 'quick_calories')}
          {@const _quickTotalKcal = _quickItems.reduce((s, it) => s + (it.nutrition?.calories || 0), 0)}
          {@const _quickTotalEnergy = Nutrition.displayEnergy(_quickTotalKcal, $energyUnit)}
          <div class="meal-items">
            {#each _foodItems as item (item._i)}
              {@const _itemEnergy = Nutrition.displayEnergy(formatKcal(item), $energyUnit)}
              <div class="diary-item" in:fly={{ y: 6, duration: _isInitialMount && !$disableAnimations ? 180 : 0 }}
                class:item-selected={selectMode && selectedItems.has(item._i)}
                on:touchstart|passive={e => onItemTouchStart(e, item)}
                on:touchmove|passive={onItemTouchMove}
                on:touchend={onItemTouchEnd}
                on:contextmenu|preventDefault={() => { if (!selectMode) { actionItem = item; _lockAndOpen(() => showItemAction = true); } }}>
                {#if selectMode}
                  <button class="item-select-btn" on:click={() => toggleItemSelect(item)} aria-label="Toggle selection">
                    <span class="item-check material-symbols-rounded" class:item-check-on={selectedItems.has(item._i)}>
                      {selectedItems.has(item._i) ? 'check_circle' : 'radio_button_unchecked'}
                    </span>
                  </button>
                {/if}
                <button class="diary-item-btn" on:click={() => selectMode ? toggleItemSelect(item) : openEditItem(item)}>
                  {#if $diaryShowThumbnails && item.imgUrl}
                    <img class="item-thumb" src={resolveAssetUrl(item.imgUrl)} alt="" loading="lazy" />
                  {:else if $diaryShowThumbnails}
                    <div class="item-thumb-placeholder">
                      <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent)">restaurant</span>
                    </div>
                  {/if}
                  <div class="item-info">
                    <span class="item-name truncate">{item.name}</span>
                    <span class="item-meta text-3 text-sm">
                      {Math.round((item.portion || item.amount || 100) * (item.quantity || 1) * 10) / 10}{item.unit || 'g'}{#if $diaryShowPortionSize && Math.abs((item.quantity || 1) - 1) > 0.001} ({item.quantity || 1} × {item.portion || item.amount || 100}{item.unit || 'g'}){/if}
                      {#if $diaryShowBrands && item.brand} · {item.brand}{/if}
                      · {_itemEnergy.value.toLocaleString()} {_itemEnergy.unit}
                      {#if $diaryShowTimestamps && item.addedAt}
                        · {formatTime(item.addedAt)}
                      {/if}
                    </span>
                  </div>
                </button>
                {#if Array.isArray(item._splitItems) && item._splitItems.length > 0}
                  <button type="button" class="split-toggle" on:click|stopPropagation={() => toggleSplitExpand(item._i)}
                    aria-label={_splitExpanded.has(item._i) ? 'Collapse ingredients' : 'Expand ingredients'}
                    title={_splitExpanded.has(item._i) ? 'Collapse ingredients' : 'Expand ingredients'}>
                    <span class="material-symbols-rounded split-chevron" class:split-chevron-open={_splitExpanded.has(item._i)}>expand_more</span>
                  </button>
                {/if}
              </div>
              {#if Array.isArray(item._splitItems) && item._splitItems.length > 0 && _splitExpanded.has(item._i)}
                <div class="split-children">
                  {#each item._splitItems as child, ci (child.addedAt + '-' + ci + '-' + (child.name || ''))}
                    {@const _ce = Nutrition.displayEnergy((Nutrition.calculate(child).calories || 0), $energyUnit)}
                    <div class="split-child">
                      <button type="button" class="split-child-btn" on:click={() => openEditChild(item._i, ci, child)}
                        aria-label="Edit {child.name}" title="Edit serving size">
                        <span class="split-child-name truncate">{child.name}</span>
                        <span class="split-child-meta text-3 text-sm">
                          {Math.round((child.portion || 100) * (child.quantity || 1) * 10) / 10}{child.unit || 'g'} · {_ce.value.toLocaleString()} {_ce.unit}
                        </span>
                      </button>
                      <button type="button" class="btn-icon split-child-del" on:click|stopPropagation={() => onRemoveSplitChild(item._i, ci)}
                        aria-label="Remove ingredient" title="Remove ingredient">
                        <span class="material-symbols-rounded" style="font-size:16px">close</span>
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            {/each}

            <!-- Quick Calories rows. Rendered separately so the display mode
                 (summed vs separate, per Settings → Diary) can collapse them
                 without affecting the food-item loop above. Issue #42. -->
            {#if _quickItems.length > 0}
              {#if $quickCaloriesDisplay === 'separate'}
                {#each _quickItems as qItem (qItem._i)}
                  {@const _qE = Nutrition.displayEnergy(qItem.nutrition?.calories || 0, $energyUnit)}
                  <div class="diary-item quick-cal-item" in:fly={{ y: 6, duration: _isInitialMount && !$disableAnimations ? 180 : 0 }}
                    class:item-selected={selectMode && selectedItems.has(qItem._i)}
                    on:contextmenu|preventDefault={() => { if (!selectMode) { actionItem = qItem; _lockAndOpen(() => showItemAction = true); } }}>
                    {#if selectMode}
                      <button class="item-select-btn" on:click={() => toggleItemSelect(qItem)} aria-label="Toggle selection">
                        <span class="item-check material-symbols-rounded" class:item-check-on={selectedItems.has(qItem._i)}>
                          {selectedItems.has(qItem._i) ? 'check_circle' : 'radio_button_unchecked'}
                        </span>
                      </button>
                    {/if}
                    <button class="diary-item-btn" on:click={() => selectMode ? toggleItemSelect(qItem) : openEditItem(qItem)}>
                      {#if $diaryShowThumbnails}
                        <div class="item-thumb-placeholder">
                          <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent)">bolt</span>
                        </div>
                      {/if}
                      <div class="item-info">
                        <span class="item-name truncate">{qItem.name || 'Quick Calories'}</span>
                        <span class="item-meta text-3 text-sm">
                          {_qE.value.toLocaleString()} {_qE.unit}
                          {#if $diaryShowTimestamps && qItem.addedAt} · {formatTime(qItem.addedAt)}{/if}
                        </span>
                      </div>
                    </button>
                  </div>
                {/each}
              {:else}
                <!-- Summed mode: one collapsed row with the total + chevron
                     to expand into the individual entries that built the
                     sum. Same pattern as split-recipe ingredients above.
                     Tapping a child row opens the standard item editor for
                     that specific entry; right-click / long-press surfaces
                     the per-item action sheet. (Issue #42 follow-up.) -->
                {@const _expanded = _quickCalExpanded.has(mealIdx)}
                {@const _single = _quickItems.length === 1}
                <div class="diary-item quick-cal-item quick-cal-summed"
                  on:contextmenu|preventDefault={() => { if (!selectMode && _single) { actionItem = _quickItems[0]; _lockAndOpen(() => showItemAction = true); } }}>
                  <button class="diary-item-btn"
                    on:click={() => _single ? openEditItem(_quickItems[0]) : toggleQuickCalExpand(mealIdx)}
                    aria-label={_single ? 'Edit Quick Calories entry' : (_expanded ? 'Collapse Quick Calorie entries' : 'Expand Quick Calorie entries')}>
                    {#if $diaryShowThumbnails}
                      <div class="item-thumb-placeholder">
                        <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent)">bolt</span>
                      </div>
                    {/if}
                    <div class="item-info">
                      <span class="item-name truncate">
                        {#if _single}{_quickItems[0]?.name || 'Quick Calories'}{:else}Quick Calories × {_quickItems.length}{/if}
                      </span>
                      <span class="item-meta text-3 text-sm">
                        {_quickTotalEnergy.value.toLocaleString()} {_quickTotalEnergy.unit}
                        {#if _quickItems.length > 1} · tap to {_expanded ? 'collapse' : 'expand'}{/if}
                      </span>
                    </div>
                  </button>
                  {#if _quickItems.length > 1}
                    <button type="button" class="split-toggle" on:click|stopPropagation={() => toggleQuickCalExpand(mealIdx)}
                      aria-label={_expanded ? 'Collapse Quick Calorie entries' : 'Expand Quick Calorie entries'}
                      title={_expanded ? 'Collapse Quick Calorie entries' : 'Expand Quick Calorie entries'}>
                      <span class="material-symbols-rounded split-chevron" class:split-chevron-open={_expanded}>expand_more</span>
                    </button>
                  {/if}
                </div>
                {#if _expanded && _quickItems.length > 0}
                  <div class="split-children">
                    {#each _quickItems as qItem (qItem._i)}
                      {@const _qcE = Nutrition.displayEnergy(qItem.nutrition?.calories || 0, $energyUnit)}
                      <div class="split-child">
                        <button type="button" class="split-child-btn" on:click={() => openEditItem(qItem)}
                          on:contextmenu|preventDefault={() => { if (!selectMode) { actionItem = qItem; _lockAndOpen(() => showItemAction = true); } }}
                          aria-label="Edit {qItem.name || 'Quick Calories'}" title="Edit entry">
                          <span class="split-child-name truncate">{qItem.name || 'Quick Calories'}</span>
                          <span class="split-child-meta text-3 text-sm">
                            {_qcE.value.toLocaleString()} {_qcE.unit}
                            {#if $diaryShowTimestamps && qItem.addedAt} · {formatTime(qItem.addedAt)}{/if}
                          </span>
                        </button>
                        <button type="button" class="btn-icon split-child-del" on:click|stopPropagation={() => removeDiaryItem(qItem._i)}
                          aria-label="Remove Quick Calories entry" title="Remove entry">
                          <span class="material-symbols-rounded" style="font-size:16px">close</span>
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}
            {/if}
          </div>
        {/if}
        {#if items.length > 0}
          <button class="meal-add-row" on:click={() => openAddFood(mealIdx)}>
            <span class="material-symbols-rounded">add</span>
            <span>{$_('diary.add_food')}</span>
          </button>
        {/if}
        {#if $diaryShowMacroSummary && items.length > 0}
          {@const mt = getMealTotals(items)}
          {#if mt}
            {@const _mtEnergy = Nutrition.displayEnergy(mt.cal, $energyUnit)}
            <button type="button" class="meal-macro-footer" on:click={() => mealTotalsIdx = mealIdx}
              aria-label="Show {meal} nutrition totals" title="Show nutrition totals">
              <div class="meal-macro-bar">
                <div class="mmb-p" style="width:{mt.p}%" title="Protein {mt.p}%"></div>
                <div class="mmb-c" style="width:{mt.c}%" title="Carbs {mt.c}%"></div>
                <div class="mmb-f" style="width:{mt.f}%" title="Fat {mt.f}%"></div>
              </div>
              <span class="meal-macro-text text-3 text-sm"><span style="color:var(--macro-protein)">{mt.p}% P</span> · <span style="color:var(--macro-carbs)">{mt.c}% C</span> · <span style="color:var(--macro-fat)">{mt.f}% F</span> · <span style="color:var(--macro-calories)">{_mtEnergy.value.toLocaleString()} {_mtEnergy.unit}</span></span>
            </button>
          {/if}
        {/if}
      </section>
    {/each}

    {#if $diaryShowActivity}
      {@const acts = $dayActivity || []}
      {@const sum  = $activitySummary || { manual: 0, wearable: 0, effective: 0, policy: 'wearable_wins' }}
      {@const policy = $manualActivityPolicy || 'wearable_wins'}
      {@const wearablePresent = (sum.wearable || 0) > 0}
      {@const manualCounted   = !wearablePresent || policy !== 'wearable_wins'}
      {@const totalActKcal = acts.reduce((s, a) => s + (a.kcal || 0), 0)}
      <section class="meal-group card activity-group" id="activity-group" in:fly={{ y: 18, duration: _isInitialMount && !$disableAnimations ? 280 : 0, delay: _isInitialMount && !$disableAnimations ? 60 + meals.length * 55 : 0 }}>
        <div class="meal-header" style="--meal-color:#4FFFB0">
          <span class="meal-type-icon material-symbols-rounded">directions_run</span>
          <div class="activity-name-stack">
            <span class="meal-name">{$_('diary.activity.section')}</span>
            {#if $wellnessEnabled}
              <span class="activity-sub text-3 text-sm">{$_('diary.activity.wellness_hint')}</span>
            {/if}
          </div>
          <button class="btn-icon accent ml-auto" on:click={() => { editingActivity = null; showActivitySheet = true; }} aria-label={$_('diary.activity.add')} title={$_('diary.activity.add')}>
            <span class="material-symbols-rounded">add</span>
          </button>
        </div>

        {#if acts.length === 0}
          <button type="button" class="meal-empty" on:click={() => { editingActivity = null; showActivitySheet = true; }} aria-label={$_('diary.activity.add')}>
            <span class="material-symbols-rounded meal-empty-icon" style="color:#4FFFB0">add_circle</span>
            <span class="meal-empty-text">{$_('diary.activity.tap_to_add')}</span>
          </button>
        {:else}
          <div class="meal-items">
            {#each acts as a (a.id)}
              {@const _aEnergy = Nutrition.displayEnergy(a.kcal || 0, $energyUnit)}
              <div class="diary-item" in:fly={{ y: 6, duration: _isInitialMount && !$disableAnimations ? 180 : 0 }}
                on:contextmenu|preventDefault={() => openActivityActionSheet(a)}>
                <button class="diary-item-btn" on:click={() => { editingActivity = a; showActivitySheet = true; }}>
                  <div class="item-info">
                    <span class="item-name truncate">{a.name}</span>
                    <span class="item-meta text-3 text-sm">
                      {#if a.duration_min}{a.duration_min} min{/if}{#if a.duration_min && a.distance} | {/if}{#if a.distance}{@const _dStr = String(a.distance).trim()}{_dStr}{#if /^\d+(\.\d+)?$/.test(_dStr)} {$distUnit || 'mi'}{/if}{/if}{#if (a.duration_min || a.distance)} | {/if}<span style="color:#4FFFB0">−{_aEnergy.value.toLocaleString()} {_aEnergy.unit}</span>{#if a.source === 'ai_estimated'} | <span class="text-3" title="Estimated by Trace">{$_('diary.activity.estimated_short')}</span>{/if}
                    </span>
                  </div>
                </button>
              </div>
            {/each}
          </div>
          <button class="meal-add-row" on:click={() => { editingActivity = null; showActivitySheet = true; }}>
            <span class="material-symbols-rounded">add</span>
            <span>{$_('diary.activity.add')}</span>
          </button>
          {@const _totActEnergy = Nutrition.displayEnergy(totalActKcal, $energyUnit)}
          <div class="meal-macro-footer activity-footer" aria-label={$_('diary.activity.section')}>
            <div class="meal-macro-bar">
              {#each acts as a (a.id)}
                {@const _aE = Nutrition.displayEnergy(a.kcal || 0, $energyUnit)}
                <div class="amb-seg" style="width:{totalActKcal ? (a.kcal / totalActKcal * 100) : 0}%" title={`${a.name} — ${_aE.value} ${_aE.unit}`}></div>
              {/each}
            </div>
            <span class="meal-macro-text text-3 text-sm">
              <span style="color:#4FFFB0">−{_totActEnergy.value.toLocaleString()} {_totActEnergy.unit}</span>
              {#if wearablePresent && !manualCounted}
                · <span title={$_('diary.activity.policy_chip')}>{$_('diary.activity.not_counted')}</span>
              {/if}
            </span>
          </div>
        {/if}
      </section>
    {/if}

    {#if $diaryShowNotes}
      <section class="diary-notes card" class:expanded={notesExpanded || _notesText}>
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div class="diary-notes-header" on:click={toggleNotes}>
          <span class="material-symbols-rounded diary-notes-icon">edit_note</span>
          <span class="diary-notes-label">Day Notes</span>
          {#if _notesText && !notesExpanded}
            <span class="diary-notes-preview text-3 text-sm truncate">{_notesText}</span>
          {/if}
          <span class="material-symbols-rounded diary-notes-chevron">{notesExpanded ? 'expand_less' : 'expand_more'}</span>
        </div>
        {#if notesExpanded}
          <div class="diary-notes-body">
            <textarea class="diary-notes-textarea" bind:value={_notesText}
              on:blur={commitNotes}
              placeholder={$_('diary.notes_placeholder')}
              rows="3"></textarea>
            <div class="diary-notes-meta">
              <span class="text-3 text-sm">{_notesSaving ? 'Saving…' : (_notesText ? `${_notesText.length} characters` : '')}</span>
            </div>
          </div>
        {/if}
      </section>
    {/if}

  </div>
</div>

<!-- Persistent bottom nutrition bar -->
<div use:portal class="diary-bottom-bar" style="bottom:{barBottom}">
  <!-- Calorie progress strip -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="dbb-progress" on:click={() => barExpanded = !barExpanded}
    title="Calories: {Math.round(calPct)}%">
    <div class="dbb-progress-fill"
      class:celebrating={_calGoalCelebrating}
      style="width:{_barsMounted ? calPct : 0}%;{calPct >= 100 ? 'background:var(--danger)' : ''}"></div>
  </div>
  <!-- Macro proportion bar — outside button so title tooltips work on hover -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="dbb-macro-bar" on:click={() => barExpanded = !barExpanded}>
    <div class="dbb-mb-p" style="width:{_barsMounted ? _mp.protein : 0}%" title="Protein {_mp.protein}%"></div>
    <div class="dbb-mb-c" style="width:{_barsMounted ? _mp.carbs : 0}%"   title="Carbs {_mp.carbs}%"></div>
    <div class="dbb-mb-f" style="width:{_barsMounted ? _mp.fat : 0}%"     title="Fat {_mp.fat}%"></div>
  </div>
  <!-- Water progress strip (collapsed, always visible) -->
  {#if _waterShowInDiary}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="dbb-water-strip" on:click={() => barExpanded = !barExpanded}
      title="Water: {_waterPct}%">
      <div class="dbb-water-strip-fill"
        class:celebrating={_waterGoalCelebrating}
        style="width:{_barsMounted ? _waterPct : 0}%"></div>
    </div>
  {/if}

  <!-- Text summary row — taps to expand/collapse -->
  <button class="dbb-summary-row" on:click={() => barExpanded = !barExpanded}
    aria-label="{barExpanded ? 'Collapse' : 'Expand'} nutrition panel">
    <span class="dbb-summary-text"><span style="color:var(--macro-protein)">{_mp.protein}% P</span> · <span style="color:var(--macro-carbs)">{_mp.carbs}% C</span> · <span style="color:var(--macro-fat)">{_mp.fat}% F</span> · <span style="color:var(--macro-calories)">{_sumEnergy.value.toLocaleString()} {_sumEnergy.unit}</span>{#if _waterShowInDiary} · <span style="color:var(--water-blue)"><span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">water_drop</span> {_waterDisplay(_waterTotal)}</span>{/if}</span>
    <span class="dbb-chevron material-symbols-rounded">{barExpanded ? 'expand_more' : 'expand_less'}</span>
  </button>

  <!-- Expanded detail panel -->
  {#if barExpanded}
    <div class="dbb-panel" transition:slide={{ duration: 220 }}>
      <!-- Consumed / Remaining toggle -->
      <div class="dbb-toggle-row">
        <button class="dbb-toggle-pill" on:click|stopPropagation={toggleTotalsMode}
          aria-label="Toggle consumed/remaining">
          <span class="dbb-tp-opt" class:dbb-tp-active={_totalsMode === 'consumed'}>Consumed</span>
          <span class="dbb-tp-opt" class:dbb-tp-active={_totalsMode === 'remaining'}>Remaining</span>
        </button>
      </div>
      <!-- Mode-aware calorie + macro row -->
      <div class="dbb-detail-row">
        <div class="dbb-kcal">
          {#if _totalsMode === 'remaining'}
            {@const _remEnergy = Nutrition.displayEnergy(caloriesGoalAdjusted - Math.round($_calTween), $energyUnit)}
            <span class="dbb-num">{_remEnergy.value.toLocaleString()}</span>
            <span class="dbb-unit">{#if $calorieGoalMode === 'dynamic' && _dynamicCaloriesOut != null}⚡ {:else if $calorieGoalMode === 'adaptive' && _adaptiveTdee != null}📈 {/if}{#if _effectiveActive > 0}<span class="material-symbols-rounded dbb-activity-cue" title="Adjusted for activity">directions_run</span> {/if}{_remEnergy.unit} left</span>
          {:else}
            {@const _eatEnergy = Nutrition.displayEnergy($_calTween, $energyUnit)}
            <span class="dbb-num">{_eatEnergy.value.toLocaleString()}</span>
            <span class="dbb-unit">{#if $calorieGoalMode === 'dynamic' && _dynamicCaloriesOut != null}⚡ {:else if $calorieGoalMode === 'adaptive' && _adaptiveTdee != null}📈 {/if}{_eatEnergy.unit} eaten</span>
          {/if}
        </div>
        <div class="dbb-macros">
          <span class="dbb-macro" style="color:var(--macro-protein)">
            {#if _totalsMode === 'remaining' && protGoal != null}{Math.round((protGoal - $_protTween)*10)/10}{:else}{Math.round($_protTween*10)/10}{/if}
            <span class="dbb-mlabel">g Protein</span>
          </span>
          <span class="dbb-macro" style="color:var(--macro-carbs)">
            {#if _totalsMode === 'remaining' && carbGoal != null}{Math.round((carbGoal - $_carbTween)*10)/10}{:else}{Math.round($_carbTween*10)/10}{/if}
            <span class="dbb-mlabel">g Carbs</span>
          </span>
          <span class="dbb-macro" style="color:var(--macro-fat)">
            {#if _totalsMode === 'remaining' && fatGoal != null}{Math.round((fatGoal - $_fatTween)*10)/10}{:else}{Math.round($_fatTween*10)/10}{/if}
            <span class="dbb-mlabel">g Fat</span>
          </span>
        </div>
      </div>
      {#if _effectiveActive > 0 && _totalsMode === 'remaining'}
        {@const _gE = Nutrition.displayEnergy(caloriesGoal, $energyUnit)}
        {@const _aE = Nutrition.displayEnergy(_effectiveActive, $energyUnit)}
        {@const _adjE = Nutrition.displayEnergy(caloriesGoalAdjusted, $energyUnit)}
        <div class="dbb-activity-breakdown text-3 text-sm">
          Goal {_gE.value.toLocaleString()} <span style="color:#4FFFB0">+ Activity {_aE.value.toLocaleString()}</span> = {_adjE.value.toLocaleString()} {_adjE.unit}
        </div>
      {/if}
      <!-- Water row -->
      {#if _waterShowInDiary}
        <div class="dbb-water-row">
          <span class="material-symbols-rounded dbb-water-icon">water_drop</span>
          <div class="dbb-water-track">
            <div class="dbb-water-bar">
              <div class="dbb-water-fill" style="width:{_waterPct}%"></div>
            </div>
            <span class="dbb-water-text">
              {#if _totalsMode === 'remaining'}
                {_waterDisplay(Math.max(0, _waterGoalMl - _waterTotal))} left
              {:else}
                {_waterDisplay(_waterTotal)}
              {/if}
              / {_waterDisplay(_waterGoalMl)}
            </span>
          </div>
          <span class="dbb-water-pct">{_totalsMode === 'remaining' ? Math.max(0, 100 - _waterPct) + '%' : _waterPct + '%'}</span>
        </div>
      {/if}

      <!-- Nutrient bars -->
      {#if $diaryShowNutritionBar && nutritionBarItems.length > 0}
        <div class="dbb-nutrient-bars">
          {#each nutritionBarItems as nb}
            <div class="nb-row">
              <span class="nb-label">{nb.label}</span>
              <div class="nb-bar"><div class="nb-fill" class:over={nb.over} style="width:{nb.pct}%;{nb.over ? '' : 'background:' + nutrientBarColor(nb.id)}"></div></div>
              <span class="nb-val" class:over={nb.over}>
                {#if _totalsMode === 'remaining' && nb.tgt}
                  {Math.round((nb.tgt - nb.cur)*10)/10}{#if $diaryShowNutritionUnits} {nb.unit}{/if}
                {:else}
                  {Math.round(nb.cur*10)/10}{#if $diaryShowNutritionUnits} {nb.unit}{/if}
                {/if}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- Water card sheet -->
<Sheet bind:open={showWaterQuickAdd} title="" overlayClose on:close={() => { showWaterQuickAdd = false; _waterShowCustom = false; _waterCustomAmt = ''; }}>
  <div class="wc-body">

    <!-- Banner strip with title overlaid at bottom-left. Sheet renders its
         own floating close button (overlayClose) so the X stays pinned even
         when the user scrolls through the day's water log. -->
    <div class="wc-banner-strip">
      <WaterBanner />
      <h2 class="wc-banner-title">Water</h2>
    </div>

    <div class="wc-inner">
    <!-- Bottle + stats -->
    <div class="wc-bottle-section">
      <div class="wc-bottle-wrap" class:wc-overflowing={_waterOverflow}>
        <svg class="wc-bottle-svg" class:wc-overflowing={_waterOverflow}
          viewBox="0 0 120 200" xmlns="http://www.w3.org/2000/svg"
          aria-label="Water bottle, {_waterRawPct}% full">
          <defs>
            <clipPath id="wc-clip-d">
              <path d="M 46 16 L 46 38 C 32 44 22 56 22 68 L 22 168 Q 22 184 37 184 L 83 184 Q 98 184 98 168 L 98 68 C 98 56 88 44 74 38 L 74 16 Z" />
            </clipPath>
          </defs>
          <!-- Bottle body background -->
          <path d="M 46 16 L 46 38 C 32 44 22 56 22 68 L 22 168 Q 22 184 37 184 L 83 184 Q 98 184 98 168 L 98 68 C 98 56 88 44 74 38 L 74 16 Z" class="wc-bottle-bg" />
          <!-- Water fill -->
          {#if _waterPct > 0}
            <g clip-path="url(#wc-clip-d)">
              <rect x="-5" y={_waterFillY + 10} width="130" height={_WB_BOTTOM - _waterFillY + 10} class="wc-water-body" />
              <g transform="translate(0, {_waterFillY})">
                <path class="wc-water-wave" d="M -120,10 C -90,2 -60,18 -30,10 C 0,2 30,18 60,10 C 90,2 120,18 150,10 C 180,2 210,18 240,10 L 240,30 L -120,30 Z" />
              </g>
            </g>
          {/if}
          <!-- Bottle outline -->
          <path d="M 46 16 L 46 38 C 32 44 22 56 22 68 L 22 168 Q 22 184 37 184 L 83 184 Q 98 184 98 168 L 98 68 C 98 56 88 44 74 38 L 74 16 Z"
            class="wc-bottle-outline" class:wc-full={_waterPct >= 100} />
          <rect x="44" y="2" width="32" height="16" rx="5" class="wc-bottle-cap" />
          <line x1="44" y1="16" x2="76" y2="16" class="wc-cap-line" />
          {#if _waterOverflow}
            <ellipse class="wc-overflow-spill" cx="60" cy="5" rx="19" ry="4" />
            <circle class="wc-overflow-drip wc-drip-1" cx="43" cy="14" r="3" />
            <circle class="wc-overflow-drip wc-drip-2" cx="42" cy="13" r="2.5" />
            <circle class="wc-overflow-drip wc-drip-3" cx="77" cy="14" r="3" />
            <circle class="wc-overflow-drip wc-drip-4" cx="78" cy="13" r="2.5" />
          {/if}
        </svg>
      </div>

      <div class="wc-stats">
        <div class="wc-amount">
          <span class="wc-current">{_waterDisplay(_waterTotal)}</span>
          <span class="wc-sep">/</span>
          <span class="wc-goal">{_waterDisplayGoal()}</span>
        </div>
        <div class="wc-pct" class:wc-goal-met={_waterOverflow}>
          {_waterRawPct}%{_waterOverflow ? ' 🎉' : ''}
        </div>
        <div class="wc-progress-bar">
          <div class="wc-progress-fill" style="width:{_waterPct}%"></div>
        </div>
      </div>
    </div>

    <!-- Quick-add grid -->
    <p class="section-title" style="padding:4px 0 8px;text-align:center">Quick Add</p>
    <div class="wc-grid">
      {#if _waterContainers.length > 0}
        {#each _waterContainers as cont (cont.id)}
          <button class="wc-btn" on:click={() => _addWaterFromDiary(cont.volumeMl)}>
            <span class="material-symbols-rounded">water_drop</span>
            <span class="wc-btn-name">{cont.name}</span>
            <span class="wc-btn-vol">{_contDisplay(cont)}</span>
          </button>
        {/each}
      {:else}
        {#each [250, 500, 1000] as ml}
          <button class="wc-btn" on:click={() => _addWaterFromDiary(ml)}>
            <span class="material-symbols-rounded">water_drop</span>
            <span class="wc-btn-vol">{_waterDisplay(ml)}</span>
          </button>
        {/each}
      {/if}
      <button class="wc-btn wc-btn-custom" on:click={_toggleWaterCustom}>
        <span class="material-symbols-rounded">edit</span>
        <span class="wc-btn-name">Custom</span>
      </button>
    </div>

    {#if _waterShowCustom}
      <div class="wc-custom-row" transition:slide={{ duration: 160 }}>
        <input class="input" type="number" min="0" step={_waterUnit === 'ml' ? '1' : '0.01'}
          placeholder={`Amount (${_waterUnit === 'oz' ? 'fl oz' : _waterUnit})`}
          bind:value={_waterCustomAmt} bind:this={_waterCustomInput}
          on:keydown={e => e.key === 'Enter' && _addWaterCustom()} />
        <button class="btn btn-primary" on:click={_addWaterCustom}>Add</button>
      </div>
    {/if}

    <!-- Today's log -->
    {#if _waterLogs.length > 0}
      <p class="section-title" style="padding:12px 0 8px">Today's Log</p>
      <div class="card wc-log-card">
        {#each _waterLogs as log, i}
          {#if i > 0}<div class="wc-divider"></div>{/if}
          {#if _waterEditIndex === i}
            <div class="wc-log-row wc-log-edit">
              <span class="material-symbols-rounded wc-log-icon">edit</span>
              <input
                class="input wc-edit-input"
                type="number"
                min="1"
                bind:value={_waterEditAmt}
                on:keydown={e => { if (e.key === 'Enter') _saveWaterEdit(i); if (e.key === 'Escape') _waterEditIndex = -1; }}
                autofocus />
              <span class="text-3 text-sm">{_waterUnit}</span>
              <button class="btn-icon" on:click={() => _saveWaterEdit(i)} title="Save">
                <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent)">check</span>
              </button>
              <button class="btn-icon" on:click={() => _waterEditIndex = -1} title="Cancel">
                <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3)">close</span>
              </button>
            </div>
          {:else}
            <div class="wc-log-row" role="button" tabindex="0"
              on:click={() => _startWaterEdit(i)}
              on:keydown={e => e.key === 'Enter' && _startWaterEdit(i)}
              title="Tap to edit">
              <span class="material-symbols-rounded wc-log-icon">water_drop</span>
              <div class="wc-log-info">
                <span class="font-medium">{_waterDisplay(log.amount)}</span>
                {#if log.time}<span class="text-3 text-sm">{log.time}</span>{/if}
              </div>
              <button class="btn-icon" on:click|stopPropagation={() => _removeWaterLog(i)} title="Remove">
                <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3)">delete</span>
              </button>
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      <div class="wc-empty-log">
        <span class="material-symbols-rounded wc-empty-icon">water_drop</span>
        <p class="text-3 text-sm">No water logged yet today</p>
      </div>
    {/if}

    <div style="height:16px"></div>
    </div><!-- /.wc-inner -->
  </div>
</Sheet>

<!-- Edit item sheet -->
<Sheet bind:open={showEditSheet} title={editItem ? editItem.name : ''} on:close={() => showEditSheet = false}>
  {#if editItem}
    <div class="edit-sheet-body">
      {#if editItem.type === 'quick_calories'}
        <!-- Quick Calories edit — mirrors the create sheet (kcal pill + 3-up
             macros + optional name). No Serving Size / Unit / Number of
             Servings because the entry has no portion concept. -->
        {@const _qcUnit = $energyUnit === 'kJ' ? 'kJ' : 'kcal'}
        <label class="form-label" for="qce-name">Name (optional)</label>
        <input id="qce-name" class="input" type="text" maxlength="60"
               placeholder="Office snack, hotel breakfast..."
               bind:value={editName} />
        <div class="qce-kcal-pill" style="background:var(--macro-calories-dim);margin-top:12px">
          <input class="qce-kcal-input" type="number" inputmode="numeric"
                 min="1" step="1"
                 style="color:var(--macro-calories)"
                 bind:value={editKcalDisplay} />
          <span class="qce-kcal-unit" style="color:var(--macro-calories)">{_qcUnit.toUpperCase()}</span>
        </div>
        <p class="qce-section-label">Optional Macros</p>
        <div class="qce-macros">
          <div class="qce-macro-pill" style="background:var(--macro-protein-dim)">
            <div class="qce-macro-val-row">
              <input class="qce-macro-input" type="number" inputmode="decimal"
                     min="0" step="0.1" placeholder="0"
                     style="color:var(--macro-protein); --qce-w:{Math.max(1, String(editProtein || '').length)}ch"
                     bind:value={editProtein} />
              <span class="qce-macro-unit" style="color:var(--macro-protein)">g</span>
            </div>
            <span class="qce-macro-label">Protein</span>
          </div>
          <div class="qce-macro-pill" style="background:var(--macro-carbs-dim)">
            <div class="qce-macro-val-row">
              <input class="qce-macro-input" type="number" inputmode="decimal"
                     min="0" step="0.1" placeholder="0"
                     style="color:var(--macro-carbs); --qce-w:{Math.max(1, String(editCarbs || '').length)}ch"
                     bind:value={editCarbs} />
              <span class="qce-macro-unit" style="color:var(--macro-carbs)">g</span>
            </div>
            <span class="qce-macro-label">Carbs</span>
          </div>
          <div class="qce-macro-pill" style="background:var(--macro-fat-dim)">
            <div class="qce-macro-val-row">
              <input class="qce-macro-input" type="number" inputmode="decimal"
                     min="0" step="0.1" placeholder="0"
                     style="color:var(--macro-fat); --qce-w:{Math.max(1, String(editFat || '').length)}ch"
                     bind:value={editFat} />
              <span class="qce-macro-unit" style="color:var(--macro-fat)">g</span>
            </div>
            <span class="qce-macro-label">Fat</span>
          </div>
        </div>
        <button class="btn btn-primary w-full" style="margin-top:16px" on:click={saveEditItem}>Save</button>
      {:else}
      <div style="display:flex;gap:12px;margin-bottom:16px">
        <div style="flex:1">
          <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:4px">Serving Size</label>
          <input class="input" type="number" min="0.1" step="0.1" bind:value={editPortion} style="width:100%" />
        </div>
        <div style="width:100px">
          <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:4px">Unit</label>
          <UnitPicker bind:value={editUnit} />
        </div>
      </div>
      <div style="margin-bottom:16px">
        <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:4px">Number of Servings</label>
        <input class="input" type="number" min="0.1" step="0.1" bind:value={editQuantity} style="width:100%" />
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-2);border-radius:var(--radius-md);margin-bottom:16px">
        <span style="font-size:13px;color:var(--text-3)">Total Amount</span>
        <span style="font-size:14px;font-weight:500">{Math.round((parseFloat(editPortion) || 100) * (parseFloat(editQuantity) || 1) * 10) / 10}{editUnit}</span>
      </div>
      <div class="edit-macros">
        <div class="edit-macro-pill" style="background:var(--macro-calories-dim)">
          <span class="edit-macro-val" style="color:var(--macro-calories)">{_editEnergy.value.toLocaleString()}</span>
          <span class="edit-macro-label">{_editEnergy.unit}</span>
        </div>
        <div class="edit-macro-pill" style="background:var(--macro-protein-dim)">
          <span class="edit-macro-val" style="color:var(--macro-protein)">{Math.round((editCalc.proteins || 0) * 10)/10}g</span>
          <span class="edit-macro-label">protein</span>
        </div>
        <div class="edit-macro-pill" style="background:var(--macro-carbs-dim)">
          <span class="edit-macro-val" style="color:var(--macro-carbs)">{Math.round((editCalc.carbohydrates || 0) * 10)/10}g</span>
          <span class="edit-macro-label">carbs</span>
        </div>
        <div class="edit-macro-pill" style="background:var(--macro-fat-dim)">
          <span class="edit-macro-val" style="color:var(--macro-fat)">{Math.round((editCalc.fat || 0) * 10)/10}g</span>
          <span class="edit-macro-label">fat</span>
        </div>
      </div>
      <button class="btn btn-primary w-full" style="margin-top:16px" on:click={saveEditItem}>Save</button>
      {/if}
    </div>
  {/if}
</Sheet>

<!-- Smart Log lives on the assistant FAB (hold to dictate) — see Trace.svelte -->


<!-- Delete confirm dialog -->
<Dialog
  bind:open={showDeleteDialog}
  title="Remove {actionItem?.name || 'item'}?"
  message="This will remove it from your diary."
  confirmText="Remove"
  dangerous
  on:confirm={doDelete}
/>

<!-- Multi-delete confirm dialog -->
<Dialog
  bind:open={showMultiDeleteDialog}
  title="Delete {selectedItems.size} item{selectedItems.size !== 1 ? 's' : ''}?"
  message="This will permanently remove the selected items from your diary."
  confirmText="Delete"
  dangerous
  on:confirm={doDeleteSelected}
/>

<!-- Item long-press action sheet -->
<ActionSheet
  bind:open={showItemAction}
  title={actionItem?.name || ''}
  actions={[
    { label: 'Edit',            icon: 'edit',          value: 'edit'        },
    { label: 'Replace',         icon: 'find_replace',  value: 'replace'     },
    { label: 'Move to Meal',    icon: 'swap_horiz',    value: 'move'        },
    { label: 'Copy',            icon: 'content_copy',  value: 'copy_to'     },
    { label: 'Select Multiple', icon: 'checklist',     value: 'select'      },
    ...(_actionItemIsRecipe ? [{ label: 'Split Recipe', icon: 'call_split', value: 'split' }] : []),
    { label: 'Delete',          icon: 'delete',        value: 'delete', danger: true },
  ]}
  on:select={onItemAction}
/>

<!-- Move to meal action sheet -->
<ActionSheet
  bind:open={showMoveToMeal}
  title="Move to Meal"
  actions={meals.map((m, i) => ({ label: m, icon: mealIcon(m), value: i }))}
  on:select={moveItemToMeal}
/>

<!-- Meal-level action sheet (⋮ on meal header) -->
{#if actionMealIdx != null}
  {@const _mealItems = getMealItems(entry.items, actionMealIdx)}
  {@const _hasItems = _mealItems.length > 0}
  <ActionSheet
    bind:open={showMealAction}
    title={meals[actionMealIdx] + (_hasItems ? ` · ${_mealItems.length} item${_mealItems.length === 1 ? '' : 's'}` : ' · empty')}
    actions={_hasItems ? [
      { label: 'Move Items to…', icon: 'swap_horiz',   value: 'move'      },
      { label: 'Copy',           icon: 'content_copy', value: 'copy_to'   },
      { label: 'Save as Meal…',  icon: 'bookmark_add', value: 'save_meal' },
      { label: 'Clear All Items', icon: 'delete_sweep', value: 'clear', danger: true },
    ] : [
      { label: 'Add Food', icon: 'add', value: 'add' },
    ]}
    on:select={(e) => {
      if (e.detail?.value === 'add') openAddFood(actionMealIdx);
      else onMealAction(e);
    }}
  />
{/if}

<!-- Meal target picker (for copy/move items to…) -->
<ActionSheet
  bind:open={showMealTargetPicker}
  title="Move to meal"
  actions={meals.map((m, i) => ({ label: m, icon: mealIcon(m), value: i }))}
  on:select={onMealTargetPick}
/>

<!-- Shared Copy sheet for both per-ITEM and per-MEAL copy actions.
     copyMode drives the title + the backend call (addDiaryItem for items,
     copyMealToDate for meals). Single combined date+meal picker —
     consolidated from the previous two-step per-meal flow at user
     request, so both surfaces share one identical UX.

     Backdrop uses a custom class (copy-to-backdrop) with low z-index
     so the nested DateInput calendar Sheet can layer above it (see
     the CSS comment block below). The standard .sheet-backdrop is
     locally overridden to z-200 in Diary which would have buried the
     calendar; this one stays at z-90 to let z-100 nested Sheets win. -->
{#if showCopySheet}
  <div use:portal class="copy-to-backdrop" role="dialog" aria-modal="true"
    on:click={() => { if (!_sheetLock) showCopySheet = false; }} on:keydown={() => {}}>
    <div class="bs-sheet copy-date-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <p class="sheet-title">Copy "{copySourceName}" to…</p>
      <label class="copy-date-label">
        <span>Date</span>
        <DateInput bind:value={copyDate} />
      </label>
      <label class="copy-date-label">
        <span>Meal</span>
        <select bind:value={copyMeal} class="select sel-sm" style="width:100%">
          {#each meals as m, i}
            <option value={i}>{m}</option>
          {/each}
        </select>
      </label>
      <div class="copy-date-actions">
        <button class="btn btn-ghost" on:click={() => showCopySheet = false} disabled={copyBusy}>Cancel</button>
        <button class="btn btn-primary" on:click={onConfirmCopy} disabled={!copyDate || copyBusy}>
          {copyBusy ? 'Copying…' : 'Copy'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Clear meal confirm -->
<Dialog
  bind:open={showClearMealDialog}
  title="Clear all items from {actionMealIdx != null ? meals[actionMealIdx] : 'meal'}?"
  message="This will remove every item in this meal from your diary for {$currentDate}. This can't be undone."
  confirmText="Clear"
  dangerous
  on:confirm={doClearMeal}
/>

<!-- Save as meal sheet -->
{#if showSaveAsMeal}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => { if (!_sheetLock && !saveAsMealSaving) showSaveAsMeal = false; }} on:keydown={() => {}}>
    <div class="bs-sheet copy-date-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <p class="sheet-title">Save {actionMealIdx != null ? meals[actionMealIdx] : 'meal'} to library</p>
      <label class="copy-date-label">
        <span>Meal name</span>
        <input type="text" bind:value={saveAsMealName} bind:this={saveAsMealNameInput}
          class="copy-date-input" placeholder="e.g. Usual breakfast" />
      </label>
      <p class="text-3 text-sm" style="margin:8px 0 0">
        {#if actionMealIdx != null}{getMealItems(entry.items, actionMealIdx).length} item{getMealItems(entry.items, actionMealIdx).length === 1 ? '' : 's'} will be saved{/if}
      </p>
      <div class="copy-date-actions">
        <button class="btn btn-ghost" disabled={saveAsMealSaving}
          on:click={() => showSaveAsMeal = false}>Cancel</button>
        <button class="btn btn-primary" disabled={saveAsMealSaving || !saveAsMealName.trim()}
          on:click={doSaveAsMeal}>{saveAsMealSaving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Date Picker Calendar Sheet -->
{#if showDatePicker}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => { if (!_sheetLock) showDatePicker = false; }} on:keydown={() => {}}>
    <div class="bs-sheet dp-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <DatePicker bind:value={pickerDate} on:select={(e) => { pickerDate = e.detail; goToDate(); }} />
    </div>
  </div>
{/if}

<!-- Body Stats Sheet -->
{#if $diaryShowBodyStats}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => { if (!_sheetLock) diaryShowBodyStats.set(false); }} on:keydown={() => {}}>
    <div class="bs-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="sheet-header-row">
        <h3 class="sheet-title">Body Stats</h3>
        <button class="btn-icon sheet-close-btn" on:click={() => diaryShowBodyStats.set(false)} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
      <form on:submit|preventDefault={saveBodyStatsLocal}>
      <div class="bs-sheet-body">
        <div class="bs-grid">
          {#if !($hiddenBodyStats||[]).includes('weight')}
          <div><label class="form-label">Weight ({$weightUnit||'kg'})</label>
            <input class="input" type="number" step="0.1" min="0" bind:value={bodyStatsData.weight} bind:this={weightInput} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('body_fat')}
          <div><label class="form-label">Body Fat %</label>
            <input class="input" type="number" step="0.1" min="0" max="100" bind:value={bodyStatsData.body_fat} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('body_water')}
          <div><label class="form-label">Body Water %</label>
            <input class="input" type="number" step="0.1" min="0" max="100" bind:value={bodyStatsData.body_water} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('neck')}
          <div><label class="form-label">Neck ({$lengthUnit||'in'})</label>
            <input class="input" type="number" step="0.1" min="0" bind:value={bodyStatsData.neck} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('waist')}
          <div><label class="form-label">Waist ({$lengthUnit||'in'})</label>
            <input class="input" type="number" step="0.1" min="0" bind:value={bodyStatsData.waist} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('hips')}
          <div><label class="form-label">Hips ({$lengthUnit||'in'})</label>
            <input class="input" type="number" step="0.1" min="0" bind:value={bodyStatsData.hips} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('chest')}
          <div><label class="form-label">Chest ({$lengthUnit||'in'})</label>
            <input class="input" type="number" step="0.1" min="0" bind:value={bodyStatsData.chest} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('thighs')}
          <div><label class="form-label">Thighs ({$lengthUnit||'in'})</label>
            <input class="input" type="number" step="0.1" min="0" bind:value={bodyStatsData.thighs} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('biceps')}
          <div><label class="form-label">Biceps ({$lengthUnit||'in'})</label>
            <input class="input" type="number" step="0.1" min="0" bind:value={bodyStatsData.biceps} /></div>
          {/if}
          {#if !($hiddenBodyStats||[]).includes('calves')}
          <div><label class="form-label">Calves ({$lengthUnit||'in'})</label>
            <input class="input" type="number" step="0.1" min="0" bind:value={bodyStatsData.calves} /></div>
          {/if}
        </div>
      </div>
      <div class="bs-sheet-footer">
        <button class="btn btn-primary w-full" type="submit">Save</button>
      </div>
      </form>
    </div>
  </div>
{/if}

<!-- Nutrition Summary Modal -->
{#if $diaryShowNutritionSummary}
  {@const _nsTotEnergy = Nutrition.displayEnergy(totals.calories || 0, $energyUnit)}
  <div use:portal class="sheet-backdrop" role="dialog" aria-modal="true"
    on:click={() => { if (!_sheetLock) diaryShowNutritionSummary.set(false); }} on:keydown={() => {}}>
    <div class="ns-sheet" on:click|stopPropagation on:keydown={() => {}}>
      <div class="sheet-handle"></div>
      <div class="sheet-header-row">
        <h3 class="sheet-title">Nutrition Summary</h3>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="text-3 text-sm">{formatDateSub($currentDate, $dateFormat)}</span>
          <button class="btn-icon sheet-close-btn" on:click={() => diaryShowNutritionSummary.set(false)} aria-label="Close" title="Close">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      </div>
      <div class="ns-body">
        <!-- Sheet toolbar: legend-mode toggle (percent / grams). Sits
             just under the header, always visible so the toggle has a
             stable home regardless of what the ring/legend/pills below
             render. Grams mode swaps the macro pill values from plain
             consumed to consumed-over-goal (e.g. 203g → 203/301g) and
             hides the ring's percent legend since the pills carry the
             same data with goal context. #95. -->
        <div class="ns-toolbar">
          <button
            class="ns-legend-toggle"
            on:click={() => macroLegendMode.set($macroLegendMode === 'grams' ? 'percent' : 'grams')}
            aria-label="Toggle macro display between percent and grams"
            title="Toggle percent / grams">
            <span class="ns-lt-opt" class:ns-lt-active={$macroLegendMode === 'percent'}>%</span>
            <span class="ns-lt-opt" class:ns-lt-active={$macroLegendMode === 'grams'}>g</span>
          </button>
        </div>
        <!-- Macro ring -->
        <div class="ns-ring-wrap">
          <MacroRing
            calories={totals.calories || 0}
            caloriesGoal={caloriesGoalAdjusted}
            fat={totals.fat || 0}
            carbs={totals.carbohydrates || 0}
            protein={totals.proteins || 0}
            proteinGoal={protGoal} {carbGoal} {fatGoal}
          />
        </div>
        <!-- Macros highlight. In grams mode the values switch to
             "consumed / goal" (e.g. 203/301g) when a goal exists, or
             fall back to plain grams when it doesn't. KCAL pill is
             mode-agnostic; the calorie goal is already visible in the
             ring center. -->
        <div class="ns-macros">
          <div class="ns-macro-pill" style="background:var(--macro-protein-dim)">
            <span class="ns-macro-val" style="color:var(--macro-protein)">{Math.round(totals.proteins || 0)}{#if $macroLegendMode === 'grams' && protGoal}/{protGoal}{/if}g</span>
            <span class="ns-macro-lbl">Protein</span>
          </div>
          <div class="ns-macro-pill" style="background:var(--macro-carbs-dim)">
            <span class="ns-macro-val" style="color:var(--macro-carbs)">{Math.round(totals.carbohydrates || 0)}{#if $macroLegendMode === 'grams' && carbGoal}/{carbGoal}{/if}g</span>
            <span class="ns-macro-lbl">Carbs</span>
          </div>
          <div class="ns-macro-pill" style="background:var(--macro-fat-dim)">
            <span class="ns-macro-val" style="color:var(--macro-fat)">{Math.round(totals.fat || 0)}{#if $macroLegendMode === 'grams' && fatGoal}/{fatGoal}{/if}g</span>
            <span class="ns-macro-lbl">Fat</span>
          </div>
        </div>
        <!-- All nutrients — tap a row to drill into top contributors -->
        <div class="ns-rows">
          {#each NUTRIMENTS.filter(n => ($diaryShowAllNutrients ? true : n.default) && (totals[n.id] || 0) > 0) as n}
            {@const isOpen = _nsExpanded === n.id}
            <div class="ns-row ns-row-clickable" role="button" tabindex="0"
                 on:click={() => _nsToggle(n.id)}
                 on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _nsToggle(n.id); } }}>
              <span>{n.label}</span>
              <span class="ns-row-right">
                <span class="font-medium">{(Math.round((totals[n.id]||0)*10)/10).toLocaleString()} {n.unit}</span>
                <span class="material-symbols-rounded ns-chev" class:open={isOpen}>chevron_right</span>
              </span>
            </div>
            {#if isOpen && _nsContributors}
              <div class="ns-contrib" transition:slide={{ duration: 160 }}>
                <div class="ns-contrib-head">
                  {_nsContributors.allShown ? 'All Contributors' : 'Top Contributors'}
                </div>
                {#if _nsContributors.visible.length === 0}
                  <div class="ns-contrib-empty">No items contribute to this nutrient.</div>
                {:else}
                  {#each _nsContributors.visible as c}
                    <div class="ns-contrib-row">
                      <span class="ns-contrib-name">
                        {c.name}{#if c.portion}<span class="ns-contrib-meta"> — {c.portion}</span>{/if}{#if c.isQuick}<span class="ns-contrib-meta"> (Quick entry)</span>{/if}
                      </span>
                      <span class="ns-contrib-val">{(Math.round(c.value*10)/10).toLocaleString()} {n.unit}</span>
                    </div>
                  {/each}
                  {#if _nsContributors.hiddenCount > 0}
                    <div class="ns-contrib-row ns-contrib-more" role="button" tabindex="0"
                         on:click|stopPropagation={() => _nsShowAll = true}
                         on:keydown|stopPropagation={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _nsShowAll = true; } }}>
                      <span class="ns-contrib-name">
                        + {_nsContributors.hiddenCount} more {_nsContributors.hiddenCount === 1 ? 'item' : 'items'}
                        <span class="ns-contrib-meta">(tap to expand)</span>
                      </span>
                      <span class="ns-contrib-val">{(Math.round(_nsContributors.hiddenSum*10)/10).toLocaleString()} {n.unit}</span>
                    </div>
                  {:else if _nsContributors.allShown && _nsContributors.visible.length > 5}
                    <button class="ns-contrib-collapse" on:click|stopPropagation={() => _nsShowAll = false}>
                      Show top 5
                    </button>
                  {/if}
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Per-meal nutrition totals sheet -->
<Sheet open={mealTotalsIdx != null} title={mealTotalsIdx != null ? `${meals[mealTotalsIdx]} totals` : ''}
  on:close={() => mealTotalsIdx = null}>
  {@const _nsMealEnergy = Nutrition.displayEnergy(_mealTotals.calories || 0, $energyUnit)}
  <div class="ns-body">
    <div class="ns-macros">
      <div class="ns-macro-pill" style="background:var(--macro-protein-dim)">
        <span class="ns-macro-val" style="color:var(--macro-protein)">{Math.round(_mealTotals.proteins || 0)}g</span>
        <span class="ns-macro-lbl">Protein</span>
      </div>
      <div class="ns-macro-pill" style="background:var(--macro-carbs-dim)">
        <span class="ns-macro-val" style="color:var(--macro-carbs)">{Math.round(_mealTotals.carbohydrates || 0)}g</span>
        <span class="ns-macro-lbl">Carbs</span>
      </div>
      <div class="ns-macro-pill" style="background:var(--macro-fat-dim)">
        <span class="ns-macro-val" style="color:var(--macro-fat)">{Math.round(_mealTotals.fat || 0)}g</span>
        <span class="ns-macro-lbl">Fat</span>
      </div>
      <div class="ns-macro-pill" style="background:var(--macro-calories-dim)">
        <span class="ns-macro-val" style="color:var(--macro-calories)">{_nsMealEnergy.value.toLocaleString()}</span>
        <span class="ns-macro-lbl">{_nsMealEnergy.unit}</span>
      </div>
    </div>
    <div class="ns-rows">
      {#each NUTRIMENTS.filter(n => ($diaryShowAllNutrients ? true : n.default) && (_mealTotals[n.id] || 0) > 0) as n}
        <div class="ns-row">
          <span>{n.label}</span>
          <span class="font-medium">{(Math.round((_mealTotals[n.id]||0)*10)/10).toLocaleString()} {n.unit}</span>
        </div>
      {/each}
    </div>
    <div class="text-3 text-sm" style="text-align:center;padding:8px 0 4px">
      {_mealTotalsItems.length} {_mealTotalsItems.length === 1 ? 'item' : 'items'}
    </div>
  </div>
</Sheet>

<AddActivitySheet bind:open={showActivitySheet} date={$currentDate} entry={editingActivity} on:close={() => editingActivity = null} />

<QuickCaloriesSheet bind:open={_quickSheetOpen} meal={_quickSheetMeal} mealName={meals[_quickSheetMeal] || ''} />

<ActionSheet
  bind:open={showActivityAction}
  title={activityActionItem?.name || $_('diary.activity.section')}
  actions={[
    { label: $_('diary.activity.actions.edit'),   icon: 'edit',   value: 'edit'   },
    { label: $_('diary.activity.actions.delete'), icon: 'delete', value: 'delete', danger: true },
  ]}
  on:select={onActivityAction}
/>


<style>
  /* Date picker sheet wrapper — calendar UI lives in DatePicker.svelte */
  .dp-sheet { padding-bottom: 4px; }

  /* Inline cue + math breakdown for the activity-adjusted calorie budget */
  :global(.dbb-activity-cue) { font-size: 14px; vertical-align: middle; opacity: 0.85; }
  :global(.dbb-activity-breakdown) {
    padding: 4px 12px 8px; text-align: right;
  }

  /* Activity section — same shell as meal-group, footer mirrors meal-macro-footer
     but with green segments per entry instead of P/C/F. */
  .activity-name-stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .activity-sub { line-height: 1.2; opacity: 0.75; }
  .activity-footer { cursor: default; }
  .activity-footer:hover, .activity-footer:active { background: transparent; }
  .amb-seg {
    background: linear-gradient(90deg, #4FFFB0, #00B894);
    border-right: 1px solid var(--surface-2, rgba(0,0,0,0.18));
  }
  .amb-seg:last-child { border-right: 0; }

  /* diary-page no longer overrides page-shell padding-top — same as every other page */

  /* Action icons fixed at top-right, same level as hamburger */
  :global(.diary-topbar-actions) {
    position: fixed;
    top: calc(var(--safe-top, 0px) + 10px);
    right: 12px;
    z-index: 41;
    display: flex;
    align-items: center;
    gap: 2px;
    pointer-events: all;
  }

  /* H1 height/alignment now lives in base.css .page-header h1 (uniform 40px). */

  /* Sticky date navigation sub-bar — pins flush below the page-header.
     62 + var(--hamburger-row): hamburger-row is 48 normally and 0 when the
     persistent sidebar is pinned, so the bar tracks the actual header height
     in both modes. With banner: 122 + hamburger-row. */
  .diary-date-bar {
    position: sticky;
    top: calc(var(--page-top, var(--safe-top)) + 60px + var(--hamburger-row, 0px));
    z-index: 9;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px var(--page-px);
  }
  .diary-date-bar.has-banner {
    top: calc(var(--page-top, var(--safe-top)) + 122px + var(--hamburger-row, 0px));
  }

  .date-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: none;
    border: none;
    cursor: pointer;
    gap: 1px;
  }
  .date-label { font-size: 17px; font-weight: 700; color: var(--accent); display: inline-flex; align-items: center; gap: 4px; }
  .date-sub   { font-size: 12px; color: var(--text-3); }
  .date-note-indicator { font-size: 16px; color: var(--text-3); vertical-align: middle; }

  .diary-content { padding-top: 12px; padding-bottom: 16px; gap: 12px; display: flex; flex-direction: column; }

  /* Water blue — dedicated color, always blue regardless of theme accent */
  :global(:root) { --water-blue: #2196F3; --water-blue-dim: rgba(33,150,243,0.15); }

  /* Water strip in collapsed bar */
  .dbb-water-strip { height: 8px; background: var(--surface-3); overflow: hidden; cursor: pointer; }
  .dbb-water-strip-fill { height: 100%; background: linear-gradient(90deg, #42A5F5, var(--water-blue)); transition: width 0.7s cubic-bezier(0.34, 1.2, 0.64, 1); }
  .dbb-water-strip-fill.celebrating { animation: goal-pulse 1.2s ease-out; }

  /* Water row in expanded panel */
  .dbb-water-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 16px 2px;
  }
  .dbb-water-icon { color: var(--water-blue); font-size: 16px; flex-shrink: 0; }
  .dbb-water-track { flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .dbb-water-bar { height: 4px; background: var(--surface-3); border-radius: var(--radius-full); overflow: hidden; }
  .dbb-water-fill { height: 100%; background: var(--water-blue); border-radius: var(--radius-full); transition: width 0.4s ease; }
  .dbb-water-text { font-size: 11px; color: var(--text-3); }
  .dbb-water-pct  { font-size: 11px; font-weight: 600; color: var(--water-blue); flex-shrink: 0; min-width: 36px; text-align: right; }

  /* Water quick-add sheet */
  /* ── Water card sheet ─────────────────────────────────────────────────────── */
  .wc-body { padding: 0; display: flex; flex-direction: column; }

  /* Banner strip — flush against the sheet top, SVG fills it, title sits at bottom-left.
     The page-header.has-banner uses padding-bottom:52px but on a ~150px header (safe area
     adds significant padding-top). On our fixed 110px strip that same value pushes the
     title to the middle; 16px keeps it in the natural bottom-third like other banners. */
  .wc-banner-strip {
    position: relative;
    height: 110px;
    overflow: hidden;
    flex-shrink: 0;
    clip-path: inset(0);
    display: flex;
    align-items: flex-end;
    padding: 0 20px 16px;
  }
  .wc-banner-title {
    position: relative;
    z-index: 1;
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1.1;
    margin: 0;
    flex: 1;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    filter: drop-shadow(0 2px 8px rgba(0,0,0,0.35));
  }
  /* Inner padding wrapper below the banner */
  .wc-inner { padding: 0 16px; display: flex; flex-direction: column; }

  .wc-empty-log {
    display: flex; flex-direction: column; align-items: center;
    gap: 8px; padding: 28px 0;
  }
  .wc-empty-icon { font-size: 36px; color: var(--accent); opacity: 0.4; }

  /* Bottle + stats */
  .wc-bottle-section {
    display: flex; flex-direction: column; align-items: center;
    gap: 16px; padding: 8px 0 16px;
  }
  .wc-bottle-wrap {
    width: 120px; height: auto;
    filter: drop-shadow(0 8px 24px rgba(0,0,0,0.3));
  }
  .wc-bottle-wrap.wc-overflowing { animation: wc-overflow-glow 1.8s ease-in-out infinite; }
  @keyframes wc-overflow-glow {
    0%,100% { filter: drop-shadow(0 8px 24px rgba(0,0,0,0.3)); }
    50%      { filter: drop-shadow(0 0 22px rgba(79,255,176,0.55)) drop-shadow(0 8px 24px rgba(0,0,0,0.2)); }
  }
  .wc-bottle-svg { width: 100%; height: auto; overflow: visible; }
  .wc-bottle-svg.wc-overflowing .wc-water-wave { animation-duration: 0.65s; }
  .wc-bottle-bg      { fill: var(--surface-3); }
  .wc-bottle-outline { fill: none; stroke: var(--border-strong); stroke-width: 2; transition: stroke 0.4s; }
  .wc-bottle-outline.wc-full { stroke: var(--accent); filter: drop-shadow(0 0 4px var(--accent)); }
  .wc-bottle-cap     { fill: var(--accent); }
  .wc-cap-line       { stroke: var(--border-strong); stroke-width: 1; }
  .wc-water-body     { fill: var(--accent); opacity: 0.55; transition: y 0.6s ease, height 0.6s ease; }
  .wc-water-wave     { fill: var(--accent); opacity: 0.75; animation: wc-wave-flow 1.8s linear infinite; }
  @keyframes wc-wave-flow { from { transform: translateX(0); } to { transform: translateX(-120px); } }
  .wc-overflow-spill { fill: var(--accent); animation: wc-spill-pulse 1.6s ease-in-out infinite; }
  @keyframes wc-spill-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 0.65; } }
  .wc-overflow-drip  { fill: var(--accent); }
  .wc-drip-1 { animation: wc-drip-l 1.4s ease-in 0s    infinite; }
  .wc-drip-2 { animation: wc-drip-l 1.4s ease-in 0.7s  infinite; }
  .wc-drip-3 { animation: wc-drip-r 1.4s ease-in 0.35s infinite; }
  .wc-drip-4 { animation: wc-drip-r 1.4s ease-in 1.05s infinite; }
  @keyframes wc-drip-l { 0% { transform:translate(0,0);    opacity:0; } 8% { opacity:0.85; } 100% { transform:translate(-10px,34px); opacity:0; } }
  @keyframes wc-drip-r { 0% { transform:translate(0,0);    opacity:0; } 8% { opacity:0.85; } 100% { transform:translate(10px, 34px); opacity:0; } }

  .wc-stats { display:flex; flex-direction:column; align-items:center; gap:8px; width:100%; max-width:280px; }
  .wc-amount { display:flex; align-items:baseline; gap:6px; }
  .wc-current { font-size:28px; font-weight:700; color:var(--accent); line-height:1; }
  .wc-sep     { font-size:20px; color:var(--text-3); }
  .wc-goal    { font-size:18px; font-weight:500; color:var(--text-2); }
  .wc-pct     { font-size:14px; font-weight:600; color:var(--text-3); }
  .wc-pct.wc-goal-met { color:var(--accent); }
  .wc-progress-bar  { width:100%; height:8px; background:var(--surface-3); border-radius:var(--radius-full); overflow:hidden; }
  .wc-progress-fill { height:100%; background:linear-gradient(90deg,var(--accent),var(--accent-2)); border-radius:var(--radius-full); transition:width 0.5s cubic-bezier(0.34,1.56,0.64,1); }

  /* Quick-add grid */
  .wc-grid { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; }
  .wc-btn {
    width:100px;
    display:flex; flex-direction:column; align-items:center; gap:6px;
    padding:18px 8px; border-radius:var(--radius-lg);
    background:var(--surface-2); border:1px solid var(--border);
    color:var(--text-1); cursor:pointer;
    transition:background var(--dur-fast), border-color var(--dur-fast), transform var(--dur-fast);
  }
  .wc-btn .material-symbols-rounded { font-size:26px; color:var(--accent); }
  .wc-btn:hover  { background:var(--accent-dim); border-color:var(--accent); }
  .wc-btn:active { transform:scale(0.94); }
  .wc-btn-custom { border-style:dashed; }
  .wc-btn-name { font-size:12px; font-weight:600; }
  .wc-btn-vol  { font-size:12px; color:var(--text-3); font-weight:500; }

  .wc-custom-row { display:flex; gap:8px; margin-top:10px; align-items:center; }
  .wc-custom-row .input { flex:1; }

  /* Log */
  .wc-log-card { border-left:3px solid var(--accent); }
  .wc-log-row  { display:flex; align-items:center; gap:12px; padding:12px 16px; cursor:pointer; }
  .wc-log-row:hover { background:var(--bg-2); }
  .wc-log-edit { cursor:default; background:var(--bg-2); }
  .wc-log-edit:hover { background:var(--bg-2); }
  .wc-edit-input { width:80px; padding:4px 8px; font-size:14px; }
  .wc-log-icon { color:var(--accent); font-size:20px; flex-shrink:0; }
  .wc-log-info { flex:1; display:flex; flex-direction:column; gap:2px; }
  .wc-divider  { height:1px; background:var(--border); margin:0 16px; }


  /* Daily notes card */
  .diary-notes {
    margin-top: 8px;
    border-left: 3px solid var(--text-3);
    transition: border-color var(--dur-fast);
  }
  .diary-notes.expanded { border-left-color: var(--accent); }
  .diary-notes-header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; cursor: pointer;
  }
  .diary-notes-icon { font-size: 20px; color: var(--text-2); }
  .diary-notes.expanded .diary-notes-icon { color: var(--accent); }
  .diary-notes-label { font-size: 14px; font-weight: 600; color: var(--text-1); flex-shrink: 0; }
  .diary-notes-preview { flex: 1; min-width: 0; font-size: 13px; color: var(--text-3); }
  .diary-notes-chevron { font-size: 20px; color: var(--text-3); margin-left: auto; flex-shrink: 0; }
  .diary-notes-body { padding: 0 14px 14px; }
  .diary-notes-textarea {
    width: 100%; min-height: 80px; resize: vertical;
    padding: 10px 12px; border-radius: var(--radius-md);
    border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text-1); font-size: 14px; line-height: 1.5;
    font-family: inherit;
  }
  .diary-notes-textarea:focus { outline: none; border-color: var(--accent); }
  .diary-notes-meta { margin-top: 6px; min-height: 16px; text-align: right; }

  .meal-group { overflow: visible; border-left: 3px solid var(--meal-color, var(--accent)); }
  .meal-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
  }
  .meal-type-icon {
    font-size: 18px;
    color: var(--meal-color, var(--accent));
    flex-shrink: 0;
    opacity: 0.9;
  }
  .meal-name   { font-size: 15px; font-weight: 600; color: var(--text-1); }
  .meal-kcal   { margin-left: 4px; }
  .ml-auto     { margin-left: auto; }
  .meal-empty  {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 16px;
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
    -webkit-tap-highlight-color: transparent;
    transition: background 120ms;
  }
  .meal-empty:hover,
  .meal-empty:active { background: var(--surface-2); }
  .meal-empty:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: var(--radius-sm, 6px);
  }
  .meal-empty-icon { font-size: 20px; opacity: 0.5; flex-shrink: 0; }
  .meal-empty-text { font-size: 13px; color: var(--text-3); }

  .meal-add-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 9px 14px;
    border-top: 1.5px dashed var(--border);
    color: var(--text-3);
    font-size: 13px;
    font-weight: 500;
    background: none;
    cursor: pointer;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .meal-add-row .material-symbols-rounded { font-size: 17px; }
  .meal-add-row:hover { color: var(--meal-color, var(--accent)); background: var(--accent-dim); }

  .meal-items { display: flex; flex-direction: column; }
  .diary-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    transition: background var(--dur-fast);
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .diary-item:last-child { border-bottom: none; }
  .diary-item:active { background: var(--surface-2); }
  .diary-item.item-selected { background: var(--accent-dim); }

  /* Multi-select circle */
  .item-select-btn {
    padding: 0 4px 0 0;
    background: none;
    border: none;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }
  .item-check {
    font-size: 24px;
    color: var(--text-3);
    transition: color var(--dur-fast);
  }
  .item-check-on { color: var(--accent); }

  /* Server error banner */
  .server-error-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    margin-bottom: 8px;
    background: rgba(255, 100, 80, 0.08);
    border: 1px solid rgba(255, 100, 80, 0.2);
    border-radius: var(--radius-lg);
    font-size: 14px; color: var(--text-2);
  }
  .server-error-banner .material-symbols-rounded { font-size: 18px; color: #ff6450; flex-shrink: 0; }
  .server-error-retry {
    background: none; border: none; padding: 0;
    color: var(--accent); font-size: 14px; font-weight: 600;
    cursor: pointer; text-decoration: underline;
  }

  /* Select-mode header title */
  .select-mode-title { color: var(--accent); }
  .item-thumb {
    width: 52px; height: 52px;
    border-radius: var(--radius-sm);
    object-fit: cover;
    flex-shrink: 0;
    background: var(--surface-2);
  }
  .item-info  { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .item-name  { font-size: 14px; font-weight: 500; }
  .item-meta  { }


  .diary-item-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    padding: 0;
    color: var(--text-1);
  }
  .item-thumb-placeholder {
    width: 52px; height: 52px;
    border-radius: var(--radius-sm);
    background: var(--accent-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  /* Split-recipe expand/collapse */
  .split-toggle {
    background: transparent;
    border: 0;
    padding: 4px 8px;
    cursor: pointer;
    color: var(--text-3);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .split-toggle:hover { color: var(--text-1); }
  .split-chevron {
    font-size: 22px;
    transition: transform 180ms ease;
  }
  .split-chevron-open { transform: rotate(180deg); }
  .split-children {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 12px 8px 44px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
  }
  .split-child {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    border-radius: var(--radius-sm);
  }
  .split-child:hover { background: var(--surface-3); }
  .split-child-btn {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: 0;
    padding: 4px 6px;
    cursor: pointer;
    text-align: left;
    color: var(--text-1);
  }
  .split-child-name { flex: 0 0 auto; font-size: 13px; max-width: 45%; }
  .split-child-meta { flex: 1; min-width: 0; }
  .split-child-del {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    color: var(--text-3);
  }
  .split-child-del:hover { color: var(--danger, #ef4444); }

  .edit-sheet-body { padding: 16px; }
  .edit-macros { display: flex; gap: 8px; flex-wrap: wrap; }
  .edit-macro-pill {
    flex: 1;
    min-width: 60px;
    border-radius: var(--radius-md);
    padding: 8px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .edit-macro-val   { font-size: 15px; font-weight: 700; }
  .edit-macro-label { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: .4px; }

  /* Quick Calories edit — same look as the create sheet
     (src/components/diary/QuickCaloriesSheet.svelte). Kept in this file
     rather than extracted because it's tightly coupled to the edit-sheet
     flow + Svelte 4's per-component scoping makes sharing pill styles
     awkward without lifting them into a global stylesheet. */
  .qce-kcal-pill {
    display: flex; align-items: baseline; justify-content: center; gap: 8px;
    padding: 14px 16px; border-radius: var(--radius-md);
  }
  .qce-kcal-input {
    background: transparent; border: 0; outline: 0;
    font-size: 28px; font-weight: 700;
    width: 130px; text-align: right;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
  }
  .qce-kcal-input::-webkit-outer-spin-button,
  .qce-kcal-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .qce-kcal-unit {
    font-size: 12px; font-weight: 700; min-width: 36px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .qce-section-label {
    font-size: 12px; font-weight: 600;
    color: var(--text-2);
    margin: 14px 0 6px 0;
    letter-spacing: 0.02em;
  }
  .qce-macros {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
  }
  .qce-macro-pill {
    display: flex; flex-direction: column; align-items: center;
    padding: 10px 8px; border-radius: var(--radius-md);
    gap: 2px;
  }
  .qce-macro-val-row {
    display: inline-flex; align-items: baseline; justify-content: center;
    gap: 1px;
  }
  .qce-macro-input {
    background: transparent; border: 0; outline: 0;
    font-size: 20px; font-weight: 700;
    text-align: right;
    font-variant-numeric: tabular-nums;
    width: var(--qce-w, 1ch); min-width: 1ch; max-width: 6ch;
    padding: 0;
    -moz-appearance: textfield;
  }
  .qce-macro-input::-webkit-outer-spin-button,
  .qce-macro-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .qce-macro-label {
    font-size: 11px; color: var(--text-3);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .qce-macro-unit { font-size: 20px; font-weight: 700; }

  /* Sheet backdrop */
  /* Copy-to-day backdrop — sits BELOW any DateInput-triggered calendar
     Sheet (which uses the global z-100 from Sheet.svelte) so the nested
     calendar can layer above this card. The other inline Diary sheets
     keep their z-200 to stay above bottom nav etc; this one stays low
     because it's the only one that triggers a nested Sheet inside it. */
  .copy-to-backdrop {
    position: fixed; inset: 0; z-index: 90;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    display: flex; align-items: flex-end; justify-content: center;
  }
  /* When the DateInput calendar opens from within the copy sheet, push
     its portal-rendered Sheet above any other portal at z-300. The
     global Sheet stays at z-100 in other contexts. :global() because
     the Sheet component portals to document.body, outside this scoped
     style's reach. */
  :global(.copy-to-backdrop ~ .sheet-backdrop) { z-index: 300 !important; }

  .sheet-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.5);
    display: flex; align-items: flex-end;
  }
  .sheet-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 10px auto 0; }
  .sheet-header-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px 4px; }
  .sheet-title { font-size: 17px; font-weight: 700; }

  /* Body stats sheet */
  .bs-sheet {
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 600px; margin: 0 auto;
    padding-bottom: var(--safe-bottom);
  }
  .bs-sheet-body  { padding: 8px 20px 0; display: flex; flex-direction: column; gap: 12px; }
  .bs-sheet-footer { padding: 16px 20px; }

  /* Meal header ⋮ menu button — quieter than the accent + */
  .meal-menu-btn { color: var(--text-3); }
  .meal-menu-btn:active { color: var(--text-1); }

  /* Copy meal to another date sheet */
  .copy-date-sheet { padding: 0 20px 20px; }
  .copy-date-sheet .sheet-title { padding: 4px 0 12px; }
  .copy-date-label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-2); }
  .copy-date-input {
    padding: 10px 12px; border-radius: var(--radius-md);
    border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text-1); font-size: 15px;
  }
  .copy-date-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
  .bs-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 4px 0;
  }

  /* Nutrition summary sheet */
  .ns-sheet {
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    width: 100%; max-width: 600px; margin: 0 auto;
    max-height: 85dvh; display: flex; flex-direction: column;
    padding-bottom: var(--safe-bottom);
  }
  .ns-body { flex: 1; overflow-y: auto; padding: 0 16px 16px; }
  .ns-toolbar {
    display: flex;
    align-items: center;
    padding: 8px 0 0;
  }
  .ns-legend-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding: 3px;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--surface-3);
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .ns-lt-opt {
    min-width: 22px;
    padding: 3px 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-3);
    border-radius: 999px;
    line-height: 1;
    transition: color 120ms, background-color 120ms;
  }
  .ns-lt-active {
    background: var(--accent);
    color: var(--on-accent, #fff);
  }
  .ns-ring-wrap { padding: 8px 0 16px; }
  .ns-macros { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 16px; }
  .ns-macro-pill {
    border-radius: var(--radius-md); padding: 10px 4px;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
  }
  .ns-macro-val { font-size: 18px; font-weight: 700; }
  .ns-macro-lbl { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; }
  .ns-rows { display: flex; flex-direction: column; gap: 6px; }
  .ns-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
  .ns-row:last-child { border-bottom: none; }
  .ns-row-clickable {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    border-radius: var(--radius-sm, 6px);
    transition: background 120ms;
  }
  .ns-row-clickable:hover { background: color-mix(in srgb, var(--text-1) 4%, transparent); }
  .ns-row-right { display: inline-flex; align-items: center; gap: 6px; }
  .ns-chev {
    font-size: 18px;
    color: var(--text-3);
    transition: transform 160ms;
  }
  .ns-chev.open { transform: rotate(90deg); }
  .ns-contrib {
    padding: 8px 10px 10px 14px;
    background: var(--surface-2);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-sm, 6px);
    margin: 2px 0 4px;
    display: flex; flex-direction: column; gap: 4px;
    font-size: 13px;
  }
  .ns-contrib-head {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 2px;
  }
  .ns-contrib-empty { color: var(--text-3); font-style: italic; padding: 2px 0; }
  .ns-contrib-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 2px 0; }
  .ns-contrib-name { color: var(--text-1); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ns-contrib-meta { color: var(--text-3); font-size: 12px; }
  .ns-contrib-val { font-weight: 600; color: var(--text-1); white-space: nowrap; }
  .ns-contrib-more {
    color: var(--text-3); font-style: italic;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    border-radius: var(--radius-sm, 6px);
    transition: background 120ms;
    margin: 2px -6px 0;
    padding: 4px 6px;
  }
  .ns-contrib-more:hover { background: color-mix(in srgb, var(--text-1) 5%, transparent); }
  .ns-contrib-more .ns-contrib-name, .ns-contrib-more .ns-contrib-val { color: var(--text-3); }
  .ns-contrib-collapse {
    margin-top: 6px;
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 0;
    align-self: flex-start;
    -webkit-tap-highlight-color: transparent;
  }
  .ns-contrib-collapse:hover { text-decoration: underline; }

  /* Meal macro footer */
  .meal-macro-footer {
    padding: 8px 16px 10px; border-top: 1px solid var(--border);
    width: 100%; display: block; text-align: left;
    background: none; cursor: pointer; color: inherit; font: inherit;
    -webkit-tap-highlight-color: transparent;
    transition: background 120ms;
  }
  .meal-macro-footer:hover, .meal-macro-footer:active { background: var(--surface-2); }
  .meal-macro-footer:focus-visible {
    outline: 2px solid var(--accent); outline-offset: -2px;
    border-radius: var(--radius-sm, 6px);
  }
  .meal-macro-bar {
    height: 8px; border-radius: 4px;
    background: var(--surface-3); overflow: hidden;
    display: flex; margin-bottom: 6px;
  }
  .mmb-p { background: linear-gradient(90deg, #BA68C8, var(--macro-protein)); }
  .mmb-c { background: linear-gradient(90deg, #00E676, var(--macro-carbs)); }
  .mmb-f { background: linear-gradient(90deg, var(--macro-fat), #E65100); }
  .meal-macro-text { display: block; }

  /* Nutrition bar (inside bottom bar) */
  .dbb-nutrient-bars { padding: 0 12px 4px; display: flex; flex-direction: column; gap: 6px; }
  .nb-row { display: flex; align-items: center; gap: 8px; }
  .nb-label { font-size: 12px; color: var(--text-3); width: 60px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nb-bar { flex: 1; height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
  .nb-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width var(--dur-base); }
  .nb-fill.over { background: var(--red, #f44336); }
  .nb-val { font-size: 12px; font-weight: 600; color: var(--text-2); width: 60px; text-align: right; flex-shrink: 0; }
  .nb-val.over { color: var(--red, #f44336); }

  /* ── Persistent bottom nutrition bar ─────────────────────────── */
  .diary-bottom-bar {
    position: fixed;
    left: 0; right: 0;
    z-index: 90;
    background: var(--glass-surface);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border-top: 1px solid var(--border);
    box-shadow: 0 -4px 16px rgba(0,0,0,0.12);
  }
  .dbb-progress {
    height: 8px;
    background: var(--surface-3);
    overflow: hidden;
    cursor: pointer;
  }
  @keyframes goal-pulse {
    0%   { filter: brightness(1); }
    30%  { filter: brightness(1.6) saturate(1.4); box-shadow: 0 0 12px currentColor; }
    70%  { filter: brightness(1.3); }
    100% { filter: brightness(1); }
  }
  .dbb-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--macro-calories), #FF8F00);
    transition: width 0.7s cubic-bezier(0.34, 1.2, 0.64, 1);
  }
  .dbb-progress-fill.celebrating {
    animation: goal-pulse 1.2s ease-out;
  }
  /* Colored macro proportion bar (standalone — not inside button so title tooltips work) */
  .dbb-macro-bar {
    height: 8px;
    background: var(--surface-3);
    display: flex;
    overflow: hidden;
    cursor: pointer;
  }
  .dbb-mb-p { background: linear-gradient(90deg, #BA68C8, var(--macro-protein)); transition: width 0.7s cubic-bezier(0.34, 1.2, 0.64, 1); }
  .dbb-mb-c { background: linear-gradient(90deg, #00E676, var(--macro-carbs)); transition: width 0.7s cubic-bezier(0.34, 1.2, 0.64, 1); }
  .dbb-mb-f { background: linear-gradient(90deg, var(--macro-fat), #E65100); transition: width 0.7s cubic-bezier(0.34, 1.2, 0.64, 1); }
  /* Text summary row button */
  .dbb-summary-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 14px 7px;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-1);
    text-align: left;
    -webkit-tap-highlight-color: transparent;
  }
  .dbb-summary-row:active { background: var(--surface-2); }
  .dbb-summary-text {
    font-size: 13px;
    color: var(--text-2);
    font-weight: 500;
  }
  .dbb-chevron {
    font-size: 18px;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .dbb-kcal {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 80px;
    flex-shrink: 0;
  }
  .dbb-num  { font-size: 20px; font-weight: 800; line-height: 1.1; color: var(--macro-calories); }
  .dbb-unit { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; }
  .dbb-macros {
    display: flex;
    flex: 1;
    gap: 12px;
    justify-content: flex-end;
  }
  .dbb-macro {
    display: flex;
    align-items: baseline;
    gap: 2px;
    font-size: 15px;
    font-weight: 700;
  }
  .dbb-mlabel { font-size: 10px; font-weight: 400; color: var(--text-3); margin-left: 1px; }

  /* Expanded panel */
  .dbb-panel {
    border-top: 1px solid var(--border);
    overflow: hidden;
  }
  .dbb-toggle-row {
    display: flex;
    justify-content: center;
    padding: 10px 14px 6px;
  }
  .dbb-toggle-pill {
    display: flex;
    background: var(--surface-2);
    border: none;
    border-radius: var(--radius-full);
    padding: 3px;
    cursor: pointer;
    gap: 2px;
    -webkit-tap-highlight-color: transparent;
  }
  .dbb-tp-opt {
    padding: 6px 18px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-3);
    border-radius: var(--radius-full);
    transition: background var(--dur-fast), color var(--dur-fast);
    user-select: none;
  }
  .dbb-tp-active {
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .dbb-detail-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 14px 10px;
  }

</style>
