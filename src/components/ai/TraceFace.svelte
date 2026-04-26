<!--
  TraceFace — animated robot face SVG used everywhere Trace is represented
  visually (FAB, header avatar, welcome screen, message avatars, typing).

  Update this single file to change the look in all 4+ places at once.
  All animations are pure CSS keyframes (no JS), so multiple instances on
  screen don't add up to JS work.
-->
<script>
  export let size = 42; // pixels — used for both width/height
</script>

<svg class="trace-face" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" style="width:{size}px;height:{size}px">
  <!-- Antenna -->
  <line class="bot-antenna" x1="28" y1="10" x2="28" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <circle class="bot-antenna-dot" cx="28" cy="9" r="2" fill="currentColor"/>
  <!-- Head -->
  <rect class="bot-head" x="13" y="16" width="30" height="26" rx="9" fill="rgba(255,255,255,0.18)" stroke="currentColor" stroke-width="1.5"/>
  <!-- Cheek lights -->
  <circle class="bot-cheek bot-cheek-l" cx="16" cy="32" r="1.5" fill="currentColor" opacity="0.6"/>
  <circle class="bot-cheek bot-cheek-r" cx="40" cy="32" r="1.5" fill="currentColor" opacity="0.6"/>
  <!-- Eyes -->
  <g class="bot-eyes">
    <rect class="bot-eye bot-eye-l" x="20" y="24" width="5" height="6" rx="2" fill="currentColor"/>
    <rect class="bot-eye bot-eye-r" x="31" y="24" width="5" height="6" rx="2" fill="currentColor"/>
  </g>
  <!-- Mouth -->
  <path class="bot-mouth" d="M22 36 Q28 39 34 36" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>
</svg>

<style>
  .trace-face {
    color: currentColor;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
    flex-shrink: 0;
  }
  /* Eyes blink — quick close every 4-5s */
  .bot-eyes {
    transform-origin: 28px 27px;
    animation: bot-blink 4.6s ease-in-out infinite;
  }
  @keyframes bot-blink {
    0%, 92%, 100% { transform: scaleY(1); }
    94%, 96%       { transform: scaleY(0.1); }
  }
  /* Eyes also dart left/right occasionally */
  .bot-eye {
    animation: bot-eye-dart 7s ease-in-out infinite;
  }
  @keyframes bot-eye-dart {
    0%, 35%, 100% { transform: translateX(0); }
    40%, 55%       { transform: translateX(-1.2px); }
    60%, 75%       { transform: translateX(1.2px); }
    80%             { transform: translateX(0); }
  }
  /* Antenna dot pulses softly */
  .bot-antenna-dot {
    transform-origin: 28px 9px;
    animation: bot-antenna 1.8s ease-in-out infinite;
  }
  @keyframes bot-antenna {
    0%, 100% { transform: scale(1);   opacity: 0.7; }
    50%       { transform: scale(1.4); opacity: 1; }
  }
  /* Cheeks twinkle alternately */
  .bot-cheek-l { animation: bot-cheek 3s ease-in-out infinite; }
  .bot-cheek-r { animation: bot-cheek 3s ease-in-out infinite 1.5s; }
  @keyframes bot-cheek {
    0%, 100% { opacity: 0.4; }
    50%       { opacity: 1; }
  }
  /* Mouth idle smile (subtle bob) */
  .bot-mouth {
    transform-origin: 28px 37px;
    animation: bot-mouth 3.4s ease-in-out infinite;
  }
  @keyframes bot-mouth {
    0%, 100% { transform: scaleY(1); }
    50%       { transform: scaleY(1.25); }
  }
</style>
