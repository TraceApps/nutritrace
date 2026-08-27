<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { push, location } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { fade, fly, slide } from 'svelte/transition';

  import Tabs        from '../components/ui/Tabs.svelte';
  import ActionSheet     from '../components/ui/ActionSheet.svelte';
  import BarcodeScanner from '../components/foods/BarcodeScanner.svelte';
  import Dialog      from '../components/ui/Dialog.svelte';
  import Sheet       from '../components/ui/Sheet.svelte';
  import FoodDetailSheet from '../components/ui/FoodDetailSheet.svelte';
  import UnitPicker  from '../components/ui/UnitPicker.svelte';
  import { portal } from '../lib/portal.js';
  import { decimalInput, parseDecimal } from '../lib/decimal-input.js';
  import { scaleFactor as _unitScaleFactor, unitSystem as _unitSystem, amountAndUnit } from '../lib/units.js';
  import { diaryPromptQuantity, warnUnitMismatch, showUnitMetadata, forceMobileLayout } from '../stores/settings.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { editorState, clearFoodEditorState } from '../stores/editorState.js';
  import { DB, localDateStr } from '../lib/db.js';
  import { loadEntry } from '../stores/diary.js';
  import { API, USDA, NtApi } from '../lib/api.js';
  import { Nutrition } from '../lib/nutrition.js';
  import { Mealie } from '../lib/mealieApi.js';
  import { resolveAssetUrl } from '../lib/platform.js';
  import { offCountryTagToFlag, offCountryTagToName } from '../lib/off-country-flag.js';
  import { foodsShowThumbnails, foodsShowCategories, foodsShowLabels, foodsShowNotes, foodsSort, mealsSort, recipesSort, foodCategories, foodsShowYesterdayMeals, foodsYesterdayCollapsed, foodsSavedCollapsed, mealNames, usdaEnabled, usdaApiKey, offEnabled, offSearchCountry, offSearchLanguage, foodsDefaultSource, catName as _catName, catDisplay as _catDisplay, pageBanners, bannerStyle, energyUnit } from '../stores/settings.js';
  import { mealIcon } from '../lib/mealIcon.js';

  // Query string params
  function qs() {
    const hash = window.location.hash;
    const qIdx = hash.indexOf('?');
    if (qIdx < 0) return {};
    return Object.fromEntries(new URLSearchParams(hash.slice(qIdx + 1)));
  }

  $: params = qs();
  $: pickMode  = params.pick === '1';
  $: pickMeal  = params.meal;
  $: pickDate  = params.date;

  const TABS = [
    { label: 'Foods',   value: 'foodList' },
    { label: 'Meals',   value: 'meals' },
    { label: 'Recipes', value: 'recipes' },
  ];
  let activeTab = 0;
  // Reset source + category filter when switching tabs (not when searchSource itself changes)
  let _prevTab = activeTab;
  $: if (activeTab !== _prevTab) {
    _prevTab = activeTab;
    activeCategoryFilter = '';
    // Re-poll sharing counts so the From Others filter appears for the new
    // tab's category if a peer just shared something.
    refreshSharingStatus();
    // Non-foods tabs only support local + shared — silently reset if the
    // current source isn't valid here (toast removed; common-sense reset).
    if (activeTab !== 0 && searchSource !== 'local' && searchSource !== 'shared') searchSource = 'local';
    if (searchSource === 'shared' && !_tabHasShared) searchSource = 'local';
  }

  // Reset scroll so the new tab starts from the top.
  // Click handler runs BEFORE bind propagation, so first reset happens before
  // reactive blocks/DOM updates fire. rAF pass catches any restore after layout.
  function onTabChange() {
    const reset = () => {
      const sc = document.querySelector('.page-transition') || document.scrollingElement || document.documentElement;
      if (sc) sc.scrollTop = 0;
      window.scrollTo(0, 0);
    };
    reset();
    requestAnimationFrame(reset);
  }
  $: _tabIcon = activeTab === 0 ? 'restaurant' : activeTab === 1 ? 'dinner_dining' : 'menu_book';
  $: { if (pickMode) loadYesterdayMeals(); }
  // Saved-meals collapse only kicks in when the SAVED MEALS header is actually rendered
  // (Meals tab + pick mode + yesterday section visible + not searching). Otherwise the
  // header isn't shown and the user has no way to toggle it back, so the list must render.
  $: _savedMealsHeaderVisible = pickMode && activeTab === 1 && yesterdayMeals.length > 0 && !search;
  $: _hideSavedMealsList = _savedMealsHeaderVisible && $foodsSavedCollapsed;

  let search = '';
  // Initial source chip. Reads the user's saved default (Settings → Foods →
  // Default search source). Requested via #128 — power users who add new
  // foods frequently prefer 'all' so it fans out to OFF/USDA/Mealie on
  // every visit rather than starting on My Foods. Existing users default
  // to 'local' (unchanged behaviour).
  let searchSource = foodsDefaultSource.get() || 'local';
  const _mealieEnabled = DB.getSetting('mealieEnabled',  false);
  // OFF / USDA / Mealie are food databases — only meaningful on the Foods tab.
  // Meals + Recipes tabs only get Local + From Others (when shared content exists).
  // 'all' (issue #96) is prepended once there are >= 2 sources so the option
  // is only offered when it actually merges something. Fires everything in
  // parallel and shows results grouped by source with per-row source badges.
  $: _perSourceOptions = [
    { value: 'local',  label: $_('foods.sources.local')  },
    ...(activeTab === 0 && $offEnabled    ? [{ value: 'off',    label: 'OFF' }] : []),
    ...(activeTab === 0 && $usdaEnabled   ? [{ value: 'usda',   label: 'USDA' }] : []),
    ...(activeTab === 0 && _mealieEnabled ? [{ value: 'mealie', label: 'Mealie' }] : []),
    ...(_tabHasShared  ? [{ value: 'shared', label: $_('foods.sources.from_others') }] : []),
  ];
  $: availableSources = _perSourceOptions.length >= 2
    ? [{ value: 'all', label: $_('foods.sources.all') }, ..._perSourceOptions]
    : _perSourceOptions;
  $: _sourceLabel = availableSources.find(s => s.value === searchSource)?.label || '';

  // ── Per-source quality-tier filters ──────────────────────────────────────
  // Backdrop-pattern dropdown attached to the OFF + USDA source chips (via
  // caret). Multi-select checkboxes, default all-active (no filter).
  // Filters apply client-side after fetch, only when the specific source
  // is active — not in 'all' mode.
  //
  // Implementation follows ActionSheet.svelte's proven pattern:
  //   1. Backdrop covers full viewport, portalled to body
  //   2. Panel is INSIDE the backdrop, uses on:click|stopPropagation
  //   3. Backdrop's on:click closes (target === currentTarget check)
  //   4. Regular on:click (NOT pointerdown) — reliable across Android WebView
  //
  // OFF tiers = the same buckets our completeness dot uses (green ≥70%,
  // yellow 40-70%, grey <40%; "unknown" for entries OFF didn't populate).
  // USDA tiers = the actual dataType values USDA returns; matches the
  // tier badge letters (F, L, S, B, X).
  const _OFF_TIERS = ['hi', 'mid', 'lo', 'unknown'];
  const _USDA_TIERS = ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded', 'Experimental', 'unknown'];
  let offTiersActive  = new Set(_OFF_TIERS);
  let usdaTiersActive = new Set(_USDA_TIERS);
  let offDropdownOpen  = false;
  let usdaDropdownOpen = false;
  let offCaretEl = null;
  let usdaCaretEl = null;
  let offDropdownPos  = { top: 0, right: 0 };
  let usdaDropdownPos = { top: 0, right: 0 };

  // ── Multi-select source chips (long-press to add) ─────────────────────
  // pinnedSources holds sources the user has explicitly pinned via long-
  // press. When any are pinned we enter "multi mode": searchSource flips
  // to 'all' (triggering the existing merged fan-out), and _allModeItems
  // is filtered to only show items from pinned sources. Tap on any chip
  // exits multi mode. Reduces to single-source cleanly when the pinned
  // set drops to 1.
  let pinnedSources = new Set();
  let _lpChipTimer = null;
  let _lpChipStartX = 0;
  let _lpChipStartY = 0;
  // Set true when a long-press just fired, cleared shortly after. Guards
  // _onChipTap from running the click that Android WebView sometimes
  // emits after a long-press (would immediately undo the multi-select
  // and drop back to single-source mode).
  let _lpChipJustFired = false;
  function _startChipLongPress(sourceValue, e) {
    const t = e?.touches?.[0];
    _lpChipStartX = t?.clientX ?? 0;
    _lpChipStartY = t?.clientY ?? 0;
    clearTimeout(_lpChipTimer);
    _lpChipTimer = setTimeout(() => {
      _lpChipTimer = null;
      _toggleChipInMulti(sourceValue);
    }, 500);
  }
  // Movement-thresholded cancel — only kill the timer when the finger has
  // actually moved more than ~10px. Without the threshold the chip row's
  // horizontal-scroll overflow causes the browser to fire touchmove events
  // proactively (to test for pan intent), which cancels the long-press
  // timer before it ever fires. Foods list rows don't have this issue
  // because they don't sit inside an overflow-scroll container.
  function _maybeCancelChipLongPress(e) {
    if (!_lpChipTimer) return;
    const t = e?.touches?.[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - _lpChipStartX);
    const dy = Math.abs(t.clientY - _lpChipStartY);
    if (dx > 10 || dy > 10) _cancelChipLongPress();
  }
  function _cancelChipLongPress() {
    if (_lpChipTimer) { clearTimeout(_lpChipTimer); _lpChipTimer = null; }
  }
  function _toggleChipInMulti(sourceValue) {
    // 'all' is meaningless in multi mode (it already IS all sources).
    if (sourceValue === 'all') return;
    // Guard against double-fire from contextmenu + touchstart-timer both
    // firing on the same long-press. First one wins; second and any
    // trailing synthetic click event are suppressed for 400ms.
    if (_lpChipJustFired) return;
    _lpChipJustFired = true;
    setTimeout(() => { _lpChipJustFired = false; }, 400);

    const s = new Set(pinnedSources);
    if (s.has(sourceValue)) {
      s.delete(sourceValue);
    } else {
      // First pin: seed with the currently-active single source so we
      // don't accidentally deselect it when adding the second source.
      if (s.size === 0 && searchSource !== 'all' && searchSource !== sourceValue) {
        s.add(searchSource);
      }
      s.add(sourceValue);
    }
    if (s.size <= 1) {
      // Fall back to single-source mode — multi with only one source is
      // functionally identical to just selecting that source normally.
      pinnedSources = new Set();
      if (s.size === 1) searchSource = [...s][0];
    } else {
      pinnedSources = s;
      searchSource = 'all';   // triggers existing all-mode fan-out
    }
  }
  // Pre-compute active flags for each chip in a plain object so the
  // template's `class:active={activeChips[v]}` has a static dependency
  // Svelte can track. Previously used a derived function which Svelte's
  // static analysis couldn't tie to pinnedSources/searchSource, so the
  // chip highlight never updated after a long-press even though the
  // pinned set was correctly updated (verified via adb logcat).
  $: activeChips = {
    local:  pinnedSources.size > 0 ? pinnedSources.has('local')  : searchSource === 'local',
    off:    pinnedSources.size > 0 ? pinnedSources.has('off')    : searchSource === 'off',
    usda:   pinnedSources.size > 0 ? pinnedSources.has('usda')   : searchSource === 'usda',
    mealie: pinnedSources.size > 0 ? pinnedSources.has('mealie') : searchSource === 'mealie',
    shared: pinnedSources.size > 0 ? pinnedSources.has('shared') : searchSource === 'shared',
    all:    pinnedSources.size === 0 && searchSource === 'all',
  };
  // Tap handler: exits multi mode and single-selects the tapped source.
  // Guarded against the synthetic click Android WebView emits after a
  // long-press — otherwise the long-press-to-add flow would immediately
  // reset to single-select mode.
  function _onChipTap(sourceValue) {
    _cancelChipLongPress();
    // Guard against the synthetic click Android WebView emits after a
    // long-press — otherwise the long-press-to-add flow would immediately
    // reset to single-select mode.
    if (_lpChipJustFired) return;
    pinnedSources = new Set();
    searchSource = sourceValue;
  }
  // Small helper for _allModeItems below.
  function _isSourceActive(name) {
    return pinnedSources.size === 0 || pinnedSources.has(name);
  }

  function _bucketOff(c) {
    if (typeof c !== 'number') return 'unknown';
    if (c >= 0.7) return 'hi';
    if (c >= 0.4) return 'mid';
    return 'lo';
  }

  function toggleOffTier(t) {
    const s = new Set(offTiersActive);
    if (s.has(t)) s.delete(t); else s.add(t);
    // Refuse to hide everything — user would see zero results with no
    // clear recourse. Keep at least one tier active at all times.
    if (s.size === 0) s.add(t);
    offTiersActive = s;
  }
  function toggleUsdaTier(t) {
    const s = new Set(usdaTiersActive);
    if (s.has(t)) s.delete(t); else s.add(t);
    if (s.size === 0) s.add(t);
    usdaTiersActive = s;
  }
  function resetOffTiers()  { offTiersActive  = new Set(_OFF_TIERS); }
  function resetUsdaTiers() { usdaTiersActive = new Set(_USDA_TIERS); }

  $: offTiersFiltered  = offTiersActive.size  !== _OFF_TIERS.length;
  $: usdaTiersFiltered = usdaTiersActive.size !== _USDA_TIERS.length;

  // Derived visible results — filters apiResults per the active tier
  // set. Only applies for the dedicated OFF or USDA source; 'all' mode
  // keeps the raw mixed list.
  $: visibleApiResults = (() => {
    if (searchSource === 'off' && offTiersFiltered) {
      return apiResults.filter(f => offTiersActive.has(_bucketOff(f.completeness)));
    }
    if (searchSource === 'usda' && usdaTiersFiltered) {
      return apiResults.filter(f => usdaTiersActive.has(f.dataType || 'unknown'));
    }
    return apiResults;
  })();

  function openOffDropdown() {
    usdaDropdownOpen = false;
    const r = offCaretEl?.getBoundingClientRect();
    if (r) offDropdownPos = { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) };
    offDropdownOpen = true;
  }
  function openUsdaDropdown() {
    offDropdownOpen = false;
    const r = usdaCaretEl?.getBoundingClientRect();
    if (r) usdaDropdownPos = { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) };
    usdaDropdownOpen = true;
  }

  // Dismiss the tier dropdowns via window-level events. Backdrop is
  // pointer-events:none so touches pass through — dismiss instead relies
  // on click / touchmove / scroll bubbling up to window. Panel clicks
  // are stopped inline with on:click|stopPropagation so they don't reach
  // here. Caret clicks are checked by .contains() so tapping the same
  // caret again correctly toggles (open handler runs after our close).
  let offDropdownPanelEl = null;
  let usdaDropdownPanelEl = null;
  function _closeTierDropdowns() {
    offDropdownOpen = false;
    usdaDropdownOpen = false;
  }
  function _onWindowClick(e) {
    if (!offDropdownOpen && !usdaDropdownOpen) return;
    const t = e.target;
    if (offCaretEl && offCaretEl.contains(t)) return;
    if (usdaCaretEl && usdaCaretEl.contains(t)) return;
    if (offDropdownPanelEl  && offDropdownPanelEl.contains(t))  return;
    if (usdaDropdownPanelEl && usdaDropdownPanelEl.contains(t)) return;
    _closeTierDropdowns();
  }
  function _onWindowTouchMove() {
    // Any touch drag anywhere = user is scrolling; close dropdown.
    // Since backdrop is pointer-events:none the touch actually landed
    // on the underlying element, so the scroll happens natively while
    // we dismiss.
    if (offDropdownOpen || usdaDropdownOpen) _closeTierDropdowns();
  }

  // Sharing — "From Others" source filter (per-category)
  let sharingEnabled = false;
  let sharedCounts = { foods: 0, meals: 0, recipes: 0 };
  $: _tabHasShared = activeTab === 0 ? sharedCounts.foods > 0 : activeTab === 1 ? sharedCounts.meals > 0 : sharedCounts.recipes > 0;
  function refreshSharingStatus() {
    NtApi.getSharingStatus().then(s => {
      sharingEnabled = s.sharing_enabled === true;
      sharedCounts = { foods: s.foods || 0, meals: s.meals || 0, recipes: s.recipes || 0 };
    }).catch(() => {});
  }
  let groupFoods = [];
  let groupMeals = [];
  let groupRecipes = [];
  let loadingGroup = false;

  async function loadGroupCatalogue() {
    if (!sharingEnabled) return;
    loadingGroup = true;
    try {
      [groupFoods, groupMeals, groupRecipes] = await Promise.all([
        NtApi.getGroupFoods(),
        NtApi.getGroupMeals(),
        NtApi.getGroupRecipes(),
      ]);
    } catch(e) { console.error('[foods] group load error:', e); showError('Could not load shared items'); }
    finally { loadingGroup = false; }
  }

  async function copyAndUse(food) {
    try {
      const isMeal = activeTab === 1 || activeTab === 2;
      return isMeal ? await NtApi.copyMeal(food.id) : await NtApi.copyFood(food.id);
    } catch(e) {
      showError('Could not copy item: ' + e.message);
      return null;
    }
  }

  let localFoods = [];
  let localMeals = [];
  let localRecipes = [];
  // apiResults still holds OFF or USDA results in single-source modes (only
  // one of the two can be active at a time). In 'all' mode, OFF and USDA
  // populate offResults / usdaResults separately so both can render together
  // alongside mealieResults, local matches, and shared matches. #96.
  let apiResults = [];
  let offResults = [];
  let usdaResults = [];
  let mealieResults = [];
  let loading = false;
  let loadError = false;
  // #178 — true while the initial getFoods/getMeals/getRecipes batch is in
  // flight on mount, false once it resolves (success or failure). Gates the
  // render so a slow server doesn't show "No foods yet" over the user's
  // actual library — that empty state was misread as "the app forgot my data".
  let _initialLoading = true;
  let mealieLoading = false;
  let searchTimeout = null;
  // Pagination state for single-source OFF / USDA modes. Both use the
  // shared apiResults array (only one of the two can be active at a time)
  // so a single set of page/total/hasMore fields suffices. When the user
  // scrolls to the bottom sentinel, loadMoreExternal() fetches the next
  // page and appends to apiResults. #96.
  let apiPage = 1;
  let apiTotalHits = 0;
  let apiHasMore = false;
  let apiLoadingMore = false;
  // Per-source pagination state for ALL mode (separate from single-source
  // state so each external source can page independently within the
  // merged view). loadMoreAll() fetches the next page from every source
  // with hasMore=true when the ALL-mode sentinel scrolls into view.
  let _allOffPage = 1, _allOffHasMore = false, _allOffTotal = 0;
  let _allUsdaPage = 1, _allUsdaHasMore = false, _allUsdaTotal = 0;
  let _allMealiePage = 1, _allMealieHasMore = false, _allMealieTotal = 0;
  let _allLoadingMore = false;
  // Smaller pages in ALL mode than single-source: keeps the merged
  // first-render snappy (3 sources at 20 = up to 60 external items) vs
  // single-source at 50 where users are deliberately going deep. Held
  // constant per query because APIs skip items when pageSize varies
  // between sequential pageNumber requests.
  const ALL_MODE_PAGE_SIZE = 20;

  let showItemActions = false;
  let selectedItem = null;
  let showDeleteDialog = false;
  let scannerOpen = false;
  let showQtyPrompt = false;
  let _qtyPromptPortionEl = null;
  // Autofocus the portion input the moment the qty-prompt sheet opens
  // so a user tapping "Add to Diary" on a food can start typing quantity
  // immediately instead of tapping the field first. #170.
  // #170 follow-up (drekkym on 2026-08-26): also select the existing
  // value so typing replaces it instead of appending. Matches the
  // Body Stats weight-edit pattern the user called out as the
  // reference. Same applied to every other sheet on this page.
  $: if (showQtyPrompt) tick().then(() => { _qtyPromptPortionEl?.focus(); _qtyPromptPortionEl?.select?.(); });
  // Enter anywhere in the sheet submits (mirrors QuickCalories + water
  // custom + activity flows). Guarded to not fire inside a select/textarea.
  function _onQtyPromptKey(e) {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    e.preventDefault();
    if (!_addingToDiary) confirmQtyPrompt();
  }
  let promptFood = null;
  let promptServings = 1;
  let promptPortion = 100;
  // Phase 2 of the NutritionFactsBox rollout: tap a food on the Foods tab
  // now opens this slide-up read-only sheet instead of the full FoodEditor
  // route. Edit button on the sheet still routes to the editor for any
  // changes the user wants to make.
  let detailSheetOpen = false;
  let detailSheetFood = null;
  // Desktop detail-pane state (Phase B). When the viewport is wide
  // enough (≥1440px) AND force-mobile-layout is off, tapping a food
  // populates this pane instead of opening the modal FoodDetailSheet.
  // The pane is sticky-positioned in the third column of .foods-body.
  let _paneFood = null;
  let _foodsViewportPane = false;
  $: _foodsPaneMode = _foodsViewportPane && !$forceMobileLayout;
  // Phase D — keyboard shortcut plumbing. bind:this from the search
  // input above; focused via ⌘K / Ctrl-K / '/' when the user isn't
  // already typing in another field.
  let _searchInputEl = null;
  let promptUnit = 'g';

  // Reactive nutrition preview for the qty prompt — recomputes whenever
  // portion/unit/servings change so the macro pills above the "Add to
  // Diary" button always reflect what the user is about to commit. Mirrors
  // the editCalc pattern in Diary.svelte's edit sheet. Fixes #30.
  $: qtyCalc = (() => {
    if (!promptFood) return {};
    const origPortion = parseFloat(promptFood.portion) || 100;
    const origUnit    = promptFood.unit || 'g';
    const newPortion  = parseDecimal(promptPortion) || origPortion;
    // Pass promptFood as the food so the scaler uses per-food alt_units and
    // density when set. Issues #69 + #70.
    const factor      = _unitScaleFactor(origPortion, origUnit, newPortion, promptUnit || origUnit, promptFood);
    const scaledNutrition = promptFood.nutrition
      ? Object.fromEntries(Object.entries(promptFood.nutrition).map(([k, v]) => [k, (parseFloat(v) || 0) * factor]))
      : promptFood.nutrition;
    return Nutrition.calculate({ ...promptFood, nutrition: scaledNutrition, quantity: parseDecimal(promptServings) || 1 });
  })();
  $: _qtyEnergy = Nutrition.displayEnergy(qtyCalc.calories || 0, $energyUnit);
  let activeCategoryFilter = ''; // '' = all
  let yesterdayMeals = []; // { mealIdx, mealName, items, totalKcal } — only in pick mode
  let yesterdayInfoGroup = null; // group whose detail sheet is currently open
  let _yesterdayImgFailed = new Set(); // items whose thumbnail failed to load — fall back to placeholder
  let mealInfoGroup = null; // saved meal/recipe whose contents sheet is open
  let _mealInfoImgFailed = new Set();

  function openMealInfo(food) {
    const items = food.items || [];
    const totalKcal = Nutrition.sum(items.map(i => Nutrition.calculate(i))).calories || 0;
    mealInfoGroup = { food, mealName: food.name, items, totalKcal, isRecipe: !!food.is_recipe };
    _mealInfoImgFailed = new Set();
  }

  // Multi-select (pick mode only)
  let selectedFoods = new Set();      // Set<food object reference>
  let showMultiPortionSheet = false;
  let multiPortionItems = [];         // [{ food, portion, unit, servings }]
  let _multiPortionSheetEl = null;
  // Same autofocus + Enter-submit treatment as the single qty prompt (#170).
  // Query the first portion input inside the sheet root after mount so we
  // don't have to bind ref per-item — cleaner with the {#each} loop.
  $: if (showMultiPortionSheet) tick().then(() => {
    const _first = _multiPortionSheetEl?.querySelector('input[type="text"][inputmode="decimal"]');
    _first?.focus();
    _first?.select?.();
  });
  function _onMultiPortionKey(e) {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    e.preventDefault();
    if (!multiAdding) confirmMultiPortionSheet();
  }
  let multiAdding = false;
  // Guards every add-to-diary path (single, direct-click, meal expand, copy).
  // Without it, a mash-click during a slow write fires the add N times and
  // the diary ends up with N duplicate rows. Issue #156.
  let _addingToDiary = false;

  // Manage mode: multi-select for bulk delete of the current tab's local
  // items. Entered from the item action sheet on a local item. Mutually
  // exclusive with pickMode (pickMode is the add-to-diary flow).
  let manageMode = false;
  let manageSelected = new Set();      // Set<item id>
  let showBulkDeleteDialog = false;
  let bulkDeleting = false;

  // Clear selection when tab changes (different list context); search does NOT clear selection.
  // Also exit manage mode on tab change so the count reflects the new list.
  $: { activeTab; selectedFoods = new Set(); manageMode = false; manageSelected = new Set(); }
  // Clear the desktop detail pane on tab or filter change so users
  // don't see a "ghost" preview of a food that isn't in the newly-
  // filtered list. Applies to the pane; the modal sheet is user-
  // dismissed so it doesn't need this treatment.
  $: { activeTab; searchSource; activeCategoryFilter; _paneFood = null; }

  // Convert item portions to grams for total serving display
  const _toG = { g:1, ml:1, oz:28.35, lb:453.59, cup:240, tbsp:15, tsp:5 };
  function mealServing(items) {
    if (!items?.length) return '0g';
    const total = items.reduce((s, i) => s + (parseFloat(i.portion)||0) * (_toG[i.unit] ?? 1), 0);
    return `${Math.round(total)}g`;
  }

  $: currentStore = TABS[activeTab].value;
  $: _ownList = activeTab === 0 ? localFoods : activeTab === 1 ? localMeals : localRecipes;
  $: _groupList = activeTab === 0 ? groupFoods : activeTab === 1 ? groupMeals : groupRecipes;
  $: displayList = searchSource === 'shared' ? _groupList : _ownList;
  $: { if (searchSource === 'shared' && _tabHasShared && !groupFoods.length && !groupMeals.length && !groupRecipes.length) loadGroupCatalogue(); }
  // 'all' mode (#96) needs the shared catalogue loaded too so shared items can
  // participate in the merged results without the user having to first flip
  // to the 'shared' chip.
  $: { if (searchSource === 'all' && _tabHasShared && !groupFoods.length && !groupMeals.length && !groupRecipes.length) loadGroupCatalogue(); }

  // Merged results for 'all' mode. Each entry is { source, item } so the row
  // renderer can dispatch the right pick action and stamp the right badge.
  // Ordering: Local first (user's own data), then Shared, then Mealie
  // (self-hosted curated), then OFF (community brand-name catalogue), then
  // USDA (verified generic reference). OFF-before-USDA matches how users
  // actually search — familiar brand-name products usually come from OFF
  // (Nutella, Cheerios); USDA is stronger on generic/verified nutrition
  // reference entries and reads naturally as the "fallback / dig deeper"
  // tier below the brand-name results.
  // _allModeItems runs in 'all' mode (either the user tapped 'All' OR they
  // entered multi mode via long-press, which flips searchSource to 'all').
  // The _isSourceActive() gate short-circuits any sources the user has
  // filtered out via multi-select — pinned set empty = show everything
  // (regular all mode), pinned set populated = show only those sources.
  //
  // The OFF completeness + USDA data-type tier filters ALSO apply here
  // (not just in dedicated OFF/USDA single-source mode) — filtering
  // happens at the item level so multi-source results still honour the
  // user's tier picks within each source.
  $: _allModeItems = searchSource !== 'all' ? [] : [
    ...(_isSourceActive('local')  ? (_ownList || []).filter(f => search.trim() ? _fuzzyMatch(f, search) : false).map(item => ({ source: 'local',  item })) : []),
    ...(_isSourceActive('shared') && _tabHasShared ? (_groupList || []).filter(f => search.trim() ? _fuzzyMatch(f, search) : false).map(item => ({ source: 'shared', item })) : []),
    ...(_isSourceActive('mealie') ? (mealieResults || []).map(item => ({ source: 'mealie', item })) : []),
    ...(_isSourceActive('off')    ? (offResults    || []).filter(f => !offTiersFiltered  || offTiersActive.has(_bucketOff(f.completeness))).map(item => ({ source: 'off',    item })) : []),
    ...(_isSourceActive('usda')   ? (usdaResults   || []).filter(f => !usdaTiersFiltered || usdaTiersActive.has(f.dataType || 'unknown')).map(item => ({ source: 'usda',   item })) : []),
  ];

  function _pickBySource(source, item) {
    if (source === 'mealie') return pickMealieRecipe(item);
    // Pass source through so pickFood can trigger the OFF v3 hydration
    // step (search-a-licious hits lack serving_size + _serving nutriments).
    return pickFood(item, source);  // local + shared + off + usda all go through pickFood
  }

  // Fetch the next page of the currently-active external source and append
  // to apiResults. Triggered by the IntersectionObserver on the bottom
  // sentinel; also guarded so a fast scroller can't fire multiple in-flight
  // requests. #96. ALL mode doesn't call this — that view stays capped per
  // source so the merged list stays scannable.
  async function loadMoreExternal() {
    if (apiLoadingMore || !apiHasMore || !search.trim()) return;
    if (searchSource !== 'off' && searchSource !== 'usda') return;
    apiLoadingMore = true;
    const nextPage = apiPage + 1;
    try {
      const r = searchSource === 'off'
        ? await API.searchByNameWithMeta(search, nextPage)
        : await USDA.searchByNameWithMeta(search, nextPage, usdaApiKey.get());
      // De-dup on stable id (avoids double-inserts if the API returns
      // overlap between pages, which USDA occasionally does for common terms).
      const seen = new Set(apiResults.map(x => x.id ?? x.barcode ?? x.name));
      const fresh = (r.items || []).filter(x => !seen.has(x.id ?? x.barcode ?? x.name));
      apiResults = [...apiResults, ...fresh];
      apiPage = r.page;
      apiHasMore = r.hasMore;
      apiTotalHits = r.totalHits;
    } catch (e) {
      console.warn('[foods] loadMore failed:', e);
    } finally {
      apiLoadingMore = false;
    }
  }

  // Svelte action: fires onIntersect once each time the observed node
  // enters the viewport (with 240px rootMargin so we start loading before
  // the user reaches the very bottom — smoother than "load exactly at end").
  function _infiniteScroll(node, { onIntersect }) {
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) onIntersect();
    }, { rootMargin: '240px' });
    observer.observe(node);
    return { destroy() { observer.disconnect(); } };
  }

  // ALL-mode counterpart of loadMoreExternal. Fires the next page of any
  // external source that still has hasMore=true, running them in parallel.
  // Merges appended items into their per-source arrays; the reactive
  // _allModeItems rebuilds the merged list in source order. Local + shared
  // are never paginated (they're already fully in memory and filtered by
  // the search term). #96.
  async function loadMoreAll() {
    if (_allLoadingMore || !search.trim() || searchSource !== 'all') return;
    if (!_allOffHasMore && !_allUsdaHasMore && !_allMealieHasMore) return;
    _allLoadingMore = true;
    const jobs = [];
    const dedupAppend = (existing, incoming, keyOf) => {
      const seen = new Set(existing.map(keyOf));
      return [...existing, ...incoming.filter(x => !seen.has(keyOf(x)))];
    };
    if (_allOffHasMore) {
      jobs.push(API.searchByNameWithMeta(search, _allOffPage + 1, ALL_MODE_PAGE_SIZE)
        .then(r => {
          offResults = dedupAppend(offResults, r.items || [], x => x.id ?? x.barcode ?? x.name);
          _allOffPage = r.page; _allOffHasMore = r.hasMore; _allOffTotal = r.totalHits;
        })
        .catch(() => {}));
    }
    if (_allUsdaHasMore) {
      const key = usdaApiKey.get();
      jobs.push(USDA.searchByNameWithMeta(search, _allUsdaPage + 1, key, ALL_MODE_PAGE_SIZE)
        .then(r => {
          usdaResults = dedupAppend(usdaResults, r.items || [], x => x.id ?? x.barcode ?? x.name);
          _allUsdaPage = r.page; _allUsdaHasMore = r.hasMore; _allUsdaTotal = r.totalHits;
        })
        .catch(() => {}));
    }
    if (_allMealieHasMore) {
      jobs.push(Mealie.searchWithMeta(search, _allMealiePage + 1, ALL_MODE_PAGE_SIZE)
        .then(r => {
          mealieResults = dedupAppend(mealieResults, r.items || [], x => x.id ?? x.slug ?? x.name);
          _allMealiePage = r.page; _allMealieHasMore = r.hasMore; _allMealieTotal = r.totalHits;
        })
        .catch(() => {}));
    }
    try { await Promise.all(jobs); }
    finally { _allLoadingMore = false; }
  }

  // Aggregate hasMore across ALL-mode external sources — sentinel + footer
  // only render while at least one source still has pages left.
  $: _allHasMoreAny = _allOffHasMore || _allUsdaHasMore || _allMealieHasMore;
  function _editDist(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  }

  function _fuzzyMatch(food, q) {
    const name  = (food.name  || '').toLowerCase();
    const brand = (food.brand || '').toLowerCase();
    const combined = name + (brand ? ' ' + brand : '');
    const qLow = q.toLowerCase().trim();
    if (!qLow) return true;
    // 1. Exact substring (current behavior)
    if (combined.includes(qLow)) return true;
    // 2. All query words appear somewhere
    const qWords = qLow.split(/\s+/);
    if (qWords.length > 1 && qWords.every(w => combined.includes(w))) return true;
    // 3. Fuzzy per-word: each query word matches a target word within edit distance 1
    const tWords = combined.split(/\s+/);
    return qWords.every(qw =>
      qw.length >= 4 && tWords.some(tw => tw.length >= 3 && _editDist(qw, tw) <= 1)
    );
  }

  $: filteredBySearch = search
    ? displayList.filter(f => _fuzzyMatch(f, search))
    : displayList;
  $: filteredList = activeCategoryFilter
    ? filteredBySearch.filter(f => (f.categories||[]).includes(activeCategoryFilter))
    : filteredBySearch;

  // Returns a NEW sorted array. Don't mutate in-place: under Svelte 5
  // compat mode the reactive cascade (_ownList → displayList → filteredList)
  // fires on the assignment-write and snapshots the array before an
  // in-place sort can take effect, so the rendered list never reorders.
  function _applySort(arr, mode) {
    const sorted = [...(arr || [])];
    if (mode === 'recent') {
      // Recently Used: most recent last_used_at first; items never used
      // sort to the end alphabetically.
      sorted.sort((a, b) => {
        const al = a.last_used_at || '';
        const bl = b.last_used_at || '';
        if (al && bl) return bl.localeCompare(al);
        if (al) return -1;
        if (bl) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
    } else if (mode === 'most') {
      // Most Used: highest usage_count first; ties broken alphabetically.
      sorted.sort((a, b) => {
        const d = (b.usage_count || 0) - (a.usage_count || 0);
        if (d !== 0) return d;
        return (a.name || '').localeCompare(b.name || '');
      });
    } else {
      // Alphabetical (default)
      sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
    return sorted;
  }

  async function load() {
    loadError = false;
    try {
      const [foods, meals, recipes] = await Promise.all([
        NtApi.getFoods(),
        NtApi.getMeals(),
        NtApi.getRecipes(),
      ]);
      localFoods   = _applySort(foods,   foodsSort.get());
      localMeals   = _applySort(meals,   mealsSort.get());
      localRecipes = _applySort(recipes, recipesSort.get());
    } catch(e) {
      console.error('[foods] load error:', e);
      loadError = true;
    } finally {
      _initialLoading = false;
    }
  }

  async function onSearch() {
    clearTimeout(searchTimeout);
    apiResults = [];
    offResults = [];
    usdaResults = [];
    mealieResults = [];
    // Reset pagination on every fresh search — new query means starting
    // over at page 1 with no accumulated results.
    apiPage = 1;
    apiTotalHits = 0;
    apiHasMore = false;
    // Local + shared don't need remote calls; 'all' mode always needs the
    // debounce because it fans out to external APIs alongside local filter.
    if (!search.trim() || searchSource === 'local' || searchSource === 'shared') return;
    const src = searchSource;
    searchTimeout = setTimeout(async () => {
      if (activeTab !== 0) return;
      if (src === 'off') {
        try {
          loading = true;
          const r = await API.searchByNameWithMeta(search, 1);
          apiResults = r.items;
          apiTotalHits = r.totalHits;
          apiHasMore = r.hasMore;
          apiPage = r.page;
        } catch { apiResults = []; apiTotalHits = 0; apiHasMore = false; }
        finally { loading = false; }
      } else if (src === 'usda') {
        try {
          loading = true;
          const key = usdaApiKey.get();
          const r = await USDA.searchByNameWithMeta(search, 1, key);
          apiResults = r.items;
          apiTotalHits = r.totalHits;
          apiHasMore = r.hasMore;
          apiPage = r.page;
        } catch { apiResults = []; apiTotalHits = 0; apiHasMore = false; }
        finally { loading = false; }
      } else if (src === 'mealie') {
        try {
          mealieLoading = true;
          mealieResults = await Mealie.search(search) || [];
        } catch { mealieResults = []; }
        finally { mealieLoading = false; }
      } else if (src === 'all') {
        // Parallel fan-out to every enabled external source. Each promise
        // catches its own error so one failing API doesn't nuke the others
        // (Promise.all fail-fast would kill the whole merge). Local + shared
        // results come from reactive state already loaded — no fetch here.
        // Uses *WithMeta variants so pagination state can drive the ALL-mode
        // sentinel via loadMoreAll(). Previous version capped at 10 per
        // source; now returns the full first page (50 per external source)
        // and paginates on scroll for parity with single-source mode. #96.
        _allOffPage = _allUsdaPage = _allMealiePage = 1;
        _allOffHasMore = _allUsdaHasMore = _allMealieHasMore = false;
        _allOffTotal = _allUsdaTotal = _allMealieTotal = 0;
        const jobs = [];
        const usesOffOrUsda = $offEnabled || $usdaEnabled;
        loading = usesOffOrUsda;
        mealieLoading = _mealieEnabled;
        if ($offEnabled) {
          jobs.push(API.searchByNameWithMeta(search, 1, ALL_MODE_PAGE_SIZE)
            .then(r => {
              offResults = r.items || [];
              _allOffTotal = r.totalHits; _allOffHasMore = r.hasMore; _allOffPage = r.page;
            })
            .catch(() => { offResults = []; }));
        }
        if ($usdaEnabled) {
          const key = usdaApiKey.get();
          jobs.push(USDA.searchByNameWithMeta(search, 1, key, ALL_MODE_PAGE_SIZE)
            .then(r => {
              usdaResults = r.items || [];
              _allUsdaTotal = r.totalHits; _allUsdaHasMore = r.hasMore; _allUsdaPage = r.page;
            })
            .catch(() => { usdaResults = []; }));
        }
        if (_mealieEnabled) {
          jobs.push(Mealie.searchWithMeta(search, 1, ALL_MODE_PAGE_SIZE)
            .then(r => {
              mealieResults = r.items || [];
              _allMealieTotal = r.totalHits; _allMealieHasMore = r.hasMore; _allMealiePage = r.page;
            })
            .catch(() => { mealieResults = []; }));
        }
        try { await Promise.all(jobs); }
        finally { loading = false; mealieLoading = false; }
      }
    }, 400);
  }

  async function pickMealieRecipe(summary) {
    try {
      const full = await Mealie.getRecipe(summary.slug);
      if (!full) { showError('Could not load recipe from Mealie'); return; }
      const mapped = Mealie.mapRecipe(full);
      openEditor(mapped, 'foodList');
    } catch(e) {
      showError('Failed to import from Mealie');
    }
  }

  // Re-run search when query, source, or OFF filters change (country + language).
  // Country change is rare in practice (setting lives in Settings) but keeping
  // the reactive means switching either one takes effect immediately without
  // needing to retype the query.
  $: { search; searchSource; $offSearchCountry; $offSearchLanguage; onSearch(); }

  function _saveScrollState() {
    editorState.foodsScrollY   = window.scrollY;
    editorState.foodsActiveTab = activeTab;
  }

  function openEditor(item, store) {
    _saveScrollState();
    editorState.foodPrefill = item ? { ...item } : null;
    editorState.foodStore   = store || currentStore;
    if (pickMode) editorState.foodDiaryCtx = { date: pickDate, meal: pickMeal };
    push('/foods/edit');
  }

  // ── FoodDetailSheet handlers (Phase 2) ───────────────────────────────────
  // The sheet dispatches `edit` and `addToDiary` with the food. The sheet
  // closes itself before these fire so the slide-down + next-action
  // animations overlap rather than chain. The transition is intentionally
  // fast (~200ms) so it reads as a single motion: sheet drops, editor or
  // qty prompt comes up underneath in the same beat.
  function onDetailEdit(e) {
    const food = e.detail.food;
    // Route by the current tab — meals/recipes need MealEditor, not
    // FoodEditor. Preserves existing edit destinations while letting
    // the desktop pane's Edit button do the right thing for the
    // currently-viewed catalog.
    if (activeTab === 1) return openMealEditor(food, false);
    if (activeTab === 2) return openMealEditor(food, true);
    openEditor(food, 'foodList');
  }

  async function onDetailAddToDiary(e) {
    const food = e.detail.food;
    if (!food) return;
    // Meal is now picked by the user on the sheet itself (defaults to
    // last-used). Routing through the qty prompt when diaryPromptQuantity
    // is on still works the same way — the picked meal rides into the
    // existing pickMeal slot so confirmQtyPrompt uses it.
    const chosenMeal = Number(e.detail.meal) || 0;
    pickMeal = String(chosenMeal);
    pickDate = localDateStr();
    if ($diaryPromptQuantity) {
      promptFood = food;
      promptServings = 1;
      promptPortion = food.portion || 100;
      promptUnit = food.unit || 'g';
      showQtyPrompt = true;
      return;
    }
    // No-prompt path: log 1 serving at the food's stored portion to the
    // chosen meal + today, then surface a toast naming the meal as
    // visible confirmation.
    const { addDiaryItem } = await import('../stores/diary.js');
    let savedFood = food;
    if (!food.id || typeof food.id !== 'number') {
      const { id: _drop, ...rest } = food;
      savedFood = await NtApi.createFood({ ...rest, created_at: food.dateTime || new Date().toISOString() });
    }
    const item = {
      ...savedFood,
      portion: savedFood.portion || 100,
      unit: savedFood.unit || 'g',
      quantity: 1,
      nutrition: savedFood.nutrition,
    };
    await addDiaryItem(item, chosenMeal);
    editorState.lastMealAdded = chosenMeal;
    const names = mealNames.get() || ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
    showSuccess($_('foods.detail.added_to', { values: { meal: names[chosenMeal] || 'meal' } }));
  }

  function openMealEditor(item, isRecipe) {
    _saveScrollState();
    editorState.mealPrefill  = item ? { ...item } : null;
    editorState.mealIsRecipe = isRecipe;
    push(item ? '/meal-editor/' + item.id : '/meal-editor');
  }

  async function pickFood(food, sourceHint) {
    // Search-a-licious hits deliberately omit serving_size, serving_quantity,
    // nutrition_data_per, and _serving nutriment variants (index space
    // savings). These matter for the Import Portion As setting, alt-units
    // convenience picker, and the cross-system nutrition-basis warning.
    // Hydrate on tap via a v3 product lookup so the add / detail sheet
    // sees full-fidelity data. NtApi.fetchProductByCode caches per-code
    // in-session, so a second tap on the same food is instant. Only fires
    // for freshly-picked OFF search hits (sourceHint === 'off'); locally
    // stored foods, barcode-scanned foods, and shared / USDA / Mealie
    // items all have their own data paths and don't need OFF hydration.
    if (sourceHint === 'off' && food && food.barcode && !food._offHydrated) {
      try {
        // fetchProductByCode lives on API, not NtApi. NtApi is a Proxy
        // that routes to the HTTP / native / cached transport layers and
        // has no such method — calling it there returns undefined and
        // throws TypeError, which the surrounding catch swallowed. Would
        // silently no-op every hydration otherwise.
        //
        // Callers that already fetched the product via lookupBarcode (v3
        // barcode scan path) pass _offHydrated: true so we skip the round-
        // trip. Cache is scoped to the tap-hydration call site, not to the
        // barcode scan, so a fresh scan wouldn't hit the cache anyway.
        const hydrated = await API.fetchProductByCode(food.barcode);
        if (hydrated) food = { ...food, ...hydrated };
      } catch { /* fall through with the un-hydrated hit */ }
    }
    if (!pickMode) {
      // Meals/Recipes open the meal editor; Foods open the read-only
      // detail sheet (Phase 2 of the NutritionFactsBox rollout). The sheet
      // handles its own Edit + Add to Diary actions, so we return here.
      // Previous behavior was openEditor(food, 'foodList') — full-page
      // navigation to /foods/edit; preserved as the Edit-button destination
      // on the new sheet so no FoodEditor functionality is lost.
      // Meals / Recipes: on desktop pane mode, populate the pane
      // (preview reuses the food-shaped nutrition + name + brand);
      // on mobile, drop straight into the MealEditor since there's
      // no pane to preview into.
      if (activeTab === 1) {
        if (_foodsPaneMode) { _paneFood = food; return; }
        return openMealEditor(food, false);
      }
      if (activeTab === 2) {
        if (_foodsPaneMode) { _paneFood = food; return; }
        return openMealEditor(food, true);
      }
      detailSheetFood = food;
      if (_foodsPaneMode) {
        // Desktop wide: populate the right-pane preview instead of
        // opening the modal sheet.
        _paneFood = food;
      } else {
        detailSheetOpen = true;
      }
      return;
    }

    // If item is from another user's catalogue, copy it into ours first
    if (searchSource === 'shared' && food._shared_by != null) {
      const mine = await copyAndUse(food);
      if (!mine) return;
      food = mine;
      showSuccess('Saved to your catalog');
      await load();
    }

    // Meals: always expand ingredients at saved portions — no quantity prompt
    if (activeTab === 1 && food.items && food.items.length > 0) {
      await _expandMealToDiary(food);
      return;
    }
    // Foods & Recipes: prompt for quantity if setting enabled
    if ($diaryPromptQuantity) {
      promptFood = food;
      promptServings = 1;
      promptPortion = food.portion || 100;
      promptUnit = food.unit || 'g';
      showQtyPrompt = true;
      return;
    }
    await _addFoodToDiary(food, 1);
  }

  async function _expandMealToDiary(meal) {
    if (_addingToDiary) return;
    _addingToDiary = true;
    try {
      const { addDiaryItem } = await import('../stores/diary.js');
      // Bump usage on the meal itself before expanding into individual food
      // items. addDiaryItem only sees the foods it logs (and bumps those),
      // so without this the saved meal's own counter would never move and
      // "Most Used" on the Meals tab would stay at zero. Fire-and-forget;
      // counter inaccuracy isn't worth blocking the user's add.
      if (typeof meal.id === 'number') {
        NtApi.markMealUsed(meal.id, pickDate || undefined).catch(() => {});
      }
      for (const item of meal.items) {
        await addDiaryItem(
          { ...item, quantity: item.quantity || 1 },
          Number(pickMeal) || 0,
          pickDate || undefined
        );
      }
      import('../stores/toast.js').then(m => m.showSuccess('Added to diary'));
      editorState.lastMealAdded = Number(pickMeal) || 0;
      history.back();
    } finally {
      _addingToDiary = false;
    }
  }

  async function _addFoodToDiaryNoNav(food, qty) {
    const { addDiaryItem } = await import('../stores/diary.js');
    let savedFood = food;
    if (!food.id || typeof food.id !== 'number') {
      const { id: _drop, ...rest } = food;
      savedFood = await NtApi.createFood({ ...rest, created_at: food.dateTime || new Date().toISOString() });
    }
    const item = {
      ...savedFood,
      portion: savedFood.portion || 100,
      unit: savedFood.unit || 'g',
      quantity: qty,
      nutrition: savedFood.nutrition
    };
    await addDiaryItem(item, Number(pickMeal) || 0, pickDate || undefined);
  }

  async function _addFoodToDiary(food, qty) {
    if (_addingToDiary) return;
    _addingToDiary = true;
    try {
      await _addFoodToDiaryNoNav(food, qty);
      import('../stores/toast.js').then(m => m.showSuccess('Added to diary'));
      editorState.lastMealAdded = Number(pickMeal) || 0;
      history.back();
    } finally {
      _addingToDiary = false;
    }
  }

  function toggleSelect(food) {
    if (selectedFoods.has(food)) selectedFoods.delete(food);
    else selectedFoods.add(food);
    selectedFoods = selectedFoods;
  }

  async function confirmMultiAdd() {
    if (selectedFoods.size === 0 || multiAdding) return;
    const foods = [...selectedFoods];

    // Meals always expand ingredients — no portion prompt even if setting is on
    if (activeTab === 1) {
      multiAdding = true;
      const { addDiaryItem } = await import('../stores/diary.js');
      for (const meal of foods) {
        for (const item of (meal.items || [])) {
          await addDiaryItem({ ...item, quantity: item.quantity || 1 }, Number(pickMeal) || 0, pickDate || undefined);
        }
      }
      showSuccess(`Added ${foods.length} meal${foods.length > 1 ? 's' : ''} to diary`);
      editorState.lastMealAdded = Number(pickMeal) || 0;
      multiAdding = false;
      history.back();
      return;
    }

    // Foods & Recipes: if prompt setting on, show single stacked portion sheet
    if ($diaryPromptQuantity) {
      multiPortionItems = foods.map(food => ({
        food,
        portion: food.portion || 100,
        unit: food.unit || 'g',
        servings: 1,
      }));
      showMultiPortionSheet = true;
      return;
    }

    // No prompt — add all with defaults
    multiAdding = true;
    for (const food of foods) await _addFoodToDiaryNoNav(food, 1);
    showSuccess(`Added ${foods.length} item${foods.length > 1 ? 's' : ''} to diary`);
    editorState.lastMealAdded = Number(pickMeal) || 0;
    multiAdding = false;
    history.back();
  }

  async function confirmMultiPortionSheet() {
    if (multiAdding) return;
    multiAdding = true;
    for (const item of multiPortionItems) {
      const origPortion = parseFloat(item.food.portion) || 100;
      const origUnit    = item.food.unit || 'g';
      const newPortion  = parseDecimal(item.portion) || origPortion;
      const portionFactor = _unitScaleFactor(origPortion, origUnit, newPortion, item.unit || origUnit, item.food);
      const scaledNutrition = item.food.nutrition
        ? Object.fromEntries(Object.entries(item.food.nutrition).map(([k,v]) => [k, (parseFloat(v)||0) * portionFactor]))
        : item.food.nutrition;
      const food = { ...item.food, portion: newPortion, unit: item.unit, nutrition: scaledNutrition };
      await _addFoodToDiaryNoNav(food, parseDecimal(item.servings) || 1);
    }
    showSuccess(`Added ${multiPortionItems.length} item${multiPortionItems.length > 1 ? 's' : ''} to diary`);
    editorState.lastMealAdded = Number(pickMeal) || 0;
    multiAdding = false;
    history.back();
  }

  async function confirmQtyPrompt() {
    if (!promptFood || _addingToDiary) return;
    const origPortion = parseFloat(promptFood.portion) || 100;
    const origUnit    = promptFood.unit || 'g';
    const newPortion  = parseDecimal(promptPortion) || origPortion;
    const newUnit     = promptUnit || origUnit;

    // Scale by mass when both units are mass-convertible (g/oz/lb/ml/etc.),
    // otherwise fall back to a pure portion ratio. Passes promptFood so the
    // scaler can use per-food alt_units (slice=35g etc.) + density when set.
    // See src/lib/units.js. Issues #69 + #70.
    const portionFactor = _unitScaleFactor(origPortion, origUnit, newPortion, newUnit, promptFood);
    const scaledNutrition = promptFood.nutrition ?
      Object.fromEntries(Object.entries(promptFood.nutrition).map(([k,v]) => [k, (parseFloat(v)||0) * portionFactor])) :
      promptFood.nutrition;

    const food = {
      ...promptFood,
      portion: newPortion,
      unit: newUnit,
      nutrition: scaledNutrition
    };
    await _addFoodToDiary(food, parseDecimal(promptServings) || 1);
  }

  async function deleteItem(item) {
    if (currentStore === 'foodList') await NtApi.deleteFood(item.id);
    else await NtApi.deleteMeal(item.id);
    await load();
    showSuccess($_('foods.toast.deleted'));
  }

  function enterManageMode(seedItem) {
    if (pickMode) return;                 // pickMode owns multi-select
    if (!seedItem?.id) return;            // external results aren't manageable
    manageMode = true;
    manageSelected = new Set([seedItem.id]);
  }
  function toggleManageSelect(item) {
    if (!item?.id) return;
    if (manageSelected.has(item.id)) manageSelected.delete(item.id);
    else manageSelected.add(item.id);
    manageSelected = manageSelected;      // trigger reactivity
    if (manageSelected.size === 0) manageMode = false;   // match Diary
  }
  function exitManageMode() {
    manageMode = false;
    manageSelected = new Set();
  }
  // #175 (nomad64) — bulk-select helpers on the manage bar. Both target
  // `filteredList` so they respect the user's current source / category /
  // search filters, giving a scoped bulk-clean rather than a database
  // nuke. Select None does NOT drop out of manage mode (the exit-on-empty
  // auto-exit only fires from the per-item toggle path).
  function selectAllVisible() {
    if (!manageMode) return;
    const next = new Set(manageSelected);
    for (const f of (filteredList || [])) {
      if (f?.id != null) next.add(f.id);
    }
    manageSelected = next;
  }
  function selectNoneVisible() {
    if (!manageMode) return;
    manageSelected = new Set();
  }
  // Reactive helpers for enabling / labelling the buttons.
  $: _visibleManageableIds = (filteredList || [])
    .filter(f => f?.id != null)
    .map(f => f.id);
  $: _allVisibleSelected = _visibleManageableIds.length > 0
    && _visibleManageableIds.every(id => manageSelected.has(id));
  async function confirmBulkDelete() {
    if (bulkDeleting || manageSelected.size === 0) return;
    bulkDeleting = true;
    const ids = [...manageSelected];
    const store = currentStore;
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        if (store === 'foodList') await NtApi.deleteFood(id);
        else await NtApi.deleteMeal(id);
        ok++;
      } catch (e) {
        console.error('[foods] bulk delete failed for', id, e);
        fail++;
      }
    }
    bulkDeleting = false;
    showBulkDeleteDialog = false;
    exitManageMode();
    await load();
    if (fail === 0) showSuccess(`Deleted ${ok} ${ok === 1 ? 'item' : 'items'}`);
    else showError(`Deleted ${ok} of ${ids.length}; ${fail} failed`);
  }

  async function cloneItem(item) {
    const { id: _drop, ...rest } = item;
    const clone = { ...rest, name: 'Copy of ' + (item.name || ''), created_at: new Date().toISOString() };
    if (currentStore === 'foodList') await NtApi.createFood(clone);
    else await NtApi.createMeal(clone);
    await load();
    showSuccess($_('foods.toast.cloned'));
  }

  function longPress(item) {
    selectedItem = item;
    showItemActions = true;
  }

  // Manual long-press timer for iOS Safari, which doesn't dispatch
  // `contextmenu` events on long-press for non-text elements (especially
  // when the element sets `-webkit-touch-callout: none`, which .food-item-btn
  // does). touchstart/touchmove/touchend always fire on iOS, so we detect
  // the hold ourselves and trigger the same action sheet. Mirrors the
  // Diary's implementation. iOS also suppresses synthetic click after a
  // >300ms hold, so no double-fire risk at 500ms. #102.
  let _lpTimer = null;
  function _startLongPress(action) {
    _lpTimer = setTimeout(() => { _lpTimer = null; action(); }, 500);
  }
  function _cancelLongPress() {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  }

  function handleItemAction({ detail }) {
    if (!selectedItem) return;
    if (detail.value === 'edit') {
      if (activeTab === 1) openMealEditor(selectedItem, false);
      else if (activeTab === 2) openMealEditor(selectedItem, true);
      else openEditor(selectedItem, 'foodList');
    } else if (detail.value === 'clone') {
      cloneItem(selectedItem);
    } else if (detail.value === 'copy') {
      if (selectedItem.id) {
        copyAndUse(selectedItem).then(() => { showSuccess('Saved to your catalog'); load(); });
      } else {
        // External item (OFF/USDA) — create a new local food from it
        NtApi.createFood(selectedItem).then(() => { showSuccess('Saved to My Foods'); load(); })
          .catch(e => showError('Could not save: ' + e.message));
      }
    } else if (detail.value === 'delete') {
      showDeleteDialog = true;
    } else if (detail.value === 'select') {
      enterManageMode(selectedItem);
    }
  }

  // Barcode normalizer — strips whitespace + leading zeros so a UPC-A saved
  // as "0036000291452" matches a scan that returns "36000291452" (and vice
  // versa). Different scanners (ML Kit on Android, Quagga on web) and
  // different OFF entries don't agree on whether to keep the leading zero.
  function _normBarcode(b) {
    return String(b || '').trim().replace(/^0+/, '');
  }

  // Loading overlay state — shown while a scanned barcode is being looked
  // up against Open Food Facts. Without it the user could be left staring
  // at the Foods tab between camera close and editor open on slow or
  // first-cold mirror queries (duplaja's barcode UX note on #22). The
  // overlay only appears for the OFF lookup leg; library hits are
  // instantaneous and never flash it.
  //
  // Deferred reveal: 400ms grace before the indicator becomes visible,
  // so the typical sub-half-second lookup flashes nothing. Slow lookups
  // (cold DuckDB, sluggish OFF API, overloaded mirror) get a clear
  // indicator past that threshold. Auto-dismisses on success / error /
  // exception via the finally block.
  let _scanLookupActive    = false;
  let _scanLookupCode      = '';
  let _scanIndicatorVisible = false;
  let _scanIndicatorTimer   = null;
  function _armScanIndicator() {
    clearTimeout(_scanIndicatorTimer);
    _scanIndicatorTimer = setTimeout(() => {
      if (_scanLookupActive) _scanIndicatorVisible = true;
    }, 400);
  }
  function _disarmScanIndicator() {
    clearTimeout(_scanIndicatorTimer);
    _scanIndicatorTimer    = null;
    _scanIndicatorVisible  = false;
  }

  async function handleScan({ detail }) {
    const rawCode = detail.code;
    if (!rawCode) return;
    // UPC-A → EAN-13 normalization. Barcode scanners return UPC-A codes
    // in their raw 12-digit form, but OFF (and most product databases)
    // store them with a leading zero as canonical EAN-13. Padding here
    // means the local mirror lookup, the remote OFF fallback, the food
    // editor's _refreshOffPresence preflight, and any saved food.barcode
    // all see the same canonical form (no "two codes for one product"
    // downstream). Idempotent for non-12-digit codes (EAN-13, EAN-8,
    // ITF-14, non-numeric QR payloads all pass through unchanged).
    // _normBarcode handles cross-form library matching for foods saved
    // under the old 12-digit form. (Issue #22 followup; duplaja noticed
    // the redundant remote-OFF roundtrip from the double-lookup log.)
    const code = /^\d{12}$/.test(rawCode) ? '0' + rawCode : rawCode;
    if (!code) return;
    try {
      // 1. Check the user's library first. If they've already saved this
      //    barcode, the quick-add card (pickMode) or the existing food page
      //    (browse mode) is what they want — no point hitting OFF + showing
      //    a fresh-import editor for something they've already vetted.
      const codeN = _normBarcode(code);
      const existing = (localFoods || []).find(f => f.barcode && _normBarcode(f.barcode) === codeN);
      if (existing) {
        if (pickMode) await pickFood(existing);
        else          openEditor(existing, 'foodList');
        return;
      }

      // 2. Not in library — fetch from Open Food Facts. If found, open
      //    FoodEditor with OFF data prefilled (picture, full nutrition,
      //    brand) so the user can verify before saving. If NOT found in
      //    OFF, still open the editor with just the barcode prefilled so
      //    the user can enter the food manually and optionally contribute
      //    it back to OFF via the editor's Contribute button. Previously
      //    this just showed a dead-end "Barcode not found" toast.
      _scanLookupCode   = code;
      _scanLookupActive = true;
      _armScanIndicator();
      const { API } = await import('../lib/api.js');
      const result = await API.lookupBarcode(code);
      if (result) {
        // OFF returned data for this barcode — show the nutrition-facts
        // detail sheet first (with Edit + Add to Diary options) instead
        // of jumping straight into the editor. Matches the OFF-search-tap
        // flow so barcode scan and text-search of an OFF-known product
        // land on the same view. Only unknown-to-OFF barcodes go straight
        // to the editor (that path unchanged).
        //
        // In pickMode (caller landed here to add-to-diary via meal-editor
        // or the Foods+pickDate+pickMeal URL flow), route through pickFood
        // so its own pickDate / pickMeal context is preserved rather than
        // silently defaulting to today + first meal via detailSheet.
        //
        // Close the scanner explicitly before opening the sheet or calling
        // pickFood. The pre-migration flow relied on openEditor navigating
        // away (which unmounted the scanner as a side effect); replacing
        // that with detail-sheet or pickFood means the scanner would keep
        // its camera running behind the sheet and could re-fire handleScan
        // on the next decoded frame.
        scannerOpen = false;
        if (pickMode) {
          // Mark as already-hydrated so pickFood skips its own v3 fetch —
          // lookupBarcode already hit /api/v3/product/<code> and returned
          // full serving-size / _serving nutriments. Would otherwise double
          // the request per scan and re-run _mapOFFProduct.
          await pickFood({ ...result, _offHydrated: true }, 'off');
        } else {
          detailSheetFood = result;
          detailSheetOpen = true;
        }
      } else {
        const { showInfo: si } = await import('../stores/toast.js');
        si('Not in Open Food Facts — enter the food and contribute it back if you want');
        openEditor({ barcode: code }, 'foodList');
      }
    } catch(e) {
      const { showError: se } = await import('../stores/toast.js');
      se('Lookup failed — opening editor so you can enter manually');
      openEditor({ barcode: code }, 'foodList');
    } finally {
      _scanLookupActive = false;
      _scanLookupCode   = '';
      _disarmScanIndicator();
    }
  }

  async function loadYesterdayMeals() {
    if (!pickMode || !$foodsShowYesterdayMeals) { yesterdayMeals = []; return; }
    const yDate = new Date();
    yDate.setDate(yDate.getDate() - 1);
    const yStr = localDateStr(yDate);
    const entry = await NtApi.getDiaryDate(yStr);
    if (!entry || !entry.items || !entry.items.length) { yesterdayMeals = []; return; }
    const names = $mealNames || ['Breakfast','Lunch','Dinner','Snacks'];
    const groups = {};
    for (const item of entry.items) {
      const m = item.meal != null ? Number(item.meal) : 0;
      if (!groups[m]) groups[m] = [];
      groups[m].push(item);
    }
    yesterdayMeals = Object.entries(groups).map(([mIdx, items]) => ({
      mealIdx: Number(mIdx),
      mealName: names[Number(mIdx)] || ('Meal ' + (Number(mIdx)+1)),
      items,
      totalKcal: Math.round(items.reduce((s,i) => {
        const factor = (i.quantity || 1);
        return s + (i.nutrition?.calories || i.calories || 0) * factor;
      }, 0)).toLocaleString()
    }));
  }
  // Resolve the live imgUrl for a diary item — same source the food picker
  // uses (the user's foods catalog), looked up at render time. Returns
  // food.imgUrl if a match is found, else the item's own (possibly stale)
  // imgUrl as a fallback. No async, no preprocessing — the foods list is
  // already loaded by the time yesterday-meal cards are visible.
  function liveImgFor(item) {
    // Search across foods + meals + recipes. Diary items can reference
    // any of the three (recipes are added as single-line entries
    // carrying the recipe's id, not expanded into ingredients).
    const all = [...(localFoods || []), ...(localMeals || []), ...(localRecipes || [])];
    // foodStableId — server_id when set (Android cache rows), else id
    // (PWA rows use the server's id directly as `id`). itemStableId —
    // food_server_id (set explicitly by addDiaryItem post-fix), or
    // item.id for legacy items (PWA-written items already use the
    // server's id; Android-pre-fix items have local ids that may have
    // renumbered after a re-install — those fall through to name match).
    const foodStableId = (f) => (typeof f.server_id === 'number') ? f.server_id : f.id;
    const itemStableId = (typeof item.food_server_id === 'number')
      ? item.food_server_id
      : item.id;

    if (typeof itemStableId === 'number') {
      const m = all.find(f => foodStableId(f) === itemStableId);
      if (m?.imgUrl) return m.imgUrl;
    }
    const itemName = (item.name || '').trim();
    const itemBrand = (item.brand || '').toLowerCase().trim();
    if (itemName) {
      const exact = all.filter(f =>
        f.name === itemName && (f.brand || '').toLowerCase().trim() === itemBrand);
      const m = exact.find(f => f.imgUrl) || exact[0] || null;
      if (m?.imgUrl) return m.imgUrl;
    }
    if (itemName && !itemBrand) {
      const nameOnly = all.filter(f => f.name === itemName);
      const m = nameOnly.find(f => f.imgUrl) || nameOnly[0] || null;
      if (m?.imgUrl) return m.imgUrl;
    }
    return item.imgUrl;
  }

  async function addYesterdayMeal(group) {
    const targetMeal = Number(pickMeal) || 0;
    const { addDiaryItem } = await import('../stores/diary.js');
    // Same lookup as the popup rendering — pull each item's live imgUrl
    // from the user's foods catalog before writing to today's diary, so
    // the new diary row uses the food's current image (just like the
    // food picker does) instead of whatever stale value yesterday's
    // diary item is carrying.
    for (const item of group.items) {
      const imgUrl = liveImgFor(item);
      await addDiaryItem({ ...item, imgUrl }, targetMeal, pickDate);
    }
    import('../stores/toast.js').then(m => m.showSuccess('Added ' + group.mealName));
    editorState.lastMealAdded = targetMeal;
    history.back();
  }

  // Register onDestroy SYNCHRONOUSLY at component setup; the listener itself
  // gets attached after onMount's async work completes. Calling onDestroy()
  // inside an async onMount (after any await) throws "Function called
  // outside component initialization" in Svelte 4.
  let _onVis = null;
  let _paneMq = null;
  let _paneMqHandler = null;
  let _railMq = null;
  let _railMqHandler = null;
  let _foodsViewportRail = false; // ≥1280px, gates the Sources/Categories rail portal
  $: _foodsRailMode = _foodsViewportRail && !$forceMobileLayout;
  let _onKeyGlobal = null;
  let _foodsBodyEl = null;
  // Same pattern as NT Diary's rail (see feedback_traceapps_fixed_positioning_in_scroll_wrapper):
  // .page-transition scopes position:fixed via will-change:transform, so
  // both asides are portaled to document.body and their geometry is fed
  // via inline CSS custom properties (which don't cross a portal).
  let _railTopPx  = 130, _railLeftPx  = 0,   _railWidthPx = 240;
  let _paneTopPx  = 130, _paneLeftPx  = 0,   _paneWidthPx = 420;
  let _foodsRailResizeObs = null;
  function _measureFoodsRails() {
    if (!_foodsBodyEl) return;
    const rect = _foodsBodyEl.getBoundingClientRect();
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const cs = getComputedStyle(_foodsBodyEl);
    const padTop  = parseFloat(cs.paddingTop  || '0') || 0;
    const padLeft = parseFloat(cs.paddingLeft || '0') || 0;
    // Grid + padding gives the actual position of the rail cell inside
    // .foods-body. Including the top padding is what puts the small
    // breathing gap between the sticky search bar and the rail (same
    // "diary rail sits below week-strip with .diary-content padding"
    // pattern from Diary.svelte).
    const rootCS = getComputedStyle(document.documentElement);
    const pageTop = parseFloat(rootCS.getPropertyValue('--page-top') || rootCS.getPropertyValue('--safe-top') || '0') || 0;
    const hamRow  = parseFloat(rootCS.getPropertyValue('--hamburger-row') || '0') || 0;
    const anchorDocTop = rect.top + scrollY + padTop;
    const topPx = Math.max(0, Math.round(anchorDocTop - pageTop - hamRow));
    if (topPx !== _railTopPx) _railTopPx = topPx;
    if (topPx !== _paneTopPx) _paneTopPx = topPx;
    // Left offsets track the grid cell edges, honoring horizontal padding.
    const leftRail = Math.max(0, Math.round(rect.left + padLeft));
    const paneRightPad = parseFloat(cs.paddingRight || '0') || 0;
    const leftPane = Math.max(0, Math.round(rect.right - paneRightPad - _paneWidthPx));
    if (leftRail !== _railLeftPx) _railLeftPx = leftRail;
    if (leftPane !== _paneLeftPx) _paneLeftPx = leftPane;
  }
  onDestroy(() => {
    if (_onVis) document.removeEventListener('visibilitychange', _onVis);
    if (_paneMq && _paneMqHandler) {
      _paneMq.removeEventListener
        ? _paneMq.removeEventListener('change', _paneMqHandler)
        : _paneMq.removeListener(_paneMqHandler);
    }
    if (_railMq && _railMqHandler) {
      _railMq.removeEventListener
        ? _railMq.removeEventListener('change', _railMqHandler)
        : _railMq.removeListener(_railMqHandler);
    }
    if (_onKeyGlobal) document.removeEventListener('keydown', _onKeyGlobal);
    try { _foodsRailResizeObs?.disconnect(); } catch {}
    if (typeof window !== 'undefined') window.removeEventListener('resize', _measureFoodsRails);
  });

  onMount(async () => {
    // Desktop detail-pane viewport tracker. Threshold 1440px matches
    // Foods Phase B — below that, the third column would squeeze the
    // main list too tight to be useful, so we keep opening the modal
    // sheet on tap. Combined with $forceMobileLayout reactively above.
    if (typeof window !== 'undefined') {
      _paneMq = window.matchMedia('(min-width: 1440px)');
      _paneMqHandler = () => { _foodsViewportPane = _paneMq.matches; };
      _foodsViewportPane = _paneMq.matches;
      _paneMq.addEventListener
        ? _paneMq.addEventListener('change', _paneMqHandler)
        : _paneMq.addListener(_paneMqHandler);
      // Second breakpoint gate: the Sources/Categories rail activates
      // at ≥1280 (one step below the detail pane). Portal + measurement
      // only run inside this window.
      _railMq = window.matchMedia('(min-width: 1280px)');
      _railMqHandler = () => { _foodsViewportRail = _railMq.matches; requestAnimationFrame(_measureFoodsRails); };
      _foodsViewportRail = _railMq.matches;
      _railMq.addEventListener
        ? _railMq.addEventListener('change', _railMqHandler)
        : _railMq.addListener(_railMqHandler);
    }
    requestAnimationFrame(() => requestAnimationFrame(_measureFoodsRails));
    try {
      _foodsRailResizeObs = new ResizeObserver(_measureFoodsRails);
      if (_foodsBodyEl) _foodsRailResizeObs.observe(_foodsBodyEl);
    } catch { /* ResizeObserver unavailable — one-shot stands */ }
    if (typeof window !== 'undefined') window.addEventListener('resize', _measureFoodsRails);
    // Global keyboard shortcut: '/' or ⌘K / Ctrl-K focuses the
    // search input from anywhere on the page, matching the muscle
    // memory of most desktop search UIs. Skipped when the user is
    // already typing in a field, and when a sheet/dialog is open
    // (a search focus underneath a modal reads as broken UX).
    if (typeof document !== 'undefined') {
      _onKeyGlobal = (e) => {
        if (!_searchInputEl) return;
        const target = e.target;
        const inField = target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        );
        const isSlash = e.key === '/';
        const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
        if (isCmdK) {
          e.preventDefault();
          _searchInputEl.focus();
          _searchInputEl.select?.();
          return;
        }
        if (isSlash && !inField) {
          e.preventDefault();
          _searchInputEl.focus();
        }
      };
      document.addEventListener('keydown', _onKeyGlobal);
    }
    // Restore tab before load so the right list is fetched
    if (editorState.foodsActiveTab != null) {
      activeTab = editorState.foodsActiveTab;
      editorState.foodsActiveTab = null;
    }
    // Load local data FIRST — don't block on server calls
    await load();
    await loadYesterdayMeals();
    // Sharing status from server — non-blocking, updates UI when ready
    refreshSharingStatus();
    // Refresh whenever the page becomes visible again (covers "someone shared
    // with me while the app was backgrounded") and on tab switch within Foods.
    _onVis = () => { if (document.visibilityState === 'visible') refreshSharingStatus(); };
    document.addEventListener('visibilitychange', _onVis);
    // Restore scroll position after Svelte has flushed the list to the DOM
    if (editorState.foodsScrollY != null) {
      const sy = editorState.foodsScrollY;
      editorState.foodsScrollY = null;
      await tick();
      window.scrollTo(0, sy);
    }
  });
