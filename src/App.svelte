<script>
  import { onMount }   from 'svelte';
  import { fade, slide } from 'svelte/transition';
  import { portal } from './lib/portal.js';
  import Router, { location } from 'svelte-spa-router';

  import BottomNav from './components/layout/BottomNav.svelte';
  import Sidebar   from './components/layout/Sidebar.svelte';
  import Toast     from './components/ui/Toast.svelte';
  import ConfirmDialogMount from './components/ui/ConfirmDialogMount.svelte';
  import { DB, localDateStr } from './lib/db.js';
  import { currentDate, loadEntry } from './stores/diary.js';
  import { navStyle, applyAccentColor, accentColor, applyAppearance, appearance, disableAnimations, sidebarPersistent, language, pageBanners, bannerStyle, bannerAnimation, forceMobileLayout } from './stores/settings.js';
  import { locale, _ } from 'svelte-i18n';
  import { currentUser, userMgmtActive, setupRequired, loadAuthState, handleOidcCallback } from './stores/auth.js';
  import { needsNativeSetup, isNative, getNativeMode, getServerUrl, apiUrl } from './lib/platform.js';
  import { describeConnectionIssue } from './lib/connection-message.js';
  import { writable } from 'svelte/store';

  // Sync state — mirrored from the real sync store (dynamically imported)
  const syncState = writable({ syncing: false, phase: '', progress: '', lastSync: null, error: null, online: true, connectionIssue: null, showErrorBanner: false });
  $: _syncModeActive = isNative && getNativeMode() === 'server';
  $: _serverReachable = $syncState.online && !$syncState.connectionIssue;
  $: _connectionCopy = describeConnectionIssue($syncState.connectionIssue, $_, true);
  $: _syncBannerCopy = $syncState.showErrorBanner && _connectionCopy
    ? { ..._connectionCopy, icon: 'cloud_off' }
    : ($syncState.showErrorBanner && $syncState.error
    ? { title: $_('sync.error_title'), detail: $syncState.error, icon: 'error' }
    : null);
  let _retryingConnection = false;
  const PULL_SYNC_SLOP = 10;
  const PULL_SYNC_THRESHOLD = 64;
  const PULL_SYNC_MAX = 88;
  let _pullStartX = 0;
  let _pullStartY = 0;
  let _pullDistance = 0;
  let _pullTracking = false;
  let _pullRefreshing = false;

  function _waitForSyncIdle(timeoutMs = 30000) {
    if (!$syncState.syncing) return Promise.resolve();
    return new Promise(resolve => {
      let unsubscribe;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A Svelte subscription invokes immediately, possibly before the
        // unsubscribe function has been assigned.
        queueMicrotask(() => unsubscribe?.());
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      unsubscribe = syncState.subscribe(state => {
        if (!state.syncing) finish();
      });
    });
  }

  async function _runForcedSync() {
    const { fullSync } = await import('./lib/sync.js');
    let result = await fullSync(false, true, true);
    if (result?.reason === 'busy') {
      console.info('[sync] manual refresh queued behind active sync');
      await _waitForSyncIdle();
      result = await fullSync(false, true, true);
    }
    return result;
  }

  async function _retryServerConnection() {
    if (_retryingConnection) return;
    _retryingConnection = true;
    try {
      await _runForcedSync();
    } finally {
      _retryingConnection = false;
    }
  }

  async function _dismissSyncBanner() {
    const { syncState: realSyncState } = await import('./lib/sync.js');
    // Keep the underlying connection issue so the cloud badge and Settings
    // status remain accurate; only dismiss the detailed manual-feedback UI.
    realSyncState.update(state => ({ ...state, showErrorBanner: false, error: null }));
  }

  function _startPullSync(event) {
    if (!_syncModeActive || needsLogin || showNativeSetup || sidebarOpen || _pullRefreshing) return;
    // Listen at window level because the fixed top bar and portalled offline
    // banner both sit outside <main>. Dialogs, sheets, sidebars and bottom
    // navigation retain their own touch handling.
    if (event.target.closest?.('[role="dialog"], .sheet-backdrop, .sidebar-panel, .sidebar-backdrop, .bottom-nav')) return;
    if (event.touches.length !== 1) return;
    // Walk up from the touch target to the nearest scrolling ancestor.
    // Editor pages have their own overflow container that sits on top of
    // .page-transition (position: fixed + overflow-y: auto) so its
    // scrollTop climbs while .page-transition stays at 0 — this walk-up
    // catches whichever container is actually scrolling.
    let el = event.target;
    let foundScroller = false;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        if (el.scrollTop > 0) return;
        foundScroller = true;
        break;
      }
      el = el.parentElement;
    }
    if (!foundScroller) {
      const rootScroll = window.scrollY || document.scrollingElement?.scrollTop || 0;
      if (rootScroll > 0) return;
    }
    _pullStartX = event.touches[0].clientX;
    _pullStartY = event.touches[0].clientY;
    _pullDistance = 0;
    _pullTracking = true;
  }

  function _movePullSync(event) {
    if (!_pullTracking || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - _pullStartX;
    const dy = event.touches[0].clientY - _pullStartY;
    if (
      (Math.abs(dx) > PULL_SYNC_SLOP && Math.abs(dx) > Math.abs(dy)) ||
      dy < -PULL_SYNC_SLOP
    ) {
      _pullTracking = false;
      _pullDistance = 0;
      return;
    }
    // Ignore normal finger jitter so a slightly imprecise tap on a header
    // control is not converted into a pull gesture.
    if (dy <= PULL_SYNC_SLOP) return;
    event.preventDefault();
    _pullDistance = Math.min(PULL_SYNC_MAX, (dy - PULL_SYNC_SLOP) * 0.5);
  }

  async function _finishPullSync() {
    if (!_pullTracking) return;
    const shouldSync = _pullDistance >= PULL_SYNC_THRESHOLD;
    _pullTracking = false;
    if (!shouldSync) {
      _pullDistance = 0;
      return;
    }

    _pullRefreshing = true;
    _pullDistance = PULL_SYNC_THRESHOLD;
    try {
      console.info(`[sync] pull-to-refresh triggered: online=${_serverReachable}`);
      const result = await _runForcedSync();
      console.info(`[sync] pull-to-refresh completed: ${result?.reason || (result?.ok ? 'ok' : 'unknown')}`);
    } catch (e) {
      console.error('[sync] pull-to-refresh failed:', e);
    } finally {
      _pullRefreshing = false;
      _pullDistance = 0;
    }
  }

  function _cancelPullSync() {
    if (_pullRefreshing) return;
    _pullTracking = false;
    _pullDistance = 0;
  }

  // Drive svelte-i18n's active locale from the user's saved language setting.
  // Fires on mount + on every change, so picking a new value in the Settings
  // dropdown immediately re-renders all $_ calls in the running app.
  $: if ($language) locale.set($language);
  import NativeSetup from './routes/NativeSetup.svelte';

  // Show native setup wizard before anything else on first Android launch
  let showNativeSetup = needsNativeSetup();

  import Diary      from './routes/Diary.svelte';
  import Foods      from './routes/Foods.svelte';
  import FoodEditor from './routes/FoodEditor.svelte';
  import MealEditor from './routes/MealEditor.svelte';
  import Statistics from './routes/Statistics.svelte';
  import Goals      from './routes/Goals.svelte';
  import Settings   from './routes/Settings.svelte';
  import Wizard     from './routes/Wizard.svelte';
  import Login          from './routes/Login.svelte';
  import Profile        from './routes/Profile.svelte';
  import ForgotPassword from './routes/ForgotPassword.svelte';
  import ResetPassword  from './routes/ResetPassword.svelte';
  import AcceptInvite   from './routes/AcceptInvite.svelte';
  import Trace      from './components/ai/Trace.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';
  import Wellness   from './routes/Wellness.svelte';

  const routes = {
    '/':                Diary,
    '/foods':           Foods,
    '/foods/edit':      FoodEditor,
    '/foods/edit/:id':  FoodEditor,
    '/meal-editor':     MealEditor,
    '/meal-editor/:id': MealEditor,
    '/statistics':      Statistics,
    '/wellness':        Wellness,
    '/goals':           Goals,
    '/settings':          Settings,
    '/settings/:section': Settings,
    '/wizard':          Wizard,
    '/profile':           Profile,
    '/forgot-password':   ForgotPassword,
    '/reset-password':    ResetPassword,
    '/accept-invite':     AcceptInvite,
    '*':                  Diary,
  };

  const NAV_HIDDEN = ['/wizard', '/foods/edit', '/meal-editor', '/profile'];
  $: showNav       = !NAV_HIDDEN.some(p => $location.startsWith(p));
  const EDITOR_ROUTES = ['/foods/edit', '/meal-editor', '/profile', '/wizard'];
  $: _isEditorRoute = EDITOR_ROUTES.some(r => $location.startsWith(r));
  $: isEditor      = NAV_HIDDEN.some(p => $location.startsWith(p));

  // Track viewport width — only the PERSISTENT/PINNED sidebar mode is gated
  // by viewport width. The drawer-style sidebar (hamburger + slide-in overlay)
  // is always available when navStyle allows it, so mobile users still have
  // access to Goals/Settings/Logout via the hamburger menu.
  // Threshold 768px = standard tablet breakpoint.
  let _viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { _viewportW = window.innerWidth; });
  }
  $: _persistentAllowed = _viewportW >= 768;

  $: _hasSidebar   = showNav && ($navStyle === 'sidebar' || $navStyle === 'both');
  $: sidebarPinned = _hasSidebar && _persistentAllowed && $sidebarPersistent;
  $: showHamburger = _hasSidebar && !sidebarPinned;

  // Set --page-top to just the device safe area — hamburger floats OVER the
  // banner instead of pushing content down. Reclaims ~62px of vertical space
  // on every page, especially valuable on small phones.
  // --hamburger-offset aligns the H1's left edge with the hamburger button's
  // LEFT edge (used by the banner-on layout where the title sits BELOW the button).
  // --hamburger-row adds a vertical row of padding when the banner-on layout is
  // active (title sits BELOW the floating hamburger). In banner-off / compact
  // mode the title sits NEXT to the button so no extra row is needed.
  // --hamburger-clearance is the button's RIGHT edge + small gap, used by the
  // compact (banner-off) layout where the title sits BESIDE the button and
  // needs padding-left to clear the button itself.
  // --sidebar-w shifts content right when sidebar is persistent.
  $: if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--page-top', 'var(--safe-top)');
    document.documentElement.style.setProperty(
      '--hamburger-offset',
      showHamburger ? '12px' : '0px'
    );
    // All three banner modes share the compact-header geometry (illustrated
    // SVG banners were retired). --hamburger-row stays 0 in every mode.
    document.documentElement.style.setProperty('--hamburger-row', '0px');
    // 12px (left margin) + 40px (button width) + 12px (gap before title)
    document.documentElement.style.setProperty(
      '--hamburger-clearance',
      showHamburger ? '64px' : '0px'
    );
    document.documentElement.style.setProperty(
      '--sidebar-w',
      sidebarPinned ? '280px' : '0px'
    );
  }

  let sidebarOpen = false;

  // Open/close sidebar as pinned state changes.
  // Track previous value so we close when transitioning pinned → not-pinned.
  let _prevPinned = false;
  function _syncSidebarToPin(pinned) {
    if (pinned) {
      sidebarOpen = true;
    } else if (_prevPinned) {
      // Was pinned, now not — dismiss the overlay so backdrop disappears
      sidebarOpen = false;
    }
    _prevPinned = pinned;
  }
  $: _syncSidebarToPin(sidebarPinned);

  // Also close immediately if sidebar nav is removed entirely (e.g. switched to bottom-only)
  $: if (!_hasSidebar) sidebarOpen = false;

  // Restore saved accent color and appearance on startup (also re-applies after loadServerSettings)
  $: applyAccentColor($accentColor);
  $: applyAppearance($appearance);

  // Apply/remove no-animations class when setting changes
  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('no-animations', !!$disableAnimations);
  }
  // Force-mobile layout: gates every desktop @media rule via the
  // :where(html:not(.force-mobile-layout)) prefix in Diary + Settings
  // stylesheets. When on, wide viewports still get the mobile pattern
  // (single-column diary, drill-in settings, no rail, no week strip).
  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('force-mobile-layout', !!$forceMobileLayout);
  }
  // Apply/remove banner-gradient class on the document so portaled top-bar
  // action buttons (which live outside the .page-header in the DOM, e.g.
  // .diary-topbar-actions and .wl-topbar-actions) can pick up the frosted-
  // pill treatment that the in-header buttons get from base.css.
  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('banner-gradient-mode', $bannerStyle === 'gradient');
    document.documentElement.classList.toggle('banner-animated-mode', $bannerStyle === 'animated');
    for (const cls of ['banner-animation-shimmer','banner-animation-drift','banner-animation-pulse','banner-animation-aurora']) {
      document.documentElement.classList.remove(cls);
    }
    if ($bannerStyle === 'animated') {
      document.documentElement.classList.add(`banner-animation-${$bannerAnimation || 'shimmer'}`);
    }
  }

  onMount(async () => {
    // Local-mode scheduled backup tick — JS-side scheduler that fires
    // exportLocalBackup() when the user's schedule is due. No-ops in
    // PWA / server modes. See src/lib/local-backup-scheduler.js for
    // why this is JS-only (vs WorkManager) and the storage layout.
    if (isNative && getNativeMode() === 'local') {
      import('./lib/local-backup-scheduler.js').then(({ startLocalBackupScheduler }) => {
        startLocalBackupScheduler();
      }).catch(e => console.warn('[local-backup] scheduler start failed:', e?.message));
    }

    // In-app-update cache housekeeping — deletes APKs in
    // Directory.Data/updates/ whose version is ≤ the running APP_VERSION
    // (leftovers from the update that just installed) plus anything
    // older than 7 days (orphans from cancelled downloads). Native-only
    // + best-effort — silent on failure.
    if (isNative) {
      import('./lib/updates.js').then(({ cleanUpdateCache }) => {
        cleanUpdateCache();
      }).catch(() => { /* ignore */ });

      // Tap-handler for the OS "update available" notification. Routes
      // into Settings → Updates so the user lands on the install action
      // one tap after the notification. Registered here (not in the
      // banner) because the notification can arrive when the banner
      // isn't mounted — e.g. app was cold-started via the tap.
      import('./lib/notifications.js').then(({ registerUpdateTapListener }) => {
        registerUpdateTapListener(() => {
          import('svelte-spa-router').then(({ push }) => push('/settings/updates'));
        });
      }).catch(() => { /* ignore */ });
    } else {
      // PWA: register the service worker via virtual:pwa-register so we
      // get onNeedRefresh callbacks. Without this, registerType:'prompt'
      // downloads new bundles but never tells the app they're ready.
      import('./lib/pwa-update.js').then(({ registerPwaSw }) => registerPwaSw()).catch(() => {});
    }

    // Visibility-change trigger for BOTH update channels. A user who
    // leaves the tab open for hours / a laptop that resumes from sleep
    // gets a re-check the moment the tab regains focus — respecting the
    // per-user cadence setting (Settings → Updates). The GitHub-tag
    // check returns cached inside the cadence window; the PWA SW-file
    // check just forces the browser to compare sw.js against what it
    // registered (otherwise the browser only bothers every 24h).
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        import('./lib/updates.js').then(({ checkForUpdate, getAutoCheck }) => {
          if (!getAutoCheck()) return;
          checkForUpdate({ force: false }).catch(() => {});
        }).catch(() => {});
        if (!isNative) {
          import('./lib/pwa-update.js').then(({ checkForPwaUpdate }) => checkForPwaUpdate()).catch(() => {});
        }
      });
    }

    // Periodic PWA-bundle poll on the same cadence as the GitHub-tag
    // check, so a tab that stays open all day still surfaces a fresh
    // deploy without a full reload. Cadence honors the same
    // updateCheckInterval setting; 0 (manual) disables the poll.
    if (!isNative && typeof window !== 'undefined') {
      Promise.all([
        import('./lib/pwa-update.js'),
        import('./stores/settings.js'),
      ]).then(([{ checkForPwaUpdate }, { updateCheckInterval }]) => {
        let _pwaPollTimer = null;
        const _resetPoll = (hours) => {
          if (_pwaPollTimer) clearInterval(_pwaPollTimer);
          _pwaPollTimer = null;
          const h = Number(hours) || 0;
          if (!h) return; // manual only
          _pwaPollTimer = setInterval(checkForPwaUpdate, h * 60 * 60 * 1000);
        };
        updateCheckInterval.subscribe(_resetPoll);
      }).catch(() => {});
    }

    // Android back button: navigate back or confirm exit
    if (isNative) {
      import('@capacitor/app').then(({ App }) => {
        let lastBack = 0;
        App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) {
            window.history.back();
          } else {
            const now = Date.now();
            if (now - lastBack < 2000) {
              App.exitApp();
            } else {
              lastBack = now;
              import('./stores/toast.js').then(({ showSuccess }) => {
                showSuccess('Tap again to exit');
              });
            }
          }
        });
        // Listen for OAuth deep link callbacks (nutritrace://callback?fitbit=connected)
        App.addListener('appUrlOpen', async ({ url }) => {
          console.log('[app] deep link received:', url);
          try {
            const { closeBrowser } = await import('./lib/oauth-native.js');
            await closeBrowser();
          } catch {}
          // Parse the deep link URL: nutritrace://callback?fitbit=connected
          // OR for OIDC flow: nutritrace://oidc-callback?token=… / ?error=… / ?linked=1
          try {
            const u = new URL(url);
            const params = u.searchParams;
            const host = (u.hostname || u.host || '').toLowerCase();
            if (host === 'oidc-callback') {
              const errMsg = params.get('error');
              const linked = params.get('linked');
              const token = params.get('token');
              const idTokenHint = params.get('id_token_hint');
              const providerId  = params.get('provider_id');
              if (errMsg) {
                import('./stores/toast.js').then(({ showError }) => showError(decodeURIComponent(errMsg)));
              } else if (linked) {
                import('./stores/toast.js').then(({ showSuccess }) => showSuccess('Linked'));
                await loadAuthState();
              } else if (token) {
                const { setAuthToken } = await import('./lib/platform.js');
                setAuthToken(token);
                // Stash the OIDC session hint so logout() can ask the IdP to
                // end the session via RP-initiated logout. The PWA stores
                // this in an httpOnly cookie at the same point, but native
                // can't reach that jar so we keep the equivalent in
                // localStorage here.
                if (idTokenHint && providerId) {
                  try {
                    localStorage.setItem('nt:oidc_logout_hint', JSON.stringify({
                      providerId,
                      idTokenHint,
                    }));
                  } catch {}
                }
                import('./stores/toast.js').then(({ showSuccess }) => showSuccess('Signed in'));
                await loadAuthState();
                // Re-evaluate the NativeSetup gate. Without this the user
                // completes OIDC from NativeSetup, gets a valid token, and
                // stays visually stuck on the setup screen — because the
                // showNativeSetup flag was captured at App.svelte mount and
                // never re-checked. needsNativeSetup() reads the current
                // nativeMode + serverUrl which NativeSetup persists before
                // opening the OIDC browser, so this correctly flips to
                // false and reveals the router. #110.
                showNativeSetup = needsNativeSetup();
                window.location.hash = '#/';
              }
            } else if (
              params.get('fitbit')        === 'connected' ||
              params.get('google_health') === 'connected' ||
              params.get('withings')      === 'connected' ||
              params.get('garmin')        === 'connected'
            ) {
              const provider =
                params.get('fitbit')        ? 'fitbit' :
                params.get('google_health') ? 'google_health' :
                params.get('withings')      ? 'withings' : 'garmin';
              const label = provider === 'google_health' ? 'Google Health' :
                            provider.charAt(0).toUpperCase() + provider.slice(1);
              import('./stores/toast.js').then(({ showSuccess }) => showSuccess(`${label} connected!`));
              // Navigate to Wellness page to pick up new connection
              window.location.hash = '#/wellness';
            } else if (
              params.get('fitbit')        === 'error' ||
              params.get('google_health') === 'error' ||
              params.get('withings')      === 'error' ||
              params.get('garmin')        === 'error'
            ) {
              const msg = params.get('msg') || 'Authorization failed';
              import('./stores/toast.js').then(({ showError }) => showError(msg));
              window.location.hash = '#/wellness';
            }
          } catch (e) {
            console.warn('[app] deep link parse error:', e);
          }
        });
      });
    }

    // Load auth state first (sets $currentUser and $userMgmtActive)
    await loadAuthState();

    // Mirror serverUrl + authToken from localStorage into the native SQLite
    // sync_meta table so the Kotlin HealthConnectSyncWorker (background HC
    // sync, #68 part 2) can read them without the WebView being open. Setters
    // already trigger this on change; this boot-time call covers users who
    // were already connected before this code shipped. No-op on web.
    try {
      const { bootMirrorAuth } = await import('./lib/platform.js');
      bootMirrorAuth();
    } catch {}

    // OIDC post-callback: if the URL hash contains ?oidc=ok / ?oidc_error=…
    // strip it, toast, and refresh auth state. Runs after loadAuthState so
    // we don't double-fetch on cold load.
    await handleOidcCallback();

    // Env-lock state: which Settings sections are configured via env vars.
    // Fetched globally so the Trace FAB knows about env-set AI_ENABLED
    // without waiting for the user to visit Settings. Issue #36.
    // Native server mode needs the Bearer token header explicitly —
    // credentials:'include' alone (cookies) returns 401 there.
    if (!isNative || getServerUrl()) {
      const { getAuthToken } = await import('./lib/platform.js');
      const headers = {};
      const token = getAuthToken();
      if (isNative && token) headers['Authorization'] = `Bearer ${token}`;
      fetch(apiUrl('/api/app-config/env-locks'), { credentials: 'include', headers })
        .then(r => r.ok ? r.json() : null)
        .then(async d => {
          if (!d) return;
          const { envLocks } = await import('./stores/settings.js');
          envLocks.set(d);
        })
        .catch(() => {});
    }

    // Show wizard on first launch:
    // - Native server mode: NEVER show wizard (server is already configured)
    // - Native local mode: show wizard for goals/units/profile setup
    // - Web + setup_required: force wizard (must create admin account first)
    // The web "no user + no user management" case is now fully covered by
    // $setupRequired alone (the server distinguishes fresh-install from
    // intentional single-user mode via the single_user_mode flag, see
    // server/routes/auth.js GET /status). Fixes #34 — without the flag,
    // an intentionally-disabled instance kept re-triggering the wizard on
    // every new device because !$userMgmtActive was always true.
    const _isNativeServer = isNative && getNativeMode() === 'server';
    const _isNativeLocal = isNative && getNativeMode() === 'local';
    if (!isNative && $setupRequired) {
      // PWA: server has no users AND not intentionally single-user — force
      // wizard with mandatory account creation
      window.location.hash = '#/wizard';
    } else if (_isNativeLocal && !DB.getSetting('setupComplete', false)) {
      // Native local: show wizard for goals/units/profile setup
      window.location.hash = '#/wizard';
    }

    // Issues #69 + #70 — one-shot migration for the showUnitMetadata
    // gate. Existing users on rc.50 saw the nutrition basis / serving
    // units / density fields unconditionally; turning the new toggle on
    // by default for them preserves continuity, while new installs get
    // the cleaner default-off behavior. setupComplete is the signal: any
    // user who has finished the wizard is an existing install. The
    // migration is idempotent via the unitMetadataMigrationV1 flag, so
    // it runs once per browser-per-user and never disturbs an explicit
    // user choice on subsequent app loads.
    if (!DB.getSetting('unitMetadataMigrationV1', false)) {
      const isExistingUser = DB.getSetting('setupComplete', false);
      if (isExistingUser) {
        DB.setSetting('showUnitMetadata', true);
      }
      DB.setSetting('unitMetadataMigrationV1', true);
    }

    // Start sync engine in native server-connected mode
    if (isNative && getNativeMode() === 'server') {
      import('./lib/sync.js').then((mod) => {
        mod.syncState.subscribe(v => syncState.set(v));
        mod.startNetworkMonitor();
        mod.fullSync(); // Initial automatic sync; failure stays in compact status
        // Periodic sync every 30 seconds (silent — only shows bar if changes found)
        setInterval(() => mod.fullSync(true), 30000);
        // Sync on app resume (visible)
        import('@capacitor/app').then(({ App }) => {
          App.addListener('resume', () => mod.fullSync());
        });
      });
    }

    // Request notification permission + re-schedule reminders on app open
    if (isNative) {
      import('./lib/notifications.js').then(async ({ requestPermission, scheduleWaterReminders, scheduleMealReminders, scheduleWeighInReminder }) => {
        // Always request permission on startup if any notification is enabled
        const anyEnabled = DB.getSetting('notifLocalEnabled', true) &&
          (DB.getSetting('notifWaterReminders', false) || DB.getSetting('notifMealReminders', false) ||
           DB.getSetting('notifWeighIn', false) || DB.getSetting('notifGoalCelebrations', false) ||
           DB.getSetting('notifCalorieGoal', false) || DB.getSetting('notifStepGoal', false) ||
           DB.getSetting('notifWellnessAlerts', false) || DB.getSetting('notifWorkoutSummary', false));
        if (anyEnabled) {
          const granted = await requestPermission();
          console.log('[app] notification permission:', granted ? 'granted' : 'denied');
        }
        if (DB.getSetting('notifWaterReminders', false)) {
          await scheduleWaterReminders(DB.getSetting('notifWaterInterval', 120));
        }
        if (DB.getSetting('notifMealReminders', false)) {
          const times = DB.getSetting('notifMealTimes', ['08:00','12:00','18:00']);
          const names = DB.getSetting('mealNames', ['Breakfast','Lunch','Dinner','Snacks']);
          await scheduleMealReminders(times, names);
        }
        if (DB.getSetting('notifWeighIn', false)) {
          await scheduleWeighInReminder(DB.getSetting('notifWeighInTime', '07:00'));
        }
      }).catch(() => {});
    }

    // Auto-detect timezone and save so server scheduler uses correct local time
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detectedTz && !DB.getSetting('timezone', '')) {
      DB.setSetting('timezone', detectedTz);
      import('./stores/settings.js').then(({ scheduleSave }) => scheduleSave('timezone', detectedTz));
    }

    // PWA: reload settings periodically + on tab focus (picks up changes from phone/other devices)
    if (!isNative && $userMgmtActive && $currentUser) {
      const _refreshSettings = () => import('./stores/settings.js').then(({ loadServerSettings }) => loadServerSettings());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _refreshSettings();
      });
      setInterval(_refreshSettings, 30000); // every 30 seconds
    }

    // Day rollover. When the tab or app sits open across midnight, the diary
    // and any date-keyed computations (adaptive goals, statistics window)
    // would otherwise stay on yesterday until the user navigates. Advance
    // currentDate to the new local today ONLY if the user was still viewing
    // the previous "today" — never yank them off a deliberately-chosen past
    // date. Two trigger paths: focus/resume (covers "left tab open overnight,
    // reopen at 6 AM") and a one-shot timer at the next local midnight
    // (covers "active across midnight").
    {
      let _lastObservedToday = localDateStr();
      let _midnightTimer = null;

      const _maybeRollDay = () => {
        const today = localDateStr();
        if (today === _lastObservedToday) return;
        let storedDate;
        currentDate.subscribe(v => storedDate = v)();
        if (storedDate === _lastObservedToday) {
          currentDate.set(today);
          loadEntry(today);
        }
        _lastObservedToday = today;
        _armMidnightTimer();
      };

      const _armMidnightTimer = () => {
        if (_midnightTimer) clearTimeout(_midnightTimer);
        const now = new Date();
        const next = new Date(now);
        next.setHours(24, 0, 30, 0); // 30s past midnight to dodge clock-skew jitter
        _midnightTimer = setTimeout(_maybeRollDay, next - now);
      };

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _maybeRollDay();
      });
      if (isNative) {
        import('@capacitor/app').then(({ App }) => {
          App.addListener('resume', _maybeRollDay);
        }).catch(() => {});
      }
      _armMidnightTimer();
    }

    // Migrate assistant name: legacy 'Buddy' / 'FitBot' defaults → 'Trace'.
    // Users who set their own custom name keep it.
    {
      const _curName = DB.getSetting('aiAssistantName', null);
      if (_curName === 'Buddy' || _curName === 'FitBot') {
        DB.setSetting('aiAssistantName', 'Trace');
      }
    }

    // Migrate water containers: replace old defaults with current ones
    const _wc = DB.getSetting('waterContainers', null);
    if (!_wc || _wc.some(c => c.name === 'Small Glass' || c.name === '1 Gallon')) {
      DB.setSetting('waterContainers', [
        { id: '1', name: 'Small Bottle',    volumeMl: 250  },
        { id: '2', name: 'Standard Bottle', volumeMl: 500  },
        { id: '3', name: 'Large Bottle',    volumeMl: 1000 },
        { id: '4', name: 'Gallon Jug',      volumeMl: 3785 },
      ]);
    }
  });

  // Auth gate: bypass for password reset / invite pages
  const AUTH_BYPASS = ['/forgot-password', '/reset-password', '/accept-invite'];
  $: needsLogin = $userMgmtActive && !$currentUser && !AUTH_BYPASS.includes($location);

  // When the user transitions from unauthenticated → authenticated (after a
  // successful login on the gate), re-pull server settings + clear stale
  // diary errors. Without this, settings that failed to load while the user
  // was anonymous (401) stay at their built-in defaults until a manual
  // refresh, and the diary banner from a pre-login load attempt sticks
  // around. Tracked manually since `currentUser` doesn't expose a
  // change-event we can subscribe to.
  let _wasNeedsLogin = needsLogin;
  $: {
    if (_wasNeedsLogin && !needsLogin && $currentUser) {
      _wasNeedsLogin = false;
      import('./stores/settings.js').then(({ loadServerSettings }) => loadServerSettings()).catch(() => {});
      import('./stores/diary.js').then(({ diaryLoadError }) => diaryLoadError.set(false)).catch(() => {});
    } else if (needsLogin) {
      _wasNeedsLogin = true;
    }
  }
