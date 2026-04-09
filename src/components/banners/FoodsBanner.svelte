<script>
  import { onMount, onDestroy } from 'svelte';
  import { DB } from '../../lib/db.js';

  let noAnim = DB.getSetting('disableAnimations', false);
  let noLoop = !DB.getSetting('loopBannerAnimations', true);
  if (typeof window !== 'undefined') {
    window.addEventListener('wl:setting', () => {
      noAnim = DB.getSetting('disableAnimations', false);
      noLoop = !DB.getSetting('loopBannerAnimations', true);
    });
  }

  const ITEMS = [
    'Grilled Chicken',
    'Pasta Carbonara',
    'Caesar Salad',
    'Beef Tacos',
    'Avocado Toast',
    'Chicken Stir Fry',
    'Mushroom Risotto',
    'Açaí Bowl',
    'Salmon Teriyaki',
    'Greek Yogurt Parfait',
    'Pad Thai',
    'Caprese Panini',
    'Overnight Oats',
  ];

  let displayText = '';
  let itemIndex = 0;
  let charIndex = 0;
  let deleting = false;
  let timer;

  const TYPE_MS   = 75;
  const DEL_MS    = 38;
  const PAUSE_END = 1800;
  const PAUSE_GAP = 350;

  function tick() {
    const word = ITEMS[itemIndex];
    if (!deleting) {
      charIndex++;
      displayText = word.slice(0, charIndex);
      if (charIndex === word.length) {
        if (noLoop) return;
        timer = setTimeout(() => { deleting = true; tick(); }, PAUSE_END);
        return;
      }
      timer = setTimeout(tick, TYPE_MS);
    } else {
      charIndex--;
      displayText = word.slice(0, charIndex);
      if (charIndex === 0) {
        deleting = false;
        itemIndex = (itemIndex + 1) % ITEMS.length;
        timer = setTimeout(tick, PAUSE_GAP);
        return;
      }
      timer = setTimeout(tick, DEL_MS);
    }
  }

  onMount(() => {
    if (noAnim) { displayText = ITEMS[0]; return; }
    timer = setTimeout(tick, 500);
  });

  onDestroy(() => clearTimeout(timer));
</script>

<!--
  Each silhouette is its own sized SVG absolutely positioned within the banner.
  This prevents the clipping that happens when one large SVG uses slice scaling
  across very different screen aspect ratios (mobile portrait vs wide desktop).
-->
<div class="tw-banner" class:no-anim={noAnim} aria-hidden="true">

  <!-- Left silhouettes: fork + apple -->
  <div class="sil-group sil-left">
    <div class="sil-wrap sw1">
      <!-- Fork: single closed path, 3 tines -->
      <svg viewBox="0 0 16 68" fill="var(--accent)" aria-hidden="true">
        <path d="M6,68 L6,36 L2,28 L2,0 L4,0 L4,24 L7,24 L7,0
                 L9,0 L9,24 L12,24 L12,0 L14,0 L14,28 L10,36 L10,68 Z"/>
      </svg>
    </div>
    <div class="sil-wrap sw2">
      <!-- Apple: body with top cleft + stem + leaf -->
      <svg viewBox="0 0 44 62" fill="var(--accent)" aria-hidden="true">
        <rect x="19" y="0" width="3" height="14" rx="1.5" transform="rotate(8,20,7)"/>
        <path d="M22,8 C28,2 37,5 35,12 C30,14 23,12 22,8 Z"/>
        <path d="M22,16 C22,11 18,8 13,9 C7,10 3,18 3,29
                 C3,43 11,56 22,56 C33,56 41,43 41,29
                 C41,18 37,10 31,9 C26,8 22,11 22,16 Z"/>
      </svg>
    </div>
  </div>

  <!-- Centre text -->
  <div class="tw-inner">
    <div class="tw-decoration">
      <span class="tw-rule"></span>
      <span class="tw-diamond" class:no-anim={noAnim}>✦</span>
      <span class="tw-rule"></span>
    </div>
    <div class="tw-label">Today's Menu</div>
    <div class="tw-text">
      <span class="tw-typed" class:no-anim={noAnim}>{displayText}</span><span
        class="tw-cursor" class:no-anim={noAnim}>|</span>
    </div>
  </div>

  <!-- Right silhouettes: carrot + spoon -->
  <div class="sil-group sil-right">
    <div class="sil-wrap sw3">
      <!-- Carrot: tapered body + ridge lines + leafy tops -->
      <svg viewBox="0 0 30 74" fill="var(--accent)" aria-hidden="true">
        <path d="M15,72 C14,70 4,46 3,22 C3,14 7,9 15,9
                 C23,9 27,14 27,22 C26,46 16,70 15,72 Z"/>
        <path fill="none" stroke="white" stroke-opacity="0.4" stroke-width="1.8"
              d="M7,30 C10,28 20,28 23,30"/>
        <path fill="none" stroke="white" stroke-opacity="0.4" stroke-width="1.8"
              d="M6,42 C9,40 21,40 24,42"/>
        <path fill="none" stroke="white" stroke-opacity="0.4" stroke-width="1.8"
              d="M8,54 C11,52 19,52 22,54"/>
        <path d="M13,9 C11,5 8,0 10,0 C12,0 13,4 15,6
                 C17,4 18,0 20,0 C22,0 19,5 17,9 Z"/>
      </svg>
    </div>
    <div class="sil-wrap sw4">
      <!-- Spoon: wide oval bowl narrowing to a thin handle -->
      <svg viewBox="0 0 24 72" fill="var(--accent)" aria-hidden="true">
        <path d="M12,72 C10.5,72 10,71 10,68 L10,28
                 C7,25 2,20 2,12 C2,4 6,0 12,0
                 C18,0 22,4 22,12 C22,20 17,25 14,28
                 L14,68 C14,71 13.5,72 12,72 Z"/>
      </svg>
    </div>
  </div>

