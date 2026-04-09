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
  Diary page banner — open notebook/diary with ruled lines and a pen.
  Absolutely positioned behind the page-header content.
  All elements use var(--accent) at low opacity so it works with any theme.
-->
<svg
  class="diary-banner-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 500 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="dib-glow" cx="50%" cy="50%" r="42%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.18" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
    <linearGradient id="dib-page-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.13" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.04" />
    </linearGradient>
  </defs>

  <!-- Ambient glow -->
  <rect x="0" y="0" width="500" height="120" fill="url(#dib-glow)" />

  <!-- Open book — left page -->
  <rect class="dib-page" x="112" y="8" width="130" height="104" rx="4"
    fill="url(#dib-page-grad)" />
  <!-- Open book — right page -->
  <rect class="dib-page" x="258" y="8" width="130" height="104" rx="4"
    fill="url(#dib-page-grad)" />

  <!-- Spine / binding (two curves meeting at top and bottom) -->
  <path class="dib-spine"
    d="M 242,9  C 244,36 256,36 258,9
       M 242,111 C 244,84 256,84 258,111"
    fill="none" />
  <line class="dib-spine" x1="242" y1="9"   x2="242" y2="111" />
  <line class="dib-spine" x1="258" y1="9"   x2="258" y2="111" />

  <!-- Bookmark ribbon on right page -->
  <path class="dib-bookmark" d="M 368,8 L 380,8 L 380,34 L 374,28 L 368,34 Z" />

  <!-- Margin rule lines -->
  <line class="dib-margin" x1="136" y1="16" x2="136" y2="104" />
  <line class="dib-margin" x1="274" y1="16" x2="274" y2="104" />

  <!-- Ruled lines — left page -->
  <line class="dib-rule ll1" x1="122" y1="40" x2="230" y2="40" />
  <line class="dib-rule ll2" x1="122" y1="54" x2="230" y2="54" />
  <line class="dib-rule ll3" x1="122" y1="68" x2="230" y2="68" />
  <line class="dib-rule ll4" x1="122" y1="82" x2="230" y2="82" />
  <line class="dib-rule ll5" x1="122" y1="96" x2="196" y2="96" />

  <!-- Ruled lines — right page (last line shorter: writing in progress) -->
  <line class="dib-rule lr1" x1="282" y1="40" x2="376" y2="40" />
  <line class="dib-rule lr2" x1="282" y1="54" x2="376" y2="54" />
  <line class="dib-rule lr3" x1="282" y1="68" x2="376" y2="68" />
  <line class="dib-rule lr4" x1="282" y1="82" x2="345" y2="82" />

  <!-- Pen (diagonal, upper-right to lower-right page area) -->
  <g class="dib-pen">
    <rect class="dib-pen-eraser" x="412" y="5" width="11" height="8" rx="2" />
    <line class="dib-pen-body"   x1="416" y1="13" x2="346" y2="83" />
    <path class="dib-pen-tip"    d="M 346,83 L 339,94 L 351,89 Z" />
  </g>

  <!-- Floating ink particles near pen tip -->
  <g class="dib-particles">
    <circle class="dib-particle p1" cx="342" cy="80" r="2"   />
    <circle class="dib-particle p2" cx="328" cy="88" r="1.5" />
    <circle class="dib-particle p3" cx="351" cy="91" r="1.8" />
    <circle class="dib-particle p4" cx="334" cy="74" r="1.3" />
  </g>
</svg>

<style>
  .diary-banner-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  /* ── Pages ───────────────────────────────────────────────────────────────── */
  .dib-page {
    stroke: var(--accent);
    stroke-opacity: 0.2;
    stroke-width: 1;
    animation: dib-page-appear 0.4s ease both;
  }
  @keyframes dib-page-appear {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* ── Spine ───────────────────────────────────────────────────────────────── */
  .dib-spine {
    stroke: var(--accent);
    stroke-opacity: 0.28;
    stroke-width: 1.2;
  }

  /* ── Margin lines ────────────────────────────────────────────────────────── */
  .dib-margin {
    stroke: var(--accent);
    stroke-opacity: 0.12;
    stroke-width: 0.8;
    stroke-dasharray: 3 5;
  }

  /* ── Bookmark ────────────────────────────────────────────────────────────── */
  .dib-bookmark {
    fill: var(--accent);
    opacity: 0.28;
  }

  /* ── Ruled lines ─────────────────────────────────────────────────────────── */
  .dib-rule {
    stroke: var(--accent);
    stroke-opacity: 0.14;
    stroke-width: 0.9;
    stroke-dasharray: 110;
    stroke-dashoffset: 110;
    animation: dib-rule-draw 0.4s ease both;
  }
  .ll1 { animation-delay: 0.10s; }
  .ll2 { animation-delay: 0.18s; }
  .ll3 { animation-delay: 0.26s; }
  .ll4 { animation-delay: 0.34s; }
  .ll5 { animation-delay: 0.40s; }
  .lr1 { animation-delay: 0.14s; }
  .lr2 { animation-delay: 0.22s; }
  .lr3 { animation-delay: 0.30s; }
  .lr4 { animation-delay: 0.38s; }

  @keyframes dib-rule-draw {
    to { stroke-dashoffset: 0; }
  }

  /* ── Pen ─────────────────────────────────────────────────────────────────── */
  .dib-pen {
    animation: dib-pen-arrive 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) 0.48s both;
  }
  @keyframes dib-pen-arrive {
    from { transform: translate(28px, -28px); opacity: 0; }
    to   { transform: translate(0, 0);        opacity: 1; }
  }
  .dib-pen-body {
    stroke: var(--accent);
    stroke-opacity: 0.55;
    stroke-width: 3.5;
    stroke-linecap: round;
  }
  .dib-pen-tip {
    fill: var(--accent);
    opacity: 0.5;
  }
  .dib-pen-eraser {
    fill: var(--accent);
    opacity: 0.3;
  }

  /* ── Ink particles ───────────────────────────────────────────────────────── */
  .dib-particle {
    fill: var(--accent);
    opacity: 0.18;
    animation: dib-float 3s ease-in-out infinite;
  }
  .p1 { animation-delay: 0.0s;  animation-duration: 2.9s; }
  .p2 { animation-delay: 0.7s;  animation-duration: 3.4s; }
  .p3 { animation-delay: 1.3s;  animation-duration: 2.7s; }
  .p4 { animation-delay: 2.0s;  animation-duration: 3.2s; }

  @keyframes dib-float {
    0%, 100% { transform: translateY(0);    opacity: 0.18; }
    50%       { transform: translateY(-5px); opacity: 0.30; }
  }

  /* ── No-loop: particles play once then stop ─────────────────────────────── */
  .diary-banner-svg.no-loop .dib-particle {
    animation-iteration-count: 1;
    animation-fill-mode: forwards;
  }

  /* ── Disable all animations ──────────────────────────────────────────────── */
  .diary-banner-svg.no-anim .dib-page,
  .diary-banner-svg.no-anim .dib-pen,
  .diary-banner-svg.no-anim .dib-particle {
    animation: none;
    opacity: 1;
    transform: none;
  }
  .diary-banner-svg.no-anim .dib-rule {
    animation: none;
    stroke-dashoffset: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .dib-page, .dib-pen, .dib-particle { animation: none !important; }
    .dib-rule { animation: none !important; stroke-dashoffset: 0 !important; }
  }
</style>
