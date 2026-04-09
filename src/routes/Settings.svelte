<script>
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { slide, fade } from 'svelte/transition';
  import { portal } from '../lib/portal.js';
  import Toggle from '../components/settings/Toggle.svelte';
  import TimePicker from '../components/ui/TimePicker.svelte';
  import SettingsWellness from '../components/settings/SettingsWellness.svelte';
  import { APP_VERSION } from '../lib/version.js';
  import Sheet  from '../components/ui/Sheet.svelte';
  import SettingsBanner from '../components/banners/SettingsBanner.svelte';
  import Dialog from '../components/ui/Dialog.svelte';
  import { showSuccess, showError } from '../stores/toast.js';
  import { applyAppearance, applyAccentColor } from '../stores/settings.js';
  import { AI_PROVIDERS, AI_MODELS, AI_DEFAULT_MODELS } from '../lib/aiChat.js';
  import { catName as _catName, catDisplay as _catDisplay, scheduleSave } from '../stores/settings.js';
  import 'emoji-picker-element';
  import {
    appearance, accentColor, energyUnit, mealNames,
    diaryShowBrands, diaryShowTimestamps, diaryShowThumbnails, diaryShowAllNutrients,
    diaryShowNutritionUnits, diaryShowMacroSummary, diaryPromptQuantity, diaryShowPortionSize,
    diaryShowNutritionBar, diaryTotalsMode,
    foodsShowCategories, foodsShowLabels, foodsShowNotes, foodsShowThumbnails, foodsShowYesterdayMeals, foodsSort,
    barcodeBeep, barcodeFlashlight, cropPhotos,
    foodCategories, visibleNutriments, nutrimentsOrder, customNutriments,
    bodyStatsOrder, hiddenBodyStats,
    dateFormat, timeFormat,
    sidebarPersistent, goalCelebrations, pageBanners,
    aiEnabled, aiProvider, aiApiKey, aiModel, aiAssistantName, quickLogEnabled,
    waterGoalMl, waterUnit, waterContainers, waterShowInStats, waterShowInDiary,
  } from '../stores/settings.js';
  import { mealIcon } from '../lib/mealIcon.js';
  import { DB } from '../lib/db.js';
  import { NtApi } from '../lib/api.js';
  import { NUTRIMENTS, Nutrition } from '../lib/nutrition.js';
  import { currentUser, userMgmtActive, loadAuthState, logout } from '../stores/auth.js';
  import { isNative, getServerUrl, setServerUrl, setNativeMode, getNativeMode, setAuthToken, apiUrl, getAuthToken, resolveAssetUrl } from '../lib/platform.js';

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
  import { push } from 'svelte-spa-router';
  // ── Collapsible section state ──────────────────────────────────────────────
  $: isDark = $appearance === 'dark' || ($appearance === 'system' && (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches));
  let openSections = { serverConnection: false, appearance: false, regional: false, diary: false, foods: false, water: false,
                       categories: false, nutrients: false, bodyStats: false, statistics: false,
                       connectedServices: false, ai: false, notifications: false, wellness: false, sharing: false,
                       backup: false, email: false, users: false, about: false };

  // ── Server Connection (native only) ─────────────────────────────────────
  let serverUrlInput = getServerUrl() || '';
  let serverUsername = '';
  let serverPassword = '';
  let serverShowPw = false;
  let serverConnecting = false;
  let serverMode = getNativeMode(); // 'local' | 'server'
  // True when running as a standalone phone app (hide multi-user / server features)
  const isNativeLocal = isNative && !getServerUrl();

  // ── Server connect/merge flow ──────────────────────────────────────────────
  let mergeStep = null;  // null | 'ask-settings' | 'syncing'
  let mergeProgress = '';
  let _pendingServerUrl = '';
  let _pendingToken = null; // cookie is set by login, but we keep the URL

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

      // Check if there's local data to merge
      const { dbGetAllDiary, dbGetFoods, dbGetMeals } = await import('../lib/db-native.js');
      const [localFoods, localMeals, localDiary] = await Promise.all([
        dbGetFoods().catch(() => []),
        dbGetMeals().catch(() => []),
        dbGetAllDiary().catch(() => []),
      ]);
      const hasLocalData = localFoods.length > 0 || localMeals.length > 0 || localDiary.length > 0;

      if (hasLocalData) {
        // Show merge dialog
        mergeStep = 'ask-settings';
      } else {
        // No local data — just connect directly
        _finalizeConnect();
      }
    } catch (e) {
      showError(e.message || 'Could not connect');
    } finally {
      serverConnecting = false;
    }
  }

  async function _mergeAndConnect(mode) {
    mergeStep = 'syncing';
    const url = _pendingServerUrl;
    const token = getAuthToken();
    const _authH = { 'Content-Type': 'application/json' };
    if (token) _authH['Authorization'] = `Bearer ${token}`;

    try {
      const { DB: _DB } = await import('../lib/db.js');
      const { dbGetFoods, dbGetMeals, dbGetAllDiary } = await import('../lib/db-native.js');

      if (mode === 'upload' || mode === 'merge') {
        // Push local settings to server
        mergeProgress = 'Uploading settings…';
        const allSettings = DB.getAllSettings();
        for (const [key, value] of Object.entries(allSettings)) {
          await fetch(`${url}/api/settings`, { method: 'PUT', headers: _authH, body: JSON.stringify({ key, value }) }).catch(() => {});
        }

        // Push local foods
        const localFoods = await dbGetFoods().catch(() => []);
        if (localFoods.length) {
          mergeProgress = `Uploading ${localFoods.length} foods…`;
          for (const food of localFoods) {
            const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at, imgUrl, categories, ...rest } = food;
            await fetch(`${url}/api/foods`, { method: 'POST', headers: _authH, body: JSON.stringify({ ...rest, img_url: imgUrl || null, category: categories?.[0] || null }) }).catch(() => {});
          }
        }

        // Push local meals
        const localMeals = await dbGetMeals().catch(() => []);
        if (localMeals.length) {
          mergeProgress = `Uploading ${localMeals.length} meals…`;
          for (const meal of localMeals) {
            const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at, imgUrl, ...rest } = meal;
            await fetch(`${url}/api/meals`, { method: 'POST', headers: _authH, body: JSON.stringify({ ...rest, img_url: imgUrl || null }) }).catch(() => {});
          }
        }

        // Push local diary
        const localDiary = await dbGetAllDiary().catch(() => []);
        if (localDiary.length) {
          mergeProgress = `Uploading ${localDiary.length} diary entries…`;
          for (const entry of localDiary) {
            await fetch(`${url}/api/diary/${entry.date}`, { method: 'PUT', headers: _authH, body: JSON.stringify({ items: entry.items || [], body_stats: entry.body_stats || {}, water: entry.water || [] }) }).catch(() => {});
          }
        }
      }

      // mode === 'download' or 'merge': server data will be pulled automatically on reload via loadServerSettings + NtApiCached
      // mode === 'upload': server settings stay, local data pushed up

      mergeProgress = 'Finalizing…';
      _finalizeConnect();
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
  }

  function disconnectServer() {
    setServerUrl(null);
    setAuthToken(null);
    setNativeMode('local');
    serverMode = 'local';
    serverUrlInput = '';
    serverUsername = '';
    serverPassword = '';
    showSuccess('Disconnected — using local storage');
    setTimeout(() => window.location.reload(), 600);
  }

  function logoutServer() {
    document.body.style.transition = 'opacity 0.3s';
    document.body.style.opacity = '0';
    localStorage.removeItem('wl:userId');
    localStorage.removeItem('nt:cachedUser');
    localStorage.removeItem('nt:cachedUserMgmt');
    if (isNative) setAuthToken(null);
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
    appearance:        ['appearance','theme','dark','light','accent','color','navigation','sidebar','persistent','start page','animations','celebrations','reduce motion','banner','page banner'],
    regional:          ['regional','date format','time format','locale','date','time','12h','24h','units','energy unit','weight unit','height','circumference','distance','temperature','imperial','metric'],
    diary:             ['diary','brands','timestamps','thumbnails','nutrients','nutrition units','macros','macro summary','prompt quantity','portion size','nutrition bar','goals progress','meal names','meals'],
    foods:             ['foods','thumbnails','category','notes','yesterday meals','sort order','sort','barcode','scan','beep','flashlight','crop photos'],
    water:             ['water','display unit','daily goal','containers','bottle','cup','glass'],
    categories:        ['categories','food categories','tags','labels'],
    nutrients:         ['nutrients','nutriments','custom nutrients','vitamins','minerals'],
    bodyStats:         ['body stats','body','weight','measurements','stats'],
    statistics:        ['statistics','chart','y-axis','average','goal line','trend','stats'],
    connectedServices: ['connected services','usda','open food facts','mealie','recipe','search language','country','api key','credentials','username','password'],
    ai:                ['ai','fitbot','assistant','provider','model','api key','artificial intelligence','chat'],
    notifications:     ['notifications','reminders','water reminder','meal reminder','gotify','push','alerts','wellness alerts','goal celebration'],
    wellness:          ['wellness','activity tracking','fitbit','withings','garmin','steps','sleep','heart rate','hrv','spo2','sync mode','sync range','connect','disconnect','connected devices','fitness tracker','body battery','stress'],
    sharing:           ['sharing','share','group','catalogue','catalog','visibility','private','members','food sharing'],
    backup:            ['backup','export','import','restore','csv','clear data','json','full backup','images','zip'],
    email:             ['email','smtp','mail','password reset','invites','notifications'],
    users:             ['users','user management','accounts','login','password','admin','register','profile'],
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
    { value: 'system', label: 'System default' },
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
  let statsAvgLine   = DB.getSetting('statsAvgLine',   true);
  let statsGoalLine  = DB.getSetting('statsGoalLine',  true);
  let statsTrendLine = DB.getSetting('statsTrendLine', true);

  // ── Goals ──────────────────────────────────────────────────────────────────
  let goalsShowCalories = DB.getSetting('goalsShowCalories', true);
  let goalsShowWeight   = DB.getSetting('goalsShowWeight',   true);

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

  // ── Mealie ─────────────────────────────────────────────────────────────────
  let mealieEnabled    = DB.getSetting('mealieEnabled',   false);
  let mealieBaseUrl    = DB.getSetting('mealieBaseUrl',   '');
  let mealieApiToken   = DB.getSetting('mealieApiToken',  '');
  let mealieShowToken  = false;
  let mealieTestStatus = ''; // '', 'testing', 'ok', 'fail'
  async function testMealieConnection() {
    if (!mealieBaseUrl || !mealieApiToken) { mealieTestStatus = 'fail'; return; }
    mealieTestStatus = 'testing';
    try {
      const res = await fetch(apiUrl('/api/mealie/proxy'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: mealieBaseUrl,
          token:   mealieApiToken,
          path:    '/api/recipes?perPage=1&page=1',
        }),
      });
      mealieTestStatus = res.ok ? 'ok' : 'fail';
    } catch { mealieTestStatus = 'fail'; }
  }

  // ── FitBot AI ──────────────────────────────────────────────────────────────
  let aiEnabledVal       = DB.getSetting('aiEnabled',       false);
  let aiProviderVal      = DB.getSetting('aiProvider',      'claude');
  let aiApiKeyVal        = DB.getSetting('aiApiKey',        '');
  let aiModelVal         = DB.getSetting('aiModel',         '');
  let aiAssistantNameVal = DB.getSetting('aiAssistantName', 'FitBot');
  let quickLogEnabledVal = DB.getSetting('quickLogEnabled', false);
  let aiShowKey          = false;
  // Reset model to provider default when provider changes
  $: if (aiModelVal && !AI_MODELS[aiProviderVal]?.find(m => m.value === aiModelVal)) {
    aiModelVal = AI_DEFAULT_MODELS[aiProviderVal] || '';
  }

  // ── Notifications ──────────────────────────────────────────────────────────
  let _notifWater    = DB.getSetting('notifWaterReminders',  false);
  let _notifWaterInt = DB.getSetting('notifWaterInterval',   120);
  let _notifMeals    = DB.getSetting('notifMealReminders',   false);
  let _notifMealTimes = DB.getSetting('notifMealTimes', ['08:00','12:00','18:00']);
  function _defaultMealTime(i) { return ['08:00','12:00','18:00','15:00','10:00','20:00'][i] || '12:00'; }
  let _notifGoals    = DB.getSetting('notifGoalCelebrations', false);
  let _notifSteps    = DB.getSetting('notifStepGoal',        false);
  let _notifWeighIn  = DB.getSetting('notifWeighIn',         false);
  let _notifWeighInTime = DB.getSetting('notifWeighInTime',  '07:00');
  let _notifWeekly   = DB.getSetting('notifWeeklySummary',   false);
  let _notifWellness = DB.getSetting('notifWellnessAlerts',  false);
  let _notifWorkouts = DB.getSetting('notifWorkoutSummary',  false);
  let _notifSync     = DB.getSetting('notifSyncFailures',    false);
  let _notifLocal    = DB.getSetting('notifLocalEnabled',     true);
  let _notifPushService = DB.getSetting('notifPushService', 'none');
  let _gotifyUrl     = DB.getSetting('gotifyUrl',            '');
  let _gotifyToken   = DB.getSetting('gotifyToken',          '');
  let _appriseUrl    = DB.getSetting('appriseUrl',  '');
  let _appriseTag    = DB.getSetting('appriseTag',  '');
  let _ntfyUrl       = DB.getSetting('ntfyUrl',     'https://ntfy.sh');
  let _ntfyTopic     = DB.getSetting('ntfyTopic',   '');
  let _ntfyToken     = DB.getSetting('ntfyToken',   '');
  let _ntfyShowToken = false;
  let _gotifyTesting = false;
  let _gotifyShowToken = false;

  $: _anyNotifEnabled = _notifLocal || _notifPushService !== 'none';

  async function _requestNotifPermission() {
    try {
      const { requestPermission } = await import('../lib/notifications.js');
      await requestPermission();
    } catch {}
  }

  async function _scheduleWater() {
    if (_notifWater) {
      const { requestPermission, scheduleWaterReminders } = await import('../lib/notifications.js');
      await requestPermission();
      await scheduleWaterReminders(_notifWaterInt);
    } else {
      const { cancelWaterReminders } = await import('../lib/notifications.js');
      await cancelWaterReminders();
    }
  }

  async function _scheduleMeals() {
    if (_notifMeals) {
      const { requestPermission, scheduleMealReminders } = await import('../lib/notifications.js');
      await requestPermission();
      const names = DB.getSetting('mealNames', ['Breakfast','Lunch','Dinner','Snacks']);
      const times = DB.getSetting('notifMealTimes', ['08:00','12:00','18:00']);
      await scheduleMealReminders(times, names);
    } else {
      const { cancelMealReminders } = await import('../lib/notifications.js');
      await cancelMealReminders();
    }
  }

  async function _scheduleWeighIn() {
    if (_notifWeighIn) {
      const { requestPermission, scheduleWeighInReminder } = await import('../lib/notifications.js');
      await requestPermission();
      await scheduleWeighInReminder(_notifWeighInTime);
    } else {
      const { cancelWeighInReminder } = await import('../lib/notifications.js');
      await cancelWeighInReminder();
    }
  }

  async function _testPush() {
    _gotifyTesting = true;
    // Save all current values
    set('gotifyUrl', _gotifyUrl); set('gotifyToken', _gotifyToken);
    set('ntfyUrl', _ntfyUrl); set('ntfyTopic', _ntfyTopic); set('ntfyToken', _ntfyToken);
    set('appriseUrl', _appriseUrl); set('appriseTag', _appriseTag);
    try {
      const { sendPush } = await import('../lib/notifications.js');
      await sendPush(_notifPushService, 'NutriTrace', 'Test notification — push service connected!', 5);
      showSuccess('Test sent — check your device!');
    } catch (e) { showError(`Test failed: ${e.message || 'unknown error'}`); }
    _gotifyTesting = false;
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

  // ── Backup ─────────────────────────────────────────────────────────────────

  // Native: use Capacitor Filesystem for downloads (WebView <a download> doesn't work)
  async function _nativeDownload(blob, filename) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const reader = new FileReader();
    const base64 = await new Promise((res, rej) => {
      reader.onload = () => res(reader.result.split(',')[1]);
      reader.onerror = rej;
      reader.readAsDataURL(blob);
    });
    // Write to shared Download folder so users can find it in their file manager
    await Filesystem.writeFile({ path: `Download/${filename}`, data: base64, directory: Directory.ExternalStorage, recursive: true });
    showSuccess(`Saved to Download/${filename}`);
  }

  function _downloadBlob(blob, filename) {
    if (isNative) { _nativeDownload(blob, filename); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function exportBackup() {
    try {
      const [foodList, meals, recipes, diary] = await Promise.all([
        NtApi.getFoods(),
        NtApi.getMeals(),
        NtApi.getRecipes(),
        NtApi.getAllDiary(),
      ]);
      const data = { foodList, meals, recipes, diary, settings: DB.getAllSettings(), exportedAt: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      _downloadBlob(blob, `nutritrace-backup-${new Date().toISOString().slice(0,10)}.json`);
      showSuccess('Backup exported');
    } catch(e) { showError('Export failed: ' + e.message); }
  }

  // ── Local Full Backup (.zip with embedded images) ──────────────────────────
  // Native local-only mode: backups are written to Capacitor Filesystem
  // (Documents directory) so the user can list, share, restore, and delete
  // them. Mirrors the server full-backup UX exactly.
  let localZipBusy = false;
  let localZipStatus = '';
  let localBackups = []; // [{ filename, createdAt, size }]
  const LOCAL_BACKUP_DIR = 'nutritrace-backups';

  async function loadLocalBackups() {
    if (!isNativeLocal) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      // Ensure dir exists
      try {
        await Filesystem.mkdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents, recursive: true });
      } catch {}
      const list = await Filesystem.readdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents });
      // list.files is an array of FileInfo: { name, type, size, mtime, uri }
      localBackups = (list.files || [])
        .filter(f => f.name && f.name.endsWith('.zip'))
        .map(f => ({
          filename: f.name,
          size: f.size || 0,
          createdAt: f.mtime ? new Date(f.mtime).toISOString() : new Date().toISOString(),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (e) {
      console.warn('[backup] list failed:', e.message);
      localBackups = [];
    }
  }

  async function exportLocalZip() {
    if (localZipBusy || !isNativeLocal) return;
    localZipBusy = true;
    localZipStatus = 'Starting…';
    try {
      const { exportLocalBackup } = await import('../lib/local-backup.js');
      const blob = await exportLocalBackup({
        onProgress: (pct, label) => { localZipStatus = `${Math.round(pct)}% — ${label}`; },
      });
      // Convert blob → base64 → write to Filesystem
      const filename = `nutritrace-backup-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.zip`;
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      const b64 = btoa(binary);
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.mkdir({ path: LOCAL_BACKUP_DIR, directory: Directory.Documents, recursive: true }).catch(() => {});
      await Filesystem.writeFile({
        path: `${LOCAL_BACKUP_DIR}/${filename}`,
        data: b64,
        directory: Directory.Documents,
      });
      localZipStatus = '';
      showSuccess('Backup created');
      await loadLocalBackups();
    } catch (e) {
      console.error('[backup] export failed:', e);
      localZipStatus = '';
      showError('Backup failed: ' + e.message);
    } finally {
      localZipBusy = false;
    }
  }

  async function importLocalZip() {
    if (localZipBusy) return;
    // File picker for the user to select a .zip from anywhere
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip,application/x-zip-compressed';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await _runImport(file);
    };
    input.click();
  }

  async function restoreLocalBackup(filename) {
    if (localZipBusy) return;
    const yes = confirm(`Restore "${filename}"? Existing data is merged, not erased.`);
    if (!yes) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const result = await Filesystem.readFile({
        path: `${LOCAL_BACKUP_DIR}/${filename}`,
        directory: Directory.Documents,
      });
      // result.data is base64
      const b64 = typeof result.data === 'string' ? result.data : await _blobToB64(result.data);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await _runImport(new Blob([bytes], { type: 'application/zip' }));
    } catch (e) {
      console.error('[backup] restore failed:', e);
      showError('Restore failed: ' + e.message);
    }
  }

  async function _blobToB64(blob) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
      r.readAsDataURL(blob);
    });
  }

  async function _runImport(file) {
    localZipBusy = true;
    localZipStatus = 'Reading…';
    try {
      const { importLocalBackup } = await import('../lib/local-backup.js');
      const result = await importLocalBackup(file, {
        onProgress: (pct, label) => { localZipStatus = `${Math.round(pct)}% — ${label}`; },
      });
      const c = result.counts;
      showSuccess(`Restored ${c.foods} foods · ${c.meals} meals · ${c.recipes} recipes · ${c.diary} days · ${c.wellness} metrics`);
      localZipStatus = '';
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      console.error('[backup] import failed:', e);
      localZipStatus = '';
      showError('Restore failed: ' + e.message);
    } finally {
      localZipBusy = false;
    }
  }

  async function deleteLocalBackup(filename) {
    const yes = confirm(`Delete "${filename}"? This cannot be undone.`);
    if (!yes) return;
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.deleteFile({
        path: `${LOCAL_BACKUP_DIR}/${filename}`,
        directory: Directory.Documents,
      });
      showSuccess('Backup deleted');
      await loadLocalBackups();
    } catch (e) {
      console.error('[backup] delete failed:', e);
      showError('Delete failed: ' + e.message);
    }
  }

  async function shareLocalBackup(filename) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const uri = await Filesystem.getUri({
        path: `${LOCAL_BACKUP_DIR}/${filename}`,
        directory: Directory.Documents,
      });
      // Try the native Share plugin if available, otherwise fall back to copy-to-clipboard of path
      try {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title: 'NutriTrace Backup',
          text: filename,
          url: uri.uri,
          dialogTitle: 'Share backup',
        });
      } catch {
        showSuccess(`Saved at: ${uri.uri}`);
      }
    } catch (e) {
      console.error('[backup] share failed:', e);
      showError('Share failed: ' + e.message);
    }
  }

  async function importBackup() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        // Upload any base64 images
        async function migrateImg(item) {
          if (!item.imgUrl || !item.imgUrl.startsWith('data:')) return item;
          try {
            const blob = await fetch(item.imgUrl).then(r => r.blob());
            const file = new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' });
            const url = await NtApi.uploadImage(file);
            return { ...item, imgUrl: url };
          } catch { return { ...item, imgUrl: '' }; }
        }
        const migrateAll = arr => Promise.all((arr || []).map(migrateImg));
        const [foodList, meals, recipes] = await Promise.all([
          migrateAll(data.foodList),
          migrateAll(data.meals),
          migrateAll(data.recipes),
        ]);

        if (isNativeLocal) {
          // Native local: import directly into SQLite
          const { dbCreateFood, dbCreateMeal, dbSaveDiaryDate } = await import('../lib/db-native.js');
          for (const food of (foodList || [])) await dbCreateFood(food).catch(() => {});
          for (const meal of (meals || [])) await dbCreateMeal(meal).catch(() => {});
          for (const meal of (recipes || [])) await dbCreateMeal({ ...meal, is_recipe: 1 }).catch(() => {});
          for (const entry of (data.diary || [])) {
            if (entry.date) await dbSaveDiaryDate(entry.date, entry).catch(() => {});
          }
        } else {
          await NtApi.post('/api/data/import', { ...data, foodList, meals, recipes });
        }

        if (data.settings && typeof data.settings === 'object') {
          for (const [key, value] of Object.entries(data.settings)) DB.setSetting(key, value);
        }

        // Merge imported categories into the category list
        const importedCats = [...new Set((foodList || []).map(f => (f.categories && f.categories[0]) || f.category).filter(Boolean))];
        if (importedCats.length) {
          const existing = get(foodCategories) || [];
          const existingNames = new Set(existing.map(c => _catName(c)));
          const toAdd = importedCats.filter(n => !existingNames.has(n));
          if (toAdd.length) foodCategories.set([...existing, ...toAdd]);
        }

        showSuccess('Backup restored — reloading...');
        setTimeout(() => location.reload(), 1500);
      } catch(err) { showError('Import failed: ' + err.message); }
    };
    input.click();
  }

  async function exportCSV() {
    try {
      const diary = await NtApi.getAllDiary();
      let csv = 'Date,Meal,Food,Amount,Unit,Calories,Fat,Carbs,Protein\n';
      diary.forEach(day => {
        (day.items || []).forEach(item => {
          const n = Nutrition.calculate(item);
          csv += `${day.date},${item.meal||0},"${item.name||''}",${item.portion||100},${item.unit||'g'},${Math.round(n.calories||0)},${(n.fat||0).toFixed(1)},${(n.carbohydrates||0).toFixed(1)},${(n.proteins||0).toFixed(1)}\n`;
        });
      });
      const blob = new Blob([csv], { type: 'text/csv' });
      _downloadBlob(blob, `nutritrace-diary-${new Date().toISOString().slice(0,10)}.csv`);
      showSuccess('CSV exported');
    } catch(e) { showError('Export failed: ' + e.message); }
  }

  // ── Full Backup ────────────────────────────────────────────────────────────
  let fullBackups        = [];
  let fullBackupBusy     = false;
  let restoreTarget      = null;  // filename pending restore confirm
  let deleteTarget       = null;  // filename pending delete confirm
  let showRestoreDialog  = false;
  let showDeleteBkDialog = false;

  async function loadFullBackups() {
    if (isNativeLocal) return;
    try {
      const res = await fetch(apiUrl('/api/full-backup'), _fetchOpts());
      if (res.ok) fullBackups = await res.json();
    } catch {}
  }

  async function createFullBackup() {
    fullBackupBusy = true;
    try {
      const res  = await fetch(apiUrl('/api/full-backup'), { method: 'POST', ..._fetchOpts() });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Backup failed'); return; }
      showSuccess('Full backup created');
      await loadFullBackups();
    } catch { showError('Backup failed'); }
    finally   { fullBackupBusy = false; }
  }

  function downloadFullBackup(filename) {
    const a = document.createElement('a');
    a.href = apiUrl(`/api/full-backup/${encodeURIComponent(filename)}/download`);
    a.download = filename;
    a.click();
  }

  let restoreStatus = null; // null | { phase: 'uploading'|'restoring', percent: number, label: string }
  let restoreProgressEl = null;

  async function _scrollToProgress() {
    await tick();
    restoreProgressEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function confirmRestoreFullBackup() {
    if (!restoreTarget) return;
    showRestoreDialog = false;
    const filename = restoreTarget;
    restoreTarget = null;
    fullBackupBusy = true;
    restoreStatus = { phase: 'restoring', percent: 40, label: 'Restoring backup…' };
    _scrollToProgress();
    try {
      const res  = await fetch(apiUrl(`/api/full-backup/${encodeURIComponent(filename)}/restore`), { method: 'POST', ..._fetchOpts() });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Restore failed'); restoreStatus = null; return; }
      restoreStatus = { phase: 'restoring', percent: 100, label: 'Restore complete — reloading…' };
      setTimeout(() => location.reload(), 1500);
    } catch (err) { showError('Restore failed: ' + (err.message || 'Unknown error')); restoreStatus = null; }
    finally   { fullBackupBusy = false; }
  }

  async function confirmDeleteFullBackup() {
    if (!deleteTarget) return;
    showDeleteBkDialog = false;
    const filename = deleteTarget;
    deleteTarget = null;
    try {
      const res = await fetch(apiUrl(`/api/full-backup/${encodeURIComponent(filename)}`), { method: 'DELETE', ..._fetchOpts() });
      if (res.ok) { showSuccess('Backup deleted'); await loadFullBackups(); }
      else showError('Delete failed');
    } catch { showError('Delete failed'); }
  }

  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  let showUploadRestoreDialog = false;
  let uploadRestoreFile       = null;

  function pickUploadRestore() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.zip';
    input.onchange = e => {
      const file = e.target.files?.[0];
      if (!file) return;
      uploadRestoreFile = file;
      showUploadRestoreDialog = true;
    };
    input.click();
  }

  function confirmUploadRestore() {
    if (!uploadRestoreFile) return;
    showUploadRestoreDialog = false;
    fullBackupBusy = true;
    restoreStatus = { phase: 'uploading', percent: 0, label: 'Uploading backup…' };
    _scrollToProgress();

    const file = uploadRestoreFile;
    uploadRestoreFile = null;

    const form = new FormData();
    form.append('backup', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/full-backup/upload-restore'));
    xhr.withCredentials = true;

    // onprogress at top level — Svelte can track these assignments directly
    xhr.upload.onprogress = ev => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 85);
        restoreStatus = { phase: 'uploading', percent: pct, label: `Uploading… ${pct}%` };
      }
    };

    xhr.onload = () => {
      fullBackupBusy = false;
      if (xhr.status >= 200 && xhr.status < 300) {
        let err = null;
        try { const d = JSON.parse(xhr.responseText); if (d.error) err = d.error; } catch {}
        if (err) { showError('Restore failed: ' + err); restoreStatus = null; return; }
        restoreStatus = { phase: 'restoring', percent: 95, label: 'Restoring on server…' };
        setTimeout(() => {
          restoreStatus = { phase: 'restoring', percent: 100, label: 'Restore complete — reloading…' };
          setTimeout(() => location.reload(), 1000);
        }, 600);
      } else if (xhr.status === 413) {
        showError('Upload failed: file exceeds the maximum size allowed by your server or reverse proxy. If accessing remotely, try uploading from your local network.');
        restoreStatus = null;
      } else {
        let msg = `Server error ${xhr.status}`;
        try { const d = JSON.parse(xhr.responseText); if (d.error) msg = d.error; } catch {}
        showError('Restore failed: ' + msg);
        restoreStatus = null;
      }
    };

    xhr.onerror = () => {
      fullBackupBusy = false;
      restoreStatus = null;
      showError('Restore failed: network error');
    };

    xhr.send(form);
  }

  // Load backup list when section opens
  $: if (openSections.backup && $currentUser?.role === 'admin' && !isNativeLocal) loadFullBackups();
  $: if (openSections.backup && isNativeLocal) loadLocalBackups();

  // ── Sharing ────────────────────────────────────────────────────────────────
  let adminSharingEnabled = false;

  async function loadSharingConfig() {
    try {
      const cfg = await NtApi.getSharingStatus().catch(() => ({}));
      adminSharingEnabled = cfg.sharing_enabled === true;
    } catch {}
  }

  async function saveAdminSharingEnabled(val) {
    adminSharingEnabled = val;
    await fetch(apiUrl('/api/app-config'), {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sharing_enabled', value: val ? 'true' : 'false' }),
    }).catch(() => {});
  }

  let bulkVisibility = 'group';
  let bulkApplying = false;
  let bulkTargets = new Set(['foods', 'meals', 'recipes']);
  function toggleBulkTarget(t) {
    if (bulkTargets.has(t)) bulkTargets.delete(t); else bulkTargets.add(t);
    bulkTargets = bulkTargets;
  }
  let bulkUsers = [];
  let bulkSelectedIds = [];
  let bulkUsersLoaded = false;

  async function loadBulkUsers() {
    if (bulkUsersLoaded) return;
    try { bulkUsers = await NtApi.getUsersList(); bulkUsersLoaded = true; } catch {}
  }

  function toggleBulkUser(id) {
    bulkSelectedIds = bulkSelectedIds.includes(id)
      ? bulkSelectedIds.filter(u => u !== id)
      : [...bulkSelectedIds, id];
  }

  async function applyBulkShare() {
    bulkApplying = true;
    try {
      const user_ids = bulkVisibility === 'specific' ? bulkSelectedIds : [];
      await NtApi.post('/api/foods/bulk-share', { visibility: bulkVisibility, targets: [...bulkTargets], user_ids });
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
    } catch {}
  }

  async function saveSmtpField(key, value) {
    await fetch(apiUrl('/api/app-config'), {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: String(value) }),
    }).catch(() => {});
  }

  let smtpSaving = false;
  let smtpSaved  = false;
  async function saveSmtp() {
    smtpSaving = true;
    try {
      await saveSmtpField('smtp_host',   smtpHost);
      await saveSmtpField('smtp_port',   smtpPort);
      await saveSmtpField('smtp_secure', String(smtpSecure));
      await saveSmtpField('smtp_user',   smtpUser);
      await saveSmtpField('smtp_pass',   smtpPass);
      await saveSmtpField('smtp_from',   smtpFrom);
      smtpSaved = true;
      setTimeout(() => smtpSaved = false, 2000);
    } finally {
      smtpSaving = false;
    }
  }

  async function testSmtp() {
    smtpTestStatus = 'testing';
    try {
      const res = await fetch(apiUrl('/api/app-config/test-email'), { method: 'POST', ..._fetchOpts() });
      smtpTestStatus = res.ok ? 'ok' : 'fail';
    } catch { smtpTestStatus = 'fail'; }
  }

  // ── Session duration (admin-only) ─────────────────────────────────────────
  let sessionHours = '720';
  let sessionSaved = false;
  async function loadSessionConfig() {
    try {
      const res = await fetch(apiUrl('/api/app-config'), { credentials: 'include' });
      if (!res.ok) return;
      const cfg = await res.json();
      sessionHours = cfg.session_hours ?? '720';
    } catch {}
  }
  async function saveSessionHours() {
    await fetch(apiUrl('/api/app-config'), {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'session_hours', value: sessionHours }),
    }).catch(() => {});
    sessionSaved = true;
    setTimeout(() => sessionSaved = false, 2000);
  }

  $: if (openSections.email && $currentUser?.role === 'admin') loadSmtpConfig();

  // ── Invite ─────────────────────────────────────────────────────────────────
  let inviteEmail  = '';
  let inviteRole   = 'user';
  let inviteLoading = false;
  let inviteResult = null; // { inviteUrl, sent }

  async function createInvite() {
    inviteLoading = true;
    inviteResult  = null;
    try {
      const res  = await fetch(apiUrl('/api/auth/invite'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim() || undefined, role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Failed to create invite'); return; }
      inviteResult = data;
      inviteEmail  = '';
    } catch { showError('Could not create invite'); }
    inviteLoading = false;
  }

  // ── User Management ────────────────────────────────────────────────────────
  let umUsers        = [];
  let umLoading      = false;
  let showAddUser    = false;
  let newUsername    = '';
  let newPassword    = '';
  let newShowPass    = false;
  let newFullName    = '';
  let newRole        = 'user';
  let umError        = '';
  let showDisableUmDialog = false;

  // Enable user management from Settings
  let showEnableUm    = false;
  let enableAdminUser = '';
  let enableAdminPass = '';
  let enableShowPass = false;
  let enableAdminConf = '';
  let enableAdminName = '';
  let enableUmError   = '';
  let enableUmLoading = false;

  async function enableUserManagement() {
    enableUmError = '';
    if (!enableAdminUser.trim()) { enableUmError = 'Username is required'; return; }
    if (enableAdminPass.length < 6) { enableUmError = 'Password must be at least 6 characters'; return; }
    if (enableAdminPass !== enableAdminConf) { enableUmError = 'Passwords do not match'; return; }
    enableUmLoading = true;
    try {
      const res = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username:  enableAdminUser.trim(),
          password:  enableAdminPass,
          full_name: enableAdminName.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { enableUmError = data.error || 'Registration failed'; enableUmLoading = false; return; }
      localStorage.setItem('wl:userId', data.user.id);
      await loadAuthState();
      showEnableUm = false;
      enableAdminUser = ''; enableAdminPass = ''; enableAdminConf = ''; enableAdminName = '';
      await loadUsers();
      showSuccess('User management enabled');
    } catch(e) { enableUmError = 'Could not connect to server'; }
    enableUmLoading = false;
  }

  async function loadUsers() {
    try {
      umUsers = await NtApi.get('/api/auth/users');
    } catch(e) { umError = e.message; }
  }

  async function addUser() {
    umError = '';
    if (!newUsername.trim() || !newPassword.trim()) { umError = 'Username and password required'; return; }
    umLoading = true;
    try {
      const res = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, full_name: newFullName.trim() || undefined, role: newRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { umError = data.error || 'Failed to add user'; } else {
        newUsername = ''; newPassword = ''; newFullName = ''; newRole = 'user';
        showAddUser = false;
        await loadUsers();
        showSuccess('User added');
      }
    } catch(e) { umError = e.message; }
    umLoading = false;
  }

  async function deleteUser(id) {
    try {
      await NtApi.del(`/api/auth/users/${id}`);
      await loadUsers();
      showSuccess('User deleted');
    } catch(e) { showError(e.message); }
  }

  async function disableUserManagement() {
    try {
      await NtApi.del('/api/auth/management');
      localStorage.removeItem('wl:userId');
      await loadAuthState();
      showDisableUmDialog = false;
      showSuccess('User management disabled');
      await loadUsers();
    } catch(e) { showError(e.message); }
  }

  // Load users when section opens
  $: if (openSections.users && $userMgmtActive) { loadUsers(); if ($currentUser?.role === 'admin') loadSessionConfig(); }

  let showClearDialog = false;
  async function clearAllData() {
    try {
      await NtApi.del('/api/data');
      // Only deletes food/diary data — settings are untouched
      showSuccess('All data cleared');
      await loadAuthState();
    } catch(e) { showError('Clear failed: ' + e.message); }
  }

  let showClearSettingsDialog = false;
  async function clearAllSettings() {
    try {
      await fetch(apiUrl('/api/settings'), { method: 'DELETE', ..._fetchOpts() });
      // Clear user-scoped localStorage settings
      const userId = localStorage.getItem('wl:userId');
      const prefix = userId ? `wl_u${userId}_` : 'wl_';
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
      // Re-stamp setupComplete so the wizard doesn't re-trigger
      DB.setSetting('setupComplete', true);
      showSuccess('All settings cleared');
      // Reload to reinitialize all local settings vars with defaults
      setTimeout(() => location.reload(), 800);
    } catch(e) { showError('Clear failed: ' + e.message); }
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
  $: set('offSearchLanguage',  offSearchLanguage);
  $: set('offSearchCountry',   offSearchCountry);
  $: set('offUploadCountry',   offUploadCountry);
  $: { aiEnabled.set(aiEnabledVal); }
  $: { aiProvider.set(aiProviderVal); }
  $: set('aiModel',         aiModelVal);
  $: set('aiAssistantName', aiAssistantNameVal);
  $: { quickLogEnabled.set(quickLogEnabledVal); }

  // ── Explicit credential saves ──────────────────────────────────────────────
  let usdaSaved   = false;
  let offSaved    = false;
  let mealieSaved = false;
  let aiKeySaved  = false;

  function saveUsda()   { set('usdaApiKey', usdaApiKey);   usdaSaved = true;   setTimeout(() => usdaSaved   = false, 2000); }
  function saveOff()    { set('offUsername', offUsername); set('offPassword', offPassword); offSaved = true; setTimeout(() => offSaved = false, 2000); }
  function saveMealie() { set('mealieBaseUrl', mealieBaseUrl); set('mealieApiToken', mealieApiToken); mealieSaved = true; setTimeout(() => mealieSaved = false, 2000); }
  function saveAiKey()  { set('aiApiKey', aiApiKeyVal);    aiKeySaved = true;  setTimeout(() => aiKeySaved  = false, 2000); }

  // ── Env-lock state — which admin sections are locked by environment vars ───
  let envLocks = { smtp: false, ai: false };
  onMount(async () => {
    try {
      const res = await fetch(apiUrl('/api/app-config/env-locks'), _fetchOpts());
      if (res.ok) envLocks = await res.json();
    } catch {}
  });
</script>

<div class="page-shell">
  <header class="page-header" class:has-banner={$pageBanners}>
    {#if $pageBanners}<SettingsBanner />{/if}
    <h1>Settings</h1>
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

  <div class="page-content settings-content">

    <p class="settings-group-label">Display</p>
    <!-- ── Appearance ──────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'appearance')} on:click={() => toggleSection('appearance')}>
      <span class="material-symbols-rounded si">contrast</span>
      <span>Appearance</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.appearance}>expand_more</span>
    </button>

    {#if sectionOpen(openSections, settingsQuery, 'appearance') && sectionVisible(settingsQuery, 'appearance')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">Theme</span>
            <div class="select-wrap" style="width:150px">
              <select class="select sel-sm" value={$appearance} on:change={e => applyAppearance(e.target.value)}>
                {#each APPEARANCE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:10px">
            <span class="setting-label">Accent color</span>
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
            <span class="setting-label">Navigation style</span>
            <div class="select-wrap" style="width:150px">
              <select class="select sel-sm" bind:value={navStyle}>
                {#each NAV_STYLE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
          </div>
          {#if (navStyle === 'sidebar' || navStyle === 'both') && (typeof window === 'undefined' || window.innerWidth >= 768)}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Persistent sidebar</span>
                <div class="setting-desc">Sidebar stays open and shifts page content instead of overlaying it. Available on tablets, foldables, and desktop.</div>
              </div>
              <Toggle checked={sidebarPersistentVal} on:change={e => sidebarPersistentVal = e.detail} />
            </div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Start page</span>
            <div class="select-wrap" style="width:150px">
              <select class="select sel-sm" bind:value={startPage}>
                {#each START_PAGE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Reduce motion</span>
            <Toggle checked={disableAnimations} on:change={e => { disableAnimations = e.detail; set('disableAnimations', e.detail); }} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Celebrate goals</span>
              <div class="setting-desc">Pulse effect when you reach goals</div>
            </div>
            <Toggle checked={$goalCelebrations} on:change={e => goalCelebrations.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Page banners</span>
              <div class="setting-desc">Animated page header illustrations</div>
            </div>
            <Toggle checked={$pageBanners} on:change={e => pageBanners.set(e.detail)} />
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Regional & Units ─────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'regional')} on:click={() => toggleSection('regional')}>
      <span class="material-symbols-rounded si">language</span>
      <span>Regional &amp; Units</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.regional}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'regional') && sectionVisible(settingsQuery, 'regional')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">Date format</span>
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
            <span class="setting-label">Time format</span>
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
      <span>Diary</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.diary}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'diary') && sectionVisible(settingsQuery, 'diary')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row"><span class="setting-label">Show brand names</span><Toggle checked={$diaryShowBrands} on:change={e => diaryShowBrands.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show timestamps</span><Toggle checked={$diaryShowTimestamps} on:change={e => diaryShowTimestamps.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show thumbnails</span><Toggle checked={$diaryShowThumbnails} on:change={e => diaryShowThumbnails.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show all nutrients</span><Toggle checked={$diaryShowAllNutrients} on:change={e => diaryShowAllNutrients.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show nutrition units</span><Toggle checked={$diaryShowNutritionUnits} on:change={e => diaryShowNutritionUnits.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show macro summary per meal</span><Toggle checked={$diaryShowMacroSummary} on:change={e => diaryShowMacroSummary.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Ask for quantity when adding</span><Toggle checked={$diaryPromptQuantity} on:change={e => diaryPromptQuantity.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show portion size</span><Toggle checked={$diaryShowPortionSize} on:change={e => diaryShowPortionSize.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show daily goals progress bar</span><Toggle checked={$diaryShowNutritionBar} on:change={e => diaryShowNutritionBar.set(e.detail)} /></div>
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
      <span>Water</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.water}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'water') && sectionVisible(settingsQuery, 'water')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <!-- Goal + unit -->
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">Display unit</span>
            <select class="select sel-sm" value={$waterUnit} on:change={e => waterUnit.set(e.target.value)}>
              <option value="ml">Milliliters (ml)</option>
              <option value="oz">Fluid ounces (fl oz)</option>
              <option value="L">Liters (L)</option>
              <option value="G">Gallons (G)</option>
            </select>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Show in Diary</span>
            <Toggle checked={$waterShowInDiary} on:change={e => waterShowInDiary.set(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Show in Statistics</span>
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
      <span>Foods</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.foods}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'foods') && sectionVisible(settingsQuery, 'foods')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row"><span class="setting-label">Show thumbnails</span><Toggle checked={$foodsShowThumbnails} on:change={e => foodsShowThumbnails.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show categories</span><Toggle checked={$foodsShowCategories} on:change={e => foodsShowCategories.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show category labels</span><Toggle checked={$foodsShowLabels} on:change={e => foodsShowLabels.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show notes</span><Toggle checked={$foodsShowNotes} on:change={e => foodsShowNotes.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show yesterday's meals</span><Toggle checked={$foodsShowYesterdayMeals} on:change={e => foodsShowYesterdayMeals.set(e.detail)} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Sort order</span>
            <div class="select-wrap" style="width:140px">
              <select class="select sel-sm" value={$foodsSort} on:change={e => foodsSort.set(e.target.value)}>
                <option value="date">Recently added</option>
                <option value="alpha">Alphabetical</option>
              </select>
            </div>
          </div>
        </div>
        <p class="sub-label">Camera &amp; Scanning</p>
        <div class="card settings-card">
          <div class="setting-row"><span class="setting-label">Beep on successful scan</span><Toggle checked={$barcodeBeep} on:change={e => barcodeBeep.set(e.detail)} /></div>
          {#if !isNative}
            <div class="setting-divider"></div>
            <div class="setting-row"><span class="setting-label">Use flashlight while scanning</span><Toggle checked={$barcodeFlashlight} on:change={e => barcodeFlashlight.set(e.detail)} /></div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Crop photos on upload</span><Toggle checked={$cropPhotos} on:change={e => cropPhotos.set(e.detail)} /></div>
        </div>
      </div>
    {/if}

    <p class="settings-group-label">Data &amp; Tracking</p>
    <!-- ── Categories ─────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'categories')} on:click={() => toggleSection('categories')}>
      <span class="material-symbols-rounded si">tag</span>
      <span>Categories</span>
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

    <!-- ── Nutrients ───────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'nutrients')} on:click={() => toggleSection('nutrients')}>
      <span class="material-symbols-rounded si">science</span>
      <span>Nutrients</span>
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

    <!-- ── Body Stats ──────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'bodyStats')} on:click={() => toggleSection('bodyStats')}>
      <span class="material-symbols-rounded si">monitor_weight</span>
      <span>Body Stats</span>
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
      <span>Statistics</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.statistics}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'statistics') && sectionVisible(settingsQuery, 'statistics')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">Default chart type</span>
            <div class="select-wrap" style="width:110px">
              <select class="select sel-sm" bind:value={statsChartType}>
                <option value="bar">Bar</option>
                <option value="line">Line</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Lock Y-axis to zero</span><Toggle checked={statsYZero} on:change={e => { statsYZero = e.detail; set('statsYZero', e.detail); }} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show average line</span><Toggle checked={statsAvgLine} on:change={e => { statsAvgLine = e.detail; set('statsAvgLine', e.detail); }} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show goal line</span><Toggle checked={statsGoalLine} on:change={e => { statsGoalLine = e.detail; set('statsGoalLine', e.detail); }} /></div>
          <div class="setting-divider"></div>
          <div class="setting-row"><span class="setting-label">Show trend line</span><Toggle checked={statsTrendLine} on:change={e => { statsTrendLine = e.detail; set('statsTrendLine', e.detail); }} /></div>
        </div>
      </div>
    {/if}


    <p class="settings-group-label">Connected Services</p>
    <!-- ── Connected Services ─────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'connectedServices')} on:click={() => toggleSection('connectedServices')}>
      <span class="material-symbols-rounded si">hub</span>
      <span>Connected Services</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.connectedServices}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'connectedServices') && sectionVisible(settingsQuery, 'connectedServices')}
      <div class="section-body" transition:slide={{ duration: 180 }}>

        <p class="sub-label">USDA FoodData Central</p>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Enable USDA FoodData</span>
              <div class="setting-desc">Search the USDA nutrition database when adding foods</div>
            </div>
            <Toggle checked={usdaEnabled} on:change={e => { usdaEnabled = e.detail; set('usdaEnabled', e.detail); }} />
          </div>
          {#if usdaEnabled}
            <div class="setting-divider"></div>
            <div class="form-group" style="padding:10px 16px 14px">
              <label class="form-label" for="usda-key">API Key</label>
              <div style="display:flex;gap:8px;align-items:center">
                <input id="usda-key" class="input" style="flex:1" placeholder="Get a free key at api.nal.usda.gov" bind:value={usdaApiKey} />
                <button class="btn btn-primary" style="height:40px;font-size:13px;white-space:nowrap" on:click={saveUsda}>
                  {#if usdaSaved}<span class="material-symbols-rounded" style="font-size:16px">check</span>{:else}Save{/if}
                </button>
              </div>
            </div>
          {/if}
        </div>

        <p class="sub-label">Open Food Facts</p>
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">Search language</span>
            <div class="select-wrap" style="width:120px">
              <select class="select sel-sm" bind:value={offSearchLanguage}>
                {#each OFF_LANGUAGE_OPTS as [v,l]}<option value={v}>{l}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Search country</span>
            <div class="select-wrap" style="width:150px">
              <select class="select sel-sm" bind:value={offSearchCountry}>
                {#each OFF_COUNTRY_OPTS as c}<option value={c}>{c}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Upload country</span>
            <div class="select-wrap" style="width:150px">
              <select class="select sel-sm" bind:value={offUploadCountry}>
                <option value="Auto">Auto</option>
                {#each OFF_COUNTRY_OPTS.filter(c => c !== 'World') as c}<option value={c}>{c}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="form-group" style="padding:10px 16px 14px">
            <label class="form-label" for="off-user">Account username</label>
            <input id="off-user" class="input" style="margin-bottom:8px" placeholder="Optional — required to contribute edits" bind:value={offUsername} />
            <label class="form-label" for="off-pass">Account password</label>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
              {#if offShowPass}
                <input id="off-pass" class="input" type="text" style="flex:1" placeholder="OFF account password" bind:value={offPassword} />
              {:else}
                <input id="off-pass" class="input" type="password" style="flex:1" placeholder="OFF account password" bind:value={offPassword} />
              {/if}
              <button class="btn-icon" on:click={() => offShowPass = !offShowPass} title={offShowPass ? 'Hide' : 'Show'}>
                <span class="material-symbols-rounded">{offShowPass ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
            <button class="btn btn-primary" style="height:36px;font-size:13px;align-self:flex-start" on:click={saveOff}>
              {#if offSaved}<span class="material-symbols-rounded" style="font-size:16px">check</span> Saved{:else}Save{/if}
            </button>
          </div>
        </div>

        <p class="sub-label">Mealie</p>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Enable Mealie</span>
              <div class="setting-desc">Import recipes from your self-hosted Mealie instance</div>
            </div>
            <Toggle checked={mealieEnabled} on:change={e => { mealieEnabled = e.detail; set('mealieEnabled', e.detail); }} />
          </div>
          {#if mealieEnabled}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Base URL</span>
              <input class="input" style="width:200px;text-align:right"
                placeholder="https://mealie.example.com"
                bind:value={mealieBaseUrl} />
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">API Token</span>
              <div style="display:flex;align-items:center;gap:6px">
                {#if mealieShowToken}
                  <input class="input" style="width:160px;text-align:right"
                    type="text" placeholder="Bearer token"
                    bind:value={mealieApiToken} />
                {:else}
                  <input class="input" style="width:160px;text-align:right"
                    type="password" placeholder="Bearer token"
                    bind:value={mealieApiToken} />
                {/if}
                <button class="btn-icon" on:click={() => mealieShowToken = !mealieShowToken}
                  title={mealieShowToken ? 'Hide' : 'Show'}>
                  <span class="material-symbols-rounded" style="font-size:18px">{mealieShowToken ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Connection</span>
              <div style="display:flex;align-items:center;gap:8px">
                {#if mealieTestStatus === 'ok'}
                  <span style="color:var(--macro-carbs);font-size:13px;display:flex;align-items:center;gap:4px">
                    <span class="material-symbols-rounded" style="font-size:16px">check_circle</span>Connected
                  </span>
                {:else if mealieTestStatus === 'fail'}
                  <span style="color:#FF7070;font-size:13px;display:flex;align-items:center;gap:4px">
                    <span class="material-symbols-rounded" style="font-size:16px">error</span>Failed
                  </span>
                {:else if mealieTestStatus === 'testing'}
                  <span style="color:var(--text-2);font-size:13px">Testing…</span>
                {/if}
                <button class="btn btn-primary" style="padding:6px 14px;font-size:13px;height:32px"
                  on:click={saveMealie}>
                  {#if mealieSaved}<span class="material-symbols-rounded" style="font-size:16px">check</span>{:else}Save{/if}
                </button>
                <button class="btn btn-secondary" style="padding:6px 14px;font-size:13px;height:32px"
                  on:click={testMealieConnection}
                  disabled={!mealieBaseUrl || !mealieApiToken || mealieTestStatus === 'testing'}>
                  Test
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
      <span>AI Assistant</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.ai}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'ai') && sectionVisible(settingsQuery, 'ai')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        {#if envLocks.ai}
          <div class="env-lock-banner">
            <span class="material-symbols-rounded">lock</span>
            Configured via environment variables — changes are disabled.
          </div>
        {/if}
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Enable FitBot AI</span>
              <div class="setting-desc">Adds a floating chat button to all pages</div>
            </div>
            <Toggle checked={aiEnabledVal} on:change={e => aiEnabledVal = e.detail} disabled={envLocks.ai} />
          </div>

          {#if aiEnabledVal}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Assistant name</span>
              <input class="input" style="width:130px;text-align:right"
                placeholder="FitBot"
                bind:value={aiAssistantNameVal} />
            </div>

            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Provider</span>
              <div class="select-wrap" style="width:170px">
                <select class="select sel-sm" bind:value={aiProviderVal} disabled={envLocks.ai}>
                  {#each AI_PROVIDERS as p}
                    <option value={p.value}>{p.label}</option>
                  {/each}
                </select>
              </div>
            </div>

            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Model</span>
              <div class="select-wrap" style="width:200px">
                <select class="select sel-sm" bind:value={aiModelVal} disabled={envLocks.ai}>
                  {#each (AI_MODELS[aiProviderVal] || []) as m}
                    <option value={m.value}>{m.label}</option>
                  {/each}
                </select>
              </div>
            </div>

            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">
                  Smart Log
                  <span class="labs-badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);vertical-align:middle">Experimental</span>
                </span>
                <div class="setting-desc">Press and hold the FitBot button on any page, then say what you ate — "for breakfast I had 2 eggs and toast". When you release, the AI parses the items AND figures out which meal slot, your food database fills in the nutrition, and a confirmation modal lets you review before saving.</div>
              </div>
              <Toggle checked={quickLogEnabledVal} on:change={e => quickLogEnabledVal = e.detail} />
            </div>
            {#if quickLogEnabledVal}
              <div class="setting-divider"></div>
              <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
                <div class="setting-desc" style="line-height:1.55">
                  <strong style="color:var(--text-2)">Quick start</strong>
                  <div style="margin-top:4px">
                    Press and hold the FitBot button on any page, speak what you ate ("<em>for breakfast I had 2 eggs and toast</em>"), release. The AI parses your sentence and matches it against your foods, meals, recipes, and yesterday's diary.
                  </div>
                  <div style="margin-top:8px">
                    <strong style="color:var(--text-2)">Trigger words</strong> for non-food matches:
                    <div style="margin-top:4px">
                      • <em>"my X <strong>meal</strong>"</em> → searches your saved meals<br/>
                      • <em>"my X <strong>recipe</strong>"</em> → searches your saved recipes<br/>
                      • <em>"<strong>same as yesterday</strong> for lunch"</em> → copies yesterday's items
                    </div>
                  </div>
                  <div style="margin-top:8px">
                    See the <a href="https://github.com/traceapps/nutritrace#smart-log--voice--ai-food-logging" target="_blank" rel="noopener" class="about-link">Smart Log section in the README</a> for the full list of trigger words, examples, what it can/can't match, and the privacy story.
                  </div>
                </div>
              </div>
            {/if}

            {#if !envLocks.ai}
              <div class="setting-divider"></div>
              <div class="form-group" style="padding:10px 16px">
                <label class="form-label" for="ai-api-key">API Key</label>
                <div style="display:flex;gap:8px;align-items:center">
                  {#if aiShowKey}
                    <input id="ai-api-key" class="input" type="text"
                      placeholder="Paste your API key here"
                      bind:value={aiApiKeyVal} autocomplete="off" style="flex:1" />
                  {:else}
                    <input id="ai-api-key" class="input" type="password"
                      placeholder="Paste your API key here"
                      bind:value={aiApiKeyVal} autocomplete="off" style="flex:1" />
                  {/if}
                  <button class="btn-icon" on:click={() => aiShowKey = !aiShowKey} title={aiShowKey ? 'Hide' : 'Show'}>
                    <span class="material-symbols-rounded">{aiShowKey ? 'visibility_off' : 'visibility'}</span>
                  </button>
                  <button class="btn btn-primary" style="height:40px;font-size:13px;white-space:nowrap" on:click={saveAiKey}>
                    {#if aiKeySaved}<span class="material-symbols-rounded" style="font-size:16px">check</span>{:else}Save{/if}
                  </button>
                </div>
                <div class="setting-desc" style="margin-top:6px">
                  {#if aiProviderVal === 'claude'}
                    Get your key at <a href="https://console.anthropic.com" target="_blank" rel="noopener" class="about-link">console.anthropic.com</a>
                  {:else if aiProviderVal === 'openai'}
                    Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="about-link">platform.openai.com</a>
                  {:else if aiProviderVal === 'gemini'}
                    Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="about-link">aistudio.google.com</a>
                  {/if}
                  Your key is stored securely on the server.
                </div>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    <!-- ── Notifications ────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'notifications')} on:click={() => toggleSection('notifications')}>
      <span class="material-symbols-rounded si">notifications</span>
      <span>Notifications <span class="labs-badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);vertical-align:middle">Experimental</span></span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.notifications}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'notifications') && sectionVisible(settingsQuery, 'notifications')}
      <div class="section-body" transition:slide={{ duration: 180 }}>

        <!-- Delivery setup first -->
        <p class="sub-label">Delivery</p>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Device Notifications</span>
              <div class="setting-desc">Native push on Android, browser notifications on desktop</div>
            </div>
            <Toggle checked={_notifLocal} on:change={e => { _notifLocal = e.detail; set('notifLocalEnabled', e.detail); if (e.detail) _requestNotifPermission(); }} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Push Service</span>
              <div class="setting-desc">Self-hosted notification server</div>
            </div>
            <div class="select-wrap" style="width:130px">
              <select class="select sel-sm" value={_notifPushService} on:change={e => { _notifPushService = e.target.value; set('notifPushService', e.target.value); }}>
                <option value="none">None</option>
                <option value="apprise">Apprise</option>
                <option value="gotify">Gotify</option>
                <option value="ntfy">ntfy</option>
              </select>
            </div>
          </div>

          <!-- Apprise config -->
          {#if _notifPushService === 'apprise'}
            <div class="setting-divider"></div>
            <div class="form-group" style="padding:10px 16px 4px">
              <label class="form-label">Apprise Server URL</label>
              <input class="input" placeholder="https://apprise.example.com" bind:value={_appriseUrl} on:blur={() => set('appriseUrl', _appriseUrl)} />
            </div>
            <div class="form-group" style="padding:8px 16px 14px">
              <label class="form-label">Tag (optional)</label>
              <div style="display:flex;gap:8px;align-items:center">
                <input class="input" style="flex:1" placeholder="e.g. nutritrace" bind:value={_appriseTag} on:blur={() => set('appriseTag', _appriseTag)} />
                <button class="btn btn-primary" style="height:40px;font-size:13px;white-space:nowrap" on:click={_testPush} disabled={!_appriseUrl || _gotifyTesting}>
                  {#if _gotifyTesting}Testing…{:else}Test{/if}
                </button>
              </div>
            </div>
          {/if}

          <!-- Gotify config -->
          {#if _notifPushService === 'gotify'}
            <div class="setting-divider"></div>
            <div class="form-group" style="padding:10px 16px 4px">
              <label class="form-label">Gotify Server URL</label>
              <input class="input" placeholder="https://gotify.example.com" bind:value={_gotifyUrl} on:blur={() => set('gotifyUrl', _gotifyUrl)} />
            </div>
            <div class="form-group" style="padding:8px 16px 14px">
              <label class="form-label">App Token</label>
              <div style="display:flex;gap:8px;align-items:center">
                {#if _gotifyShowToken}
                  <input class="input" style="flex:1" type="text" placeholder="Your Gotify app token" bind:value={_gotifyToken} on:blur={() => set('gotifyToken', _gotifyToken)} />
                {:else}
                  <input class="input" style="flex:1" type="password" placeholder="Your Gotify app token" bind:value={_gotifyToken} on:blur={() => set('gotifyToken', _gotifyToken)} />
                {/if}
                <button class="btn-icon" on:click={() => _gotifyShowToken = !_gotifyShowToken} title={_gotifyShowToken ? 'Hide' : 'Show'}>
                  <span class="material-symbols-rounded">{_gotifyShowToken ? 'visibility_off' : 'visibility'}</span>
                </button>
                <button class="btn btn-primary" style="height:40px;font-size:13px;white-space:nowrap" on:click={_testPush} disabled={!_gotifyUrl || !_gotifyToken || _gotifyTesting}>
                  {#if _gotifyTesting}Testing…{:else}Test{/if}
                </button>
              </div>
            </div>
          {/if}

          <!-- ntfy config -->
          {#if _notifPushService === 'ntfy'}
            <div class="setting-divider"></div>
            <div class="form-group" style="padding:10px 16px 4px">
              <label class="form-label">ntfy Server URL</label>
              <input class="input" placeholder="https://ntfy.sh" bind:value={_ntfyUrl} on:blur={() => set('ntfyUrl', _ntfyUrl)} />
            </div>
            <div class="form-group" style="padding:8px 16px 4px">
              <label class="form-label">Topic</label>
              <input class="input" placeholder="e.g. my-nutritrace" bind:value={_ntfyTopic} on:blur={() => set('ntfyTopic', _ntfyTopic)} />
            </div>
            <div class="form-group" style="padding:8px 16px 14px">
              <label class="form-label">Access Token (optional — for private topics)</label>
              <div style="display:flex;gap:8px;align-items:center">
                {#if _ntfyShowToken}
                  <input class="input" style="flex:1" type="text" placeholder="Bearer token" bind:value={_ntfyToken} on:blur={() => set('ntfyToken', _ntfyToken)} />
                {:else}
                  <input class="input" style="flex:1" type="password" placeholder="Bearer token" bind:value={_ntfyToken} on:blur={() => set('ntfyToken', _ntfyToken)} />
                {/if}
                <button class="btn-icon" on:click={() => _ntfyShowToken = !_ntfyShowToken} title={_ntfyShowToken ? 'Hide' : 'Show'}>
                  <span class="material-symbols-rounded">{_ntfyShowToken ? 'visibility_off' : 'visibility'}</span>
                </button>
                <button class="btn btn-primary" style="height:40px;font-size:13px;white-space:nowrap" on:click={_testPush} disabled={!_ntfyTopic || _gotifyTesting}>
                  {#if _gotifyTesting}Testing…{:else}Test{/if}
                </button>
              </div>
            </div>
          {/if}
        </div>

        {#if _anyNotifEnabled}
          <!-- Notification types — all go through whichever delivery methods are enabled -->
          <p class="sub-label">Scheduled Reminders</p>
          <div class="card settings-card">
            <div class="setting-row">
              <div>
                <span class="setting-label">Water Reminders</span>
                <div class="setting-desc">Periodic reminders to stay hydrated (8am–10pm)</div>
              </div>
              <Toggle checked={_notifWater} on:change={e => { _notifWater = e.detail; set('notifWaterReminders', e.detail); _scheduleWater(); }} />
            </div>
            {#if _notifWater}
              <div class="setting-divider"></div>
              <div class="setting-row">
                <span class="setting-label">Interval</span>
                <div class="select-wrap" style="width:130px">
                  <select class="select sel-sm" value={_notifWaterInt} on:change={e => { _notifWaterInt = Number(e.target.value); set('notifWaterInterval', _notifWaterInt); _scheduleWater(); }}>
                    <option value={60}>Every 1 hour</option>
                    <option value={90}>Every 1.5 hours</option>
                    <option value={120}>Every 2 hours</option>
                    <option value={180}>Every 3 hours</option>
                  </select>
                </div>
              </div>
            {/if}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Meal Log Reminders</span>
                <div class="setting-desc">Daily reminders to log your meals</div>
              </div>
              <Toggle checked={_notifMeals} on:change={e => { _notifMeals = e.detail; set('notifMealReminders', e.detail); _scheduleMeals(); }} />
            </div>
            {#if _notifMeals}
              {@const mealNames = DB.getSetting('mealNames', ['Breakfast','Lunch','Dinner','Snacks'])}
              {#each mealNames as name, i}
                <div class="setting-divider"></div>
                <div class="setting-row">
                  <span class="setting-label">{name}</span>
                  <TimePicker value={_notifMealTimes[i] || _defaultMealTime(i)} on:change={e => {
                    while (_notifMealTimes.length <= i) _notifMealTimes.push(_defaultMealTime(_notifMealTimes.length));
                    _notifMealTimes[i] = e.detail;
                    _notifMealTimes = _notifMealTimes;
                    set('notifMealTimes', _notifMealTimes);
                    _scheduleMeals();
                  }} />
                </div>
              {/each}
            {/if}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Weigh-in Reminder</span>
                <div class="setting-desc">Morning reminder to step on the scale</div>
              </div>
              <Toggle checked={_notifWeighIn} on:change={e => { _notifWeighIn = e.detail; set('notifWeighIn', e.detail); _scheduleWeighIn(); }} />
            </div>
            {#if _notifWeighIn}
              <div class="setting-divider"></div>
              <div class="setting-row">
                <span class="setting-label">Time</span>
                <TimePicker value={_notifWeighInTime} on:change={e => { _notifWeighInTime = e.detail; set('notifWeighInTime', e.detail); _scheduleWeighIn(); }} />
              </div>
            {/if}
          </div>

          <p class="sub-label">Alerts & Summaries</p>
          <div class="card settings-card">
            <div class="setting-row">
              <div>
                <span class="setting-label">Goal Celebrations</span>
                <div class="setting-desc">Celebrates when you hit any daily goal — calories, protein, carbs, fat, water, steps, sleep, and more</div>
              </div>
              <Toggle checked={_notifGoals} on:change={e => { _notifGoals = e.detail; set('notifGoalCelebrations', e.detail); }} />
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Step Goal Progress</span>
                <div class="setting-desc">Midday nudge if you're behind on your step goal</div>
              </div>
              <Toggle checked={_notifSteps} on:change={e => { _notifSteps = e.detail; set('notifStepGoal', e.detail); }} />
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Wellness Alerts</span>
                <div class="setting-desc">Warns when HRV drops significantly, sleep quality declines, or resting heart rate spikes</div>
              </div>
              <Toggle checked={_notifWellness} on:change={e => { _notifWellness = e.detail; set('notifWellnessAlerts', e.detail); }} />
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Workout Summaries</span>
                <div class="setting-desc">Recap after a workout syncs — duration, distance, calories burned</div>
              </div>
              <Toggle checked={_notifWorkouts} on:change={e => { _notifWorkouts = e.detail; set('notifWorkoutSummary', e.detail); }} />
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Weekly Summary</span>
                <div class="setting-desc">Sunday recap with average steps, calories, and sleep for the week</div>
              </div>
              <Toggle checked={_notifWeekly} on:change={e => { _notifWeekly = e.detail; set('notifWeeklySummary', e.detail); }} />
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Sync Failures</span>
                <div class="setting-desc">Alert when Fitbit, Garmin, or Withings sync fails</div>
              </div>
              <Toggle checked={_notifSync} on:change={e => { _notifSync = e.detail; set('notifSyncFailures', e.detail); }} />
            </div>
          </div>
        {/if}

      </div>
    {/if}

    <!-- ── Wellness ──────────────────────────────────────────────────────────── -->
    <button class="section-toggle wellness-toggle" class:hidden={!sectionVisible(settingsQuery, 'wellness')} on:click={() => { toggleSection('wellness'); wellnessRef?.loadWellnessConfig(); }}>
      <span class="material-symbols-rounded si">monitor_heart</span>
      <span>Wellness</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.wellness}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'wellness') && sectionVisible(settingsQuery, 'wellness')}
      <SettingsWellness bind:this={wellnessRef} />
    {/if}

    <p class="settings-group-label">App</p>
    <!-- ── Sharing (hidden in native local mode — no one to share with) ──── -->
    {#if $userMgmtActive && !isNativeLocal}
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'sharing')} on:click={() => toggleSection('sharing')}>
        <span class="material-symbols-rounded si">group</span>
        <span>Food Sharing <span class="labs-badge" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">Experimental</span></span>
        <span class="material-symbols-rounded chevron" class:rotated={openSections.sharing}>expand_more</span>
      </button>
      {#if sectionOpen(openSections, settingsQuery, 'sharing') && sectionVisible(settingsQuery, 'sharing')}
        <div class="section-body" transition:slide={{ duration: 180 }}>
          {#if $currentUser?.role === 'admin'}
            <p class="sub-label">Admin</p>
            <div class="card settings-card">
              <div class="setting-row">
                <div>
                  <span class="setting-label">Enable food sharing</span>
                  <span class="setting-desc">Allow group members to share foods, meals, and recipes with each other</span>
                </div>
                <Toggle checked={adminSharingEnabled} on:change={e => saveAdminSharingEnabled(e.detail)} />
              </div>
            </div>
          {/if}
          {#if adminSharingEnabled}
          <p class="sub-label">Bulk Share</p>
          <div class="card settings-card" style="gap:0">
            <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px;padding:12px 16px">
              <span class="setting-label">Apply visibility to</span>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                {#each ['foods','meals','recipes'] as t}
                  <button class="chip" class:accent={bulkTargets.has(t)} on:click={() => toggleBulkTarget(t)}>
                    {#if bulkTargets.has(t)}<span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;margin-right:2px">check</span>{/if}{t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                {/each}
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Set visibility to</span>
              <div class="select-wrap" style="width:130px">
                <select class="select sel-sm" bind:value={bulkVisibility} on:change={() => { if (bulkVisibility === 'specific') loadBulkUsers(); }}>
                  <option value="private">Private</option>
                  <option value="group">Everyone</option>
                  <option value="specific">Specific people</option>
                </select>
              </div>
            </div>
            {#if bulkVisibility === 'specific'}
              <div style="padding:0 16px 8px">
                <div class="setting-desc" style="margin-bottom:8px">Select which members can see your items:</div>
                <div style="display:flex;flex-wrap:wrap;gap:8px">
                  {#each bulkUsers as u}
                    <button class="chip" class:chip-active={bulkSelectedIds.includes(u.id)}
                      on:click={() => toggleBulkUser(u.id)}>
                      {#if bulkSelectedIds.includes(u.id)}
                        <span class="material-symbols-rounded" style="font-size:14px">check</span>
                      {/if}
                      {u.name}
                    </button>
                  {/each}
                  {#if !bulkUsersLoaded}<span class="setting-desc">Loading…</span>{/if}
                </div>
              </div>
            {/if}
            <div style="padding:8px 16px 12px">
              <button class="btn btn-secondary w-full" on:click={applyBulkShare} disabled={bulkApplying}>
                {bulkApplying ? 'Applying…' : 'Apply to existing items'}
              </button>
            </div>
          </div>
          {/if}
        </div>
      {/if}
    {/if}

    <!-- ── User Management (hidden in native local mode — single user) ────── -->
    {#if !isNativeLocal}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'users')} on:click={() => toggleSection('users')}>
      <span class="material-symbols-rounded si">group</span>
      <span>User Management</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.users}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'users') && sectionVisible(settingsQuery, 'users')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          {#if $userMgmtActive}
            <!-- Current user row -->
            <button class="setting-row setting-action" on:click={() => push('/profile')}>
              <span class="material-symbols-rounded si" style="color:var(--accent)">manage_accounts</span>
              <div>
                <span class="setting-label">My Profile</span>
                <div class="setting-desc">{$currentUser?.nickname || $currentUser?.full_name || $currentUser?.username || ''}</div>
              </div>
              <span class="material-symbols-rounded text-3" style="font-size:18px">chevron_right</span>
            </button>
            <div class="setting-divider"></div>

            <!-- User list (admin only) -->
            {#if $currentUser?.role === 'admin'}
              <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px;padding:12px 16px">
                <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
                  <span class="setting-label">Users</span>
                  <button class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 10px"
                    on:click={() => { showAddUser = !showAddUser; umError = ''; }}>
                    {showAddUser ? 'Cancel' : '+ Add User'}
                  </button>
                </div>

                {#if showAddUser}
                  <div class="um-add-form" transition:slide={{ duration: 160 }}>
                    <div class="um-form-row">
                      <input class="input" type="text" bind:value={newUsername} placeholder="Username *" autocomplete="off" />
                      <div style="display:flex;gap:4px;align-items:center;flex:1">
                        {#if newShowPass}
                          <input class="input" style="flex:1" type="text" bind:value={newPassword} placeholder="Password *" autocomplete="new-password" />
                        {:else}
                          <input class="input" style="flex:1" type="password" bind:value={newPassword} placeholder="Password *" autocomplete="new-password" />
                        {/if}
                        <button class="btn-icon" on:click={() => newShowPass = !newShowPass} style="flex-shrink:0">
                          <span class="material-symbols-rounded" style="font-size:18px">{newShowPass ? 'visibility_off' : 'visibility'}</span>
                        </button>
                      </div>
                    </div>
                    <div class="um-form-row">
                      <input class="input" type="text" bind:value={newFullName} placeholder="Full name (optional)" />
                      <select class="input" bind:value={newRole}>
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    {#if umError}<p class="um-error">{umError}</p>{/if}
                    <button class="btn btn-primary" style="width:100%" on:click={addUser} disabled={umLoading}>
                      {umLoading ? 'Adding...' : 'Create User'}
                    </button>
                  </div>
                {/if}

                <div class="um-user-list">
                  {#each umUsers as u}
                    <div class="um-user-row">
                      <div class="um-user-avatar">
                        {#if u.avatar_url}
                          <img src={resolveAssetUrl(u.avatar_url)} alt={u.username} />
                        {:else}
                          <span class="material-symbols-rounded">person</span>
                        {/if}
                      </div>
                      <div class="um-user-info">
                        <div class="um-user-name">{u.nickname || u.full_name || u.username}</div>
                        <div class="um-user-sub">@{u.username}{u.role === 'admin' ? ' · admin' : ''}</div>
                      </div>
                      {#if u.id !== $currentUser?.id}
                        <button class="btn btn-ghost um-del-btn" title="Delete user"
                          on:click={() => deleteUser(u.id)}>
                          <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger)">person_remove</span>
                        </button>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
              <div class="setting-divider"></div>

              <!-- Invite user -->
              <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px;padding:12px 16px">
                <span class="setting-label">Invite user</span>
                <div class="um-form-row">
                  <input class="input" type="email" bind:value={inviteEmail} placeholder="Email (optional)" />
                  <select class="input" bind:value={inviteRole}>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <button class="btn btn-secondary" style="width:100%" on:click={createInvite} disabled={inviteLoading}>
                  {inviteLoading ? 'Creating…' : 'Generate invite link'}
                </button>
                {#if inviteResult}
                  <div class="invite-result" transition:slide={{ duration: 160 }}>
                    {#if inviteResult.sent}
                      <span class="material-symbols-rounded" style="color:var(--accent);font-size:18px">mark_email_read</span>
                      <span style="font-size:13px">Invite sent to <strong>{inviteEmail || 'user'}</strong></span>
                    {:else}
                      <span style="font-size:13px;color:var(--text-2)">Share this link:</span>
                      <div class="invite-link-row">
                        <input class="input" style="flex:1;font-size:12px" readonly value={inviteResult.inviteUrl} />
                        <button class="btn btn-secondary" style="height:36px;padding:0 12px;font-size:12px"
                          on:click={() => { navigator.clipboard?.writeText(inviteResult.inviteUrl); showSuccess('Copied!'); }}>
                          Copy
                        </button>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>

              <div class="setting-divider"></div>
              <div class="setting-row">
                <div>
                  <span class="setting-label">Session duration</span>
                  <div class="setting-desc">How long users stay signed in. Applies to new logins.</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px">
                  <div class="select-wrap" style="width:130px">
                    <select class="select sel-sm" bind:value={sessionHours}>
                      <option value="0">Never expires</option>
                      <option value="8">8 hours</option>
                      <option value="24">1 day</option>
                      <option value="168">7 days</option>
                      <option value="720">30 days</option>
                      <option value="2160">90 days</option>
                      <option value="8760">1 year</option>
                    </select>
                  </div>
                  <button class="btn btn-secondary" style="height:32px;font-size:12px;padding:0 12px;white-space:nowrap" on:click={saveSessionHours}>
                    {#if sessionSaved}<span class="material-symbols-rounded" style="font-size:14px">check</span>{:else}Save{/if}
                  </button>
                </div>
              </div>

              <div class="setting-divider"></div>
              <button class="setting-row setting-action danger" on:click={() => showDisableUmDialog = true}>
                <span class="material-symbols-rounded si" style="color:var(--danger)">no_accounts</span>
                <div>
                  <span class="setting-label" style="color:var(--danger)">Disable user management</span>
                  <div class="setting-desc">Removes all user accounts and returns to single-user mode</div>
                </div>
              </button>
            {/if}

            <div class="setting-divider"></div>
            <button class="setting-row setting-action" on:click={logoutServer}>
              <span class="material-symbols-rounded si" style="color:var(--text-3)">logout</span>
              <span class="setting-label">Sign out</span>
            </button>
          {:else}
            <button class="setting-row setting-action" on:click={() => { showEnableUm = !showEnableUm; enableUmError = ''; }}>
              <span class="material-symbols-rounded si" style="color:var(--accent)">group_add</span>
              <div>
                <span class="setting-label">Enable user management</span>
                <div class="setting-desc">Add multiple user accounts with separate data &amp; settings</div>
              </div>
              <span class="material-symbols-rounded text-3" style="font-size:18px">{showEnableUm ? 'expand_less' : 'expand_more'}</span>
            </button>

            {#if showEnableUm}
              <div class="section-body" style="padding:0 16px 16px" transition:slide={{ duration: 160 }}>
                <p class="um-section-label" style="margin-bottom:8px">Create admin account</p>
                <div class="um-add-form">
                  <div class="um-form-row">
                    <input class="input" type="text" bind:value={enableAdminUser} placeholder="Username *" autocomplete="username" />
                    <input class="input" type="text" bind:value={enableAdminName} placeholder="Full name (optional)" />
                  </div>
                  <div class="um-form-row">
                    <div style="display:flex;gap:4px;align-items:center;flex:1">
                      {#if enableShowPass}
                        <input class="input" style="flex:1" type="text" bind:value={enableAdminPass} placeholder="Password *" autocomplete="new-password" />
                      {:else}
                        <input class="input" style="flex:1" type="password" bind:value={enableAdminPass} placeholder="Password *" autocomplete="new-password" />
                      {/if}
                      <button class="btn-icon" on:click={() => enableShowPass = !enableShowPass} style="flex-shrink:0">
                        <span class="material-symbols-rounded" style="font-size:18px">{enableShowPass ? 'visibility_off' : 'visibility'}</span>
                      </button>
                    </div>
                    {#if enableShowPass}
                      <input class="input" type="text" bind:value={enableAdminConf} placeholder="Confirm *" autocomplete="new-password" />
                    {:else}
                      <input class="input" type="password" bind:value={enableAdminConf} placeholder="Confirm *" autocomplete="new-password" />
                    {/if}
                  </div>
                  {#if enableUmError}<p class="um-error">{enableUmError}</p>{/if}
                  <button class="btn btn-primary" style="width:100%" on:click={enableUserManagement} disabled={enableUmLoading}>
                    {enableUmLoading ? 'Enabling...' : 'Enable & Create Admin'}
                  </button>
                </div>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
    {/if}

    <!-- ── Email (hidden in native local mode — no server to send from) ───── -->
    {#if $currentUser?.role === 'admin' && !isNativeLocal}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'email')} on:click={() => toggleSection('email')}>
      <span class="material-symbols-rounded si">mail</span>
      <span>Email (SMTP)</span>
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
        <div class="card settings-card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">SMTP Host</label>
            <input class="input" type="text" placeholder="e.g. smtp.example.com"
              bind:value={smtpHost} disabled={envLocks.smtp} />
          </div>
          <div style="display:flex;gap:10px">
            <div class="form-group" style="flex:1">
              <label class="form-label">Port</label>
              <input class="input" type="number" placeholder="587"
                bind:value={smtpPort} disabled={envLocks.smtp} />
            </div>
            <div class="form-group" style="display:flex;flex-direction:column;gap:6px;justify-content:flex-end;padding-bottom:2px">
              <label class="form-label">TLS</label>
              <Toggle checked={smtpSecure} on:change={e => smtpSecure = e.detail} disabled={envLocks.smtp} />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Username</label>
            <input class="input" type="text" autocomplete="off" placeholder="SMTP username or email"
              bind:value={smtpUser} disabled={envLocks.smtp} />
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <div style="display:flex;gap:8px;align-items:center">
              {#if smtpShowPass}
                <input class="input" style="flex:1" type="text" autocomplete="new-password" placeholder="SMTP password or app password"
                  bind:value={smtpPass} disabled={envLocks.smtp} />
              {:else}
                <input class="input" style="flex:1" type="password" autocomplete="new-password" placeholder="SMTP password or app password"
                  bind:value={smtpPass} disabled={envLocks.smtp} />
              {/if}
              <button class="btn-icon" on:click={() => smtpShowPass = !smtpShowPass} title={smtpShowPass ? 'Hide' : 'Show'}>
                <span class="material-symbols-rounded">{smtpShowPass ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">From address</label>
            <input class="input" type="email" placeholder='NutriTrace <noreply@example.com>'
              bind:value={smtpFrom} disabled={envLocks.smtp} />
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <button class="btn btn-primary" style="height:36px;font-size:13px"
              on:click={saveSmtp} disabled={smtpSaving || envLocks.smtp}>
              {#if smtpSaved}
                <span class="material-symbols-rounded" style="font-size:16px">check</span> Saved
              {:else}
                {smtpSaving ? 'Saving…' : 'Save'}
              {/if}
            </button>
            <button class="btn btn-secondary" style="height:36px;font-size:13px"
              on:click={testSmtp} disabled={!smtpHost || smtpTestStatus === 'testing'}>
              {smtpTestStatus === 'testing' ? 'Testing…' : 'Test'}
            </button>
            {#if smtpTestStatus === 'ok'}
              <span style="color:var(--macro-carbs);font-size:13px;display:flex;align-items:center;gap:4px">
                <span class="material-symbols-rounded" style="font-size:16px">check_circle</span>Connected
              </span>
            {:else if smtpTestStatus === 'fail'}
              <span style="color:var(--danger);font-size:13px;display:flex;align-items:center;gap:4px">
                <span class="material-symbols-rounded" style="font-size:16px">error</span>Failed
              </span>
            {/if}
          </div>
        </div>
      </div>
    {/if}
    {/if}

    <!-- ── Backup & Restore ────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'backup')} on:click={() => toggleSection('backup')}>
      <span class="material-symbols-rounded si">backup</span>
      <span>Backup & Restore</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.backup}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'backup') && sectionVisible(settingsQuery, 'backup')}
      <div class="section-body" transition:slide={{ duration: 180 }}>

        <!-- Full backup (admin only, server mode only — files stored on server) -->
        {#if $currentUser?.role === 'admin' && !isNativeLocal}
        <p class="sub-label">Full Backup</p>
        <div class="card settings-card">
          <div style="padding:12px 16px 4px">
            <p class="setting-desc" style="margin:0 0 12px">A complete snapshot of everything — all user data, diary, foods, meals, recipes, settings, and uploaded images. Saved on the server and available to download or restore at any time.</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
              <button class="btn btn-primary" style="height:36px;font-size:13px"
                on:click={createFullBackup} disabled={fullBackupBusy}>
                {#if fullBackupBusy}
                  <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span> Working…
                {:else}
                  <span class="material-symbols-rounded" style="font-size:16px">add_circle</span> Create Backup
                {/if}
              </button>
              <button class="btn btn-secondary" style="height:36px;font-size:13px"
                on:click={pickUploadRestore} disabled={fullBackupBusy}>
                <span class="material-symbols-rounded" style="font-size:16px">upload</span> Upload &amp; Restore
              </button>
            </div>
            {#if restoreStatus}
              <div class="restore-progress" bind:this={restoreProgressEl}>
                <div class="restore-progress-label">
                  <span class="material-symbols-rounded spin" style="font-size:15px;flex-shrink:0">autorenew</span>
                  {restoreStatus.label}
                </div>
                <div class="restore-progress-track">
                  <div class="restore-progress-fill" style="width:{restoreStatus.percent}%"></div>
                </div>
              </div>
            {/if}
          </div>

          {#if fullBackups.length > 0}
            <div class="setting-divider"></div>
            <!-- Table header -->
            <div class="backup-table-header">
              <span>Name</span>
              <span>Created</span>
              <span>Size</span>
              <span></span>
            </div>
            <div class="setting-divider"></div>
            {#each fullBackups as bk, i}
              {#if i > 0}<div class="setting-divider"></div>{/if}
              <div class="backup-row">
                <span class="backup-name">{bk.filename}</span>
                <span class="backup-col-date">{new Date(bk.createdAt).toLocaleDateString()}</span>
                <span class="backup-col-size">{fmtBytes(bk.size)}</span>
                <div class="backup-actions">
                  <button class="btn btn-secondary backup-action-btn"
                    on:click={() => downloadFullBackup(bk.filename)}>
                    <span class="material-symbols-rounded" style="font-size:15px">download</span> Download
                  </button>
                  <button class="btn btn-secondary backup-action-btn"
                    on:click={() => { restoreTarget = bk.filename; showRestoreDialog = true; }} disabled={fullBackupBusy}>
                    <span class="material-symbols-rounded" style="font-size:15px">restore</span> Restore
                  </button>
                  <button class="btn-icon" style="color:var(--danger);padding:0 4px"
                    on:click={() => { deleteTarget = bk.filename; showDeleteBkDialog = true; }} title="Delete backup">
                    <span class="material-symbols-rounded" style="font-size:20px">delete</span>
                  </button>
                </div>
              </div>
            {/each}
          {:else}
            <div class="setting-divider"></div>
            <p style="padding:12px 16px;font-size:13px;color:var(--text-3);margin:0">No backups yet — click Create Backup to get started.</p>
          {/if}
        </div>
        {/if}

        {#if isNativeLocal}
        <p class="sub-label">Full Backup</p>
        <div class="card settings-card">
          <div style="padding:12px 16px 4px">
            <p class="setting-desc" style="margin:0 0 12px">A complete snapshot of everything — all foods, meals, recipes, diary, wellness data, workouts, settings, AND embedded image files. Saved to your device's Documents folder, ready for phone-to-phone transfer without needing a server.</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
              <button class="btn btn-primary" style="height:36px;font-size:13px"
                on:click={exportLocalZip} disabled={localZipBusy}>
                {#if localZipBusy}
                  <span class="material-symbols-rounded spin" style="font-size:16px">autorenew</span> Working…
                {:else}
                  <span class="material-symbols-rounded" style="font-size:16px">add_circle</span> Create Backup
                {/if}
              </button>
              <button class="btn btn-secondary" style="height:36px;font-size:13px"
                on:click={importLocalZip} disabled={localZipBusy}>
                <span class="material-symbols-rounded" style="font-size:16px">upload</span> Upload &amp; Restore
              </button>
            </div>
            {#if localZipStatus}
              <div class="restore-progress">
                <div class="restore-progress-label">
                  <span class="material-symbols-rounded spin" style="font-size:15px;flex-shrink:0">autorenew</span>
                  {localZipStatus}
                </div>
              </div>
            {/if}
          </div>

          {#if localBackups.length > 0}
            <div class="setting-divider"></div>
            <div class="backup-table-header">
              <span>Name</span>
              <span>Created</span>
              <span>Size</span>
              <span></span>
            </div>
            <div class="setting-divider"></div>
            {#each localBackups as bk, i}
              {#if i > 0}<div class="setting-divider"></div>{/if}
              <div class="backup-row">
                <span class="backup-name">{bk.filename}</span>
                <span class="backup-col-date">{new Date(bk.createdAt).toLocaleDateString()}</span>
                <span class="backup-col-size">{fmtBytes(bk.size)}</span>
                <div class="backup-actions">
                  <button class="btn btn-secondary backup-action-btn"
                    on:click={() => shareLocalBackup(bk.filename)}>
                    <span class="material-symbols-rounded" style="font-size:15px">share</span> Share
                  </button>
                  <button class="btn btn-secondary backup-action-btn"
                    on:click={() => restoreLocalBackup(bk.filename)} disabled={localZipBusy}>
                    <span class="material-symbols-rounded" style="font-size:15px">restore</span> Restore
                  </button>
                  <button class="btn-icon" style="color:var(--danger);padding:0 4px"
                    on:click={() => deleteLocalBackup(bk.filename)} title="Delete backup">
                    <span class="material-symbols-rounded" style="font-size:20px">delete</span>
                  </button>
                </div>
              </div>
            {/each}
          {:else}
            <div class="setting-divider"></div>
            <p style="padding:12px 16px;font-size:13px;color:var(--text-3);margin:0">No backups yet — tap Create Backup to get started.</p>
          {/if}
        </div>
        {/if}

        <!-- Portable JSON export/import (legacy) -->
        <p class="sub-label">Portable JSON Export</p>
        <div class="card settings-card">
          <button class="setting-row setting-action" on:click={exportBackup}>
            <span class="material-symbols-rounded si" style="color:var(--accent)">download</span>
            <div>
              <span class="setting-label">Export JSON</span>
              <div class="setting-desc">Lighter format — JSON only, no images. Useful for sharing data between accounts or quick text-based exports.</div>
            </div>
            <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
          </button>
          <div class="setting-divider"></div>
          <button class="setting-row setting-action" on:click={importBackup}>
            <span class="material-symbols-rounded si" style="color:var(--accent)">upload</span>
            <div>
              <span class="setting-label">Import JSON</span>
              <div class="setting-desc">Restores from a previously exported JSON file. Merges with existing data — does not erase what's already here.</div>
            </div>
            <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
          </button>
        </div>

        <!-- Other tools -->
        <p class="sub-label">Other</p>
        <div class="card settings-card">
          <button class="setting-row setting-action" on:click={exportCSV}>
            <span class="material-symbols-rounded si" style="color:var(--info)">table_chart</span>
            <div>
              <span class="setting-label">Export diary as CSV</span>
              <div class="setting-desc">Downloads your full diary history as a spreadsheet. Useful for analysis in Excel or Google Sheets.</div>
            </div>
            <span class="material-symbols-rounded text-3" style="font-size:18px;flex-shrink:0">chevron_right</span>
          </button>
        </div>

        <!-- Danger zone -->
        <p class="sub-label danger-zone-label">Danger Zone</p>
        <div class="card settings-card danger-zone-card">
          <button class="setting-row setting-action danger" on:click={() => showClearDialog = true}>
            <span class="material-symbols-rounded si" style="color:var(--danger)">delete_forever</span>
            <div>
              <span class="setting-label" style="color:var(--danger)">Clear all data</span>
              <div class="setting-desc">Permanently deletes all diary entries, foods, meals, and body stats. Settings and credentials are kept.</div>
            </div>
            <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger);flex-shrink:0">chevron_right</span>
          </button>
          <div class="setting-divider"></div>
          <button class="setting-row setting-action danger" on:click={() => showClearSettingsDialog = true}>
            <span class="material-symbols-rounded si" style="color:var(--danger)">manage_history</span>
            <div>
              <span class="setting-label" style="color:var(--danger)">Clear all settings</span>
              <div class="setting-desc">Resets all preferences, credentials, and API keys to defaults. Food and diary data are kept.</div>
            </div>
            <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger);flex-shrink:0">chevron_right</span>
          </button>
        </div>

      </div>
    {/if}

    <!-- ── Server Connection (native app only, after Backup) ────────────── -->
    {#if isNative}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'serverConnection')} on:click={() => toggleSection('serverConnection')}>
      <span class="material-symbols-rounded si">cloud_sync</span>
      <span>Server Connection</span>
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

    <!-- About -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'about')} on:click={() => toggleSection('about')}>
      <span class="material-symbols-rounded si">info</span>
      <span>About</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.about}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'about') && sectionVisible(settingsQuery, 'about')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="about-hero">
            <img src="/icons/logo.png" alt="NutriTrace" class="about-icon" />
            <div>
              <div class="about-name">NutriTrace</div>
              <div class="about-version text-3 text-sm">{APP_VERSION}</div>
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
            <span>PWA + native Android app with offline support</span>
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
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">favorite</span>
            <span>Inspired by <a href="https://github.com/davidhealey/waistline" target="_blank" rel="noopener" class="about-link">Waistline</a> and <a href="https://github.com/CodeWithCJ/SparkyFitness" target="_blank" rel="noopener" class="about-link">SparkyFitness</a></span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="material-symbols-rounded about-feat-icon">volunteer_activism</span>
              <span>Support development</span>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;padding-left:30px">
              <a href="https://github.com/sponsors/YOUR_GITHUB_USERNAME" target="_blank" rel="noopener" class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 12px">
                <span class="material-symbols-rounded" style="font-size:14px">favorite</span> GitHub Sponsors
              </a>
              <a href="https://ko-fi.com/YOUR_KOFI_USERNAME" target="_blank" rel="noopener" class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 12px">
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
      <p style="font-size:13px;color:var(--text-3);margin:0 0 16px;line-height:1.5">
        You have data on this phone. How should it be handled when connecting?
      </p>
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
      <p style="font-size:13px;color:var(--text-3);margin:0">{mergeProgress}</p>
    </div>
  </div>
{/if}

<Dialog bind:open={showClearDialog}
  title="Clear all data"
  message="This will permanently delete all diary entries, foods, meals, and body stats. Settings and credentials are kept. This cannot be undone."
  confirmText="Delete all data"
  cancelText="Cancel"
  dangerous
  on:confirm={clearAllData}
/>

<Dialog bind:open={showClearSettingsDialog}
  title="Clear all settings"
  message="This will reset all preferences, credentials, and API keys to defaults. Food and diary data are kept. This cannot be undone."
  confirmText="Clear all settings"
  cancelText="Cancel"
  dangerous
  on:confirm={clearAllSettings}
/>

<Dialog bind:open={showRestoreDialog}
  title="Restore backup?"
  message="This will replace all current data with the contents of this backup. This cannot be undone."
  confirmText="Restore"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmRestoreFullBackup}
/>

<Dialog bind:open={showUploadRestoreDialog}
  title="Restore from uploaded file?"
  message="This will replace all current data with the contents of the uploaded backup. This cannot be undone."
  confirmText="Restore"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmUploadRestore}
/>

<Dialog bind:open={showDeleteBkDialog}
  title="Delete backup?"
  message="This backup file will be permanently removed from the server."
  confirmText="Delete"
  cancelText="Cancel"
  dangerous
  on:confirm={confirmDeleteFullBackup}
/>

<Dialog bind:open={showDisableUmDialog}
  title="Disable user management"
  message="This will remove all user accounts and their data cannot be recovered. The app will return to single-user mode."
  confirmText="Disable & delete all users"
  cancelText="Cancel"
  dangerous
  on:confirm={disableUserManagement}
/>

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
      <label class="form-label">Hex code</label>
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

<style>
  .settings-content { display: flex; flex-direction: column; gap: 0; }
  .hidden { display: none !important; }

  /* Settings search bar */
  .settings-search-bar {
    position: sticky;
    /* page-top + 10 + 48 (--hamburger-row) + 40 (h1) + 12 (padding-bottom) = +110 */
    top: calc(var(--page-top, var(--safe-top)) + 110px);
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px var(--page-px, 16px) 12px;
    background: var(--glass-surface);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
  }
  /* With banner: padding-bottom is 72, so total = 10+48+40+72 = +170 */
  :global(.page-header.has-banner) + .settings-search-bar {
    top: calc(var(--page-top, var(--safe-top)) + 170px);
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
  .danger-zone-label { color: var(--danger) !important; opacity: 0.85; }
  .danger-zone-card { border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
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
  .setting-action {
    width: 100%; background: none; border: none; cursor: pointer;
    color: var(--text-1); text-align: left;
    transition: background var(--dur-fast);
  }
  .setting-action:active { background: var(--surface-2); }

  .sub-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 4px 2px 2px;
  }
  .sel-sm { height: 36px; font-size: 13px; }

  .restore-progress {
    padding: 0 16px 14px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .restore-progress-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-2);
  }
  .restore-progress-track {
    height: 6px; border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .restore-progress-fill {
    height: 100%; border-radius: 3px;
    background: var(--accent);
    transition: width 300ms ease;
  }

  .backup-table-header {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 6px 16px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
  }
  .backup-row {
    display: grid;
    grid-template-columns: 1fr 100px 80px auto;
    gap: 12px; padding: 10px 16px;
    align-items: center;
  }
  .backup-name {
    font-size: 12px; font-weight: 500; color: var(--text-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .backup-col-date { font-size: 13px; color: var(--text-2); }
  .backup-col-size { font-size: 13px; color: var(--text-2); }
  .backup-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
  .backup-action-btn { height: 30px; font-size: 12px; padding: 0 10px; display: flex; align-items: center; gap: 4px; }

  @media (max-width: 480px) {
    .backup-table-header { display: none; }
    .backup-row {
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto;
      row-gap: 6px;
    }
    .backup-name { grid-column: 1; grid-row: 1; }
    .backup-col-date { grid-column: 1; grid-row: 2; font-size: 12px; }
    .backup-col-size { display: none; }
    .backup-actions { grid-column: 2; grid-row: 1 / 3; flex-direction: column; align-items: stretch; }
    .backup-action-btn { justify-content: center; }
  }

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

  .chip-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
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
  .input-active {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 600;
  }
  .link-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--accent); font-size: inherit; text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link-btn:hover { opacity: 0.8; }
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
  .about-hero {
    display: flex; align-items: center; gap: 16px; padding: 16px;
  }
  .about-icon { width: 56px; height: 56px; border-radius: 12px; }
  .about-name { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .about-version { margin-top: 2px; }
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

  /* ── User Management ── */
  .um-section-label {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-3);
  }
  .um-add-form { display: flex; flex-direction: column; gap: 8px; width: 100%; padding-top: 4px; }
  .um-form-row { display: flex; gap: 8px; }
  .um-form-row > .input { flex: 1; min-width: 0; }
  .um-error { font-size: 12px; color: var(--danger, #ff6b6b); background: rgba(255,107,107,0.1); border-radius: var(--radius-sm); padding: 6px 10px; }
  .um-user-list { display: flex; flex-direction: column; gap: 4px; width: 100%; }
  .invite-result { display: flex; flex-direction: column; gap: 8px; width: 100%; padding: 10px 12px; background: var(--surface-2); border-radius: var(--radius-md); border: 1px solid var(--border); }
  .invite-link-row { display: flex; gap: 6px; align-items: center; }
  .um-user-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px; border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .um-user-avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--surface-3); display: flex; align-items: center; justify-content: center;
    overflow: hidden; flex-shrink: 0;
  }
  .um-user-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .um-user-avatar .material-symbols-rounded { font-size: 20px; color: var(--text-3); }
  .um-user-info { flex: 1; min-width: 0; }
  .um-user-name { font-size: 14px; font-weight: 600; }
  .um-user-sub  { font-size: 12px; color: var(--text-3); }
  .um-del-btn { padding: 4px; min-width: 0; }

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
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
