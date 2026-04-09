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
  Statistics page banner — animated chart illustration.
  Absolutely positioned behind the page-header content.
  All elements use var(--accent) at low opacity so it works with any theme.
-->
<svg
  class="stats-banner-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 500 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <!-- Soft radial glow centred on the tallest bar -->
    <radialGradient id="sb-glow" cx="68%" cy="18%" r="38%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.20" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
    <!-- Vertical gradient for bar fill: brighter top, fade to bottom -->
    <linearGradient id="sb-bar-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.26" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.06" />
    </linearGradient>
  </defs>

  <!-- Ambient glow -->
  <rect x="0" y="0" width="500" height="120" fill="url(#sb-glow)" />

  <!-- Horizontal grid lines -->
  <g class="sb-grid">
    <line x1="0" y1="30" x2="500" y2="30" />
    <line x1="0" y1="60" x2="500" y2="60" />
    <line x1="0" y1="90" x2="500" y2="90" />
  </g>

  <!-- Bars — 8 bars trending upward, floor at y=120 -->
  <!-- Bar centre-x values: 32 94 156 218 280 342 404 466 -->
  <g class="sb-bars">
    <rect class="sb-bar b1" x="8"   y="92" width="48" height="28"  rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar b2" x="70"  y="67" width="48" height="53"  rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar b3" x="132" y="80" width="48" height="40"  rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar b4" x="194" y="42" width="48" height="78"  rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar b5" x="256" y="57" width="48" height="63"  rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar b6" x="318" y="22" width="48" height="98"  rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar b7" x="380" y="37" width="48" height="83"  rx="3" fill="url(#sb-bar-grad)" />
    <rect class="sb-bar b8" x="442" y="50" width="48" height="70"  rx="3" fill="url(#sb-bar-grad)" />
  </g>

  <!-- Trend line — smooth cubic bezier through bar tops -->
  <path
    class="sb-line"
    d="M 32,92 C 55,85 75,72 94,67
       C 114,62 136,84 156,80
       C 176,76 199,49 218,42
       C 237,35 261,62 280,57
       C 299,52 322,28 342,22
       C 362,16 385,41 404,37
       C 424,33 450,54 466,50"
    fill="none"
  />

  <!-- Data points at bar tops -->
  <g class="sb-dots">
    <circle class="sb-dot d1" cx="32"  cy="92" r="4" />
    <circle class="sb-dot d2" cx="94"  cy="67" r="4" />
    <circle class="sb-dot d3" cx="156" cy="80" r="4" />
    <circle class="sb-dot d4" cx="218" cy="42" r="4" />
    <circle class="sb-dot d5" cx="280" cy="57" r="4" />
    <circle class="sb-dot d6" cx="342" cy="22" r="4" />
    <circle class="sb-dot d7" cx="404" cy="37" r="4" />
    <circle class="sb-dot d8" cx="466" cy="50" r="4" />
  </g>

  <!-- Floating ambient particles -->
  <g class="sb-particles">
    <circle class="sb-particle p1" cx="85"  cy="28"  r="2"   />
    <circle class="sb-particle p2" cx="200" cy="48"  r="1.5" />
    <circle class="sb-particle p3" cx="430" cy="15"  r="2"   />
    <circle class="sb-particle p4" cx="355" cy="68"  r="1.5" />
    <circle class="sb-particle p5" cx="150" cy="26"  r="1.8" />
  </g>
</svg>

<style>
  .stats-banner-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  /* ── Grid ────────────────────────────────────────────────────────────── */
  .sb-grid line {
    stroke: var(--accent);
    stroke-width: 0.5;
    opacity: 0.07;
  }

  /* ── Bars ────────────────────────────────────────────────────────────── */
  .sb-bar {
    transform-box: fill-box;
    transform-origin: bottom;
    animation: sb-bar-rise 0.55s cubic-bezier(0.34, 1.2, 0.64, 1) both;
  }
  .b1 { animation-delay: 0.00s; }
  .b2 { animation-delay: 0.06s; }
  .b3 { animation-delay: 0.12s; }
  .b4 { animation-delay: 0.18s; }
  .b5 { animation-delay: 0.24s; }
  .b6 { animation-delay: 0.30s; }
  .b7 { animation-delay: 0.36s; }
  .b8 { animation-delay: 0.42s; }

  @keyframes sb-bar-rise {
    from { transform: scaleY(0); }
    to   { transform: scaleY(1); }
  }

  /* ── Trend line ──────────────────────────────────────────────────────── */
  .sb-line {
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.5;
    stroke-dasharray: 1400;
    stroke-dashoffset: 1400;
    animation: sb-line-draw 0.9s cubic-bezier(0.4, 0, 0.2, 1) 0.45s both;
  }
  @keyframes sb-line-draw {
    to { stroke-dashoffset: 0; }
  }

  /* ── Data points ─────────────────────────────────────────────────────── */
  .sb-dot {
    fill: var(--accent);
    opacity: 0.65;
    transform-box: fill-box;
    transform-origin: center;
    animation: sb-dot-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .d1 { animation-delay: 0.82s; }
  .d2 { animation-delay: 0.92s; }
  .d3 { animation-delay: 1.00s; }
  .d4 { animation-delay: 1.09s; }
  .d5 { animation-delay: 1.17s; }
  .d6 { animation-delay: 1.25s; }
  .d7 { animation-delay: 1.33s; }
  .d8 { animation-delay: 1.41s; }

  @keyframes sb-dot-pop {
    from { transform: scale(0); }
    to   { transform: scale(1); }
  }

  /* ── Floating particles ──────────────────────────────────────────────── */
  .sb-particle {
    fill: var(--accent);
    opacity: 0.1;
    animation: sb-float 3s ease-in-out infinite;
  }
  .p1 { animation-delay: 0.0s;  animation-duration: 3.2s; }
  .p2 { animation-delay: 0.7s;  animation-duration: 2.8s; }
  .p3 { animation-delay: 1.4s;  animation-duration: 3.5s; }
  .p4 { animation-delay: 0.3s;  animation-duration: 4.0s; }
  .p5 { animation-delay: 2.0s;  animation-duration: 2.6s; }

  @keyframes sb-float {
    0%, 100% { transform: translateY(0px);  }
    50%       { transform: translateY(-5px); }
  }

  /* ── No-loop: particles play once then stop ──────────────────────────── */
  .stats-banner-svg.no-loop .sb-particle {
    animation-iteration-count: 1;
    animation-fill-mode: forwards;
  }

  /* ── Disable all animations (app setting + system preference) ────────── */
  .stats-banner-svg.no-anim .sb-bar,
  .stats-banner-svg.no-anim .sb-line,
  .stats-banner-svg.no-anim .sb-dot,
  .stats-banner-svg.no-anim .sb-particle {
    animation: none;
    stroke-dashoffset: 0;
    transform: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .sb-bar, .sb-line, .sb-dot, .sb-particle {
      animation: none !important;
      stroke-dashoffset: 0 !important;
    }
  }
</style>