</div>

<style>
  .tw-banner {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    overflow: hidden;
  }

  /* ── Silhouette groups ───────────────────────────────────────────── */
  .sil-group {
    position: absolute;
    top: 0; bottom: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sil-left  { left:  8%; }
  .sil-right { right: 8%; }

  .sil-wrap {
    opacity: 0.22;
    height: 100%;
    display: flex;
    align-items: center;
  }
  /* Height is % of banner height (sil-group spans top:0 bottom:0 → 100% = banner height) */
  .sil-wrap svg {
    height: clamp(34px, 62%, 62px);
    width: auto;
    fill: var(--accent);
  }

  /* Float animations — each silhouette on its own phase/speed */
  .tw-banner:not(.no-anim) .sw1 { animation: sil-float 4.5s ease-in-out 0.1s  infinite; }
  .tw-banner:not(.no-anim) .sw2 { animation: sil-float 3.8s ease-in-out 0.8s  infinite; }
  .tw-banner:not(.no-anim) .sw3 { animation: sil-float 4.2s ease-in-out 0.45s infinite; }
  .tw-banner:not(.no-anim) .sw4 { animation: sil-float 5.0s ease-in-out 1.2s  infinite; }

  @keyframes sil-float {
    0%, 100% { transform: translateY(0);   }
    50%      { transform: translateY(-6px); }
  }

  /* ── Centre content ──────────────────────────────────────────────── */
  .tw-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    position: relative;
    z-index: 1;
  }

  .tw-decoration {
    display: flex;
    align-items: center;
    gap: 10px;
    opacity: 0.5;
  }
  .tw-rule {
    display: block;
    width: 48px;
    height: 1px;
    background: var(--accent);
  }
  .tw-banner:not(.no-anim) .tw-rule {
    animation: rule-breathe 3.5s ease-in-out infinite;
  }
  @keyframes rule-breathe {
    0%, 100% { width: 38px; opacity: 0.5; }
    50%      { width: 58px; opacity: 0.9; }
  }

  .tw-diamond {
    font-size: 10px;
    color: var(--accent);
    line-height: 1;
    display: inline-block;
  }
  .tw-banner:not(.no-anim) .tw-diamond:not(.no-anim) {
    animation: diamond-spin 7s linear infinite;
  }
  @keyframes diamond-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  .tw-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--accent);
    opacity: 0.6;
  }
  .tw-banner:not(.no-anim) .tw-label {
    animation: label-pulse 4s ease-in-out infinite;
  }
  @keyframes label-pulse {
    0%, 100% { opacity: 0.5; }
    50%      { opacity: 0.75; }
  }

  /* ── Typewriter text ─────────────────────────────────────────────── */
  .tw-text {
    font-size: 23px;
    font-weight: 700;
    letter-spacing: 0.01em;
    min-height: 1.4em;
    display: flex;
    align-items: center;
    filter: drop-shadow(0 0 8px color-mix(in srgb, var(--accent) 35%, transparent));
  }

  .tw-typed {
    background: linear-gradient(
      90deg,
      var(--accent) 0%,
      color-mix(in srgb, var(--accent) 65%, white) 50%,
      var(--accent) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .tw-banner:not(.no-anim) .tw-typed:not(.no-anim) {
    animation: shimmer 2.8s linear infinite;
  }
  .tw-typed.no-anim {
    background: none;
    -webkit-text-fill-color: var(--accent);
    color: var(--accent);
    opacity: 0.75;
  }
  @keyframes shimmer {
    0%   { background-position: 200% center; }
    100% { background-position:   0% center; }
  }

  .tw-cursor {
    display: inline-block;
    margin-left: 1px;
    color: var(--accent);
    -webkit-text-fill-color: var(--accent);
    font-weight: 200;
  }
  .tw-banner:not(.no-anim) .tw-cursor:not(.no-anim) {
    animation: blink 0.9s step-end infinite;
  }
  .tw-cursor.no-anim { opacity: 0; }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0; }
  }

  /* ── Reduced motion ──────────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    .sil-wrap,
    .tw-rule, .tw-diamond, .tw-label,
    .tw-typed, .tw-cursor { animation: none !important; }
    .tw-cursor { opacity: 0; }
    .tw-typed  { -webkit-text-fill-color: var(--accent); background: none; opacity: 0.75; }
    .tw-text   { filter: none; }
  }
</style>
