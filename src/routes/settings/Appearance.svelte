<script>
  import { onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Toggle from '../../components/settings/Toggle.svelte';
  import Sheet from '../../components/ui/Sheet.svelte';
  import { DB } from '../../lib/db.js';
  import {
    appearance, accentColor, sidebarPersistent, goalCelebrations, forceMobileLayout,
    bannerStyle, bannerAnimation,
    applyAppearance, applyAccentColor, scheduleSave,
  } from '../../stores/settings.js';

  function set(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  const ACCENT_COLORS = [
    { value: 'mint',   label: 'Mint',   dark: '#4FFFB0', light: '#00C47A' },
    { value: 'blue',   label: 'Blue',   dark: '#4FC3F7', light: '#0277BD' },
    { value: 'red',    label: 'Red',    dark: '#FF7070', light: '#D93025' },
    { value: 'purple', label: 'Purple', dark: '#CE93D8', light: '#8E24AA' },
    { value: 'orange', label: 'Orange', dark: '#FFB547', light: '#E65100' },
    { value: 'teal',   label: 'Teal',   dark: '#4DD0E1', light: '#00838F' },
    { value: 'pink',   label: 'Pink',   dark: '#F48FB1', light: '#C2185B' },
    { value: 'yellow', label: 'Yellow', dark: '#FFF176', light: '#F9A825' },
    { value: 'indigo', label: 'Indigo', dark: '#9FA8DA', light: '#3949AB' },
    { value: 'lime',   label: 'Lime',   dark: '#C5E1A5', light: '#558B2F' },
    { value: 'rose',   label: 'Rose',   dark: '#FF80AB', light: '#E91E63' },
    { value: 'cyan',   label: 'Cyan',   dark: '#80DEEA', light: '#0097A7' },
  ];
  const APPEARANCE_OPTS = [
    { value: 'system', label: 'System Default' },
    { value: 'dark',   label: 'Dark'           },
    { value: 'light',  label: 'Light'          },
  ];
  const NAV_STYLE_OPTS = [
    { value: 'bottom',   label: 'Bottom tab bar' },
    { value: 'sidebar',  label: 'Side panel'     },
    { value: 'both',     label: 'Both'           },
  ];
  const START_PAGE_OPTS = [
    { value: '/',           label: 'Diary'      },
    { value: '/foods',      label: 'Foods'      },
    { value: '/statistics', label: 'Statistics' },
    { value: '/wellness',   label: 'Wellness'   },
    { value: '/goals',      label: 'Goals'      },
    { value: '/settings',   label: 'Settings'   },
  ];

  $: isDark = $appearance === 'dark' || ($appearance === 'system' && (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches));

  // ── Custom accent color ───────────────────────────────────────────────────
  let customColorHex = /^#[0-9a-fA-F]{6}$/.test($accentColor) ? $accentColor : '#4FFFB0';
  let customHexInput = customColorHex;
  let showColorSheet = false;
  let cpHue = 160, cpSat = 100, cpLgt = 50;
  let cpR = 79, cpG = 255, cpB = 176;

  function _hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }
  function _hexToHsl(hex) {
    const r = parseInt(hex.slice(1,3),16)/255;
    const g = parseInt(hex.slice(3,5),16)/255;
    const b = parseInt(hex.slice(5,7),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h = 0, s = 0, l = (max+min)/2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d/(2-max-min) : d/(max+min);
      switch(max) {
        case r: h = ((g-b)/d + (g<b?6:0))/6; break;
        case g: h = ((b-r)/d + 2)/6; break;
        case b: h = ((r-g)/d + 4)/6; break;
      }
    }
    return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
  }

  function _syncRgbFromHex(hex) {
    cpR = parseInt(hex.slice(1,3),16);
    cpG = parseInt(hex.slice(3,5),16);
    cpB = parseInt(hex.slice(5,7),16);
  }
  function openColorSheet() {
    const cur = /^#[0-9a-fA-F]{6}$/.test($accentColor) ? $accentColor : '#4FFFB0';
    customColorHex = cur;
    customHexInput = cur;
    [cpHue, cpSat, cpLgt] = _hexToHsl(cur);
    _syncRgbFromHex(cur);
    showColorSheet = true;
  }
  function cpUpdateFromSliders() {
    customColorHex = _hslToHex(cpHue, cpSat, cpLgt);
    customHexInput = customColorHex;
    _syncRgbFromHex(customColorHex);
    applyAccentColor(customColorHex);
  }
  function cpUpdateFromHex() {
    if (/^#[0-9a-fA-F]{6}$/.test(customHexInput)) {
      customColorHex = customHexInput;
      [cpHue, cpSat, cpLgt] = _hexToHsl(customHexInput);
      _syncRgbFromHex(customHexInput);
      applyAccentColor(customHexInput);
    }
  }
  function cpUpdateFromRgb() {
    const r = Math.min(255, Math.max(0, cpR || 0));
    const g = Math.min(255, Math.max(0, cpG || 0));
    const b = Math.min(255, Math.max(0, cpB || 0));
    cpR = r; cpG = g; cpB = b;
    const hex = '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b.toString(16).padStart(2,'0');
    customColorHex = hex;
    customHexInput = hex;
    [cpHue, cpSat, cpLgt] = _hexToHsl(hex);
    applyAccentColor(hex);
  }
  function applyCustomColor() {
    if (/^#[0-9a-fA-F]{6}$/.test(customHexInput)) {
      applyAccentColor(customHexInput);
    }
    showColorSheet = false;
  }

  let navStyle  = DB.getSetting('navStyle',  'both');
  let startPage = DB.getSetting('startPage', '/');
  let disableAnimations        = DB.getSetting('disableAnimations', false);
  let sidebarPersistentVal     = DB.getSetting('sidebarPersistent', false);

  // Track viewport width reactively so the persistent-sidebar toggle hides on
  // phones (and reappears if the user rotates a tablet to landscape, etc.).
  // Threshold matches App.svelte's _persistentAllowed (768px = standard tablet).
  let _viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  function _onResize() { _viewportW = window.innerWidth; }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', _onResize);
  }
  onDestroy(() => {
    if (typeof window !== 'undefined') window.removeEventListener('resize', _onResize);
  });
  $: _persistentAllowed = _viewportW >= 768;

  $: set('navStyle', navStyle);
  $: set('startPage', startPage);
  $: set('disableAnimations', disableAnimations);
  $: { sidebarPersistent.set(sidebarPersistentVal); }
