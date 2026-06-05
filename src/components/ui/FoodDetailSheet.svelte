<script>
  /**
   * FoodDetailSheet — read-only slide-up bottom sheet for a saved food.
   *
   * Phase 2 of the NutritionFactsBox rollout. Replaces the previous "tap a
   * food → navigate to /foods/edit/<id>" flow on the Foods tab with a
   * lighter, in-place card view. The user sees the FDA-style Nutrition
   * Facts card immediately, can log to today's diary without leaving the
   * Foods tab, and reaches the full editor only when they explicitly tap
   * Edit.
   *
   * Visual layout is a 1:1 port of CookTrace's PantryItemSheet minus the
   * pantry-specific bits (no in-stock toggle, no on-hand quantity, no
   * category, no used-in-recipes list). Two-column grid on desktop
   * (≥768px): left column is photo + identity card, right column is stats
   * (Serving Size + Meal picker) + Nutrition Facts card + Add to Diary
   * action. Footer has Delete + Edit. Mobile collapses to single column;
   * the stats grid also collapses (<480px) for tight phone screens.
   *
   * Phase 3 will add inline edit mode + a kebab menu surfacing OFF actions
   * (Refresh from OFF, Contribute to OFF, Save as Copy). For now, Edit
   * always opens the full FoodEditor so no editor capability is lost.
   *
   * Props:
   *   open         — bind:open from the parent. Standard Sheet binding.
   *   food         — the food row to display. NT food shape (imgUrl,
   *                  portion, unit, nutrition, etc.). Null while closed.
   *   defaultMeal  — meal index (0..3) the picker opens to. Parent passes
   *                  the user's last-used meal so the common case is one
   *                  tap on Add to Diary.
   *
   * Events:
   *   edit         — user tapped Edit. Parent opens FoodEditor.
   *   addToDiary   — user tapped + Add to Diary. detail: {food, meal}.
   *   deleted      — user tapped Delete and confirmed. Parent refreshes
   *                  the foods list.
   *   close        — user dismissed the sheet without action.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from './Sheet.svelte';
  import ActionSheet from './ActionSheet.svelte';
  import NutritionFactsBox from './NutritionFactsBox.svelte';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { Nutrition, energyUnitSuffix } from '../../lib/nutrition.js';
  import { energyUnit, mealNames } from '../../stores/settings.js';
  import { NtApi } from '../../lib/api.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  export let open = false;
  export let food = null;

  const dispatch = createEventDispatcher();

  // Local copy that survives the parent setting food=null on close.
  // Without this, the sheet's content flickers blank during the slide-down
  // animation. Refresh whenever the parent opens with a new food.
  let _displayFood = null;
  $: if (open && food) { _displayFood = food; }

  // Meal picker ActionSheet — opened when Add to Diary is tapped. The user
  // explicitly picks the destination meal as part of the log action, which
  // is clearer than the previous twin-stat pattern where a "Meal" card sat
  // next to "Serving Size" looking like passive data. Plain meal names —
  // no last-used suggestion suffix, per user preference; every tap is a
  // one-action commit so a suggestion adds noise without speeding the
  // common case.
  let _mealPickerOpen = false;
  $: _mealActions = (($mealNames || ['Breakfast','Lunch','Dinner','Snacks'])
    .map((label, value) => ({ label, value })));

  // Image URL: NT foods carry `imgUrl` (camelCase). OFF / USDA picker rows
  // that haven't been saved yet may carry `img_url` (snake_case) or one of
  // the OFF-specific fields. Try in order so the same sheet renders any of
  // these source shapes without a separate path.
  $: _ofImg = _displayFood?.imgUrl
           || _displayFood?.img_url
           || _displayFood?.image_url
           || _displayFood?.image_front_url
           || null;

  // Serving Size shown in the right-column stat card AND threaded into the
  // NutritionFactsBox so the FDA label reads consistently with the stat.
  $: servingDescription = _displayFood
    ? _formatServing(_displayFood)
    : $_('foods.detail.per_serving');

  function _formatServing(f) {
    const p = Number(f.portion);
    const u = f.unit || 'g';
    if (!Number.isFinite(p) || p <= 0) return $_('foods.detail.per_serving');
    return `${p} ${u}`;
  }

  // Calories headline for the pill below the food name. Stored kcal
  // converts to the user's preferred energy unit (kcal or kJ) for display.
  $: energyChip = (() => {
    const v = _displayFood?.nutrition?.calories;
    if (v == null || v === '') return null;
    const d = Nutrition.displayEnergy(v, $energyUnit);
    return `${d.value} ${energyUnitSuffix($energyUnit)}`;
  })();

  // Sheet → editor transition. The parent's onDetailEdit handler pushes
  // the editor route synchronously; the sheet's own slide-down animation
  // (200ms, built into Sheet.svelte) runs in parallel. Sequencing the
  // close before the navigation (with tick) keeps both motions overlapped
  // so it reads as one cohesive "opening the editor" beat rather than
  // dismiss-then-navigate.
  let _transitioning = false;
  async function onEditTap() {
    if (_transitioning) return;
    _transitioning = true;
    open = false;
    await tick();
    dispatch('edit', { food: _displayFood });
    setTimeout(() => { _transitioning = false; }, 250);
  }

  function onAddToDiaryTap() {
    if (_transitioning) return;
    // Open the meal picker; don't close the detail sheet underneath so
    // the user can still see what they're logging while choosing the meal.
    // Final commit (close detail sheet + dispatch addToDiary) happens in
    // onMealPicked once they tap a meal.
    _mealPickerOpen = true;
  }

  function onMealPicked(e) {
    const meal = Number(e.detail?.value) || 0;
    if (_transitioning) return;
    _transitioning = true;
    open = false;
    dispatch('addToDiary', { food: _displayFood, meal });
    setTimeout(() => { _transitioning = false; }, 250);
  }

  async function onDeleteTap() {
    if (_transitioning) return;
    if (!_displayFood?.id) return;
    const ok = await confirmDialog({
      title: $_('foods.detail.delete_confirm_title'),
      message: $_('foods.detail.delete_confirm_body', { values: { name: _displayFood.name } }),
      confirmLabel: $_('common.delete'),
      cancelLabel: $_('common.cancel'),
      dangerous: true,
    });
    if (!ok) return;
    _transitioning = true;
    try {
      await NtApi.deleteFood(_displayFood.id);
      open = false;
      dispatch('deleted', { food: _displayFood });
      showSuccess($_('foods.detail.deleted'));
    } catch (e) {
      showError((e?.message) || $_('common.errors.delete_failed'));
    } finally {
      setTimeout(() => { _transitioning = false; }, 250);
    }
  }

  function onClose() {
    dispatch('close');
  }
</script>

<Sheet bind:open title={_displayFood?.name || ''} height="auto" on:close={onClose}>
  {#if _displayFood}
    <div class="grid">
      <!-- LEFT — identity column (photo + brand + barcode pill). Matches
           CookTrace's PantryItemSheet identity card 1:1, minus the
           in-stock toggle and category pill since NT doesn't track those. -->
      <div class="col-identity">
        {#if _ofImg}
          <img class="hero-photo" src={resolveAssetUrl(_ofImg)} alt="" />
        {:else}
          <div class="hero-stub">
            <span class="material-symbols-rounded">restaurant</span>
          </div>
        {/if}
        <div class="identity-info">
          {#if _displayFood.brand}
            <div class="brand">{_displayFood.brand}</div>
          {/if}
          <div class="meta-pills">
            {#if energyChip}
              <span class="pill">{energyChip}</span>
            {/if}
            {#if _displayFood.barcode}
              <span class="pill subtle" title={$_('foods.detail.barcode')}>
                <span class="material-symbols-rounded">barcode_scanner</span>
                {_displayFood.barcode}
              </span>
            {/if}
          </div>
        </div>
      </div>

      <!-- RIGHT — data column: FDA-style Nutrition Facts label + Add to
           Diary primary button. The label's first line already shows
           Serving Size, so no separate stat card above it. -->
      <div class="col-data">
        <div class="nutrition-wrap">
          <NutritionFactsBox
            nutrition={_displayFood.nutrition || {}}
            servingDescription={servingDescription} />
        </div>

        <button class="btn btn-primary add-btn"
                on:click={onAddToDiaryTap}
                aria-label={$_('foods.detail.add_to_diary_aria')}>
          <span class="material-symbols-rounded">add</span>
          {$_('foods.detail.add_to_diary')}
        </button>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-secondary danger-btn"
              on:click={onDeleteTap}
              aria-label={$_('foods.detail.delete_aria')}
              disabled={!_displayFood?.id || _transitioning}>
        <span class="material-symbols-rounded">delete</span>
        {$_('common.delete')}
      </button>
      <button class="btn btn-secondary"
              on:click={onEditTap}
              aria-label={$_('foods.detail.edit_aria')}>
        <span class="material-symbols-rounded">edit</span>
        {$_('foods.detail.edit')}
      </button>
    </div>
  {/if}
</Sheet>

<!-- Meal picker: shown after Add to Diary tap. ActionSheet layers above
     the detail sheet so the user can still see the food while choosing
     the destination meal. Tapping a meal commits + closes both sheets;
     Cancel just closes this picker, detail sheet stays open. -->
<ActionSheet
  bind:open={_mealPickerOpen}
  title={$_('foods.detail.add_to_which_meal')}
  actions={_mealActions}
  on:select={onMealPicked} />

<style>
  /* Two-column grid on desktop, single column on mobile. Mirrors CT's
     PantryItemSheet 1:1 — the only deviation is column ratio (CT uses
     1fr / 1.05fr; we match exactly so the FDA card sits where users see
     it in CookTrace too). */
  .grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
  }

  /* LEFT — identity card (photo + brand + barcode). Bordered surface so
     the photo sits on a clear background that handles non-square product
     shots gracefully (object-fit:contain + letterbox color). */
  .col-identity {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .hero-photo {
    width: 100%;
    aspect-ratio: 1 / 1;
    object-fit: contain;
    background: var(--surface-2);
    display: block;
  }
  .hero-stub {
    width: 100%;
    aspect-ratio: 1 / 1;
    background: var(--surface-2);
    display: flex; align-items: center; justify-content: center;
  }
  .hero-stub .material-symbols-rounded { font-size: 64px; color: var(--text-3); }

  .identity-info {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .brand { color: var(--text-3); font-size: 13px; font-weight: 500; }
  .meta-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-full, 99px);
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 600;
  }
  .pill.subtle { background: var(--surface-2); color: var(--text-3); border-color: var(--border); }
  .pill .material-symbols-rounded { font-size: 14px; }

  /* RIGHT — data column. */
  .col-data {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .nutrition-wrap { display: flex; justify-content: center; }

  .add-btn {
    width: 100%;
    height: 44px;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    font-size: 14px;
  }
  .add-btn .material-symbols-rounded { font-size: 18px; }

  /* Footer — Delete + Edit. Delete is danger-styled (matches CT). Edit
     stays secondary because the primary action on this sheet is
     contextually Add to Diary (which lives in col-data above). */
  .actions {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    padding-top: 12px;
    margin-top: 6px;
    border-top: 1px solid var(--border);
  }
  .actions .btn {
    flex: 1;
    height: 44px;
    font-size: 14px;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .actions .btn .material-symbols-rounded { font-size: 18px; }
  .danger-btn {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
  }
  .danger-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }

  /* Desktop (≥768px) — two-column split. Matches CT's breakpoint and
     column ratio so the layout is identical at desktop widths. */
  @media (min-width: 768px) {
    .grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
      gap: 16px;
      align-items: start;
    }
  }
</style>
