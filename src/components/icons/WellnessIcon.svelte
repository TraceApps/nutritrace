<!--
  Custom nav icon: running figure with ECG/vital-signs waveform centered behind.
  Uses currentColor so it inherits active/inactive nav colors automatically.
  Sized at 1em × 1em to match Material Symbols nav icons.
-->
<svg
  viewBox="0 0 24 24"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  style="width:1em;height:1em;display:block;flex-shrink:0"
  aria-hidden="true"
>
  <!--
    ECG / vital-signs waveform — full width, centered vertically.
    Spike is in the left third of the canvas, clear of the runner.
    Rendered first so the runner silhouette sits on top.
  -->
  <path
    d="M0,13 H4 L5,11 L6.5,7 L8,19 L9.5,13 H24"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    opacity="0.45"
  />

  <!--
    Runner facing right (direction of travel).
    Stroke-based so it works cleanly at small icon sizes.
    Parts: head · torso · two arms · two legs.
  -->

  <!-- Head -->
  <circle cx="15" cy="4" r="1.9" fill="currentColor" />

  <!-- Torso: neck → hip, leaning forward -->
  <line x1="15" y1="5.9" x2="14" y2="11"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" />

  <!-- Left arm swinging back (up-left) -->
  <line x1="14.8" y1="8" x2="12" y2="6"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />

  <!-- Right arm reaching forward (down-right) -->
  <line x1="14.8" y1="8" x2="17.5" y2="11"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />

  <!-- Right leg: extending forward (hip → knee → foot, lower-right) -->
  <polyline points="14,11 16.5,16.5 18,21"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" />

  <!-- Left leg: trailing behind (hip → knee → foot, lower-left, bent) -->
  <polyline points="14,11 12,15.5 10.5,20.5"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" />
</svg>
