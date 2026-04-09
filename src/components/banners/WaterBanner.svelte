<script>
  import { DB } from '../../lib/db.js';

  let noAnim = DB.getSetting('disableAnimations', false);
  let noLoop = !DB.getSetting('loopBannerAnimations', true);
  if (typeof window !== 'undefined') {
    window.addEventListener('wl:setting', () => {
      noAnim = DB.getSetting('disableAnimations', false);
      noLoop = !DB.getSetting('loopBannerAnimations', true);
    });
  }
</script>

<!--
  Water page banner — flowing waves, water drops, and ripple rings.
  Absolutely positioned behind the page-header content.
  All elements use var(--accent) at low opacity so it works with any theme.
-->
<svg
  class="water-banner-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 500 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="wb-glow" cx="50%" cy="80%" r="55%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.22" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
  </defs>

  <!-- Ambient glow -->
  <rect x="0" y="0" width="500" height="120" fill="url(#wb-glow)" />

  <!-- Wave 1 — deepest, widest -->
  <path
    class="wb-wave wv1"
    d="M -60,90 C -20,75 20,105 60,90 C 100,75 140,105 180,90
       C 220,75 260,105 300,90 C 340,75 380,105 420,90
       C 460,75 500,105 560,90"
    fill="none"
  />

  <!-- Wave 2 — mid layer -->
  <path
    class="wb-wave wv2"
    d="M -60,72 C -10,58 30,88 80,72 C 130,56 170,86 220,72
       C 270,58 310,88 360,72 C 410,56 450,86 510,72"
    fill="none"
  />

  <!-- Wave 3 — top surface, most visible -->
  <path
    class="wb-wave wv3"
    d="M -60,52 C 0,36 40,66 100,52 C 160,38 200,68 260,52
       C 320,36 360,66 420,52 C 480,36 510,56 560,48"
    fill="none"
  />

  <!-- Ripple rings — concentric expanding circles -->
  <g class="wb-ripple-group rg1" transform="translate(100, 95)">
    <circle class="wb-ripple wr1" r="8"  fill="none" />
    <circle class="wb-ripple wr2" r="14" fill="none" />
    <circle class="wb-ripple wr3" r="20" fill="none" />
  </g>
  <g class="wb-ripple-group rg2" transform="translate(360, 88)">
    <circle class="wb-ripple wr1" r="6"  fill="none" />
    <circle class="wb-ripple wr2" r="11" fill="none" />
  </g>

  <!-- Water drops (teardrop shape) -->
  <path class="wb-drop wd1"
    d="M 200,30 C 200,30 192,42 192,48 C 192,54 196,58 200,58
       C 204,58 208,54 208,48 C 208,42 200,30 200,30 Z" />
  <path class="wb-drop wd2"
    d="M 430,18 C 430,18 424,28 424,33 C 424,38 427,41 430,41
       C 433,41 436,38 436,33 C 436,28 430,18 430,18 Z" />
  <path class="wb-drop wd3"
    d="M 55,25  C 55,25  50,33  50,37  C 50,41  52.5,43.5 55,43.5
       C 57.5,43.5 60,41 60,37 C 60,33 55,25 55,25 Z" />

  <!-- Rising bubbles -->
  <circle class="wb-bubble wb1" cx="155" cy="105" r="3"   />
  <circle class="wb-bubble wb2" cx="290" cy="110" r="2.5" />
  <circle class="wb-bubble wb3" cx="460" cy="108" r="2"   />
  <circle class="wb-bubble wb4" cx="75"  cy="112" r="1.8" />
  <circle class="wb-bubble wb5" cx="390" cy="106" r="2.2" />
</svg>

