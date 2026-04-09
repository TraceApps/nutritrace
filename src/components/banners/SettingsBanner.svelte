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
  Settings page banner — horizontal sliders, toggle switches, and a rotating gear.
  Absolutely positioned behind the page-header content.
  All elements use var(--accent) at low opacity so it works with any theme.
-->
<svg
  class="settings-banner-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 500 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="stb-glow" cx="80%" cy="50%" r="38%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.20" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
  </defs>

  <!-- Ambient glow -->
  <rect x="0" y="0" width="500" height="120" fill="url(#stb-glow)" />

  <!-- ── Slider tracks (3 rows) ── -->
  <!-- Slider 1 — track + filled portion + knob -->
  <rect class="stb-track" x="60"  y="30" width="200" height="4"  rx="2" />
  <rect class="stb-fill  sf1"   x="60"  y="30" width="130" height="4"  rx="2" />
  <circle class="stb-knob sk1"  cx="190" cy="32" r="8" />
  <text class="stb-label" x="48" y="35">—</text>

  <!-- Slider 2 -->
  <rect class="stb-track" x="60"  y="58" width="200" height="4"  rx="2" />
  <rect class="stb-fill  sf2"   x="60"  y="58" width="80"  height="4"  rx="2" />
  <circle class="stb-knob sk2"  cx="140" cy="60" r="8" />

  <!-- Slider 3 -->
  <rect class="stb-track" x="60"  y="86" width="200" height="4"  rx="2" />
  <rect class="stb-fill  sf3"   x="60"  y="86" width="160" height="4"  rx="2" />
  <circle class="stb-knob sk3"  cx="220" cy="88" r="8" />

  <!-- ── Toggle switches (2 rows) ── -->
  <!-- Toggle 1 — ON state (knob right) -->
  <rect class="stb-toggle-track tt-on"  x="320" y="24" width="44" height="22" rx="11" />
  <circle class="stb-toggle-knob tk-on stk1" cx="353" cy="35" r="9" />

  <!-- Toggle 2 — OFF state (knob left) -->
  <rect class="stb-toggle-track tt-off" x="320" y="58" width="44" height="22" rx="11" />
  <circle class="stb-toggle-knob tk-off stk2" cx="331" cy="69" r="9" />

  <!-- Toggle 3 — ON state -->
  <rect class="stb-toggle-track tt-on"  x="320" y="92" width="44" height="22" rx="11" />
  <circle class="stb-toggle-knob tk-on stk3" cx="353" cy="103" r="9" />

  <!-- ── Gear / cog — right side ── -->
  <!-- Outer teeth (8 rectangles rotated around centre 440,60) -->
  <g class="stb-gear" transform="translate(440,60)">
    <!-- Gear body -->
    <circle r="22" fill="none" stroke-width="3" />
    <circle r="10" fill="none" stroke-width="2" />
    <!-- Teeth (8 rects, each rotated 45°) -->
    <rect x="-5" y="-28" width="10" height="10" rx="2" />
    <rect x="-5" y="-28" width="10" height="10" rx="2" transform="rotate(45)"  />
    <rect x="-5" y="-28" width="10" height="10" rx="2" transform="rotate(90)"  />
    <rect x="-5" y="-28" width="10" height="10" rx="2" transform="rotate(135)" />
    <rect x="-5" y="-28" width="10" height="10" rx="2" transform="rotate(180)" />
    <rect x="-5" y="-28" width="10" height="10" rx="2" transform="rotate(225)" />
    <rect x="-5" y="-28" width="10" height="10" rx="2" transform="rotate(270)" />
    <rect x="-5" y="-28" width="10" height="10" rx="2" transform="rotate(315)" />
  </g>

  <!-- Floating particles -->
  <circle class="stb-particle sp1" cx="30"  cy="55"  r="2"   />
  <circle class="stb-particle sp2" cx="280" cy="20"  r="1.5" />
  <circle class="stb-particle sp3" cx="290" cy="100" r="1.8" />
  <circle class="stb-particle sp4" cx="490" cy="30"  r="1.5" />
</svg>