</script>

<div class="section-body">

  <!-- Group: Theme & Color -->
  <p class="settings-group-heading">Theme &amp; Color</p>
  <p class="settings-group-sub">System theme and accent palette used across the app.</p>
  <div class="card settings-card">
    <div class="setting-row">
      <span class="setting-label">{$_('settings.appearance.theme')}</span>
      <div class="select-wrap" style="width:150px">
        <select class="select sel-sm" value={$appearance} on:change={e => applyAppearance(e.target.value)}>
          {#each APPEARANCE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:10px">
      <span class="setting-label">{$_('settings.appearance.accent_color')}</span>
      <div class="accent-swatches">
        {#each ACCENT_COLORS as c}
          <button
            class="accent-swatch"
            class:active={$accentColor === c.value}
            style="background:{isDark ? c.dark : c.light}"
            title={c.label}
            on:click={() => applyAccentColor(c.value)}
          >
            {#if $accentColor === c.value}
              <span class="material-symbols-rounded" style="font-size:16px;color:rgba(255,255,255,0.95);text-shadow:0 1px 3px rgba(0,0,0,0.4)">check</span>
            {/if}
          </button>
        {/each}
        <!-- Custom color swatch (color wheel) -->
        <button class="accent-swatch accent-swatch-custom" class:active={/^#[0-9a-fA-F]{6}$/.test($accentColor)}
          title={$_('settings_main.custom_color')} style={/^#[0-9a-fA-F]{6}$/.test($accentColor) ? "background:"+$accentColor : ""}
          on:click={openColorSheet}>
          <span class="material-symbols-rounded" style="font-size:16px;color:rgba(255,255,255,0.9);text-shadow:0 0 3px rgba(0,0,0,0.5)">colorize</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Group: Navigation -->
  <p class="settings-group-heading">Navigation</p>
  <p class="settings-group-sub">How you get around the app and where you land on open.</p>
  <div class="card settings-card">
    <div class="setting-row">
      <span class="setting-label">{$_('settings.appearance.navigation_style')}</span>
      <div class="select-wrap" style="width:150px">
        <select class="select sel-sm" bind:value={navStyle}>
          {#each NAV_STYLE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </div>
    </div>
    {#if (navStyle === 'sidebar' || navStyle === 'both') && _persistentAllowed}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_main.persistent_sidebar')}</span>
          <div class="setting-desc">{$_('settings_main.persistent_sidebar_desc')}</div>
        </div>
        <Toggle checked={sidebarPersistentVal} on:change={e => sidebarPersistentVal = e.detail} />
      </div>
    {/if}
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_main.start_page')}</span>
      <div class="select-wrap" style="width:150px">
        <select class="select sel-sm" bind:value={startPage}>
          {#each START_PAGE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">Force Mobile Layout</span>
        <div class="setting-desc">For users who prefer the compact phone-style layout on large screens. When on, the large-screen breakpoints (Diary right rail, Settings two-pane, week strip) are all disabled at every viewport width, and drag-to-copy meals is turned off. Keep this off to use the full large-screen experience.</div>
      </div>
      <Toggle checked={$forceMobileLayout} on:change={e => forceMobileLayout.set(e.detail)} />
    </div>
  </div>

  <!-- Group: Motion & Chrome -->
  <p class="settings-group-heading">Motion &amp; Chrome</p>
  <p class="settings-group-sub">Animation intensity and top-of-page banner treatment.</p>
  <div class="card settings-card">
    <div class="setting-row">
      <span class="setting-label">{$_('settings_main.reduce_motion')}</span>
      <Toggle checked={disableAnimations} on:change={e => { disableAnimations = e.detail; set('disableAnimations', e.detail); }} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_main.goal_pulse')}</span>
        <div class="setting-desc">{$_('settings_main.goal_pulse_desc')}</div>
      </div>
      <Toggle checked={$goalCelebrations} on:change={e => goalCelebrations.set(e.detail)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_main.page_banners')}</span>
        <div class="setting-desc">{$_('settings_main.page_banners_desc')}</div>
      </div>
      <div class="select-wrap" style="width:130px">
        <select class="select sel-sm" value={$bannerStyle} on:change={e => bannerStyle.set(e.currentTarget.value)}>
          <option value="animated">{$_('settings_main.banner_animated')}</option>
          <option value="gradient">{$_('settings_main.banner_gradient')}</option>
          <option value="off">{$_('settings_main.banner_off')}</option>
        </select>
      </div>
    </div>
    {#if $bannerStyle === 'animated'}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_main.anim_style')}</span>
          <div class="setting-desc">{$_('settings_main.anim_style_desc')}</div>
        </div>
        <div class="select-wrap" style="width:130px">
          <select class="select sel-sm" value={$bannerAnimation} on:change={e => bannerAnimation.set(e.currentTarget.value)}>
            <option value="shimmer">{$_('settings_main.anim_shimmer')}</option>
            <option value="drift">{$_('settings_main.anim_drift')}</option>
            <option value="pulse">{$_('settings_main.anim_pulse')}</option>
            <option value="aurora">{$_('settings_main.anim_aurora')}</option>
          </select>
        </div>
      </div>
    {/if}
  </div>

</div>

<!-- Custom color picker sheet -->
<Sheet bind:open={showColorSheet} title="Custom Color">
  <div class="cp-body">
    <!-- Live preview -->
    <div class="cp-preview" style="background:{customColorHex}">
      <span class="cp-preview-hex">{customHexInput}</span>
    </div>
    <!-- Hue slider -->
    <div class="cp-slider-group">
      <label class="form-label">Hue</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-hue" min="0" max="360"
          bind:value={cpHue} on:input={cpUpdateFromSliders} />
      </div>
    </div>
    <!-- Saturation slider -->
    <div class="cp-slider-group">
      <label class="form-label">{$_('settings_color.saturation')}</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-sat" min="0" max="100"
          bind:value={cpSat} on:input={cpUpdateFromSliders}
          style="--cp-sat-lo:hsl({cpHue},0%,{cpLgt}%);--cp-sat-hi:hsl({cpHue},100%,{cpLgt}%)" />
      </div>
    </div>
    <!-- Lightness slider -->
    <div class="cp-slider-group">
      <label class="form-label">{$_('settings_color.lightness')}</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-lgt" min="0" max="100"
          bind:value={cpLgt} on:input={cpUpdateFromSliders}
          style="--cp-lgt-lo:hsl({cpHue},{cpSat}%,0%);--cp-lgt-mid:hsl({cpHue},{cpSat}%,50%);--cp-lgt-hi:hsl({cpHue},{cpSat}%,100%)" />
      </div>
    </div>
    <!-- RGB inputs -->
    <div class="cp-slider-group">
      <label class="form-label">RGB</label>
      <div class="cp-rgb-row">
        <div class="cp-rgb-field">
          <input class="input cp-rgb-input" type="number" min="0" max="255" bind:value={cpR} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">R</span>
        </div>
        <div class="cp-rgb-field">
          <input class="input cp-rgb-input" type="number" min="0" max="255" bind:value={cpG} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">G</span>
        </div>
        <div class="cp-rgb-field">
          <input class="input cp-rgb-input" type="number" min="0" max="255" bind:value={cpB} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">B</span>
        </div>
      </div>
    </div>
    <!-- Hex input -->
    <div class="cp-slider-group">
      <label class="form-label">{$_('settings_color.hex_code')}</label>
      <div class="cp-hex-row">
        <span class="cp-hex-dot" style="background:{/^#[0-9a-fA-F]{6}$/.test(customHexInput) ? customHexInput : '#ccc'}"></span>
        <input class="input" type="text" placeholder="#rrggbb" maxlength="7"
          style="font-family:monospace;letter-spacing:0.05em;flex:1"
          bind:value={customHexInput}
          on:input={cpUpdateFromHex}
          on:keydown={e => e.key === 'Enter' && applyCustomColor()} />
      </div>
    </div>
    <button class="btn btn-primary w-full" style="height:44px;margin-top:4px" on:click={applyCustomColor}>{$_('settings_color.apply_color')}</button>
  </div>
</Sheet>

<style>
  .accent-swatches { display: flex; gap: 10px; flex-wrap: wrap; }
  .accent-swatch {
    width: 38px; height: 38px; border-radius: 50%;
    border: 3px solid transparent; cursor: pointer;
    transition: transform 0.15s, border-color 0.15s;
    outline: none;
    display: flex; align-items: center; justify-content: center;
  }
  .accent-swatch.active {
    border-color: var(--text-1);
    transform: scale(1.15);
  }
  .accent-swatch:hover { transform: scale(1.08); }
  .accent-swatch-custom {
    display: flex; align-items: center; justify-content: center;
    background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red);
    position: relative; overflow: hidden; cursor: pointer;
  }
  /* Custom color picker sheet content */
  .cp-body { display: flex; flex-direction: column; gap: 18px; padding-top: 4px; }
  .cp-preview {
    height: 70px; border-radius: var(--radius-lg);
    display: flex; align-items: flex-end; justify-content: flex-end;
    padding: 8px 12px;
    border: 1px solid rgba(255,255,255,0.12);
  }
  .cp-preview-hex {
    font-size: 11px; font-family: monospace; letter-spacing: 0.06em;
    color: rgba(255,255,255,0.75); text-shadow: 0 1px 3px rgba(0,0,0,0.5);
    font-weight: 600;
  }
  .cp-slider-group { display: flex; flex-direction: column; gap: 8px; }
  .cp-slider-wrap { padding: 4px 0; }
  .cp-slider {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 16px; border-radius: 8px; outline: none; cursor: pointer;
    border: 1px solid rgba(128,128,128,0.2);
  }
  .cp-hue {
    background: linear-gradient(to right,
      hsl(0,100%,50%), hsl(30,100%,50%), hsl(60,100%,50%), hsl(90,100%,50%),
      hsl(120,100%,50%), hsl(150,100%,50%), hsl(180,100%,50%), hsl(210,100%,50%),
      hsl(240,100%,50%), hsl(270,100%,50%), hsl(300,100%,50%), hsl(330,100%,50%), hsl(360,100%,50%));
  }
  .cp-sat { background: linear-gradient(to right, var(--cp-sat-lo), var(--cp-sat-hi)); }
  .cp-lgt { background: linear-gradient(to right, var(--cp-lgt-lo), var(--cp-lgt-mid), var(--cp-lgt-hi)); }
  .cp-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--surface-1); border: 2px solid var(--text-1);
    box-shadow: 0 2px 6px rgba(0,0,0,0.35); cursor: pointer;
  }
  .cp-slider::-moz-range-thumb {
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--surface-1); border: 2px solid var(--text-1);
    box-shadow: 0 2px 6px rgba(0,0,0,0.35); cursor: pointer;
  }
  .cp-rgb-row { display: flex; gap: 10px; }
  .cp-rgb-field { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }
  .cp-rgb-input { height: 42px; text-align: center; font-size: 16px; font-weight: 600; padding: 0 4px; }
  .cp-rgb-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: var(--text-3); text-transform: uppercase; }
  .cp-hex-row { display: flex; align-items: center; gap: 10px; }
  .cp-hex-dot {
    width: 28px; height: 28px; border-radius: 50%;
    border: 2px solid var(--border); flex-shrink: 0;
  }
</style>
