<script>
  /**
   * QuickCaloriesSheet — bottom sheet for Fitbit-style "log just a calorie
   * number" entries. Opened from the ⚡ bolt button in each meal section's
   * header in Diary.svelte. Issue #42.
   *
   * Honors the user's energyUnit setting (kcal / kJ). When kJ is selected
   * the input label + value are in kJ; conversion to kcal happens at save
   * time so internal storage stays consistent with the rest of the diary.
   *
   * Layout: kcal field on top in a calories-tinted pill, then a 3-across
   * row of optional macro inputs (protein / carbs / fat) each tinted with
   * its own macro color — same visual language as the qty-macro-pill row
   * on the Foods quantity sheet. roseyhead's path is kcal only (2 taps).
   * nomad64's MFP-style path uses any subset of the macro inputs.
   *
   * Blank macro inputs aren't stored — no zero-filled phantom values that
   * could pollute the diary's daily totals.
   *
   * The optional name field is what later shows in the diary row in
   * "Separate" display mode (or as the expanded breakdown in "Summed"
   * mode). Leave blank to default to "Quick Calories".
   */
  import { createEventDispatcher } from 'svelte';
  import Sheet from '../ui/Sheet.svelte';
  import { addQuickCalories } from '../../stores/diary.js';
  import { energyUnit } from '../../stores/settings.js';
  import { showError } from '../../stores/toast.js';
  import { _ } from 'svelte-i18n';

  export let open = false;
  export let meal = 0;          // meal index this entry will be filed under
  export let mealName = '';     // for sheet title

  const dispatch = createEventDispatcher();

  let _name = '';
  let _value = '';
  let _protein = '';
  let _carbs = '';
  let _fat = '';
  let _saving = false;
  let _inputEl;

  // Reset fields whenever the sheet opens fresh, and focus the value input.
  $: if (open) {
    _name = '';
    _value = '';
    _protein = '';
    _carbs = '';
    _fat = '';
    _saving = false;
    setTimeout(() => _inputEl?.focus(), 50);
  }

  $: _isKj = $energyUnit === 'kJ';
  $: _unitLabel = _isKj ? 'kJ' : 'kcal';

  function _parseOpt(v) {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  async function _save() {
    const raw = Number(_value);
    if (!Number.isFinite(raw) || raw <= 0) {
      showError(`Enter a positive ${_unitLabel} value.`);
      return;
    }
    // kJ → kcal: 1 kcal = 4.184 kJ. Store as kcal internally (matches the
    // rest of the diary — energyUnit only affects display).
    const kcal = _isKj ? Math.round(raw / 4.184) : Math.round(raw);
    _saving = true;
    try {
      await addQuickCalories({
        kcal,
        name: _name,
        meal,
        proteins:      _parseOpt(_protein),
        carbohydrates: _parseOpt(_carbs),
        fat:           _parseOpt(_fat),
      });
      dispatch('added', { kcal, name: _name || 'Quick Calories', meal });
      open = false;
    } catch (e) {
      showError(e.message || 'Could not save quick calories.');
    } finally {
      _saving = false;
    }
  }

  function _onKey(e) {
    if (e.key === 'Enter') _save();
  }
</script>

<Sheet bind:open title="Quick Calories{mealName ? `: ${mealName}` : ''}">
  <div class="qc-body">
    <p class="qc-help">
      Log just the {_unitLabel} when you don't have full nutrition info, or when you don't want to model the food. Optional macros are stored only when you fill them in. Adds straight to the diary; no food entry is created.
    </p>

    <label class="form-label" for="qc-name">Name (optional)</label>
    <input id="qc-name" class="input" type="text" maxlength="60"
           placeholder="Office snack, hotel breakfast..."
           bind:value={_name} on:keydown={_onKey} />

    <div class="qc-kcal-pill" style="background:var(--macro-calories-dim)">
      <input id="qc-value" class="qc-kcal-input" type="number" inputmode="numeric"
             min="1" step="1" placeholder={_isKj ? '1000' : '240'}
             style="color:var(--macro-calories)"
             bind:value={_value} bind:this={_inputEl} on:keydown={_onKey} />
      <span class="qc-kcal-unit" style="color:var(--macro-calories)">{_unitLabel.toUpperCase()}</span>
    </div>

    <p class="qc-section-label">Optional Macros</p>
    <div class="qc-macros">
      <div class="qc-macro-pill" style="background:var(--macro-protein-dim)">
        <div class="qc-macro-val-row">
          <input class="qc-macro-input" type="number" inputmode="decimal"
                 min="0" step="0.1" placeholder="0"
                 style="color:var(--macro-protein); --qc-w:{Math.max(1, String(_protein || '').length)}ch"
                 bind:value={_protein} on:keydown={_onKey} />
          <span class="qc-macro-unit" style="color:var(--macro-protein)">g</span>
        </div>
        <span class="qc-macro-label">Protein</span>
      </div>
      <div class="qc-macro-pill" style="background:var(--macro-carbs-dim)">
        <div class="qc-macro-val-row">
          <input class="qc-macro-input" type="number" inputmode="decimal"
                 min="0" step="0.1" placeholder="0"
                 style="color:var(--macro-carbs); --qc-w:{Math.max(1, String(_carbs || '').length)}ch"
                 bind:value={_carbs} on:keydown={_onKey} />
          <span class="qc-macro-unit" style="color:var(--macro-carbs)">g</span>
        </div>
        <span class="qc-macro-label">Carbs</span>
      </div>
      <div class="qc-macro-pill" style="background:var(--macro-fat-dim)">
        <div class="qc-macro-val-row">
          <input class="qc-macro-input" type="number" inputmode="decimal"
                 min="0" step="0.1" placeholder="0"
                 style="color:var(--macro-fat); --qc-w:{Math.max(1, String(_fat || '').length)}ch"
                 bind:value={_fat} on:keydown={_onKey} />
          <span class="qc-macro-unit" style="color:var(--macro-fat)">g</span>
        </div>
        <span class="qc-macro-label">Fat</span>
      </div>
    </div>

    <div class="qc-actions">
      <button class="btn btn-secondary" on:click={() => open = false} disabled={_saving}>Cancel</button>
      <button class="btn btn-primary" on:click={_save} disabled={_saving || !_value}>
        {_saving ? 'Adding…' : 'Add'}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .qc-body { padding: 4px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
  .qc-help { color: var(--text-3); font-size: 13px; line-height: 1.4; margin: 0 0 4px 0; }

  /* kcal pill — calories-tinted background with bold value + unit. */
  .qc-kcal-pill {
    display: flex; align-items: baseline; justify-content: center; gap: 8px;
    padding: 14px 16px; border-radius: var(--radius-md);
    margin-top: 4px;
  }
  .qc-kcal-input {
    background: transparent; border: 0; outline: 0;
    font-size: 28px; font-weight: 700;
    width: 130px; text-align: right;
    font-variant-numeric: tabular-nums;
    /* Strip the type=number spinner arrows so it's pure tap-and-type. */
    -moz-appearance: textfield;
  }
  .qc-kcal-input::-webkit-outer-spin-button,
  .qc-kcal-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  /* Uppercase + letter-spaced unit label matches .ns-macro-lbl in
     Diary.svelte's nutrition summary so KCAL / KJ read in the same
     visual register as PROTEIN / CARBS / FAT below. */
  .qc-kcal-unit {
    font-size: 12px;
    font-weight: 700;
    min-width: 36px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .qc-section-label {
    font-size: 12px; font-weight: 600;
    color: var(--text-2);
    margin: 6px 0 0 0;
    letter-spacing: 0.02em;
  }

  /* 3-across macro pills — mirrors .qty-macros / .qty-macro-pill in Foods.svelte
     so the visual language matches the quantity card after picking a food. */
  .qc-macros {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .qc-macro-pill {
    display: flex; flex-direction: column; align-items: center;
    padding: 10px 8px; border-radius: var(--radius-md);
    gap: 2px;
  }
  /* Value + unit sit on one row so the macro pill reads "24g" inline,
     matching .ns-macro-val ("24g" as a single token) in Diary.svelte's
     nutrition summary card. Input is content-sized via field-sizing so
     the "g" hugs the typed number instead of floating to the pill edge. */
  .qc-macro-val-row {
    display: inline-flex; align-items: baseline; justify-content: center;
    gap: 1px;
  }
  .qc-macro-input {
    background: transparent; border: 0; outline: 0;
    font-size: 20px; font-weight: 700;
    text-align: right;
    font-variant-numeric: tabular-nums;
    /* Width tracks the typed value's length via a per-input CSS variable
       set inline so the "g" stays flush against the digits regardless of
       value (10, 99, 999, 99.9, etc.). Works on every Capacitor WebView
       since it's plain CSS, no field-sizing dependency. */
    width: var(--qc-w, 1ch); min-width: 1ch; max-width: 6ch;
    padding: 0;
    /* Hide the spinner arrows so the field stays clean. */
    -moz-appearance: textfield;
  }
  .qc-macro-input::-webkit-outer-spin-button,
  .qc-macro-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  /* Match .ns-macro-lbl from Diary.svelte exactly so PROTEIN / CARBS / FAT
     read in the same visual register as the nutrition summary card. */
  .qc-macro-label {
    font-size: 11px;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* Same size/weight as .ns-macro-val so "24g" reads as one token. */
  .qc-macro-unit { font-size: 20px; font-weight: 700; }

  .qc-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
  .qc-actions .btn { min-width: 100px; }
</style>
