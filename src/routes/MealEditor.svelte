<script>
  import { onMount } from 'svelte';
  import { pop } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { NtApi } from '../lib/api.js';
  import { takePhoto } from '../lib/camera.js';
  import { isNative, resolveAssetUrl } from '../lib/platform.js';
  import { portal } from '../lib/portal.js';
  import Sheet from '../components/ui/Sheet.svelte';
  import { showSuccess, showError } from '../stores/toast.js';
  import { editorState, clearMealEditorState } from '../stores/editorState.js';
  import { Nutrition, NUTRIMENTS } from '../lib/nutrition.js';
  import { foodsShowCategories, foodsShowLabels, foodsShowNotes, foodCategories, cropPhotos, catName as _catName, catDisplay as _catDisplay, energyUnit, foodsSort, mealsSort, recipesSort } from '../stores/settings.js';
  import { fitImageDataUrl } from '../lib/image-fit.js';

  export let params = {};

  let meal   = { name: '', notes: '', categories: [], items: [], imgUrl: '' };
  let store  = 'meals';
  let saving = false;
  let isRecipe = false;

  // Photo state
  let photoPreviewUrl = '';
  let cameraOpen = false;
  let showUrlInput = false;
  let photoUrl = '';
  function applyPhotoUrl() {
    const url = photoUrl.trim();
    if (url) { photoPreviewUrl = url; }
    showUrlInput = false;
    photoUrl = '';
  }
  let cameraStream = null;
  let videoEl = null;
  let cropOpen = false;
  let cropSrc = '';
  let cropImgEl = null;
  let cropBoxX = 0, cropBoxY = 0, cropBoxSize = 200;
  let cropDragging = false, cropDragStartX = 0, cropDragStartY = 0, cropBoxStartX = 0, cropBoxStartY = 0;

  // Recipe fields. recipeAmount is the TOTAL weight of the finished dish
  // (auto-filled from ingredients; user can override for boil-off). recipeYields
  // is the number of servings the recipe makes. On save we divide total
  // weight + total nutrition by yields and store the per-serving values.
  let recipeAmount = '';
  let recipeUnit = 'g';
  let recipeYields = 1;
  const UNITS = ['g','ml','oz','cup','tbsp','tsp','piece','serving'];

  // Ingredient picker
  let showPicker = false;
  let pickerTab = 0; // 0=Foods, 1=Meals, 2=Recipes
  let pickerSearch = '';
  let pickerFoods = [];
  let pickerMeals = [];
  let pickerRecipes = [];
  let pickerLoading = false;
  const PICKER_TABS = ['Foods', 'Meals', 'Recipes'];

  // Portion picker
  let portionFood = null;
  let portionAmount = '';
  let portionQty = 1;
  let portionUnit = 'g';
  let portionSheet = false;
  let editingIndex = null; // null = adding new, number = editing existing

  // Multi-select
  let selectedIngredients = new Set();
  let showMultiPortionSheet = false;
  let multiPortionItems = [];


  onMount(async () => {
    isRecipe = editorState.mealIsRecipe || false;
    store    = isRecipe ? 'recipes' : 'meals';
    if (editorState.mealPrefill) {
      meal = { ...meal, ...editorState.mealPrefill };
    } else if (params && params.id) {
      const existing = await NtApi.getMeal(params.id).catch(() => null);
      if (existing) meal = { ...meal, ...existing };
    }
    if (meal.imgUrl) photoPreviewUrl = meal.imgUrl;
    if (isRecipe) {
      // Three cases to display the yields field:
      //   - Brand new recipe: default to 1 (visible).
      //   - Existing recipe saved with this feature: show the saved number.
      //   - Existing recipe migrated from before this feature: servings is
      //     NULL/undefined; show a blank field. Math still treats blank as 1.
      const isExistingRecipe = !!params?.id || !!editorState.mealPrefill?.id;
      const hasExplicitServings = meal.servings != null;
      const effectiveServings = hasExplicitServings
        ? Math.max(1, parseInt(meal.servings) || 1)
        : 1;
      recipeYields = isExistingRecipe && !hasExplicitServings ? '' : effectiveServings;
      if (meal.portion) recipeAmount = (parseFloat(meal.portion) || 0) * effectiveServings;
      if (meal.unit) recipeUnit = meal.unit;
    }

  });

  // ── Photo ──────────────────────────────────────────────────────────────────
  // The crop step is opt-in via Settings → Foods → "Crop photos on upload"
  // (cropPhotos store, default OFF). When off, the picked image is used
  // as-is and the meal card fits it to the available space via object-fit.
  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      if ($cropPhotos) { cropSrc = ev.target.result; cropOpen = true; initCropBox(); }
      else { photoPreviewUrl = await fitImageDataUrl(ev.target.result); }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function openCamera() {
    if (isNative) {
      try {
        const file = await takePhoto();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async ev => {
          if ($cropPhotos) { cropSrc = ev.target.result; cropOpen = true; initCropBox(); }
          else { photoPreviewUrl = await fitImageDataUrl(ev.target.result); }
        };
        reader.readAsDataURL(file);
      } catch { /* user cancelled */ }
      return;
    }
    cameraOpen = true;
    await new Promise(r => setTimeout(r, 100));
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      if (videoEl) { videoEl.srcObject = cameraStream; videoEl.play(); }
    } catch { cameraOpen = false; showError('Camera not available'); }
  }

  async function capturePhoto() {
    if (!videoEl) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth; canvas.height = videoEl.videoHeight;
    canvas.getContext('2d').drawImage(videoEl, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    closeCamera();
    if ($cropPhotos) { cropSrc = dataUrl; cropOpen = true; initCropBox(); }
    else { photoPreviewUrl = await fitImageDataUrl(dataUrl); }
  }

  function closeCamera() {
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    cameraOpen = false;
  }

  function initCropBox() {
    cropBoxX = 20; cropBoxY = 20; cropBoxSize = 200;
  }

  function confirmCrop() {
    if (!cropImgEl) return;
    const canvas = document.createElement('canvas');
    const scaleX = cropImgEl.naturalWidth / cropImgEl.offsetWidth;
    const scaleY = cropImgEl.naturalHeight / cropImgEl.offsetHeight;
    canvas.width = 300; canvas.height = 300;
    canvas.getContext('2d').drawImage(
      cropImgEl,
      cropBoxX * scaleX, cropBoxY * scaleY,
      cropBoxSize * scaleX, cropBoxSize * scaleY,
      0, 0, 300, 300
    );
    photoPreviewUrl = canvas.toDataURL('image/jpeg', 0.85);
    cropOpen = false; cropSrc = '';
  }

  function onCropMouseDown(e) {
    cropDragging = true;
    cropDragStartX = e.clientX; cropDragStartY = e.clientY;
    cropBoxStartX = cropBoxX; cropBoxStartY = cropBoxY;
    e.preventDefault();
  }
  function onCropMouseMove(e) {
    if (!cropDragging || !cropImgEl) return;
    const maxX = cropImgEl.offsetWidth - cropBoxSize;
    const maxY = cropImgEl.offsetHeight - cropBoxSize;
    cropBoxX = Math.max(0, Math.min(maxX, cropBoxStartX + (e.clientX - cropDragStartX)));
    cropBoxY = Math.max(0, Math.min(maxY, cropBoxStartY + (e.clientY - cropDragStartY)));
  }
  function onCropMouseUp() { cropDragging = false; }

  // ── Ingredient picker ──────────────────────────────────────────────────────
  async function openPicker() {
    showPicker = true;
    pickerTab = 0;
    pickerSearch = '';
    pickerLoading = true;
    try {
      [pickerFoods, pickerMeals, pickerRecipes] = await Promise.all([
        NtApi.getFoods(),
        NtApi.getMeals(),
        NtApi.getRecipes(),
      ]);
    } finally {
      pickerLoading = false;
    }
  }

  $: _pickerList = pickerTab === 0 ? pickerFoods : pickerTab === 1 ? pickerMeals : pickerRecipes;
  // Pull the per-tab sort mode from the same settings the Foods page reads,
  // so the recipe ingredient picker honors whatever sort the user picked
  // for browsing their library (default alpha).
  $: _pickerSortMode = pickerTab === 0 ? $foodsSort : pickerTab === 1 ? $mealsSort : $recipesSort;
  function _applyPickerSort(arr, mode) {
    const sorted = [...arr];
    if (mode === 'recent') {
      sorted.sort((a, b) => {
        const al = a.last_used_at || '';
        const bl = b.last_used_at || '';
        if (al && bl) return bl.localeCompare(al);
        if (al) return -1;
        if (bl) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
    } else if (mode === 'most') {
      sorted.sort((a, b) => {
        const d = (b.usage_count || 0) - (a.usage_count || 0);
        if (d !== 0) return d;
        return (a.name || '').localeCompare(b.name || '');
      });
    } else {
      sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
    // Favorites always pin to the top, regardless of sort mode (matches
    // Foods page behavior).
    return [...sorted.filter(f => f.favorite), ...sorted.filter(f => !f.favorite)];
  }
  $: _pickerListSorted = _applyPickerSort(_pickerList, _pickerSortMode);
  $: pickerFiltered = pickerSearch
    ? _pickerListSorted.filter(f =>
        (f.name||'').toLowerCase().includes(pickerSearch.toLowerCase()) ||
        (f.brand||'').toLowerCase().includes(pickerSearch.toLowerCase()))
    : _pickerListSorted;

  $: { pickerTab; selectedIngredients = new Set(); }

  // Track ingredient images that fail to load so we fall back to the placeholder
  let failedImgs = new Set();
  function onImgError(url) { failedImgs.add(url); failedImgs = failedImgs; }

  function toggleIngredient(food) {
    if (selectedIngredients.has(food)) selectedIngredients.delete(food);
    else selectedIngredients.add(food);
    selectedIngredients = selectedIngredients;
  }

  function confirmMultiIngredientAdd() {
    if (selectedIngredients.size === 0) return;
    multiPortionItems = [...selectedIngredients].map(food => ({
      food,
      portion: food.portion || 100,
      unit: food.unit || 'g',
      qty: food.quantity || 1,
    }));
    showMultiPortionSheet = true;
  }

  function confirmMultiPortion() {
    for (const item of multiPortionItems) {
      const origPortion = parseFloat(item.food.portion) || 100;
      const newPortion = parseFloat(item.portion) || origPortion;
      const newQty = parseFloat(item.qty) || 1;
      let scaledNutrition = item.food.nutrition;
      if (item.food.nutrition) {
        const factor = (newPortion / origPortion) * newQty;
        scaledNutrition = Object.fromEntries(
          Object.entries(item.food.nutrition).map(([k, v]) => [k, (parseFloat(v)||0) * factor])
        );
      }
      meal = { ...meal, items: [...meal.items, { ...item.food, portion: newPortion * newQty, unit: item.unit, quantity: 1, nutrition: scaledNutrition }] };
    }
    if (isRecipe) autoUpdateRecipeAmount();
    showMultiPortionSheet = false;
    showPicker = false;
    pickerSearch = '';
    selectedIngredients = new Set();
    multiPortionItems = [];
  }

  let _meLock = false;
  let _meLockTimer;
  function pickIngredient(food) {
    portionFood   = food;
    portionAmount = food.portion || 100;
    portionUnit   = food.unit || 'g';
    portionQty    = food.quantity || 1;
    clearTimeout(_meLockTimer);
    _meLock = true;
    portionSheet = true;
    _meLockTimer = setTimeout(() => _meLock = false, 400);
  }

  function openEditIngredient(i) {
    const item = meal.items[i];
    editingIndex = i;
    portionFood = item;
    portionAmount = item.portion || 100;
    portionUnit = item.unit || 'g';
    portionQty = item.quantity || 1;
    clearTimeout(_meLockTimer);
    _meLock = true;
    portionSheet = true;
    _meLockTimer = setTimeout(() => _meLock = false, 400);
  }

  function confirmPortion() {
    if (!portionFood) return;
    const newPortion = parseFloat(portionAmount) || 100;
    const newQty     = parseFloat(portionQty) || 1;
    const newTotal   = newPortion * newQty;

    if (editingIndex !== null) {
      // Editing existing item — rescale nutrition proportionally from current total
      const item = meal.items[editingIndex];
      const oldTotal = (parseFloat(item.portion) || 100) * (parseFloat(item.quantity) || 1);
      let newNutrition = item.nutrition;
      if (item.nutrition && oldTotal > 0) {
        const factor = newTotal / oldTotal;
        newNutrition = Object.fromEntries(
          Object.entries(item.nutrition).map(([k, v]) => [k, (parseFloat(v)||0) * factor])
        );
      }
      const items = [...meal.items];
      items[editingIndex] = { ...item, portion: newTotal, unit: portionUnit, quantity: 1, nutrition: newNutrition };
      meal = { ...meal, items };
      editingIndex = null;
    } else {
      // Adding new item
      const origPortion = parseFloat(portionFood.portion) || 100;
      let scaledNutrition = portionFood.nutrition;
      if (portionFood.nutrition) {
        const factor = (newPortion / origPortion) * newQty;
        scaledNutrition = Object.fromEntries(
          Object.entries(portionFood.nutrition).map(([k, v]) => [k, (parseFloat(v)||0) * factor])
        );
      }
      const item = { ...portionFood, portion: newTotal, unit: portionUnit, quantity: 1, nutrition: scaledNutrition };
      meal = { ...meal, items: [...meal.items, item] };
    }

    portionSheet = false;
    portionFood = null;
    showPicker = false;
    pickerSearch = '';
    if (isRecipe) autoUpdateRecipeAmount();
  }

  function moveIngredient(i, dir) {
    const items = [...meal.items];
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    meal = { ...meal, items };
  }

  // Drag-to-reorder state
  let dragFrom = null;
  let dragOver = null;

  function onDragHandleDown(e, i) {
    dragFrom = i;
    dragOver = i;
    e.currentTarget.closest('.ingredient-list').setPointerCapture(e.pointerId);
  }

  function onDragPointerMove(e, i) {
    if (dragFrom === null) return;
    // Find which row the pointer is over by hit-testing sibling rows
    const list = e.currentTarget.closest('.ingredient-list');
    if (!list) return;
    const rows = [...list.querySelectorAll('.ingredient-row')];
    const y = e.clientY;
    let target = dragFrom;
    for (let idx = 0; idx < rows.length; idx++) {
      const rect = rows[idx].getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) { target = idx; break; }
    }
    dragOver = target;
  }

  function onDragPointerUp(e) {
    if (dragFrom !== null && dragOver !== null && dragFrom !== dragOver) {
      const items = [...meal.items];
      const [removed] = items.splice(dragFrom, 1);
      items.splice(dragOver, 0, removed);
      meal = { ...meal, items };
    }
    dragFrom = null;
    dragOver = null;
  }

  function removeIngredient(i) {
    meal = { ...meal, items: meal.items.filter((_,idx) => idx !== i) };
    if (isRecipe) autoUpdateRecipeAmount();
  }

  function autoUpdateRecipeAmount() {
    const grams = meal.items.reduce((s, it) => s + toGrams(it.portion, it.unit) * (it.quantity||1), 0);
    recipeAmount = grams > 0 ? String(Math.round(grams)) : '';
    recipeUnit = 'g';
  }

  function toGrams(amount, unit) {
    const c = { g:1, ml:1, oz:28.35, cup:240, tbsp:15, tsp:5, piece:100, serving:100 };
    return (parseFloat(amount)||0) * (c[unit]||1);
  }

  let showAllNutrients = false;
  $: totals = Nutrition.sum((meal.items||[]).map(i => Nutrition.calculate(i)));

  // ── Category chips ─────────────────────────────────────────────────────────
  function toggleCat(cat) {
    const name = _catName(cat);
    const cats = meal.categories || [];
    if (cats.includes(name)) {
      meal = { ...meal, categories: cats.filter(c => c !== name) };
    } else {
      meal = { ...meal, categories: [...cats, name] };
    }
  }

  // Read-only when this meal/recipe is owned by another user (shared with us).
  // Server returns 403 on PUT regardless; locking the UI gives the user one
  // clear action — Save a Copy — instead of letting them edit and fail.
  $: _readOnly = !!meal._shared_by;

  async function saveAsCopy() {
    saving = true;
    try {
      await NtApi.copyMeal(meal.id);
      showSuccess('Saved a copy to your catalog');
      pop();
    } catch (e) { showError('Could not save copy: ' + e.message); }
    saving = false;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function save() {
    if (!meal.name.trim()) { showError($_('food_editor.errors.name_required')); return; }
    if (!meal.items.length) { showError($_('meal_editor.errors.no_ingredients')); return; }
    saving = true;
    try {
      const item = {
        ...meal,
        imgUrl: photoPreviewUrl || '',
        nutrition: totals,
        is_recipe: isRecipe,
      };
      if (isRecipe) {
        const totalGrams = parseFloat(recipeAmount) || Math.round(meal.items.reduce((s,it)=>s+toGrams(it.portion,it.unit),0)) || 100;
        const explicit = recipeYields !== '' && recipeYields != null && !Number.isNaN(parseInt(recipeYields));
        const yields = explicit ? Math.max(1, parseInt(recipeYields) || 1) : 1;
        // Store per-serving values. Adding "1" of this recipe to the diary
        // then naturally means "one serving". When yields=1 (or unset, where
        // math treats it as 1), totalGrams/1 = totalGrams — identical to the
        // pre-yields behavior. Explicit null preserves the "unset" state for
        // legacy recipes so the editor keeps showing a blank field rather
        // than auto-filling 1 on every reopen-save cycle.
        item.portion = totalGrams / yields;
        item.unit = recipeUnit;
        item.servings = explicit ? yields : null;
        item.nutrition = Object.fromEntries(
          Object.entries(totals).map(([k, v]) => [k, (parseFloat(v) || 0) / yields])
        );
      }
      if (meal.id) await NtApi.updateMeal(meal.id, item);
      else await NtApi.createMeal(item);
      clearMealEditorState();
      showSuccess($_('food_editor.saved'));
      pop();
    } catch(e) {
      showError($_('common.errors.failed'));
    } finally {
      saving = false;
    }
  }
</script>

<div class="page-shell editor-page">
  <header class="editor-header">
    <button class="btn-icon" on:click={pop} aria-label={$_('common.back')} title={$_('common.back')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2 class="editor-title">{_readOnly ? `Shared by ${meal._shared_by}` : `${meal.id ? 'Edit' : 'New'} ${isRecipe ? 'Recipe' : 'Meal'}`}</h2>
    {#if meal.id && !_readOnly}
      <button class="btn-icon fav-btn" class:on={!!meal.favorite}
        on:click={() => { meal.favorite = meal.favorite ? 0 : 1; meal = meal; }}
        aria-label={meal.favorite ? 'Unfavorite' : 'Favorite'}
        title={meal.favorite ? 'Unfavorite' : 'Add to favorites'}>
        <span class="material-symbols-rounded">{meal.favorite ? 'favorite' : 'favorite_border'}</span>
      </button>
    {/if}
    {#if _readOnly}
      <button class="btn btn-primary" style="height:36px;padding:0 14px;font-size:13px;white-space:nowrap"
        on:click={saveAsCopy} disabled={saving}>
        {saving ? 'Copying…' : 'Save to My Catalog'}
      </button>
    {:else}
      <button class="btn btn-primary" style="height:36px;padding:0 16px;font-size:13px"
        on:click={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    {/if}
  </header>

  {#if _readOnly}
    <div class="readonly-banner">
      <span class="material-symbols-rounded">lock</span>
      <div>
        <div class="readonly-title">Shared by {meal._shared_by} — read only</div>
        <div class="readonly-sub">Tap <strong>Save to My Catalog</strong> to bring this {isRecipe ? 'recipe' : 'meal'} into your catalog and edit it.</div>
      </div>
    </div>
  {/if}

  <div class="page-content editor-content" class:readonly-content={_readOnly} inert={_readOnly || null}>

    <!-- Photo -->
    <div class="card editor-card">
      <div class="editor-card-title">Photo</div>
      <div class="photo-preview-wrap">
        {#if photoPreviewUrl}
          <img src={photoPreviewUrl} alt="food" class="photo-preview-img" />
        {:else}
          <div class="photo-placeholder">
            <span class="material-symbols-rounded" style="font-size:40px;opacity:0.2">photo_camera</span>
          </div>
        {/if}
      </div>
      <div class="photo-actions">
        <button class="btn btn-ghost photo-btn" on:click={openCamera}>
          <span class="material-symbols-rounded" style="font-size:18px">camera_alt</span>
          Camera
        </button>
        <label class="btn btn-ghost photo-btn" style="cursor:pointer">
          <span class="material-symbols-rounded" style="font-size:18px">photo_library</span>
          Upload
          <input type="file" accept="image/*" style="display:none" on:change={handleFileChange} />
        </label>
        <button class="btn btn-ghost photo-btn" on:click={() => { showUrlInput = !showUrlInput; photoUrl = ''; }}>
          <span class="material-symbols-rounded" style="font-size:18px">link</span>
          URL
        </button>
        {#if photoPreviewUrl}
          <button class="btn btn-ghost photo-btn" style="color:var(--text-3)"
            on:click={() => photoPreviewUrl = ''}>
            <span class="material-symbols-rounded" style="font-size:18px">delete</span>
          </button>
        {/if}
      </div>
      {#if showUrlInput}
        <div class="photo-url-row">
          <input class="input photo-url-input" placeholder="https://..." bind:value={photoUrl}
            on:keydown={e => e.key === 'Enter' && applyPhotoUrl()} />
          <button class="btn btn-primary" on:click={applyPhotoUrl}>Get</button>
        </div>
      {/if}
    </div>

    <!-- Name -->
    <div class="card editor-card">
      <div class="editor-card-title">Name *</div>
      <input class="input" placeholder={isRecipe ? $_('meal_editor.recipe_name_placeholder') : $_('meal_editor.meal_name_placeholder')} bind:value={meal.name} />
    </div>

    <!-- Recipe servings: total weight + yields -->
    {#if isRecipe}
      <div class="card editor-card">
        <div class="editor-card-title">{$_('meal_editor.servings.title')}</div>
        <div style="display:flex;gap:10px;align-items:center">
          <input class="input" type="number" min="0.1" step="any"
            placeholder={$_('meal_editor.servings.amount_placeholder')} bind:value={recipeAmount} style="flex:1" />
          <select class="input" bind:value={recipeUnit} style="width:100px">
            {#each UNITS as u}<option value={u}>{u}</option>{/each}
          </select>
        </div>
        <p class="text-3" style="font-size:12px;margin:0">{$_('meal_editor.servings.total_weight_hint')}</p>
        <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
          <input class="input" type="number" min="1" step="1"
            bind:value={recipeYields} style="flex:1" />
          <span class="text-3" style="font-size:13px;width:100px;text-align:center">{$_('meal_editor.servings.yields_unit')}</span>
        </div>
        <p class="text-3" style="font-size:12px;margin:0">{$_('meal_editor.servings.yields_hint')}</p>
        {#if parseFloat(recipeAmount) > 0 && (parseInt(recipeYields) || 0) >= 1}
          {@const _y = Math.max(1, parseInt(recipeYields) || 1)}
          {@const _g = Math.round((parseFloat(recipeAmount) / _y) * 10) / 10}
          {@const _k = Math.round(((totals?.calories || 0) / _y) * 10) / 10}
          <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:8px">
            <p style="margin:0;font-size:13px"><span class="text-3">{$_('meal_editor.servings.per_serving_label')}</span> <strong>{_g}{recipeUnit} · {_k} kcal</strong></p>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Categories -->
    {#if $foodsShowCategories && $foodCategories && $foodCategories.length > 0}
      <div class="card editor-card">
        <div class="editor-card-title">Categories</div>
        <div class="cat-chips">
          {#each $foodCategories as cat}
            <button class="chip" class:accent={(meal.categories||[]).includes(_catName(cat))}
              on:click={() => toggleCat(cat)}>
              {#if (meal.categories||[]).includes(_catName(cat))}
                <span class="material-symbols-rounded" style="font-size:14px">check</span>
              {/if}
              {$foodsShowLabels ? _catDisplay(cat) : _catName(cat)}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Notes -->
    {#if $foodsShowNotes}
      <div class="card editor-card">
        <div class="editor-card-title">Notes</div>
        <textarea class="input" rows="2" placeholder="Optional notes…" bind:value={meal.notes}
          style="resize:vertical;min-height:60px"></textarea>
      </div>
    {/if}

    <!-- Ingredients -->
    <div class="card editor-card">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="editor-card-title">
          {isRecipe ? 'Foods' : 'Foods & Recipes'}
          {#if meal.items.length > 0}
            {@const _hdrEnergy = Nutrition.displayEnergy(totals.calories || 0, $energyUnit)}
            <span style="font-weight:400;color:var(--accent)">
              — {_hdrEnergy.value.toLocaleString()} {_hdrEnergy.unit} total
            </span>
          {/if}
        </div>
        <button class="btn btn-ghost" style="font-size:13px;height:32px;padding:0 12px"
          on:click={openPicker}>
          + Add
        </button>
      </div>

      {#if meal.items.length === 0}
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:16px 0;opacity:0.5">
          <span class="material-symbols-rounded" style="font-size:32px">restaurant</span>
          <span class="text-3 text-sm">No ingredients yet. Tap + to add.</span>
        </div>
      {:else}
        <div class="ingredient-list"
          on:pointermove={e => onDragPointerMove(e, dragOver)}
          on:pointerup={onDragPointerUp}
          on:pointercancel={onDragPointerUp}>
          {#each meal.items as item, i}
            {@const _ingEnergy = Nutrition.displayEnergy(Nutrition.calculate(item).calories || 0, $energyUnit)}
            <div class="ingredient-row"
              class:drag-over={dragOver === i && dragFrom !== null && dragFrom !== i}
              class:dragging={dragFrom === i}>
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <span class="drag-handle material-symbols-rounded"
                on:pointerdown={e => onDragHandleDown(e, i)}>
                drag_indicator
              </span>
              {#if item.imgUrl && !failedImgs.has(item.imgUrl)}
                <img src={resolveAssetUrl(item.imgUrl)} alt={item.name} class="ing-thumb"
                     on:error={() => onImgError(item.imgUrl)} />
              {:else}
                <div class="ing-thumb ing-thumb-placeholder">
                  <span class="material-symbols-rounded" style="font-size:20px;opacity:0.3">fastfood</span>
                </div>
              {/if}
              <div class="ing-info">
                <span class="ingredient-name">{item.name}</span>
                <span class="text-3" style="font-size:12px">{item.portion} {item.unit}</span>
              </div>
              <span class="text-3 text-sm">{_ingEnergy.value.toLocaleString()} {_ingEnergy.unit}</span>
              <button class="btn-icon btn-sm" on:click={() => openEditIngredient(i)}
                style="color:var(--text-3)" title="Edit ingredient">
                <span class="material-symbols-rounded" style="font-size:18px">edit</span>
              </button>
              <button class="btn-icon btn-sm" on:click={() => removeIngredient(i)}
                style="color:var(--text-3)" title="Remove ingredient">
                <span class="material-symbols-rounded" style="font-size:18px">remove_circle</span>
              </button>
            </div>
          {/each}
        </div>
        <!-- Running total + inline "add another" so users don't scroll back up -->
        {@const _ftrEnergy = Nutrition.displayEnergy(totals.calories || 0, $energyUnit)}
        <div class="ingredient-list-footer">
          <span class="ingredient-list-total">{_ftrEnergy.value.toLocaleString()} {_ftrEnergy.unit} · {meal.items.length} {meal.items.length === 1 ? 'item' : 'items'}</span>
          <button class="ingredient-add-row" on:click={openPicker}>
            <span class="material-symbols-rounded">add</span>
            <span>Add Ingredient</span>
          </button>
        </div>
      {/if}
    </div>

    <!-- Nutrition totals -->
    {#if meal.items.length > 0}
      <div class="card editor-card">
        <div class="editor-card-title">Nutrition Totals</div>
        {#each NUTRIMENTS.filter(n => (showAllNutrients ? true : n.default) && totals[n.id]) as n}
          <div style="display:flex;justify-content:space-between;padding:4px 0">
            <span class="text-sm">{n.label}</span>
            <span class="text-sm font-medium">{Math.round(totals[n.id]*10)/10} {n.unit}</span>
          </div>
        {/each}
        <button class="btn btn-ghost w-full" style="margin-top:8px"
          on:click={() => showAllNutrients = !showAllNutrients}>
          {showAllNutrients ? 'Show less' : 'Show all nutrients'}
        </button>
      </div>
    {/if}

    <div style="height:16px"></div>
  </div>
</div>

<!-- ── Ingredient picker overlay ── -->
{#if showPicker}
  <div class="picker-overlay" role="dialog" aria-modal="true">
    <div class="picker-header">
      <button class="btn-icon" on:click={() => { showPicker = false; pickerSearch = ''; selectedIngredients = new Set(); }} title="Back">
        <span class="material-symbols-rounded">arrow_back</span>
      </button>
      {#if selectedIngredients.size > 0}
        <span class="picker-count-title">{selectedIngredients.size} selected</span>
        <button class="btn-icon accent" on:click={confirmMultiIngredientAdd} aria-label="Add selected" title="Add selected">
          <span class="material-symbols-rounded">check</span>
        </button>
      {:else}
        <input class="input picker-search-input" placeholder="Search…" bind:value={pickerSearch} autofocus />
      {/if}
    </div>
    <div class="picker-tabs-row">
      {#each PICKER_TABS as label, idx}
        <button class="picker-tab-btn" class:active={pickerTab === idx}
          on:click={() => { pickerTab = idx; pickerSearch = ''; }}>
          {label}
        </button>
      {/each}
    </div>
    <div class="picker-list">
      {#if pickerLoading}
        <div class="picker-empty">Loading…</div>
      {:else if pickerFiltered.length === 0}
        <div class="picker-empty">{pickerSearch ? 'No results found' : 'No items yet. Add some in the Foods tab first.'}</div>
      {:else}
        {#each pickerFiltered as food (food.id)}
          {@const _sel = selectedIngredients.has(food)}
          {@const _pickEnergy = Nutrition.displayEnergy(food.nutrition?.calories || 0, $energyUnit)}
          <div class="picker-item-row" class:picker-item-selected={_sel}>
            <button class="picker-select-btn" on:click={() => toggleIngredient(food)} aria-label="Select">
              <span class="material-symbols-rounded picker-check" class:picker-check-on={_sel}>
                {_sel ? 'check_circle' : 'radio_button_unchecked'}
              </span>
            </button>
            <button class="picker-item-btn" on:click={() => { showPicker = false; pickerSearch = ''; selectedIngredients = new Set(); pickIngredient(food); }}>
              {#if food.imgUrl && !failedImgs.has(food.imgUrl)}
                <img src={resolveAssetUrl(food.imgUrl)} alt={food.name} class="picker-thumb"
                     on:error={() => onImgError(food.imgUrl)} />
              {:else}
                <div class="picker-thumb picker-thumb-ph">
                  <span class="material-symbols-rounded" style="font-size:20px">
                    {pickerTab === 0 ? 'restaurant' : pickerTab === 1 ? 'dinner_dining' : 'menu_book'}
                  </span>
                </div>
              {/if}
              <div class="picker-info">
                <span class="picker-name">{food.name}</span>
                {#if food.brand}<span class="text-3" style="font-size:12px">{food.brand}</span>{/if}
                {#if pickerTab === 0}
                  <span class="text-3" style="font-size:12px">{food.portion||100}{food.unit||'g'} · {_pickEnergy.value.toLocaleString()} {_pickEnergy.unit}</span>
                {:else}
                  <span class="text-3" style="font-size:12px">{_pickEnergy.value.toLocaleString()} {_pickEnergy.unit}</span>
                {/if}
              </div>
              <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent);flex-shrink:0">add_circle</span>
            </button>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<!-- ── Portion picker sheet ── -->
<Sheet bind:open={portionSheet} title={portionFood ? portionFood.name : 'Set Portion'}
  on:close={() => { editingIndex = null; }}>
  <div style="display:flex;flex-direction:column;gap:16px;padding-top:8px">
    <div style="display:flex;gap:12px">
      <div style="flex:1">
        <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">Serving Size</label>
        <input class="input" type="number" min="0.1" step="0.1" bind:value={portionAmount}
          style="font-size:16px;width:100%" />
      </div>
      <div style="width:80px">
        <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">Unit</label>
        <select class="select" bind:value={portionUnit} style="width:100%">
          {#each UNITS as u}<option value={u}>{u}</option>{/each}
        </select>
      </div>
    </div>
    <div>
      <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:6px">Quantity</label>
      <input class="input" type="number" min="0.01" step="0.1" bind:value={portionQty}
        style="font-size:16px;width:100%" />
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-2);border-radius:var(--radius-md)">
      <span style="font-size:13px;color:var(--text-3)">Total Amount</span>
      <span style="font-size:14px;font-weight:500">{Math.round((parseFloat(portionAmount) || 100) * (parseFloat(portionQty) || 1) * 10) / 10}{portionUnit || 'g'}</span>
    </div>
    <button class="btn btn-primary w-full" on:click={confirmPortion}>{editingIndex !== null ? 'Save Changes' : 'Add Ingredient'}</button>
  </div>
</Sheet>

<!-- ── Multi-ingredient portion sheet ── -->
<Sheet bind:open={showMultiPortionSheet} title="Set Portions ({multiPortionItems.length} items)">
  <div style="display:flex;flex-direction:column;gap:16px;padding-top:8px">
    {#each multiPortionItems as item, i}
      {#if i > 0}<div style="height:1px;background:var(--border);margin:4px 0"></div>{/if}
      <div style="display:flex;flex-direction:column;gap:10px">
        <span style="font-size:13px;font-weight:600;color:var(--text-1)">{item.food.name}</span>
        <div style="display:flex;gap:10px">
          <div style="flex:1">
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">Serving Size</label>
            <input class="input" type="number" min="0.1" step="0.1" bind:value={item.portion} style="width:100%;font-size:16px" />
          </div>
          <div style="width:80px">
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">Unit</label>
            <select class="select" bind:value={item.unit} style="width:100%">
              {#each UNITS as u}<option value={u}>{u}</option>{/each}
            </select>
          </div>
          <div style="width:60px">
            <label class="form-label" style="font-size:11px;color:var(--text-3);display:block;margin-bottom:5px">Qty</label>
            <input class="input" type="number" min="0.01" step="0.1" bind:value={item.qty} style="width:100%;font-size:16px" />
          </div>
        </div>
      </div>
    {/each}
    <button class="btn btn-primary w-full" on:click={confirmMultiPortion}>
      Add {multiPortionItems.length} Ingredient{multiPortionItems.length > 1 ? 's' : ''}
    </button>
  </div>
</Sheet>

<!-- ── Camera overlay ── -->
{#if cameraOpen}
  <div class="cam-overlay" role="dialog" aria-modal="true" use:portal>
    <div class="cam-popup">
      <div class="cam-header">
        <span class="cam-title">Take Photo</span>
        <button class="btn-icon" on:click={closeCamera} title="Close camera">
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
      <!-- svelte-ignore a11y-media-has-caption -->
      <video bind:this={videoEl} autoplay playsinline muted class="cam-video"></video>
      <div class="cam-footer">
        <button class="btn btn-primary cam-capture-btn" on:click={capturePhoto}>
          <span class="material-symbols-rounded">camera_alt</span>
          Capture
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Crop overlay ── -->
{#if cropOpen}
  <div class="cam-overlay" role="dialog" aria-modal="true" use:portal>
    <div class="cam-popup">
      <div class="cam-header">
        <span class="cam-title">Crop Photo</span>
        <button class="btn-icon" on:click={() => { cropOpen = false; cropSrc = ''; }} title="Cancel">
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
      <div class="crop-container"
        on:mousemove={onCropMouseMove}
        on:mouseup={onCropMouseUp}
        on:mouseleave={onCropMouseUp}
        role="img" aria-label="Crop area">
        <img bind:this={cropImgEl} src={cropSrc} alt="crop" class="crop-img" draggable="false" />
        <div class="crop-box"
          style="left:{cropBoxX}px;top:{cropBoxY}px;width:{cropBoxSize}px;height:{cropBoxSize}px"
          on:mousedown={onCropMouseDown}
          role="button" tabindex="0"
          aria-label="Drag to reposition crop"
          on:keydown={() => {}}></div>
      </div>
      <div class="cam-footer">
        <button class="btn btn-primary cam-capture-btn" on:click={confirmCrop}>Use This Crop</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .editor-page {
    padding-top: 0;
    position: fixed;
    inset: 0;
    overflow-y: auto;
    z-index: 30;
    background: var(--bg);
  }
  .editor-header {
    display: flex; align-items: center; gap: 12px;
    padding: calc(var(--safe-top) + 12px) 16px 12px;
    border-bottom: 1px solid var(--border); background: var(--surface-1);
    position: sticky; top: 0; z-index: 10;
  }
  .editor-title { font-size: 17px; font-weight: 600; flex: 1; }
  .fav-btn { color: var(--text-3); }
  .fav-btn.on { color: var(--macro-protein, #ec4899); }
  .editor-content { display: flex; flex-direction: column; gap: 12px; padding-top: 16px; padding-bottom: 32px; }
  .readonly-content { opacity: 0.78; pointer-events: none; }
  .readonly-banner {
    display: flex; align-items: center; gap: 12px;
    padding: 12px var(--page-px);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .readonly-banner .material-symbols-rounded { color: var(--accent); font-size: 20px; flex-shrink: 0; }
  .readonly-title { font-weight: 600; }
  .readonly-sub   { color: var(--text-3); font-size: 12px; margin-top: 2px; line-height: 1.4; }
  .editor-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .editor-card-title { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }

  /* Photo */
  .photo-preview-wrap {
    width: min(360px, 100%); aspect-ratio: 1 / 1; margin: 0 auto;
    border-radius: var(--radius-lg); overflow: hidden;
    border: 2px dashed var(--border);
    background: var(--surface-2);
    display: flex; align-items: center; justify-content: center;
  }
  .photo-preview-img { width: 100%; height: 100%; object-fit: cover; display: block; background: var(--surface-2); }
  .photo-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .photo-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
  .photo-btn { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; font-size: 13px; }
  .photo-url-row { display: flex; gap: 8px; margin-top: 8px; }
  .photo-url-input { flex: 1; }

  /* Categories */
  .cat-chips { display: flex; flex-wrap: wrap; gap: 6px; }

  /* Ingredient rows */
  .ingredient-list { display: flex; flex-direction: column; touch-action: none; }
  .ingredient-add-row {
    display: flex; align-items: center; gap: 8px;
    margin-top: 10px; padding: 10px 12px;
    background: var(--surface-2); border: 1px dashed var(--border);
    border-radius: var(--radius-md); color: var(--accent);
    font-size: 13px; font-weight: 500; width: 100%;
    cursor: pointer; transition: background var(--dur-fast);
  }
  .ingredient-add-row:hover { background: var(--surface-3); }
  .ingredient-add-row .material-symbols-rounded { font-size: 18px; }
  .ingredient-list-footer {
    display: flex; flex-direction: column; gap: 8px; margin-top: 10px;
  }
  .ingredient-list-total {
    font-size: 12px; color: var(--text-3); text-align: right;
    font-weight: 500;
  }
  .ingredient-list-footer .ingredient-add-row { margin-top: 0; }
  .ingredient-row {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 0; border-bottom: 1px solid var(--border);
    transition: background 120ms, opacity 120ms;
  }
  .ingredient-row:last-child { border-bottom: none; }
  .ingredient-row.dragging { opacity: 0.4; }
  .ingredient-row.drag-over { background: var(--accent-dim); border-radius: var(--radius-sm); }
  .drag-handle {
    font-size: 20px; color: var(--text-3); cursor: grab; flex-shrink: 0;
    touch-action: none; user-select: none; -webkit-user-select: none;
  }
  .drag-handle:active { cursor: grabbing; }
  .ing-thumb { width: 52px; height: 52px; border-radius: var(--radius-md); object-fit: cover; flex-shrink: 0; }
  .ing-thumb-placeholder {
    display: flex; align-items: center; justify-content: center;
    background: var(--surface-2);
  }
  .ing-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ingredient-name { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btn-sm { width: 32px; height: 32px; }

  /* Ingredient picker overlay */
  .picker-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: var(--surface-0, var(--surface-1));
    display: flex; flex-direction: column;
  }
  .picker-header {
    display: flex; gap: 8px; align-items: center;
    padding: calc(var(--safe-top) + 12px) 16px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .picker-search-input { flex: 1; }
  .picker-tabs-row {
    display: flex; gap: 4px; padding: 10px 16px 0;
    flex-shrink: 0;
  }
  .picker-tab-btn {
    flex: 1; padding: 8px 0; border-radius: var(--radius-md);
    border: 1.5px solid var(--border); background: none;
    font-size: 13px; font-weight: 500; cursor: pointer;
    color: var(--text-2); transition: all var(--dur-fast);
  }
  .picker-tab-btn.active {
    background: var(--accent); border-color: var(--accent);
    color: var(--surface-1); font-weight: 600;
  }
  .picker-list { flex: 1; overflow-y: auto; padding: 8px 0; }
  .picker-empty { padding: 48px 24px; text-align: center; color: var(--text-3); font-size: 14px; }
  .picker-count-title {
    flex: 1; font-size: 17px; font-weight: 600; color: var(--text-1);
  }
  .picker-item-row {
    display: flex; align-items: center;
    border-bottom: 1px solid var(--border);
    transition: background 120ms;
  }
  .picker-item-row:last-child { border-bottom: none; }
  .picker-item-row.picker-item-selected { background: var(--accent-dim); }
  .picker-select-btn {
    flex-shrink: 0; width: 44px; height: 100%; min-height: 56px;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; cursor: pointer; padding: 0;
  }
  .picker-check { font-size: 22px; color: var(--text-3); transition: color 120ms; }
  .picker-check.picker-check-on { color: var(--accent); }
  .picker-item-btn {
    display: flex; align-items: center; gap: 12px;
    flex: 1; padding: 10px 16px 10px 0;
    background: none; border: none; cursor: pointer;
    text-align: left; color: var(--text-1);
    transition: background var(--dur-fast);
  }
  .picker-item-btn:last-child { border-bottom: none; }
  .picker-item-btn:active { background: var(--surface-2); }
  .picker-thumb {
    width: 44px; height: 44px; border-radius: var(--radius-sm);
    object-fit: cover; flex-shrink: 0;
  }
  .picker-thumb-ph {
    background: var(--accent-dim); display: flex;
    align-items: center; justify-content: center; color: var(--accent);
  }
  .picker-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .picker-name { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Camera / Crop overlays — shared styles live in FoodEditor's :global CSS */
  :global(.crop-box) {
    position: absolute;
    border: 2px solid var(--accent);
    cursor: grab;
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.45);
  }
</style>
