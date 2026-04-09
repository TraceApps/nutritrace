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
  Goals page banner — concentric target rings, trajectory arc, and milestone dots.
  Absolutely positioned behind the page-header content.
  All elements use var(--accent) at low opacity so it works with any theme.
-->
<svg
  class="goals-banner-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 500 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <!-- Glow centred on the target -->
    <radialGradient id="gb-glow" cx="72%" cy="50%" r="36%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.22" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
  </defs>

  <!-- Ambient glow -->
  <rect x="0" y="0" width="500" height="120" fill="url(#gb-glow)" />

  <!-- Concentric target rings — centred at (360, 60) -->
  <circle class="gb-ring gr5" cx="360" cy="60" r="52" fill="none" />
  <circle class="gb-ring gr4" cx="360" cy="60" r="40" fill="none" />
  <circle class="gb-ring gr3" cx="360" cy="60" r="28" fill="none" />
  <circle class="gb-ring gr2" cx="360" cy="60" r="16" fill="none" />
  <circle class="gb-ring gr1" cx="360" cy="60" r="6"  />

  <!-- Crosshair lines through target -->
  <line class="gb-crosshair" x1="360" y1="2"   x2="360" y2="118" />
  <line class="gb-crosshair" x1="302" y1="60"  x2="418" y2="60"  />

  <!-- Trajectory arc from lower-left to the target -->
  <path
    class="gb-arc"
    d="M 20,118 C 60,100 120,80 180,65 C 240,50 300,48 340,52"
    fill="none"
    stroke-dasharray="380"
    stroke-dashoffset="380"
  />

  <!-- Arrow head at arc end -->
  <path class="gb-arrow" d="M 340,52 L 352,44 L 348,56 Z" />

  <!-- Milestone dots along the trajectory -->
  <circle class="gb-milestone gm1" cx="70"  cy="107" r="4" />
  <circle class="gb-milestone gm2" cx="155" cy="74"  r="4" />
  <circle class="gb-milestone gm3" cx="250" cy="55"  r="4" />

  <!-- Star burst at target centre (layered lines) -->
  <g class="gb-starburst">
    <line x1="360" y1="52" x2="360" y2="68" />
    <line x1="352" y1="60" x2="368" y2="60" />
    <line x1="354" y1="54" x2="366" y2="66" />
    <line x1="366" y1="54" x2="354" y2="66" />
  </g>

  <!-- Floating ambient particles -->
  <circle class="gb-particle gp1" cx="60"  cy="40"  r="2"   />
  <circle class="gb-particle gp2" cx="200" cy="28"  r="1.5" />
  <circle class="gb-particle gp3" cx="290" cy="95"  r="1.8" />
  <circle class="gb-particle gp4" cx="450" cy="20"  r="1.5" />
  <circle class="gb-particle gp5" cx="480" cy="85"  r="2"   />
</svg>

