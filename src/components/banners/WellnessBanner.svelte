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
  Wellness banner — EKG trace drawing left→right across the middle,
  grass blowing in wind along the bottom, crescent moon + Zzz's + stars.
-->
<svg
  class="wbn-svg"
  class:no-anim={noAnim}
  class:no-loop={noLoop}
  viewBox="0 0 500 120"
  preserveAspectRatio="xMidYMid slice"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
>
  <defs>
    <radialGradient id="wbn-gl" cx="22%" cy="92%" r="55%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.22" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
    <radialGradient id="wbn-gr" cx="82%" cy="40%" r="42%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="var(--accent)" stop-opacity="0.14" />
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"    />
    </radialGradient>
    <mask id="wbn-moon-mask">
      <rect width="500" height="120" fill="white"/>
      <circle cx="392" cy="52" r="11" fill="black"/>
    </mask>
  </defs>

  <rect width="500" height="120" fill="url(#wbn-gl)" />
  <rect width="500" height="120" fill="url(#wbn-gr)" />

  <!-- EKG trace — 3 heartbeat cycles drawing left→right, middle-left of banner -->
  <path class="wbn-ekg"
    d="M 20,60
       H 38
       Q 41,60 44,53 Q 47,60 50,60
       H 59
       L 61,63 L 64,26 L 67,75 L 70,60
       H 82
       Q 86,60 92,50 Q 98,60 102,60
       H 122
       H 138
       Q 141,60 144,53 Q 147,60 150,60
       H 159
       L 161,63 L 164,26 L 167,75 L 170,60
       H 182
       Q 186,60 192,50 Q 198,60 202,60
       H 222
       H 238
       Q 241,60 244,53 Q 247,60 250,60
       H 259
       L 261,63 L 264,26 L 267,75 L 270,60
       H 282
       Q 286,60 292,50 Q 298,60 302,60
       H 325"
    stroke="var(--accent)" stroke-width="1.8"
    fill="none" stroke-linecap="round" stroke-linejoin="round"
  />

  <!-- Grass — 12 clusters spanning bottom-left to just before the moon -->
  <!-- Each cluster: 3 blades, heights vary, sway independently -->
  <g class="wbn-grass gg1"  transform="translate(22,108)">
    <path class="b1" d="M0,0 C-1,-7 -1,-14 0.5,-20"  stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C2,-9 1,-17 2.5,-25"    stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-6 5.5,-12 4,-17"    stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg2"  transform="translate(48,108)">
    <path class="b1" d="M0,0 C0,-8 -1,-15 1,-21"     stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M3,0 C3,-7 2,-14 3,-19"      stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-5 6,-10 4.5,-15"    stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg3"  transform="translate(76,108)">
    <path class="b1" d="M0,0 C-1,-9 -1,-17 0,-23"    stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C2,-7 1,-14 2,-20"      stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-6 6,-13 4,-18"      stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg4"  transform="translate(102,108)">
    <path class="b1" d="M0,0 C-1,-7 -2,-14 -0.5,-19" stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C3,-9 2,-17 3,-24"      stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-6 5,-11 3.5,-16"    stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg5"  transform="translate(132,108)">
    <path class="b1" d="M0,0 C0,-8 0,-16 1,-22"      stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C2,-9 1,-17 2.5,-23"    stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-5 6,-10 4,-14"      stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg6"  transform="translate(162,108)">
    <path class="b1" d="M0,0 C-1,-8 -1,-15 0.5,-21"  stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C3,-10 2,-19 2.5,-26"   stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-7 6,-13 4.5,-18"    stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg7"  transform="translate(192,108)">
    <path class="b1" d="M0,0 C0,-7 0,-13 1,-18"      stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C3,-8 2,-15 3,-21"      stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M4,0 C5,-5 5,-11 3.5,-15"    stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg8"  transform="translate(222,108)">
    <path class="b1" d="M0,0 C-1,-9 -1,-17 0,-23"    stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C2,-8 1,-15 2,-21"      stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-6 6,-12 4,-17"      stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg9"  transform="translate(252,108)">
    <path class="b1" d="M0,0 C-1,-7 -2,-13 -0.5,-18" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C3,-9 2,-16 2.5,-22"    stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-5 5,-10 3,-14"      stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg10" transform="translate(282,108)">
    <path class="b1" d="M0,0 C0,-8 0,-16 1,-22"      stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C2,-9 1,-17 2,-23"      stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M5,0 C5,-7 6,-13 4,-18"      stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg11" transform="translate(310,108)">
    <path class="b1" d="M0,0 C-1,-8 -1,-15 0.5,-20"  stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C3,-8 2,-15 3,-21"      stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M4,0 C5,-5 5,-11 3.5,-16"    stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>
  <g class="wbn-grass gg12" transform="translate(336,108)">
    <path class="b1" d="M0,0 C-1,-7 -2,-13 -0.5,-18" stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    <path class="b2" d="M2,0 C2,-8 1,-14 1.5,-19"    stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    <path class="b3" d="M4,0 C4,-5 4,-10 3,-14"      stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round" fill="none"/>
  </g>

  <!-- Crescent moon -->
  <g class="wbn-moon">
    <circle cx="386" cy="56" r="13" fill="var(--accent)" mask="url(#wbn-moon-mask)" />
  </g>

  <!-- Zzz's -->
  <text class="wbn-z wz1" x="418" y="92"
    font-family="system-ui,-apple-system,sans-serif"
    font-size="22" font-weight="800"
    fill="var(--accent)" text-anchor="middle">Z</text>
  <text class="wbn-z wz2" x="437" y="72"
    font-family="system-ui,-apple-system,sans-serif"
    font-size="16" font-weight="800"
    fill="var(--accent)" text-anchor="middle">Z</text>
  <text class="wbn-z wz3" x="452" y="56"
    font-family="system-ui,-apple-system,sans-serif"
    font-size="12" font-weight="800"
    fill="var(--accent)" text-anchor="middle">Z</text>

  <!-- Stars -->
  <circle class="wbn-star ws1" cx="68"  cy="26" r="1.6" fill="var(--accent)" />
  <circle class="wbn-star ws2" cx="158" cy="16" r="1.3" fill="var(--accent)" />
  <circle class="wbn-star ws3" cx="250" cy="30" r="1.8" fill="var(--accent)" />
  <circle class="wbn-star ws4" cx="345" cy="20" r="1.4" fill="var(--accent)" />
  <circle class="wbn-star ws5" cx="468" cy="24" r="1.7" fill="var(--accent)" />
  <circle class="wbn-star ws6" cx="488" cy="68" r="1.2" fill="var(--accent)" />
