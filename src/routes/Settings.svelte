<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { slide, fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { portal } from '../lib/portal.js';
  import { getLogBufferText, clearLogBuffer, isVerboseLogging, setVerboseLogging, getLogFileUri, getLastCrashFileUri, hasCrashReport, clearCrashReport } from '../lib/log-capture.js';
  import Toggle from '../components/settings/Toggle.svelte';

  import SettingsWellness from '../components/settings/SettingsWellness.svelte';
  import SettingsTrace from '../components/settings/SettingsTrace.svelte';
  import SettingsNotifications from '../components/settings/SettingsNotifications.svelte';
  import SettingsUserManagement from '../components/settings/SettingsUserManagement.svelte';
  import SettingsAuth from '../components/settings/SettingsAuth.svelte';
  import SettingsApiTokens from '../components/settings/SettingsApiTokens.svelte';
  import SettingsBackup from '../components/settings/SettingsBackup.svelte';
  import SettingsImportExport from '../components/settings/SettingsImportExport.svelte';
  import SettingsNutritionImport from '../components/settings/SettingsNutritionImport.svelte';
  import { APP_VERSION } from '../lib/version.js';
  import Sheet  from '../components/ui/Sheet.svelte';
  import SettingsBanner from '../components/banners/SettingsBanner.svelte';

  import { showSuccess, showError } from '../stores/toast.js';
  import { applyAppearance, applyAccentColor } from '../stores/settings.js';
  import { catName as _catName, catDisplay as _catDisplay, scheduleSave } from '../stores/settings.js';
  import 'emoji-picker-element';
  import {
    appearance, accentColor, energyUnit, mealNames,
    diaryShowBrands, diaryShowTimestamps, diaryShowThumbnails, diaryShowAllNutrients,
    diaryShowNutritionUnits, diaryShowMacroSummary, diaryPromptQuantity, diaryShowPortionSize,
    diaryShowNotes,
    diaryShowActivity, manualActivityPolicy, calorieAdjustFromActivity,
    diaryShowNutritionBar,
    foodsShowCategories, foodsShowLabels, foodsShowNotes, foodsShowThumbnails, foodsShowYesterdayMeals, foodsSort, mealsSort, recipesSort,
    barcodeBeep, barcodeFlashlight, cropPhotos,
    foodCategories, customUnits, visibleNutriments, nutrimentsOrder, customNutriments,
    bodyStatsOrder, hiddenBodyStats,
    dateFormat, timeFormat,
    sidebarPersistent, goalCelebrations, pageBanners, language,
    waterGoalMl, waterUnit, waterContainers, waterShowInStats, waterShowInDiary,
    calorieGoalMode, calorieGoalFactor,
    fitbitEnabled, garminEnabled, healthConnectEnabled,
    fastingEnabled, fastingDefaultHours, fastingNotifyOnGoal,
    fastingScheduleEnabled, fastingScheduleTime, fastingScheduleDays, fastingScheduleGoal,
  } from '../stores/settings.js';
  $: _hasWearable = $fitbitEnabled || $garminEnabled || $healthConnectEnabled;
  import { mealIcon } from '../lib/mealIcon.js';
  import { DB } from '../lib/db.js';
  import { NtApi } from '../lib/api.js';
  import { NUTRIMENTS } from '../lib/nutrition.js';
  import { UNIT_GROUPS } from '../lib/units.js';
  import ConnectionStatus from '../components/settings/ConnectionStatus.svelte';
  import { currentUser, userMgmtActive, serverFeatures } from '../stores/auth.js';
  import { isNative, getServerUrl, setServerUrl, setNativeMode, getNativeMode, setAuthToken, apiUrl, getAuthToken, resolveAssetUrl, explainConnectError } from '../lib/platform.js';
  import { _ } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../i18n/index.js';

  function _fetchOpts(extra = {}) {
    const h = { ...extra };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return { credentials: 'include', headers: h };
  }

  // ── Collapsible section state ──────────────────────────────────────────────
  $: isDark = $appearance === 'dark' || ($appearance === 'system' && (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches));
  let openSections = { serverConnection: false, appearance: false, regional: false, diary: false, foods: false, water: false,
                       categories: false, customUnits: false, nutrients: false, goals: false, bodyStats: false, statistics: false,
                       connectedServices: false, ai: false, notifications: false, wellness: false, sharing: false,
                       authentication: false, apiTokens: false, backup: false, importExport: false, email: false, users: false, helpImprove: false, about: false };

  // ── Sync state + manual trigger ────────────────────────────────────────
  // Native server mode only. lastSyncAt comes from sync_meta on mount and is
  // kept in sync with the live syncState.lastSync as background syncs fire.
  let lastSyncAt = null;
  let _nowTick = Date.now(); // re-render the "X ago" label every 30s
  let _syncing = false;

  async function manualSync() {
    if (_syncing) return;
    _syncing = true;
    try {
      const { fullSync } = await import('../lib/sync.js');
      await fullSync(); // visible mode (shows the sync bar in App.svelte)
    } catch (e) {
      showError(e.message || 'Sync failed');
    } finally {
      _syncing = false;
    }
  }

  function _fmtTimeAgo(iso) {
    if (!iso) return 'never';
    const ms = _nowTick - new Date(iso).getTime();
    if (ms < 0) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 10)  return 'just now';
    if (s < 60)  return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)  return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  // ── Server Connection (native only) ─────────────────────────────────────
  let serverUrlInput = getServerUrl() || '';
  let serverUsername = '';
  let serverPassword = '';
  let serverShowPw = false;
  let serverConnecting = false;
  let serverMode = getNativeMode(); // 'local' | 'server'
  // True when running as a standalone phone app (hide multi-user / server
  // features). Reactive on serverMode so the UI updates instantly when the
  // user disconnects, without waiting for the post-disconnect reload.
  $: isNativeLocal = isNative && (serverMode !== 'server' || !getServerUrl());

  // ── Server connect/merge flow ──────────────────────────────────────────────
  let mergeStep = null;  // null | 'ask-settings' | 'syncing' | 'summary'
  let mergeProgress = '';
  let mergeProgressPct = 0;
  let mergeStage = '';   // current stage label for progress bar
  let _pendingServerUrl = '';
  let _pendingToken = null; // cookie is set by login, but we keep the URL
  let localCounts = null;   // { foods, meals, recipes, diary, settings, total } | null
  let migrationSummary = null;  // { success, errors, totalSuccess, total } | null

  async function connectServer() {
    if (!serverUrlInput.trim()) { showError('Enter a server URL'); return; }
    if (!serverUsername.trim() || !serverPassword.trim()) { showError('Enter credentials'); return; }
    const url = serverUrlInput.trim().replace(/\/$/, '');
    serverConnecting = true;
    try {
      // Use CapacitorHttp on native to bypass CORS (WebView fetch can't reach external origins)
      let loginData;
      if (isNative) {
        const { CapacitorHttp } = await import('@capacitor/core');
        const healthRes = await CapacitorHttp.get({ url: `${url}/api/health` });
        if (healthRes.status < 200 || healthRes.status >= 300) throw new Error('Server not reachable');
        const loginRes = await CapacitorHttp.post({
          url: `${url}/api/auth/login`,
          headers: { 'Content-Type': 'application/json' },
          data: { username: serverUsername.trim(), password: serverPassword },
        });
        loginData = typeof loginRes.data === 'string' ? JSON.parse(loginRes.data) : loginRes.data;
        if (loginRes.status < 200 || loginRes.status >= 300) throw new Error(loginData.error || 'Login failed');
      } else {
        const healthRes = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
        if (!healthRes.ok) throw new Error('Server not reachable');
        const loginRes = await fetch(`${url}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: serverUsername.trim(), password: serverPassword }),
        });
        loginData = await loginRes.json();
        if (!loginRes.ok) throw new Error(loginData.error || 'Login failed');
      }

      _pendingServerUrl = url;
      if (loginData.token) setAuthToken(loginData.token);

      // Count local data so the merge dialog can show what's about to move
      const { countLocalData } = await import('../lib/migrate.js');
      localCounts = await countLocalData();

      if (localCounts.total > 0) {
        mergeStep = 'ask-settings';
      } else {
        // No local data — just connect directly
        _finalizeConnect();
      }
    } catch (e) {
      showError(explainConnectError(e, url));
    } finally {
      serverConnecting = false;
    }
  }

  async function _mergeAndConnect(mode) {
    mergeStep = 'syncing';
    mergeProgress = '';
    mergeProgressPct = 0;
    mergeStage = '';
    migrationSummary = null;

    const url = _pendingServerUrl;
    const token = getAuthToken();

    try {
      if (mode === 'upload' || mode === 'merge') {
        const { uploadLocalToServer } = await import('../lib/migrate.js');
        const stageLabels = {
          settings: 'settings',
          foods:    'foods',
          meals:    'meals',
          recipes:  'recipes',
          diary:    'diary entries',
        };
        migrationSummary = await uploadLocalToServer({
          serverUrl: url,
          authToken: token,
          onProgress: (stage, current, total) => {
            mergeStage = stageLabels[stage] || stage;
            mergeProgress = `Uploading ${mergeStage} (${current + 1} / ${total})`;
            mergeProgressPct = total > 0 ? Math.round(((current + 1) / total) * 100) : 0;
          },
        });
      }

      // mode === 'download' or 'merge': server data is pulled on reload via
      // loadServerSettings + NtApiCached.
      // mode === 'upload': server settings stay, local data pushed up.

      // If anything was uploaded, show the summary before finalizing so the
      // user can see per-table results and any errors. Otherwise (download
      // mode, or no errors and nothing to report) finalize directly.
      if (migrationSummary && (migrationSummary.errors.length > 0 || migrationSummary.totalSuccess > 0)) {
        mergeStep = 'summary';
      } else {
        _finalizeConnect();
      }
    } catch (e) {
      mergeStep = null;
      showError('Sync failed: ' + (e.message || 'Unknown error'));
    }
  }

  function _finalizeConnect() {
    setServerUrl(_pendingServerUrl);
    setNativeMode('server');
    DB.setSetting('setupComplete', true);
    serverMode = 'server';
    mergeStep = null;
    showSuccess('Connected to server');
    setTimeout(() => window.location.reload(), 600);
  }

  function cancelMerge() {
    mergeStep = null;
    _pendingServerUrl = '';
    localCounts = null;
    migrationSummary = null;
  }

  async function disconnectServer() {
    // Clear server-mode infrastructure
    setServerUrl(null);
    setAuthToken(null);
    setNativeMode('local');

    // Clear cached auth state so loadAuthState's local branch runs cleanly
    // after the reload. Without this, the cached user + userMgmtActive flag
    // survives in localStorage and the UI keeps showing Sign Out / connected
    // state even though no server is reachable.
    localStorage.removeItem('wl:userId');
    localStorage.removeItem('nt:cachedUser');
    localStorage.removeItem('nt:cachedUserMgmt');
    localStorage.removeItem('nt:csrf');

    // Reset Svelte stores immediately so any open Settings panels
    // re-render to the disconnected state before the reload kicks in.
    currentUser.set(null);
    userMgmtActive.set(false);

    // Local UI state
    serverMode = 'local';
    serverUrlInput = '';
    serverUsername = '';
    serverPassword = '';

    showSuccess('Disconnected — using local storage');
    setTimeout(() => window.location.reload(), 600);
  }

  async function logoutServer() {
    document.body.style.transition = 'opacity 0.3s';
    document.body.style.opacity = '0';
    // Use the proper logout flow so the server-side JWT cookie is invalidated.
    // The previous version only cleared local Bearer + cache, but the cookie
    // stayed valid; the next /api/auth/me fetch would silently re-authenticate
    // and put the user right back in. Hits /api/auth/logout, clears Bearer
    // token, clears local cache, resets the stores.
    try {
      const { logout } = await import('../stores/auth.js');
      await logout();
    } catch {}
    setTimeout(() => window.location.reload(), 300);
  }

  function toggleSection(key) {
    openSections = { ...openSections, [key]: !openSections[key] };
  }

  // ── Settings search ────────────────────────────────────────────────────────
  let settingsSearch = '';
  $: settingsQuery = settingsSearch.toLowerCase().trim();

  const SECTION_KEYWORDS = {
    serverConnection:  ['server','connection','sync','cloud','local','remote','connect','disconnect','url'],
    authentication:    ['authentication','auth','sso','single sign-on','single sign on','oidc','openid','authentik','keycloak','authelia','pocket id','auth0','google','password login','admin group'],
    appearance:        ['appearance','theme','dark','light','accent','color','navigation','sidebar','persistent','start page','animations','celebrations','reduce motion','banner','page banner'],
    regional:          ['regional','language','translation','date format','time format','locale','date','time','12h','24h','units','energy unit','weight unit','height','circumference','distance','temperature','imperial','metric'],
    diary:             ['diary','brands','timestamps','thumbnails','nutrients','nutrition units','macros','macro summary','prompt quantity','portion size','nutrition bar','goals progress','meal names','meals','activity','activity section','exercise','fasting','fast','intermittent fasting','if','16:8','omad','time restricted'],
    foods:             ['foods','thumbnails','category','notes','yesterday meals','sort order','sort','barcode','scan','beep','flashlight','crop photos'],
    water:             ['water','display unit','daily goal','containers','bottle','cup','glass'],
    categories:        ['categories','food categories','tags','labels'],
    customUnits:       ['units','custom units','unit dropdown','shot','scoop','stick','add unit'],
    nutrients:         ['nutrients','nutriments','custom nutrients','vitamins','minerals'],
    goals:             ['goals','calorie goal','dynamic calorie','adaptive','adaptive tdee','adaptive calorie','tdee','energy expenditure','burn','calories out','factor','lose','gain','maintain','activity','exercise','weight trend','macrofactor','learn','fixed'],
    bodyStats:         ['body stats','body','weight','measurements','stats'],
    statistics:        ['statistics','chart','y-axis','average','goal line','trend','stats'],
    connectedServices: ['food sources','connected services','usda','open food facts','mealie','recipe','search language','country','api key','credentials','username','password'],
    ai:                ['ai','trace','assistant','provider','model','api key','artificial intelligence','chat','smart log','voice','quick log','goal insights','claude','openai','gemini','ollama','lm studio','deepseek','groq','openai compatible','oai-compat','base url'],
    notifications:     ['notifications','reminders','water reminder','meal reminder','weigh-in','weigh in','gotify','apprise','ntfy','push','alerts','wellness alerts','goal celebration','weekly summary','email summary'],
    wellness:          ['wellness','activity tracking','fitbit','withings','garmin','health connect','steps','sleep','heart rate','hrv','spo2','sync mode','sync range','connect','disconnect','connected devices','fitness tracker','body battery','stress'],
    sharing:           ['sharing','share','group','catalogue','catalog','visibility','private','members','food sharing'],
    backup:            ['backup','full backup','restore','zip','images','clear data','reset','defaults','clear settings','danger zone'],
    importExport:      ['import','export','import & export','json','csv','bulk import','foods bulk','myfitnesspal','mfp','loseit','lose it','cronometer','spreadsheet','migrate','migration','from another app','diary csv'],
    email:             ['email','smtp','mail','password reset','invites','notifications'],
    profile:           ['profile','my profile','account','name','nickname','birthday','dob','gender','sex','avatar','log out','logout','sign out','password','change password','biometric','fingerprint','face unlock','face id'],
    users:             ['users','user management','accounts','login','admin','register','invite','revoke','pending invite','session','session duration','password policy','strong password','strong passwords','require strong','zxcvbn'],
    apiTokens:         ['api','api tokens','token','federation','cooktrace','lifttrace','bearer','integration','integrations','external','third-party','third party'],
    helpImprove:       ['diagnostics','logs','verbose','calibration','export','bug','report','troubleshoot'],
    about:             ['about','version','nutritrace'],
  };

  function sectionVisible(query, key) {
    if (!query) return true;
    return (SECTION_KEYWORDS[key] || []).some(kw => kw.includes(query));
  }

  function sectionOpen(sections, query, key) {
    return sections[key] || (!!query && sectionVisible(query, key));
  }

  // ── Appearance ─────────────────────────────────────────────────────────────
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
  const ENERGY_OPTS = [
    { value: 'kcal', label: 'Calories (kcal)' },
    { value: 'kJ',   label: 'Kilojoules (kJ)'  },
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
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { _viewportW = window.innerWidth; });
  }
  $: _persistentAllowed = _viewportW >= 768;

  // ── Water ──────────────────────────────────────────────────────────────────
  function _mlToDisplay(ml, unit) {
    if (unit === 'oz') return +(ml / 29.5735).toFixed(1);
    if (unit === 'L')  return +(ml / 1000).toFixed(2);
    if (unit === 'G')  return +(ml / 3785.41).toFixed(3);
    return ml;
  }
  function _displayToMl(val, unit) {
    const n = Number(val);
    if (unit === 'oz') return Math.round(n * 29.5735);
    if (unit === 'L')  return Math.round(n * 1000);
    if (unit === 'G')  return Math.round(n * 3785.41);
    return Math.round(n);
  }
  $: _waterGoalDisplay = _mlToDisplay($waterGoalMl, $waterUnit);
  function _updateWaterGoal(val) { waterGoalMl.set(_displayToMl(val, $waterUnit)); }

  let _newContName   = '';
  let _newContVolume = '';
  let _newContUnit   = 'ml';
  function addContainer() {
    const name = _newContName.trim();
    const vol  = Number(_newContVolume);
    if (!name || !vol || vol <= 0) { showError('Enter a valid name and volume'); return; }
    waterContainers.set([...$waterContainers, { id: Date.now().toString(), name, volumeMl: _displayToMl(vol, _newContUnit) }]);
    _newContName = ''; _newContVolume = '';
  }
  function removeContainer(id) { waterContainers.set($waterContainers.filter(c => c.id !== id)); }

  // ── Statistics ─────────────────────────────────────────────────────────────
  let statsChartType = DB.getSetting('statsChartType', 'bar');
  let statsYZero     = DB.getSetting('statsYZero',     true);
  let statsIncludeTodayLocal = DB.getSetting('statsIncludeToday', false);
  let statsShowEmptyDaysLocal = DB.getSetting('statsShowEmptyDays', true);
  let statsAvgLine   = DB.getSetting('statsAvgLine',   true);
  let statsGoalLine  = DB.getSetting('statsGoalLine',  true);
  let statsTrendLine = DB.getSetting('statsTrendLine', true);



  // ── Units ──────────────────────────────────────────────────────────────────
  let weightUnit  = DB.getSetting('weightUnit',  'lb');
  let heightUnit  = DB.getSetting('heightUnit',  'ft');
  let lengthUnit  = DB.getSetting('lengthUnit',  'in');
  let distUnitVal = DB.getSetting('distUnit',    'km');
  let tempUnitVal = DB.getSetting('tempUnit',    'F');

  // ── API keys ───────────────────────────────────────────────────────────────
  let usdaApiKey    = DB.getSetting('usdaApiKey',    '');
  let offUsername   = DB.getSetting('offUsername',   '');
  let offPassword   = DB.getSetting('offPassword',   '');
  let offShowPass   = false;
  let usdaEnabled   = DB.getSetting('usdaEnabled',   false);
  let offEnabled    = DB.getSetting('offEnabled',    true);

  const OFF_LANGUAGE_OPTS = [
    ['en','English'],['fr','French'],['de','German'],['es','Spanish'],['it','Italian'],
    ['pt','Portuguese'],['nl','Dutch'],['pl','Polish'],['ru','Russian'],['ja','Japanese'],
    ['zh','Chinese'],['ar','Arabic'],['ko','Korean']
  ];
  const OFF_COUNTRY_OPTS = ['World','United States','United Kingdom','Australia','Canada',
    'France','Germany','Spain','Italy','Mexico','Brazil','Japan','China','India'];
  let offSearchLanguage = DB.getSetting('offSearchLanguage', 'en');
  let offSearchCountry  = DB.getSetting('offSearchCountry',  'World');
  let offUploadCountry  = DB.getSetting('offUploadCountry',  'Auto');
  let offImportPortion  = DB.getSetting('offImportPortion',  'per100g');

  // ── Mealie ─────────────────────────────────────────────────────────────────
  let mealieEnabled    = DB.getSetting('mealieEnabled',   false);
  let mealieBaseUrl    = DB.getSetting('mealieBaseUrl',   '');
  let mealieApiToken   = DB.getSetting('mealieApiToken',  '');
  let mealieShowToken  = false;
  let mealieTestStatus = ''; // '', 'testing', 'ok', 'fail' — raw test result
  // Banner status: show "ok" as soon as both fields are populated so users
  // see the connection card immediately. Real test result overrides on
  // testing/fail. Same shape AI Assistant uses for its banner.
  $: mealieBannerStatus = (mealieTestStatus === 'testing' || mealieTestStatus === 'fail')
    ? mealieTestStatus
    : (mealieBaseUrl && mealieApiToken ? 'ok' : '');
  async function testMealieConnection() {
    if (!mealieBaseUrl || !mealieApiToken) {
      mealieTestStatus = 'fail';
      showError('Mealie test failed: URL and token both required');
      return;
    }
    mealieTestStatus = 'testing';
    try {
      // POST goes through the server's CSRF middleware; raw fetch needs the
      // X-CSRF-Token header (PWA cookie auth) or Authorization bearer (native
      // server mode). Issue #24: this was missing and every Test click 403'd.
      const headers = { 'Content-Type': 'application/json' };
      if (isNative && getServerUrl()) {
        const token = getAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } else if (!isNative) {
        const csrf = localStorage.getItem('nt:csrf');
        if (csrf) headers['X-CSRF-Token'] = csrf;
      }
      const res = await fetch(apiUrl('/api/mealie/proxy'), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          baseUrl: mealieBaseUrl,
          token:   mealieApiToken,
          path:    '/api/recipes?perPage=1&page=1',
        }),
      });
      if (res.ok) {
        mealieTestStatus = 'ok';
        showSuccess('Mealie connection verified');
      } else {
        mealieTestStatus = 'fail';
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) detail = j.error; } catch {}
        showError(`Mealie test failed: ${detail}`);
      }
    } catch (e) {
      mealieTestStatus = 'fail';
      showError(`Mealie test failed: ${e?.message || 'network error'}`);
    }
  }

  // ── Wellness ── (extracted to SettingsWellness.svelte)
  let wellnessRef;

  // ── Meal names ─────────────────────────────────────────────────────────────
  let meals = [...(DB.getSetting('mealNames', ['Breakfast','Lunch','Dinner','Snacks']))];

  // ── Categories ─────────────────────────────────────────────────────────────
  let newCategoryName  = '';
  let newCategoryLabel = '';

  // Emoji picker — mounted imperatively on document.body to avoid
  // position:fixed being trapped by any scrolling/transformed ancestor
  let _emojiPortal = null;

  function _destroyEmojiPicker() {
    if (_emojiPortal) { _emojiPortal.remove(); _emojiPortal = null; }
    document.removeEventListener('pointerdown', _emojiOutside, true);
  }

  function _emojiOutside(e) {
    if (_emojiPortal && !_emojiPortal.contains(e.target)) _destroyEmojiPicker();
  }

  function openEmojiPicker(e) {
    if (_emojiPortal) { _destroyEmojiPicker(); return; }

    const rect    = e.currentTarget.getBoundingClientRect();
    const pickerH = 420;
    const pickerW = 320;
    const margin  = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer below button; flip above if it would overflow bottom
    let y = rect.bottom + margin;
    if (y + pickerH > vh - margin) y = rect.top - pickerH - margin;
    // Final clamp so it never leaves the viewport
    y = Math.min(Math.max(y, margin), vh - pickerH - margin);

    let x = rect.left;
    if (x + pickerW > vw - margin) x = vw - pickerW - margin;
    x = Math.max(x, margin);

    _emojiPortal = document.createElement('div');
    _emojiPortal.style.cssText =
      `position:fixed;left:${x}px;top:${y}px;z-index:99999;` +
      `border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.35)`;

    const picker = document.createElement('emoji-picker');
    // Inherit CSS custom properties from the document root
    picker.style.cssText =
      '--border-radius:12px;' +
      `--background:${getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim()};` +
      `--border-color:${getComputedStyle(document.documentElement).getPropertyValue('--border').trim()};` +
      `--input-border-color:${getComputedStyle(document.documentElement).getPropertyValue('--border').trim()};` +
      `--input-font-color:${getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim()};` +
      `--input-placeholder-color:${getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim()};` +
      '--category-emoji-size:1.1rem;--emoji-size:1.4rem';
    picker.addEventListener('emoji-click', ev => {
      newCategoryLabel = ev.detail.unicode;
      _destroyEmojiPicker();
    });

    _emojiPortal.appendChild(picker);
    document.body.appendChild(_emojiPortal);
    setTimeout(() => document.addEventListener('pointerdown', _emojiOutside, true), 50);
  }

  function clickOutside(node, fn) {
    function handle(e) { if (!node.contains(e.target)) fn(); }
    document.addEventListener('pointerdown', handle, true);
    return { destroy() { document.removeEventListener('pointerdown', handle, true); } };
  }

  function addCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    const cats = get(foodCategories) || [];
    if (cats.some(c => _catName(c) === name)) return;
    const label = newCategoryLabel.trim();
    foodCategories.set([...cats, label ? { name, label } : name]);
    newCategoryName = '';
    newCategoryLabel = '';
  }
  function removeCategory(cat) {
    const n = _catName(cat);
    foodCategories.set((get(foodCategories) || []).filter(c => _catName(c) !== n));
  }

  // ── Custom units ──────────────────────────────────────────────────────────
  let newUnitAbbr = '';
  let newUnitFull = '';

  function addCustomUnit() {
    const abbr = newUnitAbbr.trim();
    const full = newUnitFull.trim() || abbr;
    if (!abbr) return;
    const existing = get(customUnits) || [];
    // Dedup by abbr against both existing customs and the built-in catalog.
    const builtIn = new Set(UNIT_GROUPS.flatMap(g => g.units.map(u => u.abbr.toLowerCase())));
    if (builtIn.has(abbr.toLowerCase())) return; // already in catalog
    if (existing.some(c => c.abbr.toLowerCase() === abbr.toLowerCase())) return;
    customUnits.set([...existing, { abbr, full }]);
    newUnitAbbr = '';
    newUnitFull = '';
  }
  function removeCustomUnit(unit) {
    customUnits.set((get(customUnits) || []).filter(c => c.abbr !== unit.abbr));
  }

  // ── Custom nutrients ───────────────────────────────────────────────────────
  let showNutrientSheet = false;
  let newNutrient = { id: '', label: '', unit: 'g' };

  function addCustomNutrient() {
    if (!newNutrient.label.trim()) return;
    const id = 'custom_' + newNutrient.label.toLowerCase().replace(/\s+/g,'_');
    const existing = DB.getSetting('customNutriments', []);
    if (!existing.find(n => n.id === id)) {
      customNutriments.set([...existing, { ...newNutrient, id }]);
    }
    newNutrient = { id:'', label:'', unit:'g' };
    showNutrientSheet = false;
  }
  function removeCustomNutrient(id) {
    const existing = DB.getSetting('customNutriments', []);
    customNutriments.set(existing.filter(n => n.id !== id));
  }

  // ── Nutrient ordering ─────────────────────────────────────────────────────
  $: orderedNutriments = (() => {
    const order = $nutrimentsOrder || [];
    if (!order.length) return NUTRIMENTS;
    const map = new Map(NUTRIMENTS.map(n => [n.id, n]));
    const sorted = order.map(id => map.get(id)).filter(Boolean);
    const rest   = NUTRIMENTS.filter(n => !order.includes(n.id));
    return [...sorted, ...rest];
  })();

  // Drag-to-reorder for nutrients
  let nutDragFrom = null, nutDragOver = null, nutDragDelta = 0, nutRowHeights = [];
  function onNutDragDown(e, i) {
    const list = e.currentTarget.closest('.drag-list');
    const rows = [...list.querySelectorAll('.drag-row')];
    nutRowHeights = rows.map(r => r.getBoundingClientRect().height);
    nutDragFrom = i; nutDragOver = i; nutDragDelta = 0;
    list.setPointerCapture(e.pointerId);
    list._dragStartY = e.clientY;
  }
  function onNutDragMove(e) {
    if (nutDragFrom === null) return;
    nutDragDelta = e.clientY - e.currentTarget._dragStartY;
    const rows = [...e.currentTarget.querySelectorAll('.drag-row')];
    const y = e.clientY;
    let best = nutDragOver;
    for (let idx = 0; idx < rows.length; idx++) {
      if (idx === nutDragFrom) continue;
      const r = rows[idx].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { best = idx; break; }
    }
    nutDragOver = best;
  }
  function onNutDragUp() {
    if (nutDragFrom !== null && nutDragOver !== null && nutDragFrom !== nutDragOver) {
      const order = ($nutrimentsOrder && $nutrimentsOrder.length)
        ? [...$nutrimentsOrder] : orderedNutriments.map(n => n.id);
      const [removed] = order.splice(nutDragFrom, 1);
      order.splice(nutDragOver, 0, removed);
      nutrimentsOrder.set(order);
    }
    nutDragFrom = null; nutDragOver = null; nutDragDelta = 0; nutRowHeights = [];
  }

  // ── Nutrient visibility ────────────────────────────────────────────────────
  function toggleNutrientVisible(id) {
    let vis = DB.getSetting('visibleNutriments', null);
    if (!vis) vis = NUTRIMENTS.filter(n => n.default).map(n => n.id);
    if (vis.includes(id)) {
      visibleNutriments.set(vis.filter(v => v !== id));
    } else {
      visibleNutriments.set([...vis, id]);
    }
  }
  function isNutrientVisible(id) {
    const vis = $visibleNutriments;
    if (!vis) return NUTRIMENTS.find(n => n.id === id)?.default ?? false;
    return vis.includes(id);
  }

  // ── Body stats ordering ───────────────────────────────────────────────────
  $: orderedBodyStats = (() => {
    const order = $bodyStatsOrder || [];
    if (!order.length) return BODY_STATS;
    const map = new Map(BODY_STATS.map(s => [s.id, s]));
    const sorted = order.map(id => map.get(id)).filter(Boolean);
    const rest   = BODY_STATS.filter(s => !order.includes(s.id));
    return [...sorted, ...rest];
  })();

  // Drag-to-reorder for body stats
  let statDragFrom = null, statDragOver = null, statDragDelta = 0, statRowHeights = [];
  function onStatDragDown(e, i) {
    const list = e.currentTarget.closest('.drag-list');
    const rows = [...list.querySelectorAll('.drag-row')];
    statRowHeights = rows.map(r => r.getBoundingClientRect().height);
    statDragFrom = i; statDragOver = i; statDragDelta = 0;
    list.setPointerCapture(e.pointerId);
    list._dragStartY = e.clientY;
  }
  function onStatDragMove(e) {
    if (statDragFrom === null) return;
    statDragDelta = e.clientY - e.currentTarget._dragStartY;
    const rows = [...e.currentTarget.querySelectorAll('.drag-row')];
    const y = e.clientY;
    let best = statDragOver;
    for (let idx = 0; idx < rows.length; idx++) {
      if (idx === statDragFrom) continue;
      const r = rows[idx].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { best = idx; break; }
    }
    statDragOver = best;
  }
  function onStatDragUp() {
    if (statDragFrom !== null && statDragOver !== null && statDragFrom !== statDragOver) {
      const order = ($bodyStatsOrder && $bodyStatsOrder.length)
        ? [...$bodyStatsOrder] : orderedBodyStats.map(s => s.id);
      const [removed] = order.splice(statDragFrom, 1);
      order.splice(statDragOver, 0, removed);
      bodyStatsOrder.set(order);
    }
    statDragFrom = null; statDragOver = null; statDragDelta = 0; statRowHeights = [];
  }

  // Compute translateY for a non-dragging row given current drag state
  function dragShift(i, from, over, heights) {
    if (from === null || over === null || i === from || from === over) return 0;
    const h = heights[from] || 52;
    if (from < over && i > from && i <= over) return -h;  // dragging down: items above shift up
    if (from > over && i >= over && i < from) return h;   // dragging up: items below shift down
    return 0;
  }

  // ── Body stats visibility ──────────────────────────────────────────────────
  const BODY_STATS = [
    { id:'weight', label:'Weight' }, { id:'neck', label:'Neck' }, { id:'waist', label:'Waist' },
    { id:'hips', label:'Hips' }, { id:'chest', label:'Chest' }, { id:'thighs', label:'Thighs' },
    { id:'biceps', label:'Biceps' }, { id:'calves', label:'Calves' }, { id:'body_fat', label:'Body Fat %' },
  ];
  function isStatVisible(id) {
    const hidden = $hiddenBodyStats || [];
    return !hidden.includes(id);
  }
  function toggleStatVisible(id) {
    const hidden = DB.getSetting('hiddenBodyStats', []);
    if (hidden.includes(id)) {
      hiddenBodyStats.set(hidden.filter(h => h !== id));
    } else {
      hiddenBodyStats.set([...hidden, id]);
    }
  }

  // ── Save helpers ───────────────────────────────────────────────────────────
  function set(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  function autoSaveMeals() {
    const toSave = meals.filter(m => m.trim());
    if (toSave.length) mealNames.set(toSave);
  }

  // Drag-to-reorder for meal names
  let mealDragFrom = null, mealDragOver = null, mealDragDelta = 0, mealRowHeights = [];
  function onMealDragDown(e, i) {
    const list = e.currentTarget.closest('.drag-list');
    const rows = [...list.querySelectorAll('.drag-row')];
    mealRowHeights = rows.map(r => r.getBoundingClientRect().height);
    mealDragFrom = i; mealDragOver = i; mealDragDelta = 0;
    list.setPointerCapture(e.pointerId);
    list._dragStartY = e.clientY;
  }
  function onMealDragMove(e) {
    if (mealDragFrom === null) return;
    mealDragDelta = e.clientY - e.currentTarget._dragStartY;
    const rows = [...e.currentTarget.querySelectorAll('.drag-row')];
    const y = e.clientY;
    let best = mealDragOver;
    for (let idx = 0; idx < rows.length; idx++) {
      if (idx === mealDragFrom) continue;
      const r = rows[idx].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { best = idx; break; }
    }
    mealDragOver = best;
  }
  function onMealDragUp() {
    if (mealDragFrom !== null && mealDragOver !== null && mealDragFrom !== mealDragOver) {
      const reordered = [...meals];
      const [removed] = reordered.splice(mealDragFrom, 1);
      reordered.splice(mealDragOver, 0, removed);
      meals = reordered;
      autoSaveMeals();
    }
    mealDragFrom = null; mealDragOver = null; mealDragDelta = 0; mealRowHeights = [];
  }

  // ── Backup ref (for triggering load when section opens) ───────────────────
  let backupRef;
  $: if (openSections.backup && $currentUser?.role === 'admin' && !isNativeLocal) backupRef?.loadFullBackups();
  $: if (openSections.backup && isNativeLocal) backupRef?.loadLocalBackups();

  // ── Sharing ────────────────────────────────────────────────────────────────
  let adminSharingEnabled = false;

  async function loadSharingConfig() {
    try {
      const cfg = await NtApi.getSharingStatus().catch(() => ({}));
      adminSharingEnabled = cfg.sharing_enabled === true;
      // Pre-fill the bulk form from the last-applied per-category state so
      // users don't see 'Private' on every revisit when they actually saved
      // something different.
      if (cfg.bulk) {
        bulkVisFoods    = cfg.bulk.foods?.visibility    || 'private';
        bulkVisMeals    = cfg.bulk.meals?.visibility    || 'private';
        bulkVisRecipes  = cfg.bulk.recipes?.visibility  || 'private';
        bulkUsersFoods   = Array.isArray(cfg.bulk.foods?.user_ids)    ? cfg.bulk.foods.user_ids    : [];
        bulkUsersMeals   = Array.isArray(cfg.bulk.meals?.user_ids)    ? cfg.bulk.meals.user_ids    : [];
        bulkUsersRecipes = Array.isArray(cfg.bulk.recipes?.user_ids)  ? cfg.bulk.recipes.user_ids  : [];
      } else {
        console.warn('[bulk-share] server returned no `bulk` field on /api/app-config/sharing — server probably needs to redeploy');
      }
    } catch (e) {
      console.warn('[bulk-share] loadSharingConfig failed', e);
    }
  }

  async function _saveBulkState() {
    // Persist last-applied state via app-config so the form pre-fills correctly
    // next time (and across devices, since it's server-stored). Routes through
    // _fetchOpts() so CSRF (PWA) / Bearer (native) headers are attached —
    // otherwise PUT /api/app-config silently 403s and the state never persists.
    const _put = async (key, value) => {
      const res = await fetch(apiUrl('/api/app-config'), {
        method: 'PUT',
        ..._fetchOpts({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key, value }),
      }).catch(() => null);
      if (!res || !res.ok) console.warn('[bulk-share] failed to persist', key, res?.status);
    };
    await Promise.all([
      _put('bulk_vis_foods',   bulkVisFoods),
      _put('bulk_vis_meals',   bulkVisMeals),
      _put('bulk_vis_recipes', bulkVisRecipes),
      _put('bulk_users_foods',   JSON.stringify(bulkVisFoods   === 'specific' ? bulkUsersFoods   : [])),
      _put('bulk_users_meals',   JSON.stringify(bulkVisMeals   === 'specific' ? bulkUsersMeals   : [])),
      _put('bulk_users_recipes', JSON.stringify(bulkVisRecipes === 'specific' ? bulkUsersRecipes : [])),
    ]);
  }

  async function saveAdminSharingEnabled(val) {
    adminSharingEnabled = val;
    await fetch(apiUrl('/api/app-config'), {
      method: 'PUT',
      ..._fetchOpts({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ key: 'sharing_enabled', value: val ? 'true' : 'false' }),
    }).catch(() => {});
  }

  // Per-category bulk-share state. Each category has its own visibility +
  // (when 'specific') its own list of selected user ids. Three explicit rows
  // beat one ambiguous multi-select.
  let bulkVisFoods = 'private';
  let bulkVisMeals = 'private';
  let bulkVisRecipes = 'private';
  let bulkUsersFoods = [];
  let bulkUsersMeals = [];
  let bulkUsersRecipes = [];
  let bulkApplying = false;
  let bulkUsers = [];
  let bulkUsersLoaded = false;

  async function loadBulkUsers() {
    if (bulkUsersLoaded) return;
    try { bulkUsers = await NtApi.getUsersList(); bulkUsersLoaded = true; } catch {}
  }

  function toggleBulkUserFor(category, id) {
    const list = category === 'foods' ? bulkUsersFoods : category === 'meals' ? bulkUsersMeals : bulkUsersRecipes;
    const next = list.includes(id) ? list.filter(u => u !== id) : [...list, id];
    if (category === 'foods')   bulkUsersFoods   = next;
    if (category === 'meals')   bulkUsersMeals   = next;
    if (category === 'recipes') bulkUsersRecipes = next;
  }

  // Trigger user-list load when any category flips to 'specific'.
  $: if (bulkVisFoods === 'specific' || bulkVisMeals === 'specific' || bulkVisRecipes === 'specific') loadBulkUsers();

  async function applyBulkShareCategory(category, visibility, user_ids) {
    return NtApi.post('/api/foods/bulk-share', {
      visibility,
      targets: [category],
      user_ids: visibility === 'specific' ? user_ids : [],
    });
  }

  async function applyBulkShare() {
    bulkApplying = true;
    try {
      // Apply each category independently so unticked categories aren't touched
      // and each gets its own visibility.
      await Promise.all([
        applyBulkShareCategory('foods',   bulkVisFoods,   bulkUsersFoods),
        applyBulkShareCategory('meals',   bulkVisMeals,   bulkUsersMeals),
        applyBulkShareCategory('recipes', bulkVisRecipes, bulkUsersRecipes),
      ]);
      // Persist for next time — the form should remember its last state.
      await _saveBulkState();
      showSuccess('Sharing updated');
    } catch(e) { showError('Could not apply: ' + e.message); }
    bulkApplying = false;
  }

  $: if (openSections.sharing) loadSharingConfig();

  // ── Email / SMTP ───────────────────────────────────────────────────────────
  let smtpHost   = '';
  let smtpPort   = '587';
  let smtpSecure = false;
  let smtpUser   = '';
  let smtpPass   = '';
  let smtpShowPass = false;
  let smtpFrom   = '';
  let smtpTestStatus = ''; // '', 'testing', 'ok', 'fail'

  async function loadSmtpConfig() {
    try {
      const res  = await fetch(apiUrl('/api/app-config'), _fetchOpts());
      if (!res.ok) return;
      const cfg  = await res.json();
      smtpHost   = cfg.smtp_host   || '';
      smtpPort   = cfg.smtp_port   || '587';
      smtpSecure = cfg.smtp_secure === 'true';
      smtpUser   = cfg.smtp_user   || '';
      smtpPass   = cfg.smtp_pass   || '';
      smtpFrom   = cfg.smtp_from   || '';
      // Seed the auto-save baseline so a blur right after load doesn't
      // re-PUT the same values.
      _lastSavedSmtp = {
        host: smtpHost, port: String(smtpPort), secure: String(smtpSecure),
        user: smtpUser, pass: smtpPass, from: smtpFrom,
      };
      // Arm auto-save ONLY after the baseline is seeded. Without this,
      // any blur fired during the empty-initial-render window would
      // PUT blank values and wipe the server config.
      _smtpLoaded = true;
    } catch {}
  }

  async function saveSmtpField(key, value) {
    await fetch(apiUrl('/api/app-config'), {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: String(value) }),
    }).catch(() => {});
  }

  // Per-field auto-save guards. Two layers of protection:
  //   1. `_smtpLoaded` is false until loadSmtpConfig has fully populated
  //      the bound vars and seeded the baseline. NO auto-save may fire
  //      before that, otherwise an empty initial blur could overwrite
  //      the server's real config with blanks (which is exactly what
  //      bit a user in the field — public-release regression risk).
  //   2. Same-value short-circuit so a tab-through without an edit
  //      doesn't burn a PUT either.
  let _smtpLoaded = false;
  let _lastSavedSmtp = { host:'', port:'', secure:'', user:'', pass:'', from:'' };
  async function saveSmtpHost()   { if (!_smtpLoaded || smtpHost === _lastSavedSmtp.host) return; _lastSavedSmtp.host = smtpHost; await saveSmtpField('smtp_host', smtpHost); }
  async function saveSmtpPort()   { if (!_smtpLoaded) return; const v = String(smtpPort); if (v === _lastSavedSmtp.port) return; _lastSavedSmtp.port = v; await saveSmtpField('smtp_port', smtpPort); }
  async function saveSmtpSecure() { if (!_smtpLoaded) return; const v = String(smtpSecure); if (v === _lastSavedSmtp.secure) return; _lastSavedSmtp.secure = v; await saveSmtpField('smtp_secure', v); }
  async function saveSmtpUser()   { if (!_smtpLoaded || smtpUser === _lastSavedSmtp.user) return; _lastSavedSmtp.user = smtpUser; await saveSmtpField('smtp_user', smtpUser); }
  async function saveSmtpPass()   { if (!_smtpLoaded || smtpPass === _lastSavedSmtp.pass) return; _lastSavedSmtp.pass = smtpPass; await saveSmtpField('smtp_pass', smtpPass); }
  async function saveSmtpFrom()   { if (!_smtpLoaded || smtpFrom === _lastSavedSmtp.from) return; _lastSavedSmtp.from = smtpFrom; await saveSmtpField('smtp_from', smtpFrom); }

  // Banner-friendly reactive status. 'ok' just means "host + from are set
  // and the most recent test didn't fail". A real verification still
  // requires the Test button (the test endpoint actually sends an email).
  $: smtpBannerStatus = smtpTestStatus === 'testing' || smtpTestStatus === 'fail'
    ? smtpTestStatus
    : (smtpHost && smtpFrom ? 'ok' : '');
  // SMTP is fire-and-forget, not a persistent connection — be honest about
  // what the banner actually means. Default label is "Configured" (creds
  // entered, never verified). After a successful test it flips to
  // "Last test sent" with the test acting as the recency proof.
  $: smtpBannerLabel    = smtpTestStatus === 'ok' ? 'Last test sent' : 'Configured';
  $: smtpBannerSubtext  = smtpTestStatus === 'ok' ? 'Use Send Test again any time to re-verify' : 'No test has been sent yet';

  async function testSmtp() {
    if (!smtpHost) { smtpTestStatus = 'fail'; showError('SMTP test failed: host required'); return; }
    smtpTestStatus = 'testing';
    try {
      const res = await fetch(apiUrl('/api/app-config/test-email'), { method: 'POST', ..._fetchOpts() });
      if (res.ok) {
        smtpTestStatus = 'ok';
        showSuccess('SMTP test email sent, check your inbox');
      } else {
        smtpTestStatus = 'fail';
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) detail = j.error; } catch {}
        showError(`SMTP test failed: ${detail}`);
      }
    } catch (e) {
      smtpTestStatus = 'fail';
      showError(`SMTP test failed: ${e?.message || 'network error'}`);
    }
  }

  $: if (openSections.email && $currentUser?.role === 'admin') loadSmtpConfig();

  // ── User Management ref ────────────────────────────────────────────────────
  let userMgmtRef;
  $: if (openSections.users && $userMgmtActive) userMgmtRef?.loadData();

  // ── Authentication (OIDC SSO) ref ─────────────────────────────────────────
  let authRef;
  $: if (openSections.authentication && $userMgmtActive && $currentUser?.role === 'admin') authRef?.loadData();

  // ── Diagnostics: in-app log capture ──────────────────────────────────────
  let _logsSheet = false;
  let _logsText = '';
  let _logsCopied = false;
  let _verboseLogging = isVerboseLogging();
  let _hasCrashReport = false;

  function _openLogsSheet() {
    _logsText = getLogBufferText() || '(no log lines captured yet)';
    _logsCopied = false;
    _hasCrashReport = hasCrashReport();
    _logsSheet = true;
  }
  async function _copyLogs() {
    try {
      await navigator.clipboard.writeText(_logsText);
      _logsCopied = true;
      setTimeout(() => _logsCopied = false, 2000);
    } catch (e) {
      showError('Copy failed — select the text manually');
    }
  }
  async function _shareLogs() {
    try {
      if (isNative) {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title: 'NutriTrace diagnostic logs',
          text: _logsText,
          dialogTitle: 'Share NutriTrace logs',
        });
      } else if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'NutriTrace diagnostic logs', text: _logsText });
      } else {
        await _copyLogs();
      }
    } catch (e) {
      // User cancelled — silent.
    }
  }
  // Share the persistent log file as a real file attachment (native only,
  // and only useful when verbose / diagnostic mode has been on long enough
  // to write something to disk).
  async function _shareLogFile() {
    try {
      const f = await getLogFileUri();
      if (!f) { showError('No log file yet — turn on Verbose logs and reproduce the issue first'); return; }
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: 'NutriTrace diagnostic logs',
        text: 'NutriTrace log file',
        url: f.uri,
        dialogTitle: 'Share NutriTrace log file',
      });
    } catch (e) {
      // User cancelled or share unsupported — silent.
    }
  }
  // Share the most recent crash report file. Only visible when one exists
  // (cleared on next successful share or via the explicit Clear button).
  async function _shareCrashReport() {
    try {
      const f = await getLastCrashFileUri();
      if (!f) { _hasCrashReport = false; return; }
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: 'NutriTrace crash report',
        text: 'NutriTrace crash report',
        url: f.uri,
        dialogTitle: 'Share NutriTrace crash report',
      });
    } catch (e) {
      // User cancelled — silent.
    }
  }
  function _clearCrashReport() {
    clearCrashReport();
    _hasCrashReport = false;
  }
  function _clearLogs() {
    clearLogBuffer();
    _logsText = '(cleared)';
  }
  function _toggleVerbose(on) {
    _verboseLogging = on;
    setVerboseLogging(on);
  }

  // ── Diagnostics: anonymized calibration export ───────────────────────────
  let _calibExportSheet = false;
  let _calibExportJson  = '';
  let _calibExportCount = 0;
  let _calibDeviceLabel = ''; // user-supplied free-text, e.g. "Pixel Watch 4"
  let _calibCopied = false;

  async function _generateCalibExport() {
    try {
      // Pull last 30 days of Fitbit/Garmin data via the existing /data endpoint.
      // Window is today-29 → today inclusive (30 days ending today). Previously
      // used today-30 → today-1, which silently dropped today even though
      // today's seeded actuals are typically what the user just paste-confirmed.
      const today = new Date();
      const from  = new Date(today); from.setDate(from.getDate() - 29);
      const fmt   = d => d.toLocaleDateString('sv-SE');
      const fromStr = fmt(from), toStr = fmt(today);

      let fitbitRows = {}, garminRows = {};
      try { fitbitRows = await NtApi.get(`/api/wellness/fitbit/data?from=${fromStr}&to=${toStr}`) || {}; } catch {}
      try { garminRows = await NtApi.get(`/api/wellness/garmin/data?from=${fromStr}&to=${toStr}`) || {}; } catch {}

      // Build deterministic day list, oldest → newest
      const dates = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date(from); d.setDate(from.getDate() + i);
        dates.push(fmt(d));
      }

      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const days = dates.map((d, i) => {
        const f = fitbitRows[d] || {};
        const g = garminRows[d] || {};
        const wd = new Date(d + 'T12:00:00').getDay();
        // Only include fields useful for calibration. No user_id, no exact
        // dates, no PII. Numeric biometrics + scores only.
        const row = {
          dayIndex: i + 1,
          dayOfWeek: dayNames[wd],
          // Fitbit actuals (only present if user has been seeding via /seed-scores).
          // Most useful for tuning — these are Fitbit's own published scores.
          fitbit_sleep_actual:     f.sleep_score_actual     ?? null,
          fitbit_readiness_actual: f.readiness_score_actual ?? null,
          fitbit_stress_actual:    f.stress_score_actual    ?? null,
          // Our calculated scores (server-side for sleep, client-side for readiness/stress).
          sleep_calc:       (f.sleep_score_actual ? null : f.sleep_score)         ?? null,
          readiness_calc:   (f.readiness_score_actual ? null : f.readiness_score) ?? null,
          stress_calc:      (f.stress_score_actual ? null : f.stress_score)       ?? null,
          // Garmin's device-native scores (Garmin exposes these directly — no calc needed).
          // Stress is conceptually different (continuous-measurement avg, not a morning score).
          garmin_sleep:     g.sleep_score    ?? null,
          garmin_stress:    g.stress_avg     ?? null,
          // Raw biometrics — relevant for ANY device, useful for cross-device validation
          hrv:              f.hrv_daily_rmssd ?? g.hrv_daily_rmssd ?? null,
          rhr:              f.resting_hr      ?? g.resting_hr      ?? null,
          sleep_min:        f.sleep_duration_min ?? g.sleep_duration_min ?? null,
          deep_min:         f.sleep_deep_min  ?? g.sleep_deep_min  ?? null,
          rem_min:          f.sleep_rem_min   ?? g.sleep_rem_min   ?? null,
          efficiency:       f.sleep_efficiency ?? null,
          spo2:             f.spo2_avg        ?? null,
          calories_out:     f.calories_out    ?? g.calories_out    ?? null,
        };
        // Drop the day if there's no biometric data at all
        const hasData = row.fitbit_sleep_actual != null || row.sleep_calc != null ||
                        row.garmin_sleep != null || row.hrv != null || row.rhr != null;
        return hasData ? row : null;
      }).filter(Boolean);

      const payload = {
        version: 1,
        exportedAt: new Date().toISOString().slice(0, 10),
        device: _calibDeviceLabel.trim() || '(unspecified)',
        appVersion: APP_VERSION,
        days,
      };
      _calibExportJson  = JSON.stringify(payload, null, 2);
      _calibExportCount = days.length;
      _calibCopied = false;
    } catch (e) {
      showError('Could not generate calibration export: ' + (e.message || ''));
    }
  }

  async function _copyCalibExport() {
    try {
      await navigator.clipboard.writeText(_calibExportJson);
      _calibCopied = true;
      setTimeout(() => _calibCopied = false, 2000);
    } catch (e) {
      showError('Copy failed — select the text manually');
    }
  }

  // ── Reactive saves ─────────────────────────────────────────────────────────

  $: set('navStyle',          navStyle);
  $: set('startPage',          startPage);
  $: set('disableAnimations',  disableAnimations);
  $: { sidebarPersistent.set(sidebarPersistentVal); }
  $: set('statsChartType',     statsChartType);
  $: set('statsYZero',         statsYZero);
  $: set('statsAvgLine',       statsAvgLine);
  $: set('statsGoalLine',      statsGoalLine);
  $: set('statsTrendLine',     statsTrendLine);
  $: set('weightUnit',         weightUnit);
  $: set('heightUnit',         heightUnit);
  $: set('lengthUnit',         lengthUnit);
  $: set('distUnit',           distUnitVal);
  $: set('tempUnit',           tempUnitVal);
  $: set('usdaEnabled',        usdaEnabled);
  $: set('offEnabled',         offEnabled);
  $: set('offSearchLanguage',  offSearchLanguage);
  $: set('offSearchCountry',   offSearchCountry);
  $: set('offUploadCountry',   offUploadCountry);
  $: set('offImportPortion',   offImportPortion);

  // ── Explicit credential saves ──────────────────────────────────────────────
  let usdaSaved   = false;
  let usdaTestStatus = ''; // '', 'testing', 'ok', 'fail'
  $: usdaBannerStatus = (usdaTestStatus === 'testing' || usdaTestStatus === 'fail')
    ? usdaTestStatus
    : (usdaApiKey ? 'ok' : '');
  async function testUsdaConnection() {
    if (!usdaApiKey) { usdaTestStatus = 'fail'; showError('USDA test failed: API key required'); return; }
    usdaTestStatus = 'testing';
    try {
      // Direct call — USDA's FoodData Central API has open CORS, so the
      // browser can hit it without a server proxy. A 1-result probe query
      // is enough to verify the key.
      const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(usdaApiKey)}&query=apple&pageSize=1`;
      const res = await fetch(url);
      if (res.ok) {
        usdaTestStatus = 'ok';
        showSuccess('USDA API key verified');
      } else {
        usdaTestStatus = 'fail';
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error?.message) detail = j.error.message; } catch {}
        showError(`USDA test failed: ${detail}`);
      }
    } catch (e) {
      usdaTestStatus = 'fail';
      showError(`USDA test failed: ${e?.message || 'network error'}`);
    }
  }
  let offSaved    = false;
  let mealieSaved = false;

  function saveUsda() {
    set('usdaApiKey', usdaApiKey);
    usdaSaved = true;
    setTimeout(() => usdaSaved = false, 2000);
    if (usdaApiKey && usdaTestStatus !== 'testing') testUsdaConnection();
  }
  function saveOff()    { set('offUsername', offUsername); set('offPassword', offPassword); offSaved = true; setTimeout(() => offSaved = false, 2000); }
  function saveMealie() {
    set('mealieBaseUrl', mealieBaseUrl);
    set('mealieApiToken', mealieApiToken);
    mealieSaved = true;
    setTimeout(() => mealieSaved = false, 2000);
    // Auto-test on save if both fields are filled. Mirrors the AI
    // Assistant's save+test combined flow so the banner stays honest.
    if (mealieBaseUrl && mealieApiToken && mealieTestStatus !== 'testing') {
      testMealieConnection();
    }
  }

  // ── Env-lock state — which admin sections are locked by environment vars ───
  let envLocks = { smtp: false, ai: false, ai_enabled: false };
  onMount(async () => {
    try {
      const res = await fetch(apiUrl('/api/app-config/env-locks'), _fetchOpts());
      if (res.ok) {
        envLocks = await res.json();
        // Keep the global store in sync so Trace.svelte's FAB gate updates
        // when an admin flips env-locked state and revisits Settings.
        const { envLocks: globalEnvLocks } = await import('../stores/settings.js');
        globalEnvLocks.set(envLocks);
      }
    } catch {}

    // Native server mode: surface last-sync time in Server Connection card.
    // Pull the persisted timestamp from sync_meta (survives across sessions),
    // then keep it live by subscribing to the in-memory syncState store.
    let _syncStoreUnsub = null;
    let _tickInterval = null;
    if (isNative && getServerUrl()) {
      try {
        const { dbGetSyncMeta } = await import('../lib/db-native.js');
        lastSyncAt = await dbGetSyncMeta('last_sync_at');
      } catch {}
      try {
        const { syncState } = await import('../lib/sync.js');
        _syncStoreUnsub = syncState.subscribe(s => {
          if (s.lastSync) lastSyncAt = s.lastSync;
        });
      } catch {}
      // Re-render the "X ago" label every 30s so it stays accurate without
      // requiring a manual refresh.
      _tickInterval = setInterval(() => { _nowTick = Date.now(); }, 30000);
    }
    return () => {
      if (_syncStoreUnsub) _syncStoreUnsub();
      if (_tickInterval) clearInterval(_tickInterval);
    };
  });