<style>
  .goals-banner-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  /* ── Target rings ────────────────────────────────────────────────────────── */
  .gb-ring {
    stroke: var(--accent);
    stroke-width: 1.2;
    transform-box: fill-box;
    transform-origin: center;
    animation: gb-ring-pop 0.45s cubic-bezier(0.34, 1.3, 0.64, 1) both;
  }
  .gr5 { stroke-opacity: 0.08; animation-delay: 0.00s; }
  .gr4 { stroke-opacity: 0.12; animation-delay: 0.08s; }
  .gr3 { stroke-opacity: 0.18; animation-delay: 0.16s; }
  .gr2 { stroke-opacity: 0.25; animation-delay: 0.24s; }
  .gr1 { fill: var(--accent); opacity: 0.45; animation-delay: 0.32s; }

  @keyframes gb-ring-pop {
    from { transform: scale(0); opacity: 0; }
    to   { transform: scale(1); opacity: 1; }
  }

  /* ── Crosshair ───────────────────────────────────────────────────────────── */
  .gb-crosshair {
    stroke: var(--accent);
    stroke-opacity: 0.08;
    stroke-width: 0.8;
    stroke-dasharray: 4 4;
  }

  /* ── Trajectory arc ──────────────────────────────────────────────────────── */
  .gb-arc {
    stroke: var(--accent);
    stroke-opacity: 0.35;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-dasharray: 4 5;
    animation: gb-arc-draw 0.85s cubic-bezier(0.4, 0, 0.2, 1) 0.35s both;
  }
  @keyframes gb-arc-draw {
    to { stroke-dashoffset: 0; }
  }

  /* ── Arrow head ──────────────────────────────────────────────────────────── */
  .gb-arrow {
    fill: var(--accent);
    opacity: 0.45;
    animation: gb-arrow-appear 0.3s ease 1.1s both;
  }
  @keyframes gb-arrow-appear {
    from { opacity: 0; transform: scale(0.5); transform-origin: 346px 50px; }
    to   { opacity: 0.45; transform: scale(1); }
  }

  /* ── Milestone dots ──────────────────────────────────────────────────────── */
  .gb-milestone {
    fill: var(--accent);
    opacity: 0;
    transform-box: fill-box;
    transform-origin: center;
    animation: gb-milestone-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .gm1 { animation-delay: 0.50s; }
  .gm2 { animation-delay: 0.70s; }
  .gm3 { animation-delay: 0.90s; }

  @keyframes gb-milestone-pop {
    from { opacity: 0; transform: scale(0); }
    to   { opacity: 0.55; transform: scale(1); }
  }

  /* ── Star burst at target centre ─────────────────────────────────────────── */
  .gb-starburst {
    animation: gb-starburst-spin 6s linear infinite;
    transform-origin: 360px 60px;
  }
  .gb-starburst line {
    stroke: var(--accent);
    stroke-opacity: 0.40;
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  @keyframes gb-starburst-spin {
    from { transform: rotate(0deg);   }
    to   { transform: rotate(360deg); }
  }

  /* ── Ambient particles ───────────────────────────────────────────────────── */
  .gb-particle {
    fill: var(--accent);
    opacity: 0.10;
    animation: gb-float 3s ease-in-out infinite;
  }
  .gp1 { animation-delay: 0.0s;  animation-duration: 3.1s; }
  .gp2 { animation-delay: 0.8s;  animation-duration: 2.7s; }
  .gp3 { animation-delay: 1.5s;  animation-duration: 3.6s; }
  .gp4 { animation-delay: 0.3s;  animation-duration: 2.9s; }
  .gp5 { animation-delay: 2.0s;  animation-duration: 3.3s; }

  @keyframes gb-float {
    0%, 100% { transform: translateY(0);    opacity: 0.10; }
    50%       { transform: translateY(-5px); opacity: 0.20; }
  }

  /* ── No-loop: ambient animations play once then stop ────────────────────── */
  .goals-banner-svg.no-loop .gb-starburst,
  .goals-banner-svg.no-loop .gb-particle {
    animation-iteration-count: 1;
    animation-fill-mode: forwards;
  }

  /* ── Disable all animations ──────────────────────────────────────────────── */
  .goals-banner-svg.no-anim .gb-ring,
  .goals-banner-svg.no-anim .gb-milestone,
  .goals-banner-svg.no-anim .gb-arrow,
  .goals-banner-svg.no-anim .gb-particle {
    animation: none;
    opacity: 1;
    transform: none;
  }
  .goals-banner-svg.no-anim .gb-ring    { opacity: 1; }
  .goals-banner-svg.no-anim .gb-milestone { opacity: 0.55; }
  .goals-banner-svg.no-anim .gb-arrow   { opacity: 0.45; }
  .goals-banner-svg.no-anim .gb-particle { opacity: 0.10; }
  .goals-banner-svg.no-anim .gb-arc {
    animation: none;
    stroke-dashoffset: 0;
  }
  .goals-banner-svg.no-anim .gb-starburst {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .gb-ring, .gb-milestone, .gb-arrow, .gb-particle, .gb-starburst {
      animation: none !important;
      transform: none !important;
    }
    .gb-arc { animation: none !important; stroke-dashoffset: 0 !important; }
    .gb-milestone { opacity: 0.55 !important; }
    .gb-arrow { opacity: 0.45 !important; }
  }
</style>