<style>
  .settings-banner-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  /* ── Slider tracks ───────────────────────────────────────────────────────── */
  .stb-track {
    fill: var(--accent);
    opacity: 0.10;
  }
  .stb-fill {
    fill: var(--accent);
    opacity: 0.28;
    transform-box: fill-box;
    transform-origin: left;
    animation: stb-fill-grow 0.5s cubic-bezier(0.34, 1.1, 0.64, 1) both;
  }
  .sf1 { animation-delay: 0.10s; }
  .sf2 { animation-delay: 0.22s; }
  .sf3 { animation-delay: 0.34s; }

  @keyframes stb-fill-grow {
    from { transform: scaleX(0); }
    to   { transform: scaleX(1); }
  }

  .stb-knob {
    fill: var(--accent);
    opacity: 0.55;
    transform-box: fill-box;
    transform-origin: center;
    animation: stb-knob-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .sk1 { animation-delay: 0.15s; }
  .sk2 { animation-delay: 0.27s; }
  .sk3 { animation-delay: 0.39s; }

  @keyframes stb-knob-pop {
    from { transform: scale(0); opacity: 0; }
    to   { transform: scale(1); opacity: 0.55; }
  }

  /* ── Toggle switches ─────────────────────────────────────────────────────── */
  .stb-toggle-track {
    stroke: var(--accent);
    stroke-width: 1;
    animation: stb-toggle-appear 0.35s ease both;
  }
  .tt-on  { fill: var(--accent); opacity: 0.22; stroke-opacity: 0.30; }
  .tt-off { fill: var(--accent); opacity: 0.07; stroke-opacity: 0.20; }

  @keyframes stb-toggle-appear {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .stb-toggle-knob {
    transform-box: fill-box;
    transform-origin: center;
    animation: stb-knob-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .tk-on  { fill: var(--accent); opacity: 0.65; }
  .tk-off { fill: var(--accent); opacity: 0.30; }
  .stk1 { animation-delay: 0.08s; }
  .stk2 { animation-delay: 0.16s; }
  .stk3 { animation-delay: 0.24s; }

  /* ── Gear ────────────────────────────────────────────────────────────────── */
  .stb-gear {
    stroke: var(--accent);
    stroke-opacity: 0.18;
    fill: var(--accent);
    opacity: 0.08;
    animation: stb-gear-spin 12s linear infinite;
    transform-origin: 0px 0px; /* already translated to 440,60 */
  }
  .stb-gear circle { fill: none; }

  @keyframes stb-gear-spin {
    from { transform: rotate(0deg);   }
    to   { transform: rotate(360deg); }
  }

  /* ── Particles ───────────────────────────────────────────────────────────── */
  .stb-particle {
    fill: var(--accent);
    opacity: 0.10;
    animation: stb-float 3s ease-in-out infinite;
  }
  .sp1 { animation-delay: 0.0s;  animation-duration: 3.0s; }
  .sp2 { animation-delay: 0.7s;  animation-duration: 2.8s; }
  .sp3 { animation-delay: 1.4s;  animation-duration: 3.4s; }
  .sp4 { animation-delay: 0.3s;  animation-duration: 2.6s; }

  @keyframes stb-float {
    0%, 100% { transform: translateY(0);    opacity: 0.10; }
    50%       { transform: translateY(-5px); opacity: 0.20; }
  }

  /* ── No-loop: ambient animations play once then stop ────────────────────── */
  .settings-banner-svg.no-loop .stb-gear,
  .settings-banner-svg.no-loop .stb-particle {
    animation-iteration-count: 1;
    animation-fill-mode: forwards;
  }

  /* ── Disable all animations ──────────────────────────────────────────────── */
  .settings-banner-svg.no-anim .stb-fill,
  .settings-banner-svg.no-anim .stb-knob,
  .settings-banner-svg.no-anim .stb-toggle-track,
  .settings-banner-svg.no-anim .stb-toggle-knob,
  .settings-banner-svg.no-anim .stb-gear,
  .settings-banner-svg.no-anim .stb-particle {
    animation: none;
    transform: none;
  }
  .settings-banner-svg.no-anim .stb-fill         { opacity: 0.28; }
  .settings-banner-svg.no-anim .stb-knob         { opacity: 0.55; }
  .settings-banner-svg.no-anim .stb-toggle-track { opacity: 1; }
  .settings-banner-svg.no-anim .stb-toggle-knob  { opacity: 1; }
  .settings-banner-svg.no-anim .stb-particle     { opacity: 0.10; }
  @media (prefers-reduced-motion: reduce) {
    .stb-fill, .stb-knob, .stb-toggle-track, .stb-toggle-knob, .stb-gear, .stb-particle {
      animation: none !important;
      transform: none !important;
    }
  }
</style>