</script>

<!-- Dismiss triggers for the OFF/USDA tier dropdowns. Since the backdrop
     is pointer-events:none (so scrolls pass through to underlying page),
     we detect dismiss via window-level events that bubble from wherever
     the touch actually landed. -->
<svelte:window
  on:click={_onWindowClick}
  on:touchmove={_onWindowTouchMove}
  on:scroll={_closeTierDropdowns}
  on:resize={_closeTierDropdowns}
/>

<!-- Source + category chip snippets. Rendered inline in the mobile
     sticky bar (horizontal scroll) AND inside the desktop
     .foods-filter-rail (vertical list). Same event handlers +
     state either way — snippet-driven so behavior stays in one
     place while the layout adapts. -->
{#snippet sourceChips()}
  {#if availableSources.length > 1}
    {#each availableSources as src}
      {#if src.value === 'off'}
        <div class="source-chip-wrap">
          <button class="source-chip source-chip-split"
                  class:active={activeChips.off}
                  on:click={() => _onChipTap('off')}
                  on:contextmenu|preventDefault={() => _toggleChipInMulti('off')}
                  on:touchstart|passive={(e) => _startChipLongPress('off', e)}
                  on:touchmove|passive={_maybeCancelChipLongPress}
                  on:touchend={_cancelChipLongPress}
                  on:touchcancel={_cancelChipLongPress}>
            {src.label}
            {#if offTiersFiltered}<span class="tier-active-dot" title="OFF tier filter active"></span>{/if}
          </button>
          <button class="source-chip-caret"
                  class:active={activeChips.off}
                  class:open={offDropdownOpen}
                  bind:this={offCaretEl}
                  on:click={openOffDropdown}
                  aria-label="Filter OFF results by quality tier"
                  aria-expanded={offDropdownOpen}>
            <span class="material-symbols-rounded">expand_more</span>
          </button>
        </div>
      {:else if src.value === 'usda'}
        <div class="source-chip-wrap">
          <button class="source-chip source-chip-split"
                  class:active={activeChips.usda}
                  on:click={() => _onChipTap('usda')}
                  on:contextmenu|preventDefault={() => _toggleChipInMulti('usda')}
                  on:touchstart|passive={(e) => _startChipLongPress('usda', e)}
                  on:touchmove|passive={_maybeCancelChipLongPress}
                  on:touchend={_cancelChipLongPress}
                  on:touchcancel={_cancelChipLongPress}>
            {src.label}
            {#if usdaTiersFiltered}<span class="tier-active-dot" title="USDA tier filter active"></span>{/if}
          </button>
          <button class="source-chip-caret"
                  class:active={activeChips.usda}
                  class:open={usdaDropdownOpen}
                  bind:this={usdaCaretEl}
                  on:click={openUsdaDropdown}
                  aria-label="Filter USDA results by data type"
                  aria-expanded={usdaDropdownOpen}>
            <span class="material-symbols-rounded">expand_more</span>
          </button>
        </div>
      {:else}
        <button class="source-chip"
                class:active={activeChips[src.value]}
                on:click={() => _onChipTap(src.value)}
                on:contextmenu|preventDefault={() => _toggleChipInMulti(src.value)}
                on:touchstart|passive={(e) => _startChipLongPress(src.value, e)}
                on:touchmove|passive={_maybeCancelChipLongPress}
                on:touchend={_cancelChipLongPress}
                on:touchcancel={_cancelChipLongPress}>
          {src.label}
        </button>
      {/if}
    {/each}
  {/if}
{/snippet}

{#snippet catChips()}
  {#if activeTab === 0 && searchSource === 'local' && $foodsShowCategories && $foodCategories && $foodCategories.length > 0}
    <button class="cat-chip" class:active={!activeCategoryFilter}
      on:click={() => activeCategoryFilter = ''}>{$_('foods.category_all')}</button>
    {#each $foodCategories as cat}
      <button class="cat-chip" class:active={activeCategoryFilter === _catName(cat)}
        on:click={() => activeCategoryFilter = activeCategoryFilter === _catName(cat) ? '' : _catName(cat)}>{$foodsShowLabels ? _catDisplay(cat) : _catName(cat)}</button>
    {/each}
  {/if}
{/snippet}

<div class="page-shell">
  <!-- Manage-mode action icons — fixed at top-right, matches Diary UX -->
  {#if manageMode}
    <div use:portal class="foods-topbar-actions">
      <button class="btn-icon" on:click={exitManageMode} aria-label="Cancel selection" title="Cancel">
        <span class="material-symbols-rounded">close</span>
      </button>
      <button class="btn-icon"
        disabled={_visibleManageableIds.length === 0 || _allVisibleSelected || bulkDeleting}
        on:click={selectAllVisible}
        aria-label="Select all visible" title="Select all">
        <span class="material-symbols-rounded">select_all</span>
      </button>
      <button class="btn-icon"
        disabled={manageSelected.size === 0 || bulkDeleting}
        on:click={selectNoneVisible}
        aria-label="Select none" title="Select none">
        <span class="material-symbols-rounded">deselect</span>
      </button>
      <button class="btn-icon" style="color:var(--danger)"
        disabled={manageSelected.size === 0 || bulkDeleting}
        on:click={() => (showBulkDeleteDialog = true)}
        aria-label="Delete selected" title="Delete">
        <span class="material-symbols-rounded" class:spin={bulkDeleting}>{bulkDeleting ? 'refresh' : 'delete'}</span>
      </button>
    </div>
  {/if}
  <!-- Header -->
  <header class="page-header"
    class:banner-gradient={$bannerStyle === 'gradient' && !manageMode}
    class:banner-animated={$bannerStyle === 'animated' && !manageMode}>
    {#if pickMode && selectedFoods.size > 0}
      <h1 class="pick-count-title">{$_('foods.n_selected', { values: { n: selectedFoods.size } })}</h1>
      <button class="btn btn-primary pick-confirm-btn" on:click={confirmMultiAdd} disabled={multiAdding} aria-label={$_('foods.add_selected_to_diary')}>
        {#if multiAdding}
          <span class="material-symbols-rounded spin" style="font-size:16px">refresh</span>
          <span>{$_('foods.adding')}</span>
        {:else}
          <span class="material-symbols-rounded" style="font-size:16px">check</span>
          <span>{$_('foods.add_n', { values: { n: selectedFoods.size } })}</span>
        {/if}
      </button>
    {:else if manageMode}
      <h1 class="select-mode-title">{manageSelected.size} selected</h1>
    {:else}
      <h1>{$_('routes.foods.title')}</h1>
      <button class="btn-icon accent" on:click={() => {
        if (activeTab === 0) openEditor(null, 'foodList');
        else if (activeTab === 1) openMealEditor(null, false);
        else openMealEditor(null, true);
      }} aria-label={$_('foods.add_new')} title={$_('foods.add_new')}>
        <span class="material-symbols-rounded">add</span>
      </button>
    {/if}
  </header>

  <!-- Tabs + Search (sticky below header) -->
  <div class="foods-sticky-bar">
  <div class="foods-tabs">
    <Tabs tabs={TABS} bind:active={activeTab} on:change={onTabChange} />
  </div>

  <div class="foods-search">
    <span class="material-symbols-rounded foods-search-icon">search</span>
    <div class="foods-search-input-wrap">
      <input
        class="foods-search-input"
        type="search"
        placeholder={$_('foods.search_placeholder')}
        bind:this={_searchInputEl}
        bind:value={search}
      />
      <button class="btn-scan-inline" on:click={() => scannerOpen = true} aria-label={$_('foods.scan_barcode')} title={$_('foods.scan_barcode')}>
        <span class="material-symbols-rounded">barcode_scanner</span>
      </button>
    </div>
  </div>

  <!-- Mobile chip rows — horizontal scroll inside the sticky bar
       (sources) + below the sticky bar (categories). Both are
       CSS-hidden on desktop (≥1280px) since the .foods-filter-rail
       shows the same chips vertically. -->
  <div class="foods-mobile-chips">
    <div class="source-chip-row">
      {@render sourceChips()}
    </div>
  </div>
  </div>

  <div class="foods-mobile-chips">
    <div class="cat-filter-row">
      {@render catChips()}
    </div>
  </div>

  <!-- Foods body: two-pane split at ≥1280px. Left rail holds the
       filter chips vertically; main pane holds the food list. Below
       1280px (or when force-mobile-layout is on) this collapses to
       a single main column and the .foods-mobile-chips above take
       over the filter surface. -->
  <div class="foods-body" bind:this={_foodsBodyEl}>
    {#if _foodsRailMode}
    <aside
      use:portal
      class="foods-filter-rail"
      style="--foods-rail-top:{_railTopPx}px; --foods-rail-left:{_railLeftPx}px; --foods-rail-width:{_railWidthPx}px"
    >
      {#if availableSources.length > 1}
        <!-- Sources heading + chips only make sense when there's
             more than one source to pick from. Meals/Recipes with
             just Local (no shared users) hide the section entirely
             — no dead heading with a single chip beneath. -->
        <p class="foods-filter-heading">Sources</p>
        <div class="foods-rail-chips foods-rail-sources">
          {@render sourceChips()}
        </div>
      {/if}
      {#if activeTab === 0 && searchSource === 'local' && $foodsShowCategories && $foodCategories && $foodCategories.length > 0}
        <p class="foods-filter-heading">Categories</p>
        <div class="foods-rail-chips foods-rail-cats">
          {@render catChips()}
        </div>
      {/if}
      {#if availableSources.length <= 1 && !(activeTab === 0 && searchSource === 'local' && $foodsShowCategories && $foodCategories && $foodCategories.length > 0)}
        <!-- Rail would be empty otherwise — leave a low-key hint so
             the column doesn't render as a mysteriously-empty box. -->
        <p class="foods-filter-empty">No filters available for this tab.</p>
      {/if}
    </aside>
    {/if}

    <div class="foods-main">

  <!-- Yesterday's meals (pick mode only) -->
  {#if pickMode && yesterdayMeals.length > 0 && !search && activeTab === 1}
    <button class="meal-section-header" type="button"
      on:click={() => foodsYesterdayCollapsed.set(!$foodsYesterdayCollapsed)}
      aria-expanded={!$foodsYesterdayCollapsed}>
      <span class="meal-section-label">Yesterday's Meals</span>
      <span class="material-symbols-rounded meal-section-chevron"
        class:meal-section-chevron-collapsed={$foodsYesterdayCollapsed}>expand_more</span>
    </button>
    {#if !$foodsYesterdayCollapsed}
    <div class="card" style="margin-bottom:12px">
      {#each yesterdayMeals as group, gi}
        {@const _grpEnergy = Nutrition.displayEnergy(group.totalKcal, $energyUnit)}
        {#if gi > 0}<div style="height:1px;background:var(--border);margin:0 16px"></div>{/if}
        <div style="display:flex;align-items:center;padding-right:8px">
          <button class="food-item-btn" style="padding:12px 14px;flex:1" on:click={() => addYesterdayMeal(group)}>
            <div class="ing-thumb-placeholder" style="width:52px;height:52px;border-radius:var(--radius-sm);background:var(--accent-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <span class="material-symbols-rounded" style="color:var(--accent);font-size:20px">{mealIcon(group.mealName)}</span>
            </div>
            <div class="food-info">
              <span class="food-name">{group.mealName}</span>
              <span class="food-kcal text-sm">{group.items.length} items · {_grpEnergy.value.toLocaleString()} {_grpEnergy.unit}</span>
            </div>
          </button>
          <button class="btn-icon" on:click|stopPropagation={() => yesterdayInfoGroup = group}
            aria-label="Show items in {group.mealName}" title="Show items">
            <span class="material-symbols-rounded">info</span>
          </button>
          <button class="btn-icon accent" on:click|stopPropagation={() => addYesterdayMeal(group)}
            aria-label="Add {group.mealName} to today" title="Add to today">
            <span class="material-symbols-rounded">add_circle</span>
          </button>
        </div>
      {/each}
    </div>
    {/if}
    <!-- Sibling header for the saved meals list — only render when both sections coexist
         (yesterday is showing AND there are saved meals to display) so it acts as a divider. -->
    {#if filteredList.length > 0}
      <button class="meal-section-header" type="button"
        on:click={() => foodsSavedCollapsed.set(!$foodsSavedCollapsed)}
        aria-expanded={!$foodsSavedCollapsed}>
        <span class="meal-section-label">{$_('foods.saved_meals')}</span>
        <span class="material-symbols-rounded meal-section-chevron"
          class:meal-section-chevron-collapsed={$foodsSavedCollapsed}>expand_more</span>
      </button>
    {/if}
  {/if}

  {#if loadError}
    <div class="server-error-banner">
      <span class="material-symbols-rounded">cloud_off</span>
      <span>{$_('foods_deep.cant_reach_retry_msg')}<button class="server-error-retry" on:click={load}>{$_('foods_deep.retry')}</button></span>
    </div>
  {/if}

  <div class="page-content">
    {#if searchSource === 'all'}
      <!-- ── All: merged results from every enabled source ─────────────────── -->
      {#if !search.trim()}
        <div class="empty-state">
          <span class="material-symbols-rounded empty-icon">search</span>
          <p>{$_('foods.all_mode.search_hint')}</p>
        </div>
      {:else if (loading || mealieLoading) && _allModeItems.length === 0}
        <div class="loading-row">
          <span class="material-symbols-rounded spin">refresh</span>
          <span class="text-2 text-sm">{$_('foods.all_mode.searching')}</span>
        </div>
      {:else if _allModeItems.length === 0}
        <div class="empty-state">
          <span class="material-symbols-rounded empty-icon">search_off</span>
          <p>{$_('foods.all_mode.no_matches', { values: { q: search } })}</p>
        </div>
      {:else}
        <ul class="food-list">
          {#each _allModeItems as { source, item } (source + ':' + (item.id || item.slug || item.barcode || item.name))}
            {@const isMealie = source === 'mealie'}
            {@const isExternal = source === 'off' || source === 'usda'}
            {@const _foodEnergy = isMealie
              ? null
              : Nutrition.displayEnergy(item.nutrition?.calories || item.calories || 0, $energyUnit)}
            <li class="food-item card" in:fade={{ duration: 140 }}>
              <button class="food-item-btn"
                on:click={() => _pickBySource(source, item)}
                on:contextmenu|preventDefault={() => !isMealie && !isExternal && longPress(item)}
                on:touchstart|passive={() => _startLongPress(() => !isMealie && !isExternal && longPress(item))}
                on:touchmove|passive={_cancelLongPress}
                on:touchend={_cancelLongPress}>
                {#if isMealie && item.id}
                  <img class="food-thumb" src={Mealie.imageUrl(item.id)} alt=""
                    loading="lazy" on:error={e => e.target.style.display='none'} />
                {:else if item.imgUrl}
                  <img class="food-thumb" src={item.imgUrl} alt="" loading="lazy" referrerpolicy="no-referrer" on:error={e => e.target.style.display='none'} />
                {:else}
                  <div class="food-thumb-placeholder">
                    <span class="material-symbols-rounded">
                      {#if isMealie}menu_book{:else if source === 'usda'}science{:else if source === 'off'}public{:else}{_tabIcon}{/if}
                    </span>
                  </div>
                {/if}
                <div class="food-info">
                  <span class="food-name">
                    {#if source === 'local' && item.favorite}<span class="material-symbols-rounded fav-mark" title="Favorite">favorite</span>{/if}
                    {item.name}
                    <!-- OFF origin-country flag — shown on any OFF item
                         with origin data, regardless of whether the user
                         is on single-OFF mode or multi-source mode. -->
                    {#if source === 'off' && item.originTag}
                      {@const _flag = offCountryTagToFlag(item.originTag)}
                      {#if _flag}
                        <span class="off-origin-flag" title={`Made in ${offCountryTagToName(item.originTag)}`} aria-label={`Origin: ${offCountryTagToName(item.originTag)}`}>{_flag}</span>
                      {/if}
                    {/if}
                  </span>
                  {#if isMealie}
                    {#if item.recipeCategory?.length}
                      <span class="food-brand text-3 text-sm">{item.recipeCategory.map(c => c.name).join(', ')}</span>
                    {/if}
                  {:else}
                    {#if item.brand}<span class="food-brand text-3 text-sm">{item.brand}</span>{/if}
                    {#if _foodEnergy}
                      <span class="food-kcal text-sm">
                        {_foodEnergy.value.toLocaleString()} {_foodEnergy.unit}
                        <!-- OFF completeness dot -->
                        {#if source === 'off' && typeof item.completeness === 'number'}
                          <span class="off-quality-dot"
                                class:off-q-hi={item.completeness >= 0.7}
                                class:off-q-mid={item.completeness >= 0.4 && item.completeness < 0.7}
                                class:off-q-lo={item.completeness < 0.4}
                                title={`OFF data completeness: ${Math.round(item.completeness * 100)}%`}
                                aria-label={`Data completeness ${Math.round(item.completeness * 100)}%`}></span>
                        {/if}
                        <!-- USDA data-type badge -->
                        {#if source === 'usda' && item.dataType}
                          {@const _t = item.dataType}
                          {@const _abbr = _t === 'Foundation' ? 'F' : _t === 'SR Legacy' ? 'L' : _t === 'Survey (FNDDS)' ? 'S' : _t === 'Branded' ? 'B' : _t === 'Experimental' ? 'X' : '?'}
                          <span class="usda-type-badge"
                                class:usda-t-hi={_t === 'Foundation' || _t === 'SR Legacy'}
                                class:usda-t-mid={_t === 'Survey (FNDDS)'}
                                class:usda-t-lo={_t === 'Branded' || _t === 'Experimental'}
                                title={`USDA ${_t}`}
                                aria-label={`USDA data type ${_t}`}>{_abbr}</span>
                        {/if}
                      </span>
                    {/if}
                    {#if source === 'shared' && item._shared_by}<span class="food-kcal text-sm" style="color:var(--accent)">by {item._shared_by}</span>{/if}
                  {/if}
                </div>
                <span class="source-badge source-badge-{source}">
                  {#if source === 'local'}{$_('foods.sources.local')}
                  {:else if source === 'shared'}{$_('foods.sources.shared')}
                  {:else if source === 'mealie'}{$_('foods.sources.mealie')}
                  {:else if source === 'usda'}USDA
                  {:else}OFF{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
        <!-- ALL-mode per-source counts + infinite-scroll sentinel. Counts
             turn silent 0s into visible signals (e.g. "OFF · 0" tells the
             user OFF didn't return anything, not that ALL is broken).
             Sentinel fires loadMoreAll() when it scrolls into view. #96. -->
        {#if _allModeItems.length > 0 || _allOffTotal > 0 || _allUsdaTotal > 0 || _allMealieTotal > 0}
          {@const _localCount = (_ownList || []).filter(f => search.trim() ? _fuzzyMatch(f, search) : false).length}
          {@const _sharedCount = _tabHasShared ? (_groupList || []).filter(f => search.trim() ? _fuzzyMatch(f, search) : false).length : 0}
          <div class="all-source-counts">
            <span class="asc-chip"><span class="asc-dot asc-local"></span>Local · {_localCount}</span>
            {#if _tabHasShared}
              <span class="asc-chip"><span class="asc-dot asc-shared"></span>Shared · {_sharedCount}</span>
            {/if}
            {#if _mealieEnabled}
              <span class="asc-chip"><span class="asc-dot asc-mealie"></span>Mealie · {mealieResults.length}{#if _allMealieTotal > mealieResults.length} of {_allMealieTotal.toLocaleString()}{/if}</span>
            {/if}
            {#if $offEnabled}
              <span class="asc-chip"><span class="asc-dot asc-off"></span>OFF · {offResults.length}{#if _allOffTotal > offResults.length} of {_allOffTotal.toLocaleString()}{/if}</span>
            {/if}
            {#if $usdaEnabled}
              <span class="asc-chip"><span class="asc-dot asc-usda"></span>USDA · {usdaResults.length}{#if _allUsdaTotal > usdaResults.length} of {_allUsdaTotal.toLocaleString()}{/if}</span>
            {/if}
          </div>
        {/if}
        {#if _allLoadingMore}
          <div class="loading-row" style="margin-top:8px">
            <span class="material-symbols-rounded spin">refresh</span>
            <span class="text-2 text-sm">{$_('foods.all_mode.loading_more')}</span>
          </div>
        {:else if loading || mealieLoading}
          <div class="loading-row" style="margin-top:8px">
            <span class="material-symbols-rounded spin">refresh</span>
            <span class="text-2 text-sm">{$_('foods.all_mode.still_searching_others')}</span>
          </div>
        {/if}
        {#if _allHasMoreAny && !_allLoadingMore}
          <div class="scroll-sentinel" use:_infiniteScroll={{ onIntersect: loadMoreAll }}></div>
        {/if}
      {/if}

    {:else if searchSource === 'local' || searchSource === 'shared' || activeTab !== 0}
      <!-- ── Local list ─────────────────────────────────────────────────────── -->
      {#if _initialLoading && filteredList.length === 0 && !loadError}
        <!-- #178 — hold the empty state while the initial fetch is in
             flight. A slow /api/foods response would otherwise render
             "No foods yet" over the user's actual (server-side) library. -->
        <div class="loading-row">
          <span class="material-symbols-rounded spin">refresh</span>
          <span class="text-2 text-sm">{$_('foods.loading_library')}</span>
        </div>
      {:else if filteredList.length === 0 && !search && !loadError}
        <div class="empty-state">
          <span class="material-symbols-rounded empty-icon">
            {activeTab === 0 ? 'restaurant' : activeTab === 1 ? 'dinner_dining' : 'book'}
          </span>
          <p>No {TABS[activeTab].label.toLowerCase()} yet</p>
          <button class="btn btn-primary" on:click={() => {
            if (activeTab === 0) openEditor(null);
            else openMealEditor(null, activeTab === 2);
          }}>
            Add {TABS[activeTab].label.slice(0,-1)}
          </button>
        </div>
      {:else if filteredList.length === 0 && search}
        <div class="empty-state">
          <span class="material-symbols-rounded empty-icon">search_off</span>
          <p>No matches for "{search}"</p>
          {#if activeTab === 0}
            <p class="empty-state-hint">{$_('foods.search_empty_hint')}</p>
          {/if}
        </div>
      {:else if !_hideSavedMealsList}
        {@const _renderList = (search || activeCategoryFilter)
          ? filteredList
          : [...filteredList.filter(f => f.favorite), ...filteredList.filter(f => !f.favorite)]}
        <ul class="food-list">
          {#each _renderList as food (food.id)}
            {@const _sel = selectedFoods.has(food)}
            {@const _mSel = manageMode && food.id != null && manageSelected.has(food.id)}
            <li class="food-item card"
                class:food-selected={_sel || _mSel}
                class:food-pane-active={food.id != null && _paneFood?.id === food.id}
                in:fade={{ duration: 160 }}>
              {#if pickMode}
                <button class="food-select-btn" on:click={() => toggleSelect(food)} aria-label="Select">
                  <span class="food-check material-symbols-rounded" class:food-check-on={_sel}>
                    {_sel ? 'check_circle' : 'radio_button_unchecked'}
                  </span>
                </button>
              {:else if manageMode}
                <button class="food-select-btn" on:click={() => toggleManageSelect(food)} aria-label="Select">
                  <span class="food-check material-symbols-rounded" class:food-check-on={_mSel}>
                    {_mSel ? 'check_circle' : 'radio_button_unchecked'}
                  </span>
                </button>
              {/if}
              <button class="food-item-btn"
                on:click={() => manageMode ? toggleManageSelect(food) : pickFood(food)}
                on:contextmenu|preventDefault={() => !manageMode && longPress(food)}
                on:touchstart|passive={() => _startLongPress(() => !manageMode && longPress(food))}
                on:touchmove|passive={_cancelLongPress}
                on:touchend={_cancelLongPress}>
                {#if $foodsShowThumbnails && food.imgUrl}
                  <img class="food-thumb" src={food.imgUrl} alt="" loading="lazy" referrerpolicy="no-referrer" on:error={e => e.target.style.display='none'} />
                {:else}
                  <div class="food-thumb-placeholder">
                    <span class="material-symbols-rounded">{_tabIcon}</span>
                  </div>
                {/if}
                <div class="food-info">
                  <span class="food-name">
                    {#if food.favorite}<span class="material-symbols-rounded fav-mark" title="Favorite">favorite</span>{/if}
                    {food.name}
                  </span>
                  {#if activeTab === 0}
                    {#if food.brand}<span class="food-brand text-3 text-sm">{food.brand}</span>{/if}
                    <span class="food-kcal text-sm">{amountAndUnit(food.portion || 100, food.unit)}{#if food.nutrition_basis && ($showUnitMetadata || $warnUnitMismatch)} · <span class="food-basis text-3">per 100 {food.nutrition_basis}</span>{/if}{#if food._shared_by} · <span style="color:var(--accent)">by {food._shared_by}</span>{/if}</span>
                  {:else}
                    {@const _kcal = Math.round(Nutrition.sum((food.items||[]).map(i => Nutrition.calculate(i))).calories || food.nutrition?.calories || 0)}
                    {@const _mealEnergy = Nutrition.displayEnergy(_kcal, $energyUnit)}
                    <span class="food-brand text-3 text-sm">{mealServing(food.items)}{#if food._shared_by} · <span style="color:var(--accent)">by {food._shared_by}</span>{/if}</span>
                    <span class="food-kcal text-sm">{_mealEnergy.value.toLocaleString()} {_mealEnergy.unit}</span>
                  {/if}
                </div>
                {#if activeTab !== 1 && activeTab !== 2}
                  <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
                {/if}
              </button>
              {#if (activeTab === 1 || activeTab === 2) && (food.items || []).length > 0 && !manageMode}
                <button class="btn-icon meal-info-btn" on:click|stopPropagation={() => openMealInfo(food)}
                  aria-label="Show items in {food.name}" title="Show items">
                  <span class="material-symbols-rounded">info</span>
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

    {:else}
      <!-- ── External source results ─────────────────────────────────────────── -->
      {#if !search.trim()}
        <div class="empty-state">
          <span class="material-symbols-rounded empty-icon">search</span>
          <p>{$_('foods.search_in', { values: { source: _sourceLabel } })}</p>
        </div>

      {:else if loading || mealieLoading}
        <div class="loading-row">
          <span class="material-symbols-rounded spin">refresh</span>
          <span class="text-2 text-sm">{$_('foods.searching_in', { values: { source: _sourceLabel } })}</span>
        </div>

      {:else if apiResults.length === 0 && mealieResults.length === 0}
        <div class="empty-state">
          <span class="material-symbols-rounded empty-icon">search_off</span>
          <p>{$_('foods.no_results_in', { values: { source: _sourceLabel } })}</p>
        </div>

      {:else}
        <!-- Per-source tier filter hid every fetched result -->
        {#if apiResults.length > 0 && visibleApiResults.length === 0}
          <div class="empty-state">
            <span class="material-symbols-rounded empty-icon">filter_alt_off</span>
            <p>
              {apiResults.length.toLocaleString()} result{apiResults.length === 1 ? '' : 's'} hidden by the
              {searchSource === 'off' ? 'OFF' : 'USDA'} tier filter.
              Widen your selection in the dropdown next to the source chip.
            </p>
          </div>
        {/if}
        <!-- OFF / USDA results — rendered from visibleApiResults so the
             per-source tier filters can hide low-quality entries without
             changing the underlying fetch. -->
        {#if visibleApiResults.length > 0}
          <ul class="food-list">
            {#each visibleApiResults as food (food.id || food.barcode)}
              {@const _sel = selectedFoods.has(food)}
              {@const _foodEnergy = Nutrition.displayEnergy(food.nutrition?.calories || food.calories || 0, $energyUnit)}
              <li class="food-item card" class:food-selected={_sel}>
                {#if pickMode}
                  <button class="food-select-btn" on:click={() => toggleSelect(food)} aria-label="Select">
                    <span class="food-check material-symbols-rounded" class:food-check-on={_sel}>
                      {_sel ? 'check_circle' : 'radio_button_unchecked'}
                    </span>
                  </button>
                {/if}
                <button class="food-item-btn"
                  on:click={() => pickFood(food, searchSource)}
                  on:contextmenu|preventDefault={() => longPress(food)}
                  on:touchstart|passive={() => _startLongPress(() => longPress(food))}
                  on:touchmove|passive={_cancelLongPress}
                  on:touchend={_cancelLongPress}>
                  {#if food.imgUrl}
                    <img class="food-thumb" src={food.imgUrl} alt="" loading="lazy" referrerpolicy="no-referrer" on:error={e => e.target.style.display='none'} />
                  {:else}
                    <div class="food-thumb-placeholder">
                      <span class="material-symbols-rounded">{searchSource === 'usda' ? 'science' : 'public'}</span>
                    </div>
                  {/if}
                  <div class="food-info">
                    <span class="food-name">
                      {food.name}
                      {#if searchSource === 'off' && food.originTag}
                        {@const _flag = offCountryTagToFlag(food.originTag)}
                        {#if _flag}
                          <!-- OFF origin-country flag lifted from `origins_tags` (or
                               manufacturing_places_tags fallback). Only rendered when
                               we can map the tag to an ISO code — unmapped countries
                               show nothing rather than a placeholder. Sold-in countries
                               (`countries_tags`) are deliberately NOT used here since
                               they don't mean origin. -->
                          <span class="off-origin-flag" title={`Made in ${offCountryTagToName(food.originTag)}`} aria-label={`Origin: ${offCountryTagToName(food.originTag)}`}>{_flag}</span>
                        {/if}
                      {/if}
                    </span>
                    {#if food.brand}<span class="food-brand text-3 text-sm">{food.brand}</span>{/if}
                    <span class="food-kcal text-sm">
                      {_foodEnergy.value.toLocaleString()} {_foodEnergy.unit}
                      {#if searchSource === 'off' && typeof food.completeness === 'number'}
                        <!-- OFF data-completeness dot. Green when the entry has most
                             nutriment fields filled in, yellow when partial, grey when
                             sparse. Helps users pick the more reliable of two similar
                             OFF entries without opening each one. -->
                        <span class="off-quality-dot"
                              class:off-q-hi={food.completeness >= 0.7}
                              class:off-q-mid={food.completeness >= 0.4 && food.completeness < 0.7}
                              class:off-q-lo={food.completeness < 0.4}
                              title={`OFF data completeness: ${Math.round(food.completeness * 100)}%`}
                              aria-label={`Data completeness ${Math.round(food.completeness * 100)}%`}></span>
                      {/if}
                      {#if searchSource === 'usda' && food.dataType}
                        <!-- USDA data-type badge. Foundation + SR Legacy are USDA's
                             curated tiers (laboratory-analyzed staples, well-established
                             reference data). Survey (FNDDS) is composite dietary data.
                             Branded is manufacturer-submitted with widely varying quality.
                             Letter + color = fast visual signal so users pick the curated
                             entry over the brand-submitted one when searching common foods. -->
                        {@const _t = food.dataType}
                        {@const _abbr = _t === 'Foundation' ? 'F' : _t === 'SR Legacy' ? 'L' : _t === 'Survey (FNDDS)' ? 'S' : _t === 'Branded' ? 'B' : _t === 'Experimental' ? 'X' : '?'}
                        <span class="usda-type-badge"
                              class:usda-t-hi={_t === 'Foundation' || _t === 'SR Legacy'}
                              class:usda-t-mid={_t === 'Survey (FNDDS)'}
                              class:usda-t-lo={_t === 'Branded' || _t === 'Experimental'}
                              title={`USDA ${_t}`}
                              aria-label={`USDA data type ${_t}`}>{_abbr}</span>
                      {/if}
                    </span>
                  </div>
                </button>
              </li>
            {/each}
          </ul>
          <!-- Pagination footer: "Showing X of Y", plus a sentinel that
               triggers loadMoreExternal when it scrolls into view (240px
               rootMargin so we prefetch a screen before the user reaches
               the actual bottom). Hidden entirely on the last page. #96. -->
          {#if apiTotalHits > 0}
            <div class="pagination-footer">
              <span class="text-3 text-sm">
                {$_('foods.pagination.showing_x_of_y', { values: { shown: apiResults.length.toLocaleString(), total: apiTotalHits.toLocaleString() } })}
              </span>
              {#if apiLoadingMore}
                <span class="loading-more">
                  <span class="material-symbols-rounded spin">refresh</span>
                  {$_('foods.pagination.loading_more')}
                </span>
              {/if}
            </div>
            {#if apiHasMore && !apiLoadingMore}
              <div class="scroll-sentinel" use:_infiniteScroll={{ onIntersect: loadMoreExternal }}></div>
            {/if}
          {/if}
        {/if}

        <!-- Mealie results -->
        {#if mealieResults.length > 0}
          <ul class="food-list">
            {#each mealieResults as recipe (recipe.slug)}
              <li class="food-item card">
                <button class="food-item-btn" on:click={() => pickMealieRecipe(recipe)}>
                  {#if recipe.id}
                    <img class="food-thumb" src={Mealie.imageUrl(recipe.id)} alt=""
                      loading="lazy" on:error={e => e.target.style.display='none'} />
                  {:else}
                    <div class="food-thumb-placeholder">
                      <span class="material-symbols-rounded">menu_book</span>
                    </div>
                  {/if}
                  <div class="food-info">
                    <span class="food-name">{recipe.name}</span>
                    {#if recipe.recipeCategory?.length}
                      <span class="food-brand text-3 text-sm">{recipe.recipeCategory.map(c => c.name).join(', ')}</span>
                    {/if}
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    {/if}
  </div><!-- /.page-content -->
    </div><!-- /.foods-main -->

    <!-- Desktop detail pane (Phase B) — reuses the FoodDetailSheet
         component in embedded mode so the exact same identity /
         nutrition / actions markup renders in both places. Empty
         state prompts when nothing is selected. Only visible at
         ≥1440px via CSS; mobile continues to use the modal sheet. -->
    {#if _foodsPaneMode && !manageMode}
    <aside
      use:portal
      class="foods-detail-pane"
      style="--foods-pane-top:{_paneTopPx}px; --foods-pane-left:{_paneLeftPx}px; --foods-pane-width:{_paneWidthPx}px"
    >
      <FoodDetailSheet
        embedded={true}
        food={_paneFood}
        onDismiss={() => _paneFood = null}
        on:edit={onDetailEdit}
        on:addToDiary={onDetailAddToDiary}
        on:deleted={() => { _paneFood = null; detailSheetFood = null; load(); }}
      />
    </aside>
    {/if}
  </div><!-- /.foods-body -->
</div>

<!-- Multi-item portion sheet -->
<Sheet bind:open={showMultiPortionSheet} title={$_('foods.multi_portion_sheet', { values: { count: multiPortionItems.length } })}>
  <div bind:this={_multiPortionSheetEl} style="display:flex;flex-direction:column;gap:0;padding-top:4px" on:keydown={_onMultiPortionKey}>
    {#each multiPortionItems as item, i}
      {#if i > 0}<div style="height:1px;background:var(--border);margin:12px 0"></div>{/if}
      <div style="display:flex;flex-direction:column;gap:10px">
        <span style="font-size:13px;font-weight:600;color:var(--text-1)">{item.food.name}</span>
        {#if (item.food.notes || '').trim()}
          <div class="qty-notes qty-notes-compact">
            <span class="material-symbols-rounded qty-notes-icon">sticky_note_2</span>
            <span class="qty-notes-text">{item.food.notes}</span>
          </div>
        {/if}
        <div style="display:flex;gap:10px">
          <div style="flex:1">
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">{$_('foods_deep.serving_size')}</label>
            <input class="input" type="text" inputmode="decimal" use:decimalInput bind:value={item.portion} style="font-size:16px;width:100%" />
          </div>
          <div style="width:100px">
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">Unit</label>
            <UnitPicker bind:value={item.unit} />
          </div>
          <div style="width:72px">
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">{$_('foods_deep.servings')}</label>
            <input class="input" type="text" inputmode="decimal" use:decimalInput bind:value={item.servings} style="font-size:16px;width:100%" />
          </div>
        </div>
      </div>
    {/each}
    <button class="btn btn-primary w-full" style="margin-top:16px"
      on:click={confirmMultiPortionSheet} disabled={multiAdding}>
      {#if multiAdding}
        <span class="material-symbols-rounded spin" style="font-size:18px">refresh</span>
      {:else}
        Add {multiPortionItems.length} Item{multiPortionItems.length > 1 ? 's' : ''} to Diary
      {/if}
    </button>
  </div>
</Sheet>

<!-- Phase 2 of NutritionFactsBox rollout: read-only food detail sheet that
     replaces tap-to-edit on the Foods tab. Slides up over the food list;
     Edit button on the sheet closes it and pushes /foods/edit so no
     FoodEditor functionality is lost. Edit transition is intentionally
     overlapping (sheet slides down ~200ms while editor route slides in)
     so it reads as a single motion. -->
<FoodDetailSheet
  bind:open={detailSheetOpen}
  food={detailSheetFood}
  on:edit={onDetailEdit}
  on:addToDiary={onDetailAddToDiary}
  on:deleted={() => { detailSheetFood = null; load(); }} />

<!-- Quantity prompt sheet -->
<Sheet bind:open={showQtyPrompt} title={promptFood ? promptFood.name : 'Add to Diary'}>
  <div style="display:flex;flex-direction:column;gap:16px;padding-top:8px" on:keydown={_onQtyPromptKey}>
    <!-- Issues #69 + #70: surface the OFF nutrition basis so users know
         whether values are per-100-g or per-100-ml at a glance. Gated on
         the showUnitMetadata opt-in (or the warn-about-conversions toggle
         that implies it). -->
    {#if promptFood?.nutrition_basis && ($showUnitMetadata || $warnUnitMismatch)}
      <div class="qty-basis-label">
        Nutrition per 100 {promptFood.nutrition_basis}
      </div>
    {/if}
    {#if promptFood && (promptFood.notes || '').trim()}
      <div class="qty-notes">
        <span class="material-symbols-rounded qty-notes-icon">sticky_note_2</span>
        <span class="qty-notes-text">{promptFood.notes}</span>
      </div>
    {/if}
    <!-- Quick-pick chips for per-food alt_units (slice/cookie/bottle).
         Tapping fills portion=1 + unit=abbr so the user gets the right
         gram math via scaleFactor's tier-1 lookup. Issues #69 + #70.
         Gated on the showUnitMetadata opt-in (or warn-about-conversions). -->
    {#if promptFood?.alt_units && promptFood.alt_units.length > 0 && ($showUnitMetadata || $warnUnitMismatch)}
      <div class="qty-quickpicks">
        {#each promptFood.alt_units as au}
          <button type="button" class="qty-quickpick"
            class:active={promptUnit === au.abbr && parseDecimal(promptPortion) === 1}
            on:click={() => { promptPortion = 1; promptUnit = au.abbr; }}>
            1 {au.abbr} <span class="qty-quickpick-g">({au.grams} g)</span>
          </button>
        {/each}
      </div>
    {/if}
    <div style="display:flex;gap:12px">
      <div style="flex:1">
        <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">{$_('foods_deep.serving_size')}</label>
        <input class="input" type="text" inputmode="decimal" use:decimalInput
          bind:value={promptPortion} bind:this={_qtyPromptPortionEl}
          style="font-size:16px;width:100%" />
      </div>
      <div style="width:100px">
        <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">Unit</label>
        <UnitPicker bind:value={promptUnit} />
      </div>
    </div>
    <!-- Mismatch warning: gated behind the warnUnitMismatch setting.
         Fires when the picked unit's system doesn't match the food's
         nutrition_basis AND no density is set, so the scaler is using the
         1 ml = 1 g approximation that's rough for oils, honey, etc.
         Issues #69 + #70. -->
    {#if $warnUnitMismatch && promptFood?.nutrition_basis && !promptFood?.density_g_ml
         && _unitSystem(promptUnit) && _unitSystem(promptUnit) !== promptFood.nutrition_basis}
      <div class="qty-mismatch-warn">
        <span class="material-symbols-rounded">warning</span>
        <span>
          Nutrition is per 100 {promptFood.nutrition_basis}. Converting from {_unitSystem(promptUnit) === 'g' ? 'grams' : 'milliliters'} uses 1 ml ≈ 1 g, rough for oils, honey, etc. Add a <strong>Density (g/ml)</strong> value to the food for accurate conversion.
        </span>
      </div>
    {/if}
    <div>
      <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">{$_('foods_deep.num_servings')}</label>
      <input class="input" type="text" inputmode="decimal" use:decimalInput bind:value={promptServings}
        style="font-size:16px;width:100%" />
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-2);border-radius:var(--radius-md)">
      <span style="font-size:13px;color:var(--text-3)">{$_('foods_deep.total_amount')}</span>
      <span style="font-size:14px;font-weight:500">{Math.round((parseDecimal(promptPortion) || 100) * (parseDecimal(promptServings) || 1) * 10) / 10}{promptUnit || 'g'}</span>
    </div>
    <!-- Live nutrition preview (#30) — recomputes with portion/unit/servings changes.
         Color scheme mirrors the Nutrition Summary sheet + diary totals so the
         four macros read with the same visual language app-wide. -->
    <div class="qty-macros">
      <div class="qty-macro-pill" style="background:var(--macro-calories-dim)">
        <span class="qty-macro-val" style="color:var(--macro-calories)">{_qtyEnergy.value.toLocaleString()}</span>
        <span class="qty-macro-label">{_qtyEnergy.unit}</span>
      </div>
      <div class="qty-macro-pill" style="background:var(--macro-protein-dim)">
        <span class="qty-macro-val" style="color:var(--macro-protein)">{Math.round((qtyCalc.proteins || 0) * 10) / 10}g</span>
        <span class="qty-macro-label">protein</span>
      </div>
      <div class="qty-macro-pill" style="background:var(--macro-carbs-dim)">
        <span class="qty-macro-val" style="color:var(--macro-carbs)">{Math.round((qtyCalc.carbohydrates || 0) * 10) / 10}g</span>
        <span class="qty-macro-label">carbs</span>
      </div>
      <div class="qty-macro-pill" style="background:var(--macro-fat-dim)">
        <span class="qty-macro-val" style="color:var(--macro-fat)">{Math.round((qtyCalc.fat || 0) * 10) / 10}g</span>
        <span class="qty-macro-label">fat</span>
      </div>
    </div>
    <button class="btn btn-primary w-full" on:click={confirmQtyPrompt} disabled={_addingToDiary}>{$_('foods.add_to_diary')}</button>
  </div>
</Sheet>

<!-- Yesterday's meal info sheet — list of items in that meal group -->
<Sheet open={yesterdayInfoGroup != null}
  title={yesterdayInfoGroup ? `Yesterday: ${yesterdayInfoGroup.mealName}` : ''}
  on:close={() => yesterdayInfoGroup = null}>
  {#if yesterdayInfoGroup}
    {@const _yTotEnergy = Nutrition.displayEnergy(yesterdayInfoGroup.totalKcal, $energyUnit)}
    <div style="padding:0 4px 8px">
      {#each yesterdayInfoGroup.items as it}
        {@const _itEnergy = Nutrition.displayEnergy((it.nutrition?.calories || it.calories || 0) * (it.quantity || 1), $energyUnit)}
        {@const _img = liveImgFor(it)}
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border)">
          {#if _img && !_yesterdayImgFailed.has(it)}
            <img src={resolveAssetUrl(_img)} alt="" loading="lazy" referrerpolicy="no-referrer"
              style="width:40px;height:40px;border-radius:var(--radius-sm,6px);object-fit:cover;flex-shrink:0"
              on:error={() => { _yesterdayImgFailed.add(it); _yesterdayImgFailed = _yesterdayImgFailed; }} />
          {:else}
            <div style="width:40px;height:40px;border-radius:var(--radius-sm,6px);background:var(--surface-3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <span class="material-symbols-rounded" style="color:var(--text-3);font-size:18px">restaurant</span>
            </div>
          {/if}
          <div style="display:flex;flex-direction:column;min-width:0;flex:1">
            <span style="font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{it.name || 'Unnamed'}</span>
            {#if it.brand}<span class="text-3 text-sm">{it.brand}</span>{/if}
            <span class="text-3 text-sm">
              {it.quantity ? `${it.quantity} × ` : ''}{amountAndUnit(it.portion || 100, it.unit)}
            </span>
          </div>
          <span class="text-2 text-sm" style="font-variant-numeric:tabular-nums;margin-left:8px;flex-shrink:0">
            {_itEnergy.value.toLocaleString()} {_itEnergy.unit}
          </span>
        </div>
      {/each}
      <div style="display:flex;justify-content:space-between;padding:12px;font-weight:600">
        <span>{$_('foods_deep.total')}</span>
        <span>{_yTotEnergy.value.toLocaleString()} {_yTotEnergy.unit}</span>
      </div>
      <button class="btn btn-primary w-full" style="margin-top:8px"
        on:click={() => { const g = yesterdayInfoGroup; yesterdayInfoGroup = null; addYesterdayMeal(g); }}>
        Add this meal
      </button>
    </div>
  {/if}
</Sheet>

<!-- Saved meal/recipe info sheet — list of items inside that meal/recipe -->
<Sheet open={mealInfoGroup != null}
  title={mealInfoGroup ? `${mealInfoGroup.isRecipe ? 'Recipe' : 'Meal'}: ${mealInfoGroup.mealName}` : ''}
  on:close={() => mealInfoGroup = null}>
  {#if mealInfoGroup}
    {@const _mTotEnergy = Nutrition.displayEnergy(mealInfoGroup.totalKcal, $energyUnit)}
    <div style="padding:0 4px 8px">
      {#each mealInfoGroup.items as it}
        {@const _itEnergy = Nutrition.displayEnergy((it.nutrition?.calories || it.calories || 0) * (it.quantity || 1), $energyUnit)}
        {@const _img = liveImgFor(it)}
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border)">
          {#if _img && !_mealInfoImgFailed.has(it)}
            <img src={resolveAssetUrl(_img)} alt="" loading="lazy" referrerpolicy="no-referrer"
              style="width:40px;height:40px;border-radius:var(--radius-sm,6px);object-fit:cover;flex-shrink:0"
              on:error={() => { _mealInfoImgFailed.add(it); _mealInfoImgFailed = _mealInfoImgFailed; }} />
          {:else}
            <div style="width:40px;height:40px;border-radius:var(--radius-sm,6px);background:var(--surface-3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <span class="material-symbols-rounded" style="color:var(--text-3);font-size:18px">restaurant</span>
            </div>
          {/if}
          <div style="display:flex;flex-direction:column;min-width:0;flex:1">
            <span style="font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{it.name || 'Unnamed'}</span>
            {#if it.brand}<span class="text-3 text-sm">{it.brand}</span>{/if}
            <span class="text-3 text-sm">
              {it.quantity ? `${it.quantity} × ` : ''}{amountAndUnit(it.portion || 100, it.unit)}
            </span>
          </div>
          <span class="text-2 text-sm" style="font-variant-numeric:tabular-nums;margin-left:8px;flex-shrink:0">
            {_itEnergy.value.toLocaleString()} {_itEnergy.unit}
          </span>
        </div>
      {/each}
      <div style="display:flex;justify-content:space-between;padding:12px;font-weight:600">
        <span>{$_('foods_deep.total')}</span>
        <span>{_mTotEnergy.value.toLocaleString()} {_mTotEnergy.unit}</span>
      </div>
      {#if pickMode}
        <button class="btn btn-primary w-full" style="margin-top:8px"
          on:click={() => { const f = mealInfoGroup.food; mealInfoGroup = null; pickFood(f); }}>
          Add this {mealInfoGroup.isRecipe ? 'recipe' : 'meal'}
        </button>
      {/if}
    </div>
  {/if}
</Sheet>

<BarcodeScanner bind:open={scannerOpen} on:scan={handleScan} on:close={() => scannerOpen = false} />

<!-- Barcode-lookup loading overlay. Deferred reveal (see _armScanIndicator
     above) means fast lookups don't flash this UI; only lookups that run
     past 400ms render it. Non-modal: doesn't catch clicks, just signals
     activity. Dismisses automatically when handleScan's finally fires. -->
{#if _scanIndicatorVisible}
  <div class="scan-lookup-overlay" transition:fade={{ duration: 150 }}>
    <div class="scan-lookup-card" role="status" aria-live="polite">
      <span class="material-symbols-rounded scan-lookup-spin">progress_activity</span>
      <div class="scan-lookup-text">
        <span class="scan-lookup-title">{$_('foods.looking_up_barcode')}</span>
        {#if _scanLookupCode}
          <span class="scan-lookup-code">{_scanLookupCode}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<ActionSheet
  bind:open={showItemActions}
  title={selectedItem ? selectedItem.name : ''}
  actions={selectedItem?._shared_by != null ? [
    { label: 'Save to My Catalog', icon: 'bookmark_add', value: 'copy' },
  ] : !selectedItem?.id ? [
    { label: 'Save to My Foods', icon: 'bookmark_add', value: 'copy' },
  ] : [
    { label: 'Edit',   icon: 'edit',        value: 'edit' },
    ...(activeTab !== 0 ? [{ label: 'Clone', icon: 'content_copy', value: 'clone' }] : []),
    { label: 'Select Multiple', icon: 'checklist', value: 'select' },
    { label: 'Delete', icon: 'delete',      value: 'delete', danger: true },
  ]}
  on:select={handleItemAction}
/>

<Dialog
  bind:open={showDeleteDialog}
  title="Delete item?"
  message="This will permanently delete this item."
  confirmText="Delete"
  dangerous
  on:confirm={() => selectedItem && deleteItem(selectedItem)}
/>

<Dialog
  bind:open={showBulkDeleteDialog}
  title={`Delete ${manageSelected.size} ${manageSelected.size === 1 ? 'item' : 'items'}?`}
  message="Diary entries that reference these will keep their nutrition snapshot but lose the link to the source. This can't be undone."
  confirmText="Delete"
  dangerous
  on:confirm={confirmBulkDelete}
/>

<!-- OFF tier filter dropdown — backdrop-wrapped, portalled to body,
     positioned via getBoundingClientRect measured on open. Follows the
     exact pattern of ActionSheet.svelte: backdrop's on:click closes,
     inner panel uses on:click|stopPropagation so clicks on checkboxes
     don't propagate to the backdrop. -->
{#if offDropdownOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="tier-dropdown-backdrop"
    in:fade={{ duration: 120 }} out:fade={{ duration: 100 }}>
    <div class="tier-dropdown-panel"
      bind:this={offDropdownPanelEl}
      style="top:{offDropdownPos.top}px; right:{offDropdownPos.right}px;"
      on:click|stopPropagation
      in:slide={{ duration: 140 }}>
      <div class="tier-dropdown-header">
        <span>{$_('foods.tier.off_data_quality')}</span>
        {#if offTiersFiltered}
          <button class="tier-reset" on:click={resetOffTiers}>{$_('foods.tier.reset')}</button>
        {/if}
      </div>
      <label class="tier-option">
        <input type="checkbox" checked={offTiersActive.has('hi')} on:change={() => toggleOffTier('hi')} />
        <span class="tier-swatch tier-swatch-hi"></span>
        <span class="tier-label">{$_('foods.tier.off_high')} <span class="tier-hint">{$_('foods.tier.off_high_hint')}</span></span>
      </label>
      <label class="tier-option">
        <input type="checkbox" checked={offTiersActive.has('mid')} on:change={() => toggleOffTier('mid')} />
        <span class="tier-swatch tier-swatch-mid"></span>
        <span class="tier-label">{$_('foods.tier.off_medium')} <span class="tier-hint">{$_('foods.tier.off_medium_hint')}</span></span>
      </label>
      <label class="tier-option">
        <input type="checkbox" checked={offTiersActive.has('lo')} on:change={() => toggleOffTier('lo')} />
        <span class="tier-swatch tier-swatch-lo"></span>
        <span class="tier-label">{$_('foods.tier.off_low')} <span class="tier-hint">{$_('foods.tier.off_low_hint')}</span></span>
      </label>
      <label class="tier-option">
        <input type="checkbox" checked={offTiersActive.has('unknown')} on:change={() => toggleOffTier('unknown')} />
        <span class="tier-swatch"></span>
        <span class="tier-label">{$_('foods.tier.off_unknown')} <span class="tier-hint">{$_('foods.tier.off_unknown_hint')}</span></span>
      </label>
    </div>
  </div>
{/if}

{#if usdaDropdownOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="tier-dropdown-backdrop"
    in:fade={{ duration: 120 }} out:fade={{ duration: 100 }}>
    <div class="tier-dropdown-panel"
      bind:this={usdaDropdownPanelEl}
      style="top:{usdaDropdownPos.top}px; right:{usdaDropdownPos.right}px;"
      on:click|stopPropagation
      in:slide={{ duration: 140 }}>
      <div class="tier-dropdown-header">
        <span>{$_('foods.tier.usda_data_type')}</span>
        {#if usdaTiersFiltered}
          <button class="tier-reset" on:click={resetUsdaTiers}>{$_('foods.tier.reset')}</button>
        {/if}
      </div>
      <label class="tier-option">
        <input type="checkbox" checked={usdaTiersActive.has('Foundation')} on:change={() => toggleUsdaTier('Foundation')} />
        <span class="tier-swatch tier-swatch-hi"></span>
        <span class="tier-label">{$_('foods.tier.usda_foundation')} <span class="tier-hint">{$_('foods.tier.usda_foundation_hint')}</span></span>
      </label>
      <label class="tier-option">
        <input type="checkbox" checked={usdaTiersActive.has('SR Legacy')} on:change={() => toggleUsdaTier('SR Legacy')} />
        <span class="tier-swatch tier-swatch-hi"></span>
        <span class="tier-label">{$_('foods.tier.usda_sr_legacy')} <span class="tier-hint">{$_('foods.tier.usda_sr_legacy_hint')}</span></span>
      </label>
      <label class="tier-option">
        <input type="checkbox" checked={usdaTiersActive.has('Survey (FNDDS)')} on:change={() => toggleUsdaTier('Survey (FNDDS)')} />
        <span class="tier-swatch tier-swatch-mid"></span>
        <span class="tier-label">{$_('foods.tier.usda_survey')} <span class="tier-hint">{$_('foods.tier.usda_survey_hint')}</span></span>
      </label>
      <label class="tier-option">
        <input type="checkbox" checked={usdaTiersActive.has('Branded')} on:change={() => toggleUsdaTier('Branded')} />
        <span class="tier-swatch tier-swatch-lo"></span>
        <span class="tier-label">{$_('foods.tier.usda_branded')} <span class="tier-hint">{$_('foods.tier.usda_branded_hint')}</span></span>
      </label>
      <label class="tier-option">
        <input type="checkbox" checked={usdaTiersActive.has('Experimental')} on:change={() => toggleUsdaTier('Experimental')} />
        <span class="tier-swatch tier-swatch-lo"></span>
        <span class="tier-label">{$_('foods.tier.usda_experimental')} <span class="tier-hint">{$_('foods.tier.usda_experimental_hint')}</span></span>
      </label>
    </div>
  </div>
{/if}

<style>
  /* Live-preview macro pills inside the qty-prompt sheet (#30).
     Mirrors the diary edit sheet's .edit-macro-pill styling. */
  .qty-macros { display: flex; gap: 8px; flex-wrap: wrap; }
  /* Issues #69 + #70: basis label + alt-unit quick-picks + mismatch warning */
  .qty-basis-label {
    font-size: 12px;
    color: var(--text-3);
    text-align: center;
    margin-top: -8px;
  }
  .qty-quickpicks {
    display: flex; flex-wrap: wrap; gap: 8px;
  }
  .qty-quickpick {
    padding: 6px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text-1);
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .qty-quickpick:hover { background: var(--surface-3); }
  .qty-quickpick.active {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .qty-quickpick-g {
    color: var(--text-3);
    font-size: 12px;
  }
  .qty-mismatch-warn {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--warning, #f59e0b) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 35%, transparent);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-1);
    line-height: 1.5;
  }
  .qty-mismatch-warn .material-symbols-rounded {
    color: var(--warning, #f59e0b);
    font-size: 18px;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .qty-macro-pill {
    flex: 1;
    min-width: 60px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    padding: 8px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .qty-macro-val   { font-size: 15px; font-weight: 700; color: var(--text-1); }
  .qty-macro-label { font-size: 10px; color: var(--text-3); text-transform: uppercase; letter-spacing: .4px; }

  /* Meals tab section headers ("Yesterday's Meals" / "Saved Meals") — small uppercase
     label matching .section-title style, but as a clickable button with a chevron so
     users can collapse each section independently. */
  .meal-section-header {
    display: flex;
    align-items: center;
    width: 100%;
    background: none;
    border: none;
    padding: var(--space-4) var(--page-px) var(--space-2);
    cursor: pointer;
    text-align: left;
    color: var(--text-3);
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  .meal-section-header:active { color: var(--text-2); }
  .meal-section-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    flex: 1;
  }
  .meal-section-chevron {
    font-size: 20px;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .meal-section-chevron-collapsed { transform: rotate(-90deg); }

  /* Notes display in quick-add sheets */
  .qty-notes {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 10px 12px;
    background: var(--surface-2);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
  }
  .qty-notes.qty-notes-compact { padding: 8px 10px; }
  .qty-notes-icon {
    font-size: 16px; color: var(--accent);
    flex-shrink: 0; margin-top: 1px;
  }
  .qty-notes-text {
    font-size: 13px; line-height: 1.5;
    color: var(--text-2);
    white-space: pre-wrap; word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .foods-sticky-bar {
    position: sticky;
    /* 62 + var(--hamburger-row): pins flush below header in both
       hamburger-visible (48) and pinned-sidebar (0) modes. */
    top: calc(var(--page-top, var(--safe-top)) + 60px + var(--hamburger-row, 0px));
    z-index: 20;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
  }
  /* With banner: pad-bot is 72 → 122 + hamburger-row */
  :global(.page-header.has-banner) ~ .foods-sticky-bar {
    top: calc(var(--page-top, var(--safe-top)) + 122px + var(--hamburger-row, 0px));
  }
  .foods-tabs { padding: 12px var(--page-px) 12px; }
  .foods-search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 var(--page-px) 6px;
  }
  .foods-search-icon { font-size: 20px; color: var(--text-3); flex-shrink: 0; }
  .foods-search-input-wrap {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
  }
  .foods-search-input {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 7px 40px 7px 14px;
    font-size: 15px;
    color: var(--text-1);
    outline: none;
  }
  .foods-search-input:focus { border-color: var(--accent); }

  .food-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .food-item { overflow: hidden; }
  .meal-info-btn { flex-shrink: 0; margin-right: 8px; align-self: center; }
  .food-item-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    /* flex + min-width: 0 so we take remaining space after the sibling
       meal-info-btn claims its own, and allow the food-name inside to
       shrink and ellipsis-truncate. Previously used `width: 100%` which
       forced full parent width and pushed the info button past the
       card boundary on narrow viewports (Firefox + iOS Safari). #106 */
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background var(--dur-fast);
    color: var(--text-1);
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .food-item-btn:active { background: var(--surface-2); }
  .food-thumb {
    width: 52px; height: 52px;
    border-radius: var(--radius-sm);
    object-fit: cover;
    background: var(--surface-2);
    flex-shrink: 0;
  }
  .food-thumb-placeholder {
    width: 52px; height: 52px;
    border-radius: var(--radius-sm);
    background: var(--accent-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--accent);
    font-size: 20px;
  }
  .food-info  { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .food-name  { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fav-mark   { font-size: 14px; vertical-align: -2px; color: var(--macro-protein, #ec4899); margin-right: 4px; }
  .food-brand { }
  .food-kcal  { color: var(--text-2); }

  /* Small dot next to kcal on OFF results indicating how complete the OFF
     entry's data is (green ≥70%, yellow 40-69%, grey <40%). Lets users
     eyeball which of two similar entries is more trustworthy without
     opening each one. Cursor stays default because the parent is already
     a button (whole row is the tap target); the dot is decorative + a
     hover/long-press tooltip. */
  .off-quality-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-left: 6px;
    vertical-align: 1px;
    background: var(--border);
  }
  .off-q-hi  { background: #22c55e; }
  .off-q-mid { background: #eab308; }
  .off-q-lo  { background: var(--text-3); }

  /* USDA data-type badge — single letter with color-coded background.
     Curated tiers (Foundation, SR Legacy) get green, Survey/FNDDS gets
     yellow, Branded/Experimental grey. Similar visual weight to the
     OFF completeness dot but text-carrying since USDA's four types
     don't map cleanly to a continuous scale. */
  .usda-type-badge {
    display: inline-block;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    margin-left: 6px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
    color: white;
    vertical-align: 1px;
    background: var(--text-3);
  }
  .usda-t-hi  { background: #22c55e; }
  .usda-t-mid { background: #eab308; }
  .usda-t-lo  { background: var(--text-3); }

  /* Source badge — pill on each row in 'all' search mode indicating which
     source the item came from (Local / Shared / Mealie / USDA / OFF).
     Colors chosen for scannability: user's own = green, community = neutral
     gray, curated/structured = accent, self-hosted Mealie = orange. #96. */
  .source-badge {
    flex-shrink: 0;
    align-self: center;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    margin-left: 8px;
  }
  .source-badge-local  { background: rgba(74, 222, 128, 0.14); color: rgb(52, 179, 105); }
  .source-badge-shared { background: rgba(168, 85, 247, 0.14); color: rgb(168, 85, 247); }
  .source-badge-mealie { background: rgba(251, 146, 60, 0.14); color: rgb(234, 128, 42); }
  .source-badge-usda   { background: rgba(59, 130, 246, 0.14); color: rgb(59, 130, 246); }
  .source-badge-off    { background: rgba(148, 163, 184, 0.18); color: rgb(148, 163, 184); }

  /* Pagination footer under external results (single-source OFF/USDA
     modes). "Showing X of Y" gives users the truth about how much data
     is behind the query, and the scroll-sentinel silently drives
     infinite scroll — no explicit "load more" button. #96. */
  .pagination-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 4px 0;
    gap: 8px;
  }
  .loading-more {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-2);
    font-size: 13px;
  }
  .loading-more .material-symbols-rounded {
    font-size: 16px;
  }
  .scroll-sentinel {
    /* Zero-height / non-interactive sentinel. IntersectionObserver
       watches it; when it enters the viewport (with rootMargin), we
       fetch the next page. Height 1px avoids some browsers collapsing
       0-height elements out of the layout tree. */
    height: 1px;
    width: 100%;
    pointer-events: none;
  }

  /* ALL-mode per-source counts strip. One chip per enabled source so
     the user sees exactly what each source contributed and whether more
     hits exist (e.g. "USDA · 50 of 20,968"). Dots reuse the badge color
     scheme so the strip and the row badges speak the same visual
     language. #96. */
  .all-source-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 10px 4px 0;
  }
  .asc-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
  }
  .asc-dot {
    width: 6px; height: 6px; border-radius: 50%;
    flex-shrink: 0;
  }
  .asc-local  { background: rgb(52, 179, 105); }
  .asc-shared { background: rgb(168, 85, 247); }
  .asc-mealie { background: rgb(234, 128, 42); }
  .asc-usda   { background: rgb(59, 130, 246); }
  .asc-off    { background: rgb(148, 163, 184); }

  .server-error-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    margin: 0 0 8px;
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

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 48px 24px;
    text-align: center;
    color: var(--text-2);
  }
  .empty-icon { font-size: 48px; color: var(--accent); opacity: 0.6; }
  .empty-state-hint { font-size: 12px; color: var(--text-3, #888); margin-top: -8px; }

  .loading-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px;
    justify-content: center;
  }

  .cat-filter-row {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 6px;
    padding: 0 var(--page-px) 10px;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .cat-filter-row::-webkit-scrollbar { display: none; }
  .cat-chip {
    flex-shrink: 0;
    padding: 5px 12px;
    border-radius: var(--radius-full);
    border: 1.5px solid var(--border);
    background: none;
    font-size: 13px;
    cursor: pointer;
    color: var(--text-2);
    transition: all var(--dur-fast);
    white-space: nowrap;
  }
  .cat-chip.active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 600; }

  .source-chip-row {
    display: flex;
    gap: 6px;
    padding: 0 var(--page-px) 10px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  /* ── Multi-select ─────────────────────────────────────────────────────── */
  .food-item { display: flex; align-items: stretch; }

  .food-select-btn {
    display: flex;
    align-items: center;
    padding: 0 4px 0 14px;
    background: none;
    border: none;
    cursor: pointer;
    flex-shrink: 0;
    color: var(--text-3);
  }
  .food-check {
    font-size: 22px;
    transition: color var(--dur-fast);
  }
  .food-check-on { color: var(--accent); }

  .food-item.food-selected { background: var(--accent-dim); }

  .pick-count-title { color: var(--accent); }
  .pick-confirm-btn {
    display: flex; align-items: center; gap: 6px;
    height: 36px; padding: 0 14px; font-size: 13px; font-weight: 600;
  }

  .source-chip-row::-webkit-scrollbar { display: none; }
  .source-chip {
    flex-shrink: 0;
    padding: 5px 16px;
    border-radius: var(--radius-full);
    border: 1.5px solid var(--border);
    background: var(--surface-1);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    color: var(--text-2);
    transition: all var(--dur-fast);
    white-space: nowrap;
    /* Suppress the Android WebView text-selection popup that fires on
       long-press. Same treatment as action-sheet items — see memory
       note feedback_android_long_press.md. */
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .source-chip:hover { background: var(--surface-2); }
  .source-chip.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--surface-1);
    font-weight: 600;
  }

  /* Split source chip — left half selects source, right half opens a
     tier filter dropdown. Wrapper is a plain flex container (no
     positioning needed — the dropdown is portalled + fixed-positioned). */
  .source-chip-wrap {
    display: inline-flex;
    align-items: stretch;
    flex-shrink: 0;
  }
  .source-chip-split {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: none;
    padding-right: 10px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .source-chip-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    border: 1.5px solid var(--border);
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-top-right-radius: var(--radius-full);
    border-bottom-right-radius: var(--radius-full);
    background: var(--surface-1);
    color: var(--text-3);
    cursor: pointer;
    transition: all var(--dur-fast);
  }
  .source-chip-caret:hover { background: var(--surface-2); color: var(--text-2); }
  .source-chip-caret.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--surface-1);
  }
  .source-chip-caret .material-symbols-rounded {
    font-size: 16px;
    transition: transform var(--dur-fast);
  }
  .source-chip-caret.open .material-symbols-rounded {
    transform: rotate(180deg);
  }
  /* Small dot on the source label when the tier filter is narrowing */
  .tier-active-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.7;
    margin-left: 2px;
  }

  /* Tier filter dropdown — matches ActionSheet.svelte's proven pattern:
     backdrop covers full viewport (transparent — no dim, dropdown
     shouldn't feel like a modal), inner panel is fixed-positioned near
     the caret. Backdrop click closes; panel click|stopPropagation
     prevents accidental close when interacting with checkboxes.
     Globalized because :global(.tier-dropdown-backdrop) etc. lands
     inside document.body via use:portal. */
  :global(.tier-dropdown-backdrop) {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: transparent;
    /* CRITICAL: backdrop is non-blocking so touches pass through to the
       underlying page. First swipe both dismisses the dropdown (via the
       svelte:window handlers below) AND scrolls the page natively in
       the same gesture. Panel below re-enables pointer-events so its
       checkboxes remain interactive. */
    pointer-events: none;
  }
  :global(.tier-dropdown-panel) {
    position: fixed;
    min-width: 220px;
    max-width: min(calc(100vw - 24px), 260px);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 12px);
    box-shadow: var(--shadow-md, 0 8px 24px rgba(0,0,0,0.15));
    padding: 6px;
    /* Re-enable — backdrop is pointer-events:none for scroll-passthrough. */
    pointer-events: auto;
  }
  :global(.tier-dropdown-header) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  :global(.tier-reset) {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    text-transform: none;
    letter-spacing: 0;
  }
  :global(.tier-reset:hover) { text-decoration: underline; }
  :global(.tier-option) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-1);
    transition: background var(--dur-fast);
  }
  :global(.tier-option:hover) { background: var(--surface-2); }
  :global(.tier-option input[type="checkbox"]) {
    margin: 0;
    flex-shrink: 0;
    accent-color: var(--accent);
  }
  :global(.tier-swatch) {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-3);
    flex-shrink: 0;
  }
  :global(.tier-swatch-hi)  { background: #22c55e; }
  :global(.tier-swatch-mid) { background: #eab308; }
  :global(.tier-swatch-lo)  { background: var(--text-3); }
  :global(.tier-label) { flex: 1; }
  :global(.tier-hint) {
    color: var(--text-3);
    font-size: 11px;
    margin-left: 2px;
  }

  /* OFF origin-country flag emoji shown next to each OFF result's name.
     Small, inline, decorative — the tooltip carries the country name for
     platforms where flag emojis render as country-code text (older
     Android, some Linux). Kept subtle so the food name stays the focus. */
  .off-origin-flag {
    display: inline-block;
    margin-left: 6px;
    font-size: 14px;
    vertical-align: -1px;
    line-height: 1;
  }

  /* Barcode-lookup loading overlay. Centered card, soft backdrop, polished
     spinner. pointer-events: none on the wrapper so the user can still
     interact with the page underneath (e.g. cancel by navigating away).
     Lives above the bottom nav (~900) and below toasts (~9999). */
  .scan-lookup-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
    padding: 16px;
  }
  .scan-lookup-card {
    pointer-events: auto;
    display: flex; align-items: center; gap: 14px;
    padding: 14px 18px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 10px 32px -8px rgba(0, 0, 0, 0.35),
                0 2px 6px rgba(0, 0, 0, 0.18);
    min-width: 220px; max-width: min(360px, 90vw);
  }
  .scan-lookup-spin {
    font-size: 28px;
    color: var(--accent);
    flex-shrink: 0;
    animation: scan-lookup-rotate 1s linear infinite;
  }
  .scan-lookup-text {
    display: flex; flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .scan-lookup-title {
    font-size: 14px; font-weight: 600;
    color: var(--text-1);
  }
  .scan-lookup-code {
    font-size: 12px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  @keyframes scan-lookup-rotate {
    to { transform: rotate(360deg); }
  }

  /* Manage-mode topbar (Foods) — mirrors Diary's .diary-topbar-actions
     styling so cancel/delete icons pin to the top-right of the viewport
     independent of the header banner. */
  :global(.foods-topbar-actions) {
    position: fixed;
    top: calc(var(--safe-top, 0px) + 10px);
    right: 12px;
    z-index: 41;
    display: flex;
    align-items: center;
    gap: 2px;
    pointer-events: all;
  }
  .select-mode-title { color: var(--accent); }

  /* ───────────────────────────────────────────────────────────────
     Foods desktop Phase A — left filter rail (≥1280px).

     Mobile / narrow (default): chip rows sit inline in the sticky
     bar (sources) and just below it (categories), scrolling
     horizontally. That behavior is unchanged.

     Desktop (≥1280px, unless force-mobile-layout is on): the same
     chip-render snippets flow vertically into a 240px sticky rail
     on the left of the foods body; the mobile inline chip rows
     are hidden. Same handlers, same state — one code path, two
     layouts, mirroring the Diary right-rail + Settings two-pane
     pattern. */
  .foods-body {
    display: block;
  }
  .foods-filter-rail,
  .foods-detail-pane {
    display: none;
  }

  @media (min-width: 1280px) {
    :global(html:not(.force-mobile-layout)) .foods-body {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 20px;
      align-items: start;
      /* Match page-content's 12px top padding so the rail top border
         aligns with the first card's top edge in the middle column
         (page-content has padding: 12px var(--page-px) 0). */
      padding: 12px var(--page-px) 0;
    }
    /* Middle column has its own .page-content padding — zero out
       here to avoid doubling with the new .foods-body padding. */
    :global(html:not(.force-mobile-layout)) .foods-main :global(.page-content) {
      padding-top: 0;
    }
    /* Explicit column placement so .foods-main stays in the middle
       track even when the rail + pane are portaled out (their asides
       leave the grid, and without this, .foods-main falls into column
       1 and the list gets squished into the 240px rail column). */
    :global(html:not(.force-mobile-layout)) .foods-main {
      grid-column: 2 / 3;
    }
    /* Rail — position:fixed + portaled to document.body, same
       pattern as NT Diary's right rail (see
       feedback_traceapps_fixed_positioning_in_scroll_wrapper).
       .page-transition's will-change:transform breaks the naive
       position:fixed containing block, so JS drives left/top from
       the .foods-body grid via inline CSS custom properties. */
    :global(html:not(.force-mobile-layout)) .foods-filter-rail {
      display: flex;
      flex-direction: column;
      gap: 4px;
      position: fixed;
      top: calc(var(--page-top, var(--safe-top)) + var(--foods-rail-top, 130px) + var(--hamburger-row, 0px));
      left: var(--foods-rail-left, auto);
      width: var(--foods-rail-width, 240px);
      z-index: 5;
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - var(--foods-rail-top, 130px)
        - 20px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow-y: auto;
      padding: 12px 10px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    :global(html:not(.force-mobile-layout)) .foods-filter-heading {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-3);
      margin: 8px 4px 6px;
    }
    :global(html:not(.force-mobile-layout)) .foods-filter-heading:first-child {
      margin-top: 0;
    }
    :global(html:not(.force-mobile-layout)) .foods-filter-empty {
      margin: 4px;
      padding: 12px 8px;
      color: var(--text-3);
      font-size: 12px;
      line-height: 1.4;
      text-align: center;
    }
    /* Rail chip containers — flip from horizontal scroll to
       vertical flow. Every chip inside becomes a full-width row. */
    :global(html:not(.force-mobile-layout)) .foods-rail-chips {
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow: visible;
      padding: 0;
    }
    /* Chip restyle inside the rail: full-width, left-aligned pills
       instead of round mobile chips. Uses :global() because the
       chip markup lives inside the snippet (rendered inside the
       rail via {@render sourceChips()}), so Diary's scoping hash
       won't be on them without opting out. */
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.source-chip),
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.source-chip-split),
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.cat-chip) {
      width: 100%;
      justify-content: flex-start;
      text-align: left;
      padding: 8px 12px;
      border-radius: var(--radius-md);
      border-width: 1px;
      font-weight: 500;
    }
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.source-chip.active),
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.cat-chip.active) {
      background: var(--accent-dim);
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    }
    /* Focus-visible ring for keyboard nav — matches the Settings
       rail so tab-through has a consistent look across surfaces. */
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.source-chip:focus-visible),
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.source-chip-caret:focus-visible),
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.cat-chip:focus-visible) {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    /* Selected food card gets an accent border + subtle tint so the
       list-vs-pane relationship is obvious. Only fires when the
       detail pane is showing a food from the current list. */
    :global(html:not(.force-mobile-layout)) :global(.food-item.food-pane-active) {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 6%, var(--surface-1));
      box-shadow: 0 0 0 1px var(--accent);
    }
    /* Split source chips (OFF, USDA) — keep the caret snug on the
       right of the pill. */
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.source-chip-wrap) {
      display: flex;
      width: 100%;
    }
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.source-chip-wrap .source-chip) {
      flex: 1 1 auto;
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
    }
    :global(html:not(.force-mobile-layout)) .foods-rail-chips :global(.source-chip-caret) {
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
    }
    /* Hide mobile chip scrollers on desktop — same chips now live
       in the rail. */
    :global(html:not(.force-mobile-layout)) .foods-mobile-chips {
      display: none;
    }
  }

  /* Foods Phase B — right detail-preview pane at ≥1440px. Below
     1440 the pane would squeeze the main list too tight; the
     modal FoodDetailSheet keeps working on tap there. At ≥1440 the
     pane replaces the sheet: tap a food and its identity /
     nutrition / actions render inline in the third column instead
     of sliding up as a modal. */
  @media (min-width: 1440px) {
    :global(html:not(.force-mobile-layout)) .foods-body {
      grid-template-columns: 240px minmax(0, 1fr) 420px;
    }
    :global(html:not(.force-mobile-layout)) .foods-detail-pane {
      display: block;
      /* Same portaled + position:fixed pattern as the filter rail
         above. --foods-pane-* vars come from Foods.svelte's
         _measureFoodsRails, updated on mount + resize. */
      position: fixed;
      top: calc(var(--page-top, var(--safe-top)) + var(--foods-pane-top, 130px) + var(--hamburger-row, 0px));
      left: var(--foods-pane-left, auto);
      width: var(--foods-pane-width, 420px);
      z-index: 5;
      /* Subtract EVERYTHING between the pane's top and the viewport
         bottom: safe-top, sticky bar (130), hamburger row, bottom
         nav (var(--nav-h) + safe-bottom), and a small slack. Without
         the bottom-nav terms the pane's action buttons (Add to
         Diary, Edit, Delete) got clipped by the bottom nav bar. */
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - var(--foods-pane-top, 130px)
        - 20px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow-y: auto;
      padding: 16px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    /* Phase C — main list becomes a 2-column card grid at ≥1440px
       so the wide center column doesn't render 350-360px cards on
       a 800px-wide surface. All food-list variants (Local, OFF,
       USDA, Mealie, All-mode) inherit via :global. min-width:0 on
       each card so long names don't blow the grid layout. */
    :global(html:not(.force-mobile-layout)) :global(.food-list) {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 10px;
    }
    :global(html:not(.force-mobile-layout)) :global(.food-item) {
      min-width: 0;
    }
  }
  /* Phase C — three columns on ultrawide. Detail pane still takes
     380px on the right, leaving a wide center; three cards read
     more naturally than two very-wide ones at 1920+. */
  @media (min-width: 1920px) {
    :global(html:not(.force-mobile-layout)) :global(.food-list) {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
    }
  }

  /* Phase D — manage-mode top-right portaled action bar shifts
     detail pane is now hidden entirely when manageMode is on (the
     pane isn't interactive during selection anyway — tapping a food
     toggles its checkbox, not the preview), so the manage-bar buttons
     get the right edge to themselves at every viewport width. Prior
     override that inset them 452px to clear the pane is no longer
     needed and was making the buttons look adrift in the middle
     of wide screens on the user's report. */
</style>
