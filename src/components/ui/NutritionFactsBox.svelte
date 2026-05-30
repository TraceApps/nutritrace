<script>
  /**
   * NutritionFactsBox — FDA-style "Nutrition Facts" label.
   *
   * TraceApps brand cohesion: this component is a byte-for-byte port of
   * CookTrace's NutritionFactsBox so the shared visual language stays
   * consistent across the family. When updating either copy, mirror the
   * change to the other; treat divergence as a bug.
   *
   * Layout matches the standard FDA "Nutrition Facts" panel: huge
   * "Nutrition Facts" title, serving info, thick rule, prominent
   * Calories row, % Daily Value column, indented sub-nutrients,
   * a thick rule before the vitamin/mineral block, and the small
   * footnote at the bottom.
   *
   * Props:
   *   nutrition           — { calories, fat, ..., _derived: {...} }
   *   servings            — recipe servings count (legacy)
   *   yieldText           — recipe yield text
   *   servingDescription  — pantry override: "100 g" / "1 cup, sifted"
   *   servingsPerContainer — optional packaged-food line
   *   forceShowAll        — when true, render every nutriment that has a
   *                         non-trivial value, IGNORING the user's
   *                         visibleNutriments preference. Used by Trace's
   *                         AI proposal cards so the user sees everything
   *                         the model estimated, not just their normal
   *                         daily-view subset.
   */
  import {
    NUTRIMENTS, DEFAULT_VISIBLE_NUTRIMENT_IDS,
    dvPercent, isDerived,
    energyLabel, energyUnitSuffix,
    Nutrition,
  } from '../../lib/nutrition.js';
  import { visibleNutriments, energyUnit } from '../../stores/settings.js';

  export let nutrition = {};
  export let servings = null;
  export let yieldText = '';
  export let servingDescription = '';
  export let servingsPerContainer = null;
  export let forceShowAll = false;

  // Effective visible-set: user choice if any, else the default subset.
  // Bypassed entirely when forceShowAll is on — the AI proposal card is
  // meant to be a transparent dump of what the model estimated,
  // independent of the user's daily-view nutrient preferences.
  $: visibleSet = new Set(
    Array.isArray($visibleNutriments) && $visibleNutriments.length > 0
      ? $visibleNutriments
      : DEFAULT_VISIBLE_NUTRIMENT_IDS
  );

  // Filter to nutriments that have a value present AND (are user-visible
  // OR forceShowAll is on).
  $: rows = NUTRIMENTS.filter(n => {
    if (!forceShowAll && !visibleSet.has(n.id)) return false;
    const v = nutrition?.[n.id];
    return v != null && v !== '' && Number(v) >= 0 &&
      // Only include zero-valued rows for the canonical FDA-required
      // nutrients — otherwise a pantry item filling everything to 0
      // would render every nutrient as "0g".
      (Number(v) > 0 || n.fdaRequired);
  });

  // Calories gets the prominent display.
  $: caloriesNut = rows.find(r => r.id === 'calories');
  $: caloriesValDisplay = caloriesNut
    ? Nutrition.displayEnergy(nutrition[caloriesNut.id], $energyUnit).value : null;
  $: caloriesUnitLabel = energyUnitSuffix($energyUnit);
  $: caloriesRowLabel = energyLabel($energyUnit);
  $: bodyRows = rows.filter(r => r.id !== 'calories');

  // Macros (incl. their sub-rows) go above the thick rule; vitamins +
  // minerals go below.
  $: macroRows  = bodyRows.filter(r => r.category !== 'vitamin' && r.category !== 'mineral');
  $: vitMinRows = bodyRows.filter(r => r.category === 'vitamin' || r.category === 'mineral');

  function fmt(v, unit) {
    if (v == null) return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    // Whole when close enough; otherwise 1 decimal max. No space
    // between number and unit (matches FDA: "0g", "15mg").
    const text = Math.abs(n - Math.round(n)) < 0.05
      ? String(Math.round(n))
      : n.toFixed(1).replace(/\.0$/, '');
    return text + (unit || '');
  }
  function _depth(n) {
    // 0 = top-level, 1 = sub (Saturated Fat, Dietary Fiber), 2 = sub-sub
    // (Includes Added Sugars). NUTRIMENTS may chain via subOf.
    let d = 0;
    let cur = n;
    while (cur?.subOf) {
      d++;
      cur = NUTRIMENTS.find(x => x.id === cur.subOf);
      if (!cur || d > 3) break;
    }
    return d;
  }
</script>

