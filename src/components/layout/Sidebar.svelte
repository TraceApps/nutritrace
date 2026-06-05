<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { location, push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { createEventDispatcher } from 'svelte';
  import { resolveAssetUrl, isNative } from '../../lib/platform.js';
  import { currentUser, userMgmtActive, logout } from '../../stores/auth.js';
  import { wellnessEnabled, fitbitEnabled, withingsEnabled, garminEnabled, googleHealthEnabled, healthConnectEnabled } from '../../stores/settings.js';
  import WellnessIcon from '../icons/WellnessIcon.svelte';
  import { APP_VERSION } from '../../lib/version.js';

  export let open = false;
  export let persistent = false;
  const dispatch = createEventDispatcher();

  async function handleLogout() {
    await logout();
    open = false;
    dispatch('close');
    if (isNative) {
      // Fade out then reload for smooth transition
      document.body.style.transition = 'opacity 0.3s';
      document.body.style.opacity = '0';
      setTimeout(() => window.location.reload(), 350);
    }
  }

  function getInitial(user) {
    return (user?.full_name || user?.username || '?')[0].toUpperCase();
  }

  $: BASE_NAV = [
    { path: '/',           icon: 'book',           label: $_('nav.diary')      },
    { path: '/foods',      icon: 'restaurant',     label: $_('nav.foods')      },
    { path: '/statistics', icon: 'bar_chart',      label: $_('nav.statistics') },
    { path: '/goals',      icon: 'flag',           label: $_('nav.goals')      },
    { path: '/settings',   icon: 'settings',       label: $_('nav.settings')   },
  ];

  $: WELLNESS_NAV = { path: '/wellness', customIcon: WellnessIcon, label: $_('nav.wellness') };

  // Must mirror BottomNav.svelte's predicate so the sidebar shows Wellness
  // for the same source set: Fitbit / Withings / Garmin / Google Health /
  // Health Connect. Earlier omission of healthConnect caused #62 (sidebar
  // hid Wellness for HC-only users while bottom nav showed it).
  $: showWellness = $wellnessEnabled && ($fitbitEnabled || $withingsEnabled || $garminEnabled || $googleHealthEnabled || $healthConnectEnabled);
  $: navItems = showWellness
    ? [...BASE_NAV.slice(0, 2), WELLNESS_NAV, ...BASE_NAV.slice(2)]
    : BASE_NAV;

  function go(path) {
    push(path);
    if (!persistent) {
      open = false;
      dispatch('close');
    }
  }

  function close() {
    if (!persistent) {
      open = false;
      dispatch('close');
    }
  }

  $: activePath = $location.split('?')[0];
</script>

{#if open}
  <!-- Backdrop (overlay mode only) -->
  {#if !persistent}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="sidebar-backdrop"
      in:fade={{ duration: 200 }}
      out:fade={{ duration: 160 }}
      on:click={close}
    ></div>
  {/if}

  <!-- Panel -->
  <aside
    class="sidebar-panel"
    class:sidebar-persistent={persistent}
    in:fly={{ x: -280, duration: persistent ? 0 : 280, easing: cubicOut }}
    out:fly={{ x: -280, duration: persistent ? 0 : 200 }}
    aria-label="Navigation menu"
  >
    <!-- App branding -->
    <div class="sidebar-brand">
      <img class="brand-icon" src={resolveAssetUrl('/icons/logo.png')} alt="NutriTrace" />
      <div class="brand-text">
        <span class="brand-name">NutriTrace</span>
        <span class="brand-tagline">Trace Every Bite — Personal Nutrition Tracker</span>
      </div>
    </div>

    <div class="sidebar-divider"></div>

    <!-- Nav items -->
    <nav class="sidebar-nav">
      {#each navItems as item}
        <button
          class="sidebar-item"
          class:active={activePath === item.path}
          on:click={() => go(item.path)}
        >
          {#if item.customIcon}
            <span class="sidebar-icon custom-icon"><svelte:component this={item.customIcon} /></span>
          {:else}
            <span class="material-symbols-rounded sidebar-icon">{item.icon}</span>
          {/if}
          <span class="sidebar-label">{item.label}</span>
          {#if activePath === item.path}
            <div class="active-indicator"></div>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="sidebar-footer">
      {#if $userMgmtActive && $currentUser}
        <div class="sidebar-user">
          <div class="user-avatar">
            {#if $currentUser.avatar_url}
              <img src={resolveAssetUrl($currentUser.avatar_url)} alt="" class="user-avatar-img" />
            {:else}
              {getInitial($currentUser)}
            {/if}
          </div>
          <div class="user-info">
            <span class="user-name">{$currentUser.full_name || $currentUser.username}</span>
            <span class="sidebar-version">{APP_VERSION}</span>
          </div>
          <button class="btn-icon logout-btn" on:click={handleLogout} title={$_('common.sign_out')} aria-label={$_('common.sign_out')}>
            <span class="material-symbols-rounded">logout</span>
          </button>
        </div>
      {:else}
        <span class="sidebar-version">{APP_VERSION}</span>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .sidebar-backdrop {
    position: fixed; inset: 0;
    /* Dark frosted glass scrim — covers everything to the right of the
       sidebar panel with a heavy blur + saturation boost so the page
       content reads as background texture rather than competing with
       the sidebar nav items. */
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    z-index: 100;
  }

  .sidebar-panel {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    width: 280px;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
    z-index: 101;
    display: flex;
    flex-direction: column;
    padding: var(--safe-top) 0 var(--safe-bottom);
    box-shadow: var(--shadow-lg);
  }
  /* Persistent sidebar: no shadow, lower z-index (no need to float above content) */
  .sidebar-persistent {
    box-shadow: none;
    z-index: 40;
  }

  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 20px 16px;
  }
  .brand-icon {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    flex-shrink: 0;
    filter: drop-shadow(0 2px 8px rgba(79,255,176,0.3));
  }
  .brand-text { display: flex; flex-direction: column; gap: 2px; }
  .brand-name {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .brand-tagline { font-size: 12px; color: var(--text-3); }

  .sidebar-divider { height: 1px; background: var(--border); margin: 0 16px 8px; }

  .sidebar-nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 10px;
    overflow-y: auto;
  }

  .sidebar-item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 13px 14px;
    border-radius: var(--radius-md);
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-2);
    font-size: 15px;
    font-weight: 500;
    text-align: left;
    width: 100%;
    position: relative;
    transition: background var(--dur-fast), color var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .sidebar-item:hover  { background: var(--surface-2); color: var(--text-1); }
  .sidebar-item.active {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .sidebar-item:active { transform: scale(0.98); }

  .sidebar-icon { font-size: 22px; flex-shrink: 0; }
  .sidebar-icon.custom-icon {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sidebar-label { flex: 1; }

  .active-indicator {
    width: 4px;
    height: 20px;
    border-radius: var(--radius-full);
    background: var(--accent);
    position: absolute;
    right: -10px;
    top: 50%;
    transform: translateY(-50%);
  }

  .sidebar-footer {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .sidebar-version { font-size: 11px; color: var(--text-3); }

  .sidebar-user {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
  }
  .user-avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent);
    font-size: 14px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
  }
  .user-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
  }
  .user-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .user-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .logout-btn {
    flex-shrink: 0;
    color: var(--text-3);
    transition: color var(--dur-fast);
  }
  .logout-btn:hover { color: var(--error, #f87171); }
</style>
