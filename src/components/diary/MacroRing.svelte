<script>
  import { tweened } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';

  export let calories    = 0;
  export let caloriesGoal = 2000;
  export let fat     = 0;
  export let carbs   = 0;
  export let protein = 0;

  const SIZE = 200;
  const STROKE = 14;
  const R = (SIZE - STROKE) / 2;
  const C = 2 * Math.PI * R;

  // Animate values
  const aFat     = tweened(0, { duration: 600, easing: cubicOut });
  const aCarbs   = tweened(0, { duration: 600, easing: cubicOut });
  const aProtein = tweened(0, { duration: 600, easing: cubicOut });
  const aCals    = tweened(0, { duration: 700, easing: cubicOut });

  $: aFat.set(fat);
  $: aCarbs.set(carbs);
  $: aProtein.set(protein);
  $: aCals.set(calories);

  $: total = ($aFat * 9) + ($aCarbs * 4) + ($aProtein * 4);

  function arc(value, total) {
    if (!total) return C; // empty ring
    const pct = Math.min(value / total, 1);
    return C - C * pct;
  }

  $: fatKcal     = $aFat * 9;
  $: carbsKcal   = $aCarbs * 4;
  $: proteinKcal = $aProtein * 4;

  $: fatOffset     = C;
  $: carbsOffset   = arc(fatKcal, total);
  $: proteinOffset = arc(fatKcal + carbsKcal, total);

  // Rotation so segments appear in order: fat -> carbs -> protein
  $: fatRotate     = -90;
  $: carbsRotate   = fatRotate + (fatKcal / (total || 1)) * 360;
  $: proteinRotate = carbsRotate + (carbsKcal / (total || 1)) * 360;

  $: caloriesPct = caloriesGoal ? Math.min($aCals / caloriesGoal, 1) : 0;
  $: bgOffset    = C - C * caloriesPct;
</script>

<div class="ring-wrap">
  <svg width={SIZE} height={SIZE} viewBox="0 0 {SIZE} {SIZE}" class="ring-svg">
    <!-- Background track -->
    <circle
      cx={SIZE/2} cy={SIZE/2} r={R}
      fill="none"
      stroke="var(--surface-3)"
      stroke-width={STROKE}
    />
    <!-- Calories progress ring (outer faint) -->
    <circle
      cx={SIZE/2} cy={SIZE/2} r={R}
      fill="none"
      stroke="var(--accent)"
      stroke-width={STROKE}
      stroke-dasharray={C}
      stroke-dashoffset={bgOffset}
      stroke-linecap="round"
      transform="rotate(-90 {SIZE/2} {SIZE/2})"
      opacity="0.2"
    />
    <!-- Fat segment -->
    <circle
      cx={SIZE/2} cy={SIZE/2} r={R - STROKE - 4}
      fill="none"
      stroke="var(--macro-fat)"
      stroke-width={STROKE - 2}
      stroke-dasharray={C * 0.9}
      stroke-dashoffset={arc(fatKcal, total)}
      stroke-linecap="round"
      transform="rotate({fatRotate} {SIZE/2} {SIZE/2})"
    />
    <!-- Carbs segment -->
    <circle
      cx={SIZE/2} cy={SIZE/2} r={R - STROKE - 4}
      fill="none"
      stroke="var(--macro-carbs)"
      stroke-width={STROKE - 2}
      stroke-dasharray={C * 0.9}
      stroke-dashoffset={arc(carbsKcal, total)}
      stroke-linecap="round"
      transform="rotate({carbsRotate} {SIZE/2} {SIZE/2})"
    />
    <!-- Protein segment -->
    <circle
      cx={SIZE/2} cy={SIZE/2} r={R - STROKE - 4}
      fill="none"
      stroke="var(--macro-protein)"
      stroke-width={STROKE - 2}
      stroke-dasharray={C * 0.9}
      stroke-dashoffset={arc(proteinKcal, total)}
      stroke-linecap="round"
      transform="rotate({proteinRotate} {SIZE/2} {SIZE/2})"
    />
  </svg>

  <!-- Centre text -->
  <div class="ring-center">
    <span class="ring-cals">{Math.round($aCals)}</span>
    <span class="ring-unit">kcal</span>
    {#if caloriesGoal}
      <span class="ring-goal">of {caloriesGoal}</span>
    {/if}
  </div>
</div>

<!-- Macro legend -->
<div class="macro-legend">
  <div class="macro-item">
    <span class="dot fat"></span>
    <span class="macro-val">{Math.round($aFat)}g</span>
    <span class="macro-lbl">Fat</span>
  </div>
  <div class="macro-item">
    <span class="dot carbs"></span>
    <span class="macro-val">{Math.round($aCarbs)}g</span>
    <span class="macro-lbl">Carbs</span>
  </div>
  <div class="macro-item">
    <span class="dot protein"></span>
    <span class="macro-val">{Math.round($aProtein)}g</span>
    <span class="macro-lbl">Protein</span>
  </div>
</div>

<style>
  .ring-wrap {
    position: relative;
    width: 200px;
    height: 200px;
    margin: 0 auto;
  }
  .ring-svg { display: block; overflow: visible; }
  .ring-center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
  }
  .ring-cals  { font-size: 36px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
  .ring-unit  { font-size: 12px; font-weight: 500; color: var(--text-2); }
  .ring-goal  { font-size: 11px; color: var(--text-3); }

  .macro-legend {
    display: flex;
    justify-content: center;
    gap: 20px;
    margin-top: 16px;
  }
  .macro-item {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-direction: column;
    text-align: center;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.fat     { background: var(--macro-fat); }
  .dot.carbs   { background: var(--macro-carbs); }
  .dot.protein { background: var(--macro-protein); }
  .macro-val   { font-size: 15px; font-weight: 600; }
  .macro-lbl   { font-size: 11px; color: var(--text-3); font-weight: 500; }
</style>