</svg>

<style>
  .wbn-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  /* ── EKG trace ───────────────────────────────────────────────────────────── */
  .wbn-ekg {
    stroke-dasharray: 480;
    stroke-dashoffset: 480;
    opacity: 0;
    animation: wbn-ekg-draw 5.5s ease-in 0.4s infinite;
  }
  @keyframes wbn-ekg-draw {
    0%   { stroke-dashoffset: 480; opacity: 0;    }
    4%   { opacity: 0.6;                          }
    65%  { stroke-dashoffset: 0;   opacity: 0.6;  }
    80%  { stroke-dashoffset: 0;   opacity: 0;    }
    100% { stroke-dashoffset: 480; opacity: 0;    }
  }

  /* ── Grass ───────────────────────────────────────────────────────────────── */
  .wbn-grass {
    opacity: 0;
    animation: wbn-grass-in 0.7s ease forwards;
  }
  /* Stagger fade-in across the field */
  .gg1  { animation-delay: 0.10s; } .gg2  { animation-delay: 0.16s; }
  .gg3  { animation-delay: 0.22s; } .gg4  { animation-delay: 0.28s; }
  .gg5  { animation-delay: 0.34s; } .gg6  { animation-delay: 0.40s; }
  .gg7  { animation-delay: 0.46s; } .gg8  { animation-delay: 0.52s; }
  .gg9  { animation-delay: 0.58s; } .gg10 { animation-delay: 0.64s; }
  .gg11 { animation-delay: 0.70s; } .gg12 { animation-delay: 0.76s; }

  @keyframes wbn-grass-in { to { opacity: 1; } }

  /* Blade sway — wind from left, so blades lean and return rightward */
  .wbn-grass path {
    transform-box: fill-box;
    transform-origin: bottom center;
  }
  .wbn-grass .b1 { opacity: 0.50; animation: wbn-sway 2.3s ease-in-out infinite; }
  .wbn-grass .b2 { opacity: 0.60; animation: wbn-sway 2.7s ease-in-out infinite; }
  .wbn-grass .b3 { opacity: 0.42; animation: wbn-sway 2.0s ease-in-out infinite; }

  /* Vary sway phase per cluster so the field feels like natural wind, not a metronome */
  .gg1  .b1 { animation-delay: 0.0s;  } .gg1  .b2 { animation-delay: 0.5s;  } .gg1  .b3 { animation-delay: 1.0s;  }
  .gg2  .b1 { animation-delay: 0.3s;  } .gg2  .b2 { animation-delay: 0.8s;  } .gg2  .b3 { animation-delay: 1.3s;  }
  .gg3  .b1 { animation-delay: 0.6s;  } .gg3  .b2 { animation-delay: 1.1s;  } .gg3  .b3 { animation-delay: 0.2s;  }
  .gg4  .b1 { animation-delay: 0.9s;  } .gg4  .b2 { animation-delay: 0.4s;  } .gg4  .b3 { animation-delay: 1.5s;  }
  .gg5  .b1 { animation-delay: 1.2s;  } .gg5  .b2 { animation-delay: 0.7s;  } .gg5  .b3 { animation-delay: 0.1s;  }
  .gg6  .b1 { animation-delay: 0.4s;  } .gg6  .b2 { animation-delay: 1.0s;  } .gg6  .b3 { animation-delay: 1.7s;  }
  .gg7  .b1 { animation-delay: 0.7s;  } .gg7  .b2 { animation-delay: 0.2s;  } .gg7  .b3 { animation-delay: 1.4s;  }
  .gg8  .b1 { animation-delay: 1.0s;  } .gg8  .b2 { animation-delay: 1.6s;  } .gg8  .b3 { animation-delay: 0.3s;  }
  .gg9  .b1 { animation-delay: 0.2s;  } .gg9  .b2 { animation-delay: 0.9s;  } .gg9  .b3 { animation-delay: 1.6s;  }
  .gg10 .b1 { animation-delay: 0.5s;  } .gg10 .b2 { animation-delay: 1.3s;  } .gg10 .b3 { animation-delay: 0.6s;  }
  .gg11 .b1 { animation-delay: 0.8s;  } .gg11 .b2 { animation-delay: 0.3s;  } .gg11 .b3 { animation-delay: 1.1s;  }
  .gg12 .b1 { animation-delay: 1.1s;  } .gg12 .b2 { animation-delay: 0.6s;  } .gg12 .b3 { animation-delay: 0.0s;  }

  @keyframes wbn-sway {
    0%   { transform: rotate(-4deg); }
    45%  { transform: rotate(11deg); }
    65%  { transform: rotate(9deg);  }
    100% { transform: rotate(-4deg); }
  }

  /* ── Moon ────────────────────────────────────────────────────────────────── */
  .wbn-moon {
    opacity: 0;
    animation: wbn-moon-in 0.8s ease 1.0s forwards;
  }
  @keyframes wbn-moon-in { to { opacity: 0.55; } }

  /* ── Zzz's ───────────────────────────────────────────────────────────────── */
  .wbn-z {
    opacity: 0;
    animation: wbn-z-rise 2.4s ease-in-out infinite;
  }
  .wz1 { animation-delay: 0.30s; animation-duration: 2.5s; }
  .wz2 { animation-delay: 0.95s; animation-duration: 2.2s; }
  .wz3 { animation-delay: 1.55s; animation-duration: 1.9s; }

  @keyframes wbn-z-rise {
    0%   { opacity: 0;    transform: translateY(0);     }
    18%  { opacity: 0.72;                               }
    75%  { opacity: 0.42;                               }
    100% { opacity: 0;    transform: translateY(-28px); }
  }

  /* ── Stars ───────────────────────────────────────────────────────────────── */
  .wbn-star {
    opacity: 0.10;
    animation: wbn-star-twinkle 3s ease-in-out infinite;
  }
  .ws1 { animation-delay: 0.0s;  animation-duration: 2.8s; }
  .ws2 { animation-delay: 0.7s;  animation-duration: 3.3s; }
  .ws3 { animation-delay: 1.4s;  animation-duration: 2.6s; }
  .ws4 { animation-delay: 0.4s;  animation-duration: 3.1s; }
  .ws5 { animation-delay: 1.8s;  animation-duration: 2.9s; }
  .ws6 { animation-delay: 2.4s;  animation-duration: 3.5s; }

  @keyframes wbn-star-twinkle {
    0%, 100% { opacity: 0.10; transform: scale(1);   }
    50%       { opacity: 0.35; transform: scale(1.4); }
  }

  /* ── No-loop ─────────────────────────────────────────────────────────────── */
  .wbn-svg.no-loop .wbn-ekg  { animation-iteration-count: 1; animation-fill-mode: forwards; }
  .wbn-svg.no-loop .wbn-z    { animation-iteration-count: 1; animation-fill-mode: forwards; }
  .wbn-svg.no-loop .wbn-star { animation-iteration-count: 1; animation-fill-mode: forwards; }
  .wbn-svg.no-loop .wbn-grass .b1,
  .wbn-svg.no-loop .wbn-grass .b2,
  .wbn-svg.no-loop .wbn-grass .b3 { animation-iteration-count: 1; animation-fill-mode: forwards; }

  /* ── No-anim ─────────────────────────────────────────────────────────────── */
  .wbn-svg.no-anim .wbn-ekg  { animation: none; stroke-dashoffset: 0; opacity: 0.5; }
  .wbn-svg.no-anim .wbn-grass { animation: none; opacity: 1; }
  .wbn-svg.no-anim .wbn-grass .b1,
  .wbn-svg.no-anim .wbn-grass .b2,
  .wbn-svg.no-anim .wbn-grass .b3 { animation: none; transform: rotate(4deg); }
  .wbn-svg.no-anim .wbn-moon { animation: none; opacity: 0.55; }
  .wbn-svg.no-anim .wbn-z    { animation: none; opacity: 0.55; transform: translateY(-14px); }
  .wbn-svg.no-anim .wbn-star { animation: none; opacity: 0.22; }

  @media (prefers-reduced-motion: reduce) {
    .wbn-ekg  { animation: none !important; stroke-dashoffset: 0 !important; opacity: 0.5 !important; }
    .wbn-grass { animation: none !important; opacity: 1 !important; }
    .wbn-grass .b1, .wbn-grass .b2, .wbn-grass .b3 { animation: none !important; transform: rotate(4deg) !important; }
    .wbn-moon  { animation: none !important; opacity: 0.55 !important; }
    .wbn-z     { animation: none !important; opacity: 0.55 !important; transform: translateY(-14px) !important; }
    .wbn-star  { animation: none !important; opacity: 0.22 !important; }
  }
</style>
