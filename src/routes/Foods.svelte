<script>
  import { onMount, tick } from 'svelte';
  import { push, location } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { fade, fly } from 'svelte/transition';

  import Tabs        from '../components/ui/Tabs.svelte';
  import ActionSheet     from '../components/ui/ActionSheet.svelte';
  import BarcodeScanner from '../components/foods/BarcodeScanner.svelte';
  import Dialog      from '../components/ui/Dialog.svelte';
  import Sheet       from '../components/ui/Sheet.svelte';
  import { diaryPromptQuantity } from '../stores/settings.js';
  import { showSuccess, showError } from '../stores/toast.js';
  import { editorState, clearFoodEditorState } from '../stores/editorState.js';
  import { DB, localDateStr } from '../lib/db.js';
  import { loadEntry } from '../stores/diary.js';
  import { API, USDA, NtApi } from '../lib/api.js';
  import { Nutrition } from '../lib/nutrition.js';
  import { Mealie } from '../lib/mealieApi.js';
  import { resolveAssetUrl } from '../lib/platform.js';
  import { foodsShowThumbnails, foodsShowCategories, foodsShowLabels, foodsShowNotes, foodsSort, foodCategories, foodsShowYesterdayMeals, foodsYesterdayCollapsed, foodsSavedCollapsed, mealNames, usdaEnabled, usdaApiKey, catName as _catName, catDisplay as _catDisplay, pageBanners } from '../stores/settings.js';
  import { mealIcon } from '../lib/mealIcon.js';
  import FoodsBanner from '../components/banners/FoodsBanner.svelte';

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
    // Non-foods tabs only support local + shared — reset & notify if source was external
    const _prevSrc = searchSource;
    if (activeTab !== 0 && searchSource !== 'local' && searchSource !== 'shared') searchSource = 'local';
    if (searchSource === 'shared' && !_tabHasShared) searchSource = 'local';
    if (_prevSrc !== searchSource) {
      import('../stores/toast.js').then(({ showInfo }) => showInfo('Source reset to Local — external sources only work for Foods')).catch(() => {});
    }
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
  let searchSource = 'local';
  const _mealieEnabled = DB.getSetting('mealieEnabled',  false);
  $: availableSources = [
    { value: 'local',  label: $_('foods.sources.local')  },
    { value: 'off',    label: 'OFF'                       },
    ...($usdaEnabled   ? [{ value: 'usda',   label: 'USDA' }] : []),
    ...(_mealieEnabled ? [{ value: 'mealie', label: 'Mealie' }] : []),
    ...(_tabHasShared  ? [{ value: 'shared', label: $_('foods.sources.from_others') }] : []),
  ];
  $: _sourceLabel = availableSources.find(s => s.value === searchSource)?.label || '';

  // Sharing — "From Others" source filter (per-category)
  let sharingEnabled = false;
  let sharedCounts = { foods: 0, meals: 0, recipes: 0 };
  $: _tabHasShared = activeTab === 0 ? sharedCounts.foods > 0 : activeTab === 1 ? sharedCounts.meals > 0 : sharedCounts.recipes > 0;
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
  let apiResults = [];
  let mealieResults = [];
  let loading = false;
  let loadError = false;
  let mealieLoading = false;
  let searchTimeout = null;

  let showItemActions = false;
  let selectedItem = null;
  let showDeleteDialog = false;
  let scannerOpen = false;
  let showQtyPrompt = false;
  let promptFood = null;
  let promptServings = 1;
  let promptPortion = 100;
  let promptUnit = 'g';
  let activeCategoryFilter = ''; // '' = all
  let yesterdayMeals = []; // { mealIdx, mealName, items, totalKcal } — only in pick mode
  let yesterdayInfoGroup = null; // group whose detail sheet is currently open
  let _yesterdayImgFailed = new Set(); // items whose thumbnail failed to load — fall back to placeholder

  // Multi-select (pick mode only)
  let selectedFoods = new Set();      // Set<food object reference>
  let showMultiPortionSheet = false;
  let multiPortionItems = [];         // [{ food, portion, unit, servings }]
  let multiAdding = false;

  // Clear selection when tab changes (different list context); search does NOT clear selection
  $: { activeTab; selectedFoods = new Set(); }

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

  async function load() {
    loadError = false;
    try {
      [localFoods, localMeals, localRecipes] = await Promise.all([
        NtApi.getFoods(),
        NtApi.getMeals(),
        NtApi.getRecipes(),
      ]);
      const sort = foodsSort.get();
      if (sort === 'alpha') {
        [localFoods, localMeals, localRecipes].forEach(arr =>
          arr.sort((a,b) => (a.name||'').localeCompare(b.name||'')));
      }
    } catch(e) {
      console.error('[foods] load error:', e);
      loadError = true;
    }
  }

  async function onSearch() {
    clearTimeout(searchTimeout);
    apiResults = [];
    mealieResults = [];
    if (!search.trim() || searchSource === 'local') return;
    const src = searchSource;
    searchTimeout = setTimeout(async () => {
      if (activeTab !== 0) return;
      if (src === 'off') {
        try {
          loading = true;
          apiResults = await API.searchByName(search) || [];
        } catch { apiResults = []; }
        finally { loading = false; }
      } else if (src === 'usda') {
        try {
          loading = true;
          const key = usdaApiKey.get();
          apiResults = await USDA.searchByName(search, 1, key) || [];
        } catch { apiResults = []; }
        finally { loading = false; }
      } else if (src === 'mealie') {
        try {
          mealieLoading = true;
          mealieResults = await Mealie.search(search) || [];
        } catch { mealieResults = []; }
        finally { mealieLoading = false; }
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

  $: { search; searchSource; onSearch(); }

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

  function openMealEditor(item, isRecipe) {
    _saveScrollState();
    editorState.mealPrefill  = item ? { ...item } : null;
    editorState.mealIsRecipe = isRecipe;
    push(item ? '/meal-editor/' + item.id : '/meal-editor');
  }

  async function pickFood(food) {
    if (!pickMode) {
      // Meals/Recipes open the meal editor; Foods open the food editor
      if (activeTab === 1) { openMealEditor(food, false); return; }
      if (activeTab === 2) { openMealEditor(food, true);  return; }
      openEditor(food, 'foodList');
      return;
    }

    // If item is from another user's catalogue, copy it into ours first
    if (searchSource === 'shared' && food._shared_by != null) {
      const mine = await copyAndUse(food);
      if (!mine) return;
      food = mine;
      showSuccess('Saved to your catalogue');
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
    const { addDiaryItem } = await import('../stores/diary.js');
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
    await _addFoodToDiaryNoNav(food, qty);
    import('../stores/toast.js').then(m => m.showSuccess('Added to diary'));
    editorState.lastMealAdded = Number(pickMeal) || 0;
    history.back();
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
      const newPortion  = parseFloat(item.portion) || origPortion;
      const portionFactor = newPortion / origPortion;
      const scaledNutrition = item.food.nutrition
        ? Object.fromEntries(Object.entries(item.food.nutrition).map(([k,v]) => [k, (parseFloat(v)||0) * portionFactor]))
        : item.food.nutrition;
      const food = { ...item.food, portion: newPortion, unit: item.unit, nutrition: scaledNutrition };
      await _addFoodToDiaryNoNav(food, parseFloat(item.servings) || 1);
    }
    showSuccess(`Added ${multiPortionItems.length} item${multiPortionItems.length > 1 ? 's' : ''} to diary`);
    editorState.lastMealAdded = Number(pickMeal) || 0;
    multiAdding = false;
    history.back();
  }

  async function confirmQtyPrompt() {
    if (!promptFood) return;
    const newPortion = parseFloat(promptPortion) || promptFood.portion || 100;
    const origPortion = parseFloat(promptFood.portion) || 100;

    // If portion changed (e.g. user is adding half the recipe), scale nutrition proportionally
    const portionFactor = newPortion / origPortion;
    const scaledNutrition = promptFood.nutrition ?
      Object.fromEntries(Object.entries(promptFood.nutrition).map(([k,v]) => [k, (parseFloat(v)||0) * portionFactor])) :
      promptFood.nutrition;

    const food = {
      ...promptFood,
      portion: newPortion,
      unit: promptUnit || promptFood.unit || 'g',
      nutrition: scaledNutrition
    };
    await _addFoodToDiary(food, parseFloat(promptServings) || 1);
  }

  async function deleteItem(item) {
    if (currentStore === 'foodList') await NtApi.deleteFood(item.id);
    else await NtApi.deleteMeal(item.id);
    await load();
    showSuccess($_('foods.toast.deleted'));
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
        copyAndUse(selectedItem).then(() => { showSuccess('Saved to your catalogue'); load(); });
      } else {
        // External item (OFF/USDA) — create a new local food from it
        NtApi.createFood(selectedItem).then(() => { showSuccess('Saved to My Foods'); load(); })
          .catch(e => showError('Could not save: ' + e.message));
      }
    } else if (detail.value === 'delete') {
      showDeleteDialog = true;
    }
  }

  async function handleScan({ detail }) {
    const code = detail.code;
    if (!code) return;
    try {
      const { API } = await import('../lib/api.js');
      const result = await API.lookupBarcode(code);
      if (result) {
        if (pickMode) {
          await pickFood(result);
        } else {
          openEditor(result, 'foodList');
        }
      } else {
        const { showError: se } = await import('../stores/toast.js');
        se('Barcode not found: ' + code);
      }
    } catch(e) {
      const { showError: se } = await import('../stores/toast.js');
      se('Lookup failed');
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

  async function addYesterdayMeal(group) {
    const targetMeal = Number(pickMeal) || 0;
    const { addDiaryItem } = await import('../stores/diary.js');
    for (const item of group.items) {
      await addDiaryItem({ ...item }, targetMeal, pickDate);
    }
    import('../stores/toast.js').then(m => m.showSuccess('Added ' + group.mealName));
    editorState.lastMealAdded = targetMeal;
    history.back();
  }

  onMount(async () => {
    // Restore tab before load so the right list is fetched
    if (editorState.foodsActiveTab != null) {
      activeTab = editorState.foodsActiveTab;
      editorState.foodsActiveTab = null;
    }
    // Load local data FIRST — don't block on server calls
    await load();
    await loadYesterdayMeals();
    // Sharing status from server — non-blocking, updates UI when ready
    NtApi.getSharingStatus().then(s => {
      sharingEnabled = s.sharing_enabled === true;
      sharedCounts = { foods: s.foods || 0, meals: s.meals || 0, recipes: s.recipes || 0 };
    }).catch(() => {});
    // Restore scroll position after Svelte has flushed the list to the DOM
    if (editorState.foodsScrollY != null) {
      const sy = editorState.foodsScrollY;
      editorState.foodsScrollY = null;
      await tick();
      window.scrollTo(0, sy);
    }
  });
</script>

<div class="page-shell">
  <!-- Header -->
  <header class="page-header" class:has-banner={$pageBanners}>
    {#if $pageBanners}<FoodsBanner />{/if}
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
        bind:value={search}
      />
      <button class="scan-btn-inline" on:click={() => scannerOpen = true} aria-label={$_('foods.scan_barcode')} title={$_('foods.scan_barcode')}>
        <span class="material-symbols-rounded">barcode_scanner</span>
      </button>
    </div>
  </div>

  <!-- Source chips (Foods tab only) -->
  {#if activeTab === 0}
    <div class="source-chip-row">
      {#each availableSources as src}
        <button class="source-chip" class:active={searchSource === src.value}
          on:click={() => { searchSource = src.value; }}>
          {src.label}
        </button>
      {/each}
    </div>
  {/if}
  </div>

  <!-- Category filter chips (Local + Foods tab only) -->
  {#if activeTab === 0 && searchSource === 'local' && $foodsShowCategories && $foodCategories && $foodCategories.length > 0}
    <div class="cat-filter-row">
      <button class="cat-chip" class:active={!activeCategoryFilter}
        on:click={() => activeCategoryFilter = ''}>All</button>
      {#each $foodCategories as cat}
        <button class="cat-chip" class:active={activeCategoryFilter === _catName(cat)}
          on:click={() => activeCategoryFilter = activeCategoryFilter === _catName(cat) ? '' : _catName(cat)}>{$foodsShowLabels ? _catDisplay(cat) : _catName(cat)}</button>
      {/each}
    </div>
  {/if}

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
        {#if gi > 0}<div style="height:1px;background:var(--border);margin:0 16px"></div>{/if}
        <div style="display:flex;align-items:center;padding-right:8px">
          <button class="food-item-btn" style="padding:12px 14px;flex:1" on:click={() => addYesterdayMeal(group)}>
            <div class="ing-thumb-placeholder" style="width:52px;height:52px;border-radius:var(--radius-sm);background:var(--accent-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <span class="material-symbols-rounded" style="color:var(--accent);font-size:20px">{mealIcon(group.mealName)}</span>
            </div>
            <div class="food-info">
              <span class="food-name">{group.mealName}</span>
              <span class="food-kcal text-sm">{group.items.length} items · {group.totalKcal} kcal</span>
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
        <span class="meal-section-label">Saved Meals</span>
        <span class="material-symbols-rounded meal-section-chevron"
          class:meal-section-chevron-collapsed={$foodsSavedCollapsed}>expand_more</span>
      </button>
    {/if}
  {/if}

  {#if loadError}
    <div class="server-error-banner">
      <span class="material-symbols-rounded">cloud_off</span>
      <span>Could not reach server — <button class="server-error-retry" on:click={load}>retry</button></span>
    </div>
  {/if}

  <div class="page-content">
    {#if searchSource === 'local' || searchSource === 'shared' || activeTab !== 0}
      <!-- ── Local list ─────────────────────────────────────────────────────── -->
      {#if filteredList.length === 0 && !search && !loadError}
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
            <p class="empty-state-hint">Try searching Open Food Facts or USDA above</p>
          {/if}
        </div>
      {:else if !_hideSavedMealsList}
        <ul class="food-list">
          {#each filteredList as food (food.id)}
            {@const _sel = selectedFoods.has(food)}
            <li class="food-item card" class:food-selected={_sel} in:fade={{ duration: 160 }}>
              {#if pickMode}
                <button class="food-select-btn" on:click={() => toggleSelect(food)} aria-label="Select">
                  <span class="food-check material-symbols-rounded" class:food-check-on={_sel}>
                    {_sel ? 'check_circle' : 'radio_button_unchecked'}
                  </span>
                </button>
              {/if}
              <button class="food-item-btn"
                on:click={() => pickFood(food)}
                on:contextmenu|preventDefault={() => longPress(food)}>
                {#if $foodsShowThumbnails && food.imgUrl}
                  <img class="food-thumb" src={food.imgUrl} alt="" loading="lazy" referrerpolicy="no-referrer" on:error={e => e.target.style.display='none'} />
                {:else}
                  <div class="food-thumb-placeholder">
                    <span class="material-symbols-rounded">{_tabIcon}</span>
                  </div>
                {/if}
                <div class="food-info">
                  <span class="food-name">{food.name}</span>
                  {#if activeTab === 0}
                    {#if food.brand}<span class="food-brand text-3 text-sm">{food.brand}</span>{/if}
                    <span class="food-kcal text-sm">{food.portion || 100}{food.unit || 'g'}{#if food._shared_by} · <span style="color:var(--accent)">by {food._shared_by}</span>{/if}</span>
                  {:else}
                    {@const _kcal = Math.round(Nutrition.sum((food.items||[]).map(i => Nutrition.calculate(i))).calories || food.nutrition?.calories || 0)}
                    <span class="food-brand text-3 text-sm">{mealServing(food.items)}{#if food._shared_by} · <span style="color:var(--accent)">by {food._shared_by}</span>{/if}</span>
                    <span class="food-kcal text-sm">{_kcal.toLocaleString()} kcal</span>
                  {/if}
                </div>
                <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
              </button>
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
        <!-- OFF / USDA results -->
        {#if apiResults.length > 0}
          <ul class="food-list">
            {#each apiResults as food (food.id || food.barcode)}
              {@const _sel = selectedFoods.has(food)}
              <li class="food-item card" class:food-selected={_sel}>
                {#if pickMode}
                  <button class="food-select-btn" on:click={() => toggleSelect(food)} aria-label="Select">
                    <span class="food-check material-symbols-rounded" class:food-check-on={_sel}>
                      {_sel ? 'check_circle' : 'radio_button_unchecked'}
                    </span>
                  </button>
                {/if}
                <button class="food-item-btn"
                  on:click={() => pickFood(food)}
                  on:contextmenu|preventDefault={() => longPress(food)}>
                  {#if food.imgUrl}
                    <img class="food-thumb" src={food.imgUrl} alt="" loading="lazy" referrerpolicy="no-referrer" on:error={e => e.target.style.display='none'} />
                  {:else}
                    <div class="food-thumb-placeholder">
                      <span class="material-symbols-rounded">{searchSource === 'usda' ? 'science' : 'public'}</span>
                    </div>
                  {/if}
                  <div class="food-info">
                    <span class="food-name">{food.name}</span>
                    {#if food.brand}<span class="food-brand text-3 text-sm">{food.brand}</span>{/if}
                    <span class="food-kcal text-sm">{Math.round(food.nutrition?.calories || food.calories || 0).toLocaleString()} kcal</span>
                  </div>
                </button>
              </li>
            {/each}
          </ul>
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
  </div>
</div>

<!-- Multi-item portion sheet -->
<Sheet bind:open={showMultiPortionSheet} title="Set Portions ({multiPortionItems.length} items)">
  <div style="display:flex;flex-direction:column;gap:0;padding-top:4px">
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
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">Serving Size</label>
            <input class="input" type="number" min="0.1" step="0.1" bind:value={item.portion} style="font-size:16px;width:100%" />
          </div>
          <div style="width:80px">
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">Unit</label>
            <select class="select" bind:value={item.unit} style="width:100%">
              {#each ['g','ml','oz','lb','cup','tbsp','tsp','piece','slice','serving'] as u}
                <option value={u}>{u}</option>
              {/each}
            </select>
          </div>
          <div style="width:72px">
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">Servings</label>
            <input class="input" type="number" min="0.1" step="0.1" bind:value={item.servings} style="font-size:16px;width:100%" />
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

<!-- Quantity prompt sheet -->
<Sheet bind:open={showQtyPrompt} title={promptFood ? promptFood.name : 'Add to Diary'}>
  <div style="display:flex;flex-direction:column;gap:16px;padding-top:8px">
    {#if promptFood && (promptFood.notes || '').trim()}
      <div class="qty-notes">
        <span class="material-symbols-rounded qty-notes-icon">sticky_note_2</span>
        <span class="qty-notes-text">{promptFood.notes}</span>
      </div>
    {/if}
    <div style="display:flex;gap:12px">
      <div style="flex:1">
        <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">Serving Size</label>
        <input class="input" type="number" min="0.1" step="0.1" bind:value={promptPortion}
          style="font-size:16px;width:100%" />
      </div>
      <div style="width:80px">
        <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">Unit</label>
        <select class="select" bind:value={promptUnit} style="width:100%">
          {#each ['g','ml','oz','lb','cup','tbsp','tsp','piece','slice','serving'] as u}
            <option value={u}>{u}</option>
          {/each}
        </select>
      </div>
    </div>
    <div>
      <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">Number of Servings</label>
      <input class="input" type="number" min="0.1" step="0.1" bind:value={promptServings}
        style="font-size:16px;width:100%" />
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-2);border-radius:var(--radius-md)">
      <span style="font-size:13px;color:var(--text-3)">Total Amount</span>
      <span style="font-size:14px;font-weight:500">{Math.round((parseFloat(promptPortion) || 100) * (parseFloat(promptServings) || 1) * 10) / 10}{promptUnit || 'g'}</span>
    </div>
    <button class="btn btn-primary w-full" on:click={confirmQtyPrompt}>Add to Diary</button>
  </div>
</Sheet>

<!-- Yesterday's meal info sheet — list of items in that meal group -->
<Sheet open={yesterdayInfoGroup != null}
  title={yesterdayInfoGroup ? `${yesterdayInfoGroup.mealName} — yesterday` : ''}
  on:close={() => yesterdayInfoGroup = null}>
  {#if yesterdayInfoGroup}
    <div style="padding:0 4px 8px">
      {#each yesterdayInfoGroup.items as it}
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border)">
          {#if it.imgUrl && !_yesterdayImgFailed.has(it)}
            <img src={resolveAssetUrl(it.imgUrl)} alt="" loading="lazy" referrerpolicy="no-referrer"
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
              {it.quantity ? `${it.quantity} × ` : ''}{it.portion || 100}{it.unit || 'g'}
            </span>
          </div>
          <span class="text-2 text-sm" style="font-variant-numeric:tabular-nums;margin-left:8px;flex-shrink:0">
            {Math.round((it.nutrition?.calories || it.calories || 0) * (it.quantity || 1))} kcal
          </span>
        </div>
      {/each}
      <div style="display:flex;justify-content:space-between;padding:12px;font-weight:600">
        <span>Total</span>
        <span>{yesterdayInfoGroup.totalKcal} kcal</span>
      </div>
      <button class="btn btn-primary w-full" style="margin-top:8px"
        on:click={() => { const g = yesterdayInfoGroup; yesterdayInfoGroup = null; addYesterdayMeal(g); }}>
        Add this meal
      </button>
    </div>
  {/if}
</Sheet>

<BarcodeScanner bind:open={scannerOpen} on:scan={handleScan} on:close={() => scannerOpen = false} />

<ActionSheet
  bind:open={showItemActions}
  title={selectedItem ? selectedItem.name : ''}
  actions={selectedItem?._shared_by != null ? [
    { label: 'Save to My Catalogue', icon: 'bookmark_add', value: 'copy' },
  ] : !selectedItem?.id ? [
    { label: 'Save to My Foods', icon: 'bookmark_add', value: 'copy' },
  ] : [
    { label: 'Edit',   icon: 'edit',        value: 'edit' },
    ...(activeTab !== 0 ? [{ label: 'Clone', icon: 'content_copy', value: 'clone' }] : []),
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

<style>
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
    /* page-top + 10 + 48 (--hamburger-row) + 40 (h1) + 12 (padding-bottom) = +110 */
    top: calc(var(--page-top, var(--safe-top)) + 110px);
    z-index: 20;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
  }
  /* With banner: padding-bottom is 72, so total = 10+48+40+72 = +170 */
  :global(.page-header.has-banner) ~ .foods-sticky-bar {
    top: calc(var(--page-top, var(--safe-top)) + 170px);
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
  .scan-btn-inline {
    position: absolute;
    right: 6px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-3);
    padding: 4px;
    display: flex;
    align-items: center;
  }
  .scan-btn-inline .material-symbols-rounded { font-size: 20px; }

  .food-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .food-item { overflow: hidden; }
  .food-item-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
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
  .food-brand { }
  .food-kcal  { color: var(--text-2); }

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
  }
  .source-chip:hover { background: var(--surface-2); }
  .source-chip.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--surface-1);
    font-weight: 600;
  }
</style>