</script>

<svelte:window
  on:touchstart|capture={_startPullSync}
  on:touchmove|nonpassive|capture={_movePullSync}
  on:touchend|capture={_finishPullSync}
  on:touchcancel|capture={_cancelPullSync}
/>

<!-- Native setup gate — shown on first launch on Android/iOS -->
{#if showNativeSetup}
  <NativeSetup />
  <Toast />

<!-- Login gate (when user management active and not authenticated) -->
{:else if needsLogin}
  <Login />
{:else}

<!-- Sidebar (hamburger menu) -->
<Sidebar bind:open={sidebarOpen} persistent={sidebarPinned} on:close={() => { if (!sidebarPinned) sidebarOpen = false; }} />

{#if showHamburger && $currentUser}
  <header class="app-topbar">
    <button
      class="hamburger"
      on:click={() => sidebarOpen = !sidebarOpen}
      aria-label="Open menu"
    >
      <span class="material-symbols-rounded">menu</span>
      {#if _syncModeActive && !_serverReachable}
        <span class="conn-badge conn-offline">
          <span class="material-symbols-rounded" style="font-size:10px">cloud_off</span>
        </span>
      {/if}
    </button>
    <div class="topbar-spacer"></div>
  </header>
{/if}

<!-- Portalled so page transforms cannot trap it in a lower stacking context.
     The safe-area + header offset keeps it below Android system chrome and
     the app's compact header instead of covering the clock or hamburger. -->
{#if _syncModeActive && !needsLogin && _syncBannerCopy}
  <div
    class="sync-connection-banner"
    use:portal
    transition:slide={{ duration: $disableAnimations ? 0 : 200 }}
    role="status"
    aria-live="assertive"
  >
    <span class="material-symbols-rounded sync-connection-icon">{_syncBannerCopy.icon}</span>
    <div class="sync-connection-copy">
      <strong>{_syncBannerCopy.title}</strong>
      <span>{_syncBannerCopy.detail}</span>
    </div>
    <button
      class="sync-retry"
      on:click={_retryServerConnection}
      disabled={_retryingConnection}
    >
      {_retryingConnection ? $_('sync.retrying') : $_('sync.retry')}
    </button>
    <button
      class="sync-dismiss"
      on:click={_dismissSyncBanner}
      aria-label={$_('sync.dismiss_message')}
    >
      <span class="material-symbols-rounded">close</span>
    </button>
  </div>
{/if}

{#if _syncModeActive && !sidebarOpen && (_pullDistance > 0 || _pullRefreshing)}
  <div
    class="pull-sync-indicator"
    class:ready-to-sync={_pullDistance >= PULL_SYNC_THRESHOLD}
    use:portal
    style:transform={`translate(-50%, ${Math.round(_pullDistance * 0.45)}px)`}
    aria-hidden="true"
  >
    <span class="material-symbols-rounded" class:pull-sync-spin={_pullRefreshing}>
      {_pullRefreshing ? 'autorenew' : 'arrow_downward'}
    </span>
  </div>
{/if}

<!-- In-app update banner (Android only — PWA gets SW reload prompt separately;
     server-update banner lives inside Settings → Updates admin panel). -->
{#if !needsLogin}<UpdateBanner />{/if}

<!-- Page content -->
<!-- Key on the top-level path segment (/settings, /foods, /goals, …)
     instead of the full $location. Otherwise inner nav within a
     shell that keeps the same component mounted (e.g. Settings
     jumping between /settings/appearance → /settings/diary via
     the desktop rail) still triggers a full <main> remount +
     fade-in, which reads as a page load and blows away all local
     state in the shell (rail scroll position, expand states,
     matchMedia trackers, etc.). Segment-keyed means only true
     shell changes animate. -->
{#key ($location || '').split('/')[1] || ''}
  <main
    class="page-transition"
    class:has-topbar={showNav}
    in:fade={{ duration: $disableAnimations ? 0 : 180 }}
  >
    <Router {routes} />
  </main>
{/key}

{#if showNav && ($navStyle === 'bottom' || $navStyle === 'both')}
  <BottomNav />
{/if}

<Toast />
<Trace />

{/if}

<!-- Toast must also render outside the login gate so errors show on the login screen -->
{#if needsLogin}<Toast />{/if}
<!-- ConfirmDialog is always-mounted so it works on every screen including login + native setup -->
<ConfirmDialogMount />

<style>
  :global(body) { overflow-x: hidden; }

  /* Kill all transitions & animations when user enables "Disable animations" */
  :global(.no-animations *) {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
  }

  .app-topbar {
    position: fixed;
    top: var(--safe-top);
    left: 0; right: 0;
    height: 0; /* zero height — hamburger floats absolutely */
    z-index: 40;
    pointer-events: none;
  }

  .hamburger {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    left: 12px;
    width: 40px; height: 40px;
    border-radius: var(--radius-md);
    /* Translucent backdrop-blur pill so the button reads cleanly over the
       banner image AND over plain page background (when banners are off). */
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    z-index: 41;
    pointer-events: all;
    color: #ffffff;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    transition: background var(--dur-fast), transform var(--dur-fast) var(--ease-spring);
  }
  .hamburger:hover  { background: rgba(0, 0, 0, 0.5); }
  .hamburger:active { transform: scale(0.92); }

  .topbar-spacer { flex: 1; }

  :global(.page-transition) {
    position: fixed;
    top: 0;
    left: var(--sidebar-w, 0px);
    right: 0;
    bottom: 0;
    overflow-y: auto;
    transition: left 0.25s ease;
  }
  :global(.bottom-nav) {
    left: var(--sidebar-w, 0px) !important;
    transition: left 0.25s ease !important;
  }
  :global(.diary-bottom-bar) {
    left: var(--sidebar-w, 0px) !important;
    transition: left 0.25s ease !important;
  }

  /* ── Connection badge on hamburger ── */
  .conn-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--surface-1);
    transition: background 0.3s;
  }
  .conn-offline {
    background: var(--error, #ef4444);
    color: #fff;
  }

  /* ── Actionable server-connection banner ── */
  .sync-connection-banner {
    position: fixed;
    top: calc(var(--safe-top) + 60px);
    left: calc(var(--sidebar-w, 0px) + 12px);
    right: 12px;
    z-index: 250;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    color: var(--error, #f87171);
    background: color-mix(in srgb, var(--error, #f87171) 8%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--error, #f87171) 25%, var(--border));
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    font-size: 12px;
    font-weight: 500;
    transition: left 0.25s ease;
  }
  .sync-connection-icon {
    flex: 0 0 auto;
    font-size: 18px;
  }
  .sync-connection-copy {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.35;
  }
  .sync-connection-copy strong { font-size: 13px; }
  .sync-connection-copy span {
    color: var(--text-2);
    font-weight: 400;
  }
  .sync-retry,
  .sync-dismiss {
    flex: 0 0 auto;
    border: 0;
    color: var(--error, #f87171);
    background: transparent;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .sync-retry:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .sync-dismiss {
    display: flex;
    align-items: center;
    padding: 2px;
  }
  .sync-dismiss .material-symbols-rounded { font-size: 18px; }

  /* ── Native pull-to-sync indicator ── */
  .pull-sync-indicator {
    position: fixed;
    top: calc(var(--safe-top) + 8px);
    left: calc(var(--sidebar-w, 0px) + (100vw - var(--sidebar-w, 0px)) / 2);
    z-index: 251;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    background: var(--surface-3);
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    box-shadow: var(--shadow-lg);
    pointer-events: none;
    transition: color 120ms, border-color 120ms;
  }
  .pull-sync-indicator.ready-to-sync {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }
  .pull-sync-indicator .material-symbols-rounded {
    font-size: 20px;
    transition: transform 120ms;
  }
  .pull-sync-indicator.ready-to-sync .material-symbols-rounded {
    transform: rotate(180deg);
  }
  @keyframes pull-sync-spin {
    to { transform: rotate(360deg); }
  }
  .pull-sync-indicator .pull-sync-spin {
    animation: pull-sync-spin 0.8s linear infinite;
  }

</style>