<style>
  .water-banner-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  /* ── Waves ───────────────────────────────────────────────────────────────── */
  .wb-wave {
    stroke: var(--accent);
    stroke-linecap: round;
    stroke-linejoin: round;
    animation: wb-wave-drift 4s ease-in-out infinite;
  }
  .wv1 {
    stroke-opacity: 0.08;
    stroke-width: 10;
    animation-duration: 5.0s;
    animation-delay: 0.0s;
  }
  .wv2 {
    stroke-opacity: 0.12;
    stroke-width: 6;
    animation-duration: 4.2s;
    animation-delay: 0.4s;
  }
  .wv3 {
    stroke-opacity: 0.20;
    stroke-width: 2.5;
    animation-duration: 3.5s;
    animation-delay: 0.8s;
  }

  @keyframes wb-wave-drift {
    0%   { transform: translateX(0);    }
    50%  { transform: translateX(30px); }
    100% { transform: translateX(0);    }
  }

  /* ── Ripples ─────────────────────────────────────────────────────────────── */
  .wb-ripple {
    stroke: var(--accent);
    stroke-width: 1;
    opacity: 0;
    transform-box: fill-box;
    transform-origin: center;
    animation: wb-ripple-expand 2.4s ease-out infinite;
  }
  .wr1 { animation-delay: 0.0s; }
  .wr2 { animation-delay: 0.6s; }
  .wr3 { animation-delay: 1.2s; }

  .rg1 { }
  .rg2 { animation-delay: 1.0s; }

  @keyframes wb-ripple-expand {
    0%   { transform: scale(0.5); opacity: 0.35; }
    100% { transform: scale(2.2); opacity: 0;    }
  }

  /* ── Drops ───────────────────────────────────────────────────────────────── */
  .wb-drop {
    fill: var(--accent);
    opacity: 0;
    transform-box: fill-box;
    transform-origin: top center;
    animation: wb-drop-fall 0.55s cubic-bezier(0.34, 1.2, 0.64, 1) both;
  }
  .wd1 { animation-delay: 0.20s; }
  .wd2 { animation-delay: 0.40s; }
  .wd3 { animation-delay: 0.10s; }

  @keyframes wb-drop-fall {
    from { opacity: 0; transform: translateY(-12px) scale(0.7); }
    to   { opacity: 0.35; transform: translateY(0) scale(1);    }
  }

  /* ── Bubbles ─────────────────────────────────────────────────────────────── */
  .wb-bubble {
    fill: var(--accent);
    opacity: 0.12;
    animation: wb-bubble-rise 3.5s ease-in infinite;
  }
  .wb1 { animation-delay: 0.0s;  animation-duration: 3.2s; }
  .wb2 { animation-delay: 0.9s;  animation-duration: 4.0s; }
  .wb3 { animation-delay: 1.7s;  animation-duration: 3.5s; }
  .wb4 { animation-delay: 0.4s;  animation-duration: 2.9s; }
  .wb5 { animation-delay: 2.2s;  animation-duration: 3.8s; }

  @keyframes wb-bubble-rise {
    0%   { transform: translateY(0);     opacity: 0.12; }
    80%  { transform: translateY(-55px); opacity: 0.20; }
    100% { transform: translateY(-65px); opacity: 0;    }
  }

  /* ── No-loop: ambient animations play once then stop ────────────────────── */
  .water-banner-svg.no-loop .wb-wave,
  .water-banner-svg.no-loop .wb-ripple,
  .water-banner-svg.no-loop .wb-bubble {
    animation-iteration-count: 1;
    animation-fill-mode: forwards;
  }

  /* ── Disable all animations ──────────────────────────────────────────────── */
  .water-banner-svg.no-anim .wb-wave    { animation: none; transform: none; }
  .water-banner-svg.no-anim .wb-ripple  { animation: none; opacity: 0.15; transform: none; }
  .water-banner-svg.no-anim .wb-drop    { animation: none; opacity: 0.35; transform: none; }
  .water-banner-svg.no-anim .wb-bubble  { animation: none; opacity: 0.12; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .wb-wave   { animation: none !important; transform: none !important; }
    .wb-ripple { animation: none !important; opacity: 0.15 !important; }
    .wb-drop   { animation: none !important; opacity: 0.35 !important; transform: none !important; }
    .wb-bubble { animation: none !important; opacity: 0.12 !important; transform: none !important; }
  }
</style>