</script>

<div class="page-shell">
  <!-- Header + search bar share one sticky container so the search row
       stays flush with the header in BOTH compact and banner-on modes.
       The brittle `top: calc(... + 62px + hamburger-row)` pattern bred
       a 2px gap when the compact header was shorter than the offset
       assumed. Pinning them together as one unit removes the whole
       class of header-height vs sub-bar-top mismatch bugs. -->
  <div class="settings-sticky-top">
    <header class="page-header" class:has-banner={$pageBanners}>
      {#if $pageBanners}<SettingsBanner />{/if}
      <h1>{$_('routes.settings.title')}</h1>
    </header>

    <div class="settings-search-bar">
      <span class="material-symbols-rounded settings-search-icon">search</span>
      <input class="settings-search-input" type="search" placeholder="Search settings…"
        bind:value={settingsSearch} />
      {#if settingsSearch}
        <button class="settings-search-clear btn-icon" on:click={() => settingsSearch = ''} title="Clear search">
          <span class="material-symbols-rounded" style="font-size:18px">close</span>
        </button>
      {/if}
    </div>
  </div>

  <div class="page-content settings-content">

    <!-- ── Profile hero — identity card at the top of Settings.
         Avatar + name (nickname → full name → "My Profile" fallback) +
         optional admin pill. Click → /profile. Hidden during search
         when no profile keyword matches so it doesn't dilute results. -->
    {#if sectionVisible(settingsQuery, 'profile')}
    {@const _u = $currentUser || {}}
    {@const _nick = (_u.nickname || '').trim()}
    {@const _full = (_u.full_name || '').trim()}
    {@const _displayName = _nick || (_full && _full !== 'Local User' ? _full : '') || $_('settings.profile_hero.label_fallback')}
    {@const _hasName = _displayName !== $_('settings.profile_hero.label_fallback')}
    {@const _initial = (_displayName[0] || '?').toUpperCase()}
    <button class="profile-hero" on:click={() => push('/profile')}>
      <div class="profile-hero-avatar">
        {#if _u.avatar_url}
          <img src={resolveAssetUrl(_u.avatar_url)} alt="" />
        {:else if _hasName}
          <span class="profile-hero-initial">{_initial}</span>
        {:else}
          <span class="material-symbols-rounded">person</span>
        {/if}
      </div>
      <div class="profile-hero-info">
        <span class="profile-hero-name">{_displayName}</span>
        {#if _hasName && _u.role === 'admin' && $userMgmtActive}
          <span class="profile-hero-role">{$_('common.admin')}</span>
        {:else if !_hasName}
          <span class="profile-hero-sub">{$_('settings.profile_hero.subtitle_empty')}</span>
        {/if}
      </div>
      <span class="material-symbols-rounded profile-hero-chev">chevron_right</span>
    </button>
    {/if}

    <p class="settings-group-label">Display</p>
    <!-- ── Appearance ──────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'appearance')} on:click={() => toggleSection('appearance')}>
      <span class="material-symbols-rounded si">contrast</span>
      <span>{$_('settings.appearance.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.appearance}>expand_more</span>
    </button>

    {#if sectionOpen(openSections, settingsQuery, 'appearance') && sectionVisible(settingsQuery, 'appearance')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
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
                title="Custom color" style={/^#[0-9a-fA-F]{6}$/.test($accentColor) ? "background:"+$accentColor : ""}
                on:click={openColorSheet}>
                <span class="material-symbols-rounded" style="font-size:16px;color:rgba(255,255,255,0.9);text-shadow:0 0 3px rgba(0,0,0,0.5)">colorize</span>
              </button>
            </div>
          </div>
          <div class="setting-divider"></div>
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
                <span class="setting-label">Persistent Sidebar</span>
                <div class="setting-desc">Sidebar stays open and shifts page content instead of overlaying it. Available on tablets, foldables, and desktop.</div>
              </div>
              <Toggle checked={sidebarPersistentVal} on:change={e => sidebarPersistentVal = e.detail} />
            </div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Start Page</span>
            <div class="select-wrap" style="width:150px">
              <select class="select sel-sm" bind:value={startPage}>
                {#each START_PAGE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Reduce Motion</span>
            <Toggle checked={disableAnimations} on:change={e => { disableAnimations = e.detail; set('disableAnimations', e.detail); }} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Goal Pulse Animation</span>
              <div class="setting-desc">Pulse the diary's nutrition bar when you hit a daily goal. For push notifications on goal hits, see Notifications.</div>
            </div>
            <Toggle checked={$goalCelebrations} on:change={e => goalCelebrations.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Page Banners</span>
              <div class="setting-desc">Decorative animated illustrations at the top of every page</div>
            </div>
            <Toggle checked={$pageBanners} on:change={e => pageBanners.set(e.detail)} />
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Regional & Units ─────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'regional')} on:click={() => toggleSection('regional')}>
      <span class="material-symbols-rounded si">language</span>
      <span>{$_('settings.regional.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.regional}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'regional') && sectionVisible(settingsQuery, 'regional')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">{$_('settings.regional.language')}</span>
            <div class="select-wrap" style="width:150px">
              <select class="select sel-sm" bind:value={$language}>
                {#each AVAILABLE_LOCALES as l}<option value={l.code}>{l.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Date Format</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$dateFormat} on:change={e => dateFormat.set(e.target.value)}>
                <option value="ISO">YYYY-MM-DD</option>
                <option value="US">MM/DD/YYYY</option>
                <option value="EU">DD/MM/YYYY</option>
                <option value="natural">D MMM YYYY</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Time Format</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$timeFormat} on:change={e => timeFormat.set(e.target.value)}>
                <option value="12h">12-hour (AM/PM)</option>
                <option value="24h">24-hour</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Energy</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$energyUnit} on:change={e => energyUnit.set(e.target.value)}>
                {#each ENERGY_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Weight</span>
            <div class="select-wrap" style="width:100px">
              <select class="select sel-sm" bind:value={weightUnit}>
                <option value="kg">kg</option>
                <option value="lb">lbs</option>
                <option value="st">st</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Height</span>
            <div class="select-wrap" style="width:100px">
              <select class="select sel-sm" bind:value={heightUnit}>
                <option value="cm">cm</option>
                <option value="ft">ft / in</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Circumference</span>
            <div class="select-wrap" style="width:100px">
              <select class="select sel-sm" bind:value={lengthUnit}>
                <option value="in">in</option>
                <option value="cm">cm</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Distance</span>
            <div class="select-wrap" style="width:100px">
              <select class="select sel-sm" bind:value={distUnitVal}>
                <option value="km">km</option>
                <option value="mi">mi</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Temperature</span>
            <div class="select-wrap" style="width:100px">
              <select class="select sel-sm" bind:value={tempUnitVal}>
                <option value="F">°F</option>
                <option value="C">°C</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Diary ───────────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'diary')} on:click={() => toggleSection('diary')}>
      <span class="material-symbols-rounded si">book</span>
      <span>{$_('settings.diary.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.diary}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'diary') && sectionVisible(settingsQuery, 'diary')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <div><span class="setting-label">Show Brand Names</span><div class="setting-desc">Display the brand under each food name</div></div>
            <Toggle checked={$diaryShowBrands} on:change={e => diaryShowBrands.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Timestamps</span><div class="setting-desc">Show the time each item was logged</div></div>
            <Toggle checked={$diaryShowTimestamps} on:change={e => diaryShowTimestamps.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Thumbnails</span><div class="setting-desc">Food/meal photos next to each item</div></div>
            <Toggle checked={$diaryShowThumbnails} on:change={e => diaryShowThumbnails.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show All Nutrients</span><div class="setting-desc">When viewing a meal's totals, show every available nutrient (vitamins, minerals, etc.) instead of just the macros</div></div>
            <Toggle checked={$diaryShowAllNutrients} on:change={e => diaryShowAllNutrients.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Nutrition Units</span><div class="setting-desc">Append "g" / "mg" / etc. after numeric values</div></div>
            <Toggle checked={$diaryShowNutritionUnits} on:change={e => diaryShowNutritionUnits.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Macro Summary Per Meal</span><div class="setting-desc">P/C/F bar at the bottom of each meal — tap it for full nutrient breakdown</div></div>
            <Toggle checked={$diaryShowMacroSummary} on:change={e => diaryShowMacroSummary.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Ask For Quantity When Adding</span><div class="setting-desc">Prompt for portion size before adding a food (otherwise use the food's default)</div></div>
            <Toggle checked={$diaryPromptQuantity} on:change={e => diaryPromptQuantity.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Portion Size</span><div class="setting-desc">Display "150g" / "1 cup" etc. on each diary item</div></div>
            <Toggle checked={$diaryShowPortionSize} on:change={e => diaryShowPortionSize.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Daily Notes</span><div class="setting-desc">Free-text notes section at the bottom of each day's diary</div></div>
            <Toggle checked={$diaryShowNotes} on:change={e => diaryShowNotes.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Activity Section</span><div class="setting-desc">A list-of-entries Activity section on the Diary for logging exercise. Each entry has a name + calories burned. Useful if you don't have a wearable integration.</div></div>
            <Toggle checked={$diaryShowActivity} on:change={e => diaryShowActivity.set(e.detail)} />
          </div>
          {#if $diaryShowActivity}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div><span class="setting-label">Adjust Calorie Goal From Activity</span><div class="setting-desc">When on, today's burn (manual + wearable per the policy below) raises your calorie remaining for the day — earn-back model. When off, activity entries still log and display but your goal stays at its base value.</div></div>
              <Toggle checked={$calorieAdjustFromActivity} on:change={e => calorieAdjustFromActivity.set(e.detail)} />
            </div>
          {/if}
          {#if $diaryShowActivity && $calorieAdjustFromActivity && (!isNativeLocal || $healthConnectEnabled)}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div style="flex:1">
                <span class="setting-label">When Wearable + Manual Entries Both Exist</span>
                <div class="setting-desc">{isNativeLocal ? 'How to combine your manually-logged activity with Health Connect active calories on days you have both.' : 'How to combine your manually-logged activity with calories from Fitbit / Garmin / Withings / Health Connect on days you have both.'}</div>
                <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
                  <label style="display:flex; gap:8px; align-items:flex-start;">
                    <input type="radio" name="activityPolicy" value="wearable_wins" checked={$manualActivityPolicy === 'wearable_wins'} on:change={() => manualActivityPolicy.set('wearable_wins')} />
                    <span><strong>Wearable wins</strong> <span class="setting-desc">— manual entries show on the diary but don't move the goal math. Default, no double-count risk.</span></span>
                  </label>
                  <label style="display:flex; gap:8px; align-items:flex-start;">
                    <input type="radio" name="activityPolicy" value="manual_wins" checked={$manualActivityPolicy === 'manual_wins'} on:change={() => manualActivityPolicy.set('manual_wins')} />
                    <span><strong>Manual wins</strong> <span class="setting-desc">— your manually-logged total replaces the wearable's burn for the day.</span></span>
                  </label>
                  <label style="display:flex; gap:8px; align-items:flex-start;">
                    <input type="radio" name="activityPolicy" value="additive" checked={$manualActivityPolicy === 'additive'} on:change={() => manualActivityPolicy.set('additive')} />
                    <span><strong>Add together</strong> <span class="setting-desc">— sums both. ⚠ Risk of double-counting if your wearable already saw the activity.</span></span>
                  </label>
                </div>
                <div class="setting-desc" style="margin-top:8px">When no wearable data exists for a day, manual entries always count regardless of this setting.</div>
              </div>
            </div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Fasting Tracker</span><div class="setting-desc">Adds an intermittent-fasting timer at the top of the Diary. Start a fast, see elapsed time and progress toward your goal, end when you're done.</div></div>
            <Toggle checked={$fastingEnabled} on:change={e => fastingEnabled.set(e.detail)} />
          </div>
          {#if $fastingEnabled}
            <div class="setting-divider"></div>
            <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
              <span class="setting-label">Default Fast Goal</span>
              <div class="seg-control" style="width:100%;--seg-count:5;--seg-active:{[14,16,18,20,23].indexOf($fastingDefaultHours)}">
                {#each [14,16,18,20,23] as h}
                  <button class="seg-opt" class:seg-active={$fastingDefaultHours === h}
                    on:click={() => fastingDefaultHours.set(h)}>
                    {h === 23 ? 'OMAD' : `${h}:${24 - h}`}
                  </button>
                {/each}
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div><span class="setting-label">Notify When Goal Reached</span><div class="setting-desc">Fire a notification when your active fast hits its goal so you don't have to keep checking the Diary.</div></div>
              <Toggle checked={$fastingNotifyOnGoal} on:change={e => fastingNotifyOnGoal.set(e.detail)} />
            </div>

            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Recurring Schedule</span>
                <div class="setting-desc">Auto-start a fast at a fixed time each day. The schedule fires once per scheduled day; manually started fasts still work normally.</div>
              </div>
              <Toggle checked={$fastingScheduleEnabled} on:change={e => fastingScheduleEnabled.set(e.detail)} />
            </div>
            {#if $fastingScheduleEnabled}
              <div class="setting-divider"></div>
              <div class="setting-row">
                <span class="setting-label">Start Time</span>
                <input class="input" type="time" style="width:120px;text-align:center"
                  value={$fastingScheduleTime}
                  on:change={e => fastingScheduleTime.set(e.target.value)} />
              </div>
              <div class="setting-divider"></div>
              <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
                <span class="setting-label">Repeat On</span>
                <div class="seg-control multi" style="width:100%;--seg-count:7">
                  {#each ['S','M','T','W','T','F','S'] as label, idx}
                    <button class="seg-opt" type="button"
                      class:seg-active={$fastingScheduleDays?.includes(idx)}
                      on:click={() => {
                        const cur = $fastingScheduleDays || [];
                        const next = cur.includes(idx) ? cur.filter(d => d !== idx) : [...cur, idx].sort((a,b)=>a-b);
                        fastingScheduleDays.set(next);
                      }}>{label}</button>
                  {/each}
                </div>
                <div class="setting-desc" style="margin:0">
                  Tap a day to toggle. Sunday → Saturday.
                </div>
              </div>
              <div class="setting-divider"></div>
              <div class="setting-row">
                <span class="setting-label">Schedule Goal</span>
                <input class="input" type="number" min="1" max="168" step="0.5"
                  style="width:90px;text-align:center"
                  value={$fastingScheduleGoal}
                  on:change={e => fastingScheduleGoal.set(Number(e.target.value) || 16)} />
              </div>
            {/if}
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Daily Goals Progress Bar</span><div class="setting-desc">Progress strip at the bottom of the diary showing how much of your daily goals you've hit</div></div>
            <Toggle checked={$diaryShowNutritionBar} on:change={e => diaryShowNutritionBar.set(e.detail)} />
          </div>
        </div>

        <p class="sub-label">Meal names</p>
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="card settings-card drag-list"
          on:pointermove={onMealDragMove}
          on:pointerup={onMealDragUp}
          on:pointercancel={onMealDragUp}>
          {#each meals as _, i}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="setting-row drag-row"
              class:dragging={mealDragFrom === i}
              class:drag-target={mealDragFrom !== null && mealDragFrom !== i && mealDragOver === i}
              style={mealDragFrom !== null
                ? mealDragFrom === i
                  ? `transform:scale(1.04) translateY(${mealDragDelta}px);transition:box-shadow 200ms ease,opacity 200ms ease`
                  : `transform:translateY(${dragShift(i,mealDragFrom,mealDragOver,mealRowHeights)}px)`
                : ''}>
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <span class="drag-handle material-symbols-rounded" on:pointerdown={e => onMealDragDown(e, i)}>drag_indicator</span>
              <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3);flex-shrink:0">{mealIcon(meals[i])}</span>
              <input class="input" style="flex:1;height:36px;min-width:0" placeholder="Meal {i+1}" bind:value={meals[i]} on:blur={autoSaveMeals} />
              {#if meals.length > 1}
                <button class="btn-icon" style="width:32px;height:32px;color:var(--danger);flex-shrink:0"
                  on:click={() => { meals = meals.filter((_,j) => j !== i); autoSaveMeals(); }} title="Remove meal">
                  <span class="material-symbols-rounded" style="font-size:16px">remove</span>
                </button>
              {/if}
            </div>
          {/each}
          <div style="padding:8px 16px 14px">
            <button class="btn btn-secondary" style="height:36px;font-size:13px;width:100%;display:flex;align-items:center;justify-content:center;gap:4px"
              on:click={() => meals = [...meals.filter(m => m.trim()), '']}>
              <span class="material-symbols-rounded" style="font-size:16px">add</span> Add Meal
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Water ───────────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'water')} on:click={() => toggleSection('water')}>
      <span class="material-symbols-rounded si">water_drop</span>
      <span>{$_('settings.water.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.water}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'water') && sectionVisible(settingsQuery, 'water')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <!-- Goal + unit -->
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">Display Unit</span>
            <select class="select sel-sm" value={$waterUnit} on:change={e => waterUnit.set(e.target.value)}>
              <option value="ml">Milliliters (ml)</option>
              <option value="oz">Fluid ounces (fl oz)</option>
              <option value="L">Liters (L)</option>
              <option value="G">Gallons (G)</option>
            </select>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Show In Diary</span>
            <Toggle checked={$waterShowInDiary} on:change={e => waterShowInDiary.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Show In Statistics</span>
            <Toggle checked={$waterShowInStats} on:change={e => waterShowInStats.set(e.detail)} />
          </div>
        </div>

        <!-- Containers list -->
        <p class="section-title" style="margin-top:14px">Water Containers</p>
        <p class="setting-desc" style="padding:0 var(--page-px) 10px">Quick-add buttons shown in the Diary for logging water intake</p>
        <div class="card settings-card">
          {#each $waterContainers as container, i}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="setting-row">
              <div style="display:flex;align-items:center;gap:10px;min-width:0">
                <span class="material-symbols-rounded" style="color:var(--accent);font-size:20px;flex-shrink:0">water_drop</span>
                <div style="min-width:0">
                  <div class="setting-label">{container.name}</div>
                  <div class="setting-desc">{_mlToDisplay(container.volumeMl, $waterUnit)} {$waterUnit}</div>
                </div>
              </div>
              <button class="btn-icon" on:click={() => removeContainer(container.id)} title="Remove">
                <span class="material-symbols-rounded" style="font-size:18px;color:var(--text-3)">delete</span>
              </button>
            </div>
          {/each}
          {#if $waterContainers.length === 0}
            <p class="text-3 text-sm" style="padding:16px;text-align:center">No containers yet</p>
          {/if}
        </div>

        <!-- Add container form -->
        <div class="card settings-card" style="margin-top:8px">
          <div style="padding:12px 16px 14px">
            <p class="setting-label" style="margin-bottom:10px">Add Container</p>
            <input class="input" type="text" placeholder="Name (e.g. My Water Bottle)"
              bind:value={_newContName} style="margin-bottom:8px" />
            <div style="display:flex;gap:8px;align-items:center">
              <input class="input" type="number" min="0.1" step="0.1" placeholder="Volume"
                bind:value={_newContVolume} style="flex:1" />
              <select class="select sel-sm" bind:value={_newContUnit} style="width:86px">
                <option value="ml">ml</option>
                <option value="oz">fl oz</option>
                <option value="L">L</option>
                <option value="G">G</option>
              </select>
              <button class="btn btn-primary" style="height:42px;white-space:nowrap" on:click={addContainer}>Add</button>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Foods ───────────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'foods')} on:click={() => toggleSection('foods')}>
      <span class="material-symbols-rounded si">restaurant</span>
      <span>{$_('settings.foods.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.foods}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'foods') && sectionVisible(settingsQuery, 'foods')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <div><span class="setting-label">Show Thumbnails</span><div class="setting-desc">Food/meal photos in the picker list</div></div>
            <Toggle checked={$foodsShowThumbnails} on:change={e => foodsShowThumbnails.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Categories</span><div class="setting-desc">Filter chips at the top of the Foods picker</div></div>
            <Toggle checked={$foodsShowCategories} on:change={e => foodsShowCategories.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Category Labels</span><div class="setting-desc">Display the category name + emoji on each food row</div></div>
            <Toggle checked={$foodsShowLabels} on:change={e => foodsShowLabels.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Notes</span><div class="setting-desc">Show saved food notes (e.g. "1 serving = 150g cooked") in the quick-add card</div></div>
            <Toggle checked={$foodsShowNotes} on:change={e => foodsShowNotes.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div><span class="setting-label">Show Yesterday's Meals</span><div class="setting-desc">Pin yesterday's meals as quick-add cards in the Meals tab. Tap the info icon to see what's in each one.</div></div>
            <Toggle checked={$foodsShowYesterdayMeals} on:change={e => foodsShowYesterdayMeals.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Foods Sort</span>
              <div class="setting-desc">How items are ordered in the Foods tab. Favorites are always pinned at the top regardless of sort.</div>
            </div>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$foodsSort} on:change={e => foodsSort.set(e.target.value)}>
                <option value="recent">Recently Used</option>
                <option value="most">Most Used</option>
                <option value="alpha">Alphabetical</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Meals Sort</span>
              <div class="setting-desc">How items are ordered in the Meals tab.</div>
            </div>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$mealsSort} on:change={e => mealsSort.set(e.target.value)}>
                <option value="recent">Recently Used</option>
                <option value="most">Most Used</option>
                <option value="alpha">Alphabetical</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Recipes Sort</span>
              <div class="setting-desc">How items are ordered in the Recipes tab.</div>
            </div>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$recipesSort} on:change={e => recipesSort.set(e.target.value)}>
                <option value="recent">Recently Used</option>
                <option value="most">Most Used</option>
                <option value="alpha">Alphabetical</option>
              </select>
            </div>
          </div>
        </div>
        <p class="sub-label">Camera &amp; Scanning</p>
        <div class="card settings-card">
          <div class="setting-row"><span class="setting-label">Beep On Successful Scan</span><Toggle checked={$barcodeBeep} on:change={e => barcodeBeep.set(e.detail)} /></div>
          {#if isNative}
            <div class="setting-divider"></div>
            <div class="setting-row"><span class="setting-label">Use Flashlight While Scanning</span><Toggle checked={$barcodeFlashlight} on:change={e => barcodeFlashlight.set(e.detail)} /></div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Crop Photos On Upload</span><Toggle checked={$cropPhotos} on:change={e => cropPhotos.set(e.detail)} /></div>
        </div>
      </div>
    {/if}

    <p class="settings-group-label">Data &amp; Tracking</p>
    <!-- ── Goals ───────────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'goals')} on:click={() => toggleSection('goals')}>
      <span class="material-symbols-rounded si">flag</span>
      <span>{$_('settings.goals.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.goals}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'goals') && sectionVisible(settingsQuery, 'goals')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
            <div>
              <span class="setting-label">Calorie Goal Mode</span>
              <span class="labs-badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);vertical-align:middle">Experimental</span>
              <div class="setting-desc">How your daily calorie target is calculated</div>
            </div>
            <div class="seg-control" style="width:100%;--seg-count:3;--seg-active:{$calorieGoalMode === 'fixed' ? 0 : $calorieGoalMode === 'dynamic' ? 1 : 2}">
              <button class="seg-opt" class:seg-active={$calorieGoalMode === 'fixed'}
                on:click={() => calorieGoalMode.set('fixed')}>Fixed</button>
              <button class="seg-opt" class:seg-active={$calorieGoalMode === 'dynamic'}
                disabled={!_hasWearable}
                title={!_hasWearable ? 'Connect a wearable in Wellness first' : ''}
                on:click={() => _hasWearable && calorieGoalMode.set('dynamic')}>Dynamic</button>
              <button class="seg-opt" class:seg-active={$calorieGoalMode === 'adaptive'}
                on:click={() => calorieGoalMode.set('adaptive')}>Adaptive</button>
            </div>
          </div>
          {#if $calorieGoalMode === 'fixed'}
            <div class="setting-divider"></div>
            <p class="setting-desc" style="padding:8px var(--page-px)">
              Uses the calorie target from your goal templates as the daily goal.
            </p>
          {:else if $calorieGoalMode === 'dynamic'}
            <div class="setting-divider"></div>
            <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
              <span class="setting-label">Goal Factor</span>
              <div class="seg-control" style="width:100%;--seg-count:3;--seg-active:{$calorieGoalFactor === 0.8 ? 0 : $calorieGoalFactor === 1.2 ? 2 : 1}">
                <button class="seg-opt" class:seg-active={$calorieGoalFactor === 0.8}  on:click={() => calorieGoalFactor.set(0.8)}>Lose −20%</button>
                <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.0}  on:click={() => calorieGoalFactor.set(1.0)}>Maintain</button>
                <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.2}  on:click={() => calorieGoalFactor.set(1.2)}>Gain +20%</button>
              </div>
            </div>
            <div class="setting-divider"></div>
            <p class="setting-desc" style="padding:8px var(--page-px)">
              Uses yesterday's final calorie burn from your wearable, multiplied by the factor. Falls back to your fixed goal if no data is available.
            </p>
          {:else if $calorieGoalMode === 'adaptive'}
            <div class="setting-divider"></div>
            <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
              <span class="setting-label">Goal Factor</span>
              <div class="seg-control" style="width:100%;--seg-count:3;--seg-active:{$calorieGoalFactor === 0.8 ? 0 : $calorieGoalFactor === 1.2 ? 2 : 1}">
                <button class="seg-opt" class:seg-active={$calorieGoalFactor === 0.8}  on:click={() => calorieGoalFactor.set(0.8)}>Lose −20%</button>
                <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.0}  on:click={() => calorieGoalFactor.set(1.0)}>Maintain</button>
                <button class="seg-opt" class:seg-active={$calorieGoalFactor === 1.2}  on:click={() => calorieGoalFactor.set(1.2)}>Gain +20%</button>
              </div>
            </div>
            <div class="setting-divider"></div>
            <p class="setting-desc" style="padding:8px var(--page-px);line-height:1.5">
              Learns your true TDEE from <strong>35 days of weight + diary</strong> and adjusts daily. Falls back to your fixed goal until enough data is logged. See the readiness card on the <strong>Goals</strong> page for current status. <a href="https://github.com/TraceApps/nutritrace#adaptive-tdee" target="_blank" rel="noopener" class="about-link">How it works →</a>
            </p>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ── Body Stats ──────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'bodyStats')} on:click={() => toggleSection('bodyStats')}>
      <span class="material-symbols-rounded si">monitor_weight</span>
      <span>{$_('settings.body_stats.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.bodyStats}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'bodyStats') && sectionVisible(settingsQuery, 'bodyStats')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="card settings-card drag-list"
          on:pointermove={onStatDragMove}
          on:pointerup={onStatDragUp}
          on:pointercancel={onStatDragUp}>
          {#each orderedBodyStats as stat, i}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="setting-row drag-row"
              class:dragging={statDragFrom === i}
              class:drag-target={statDragFrom !== null && statDragFrom !== i && statDragOver === i}
              style={statDragFrom !== null
                ? statDragFrom === i
                  ? `transform:scale(1.04) translateY(${statDragDelta}px);transition:box-shadow 200ms ease,opacity 200ms ease`
                  : `transform:translateY(${dragShift(i,statDragFrom,statDragOver,statRowHeights)}px)`
                : ''}>
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <span class="drag-handle material-symbols-rounded" on:pointerdown={e => onStatDragDown(e, i)}>drag_indicator</span>
              <span class="setting-label">{stat.label}</span>
              <Toggle checked={isStatVisible(stat.id)} on:change={() => toggleStatVisible(stat.id)} />
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ── Statistics ──────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'statistics')} on:click={() => toggleSection('statistics')}>
      <span class="material-symbols-rounded si">bar_chart</span>
      <span>{$_('settings.statistics.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.statistics}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'statistics') && sectionVisible(settingsQuery, 'statistics')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">Default Chart Type</span>
            <div class="select-wrap" style="width:110px">
              <select class="select sel-sm" bind:value={statsChartType}>
                <option value="bar">Bar</option>
                <option value="line">Line</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Lock Y-Axis To Zero</span><Toggle checked={statsYZero} on:change={e => { statsYZero = e.detail; set('statsYZero', e.detail); }} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show Average Line</span><Toggle checked={statsAvgLine} on:change={e => { statsAvgLine = e.detail; set('statsAvgLine', e.detail); }} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show Goal Line</span><Toggle checked={statsGoalLine} on:change={e => { statsGoalLine = e.detail; set('statsGoalLine', e.detail); }} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show Trend Line</span><Toggle checked={statsTrendLine} on:change={e => { statsTrendLine = e.detail; set('statsTrendLine', e.detail); }} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Include Today In Trends</span>
              <div class="setting-desc">For cumulative metrics (calories, water, steps, etc.) today is partial until the day ends. Off by default — the chart looks cleaner. Statistics page also has an inline toggle for one-off overrides.</div>
            </div>
            <Toggle checked={statsIncludeTodayLocal} on:change={e => { statsIncludeTodayLocal = e.detail; set('statsIncludeToday', e.detail); }} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Show Empty Days</span>
              <div class="setting-desc">Keep every date in the chart's range visible even when nothing was logged that day. Lets gaps in logging show up rather than collapsing into a denser chart that hides them. Applies to both bar and line charts.</div>
            </div>
            <Toggle checked={statsShowEmptyDaysLocal} on:change={e => { statsShowEmptyDaysLocal = e.detail; set('statsShowEmptyDays', e.detail); }} />
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Nutrients ───────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'nutrients')} on:click={() => toggleSection('nutrients')}>
      <span class="material-symbols-rounded si">science</span>
      <span>{$_('settings.nutrients.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.nutrients}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'nutrients') && sectionVisible(settingsQuery, 'nutrients')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <p class="sub-label">Visible nutrients (shown in diary & food editor)</p>
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="card settings-card drag-list"
          on:pointermove={onNutDragMove}
          on:pointerup={onNutDragUp}
          on:pointercancel={onNutDragUp}>
          {#each orderedNutriments as n, i}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="setting-row drag-row"
              class:dragging={nutDragFrom === i}
              class:drag-target={nutDragFrom !== null && nutDragFrom !== i && nutDragOver === i}
              style={nutDragFrom !== null
                ? nutDragFrom === i
                  ? `transform:scale(1.04) translateY(${nutDragDelta}px);transition:box-shadow 200ms ease,opacity 200ms ease`
                  : `transform:translateY(${dragShift(i,nutDragFrom,nutDragOver,nutRowHeights)}px)`
                : ''}>
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <span class="drag-handle material-symbols-rounded" on:pointerdown={e => onNutDragDown(e, i)}>drag_indicator</span>
              <span class="setting-label">{n.label} <span class="text-3 text-sm">({n.unit})</span></span>
              <Toggle checked={isNutrientVisible(n.id)} on:change={() => toggleNutrientVisible(n.id)} />
            </div>
          {/each}
        </div>

        <p class="sub-label">Custom nutrients</p>
        <div class="card settings-card">
          {#each ($customNutriments || []) as cn, i}
            {#if i > 0}<div class="setting-divider"></div>{/if}
            <div class="setting-row">
              <span class="setting-label">{cn.label} ({cn.unit})</span>
              <button class="btn-icon" style="width:32px;height:32px;color:var(--danger)"
                on:click={() => removeCustomNutrient(cn.id)} title="Remove nutrient">
                <span class="material-symbols-rounded" style="font-size:18px">delete</span>
              </button>
            </div>
          {/each}
          {#if ($customNutriments || []).length === 0}
            <div class="setting-row"><span class="text-3 text-sm">No custom nutrients</span></div>
            <div class="setting-divider"></div>
          {/if}
          <div style="padding:8px 16px 14px">
            <button class="btn btn-secondary" style="height:36px;font-size:13px"
              on:click={() => showNutrientSheet = true}>
              <span class="material-symbols-rounded" style="font-size:18px">add</span>
              Add custom nutrient
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Categories ─────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'categories')} on:click={() => toggleSection('categories')}>
      <span class="material-symbols-rounded si">tag</span>
      <span>{$_('settings.categories.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.categories}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'categories') && sectionVisible(settingsQuery, 'categories')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="cat-chips-wrap">
            {#each ($foodCategories || []) as cat}
              <div class="chip">
                {_catDisplay(cat)}
                <button class="chip-x" on:click={() => removeCategory(cat)} aria-label="Remove">
                  <span class="material-symbols-rounded" style="font-size:14px">close</span>
                </button>
              </div>
            {/each}
            {#if ($foodCategories || []).length === 0}
              <span class="text-3 text-sm">No categories yet</span>
            {/if}
          </div>
          <div class="setting-divider"></div>
          <div class="cat-add-row">
            <div style="display:flex;flex-direction:column;gap:3px;flex-shrink:0;position:relative">
              <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);text-align:center">Label</span>
              <button class="input emoji-btn" title="Pick an emoji label"
                on:click={openEmojiPicker}>
                {newCategoryLabel || '🏷️'}
              </button>
            </div>
            <div style="display:flex;flex-direction:column;gap:3px;flex:1">
              <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">Category name *</span>
              <input class="input" style="height:40px" placeholder="e.g. Dairy, Proteins…"
                bind:value={newCategoryName} on:keydown={e => e.key==='Enter' && addCategory()} />
            </div>
            <button class="btn btn-secondary" style="height:40px;padding:0 16px;align-self:flex-end" on:click={addCategory}>Add</button>
          </div>
        </div>
      </div>
    {/if}


    <!-- ── Custom Units ───────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'customUnits')} on:click={() => toggleSection('customUnits')}>
      <span class="material-symbols-rounded si">straighten</span>
      <span>Custom Units</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.customUnits}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'customUnits') && sectionVisible(settingsQuery, 'customUnits')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div style="padding:12px 16px 0">
            <p class="setting-desc" style="margin:0 0 10px">
              Add units that aren't in the built-in catalog (e.g. "shot", "scoop", "stick"). Custom units appear under "Custom" at the top of the unit dropdown when adding foods.
            </p>
            <p class="setting-desc" style="margin:0 0 12px;color:var(--warning, #d49a2b)">
              <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">info</span>
              Custom units do not convert by mass. Picking one falls back to a pure portion-ratio scale (1 unit → 2 units = 2× nutrition), since "shot" or "scoop" has no fixed gram weight.
            </p>
          </div>
          <div class="cat-chips-wrap" style="padding:0 16px 12px">
            {#each ($customUnits || []) as u}
              <div class="chip">
                {u.full} <span style="color:var(--text-3);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-left:6px">{u.abbr}</span>
                <button class="chip-x" on:click={() => removeCustomUnit(u)} aria-label="Remove">
                  <span class="material-symbols-rounded" style="font-size:14px">close</span>
                </button>
              </div>
            {/each}
            {#if (!$customUnits || $customUnits.length === 0)}
              <span class="text-3 text-sm">No custom units yet</span>
            {/if}
          </div>
          <div class="setting-divider"></div>
          <div class="cat-add-row">
            <div style="display:flex;flex-direction:column;gap:3px;width:80px">
              <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">Abbr *</span>
              <input class="input" style="height:40px" placeholder="shot"
                bind:value={newUnitAbbr} on:keydown={e => e.key==='Enter' && addCustomUnit()} />
            </div>
            <div style="display:flex;flex-direction:column;gap:3px;flex:1">
              <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">Full name</span>
              <input class="input" style="height:40px" placeholder="shot glass"
                bind:value={newUnitFull} on:keydown={e => e.key==='Enter' && addCustomUnit()} />
            </div>
            <button class="btn btn-secondary" style="height:40px;padding:0 16px;align-self:flex-end" on:click={addCustomUnit}>Add</button>
          </div>
        </div>
      </div>
    {/if}


    <p class="settings-group-label">Integrations</p>
    <!-- ── Food Sources ───────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'connectedServices')} on:click={() => toggleSection('connectedServices')}>
      <span class="material-symbols-rounded si">hub</span>
      <span>{$_('settings.connected_services.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.connectedServices}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'connectedServices') && sectionVisible(settingsQuery, 'connectedServices')}
      <div class="section-body" transition:slide={{ duration: 180 }}>

        <p class="sub-label">{$_('settings.connected_services.off.header')}</p>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">{$_('settings.connected_services.off.enable')}</span>
              <div class="setting-desc">
                {$_('settings.connected_services.off.enable_desc')}
              </div>
            </div>
            <Toggle checked={offEnabled} on:change={e => { offEnabled = e.detail; set('offEnabled', e.detail); }} />
          </div>
          {#if offEnabled}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">{$_('settings.connected_services.off.search_language')}</span>
              <div class="select-wrap" style="width:120px">
                <select class="select sel-sm" bind:value={offSearchLanguage}>
                  {#each OFF_LANGUAGE_OPTS as [v,l]}<option value={v}>{l}</option>{/each}
                </select>
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">{$_('settings.connected_services.off.search_country')}</span>
              <div class="select-wrap" style="width:150px">
                <select class="select sel-sm" bind:value={offSearchCountry}>
                  {#each OFF_COUNTRY_OPTS as c}<option value={c}>{c}</option>{/each}
                </select>
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">{$_('settings.connected_services.off.upload_country')}</span>
              <div class="select-wrap" style="width:150px">
                <select class="select sel-sm" bind:value={offUploadCountry}>
                  <option value="Auto">{$_('settings.connected_services.off.upload_country_auto')}</option>
                  {#each OFF_COUNTRY_OPTS.filter(c => c !== 'World') as c}<option value={c}>{c}</option>{/each}
                </select>
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">{$_('settings.connected_services.off.import_portion')}</span>
                <div class="setting-desc">
                  {$_('settings.connected_services.off.import_portion_desc')}
                </div>
              </div>
              <div class="select-wrap" style="width:150px">
                <select class="select sel-sm" bind:value={offImportPortion}>
                  <option value="per100g">{$_('settings.connected_services.off.import_portion_100g')}</option>
                  <option value="perServing">{$_('settings.connected_services.off.import_portion_serving')}</option>
                </select>
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="form-group" style="padding:10px 16px 14px">
              <label class="form-label" for="off-user">{$_('settings.connected_services.off.account_username')}</label>
              <div class="setting-desc" style="margin:0 0 8px 0;line-height:1.4">
                {$_('settings.connected_services.off.account_note')}
                <a href="https://world.openfoodfacts.org/cgi/user.pl" target="_blank" rel="noopener" class="about-link">{$_('settings.connected_services.off.account_create_link')}</a>
              </div>
              <input id="off-user" class="input" style="margin-bottom:8px" placeholder={$_('settings.connected_services.off.username_placeholder')} bind:value={offUsername} />
              <label class="form-label" for="off-pass">{$_('settings.connected_services.off.account_password')}</label>
              <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
                {#if offShowPass}
                  <input id="off-pass" class="input" type="text" style="flex:1" placeholder={$_('settings.connected_services.off.password_placeholder')} bind:value={offPassword} />
                {:else}
                  <input id="off-pass" class="input" type="password" style="flex:1" placeholder={$_('settings.connected_services.off.password_placeholder')} bind:value={offPassword} />
                {/if}
                <button class="btn-icon" on:click={() => offShowPass = !offShowPass} title={offShowPass ? 'Hide' : 'Show'}>
                  <span class="material-symbols-rounded">{offShowPass ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
              <button class="btn btn-primary" style="height:36px;font-size:13px;align-self:flex-start" on:click={saveOff}>
                {#if offSaved}<span class="material-symbols-rounded" style="font-size:16px">check</span> Saved{:else}Save{/if}
              </button>
            </div>
          {/if}
        </div>

        <p class="sub-label">USDA FoodData Central</p>
        <div class="card settings-card">
          {#if usdaEnabled}
            <ConnectionStatus
              status={usdaBannerStatus}
              error={usdaTestStatus === 'fail' ? 'Check API key' : ''}
              onRetest={() => testUsdaConnection()}
              retestDisabled={usdaTestStatus === 'testing' || !usdaApiKey}
            />
          {/if}
          <div class="setting-row">
            <div>
              <span class="setting-label">Enable USDA FoodData</span>
              <div class="setting-desc">
                Search the USDA nutrition database when adding foods.
                <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener" class="about-link">Get a free API key →</a>
              </div>
            </div>
            <Toggle checked={usdaEnabled} on:change={e => { usdaEnabled = e.detail; set('usdaEnabled', e.detail); }} />
          </div>
          {#if usdaEnabled}
            <div class="setting-divider"></div>
            <div class="form-group" style="padding:10px 16px 14px">
              <label class="form-label" for="usda-key">API Key</label>
              <input id="usda-key" class="input" type="text"
                placeholder="Paste your USDA API key here"
                bind:value={usdaApiKey}
                on:blur={saveUsda}
                autocomplete="off" style="width:100%" />
            </div>
          {/if}
        </div>

        <p class="sub-label">Mealie</p>
        <div class="card settings-card">
          {#if mealieEnabled}
            <ConnectionStatus
              status={mealieBannerStatus}
              error={mealieTestStatus === 'fail' ? 'Check URL and token' : ''}
              onRetest={() => testMealieConnection()}
              retestDisabled={mealieTestStatus === 'testing' || !mealieBaseUrl || !mealieApiToken}
            />
          {/if}
          <div class="setting-row">
            <div>
              <span class="setting-label">Enable Mealie</span>
              <div class="setting-desc">Import recipes from your self-hosted Mealie instance</div>
            </div>
            <Toggle checked={mealieEnabled} on:change={e => { mealieEnabled = e.detail; set('mealieEnabled', e.detail); }} />
          </div>
          {#if mealieEnabled}
            <div class="setting-divider"></div>
            <div class="form-group" style="padding:10px 16px">
              <label class="form-label" for="mealie-base-url">Base URL</label>
              <input id="mealie-base-url" class="input" type="url"
                placeholder="https://mealie.example.com"
                bind:value={mealieBaseUrl}
                on:blur={saveMealie}
                style="width:100%" />
            </div>
            <div class="setting-divider"></div>
            <div class="form-group" style="padding:10px 16px">
              <label class="form-label" for="mealie-api-token">API Token</label>
              <div style="display:flex;gap:8px;align-items:center">
                {#if mealieShowToken}
                  <input id="mealie-api-token" class="input" type="text"
                    placeholder="Bearer token"
                    bind:value={mealieApiToken}
                    on:blur={saveMealie}
                    autocomplete="off" style="flex:1" />
                {:else}
                  <input id="mealie-api-token" class="input" type="password"
                    placeholder="Bearer token"
                    bind:value={mealieApiToken}
                    on:blur={saveMealie}
                    autocomplete="off" style="flex:1" />
                {/if}
                <button class="btn-icon" on:click={() => mealieShowToken = !mealieShowToken}
                  title={mealieShowToken ? 'Hide' : 'Show'}>
                  <span class="material-symbols-rounded">{mealieShowToken ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ── AI Assistant ──────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'ai')} on:click={() => toggleSection('ai')}>
      <span class="material-symbols-rounded si">smart_toy</span>
      <span>{$_('settings.ai.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.ai}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'ai') && sectionVisible(settingsQuery, 'ai')}
      <SettingsTrace envLocks={envLocks} />
    {/if}

    <!-- Notifications moved to App group (it's internal scheduling, not an external integration). -->

    <!-- ── Wellness ──────────────────────────────────────────────────────────── -->
    <button class="section-toggle wellness-toggle" class:hidden={!sectionVisible(settingsQuery, 'wellness')} on:click={() => { toggleSection('wellness'); wellnessRef?.loadWellnessConfig(); }}>
      <span class="material-symbols-rounded si">monitor_heart</span>
      <span>{$_('settings.wellness.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.wellness}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'wellness') && sectionVisible(settingsQuery, 'wellness')}
      <SettingsWellness bind:this={wellnessRef} />
    {/if}

    <p class="settings-group-label">App</p>

    <!-- ── Server Connection (native only — manages connection to a remote
         NutriTrace server). PWA users have no "server connection" concept;
         their Log Out lives in My Profile. -->
    {#if isNative}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'serverConnection')} on:click={() => toggleSection('serverConnection')}>
      <span class="material-symbols-rounded si">cloud_sync</span>
      <span>{$_('settings.server.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.serverConnection}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'serverConnection') && sectionVisible(settingsQuery, 'serverConnection')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          {#if serverMode === 'server' && getServerUrl()}
            <div class="setting-row">
              <div>
                <span class="setting-label">Connected</span>
                <div class="setting-desc">{getServerUrl()}</div>
              </div>
              <span class="material-symbols-rounded" style="color:var(--success, #22c55e);font-size:22px">cloud_done</span>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Last Synced</span>
                <div class="setting-desc">
                  {#key _nowTick}{_fmtTimeAgo(lastSyncAt)}{/key}
                </div>
              </div>
              <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px;display:flex;align-items:center;gap:6px" on:click={manualSync} disabled={_syncing}>
                <span class="material-symbols-rounded" class:spin={_syncing} style="font-size:16px">{_syncing ? 'autorenew' : 'sync'}</span>
                {_syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
            <div class="setting-divider"></div>
            <div style="padding:12px 16px;display:flex;flex-direction:column;gap:8px">
              <button class="btn btn-ghost w-full" on:click={logoutServer}>
                <span class="material-symbols-rounded" style="font-size:18px">logout</span>
                Log Out
              </button>
              <button class="btn btn-ghost w-full" style="color:var(--error,#f87171)" on:click={disconnectServer}>
                <span class="material-symbols-rounded" style="font-size:18px">link_off</span>
                Disconnect &amp; Use Locally
              </button>
            </div>
          {:else}
            <div class="setting-row">
              <div>
                <span class="setting-label">Local Mode</span>
                <div class="setting-desc">All data stored on this device only</div>
              </div>
              <span class="material-symbols-rounded" style="color:var(--text-3);font-size:22px">smartphone</span>
            </div>
            <div class="setting-divider"></div>
            <div style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
              <div class="form-group" style="margin:0">
                <label class="form-label">Server URL</label>
                <input class="input" type="url" placeholder="https://nutritrace.example.com" bind:value={serverUrlInput} />
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Username</label>
                <input class="input" type="text" placeholder="Your username" bind:value={serverUsername} autocapitalize="off" />
              </div>
              <div class="form-group" style="margin:0">
                <label class="form-label">Password</label>
                <div style="position:relative">
                  {#if serverShowPw}
                    <input class="input" type="text" placeholder="Your password" bind:value={serverPassword} style="padding-right:40px" />
                  {:else}
                    <input class="input" type="password" placeholder="Your password" bind:value={serverPassword} style="padding-right:40px" />
                  {/if}
                  <button type="button" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-3);padding:4px" on:click={() => serverShowPw = !serverShowPw}>
                    <span class="material-symbols-rounded" style="font-size:20px">{serverShowPw ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
              </div>
              <button class="btn btn-primary w-full" on:click={connectServer} disabled={serverConnecting}>
                {serverConnecting ? 'Connecting…' : 'Connect to Server'}
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
    {/if}

    <!-- ── Notifications ────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'notifications')} on:click={() => toggleSection('notifications')}>
      <span class="material-symbols-rounded si">notifications</span>
      <span>{$_('settings.notifications.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.notifications}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'notifications') && sectionVisible(settingsQuery, 'notifications')}
      <SettingsNotifications />
    {/if}

    <!-- ── Backup & Restore ────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'backup')} on:click={() => toggleSection('backup')}>
      <span class="material-symbols-rounded si">backup</span>
      <span>{$_('settings.backup.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.backup}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'backup') && sectionVisible(settingsQuery, 'backup')}
      <SettingsBackup bind:this={backupRef} />
    {/if}

    <!-- ── Import & Export ─────────────────────────────────────────────────── -->
    <!-- Holds the lightweight per-dataset import/export rows (JSON backup,
         Bulk Import Foods, Diary CSV) plus the MFP/Cronometer/LoseIt
         importer. Full-account snapshots live in the Backup section above. -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'importExport')} on:click={() => toggleSection('importExport')}>
      <span class="material-symbols-rounded si">import_export</span>
      <span>{$_('settings.importExport.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.importExport}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'importExport') && sectionVisible(settingsQuery, 'importExport')}
      <SettingsImportExport />
      {#if !isNativeLocal}
        <SettingsNutritionImport />
      {/if}
    {/if}

    <!-- Users / Authentication / Email moved to the Admin group below Diagnostics. -->

    <!-- ── Food Sharing (per-user; hidden in native local mode — no one to share with) ─ -->
    {#if $userMgmtActive && !isNativeLocal}
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'sharing')} on:click={() => toggleSection('sharing')}>
        <span class="material-symbols-rounded si">group</span>
        <span>{$_('settings.sharing.section')}</span>
        <span class="material-symbols-rounded chevron" class:rotated={openSections.sharing}>expand_more</span>
      </button>
      {#if sectionOpen(openSections, settingsQuery, 'sharing') && sectionVisible(settingsQuery, 'sharing')}
        <div class="section-body" transition:slide={{ duration: 180 }}>
          {#if $currentUser?.role === 'admin'}
            <p class="sub-label">Admin</p>
            <div class="card settings-card">
              <div class="setting-row">
                <div>
                  <span class="setting-label">Enable Food Sharing</span>
                  <span class="setting-desc">Allow group members to share foods, meals, and recipes with each other</span>
                </div>
                <Toggle checked={adminSharingEnabled} on:change={e => saveAdminSharingEnabled(e.detail)} />
              </div>
            </div>
          {/if}
          {#if adminSharingEnabled}
          <p class="sub-label">Bulk Share</p>
          <p class="setting-desc" style="padding:0 var(--page-px) 6px;line-height:1.5">
            Set who can see your existing items. Each category has its own visibility, so changing one doesn't affect the others.
          </p>
          <div class="card settings-card" style="gap:0">
            {#each [
              { key: 'foods',   label: 'Foods'   },
              { key: 'meals',   label: 'Meals'   },
              { key: 'recipes', label: 'Recipes' },
            ] as cat, ci}
              {#if ci > 0}<div class="setting-divider"></div>{/if}
              {@const _vis    = cat.key === 'foods' ? bulkVisFoods   : cat.key === 'meals' ? bulkVisMeals   : bulkVisRecipes}
              {@const _users  = cat.key === 'foods' ? bulkUsersFoods : cat.key === 'meals' ? bulkUsersMeals : bulkUsersRecipes}
              <div class="setting-row">
                <span class="setting-label">{cat.label}</span>
                <div class="select-wrap" style="width:160px">
                  <select class="select sel-sm"
                    on:change={e => {
                      const v = e.target.value;
                      if (cat.key === 'foods')   bulkVisFoods   = v;
                      if (cat.key === 'meals')   bulkVisMeals   = v;
                      if (cat.key === 'recipes') bulkVisRecipes = v;
                    }}
                    value={_vis}>
                    <option value="private">Private</option>
                    <option value="group">Everyone</option>
                    <option value="specific">Specific People</option>
                  </select>
                </div>
              </div>
              {#if _vis === 'specific'}
                <div style="padding:0 16px 12px">
                  <div class="setting-desc" style="margin-bottom:8px">Members who can see your {cat.label.toLowerCase()}:</div>
                  <div style="display:flex;flex-wrap:wrap;gap:8px">
                    {#each bulkUsers as u}
                      <button class="chip" class:chip-active={_users.includes(u.id)}
                        on:click={() => toggleBulkUserFor(cat.key, u.id)}>
                        {#if _users.includes(u.id)}<span class="material-symbols-rounded" style="font-size:14px">check</span>{/if}
                        {u.name}
                      </button>
                    {/each}
                    {#if !bulkUsersLoaded}<span class="setting-desc">Loading…</span>{/if}
                  </div>
                </div>
              {/if}
            {/each}
            <div style="padding:8px 16px 12px">
              <button class="btn btn-secondary w-full" on:click={applyBulkShare} disabled={bulkApplying}>
                {bulkApplying ? 'Applying…' : 'Apply to Existing Items'}
              </button>
            </div>
          </div>
          {/if}
        </div>
      {/if}
    {/if}

    <!-- Diagnostics -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'helpImprove')} on:click={() => toggleSection('helpImprove')}>
      <span class="material-symbols-rounded si">troubleshoot</span>
      <span>{$_('settings.diagnostics.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.helpImprove}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'helpImprove') && sectionVisible(settingsQuery, 'helpImprove')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Diagnostic Mode</span>
              <div class="setting-desc">Enables detailed app-internal logs (sync, settings, notifications, Health Connect) and{isNative ? ' writes them to a daily log file on disk so they survive crashes and reloads.' : ' enables verbose console output.'} Off by default — turn on while reproducing a bug, then export below.</div>
            </div>
            <Toggle checked={_verboseLogging} on:change={e => _toggleVerbose(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <span class="setting-label">View Diagnostic Logs</span>
            <p class="setting-desc" style="line-height:1.5">
              Recent log lines from the app's console. Useful for bug reports — copy / share into a <a href="https://github.com/traceapps/nutritrace/issues" target="_blank" rel="noopener" class="about-link">GitHub issue</a>.{isNative ? ' On Android with Diagnostic Mode on, you can also share the persisted log file or any captured crash report.' : ''} Nothing is sent anywhere automatically.
            </p>
            <button class="btn btn-secondary" style="height:40px;font-size:13px" on:click={_openLogsSheet}>
              <span class="material-symbols-rounded" style="font-size:16px">terminal</span>
              View logs{hasCrashReport() ? ' · crash report available' : ''}
            </button>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <span class="setting-label">Calibration Export</span>
            <p class="setting-desc" style="line-height:1.5">
              Anonymized 30-day JSON of your wellness data (HRV, RHR, sleep, calculated Trace scores). Useful for tracking how Trace scores compare to your device's own scores over time, or for attaching to a wellness-related bug report. Held in-memory until you copy it — nothing is sent anywhere automatically. Review the JSON before sharing.
            </p>
            <div class="form-group" style="width:100%;padding:0">
              <label class="form-label" for="calib-device">Your device (optional, free text)</label>
              <input id="calib-device" class="input" placeholder="e.g. Pixel Watch 4, Fitbit Charge 6, Sense 2"
                bind:value={_calibDeviceLabel} />
            </div>
            <button class="btn btn-primary" style="height:40px;font-size:13px" on:click={() => { _generateCalibExport(); _calibExportSheet = true; }}>
              <span class="material-symbols-rounded" style="font-size:16px">data_object</span>
              Generate calibration export
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Admin group (server-side users / auth / SMTP — only meaningful
         when there's a real server with user management to administer).
         Shown when: not native standalone AND (single-user → Users
         on-ramp visible to the synthetic admin, or multi-user admin
         viewer). Hidden entirely for non-admin members on multi-user. -->
    {#if !isNativeLocal && (!$userMgmtActive || $currentUser?.role === 'admin')}
    <p class="settings-group-label">Admin</p>

    <!-- ── Users (was "User Management" — admin features for the user directory) -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'users')} on:click={() => toggleSection('users')}>
      <span class="material-symbols-rounded si">group</span>
      <span>{$_('settings.users.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.users}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'users') && sectionVisible(settingsQuery, 'users')}
      <SettingsUserManagement bind:this={userMgmtRef} />
    {/if}

    <!-- ── Authentication (OIDC SSO + password-login toggle) ──────────────── -->
    {#if $userMgmtActive && $currentUser?.role === 'admin'}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'authentication')} on:click={() => toggleSection('authentication')}>
      <span class="material-symbols-rounded si">vpn_key</span>
      <span>{$_('settings.authentication.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.authentication}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'authentication') && sectionVisible(settingsQuery, 'authentication')}
      <SettingsAuth bind:this={authRef} />
    {/if}
    {/if}

    <!-- ── Email (SMTP — admin only, for password resets and invites) ────── -->
    {#if $currentUser?.role === 'admin'}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'email')} on:click={() => toggleSection('email')}>
      <span class="material-symbols-rounded si">mail</span>
      <span>{$_('settings.email.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.email}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'email') && sectionVisible(settingsQuery, 'email')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <p class="sub-label" style="padding-bottom:4px">Used for password resets and user invites</p>
        {#if envLocks.smtp}
          <div class="env-lock-banner">
            <span class="material-symbols-rounded">lock</span>
            Configured via environment variables — changes are disabled.
          </div>
        {/if}
        <div class="card settings-card">
          {#if !envLocks.smtp}
            <ConnectionStatus
              status={smtpBannerStatus}
              okLabel={smtpBannerLabel}
              subtext={smtpBannerSubtext}
              error={smtpTestStatus === 'fail' ? 'Check host, credentials, and from address' : ''}
              onRetest={() => testSmtp()}
              retestDisabled={smtpTestStatus === 'testing' || !smtpHost}
              retestLabel="Send Test"
            />
          {/if}
          <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
            <div class="form-group">
              <label class="form-label">SMTP Host</label>
              <input class="input" type="text" placeholder="e.g. smtp.example.com"
                bind:value={smtpHost} on:blur={saveSmtpHost} disabled={envLocks.smtp} />
            </div>
            <div style="display:flex;gap:10px">
              <div class="form-group" style="flex:1">
                <label class="form-label">Port</label>
                <input class="input" type="number" placeholder="587"
                  bind:value={smtpPort} on:blur={saveSmtpPort} disabled={envLocks.smtp} />
              </div>
              <div class="form-group" style="display:flex;flex-direction:column;gap:6px;justify-content:flex-end;padding-bottom:2px">
                <label class="form-label">TLS</label>
                <Toggle checked={smtpSecure} on:change={e => { smtpSecure = e.detail; saveSmtpSecure(); }} disabled={envLocks.smtp} />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Username</label>
              <input class="input" type="text" autocomplete="off" placeholder="SMTP username or email"
                bind:value={smtpUser} on:blur={saveSmtpUser} disabled={envLocks.smtp} />
            </div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <div style="display:flex;gap:8px;align-items:center">
                {#if smtpShowPass}
                  <input class="input" style="flex:1" type="text" autocomplete="new-password" placeholder="SMTP password or app password"
                    bind:value={smtpPass} on:blur={saveSmtpPass} disabled={envLocks.smtp} />
                {:else}
                  <input class="input" style="flex:1" type="password" autocomplete="new-password" placeholder="SMTP password or app password"
                    bind:value={smtpPass} on:blur={saveSmtpPass} disabled={envLocks.smtp} />
                {/if}
                <button class="btn-icon" on:click={() => smtpShowPass = !smtpShowPass} title={smtpShowPass ? 'Hide' : 'Show'}>
                  <span class="material-symbols-rounded">{smtpShowPass ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">From Address</label>
              <input class="input" type="email" placeholder='NutriTrace <noreply@example.com>'
                bind:value={smtpFrom} on:blur={saveSmtpFrom} disabled={envLocks.smtp} />
            </div>
          </div>
        </div>
      </div>
    {/if}
    {/if}

    <!-- ── API Tokens (federation API access — admin only on multi-user, gated by NT_FEATURES_API=1) ── -->
    {#if $serverFeatures.apiTokens && $userMgmtActive && $currentUser?.role === 'admin'}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'apiTokens')} on:click={() => toggleSection('apiTokens')}>
      <span class="material-symbols-rounded si">key</span>
      <span>API Tokens</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.apiTokens}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'apiTokens') && sectionVisible(settingsQuery, 'apiTokens')}
      <SettingsApiTokens expanded={openSections.apiTokens} />
    {/if}
    {/if}
    {/if}

    <!-- About — standalone footer item, no group label. Always last. -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'about')} on:click={() => toggleSection('about')}>
      <span class="material-symbols-rounded si">info</span>
      <span>{$_('settings.about.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.about}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'about') && sectionVisible(settingsQuery, 'about')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="about-hero">
            <img src={resolveAssetUrl('/icons/logo.png')} alt="NutriTrace" class="about-icon" />
            <div>
              <div class="about-name">NutriTrace</div>
              <div class="about-version text-3 text-sm">
                {APP_VERSION}
                <span class="platform-tag">{isNative ? 'Android' : 'PWA'}</span>
              </div>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="about-desc">
            Trace Every Bite — Personal Nutrition Tracker. NutriTrace is a self-hosted nutrition,
            wellness, and fitness tracker built for privacy. Your data lives on your server, not
            in the cloud. Features food diary, wellness integrations (Fitbit, Garmin, Withings,
            Health Connect), AI assistant, workout GPS maps, goal tracking, and more.
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">database</span>
            <span>Self-hosted — your data, your server</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">phone_android</span>
            <span>Native Android app with offline support, plus a PWA for any browser</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">lock</span>
            <span>No tracking, no ads, no third-party analytics</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">restaurant_menu</span>
            <span>Food data from <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener" class="about-link">Open Food Facts</a> (ODbL)</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">code</span>
            <span>Server: <a href="https://github.com/traceapps/nutritrace" target="_blank" rel="noopener" class="about-link">Open source</a> (AGPL-3.0)</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="material-symbols-rounded about-feat-icon">volunteer_activism</span>
              <span>Support development</span>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;padding-left:30px">
              <!-- GitHub Sponsors button removed pending traceapps org Sponsors approval — re-add when live -->
              <a href="https://ko-fi.com/traceapps" target="_blank" rel="noopener" class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 12px">
                <span class="material-symbols-rounded" style="font-size:14px">coffee</span> Ko-fi
              </a>
            </div>
            <div class="setting-desc" style="padding-left:30px;font-size:11px">NutriTrace is free to self-host. Donations are appreciated but never required.</div>
          </div>
          <div class="setting-divider"></div>
          <div class="about-desc" style="font-size:11px;color:var(--text-3);line-height:1.5">
            NutriTrace is not medical software. It does not provide medical advice, diagnosis, or treatment.
            Wellness scores, readiness, and stress estimates are approximations and should not be used for
            medical decisions. Always consult a healthcare professional for medical advice. Food nutrition
            data is sourced from public databases and may contain inaccuracies. Use at your own discretion.
          </div>
        </div>
      </div>
    {/if}

    <div style="height:24px"></div>
  </div>

</div>

<!-- Merge dialog (shown when connecting to server with existing local data) -->
{#if mergeStep === 'ask-settings'}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 style="margin:0 0 6px;font-size:18px;color:var(--text-1)">Sync Options</h3>
      <p style="font-size:13px;color:var(--text-3);margin:0 0 12px;line-height:1.5">
        You have data on this phone. How should it be handled when connecting?
      </p>
      {#if localCounts && localCounts.total > 0}
        <div class="merge-counts" style="margin:0 0 16px">
          <div class="merge-counts-title">On this phone:</div>
          <div class="merge-counts-grid">
            {#if localCounts.foods    > 0}<div><strong>{localCounts.foods}</strong> {localCounts.foods === 1 ? 'food' : 'foods'}</div>{/if}
            {#if localCounts.meals    > 0}<div><strong>{localCounts.meals}</strong> {localCounts.meals === 1 ? 'meal' : 'meals'}</div>{/if}
            {#if localCounts.recipes  > 0}<div><strong>{localCounts.recipes}</strong> {localCounts.recipes === 1 ? 'recipe' : 'recipes'}</div>{/if}
            {#if localCounts.diary    > 0}<div><strong>{localCounts.diary}</strong> diary {localCounts.diary === 1 ? 'day' : 'days'}</div>{/if}
            {#if localCounts.settings > 0}<div><strong>{localCounts.settings}</strong> settings</div>{/if}
          </div>
        </div>
      {/if}
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="merge-option" on:click={() => _mergeAndConnect('upload')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">cloud_upload</span>
          <div>
            <div class="merge-option-title">Upload phone to server</div>
            <div class="merge-option-desc">Send this phone's foods, diary, and settings to the server. Existing server data stays.</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('download')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">cloud_download</span>
          <div>
            <div class="merge-option-title">Download server to phone</div>
            <div class="merge-option-desc">Replace this phone's data with everything from the server. Local data is discarded.</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('merge')}>
          <span class="material-symbols-rounded" style="font-size:22px;color:var(--accent)">sync</span>
          <div>
            <div class="merge-option-title">Merge both</div>
            <div class="merge-option-desc">Upload phone data to the server AND download server data. Nothing is lost, but duplicates are possible.</div>
          </div>
        </button>
        <button class="btn btn-ghost w-full" style="color:var(--text-3);margin-top:4px" on:click={cancelMerge}>Cancel</button>
      </div>
    </div>
  </div>
{:else if mergeStep === 'syncing'}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog" style="text-align:center">
      <span class="material-symbols-rounded" style="font-size:36px;color:var(--accent);animation:spin 1.2s linear infinite">sync</span>
      <p style="font-size:15px;color:var(--text-1);margin:12px 0 4px;font-weight:600">Syncing…</p>
      <p style="font-size:13px;color:var(--text-3);margin:0">{mergeProgress || 'Preparing…'}</p>
      {#if mergeProgressPct > 0}
        <div class="merge-progress-bar" style="margin-top:14px">
          <div class="merge-progress-fill" style="width:{mergeProgressPct}%"></div>
        </div>
      {/if}
    </div>
  </div>
{:else if mergeStep === 'summary' && migrationSummary}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 style="margin:0 0 6px;font-size:18px;color:var(--text-1)">
        {migrationSummary.errors.length === 0 ? 'Upload complete' : 'Upload finished with issues'}
      </h3>
      <p style="font-size:13px;color:var(--text-3);margin:0 0 14px;line-height:1.5">
        {migrationSummary.totalSuccess} of {migrationSummary.total} {migrationSummary.total === 1 ? 'item' : 'items'} uploaded successfully.
      </p>
      <div class="merge-counts" style="margin:0 0 14px">
        <div class="merge-counts-title">Uploaded to server:</div>
        <div class="merge-counts-grid">
          {#if migrationSummary.success.foods    > 0}<div><strong>{migrationSummary.success.foods}</strong> {migrationSummary.success.foods === 1 ? 'food' : 'foods'}</div>{/if}
          {#if migrationSummary.success.meals    > 0}<div><strong>{migrationSummary.success.meals}</strong> {migrationSummary.success.meals === 1 ? 'meal' : 'meals'}</div>{/if}
          {#if migrationSummary.success.recipes  > 0}<div><strong>{migrationSummary.success.recipes}</strong> {migrationSummary.success.recipes === 1 ? 'recipe' : 'recipes'}</div>{/if}
          {#if migrationSummary.success.diary    > 0}<div><strong>{migrationSummary.success.diary}</strong> diary {migrationSummary.success.diary === 1 ? 'day' : 'days'}</div>{/if}
          {#if migrationSummary.success.settings > 0}<div><strong>{migrationSummary.success.settings}</strong> settings</div>{/if}
        </div>
      </div>
      {#if migrationSummary.errors.length > 0}
        <div style="margin:0 0 14px">
          <div class="merge-counts-title" style="color:var(--danger,#e57373)">
            {migrationSummary.errors.length} {migrationSummary.errors.length === 1 ? 'error' : 'errors'}
            {#if migrationSummary.errors.length > 5}(showing first 5){/if}
          </div>
          <ul style="font-size:12px;color:var(--text-3);padding-left:18px;margin:6px 0 0;line-height:1.5">
            {#each migrationSummary.errors.slice(0, 5) as err}
              <li><strong>{err.stage}</strong> · {err.name}: {err.message}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <button class="btn btn-primary w-full" on:click={_finalizeConnect}>Continue</button>
    </div>
  </div>
{/if}


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
      <label class="form-label">Saturation</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-sat" min="0" max="100"
          bind:value={cpSat} on:input={cpUpdateFromSliders}
          style="--cp-sat-lo:hsl({cpHue},0%,{cpLgt}%);--cp-sat-hi:hsl({cpHue},100%,{cpLgt}%)" />
      </div>
    </div>
    <!-- Lightness slider -->
    <div class="cp-slider-group">
      <label class="form-label">Lightness</label>
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
      <label class="form-label">Hex Code</label>
      <div class="cp-hex-row">
        <span class="cp-hex-dot" style="background:{/^#[0-9a-fA-F]{6}$/.test(customHexInput) ? customHexInput : '#ccc'}"></span>
        <input class="input" type="text" placeholder="#rrggbb" maxlength="7"
          style="font-family:monospace;letter-spacing:0.05em;flex:1"
          bind:value={customHexInput}
          on:input={cpUpdateFromHex}
          on:keydown={e => e.key === 'Enter' && applyCustomColor()} />
      </div>
    </div>
    <button class="btn btn-primary w-full" style="height:44px;margin-top:4px" on:click={applyCustomColor}>Apply Color</button>
  </div>
</Sheet>

<!-- Custom nutrient sheet -->
<Sheet bind:open={showNutrientSheet} title="Add Custom Nutrient">
  <div style="display:flex;flex-direction:column;gap:16px;padding-top:8px">
    <div class="form-group">
      <label class="form-label" for="cn-label">Nutrient name</label>
      <input id="cn-label" class="input" placeholder="e.g. Omega-3" bind:value={newNutrient.label} />
    </div>
    <div class="form-group">
      <label class="form-label" for="cn-unit">Unit</label>
      <div class="select-wrap">
        <select id="cn-unit" class="select" bind:value={newNutrient.unit}>
          <option value="g">g</option>
          <option value="mg">mg</option>
          <option value="µg">µg</option>
          <option value="IU">IU</option>
          <option value="kcal">kcal</option>
          <option value="kJ">kJ</option>
          <option value="%">%</option>
        </select>
      </div>
    </div>
    <button class="btn btn-primary w-full" on:click={addCustomNutrient}>Add Nutrient</button>
  </div>
</Sheet>

<!-- Diagnostic logs viewer -->
<Sheet bind:open={_logsSheet} title="Diagnostic Logs">
  <div style="padding:0 4px 8px">
    <p class="setting-desc" style="line-height:1.5;margin-bottom:10px">
      Recent log lines (capped at 500 normally, 1000 in verbose mode). Header shows app version + platform so the recipient knows what they're looking at. <strong>Redact</strong> any HRV / RHR / weight / calorie values before posting publicly — they're personal health data.
    </p>
    <textarea readonly style="width:100%;height:280px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:var(--surface-2);color:var(--text-1);resize:vertical;white-space:pre">{_logsText}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-primary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_copyLogs}>
        {#if _logsCopied}
          <span class="material-symbols-rounded" style="font-size:16px">check</span> Copied
        {:else}
          <span class="material-symbols-rounded" style="font-size:16px">content_copy</span> Copy
        {/if}
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_shareLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">share</span> Share text
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_clearLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">delete</span> Clear
      </button>
    </div>
    {#if isNative && _verboseLogging}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-secondary" style="flex:1;height:40px;font-size:13px" on:click={_shareLogFile}>
          <span class="material-symbols-rounded" style="font-size:16px">description</span> Share log file
        </button>
      </div>
      <p class="setting-desc" style="margin-top:6px;font-size:11px">
        Today's persisted log on disk (rotates daily, last 7 days kept). Better for long sessions or after a crash — the in-memory buffer above resets every reload.
      </p>
    {/if}
    {#if isNative && _hasCrashReport}
      <div style="margin-top:14px;padding:10px;background:color-mix(in srgb,var(--danger) 8%, transparent);border-left:3px solid var(--danger);border-radius:var(--radius-sm,6px)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger)">warning</span>
          <strong style="color:var(--danger);font-size:14px">Crash report available</strong>
        </div>
        <p class="setting-desc" style="margin:0 0 8px;font-size:12px">
          The app captured an uncaught error. Share the report to help track it down, then dismiss it.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1;height:36px;font-size:12px" on:click={_shareCrashReport}>
            <span class="material-symbols-rounded" style="font-size:14px">share</span> Share crash report
          </button>
          <button class="btn btn-ghost" style="flex:1;height:36px;font-size:12px" on:click={_clearCrashReport}>
            Dismiss
          </button>
        </div>
      </div>
    {/if}
  </div>
</Sheet>

<!-- Calibration Export preview -->
<Sheet bind:open={_calibExportSheet} title="Calibration Export — Review">
  <div style="padding:0 4px 8px">
    <p class="setting-desc" style="line-height:1.5;margin-bottom:10px">
      {_calibExportCount} day{_calibExportCount === 1 ? '' : 's'} of data, anonymized. Review the JSON below before sharing — nothing is uploaded automatically.
    </p>
    <textarea readonly style="width:100%;height:240px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:var(--surface-2);color:var(--text-1);resize:vertical">{_calibExportJson}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn btn-primary" style="flex:1;height:40px;font-size:13px" on:click={_copyCalibExport}>
        {#if _calibCopied}
          <span class="material-symbols-rounded" style="font-size:16px">check</span> Copied
        {:else}
          <span class="material-symbols-rounded" style="font-size:16px">content_copy</span> Copy JSON
        {/if}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .settings-content { display: flex; flex-direction: column; gap: 0; }
  .hidden { display: none !important; }

  /* Settings header + search bar pinned together. Single sticky-top wrapper
     is more reliable than two separate sticky elements with computed offsets.
     The nested .page-header switches to static so it doesn't double-stick
     inside this container. */
  .settings-sticky-top {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--bg);
  }
  .settings-sticky-top :global(.page-header) {
    position: static;
  }
  .settings-search-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px var(--page-px, 16px) 12px;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
  }
  .settings-search-icon { font-size: 20px; color: var(--text-3); flex-shrink: 0; }
  .settings-search-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 7px 14px;
    font-size: 15px;
    color: var(--text-1);
    outline: none;
  }
  .settings-search-input:focus { border-color: var(--accent); }
  .settings-search-clear { color: var(--text-3); }

  /* Profile hero — identity card at the top of Settings */
  .profile-hero {
    display: flex; align-items: center; gap: 14px;
    width: 100%;
    margin: 4px var(--page-px) 14px;
    padding: 14px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    color: var(--text-1);
    cursor: pointer;
    font-family: inherit; text-align: left;
    transition: background var(--dur-fast), transform var(--dur-fast);
    width: calc(100% - var(--page-px) * 2);
  }
  .profile-hero:hover  { background: var(--surface-3); }
  .profile-hero:active { transform: scale(0.99); }
  .profile-hero-avatar {
    width: 48px; height: 48px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; overflow: hidden;
  }
  .profile-hero-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .profile-hero-avatar :global(.material-symbols-rounded) { font-size: 26px; }
  .profile-hero-initial { font-size: 20px; font-weight: 700; line-height: 1; }
  .profile-hero-info { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .profile-hero-name {
    font-size: 17px; font-weight: 700; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .profile-hero-role {
    align-self: flex-start;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--accent); background: var(--accent-dim);
    padding: 2px 8px; border-radius: var(--radius-full, 999px);
  }
  .profile-hero-sub { font-size: 13px; color: var(--text-3); }
  .profile-hero-chev { color: var(--text-3); flex-shrink: 0; }

  /* Section toggle button */
  .section-toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 14px var(--page-px);
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition: background var(--dur-fast);
  }
  .section-toggle:hover  { background: var(--surface-2); }
  .section-toggle:active { background: var(--surface-3); }
  .si {
    font-size: 18px;
    color: var(--accent);
    flex-shrink: 0;
    width: 30px; height: 30px;
    background: var(--accent-dim);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
  }
  .settings-group-label {
    padding: 20px var(--page-px) 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
  }
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
  .chevron { font-size: 20px; color: var(--text-3); margin-left: auto; transition: transform var(--dur-base) var(--ease-out); }
  .chevron.rotated { transform: rotate(180deg); }

  .section-body { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }

  .settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
  /* Layout guard for the common .setting-row pattern. The text-block
     (a <div> or a bare <span class="setting-label">) grows and is allowed
     to shrink (min-width:0) so long labels wrap/truncate instead of
     bleeding into icons or controls beside it. Icons (.material-symbols-
     rounded) and right-side controls stay pinned via flex-shrink:0. The
     text-block can be in any position (some rows have leading icon + text
     + chevron; others have just text + Toggle), so we target it by tag/
     class instead of :first-child. :global() so sub-components inherit. */
  :global(.setting-row > *) { flex-shrink: 0; }
  :global(.setting-row > div), :global(.setting-row > span.setting-label) {
    flex: 1 1 0; min-width: 0;
  }
  /* Reset for column-direction setting-rows. Children of a column-flex
     .setting-row should take their natural content height — the rule
     above gives them flex-basis:0 which collapses them down to the parent's
     min-height (50px) on the main axis (height) and lets their content
     overflow visibly. That overflow paints in the same space as the next
     sibling, visually overlapping it (nomad64 #33 — Cancel/Import row
     overlapping the dupe-option radios in Nutrition Import). Higher
     specificity than the rule above so it wins without !important. */
  :global(.setting-row[style*="flex-direction:column"] > div),
  :global(.setting-row[style*="flex-direction: column"] > div),
  :global(.setting-row[style*="flex-direction:column"] > span.setting-label),
  :global(.setting-row[style*="flex-direction: column"] > span.setting-label) {
    flex: 0 0 auto;
    min-width: auto;
  }
  :global(.setting-label), :global(.setting-desc) { word-break: break-word; overflow-wrap: anywhere; }
  /* Allow dragged items to visually escape the card boundary */
  .drag-list { overflow: visible; }

  .drag-row {
    position: relative;
    will-change: transform;
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 220ms ease, opacity 220ms ease;
  }
  .drag-row.drag-target {
    background: var(--accent-dim);
    border-radius: var(--radius-sm);
    transition: background 120ms ease;
  }
  .drag-row.dragging {
    opacity: 0.90;
    z-index: 20;
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    box-shadow:
      0 28px 72px rgba(0,0,0,0.50),
      0 8px 24px rgba(0,0,0,0.30),
      0 0 0 1px rgba(255,255,255,0.08);
    backdrop-filter: blur(4px);
  }
  .drag-handle {
    font-size: 20px;
    color: var(--text-3);
    cursor: grab;
    flex-shrink: 0;
    user-select: none;
    touch-action: none;
    transition: color var(--dur-fast);
  }
  .drag-handle:hover  { color: var(--accent); }
  .drag-handle:active { cursor: grabbing; color: var(--accent); }
  .setting-label { font-size: 14px; font-weight: 500; flex: 1; }
  .setting-desc  { font-size: 12px; color: var(--text-3); margin-top: 2px; font-weight: 400; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .sub-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 4px 2px 2px;
  }
  .sel-sm { height: 36px; font-size: 13px; }

  .cat-chips-wrap {
    display: flex; flex-wrap: wrap; gap: 8px;
    padding: 14px 16px 8px;
  }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 99px; font-size: 13px; font-weight: 500; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); }
  .chip-x { background: none; border: none; cursor: pointer; display: flex; align-items: center; color: var(--text-3); padding: 0; }
  .chip-x:hover { color: var(--danger); }
  .cat-add-row { display: flex; gap: 8px; padding: 8px 16px 14px; }
  .emoji-btn {
    width: 54px; height: 40px; font-size: 20px; padding: 0;
    text-align: center; cursor: pointer; line-height: 1;
  }

  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }

  .chip {
    padding: 4px 12px;
    border-radius: 99px;
    border: 1.5px solid var(--border);
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
  }
  .chip:hover { border-color: var(--accent); color: var(--text-1); }
  .chip-active {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 600;
  }
  .labs-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    color: #fff;
    padding: 2px 6px;
    border-radius: 99px;
    margin-left: 6px;
    vertical-align: middle;
  }
  .seg-control {
    position: relative;
    display: flex;
    background: var(--surface-2);
    border-radius: var(--radius-full);
    padding: 3px;
    gap: 2px;
  }
  /* Multi-select seg controls suppress the sliding pill — caller adds the
     `multi` class. Each .seg-active button shades its own background instead. */
  .seg-control.multi::before { display: none; }
  .seg-control.multi .seg-opt.seg-active {
    background: var(--surface-1);
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  }
  /* Sliding active pill — driven by --seg-active (index) + --seg-count (total). */
  .seg-control::before {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    height: calc(100% - 6px);
    width: calc((100% - 6px - 2px * (var(--seg-count, 3) - 1)) / var(--seg-count, 3));
    background: var(--surface-1);
    border-radius: var(--radius-full);
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    transform: translateX(calc(var(--seg-active, 0) * (100% + 2px)));
    transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
    pointer-events: none;
    z-index: 0;
  }
  .seg-opt {
    position: relative;
    z-index: 1;
    flex: 1;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-3);
    background: none;
    border: none;
    border-radius: var(--radius-full);
    cursor: pointer;
    white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
    transition: color var(--dur-fast);
  }
  .seg-opt.seg-active {
    color: var(--text-1);
  }
  .about-hero {
    display: flex; align-items: center; gap: 16px; padding: 16px;
  }
  .about-icon { width: 56px; height: 56px; border-radius: 12px; }
  .about-name { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .about-version { margin-top: 2px; display: flex; align-items: center; gap: 8px; }
  .platform-tag {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--accent); background: var(--accent-dim);
    padding: 2px 8px; border-radius: var(--radius-full, 999px);
  }
  .about-desc {
    font-size: 13px; color: var(--text-2); line-height: 1.5;
    padding: 12px 16px;
  }
  .about-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; font-size: 14px; color: var(--text-1);
  }
  .about-feat-icon { font-size: 20px; color: var(--accent); flex-shrink: 0; }
  .about-link { color: var(--accent); text-decoration: underline; }
  .about-link:hover { opacity: 0.8; }

  /* ── Env-lock badge ────────────────────────────────────────────────────── */
  .env-lock-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-2);
    margin-bottom: 4px;
  }
  .env-lock-banner .material-symbols-rounded { font-size: 16px; color: var(--accent); flex-shrink: 0; }

  /* ── Merge dialog ── */
  .merge-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .merge-dialog {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    padding: 20px; width: 100%; max-width: 360px;
  }
  .merge-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 12px);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s;
  }
  .merge-option:hover { border-color: var(--accent); }
  .merge-option-title { font-size: 14px; font-weight: 600; color: var(--text-1); margin-bottom: 2px; }
  .merge-option-desc { font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .merge-counts {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
  }
  .merge-counts-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .merge-counts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 4px 12px;
    font-size: 13px;
    color: var(--text-2);
  }
  .merge-counts-grid strong { color: var(--text-1); font-weight: 600; }
  .merge-progress-bar {
    height: 6px;
    background: var(--surface-2);
    border-radius: 3px;
    overflow: hidden;
  }
  .merge-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1s linear infinite; display: inline-block; }
</style>