{#if rows.length > 0}
<div class="nfacts">
  <div class="title">Nutrition Facts</div>

  {#if servingsPerContainer}
    <div class="serving-line">{servingsPerContainer} servings per container</div>
  {/if}
  <div class="serving-line">
    <strong>Serving Size</strong>
    <span class="serving-detail">
      {#if servingDescription}
        {servingDescription}
      {:else if yieldText}
        1 of {servings || '?'} ({yieldText})
      {:else if servings}
        1 of {servings}
      {:else}
        per serving
      {/if}
    </span>
  </div>

  <div class="rule thick"></div>

  {#if caloriesNut}
    <div class="amount-label">Amount Per Serving</div>
    <div class="cal-row">
      <span class="cal-name">{caloriesRowLabel}</span>
      <span class="cal-value">
        {caloriesValDisplay}{#if $energyUnit === 'kJ'}<span class="cal-unit"> {caloriesUnitLabel}</span>{/if}
      </span>
    </div>
    <div class="rule mid"></div>
  {/if}

  <div class="dv-header">% Daily Value*</div>

  {#each macroRows as nut (nut.id)}
    {@const v = nutrition[nut.id]}
    {@const dv = dvPercent(nut, v)}
    {@const depth = _depth(nut)}
    {@const derived = isDerived(nutrition, nut.id)}
    <div class="row" class:bold={nut.bold && depth === 0} class:italic={nut.italic}
      style={depth > 0 ? `padding-left:${depth * 14}px` : ''}>
      <span class="row-label">
        {#if nut.id === 'added-sugars'}
          <!-- FDA format: "Includes <qty> Added Sugars". Qty is
               embedded between "Includes" and the label. -->
          <span class="row-name">Includes {fmt(v, nut.unit)} {nut.label}</span>
        {:else}
          <span class="row-name">{nut.label}</span>
          <span class="row-value">{fmt(v, nut.unit)}</span>
        {/if}
        {#if derived}
          <span class="derived material-symbols-rounded"
            title="Derived from {nut.id === 'sodium' ? 'salt' : 'sodium'}">calculate</span>
        {/if}
      </span>
      <span class="row-dv">{dv != null ? `${dv}%` : ''}</span>
    </div>
  {/each}

  {#if vitMinRows.length > 0}
    <div class="rule thick"></div>
    {#each vitMinRows as nut, i (nut.id)}
      {@const v = nutrition[nut.id]}
      {@const dv = dvPercent(nut, v)}
      <div class="row vmin" class:no-bottom={i === vitMinRows.length - 1}>
        <span class="row-label">
          <span class="row-name">{nut.label}</span>
          <span class="row-value">{fmt(v, nut.unit)}</span>
        </span>
        <span class="row-dv">{dv != null ? `${dv}%` : ''}</span>
      </div>
    {/each}
  {/if}

  <div class="rule thick"></div>
  <p class="footnote">
    * The % Daily Value (DV) tells you how much a nutrient in a serving
    of food contributes to a daily diet. 2,000 calories a day is used
    for general nutrition advice.
  </p>
</div>
{/if}

<style>
  /* Black-on-white FDA Nutrition Facts label. Color is intentionally
     fixed to black/white so it reads as the official label even in
     dark mode. Mirrors CookTrace's scoped styles. */
  .nfacts {
    background: #ffffff;
    color: #000000;
    border: 2px solid #000;
    padding: 8px 12px 12px;
    border-radius: 4px;
    max-width: 380px;
    width: 100%;
    box-sizing: border-box;
    font-family: 'Helvetica Neue', 'Arial Black', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.2;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  .title {
    font-size: 32px;
    font-weight: 900;
    line-height: 1.0;
    letter-spacing: -0.01em;
    padding: 4px 0 6px;
  }

  .serving-line {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
    font-size: 15px;
    line-height: 1.25;
    padding: 1px 0;
  }
  .serving-line strong { font-weight: 700; }
  .serving-detail { font-weight: 700; text-align: right; }

  .rule { border-top: 1px solid #000; margin: 4px -12px; }
  .rule.thick { border-top-width: 10px; }
  .rule.mid   { border-top-width: 5px; }

  .amount-label {
    font-size: 11px;
    font-weight: 700;
    padding-top: 4px;
  }

  .cal-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0 0 4px;
  }
  .cal-name  { font-size: 26px; font-weight: 900; line-height: 1; }
  .cal-value { font-size: 38px; font-weight: 900; line-height: 1; }
  .cal-unit  { font-size: 14px; font-weight: 700; }

  .dv-header {
    text-align: right;
    font-size: 12px;
    font-weight: 700;
    border-bottom: 1px solid #000;
    padding: 2px 0 2px;
    margin-bottom: 0;
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid #000;
    padding: 4px 0;
    font-size: 14px;
  }
  .row.italic { font-style: italic; }
  .row-label  { display: inline-flex; align-items: baseline; gap: 4px; flex: 1; min-width: 0; }
  .row-name   { font-weight: 700; }
  .row:not(.bold) .row-name { font-weight: 400; }
  .row.bold .row-name { font-weight: 700; }
  .row-value { font-weight: 400; }
  .row-dv {
    font-weight: 700;
    min-width: 44px;
    text-align: right;
    flex-shrink: 0;
  }

  .row.vmin {
    font-size: 13px;
    padding: 3px 0;
  }
  .row.vmin .row-name { font-weight: 400; }
  .row.vmin.no-bottom { border-bottom: none; }

  .derived {
    font-size: 13px;
    color: #555;
    margin-left: 3px;
    cursor: help;
  }

  .footnote {
    font-size: 10.5px;
    line-height: 1.35;
    margin: 6px 0 0;
    font-weight: 400;
  }
</style>
