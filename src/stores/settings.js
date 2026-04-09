import { writable, get } from 'svelte/store';
import { DB } from '../lib/db.js';

// ── Settings categorization ────────────────────────────────────────────────
//
// USER_PREFS — synced to server, travel with the user across devices.
//   Includes nutrition prefs, units, integrations (creds), notifications.
//
// DEVICE_PREFS — local-only, never synced. Each device chooses its own value.
//   Reasons: form factor (sidebar vs bottom nav), screen lighting (dark/light
//   theme), performance (animations on/off per device), or device-specific
//   hardware (camera flashlight is meaningless on desktop).
//
// SERVER_ADMIN — server-only, never reach clients (filtered in
//   server/lib/server-only-keys.js). OAuth app credentials etc.
//
export const USER_PREFS = new Set([
  'energyUnit','mealNames','goals','goalTemplates',
  'visibleNutriments','nutrimentsOrder','customNutriments',
  'bodyStatsOrder','hiddenBodyStats','foodCategories',
  'diaryShowNutritionBar','diaryTotalsMode',
  'diaryShowBrands','diaryShowTimestamps','diaryShowThumbnails',
  'diaryShowAllNutrients','diaryShowNutritionUnits','diaryShowMacroSummary',
  'diaryPromptQuantity','diaryShowPortionSize',
  'foodsShowCategories','foodsShowLabels','foodsShowNotes','foodsShowThumbnails',
  'foodsShowYesterdayMeals','foodsSort',
  'barcodeBeep','cropPhotos',
  'offSearchLanguage','offSearchCountry','offUploadCountry',
  'weightUnit','heightUnit','lengthUnit','distUnit','tempUnit',
  'waterGoalMl','waterUnit','waterContainers','waterShowInStats','waterShowInDiary',
  'dateFormat','timeFormat','timezone',
  'statsChartType','statsYZero','statsAvgLine','statsGoalLine','statsTrendLine',
  'aiEnabled','aiProvider','aiApiKey','aiModel','aiAssistantName','quickLogEnabled',
  'usdaEnabled','usdaApiKey','offUsername','offPassword',
  'mealieEnabled','mealieBaseUrl','mealieApiToken',
  'wellnessEnabled','fitbitEnabled','healthConnectEnabled','wellnessMetrics','workoutsEnabled',
  'wellnessSyncMode','wellnessSyncSchedule','wellnessSyncTime','wellnessSyncRange',
  'withingsEnabled','withingsSyncRange','withingsDataPriority',
  'garminEnabled','garminSyncRange',
  'defaultFoodVisibility',
  // Notifications
  'notifLocalEnabled','notifPushService',
  'notifWaterReminders','notifWaterInterval','notifMealReminders','notifMealTimes',
  'notifGoalCelebrations','notifCalorieGoal','notifStepGoal',
  'notifWeighIn','notifWeighInTime','notifWeeklySummary',
  'notifWellnessAlerts','notifWorkoutSummary','notifSyncFailures',
  'appriseUrl','appriseTag','gotifyUrl','gotifyToken','ntfyUrl','ntfyTopic','ntfyToken',
  // UI behavior prefs that should match across devices
  'accentColor','startPage','goalCelebrations','pageBanners','loopBannerAnimations',
]);

// DEVICE_PREFS — local-only, never synced.
export const DEVICE_PREFS = new Set([
  'appearance',         // light/dark — depends on each device's lighting context
  'navStyle',           // bottom-nav makes no sense on desktop, sidebar makes none on phone
  'sidebarPersistent',  // form-factor specific
  'disableAnimations',  // performance pref tied to device speed
  'barcodeFlashlight',  // hardware-specific (no flashlight on desktop)
]);

// Backwards-compat alias — keeps existing .has(key) checks working without
// touching every call site. Equivalent to USER_PREFS.
const SERVER_SETTINGS = USER_PREFS;

import { isNative, getServerUrl, getAuthToken } from '../lib/platform.js';

function _settingsUrl() {
  if (isNative) { const url = getServerUrl(); if (url) return url + '/api/settings'; }
  return '/api/settings';
}

function _authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    const token = getAuthToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  }
  return h;
}

const _saveQueue = {};
// Track recently changed keys to protect from pull overwrites during race window
const _recentlyChanged = new Map(); // key → timestamp
export function isRecentlyChanged(key) {
  const ts = _recentlyChanged.get(key);
  return ts && Date.now() - ts < 10000; // 10-second protection window
}
// Suppress scheduleSave when loading settings from server (prevents feedback loop)
let _suppressSync = false;

/** Apply a server-sourced setting to localStorage + notify stores without pushing back */
export function _applySetting(key, value) {
  _suppressSync = true;
  DB.setSetting(key, value);
  _suppressSync = false;
}
function _isLoggedIn() { return !!localStorage.getItem('wl:userId'); }
function _shouldSyncToServer() { return _isLoggedIn() && !(isNative && !getServerUrl()); }
export function scheduleSave(key, value) {
  if (!SERVER_SETTINGS.has(key)) return;
  if (_suppressSync) return;
  clearTimeout(_saveQueue[key]);
  _saveQueue[key] = setTimeout(async () => {
    // Try direct push to server (fast path when online)
    if (!_shouldSyncToServer()) return;
    try {
      const url = _settingsUrl();
      console.log(`[settings] pushing ${key}=${JSON.stringify(value)} to ${url}`);
      const res = await fetch(url, {
        method: 'PUT',
        credentials: 'include',
        headers: _authHeaders(),
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      console.log(`[settings] pushed ${key} to server OK`);
      // If direct push succeeded on native, mark as synced so differential sync skips it
      if (isNative) {
        try {
          const { dbMarkSettingsSynced } = await import('../lib/db-native.js');
          await dbMarkSettingsSynced([key]);
        } catch {}
      }
    } catch (e) {
      console.warn(`[settings] direct push failed for ${key}:`, e.message);
      // Leave as 'pending' in local SQLite — differential sync will push it later
    }
  }, 600);
}

/**
 * Bulk-set many settings at once with a SINGLE server push.
 *
 * Used by onboarding flows (Wizard) where ~15 settings get written in
 * sequence. Without this, each individual write would fire the global
 * wl:setting listener and trigger its own debounced server push,
 * resulting in 15 separate API calls within a second.
 *
 * Behavior:
 *  - Writes all keys to localStorage (with wl:setting events suppressed
 *    to avoid the listener echoing them as individual server pushes)
 *  - Native: writes all keys to local SQLite user_settings as 'pending'
 *  - Fires a single bulk API call to PUT /api/settings/bulk
 *  - After the API call, marks all keys as 'synced' in native SQLite
 *  - DEVICE_PREFS and SERVER_ADMIN keys are silently filtered out
 */
export async function bulkSet(settingsObj) {
  if (!settingsObj || typeof settingsObj !== 'object') return;
  const entries = Object.entries(settingsObj);
  if (entries.length === 0) return;

  // Filter to USER_PREFS only
  const userPrefEntries = entries.filter(([k]) => USER_PREFS.has(k));

  // Step 1: write to localStorage WITH suppressSync so the global listener
  // doesn't fire individual debounced pushes for each key
  _suppressSync = true;
  try {
    for (const [key, value] of entries) {
      DB.setSetting(key, value);
    }
  } finally {
    _suppressSync = false;
  }

  // Step 2: native — write all USER_PREFS to local SQLite as pending
  if (isNative && userPrefEntries.length > 0) {
    try {
      const { dbUpsertSetting } = await import('../lib/db-native.js');
      for (const [key, value] of userPrefEntries) {
        await dbUpsertSetting(key, value);
      }
    } catch (e) {
      console.warn('[settings] bulk native upsert failed:', e.message);
    }
  }

  // Step 3: single bulk API call (only if we should sync to server)
  if (!_shouldSyncToServer() || userPrefEntries.length === 0) return;
  try {
    const url = _settingsUrl() + '/bulk';
    const bulkObj = Object.fromEntries(userPrefEntries);
    console.log(`[settings] bulk pushing ${userPrefEntries.length} keys`);
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: _authHeaders(),
      body: JSON.stringify({ settings: bulkObj }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    console.log(`[settings] bulk pushed ${userPrefEntries.length} keys OK`);
    // Mark all keys as synced in native SQLite
    if (isNative) {
      try {
        const { dbMarkSettingsSynced } = await import('../lib/db-native.js');
        await dbMarkSettingsSynced(userPrefEntries.map(([k]) => k));
      } catch {}
    }
  } catch (e) {
    console.warn('[settings] bulk push failed:', e.message);
    // Leave as 'pending' in local SQLite — differential sync will push them later
  }
}

/**
 * Called after login/auth-check. Fetches all server settings and populates
 * localStorage + notifies all stores via wl:setting events.
 *
 * On native, ALSO writes each setting to the native SQLite user_settings
 * table so background workers (ReminderWorker, etc.) read fresh values.
 * Without this, WorkManager would see stale or missing settings even after
 * the JS app pulls everything from the server.
 */
export async function loadServerSettings() {
  if (!_shouldSyncToServer()) return;
  try {
    const res = await fetch(_settingsUrl(), { credentials: 'include', headers: _authHeaders(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const serverSettings = await res.json();
    _suppressSync = true; // Don't push these back to server

    // Write all to localStorage (PWA + native JS layer)
    for (const [key, value] of Object.entries(serverSettings)) {
      DB.setSetting(key, value);
    }

    // Native: also mirror into the native SQLite user_settings table so the
    // WorkManager / background workers have access to fresh values. Mark as
    // 'synced' so the differential sync doesn't try to re-push them.
    if (isNative) {
      try {
        const { dbUpsertSetting, dbMarkSettingsSynced } = await import('../lib/db-native.js');
        const keys = [];
        for (const [key, value] of Object.entries(serverSettings)) {
          await dbUpsertSetting(key, value);
          keys.push(key);
        }
        if (keys.length) await dbMarkSettingsSynced(keys);
      } catch (e) {
        console.warn('[settings] native SQLite mirror failed:', e.message);
      }
    }

    _suppressSync = false;
  } catch { _suppressSync = false; }
}

/**
 * Creates a Svelte store backed by a DB setting.
 * Syncs with the 'wl:setting' window event so changes in one
 * component are immediately reflected everywhere.
 */
// ── Global wl:setting listener — catches direct DB.setSetting() calls ──────
// Some legacy code paths write settings via DB.setSetting() directly instead
// of going through a store's .set(). Without this listener, those writes
// would never trigger a server push for USER_PREFS keys, leaving the server
// (and other devices) out of sync. This single listener fixes all bypass
// call sites at once without touching them individually.
//
// The store-based path also fires this listener, but scheduleSave() is
// debounced (600ms) on a per-key basis, so the duplicate trigger is harmless
// — only the latest call wins. The early-exit in DB.setSetting() further
// prevents unnecessary re-entry when the value is unchanged.
if (typeof window !== 'undefined') {
  window.addEventListener('wl:setting', (e) => {
    const key = e.detail?.key;
    if (!key) return;
    if (!USER_PREFS.has(key)) return;        // device-only or unknown key — skip
    if (_suppressSync) return;                // server-sourced update — don't echo
    const value = DB.getSetting(key, undefined);
    _recentlyChanged.set(key, Date.now());
    // Native: write to local SQLite immediately (marks as pending for sync protection)
    if (isNative) {
      import('../lib/db-native.js').then(({ dbUpsertSetting }) => dbUpsertSetting(key, value)).catch(() => {});
    }
    scheduleSave(key, value);
  });
}

function createSettingStore(key, defaultValue) {
  const store = writable(DB.getSetting(key, defaultValue));

  window.addEventListener('wl:setting', (e) => {
    if (e.detail && e.detail.key === key) {
      store.set(DB.getSetting(key, defaultValue));
    }
  });

  return {
    subscribe: store.subscribe,
    set(value) {
      // Skip if value hasn't changed (prevents $: reactive statements from flooding on mount)
      const current = DB.getSetting(key, defaultValue);
      if (JSON.stringify(current) === JSON.stringify(value)) {
        store.set(value); // still update store in case it's stale
        return;
      }
      DB.setSetting(key, value);
      store.set(value);
      if (_suppressSync) return; // Server-sourced update — don't push back
      _recentlyChanged.set(key, Date.now());
      // On native: write to local SQLite immediately (marks as pending for sync protection)
      if (isNative && SERVER_SETTINGS.has(key)) {
        import('../lib/db-native.js').then(({ dbUpsertSetting }) => dbUpsertSetting(key, value)).catch(() => {});
      }
      scheduleSave(key, value);
    },
    update(fn) {
      const current = DB.getSetting(key, defaultValue);
      this.set(fn(current));
    },
    get() {
      return get(store);
    }
  };
}

export const appearance       = createSettingStore('appearance',       'system');
export const energyUnit        = createSettingStore('energyUnit',       'kcal');
export const mealNames         = createSettingStore('mealNames',        ['Breakfast','Lunch','Dinner','Snacks']);
export const goals             = createSettingStore('goals',            {});
export const goalTemplates     = createSettingStore('goalTemplates',    []);
export const visibleNutriments = createSettingStore('visibleNutriments', null);
export const nutrimentsOrder   = createSettingStore('nutrimentsOrder',  []);
export const customNutriments  = createSettingStore('customNutriments', []);
export const bodyStatsOrder    = createSettingStore('bodyStatsOrder',   []);
export const hiddenBodyStats   = createSettingStore('hiddenBodyStats',  []);
export const foodCategories    = createSettingStore('foodCategories',   []);

// Display prefs used in multiple pages
export const diaryShowNutritionBar = createSettingStore('diaryShowNutritionBar', true);
export const diaryTotalsMode      = createSettingStore('diaryTotalsMode', 'consumed'); // 'consumed' | 'remaining'
export const diaryShowBrands        = createSettingStore('diaryShowBrands',        true);
export const diaryShowTimestamps    = createSettingStore('diaryShowTimestamps',     false);
export const diaryShowThumbnails    = createSettingStore('diaryShowThumbnails',     true);
export const diaryShowAllNutrients  = createSettingStore('diaryShowAllNutrients',   false);
export const diaryShowNutritionUnits= createSettingStore('diaryShowNutritionUnits', true);
export const diaryShowMacroSummary  = createSettingStore('diaryShowMacroSummary',   true);
export const diaryPromptQuantity    = createSettingStore('diaryPromptQuantity',     true);
export const diaryShowPortionSize   = createSettingStore('diaryShowPortionSize',    false);

export const foodsShowCategories    = createSettingStore('foodsShowCategories',    true);
export const foodsShowLabels        = createSettingStore('foodsShowLabels',        true);
export const foodsShowNotes         = createSettingStore('foodsShowNotes',         true);
export const foodsShowThumbnails    = createSettingStore('foodsShowThumbnails',    true);
export const foodsShowYesterdayMeals= createSettingStore('foodsShowYesterdayMeals',true);
export const foodsSort              = createSettingStore('foodsSort',              'alpha');

export const barcodeBeep            = createSettingStore('barcodeBeep',            false);
export const barcodeFlashlight      = createSettingStore('barcodeFlashlight',      false);
export const cropPhotos             = createSettingStore('cropPhotos',             false);
export const offSearchLanguage      = createSettingStore('offSearchLanguage',      'en');
export const offSearchCountry       = createSettingStore('offSearchCountry',       'World');
export const offUploadCountry       = createSettingStore('offUploadCountry',       'Auto');

export const accentColor = createSettingStore('accentColor', 'mint');

/** Apply accent color — supports named presets and custom hex (#rrggbb) */
export function applyAccentColor(value) {
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
  // Clear any previously injected custom vars
  ['--accent','--accent-2','--accent-dim','--accent-text'].forEach(v =>
    document.documentElement.style.removeProperty(v));
  if (value === 'mint') {
    document.documentElement.removeAttribute('data-accent');
  } else if (isHex) {
    // Custom hex: remove data-accent and inject CSS vars directly
    document.documentElement.removeAttribute('data-accent');
    const r = parseInt(value.slice(1,3), 16);
    const g = parseInt(value.slice(3,5), 16);
    const b = parseInt(value.slice(5,7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    document.documentElement.style.setProperty('--accent',      value);
    document.documentElement.style.setProperty('--accent-2',    value);
    document.documentElement.style.setProperty('--accent-dim',  `rgba(${r},${g},${b},0.15)`);
    document.documentElement.style.setProperty('--accent-text', lum > 0.55 ? '#0A0B0F' : '#FFFFFF');
  } else {
    document.documentElement.setAttribute('data-accent', value);
  }
  accentColor.set(value);
}

/** Apply an appearance change and update the DOM + theme-color meta */
export function applyAppearance(value) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = value === 'dark' || (value === 'system' && prefersDark);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = dark ? '#0A0B0F' : '#F5F7FA';
  appearance.set(value);
}

// Navigation & app settings (not already declared above)
export const navStyle          = createSettingStore('navStyle',          'both');
export const sidebarPersistent = createSettingStore('sidebarPersistent', false);
export const startPage         = createSettingStore('startPage',         '/');
export const disableAnimations  = createSettingStore('disableAnimations',  false);
export const goalCelebrations   = createSettingStore('goalCelebrations',   true);

// Date / time display format
export const dateFormat = createSettingStore('dateFormat', 'US');   // 'ISO' | 'US' | 'EU' | 'natural'
export const timeFormat = createSettingStore('timeFormat', '12h');  // '12h' | '24h'
export const timezone   = createSettingStore('timezone',   '');     // IANA timezone (e.g. 'America/New_York'), empty = auto-detect

// Statistics chart settings
export const statsChartType = createSettingStore('statsChartType', 'bar');
export const statsYZero     = createSettingStore('statsYZero',     true);
export const statsAvgLine   = createSettingStore('statsAvgLine',   true);
export const statsGoalLine  = createSettingStore('statsGoalLine',  true);
export const statsTrendLine = createSettingStore('statsTrendLine', true);

// Units
export const weightUnit = createSettingStore('weightUnit', 'lb');
export const heightUnit = createSettingStore('heightUnit', 'ft');
export const lengthUnit = createSettingStore('lengthUnit', 'in');
export const distUnit   = createSettingStore('distUnit',   'mi');
export const tempUnit   = createSettingStore('tempUnit',   'F');  // 'F' | 'C'

// Water
export const waterGoalMl      = createSettingStore('waterGoalMl',      2000);
export const waterUnit         = createSettingStore('waterUnit',         'ml');
export const waterContainers   = createSettingStore('waterContainers',   [
  { id: '1', name: 'Small Bottle',    volumeMl: 250 },
  { id: '2', name: 'Standard Bottle', volumeMl: 500 },
]);
export const waterShowInStats  = createSettingStore('waterShowInStats',  true);
export const waterShowInDiary  = createSettingStore('waterShowInDiary',  true);

// USDA / OFF API keys
export const usdaApiKey  = createSettingStore('usdaApiKey',  '');
export const usdaEnabled = createSettingStore('usdaEnabled', false);
export const offUsername = createSettingStore('offUsername', '');
export const offPassword = createSettingStore('offPassword', '');

// ── Category label helpers ─────────────────────────────────────────────────
// foodCategories items can be a plain string (legacy) or { name, label? }
export const catName    = c => typeof c === 'string' ? c : (c?.name    || '');
export const catLabel   = c => typeof c === 'string' ? '' : (c?.label  || '');
export const catDisplay = c => { const l = catLabel(c); return l ? `${l} ${catName(c)}` : catName(c); };

// Page banners
export const pageBanners          = createSettingStore('pageBanners',          true);
export const loopBannerAnimations = createSettingStore('loopBannerAnimations', true);

// Wellness (Activity Tracking)
export const wellnessEnabled    = createSettingStore('wellnessEnabled',    false);
export const fitbitEnabled      = createSettingStore('fitbitEnabled',      false);
export const healthConnectEnabled = createSettingStore('healthConnectEnabled', false);
export const wellnessMetrics    = createSettingStore('wellnessMetrics',    null); // null = all visible
export const workoutsEnabled   = createSettingStore('workoutsEnabled',   false); // show workout history + GPS maps in Movement tab
export const wellnessSyncMode     = createSettingStore('wellnessSyncMode',     'auto'); // 'auto' | 'manual' | 'scheduled'
export const wellnessSyncSchedule = createSettingStore('wellnessSyncSchedule', 'daily'); // 'every6h' | 'every12h' | 'daily' | 'weekly'
export const wellnessSyncTime     = createSettingStore('wellnessSyncTime',     '14:00'); // HH:MM for scheduled sync
export const wellnessSyncRange    = createSettingStore('wellnessSyncRange',    7);    // days: 1|7|30|90|365

export const withingsEnabled      = createSettingStore('withingsEnabled',      false);
export const withingsSyncRange    = createSettingStore('withingsSyncRange',    7);
export const withingsDataPriority = createSettingStore('withingsDataPriority', {
  activity: 'fitbit',  // 'fitbit' | 'withings'
  sleep:    'fitbit',
  heart:    'fitbit',
});

export const garminEnabled   = createSettingStore('garminEnabled',   false);
export const garminSyncRange = createSettingStore('garminSyncRange', 7);

// Sharing
export const defaultFoodVisibility = createSettingStore('defaultFoodVisibility', 'private'); // 'private' | 'group' | 'specific'

// FitBot AI
export const aiEnabled       = createSettingStore('aiEnabled',       false);
export const aiProvider      = createSettingStore('aiProvider',      'claude');
export const aiApiKey        = createSettingStore('aiApiKey',        '');
export const aiModel         = createSettingStore('aiModel',         '');
export const aiAssistantName = createSettingStore('aiAssistantName', 'FitBot');
// Quick Log — natural-language food entry powered by FitBot's AI provider.
// Off by default (experimental). Only usable when aiEnabled is true.
export const quickLogEnabled = createSettingStore('quickLogEnabled', false);

// Notifications
export const notifLocalEnabled     = createSettingStore('notifLocalEnabled',     true);
export const notifPushService     = createSettingStore('notifPushService',     'none'); // 'none' | 'gotify' | 'ntfy' | 'apprise'
export const notifWaterReminders  = createSettingStore('notifWaterReminders',  false);
export const notifWaterInterval   = createSettingStore('notifWaterInterval',   120); // minutes
export const notifMealReminders   = createSettingStore('notifMealReminders',   false);
export const notifMealTimes       = createSettingStore('notifMealTimes',       ['08:00','12:00','18:00']); // HH:MM
export const notifGoalCelebrations = createSettingStore('notifGoalCelebrations', false);
export const notifCalorieGoal     = createSettingStore('notifCalorieGoal',     false);
export const notifStepGoal        = createSettingStore('notifStepGoal',        false);
export const notifWeighIn         = createSettingStore('notifWeighIn',         false);
export const notifWeighInTime     = createSettingStore('notifWeighInTime',     '07:00');
export const notifWeeklySummary   = createSettingStore('notifWeeklySummary',   false);
export const notifWellnessAlerts  = createSettingStore('notifWellnessAlerts',  false);
export const notifWorkoutSummary  = createSettingStore('notifWorkoutSummary',  false);
export const notifSyncFailures    = createSettingStore('notifSyncFailures',    false);
export const appriseUrl           = createSettingStore('appriseUrl',           '');
export const appriseTag           = createSettingStore('appriseTag',           '');
export const gotifyUrl            = createSettingStore('gotifyUrl',            '');
export const gotifyToken          = createSettingStore('gotifyToken',          '');
export const ntfyUrl              = createSettingStore('ntfyUrl',              'https://ntfy.sh');
export const ntfyTopic            = createSettingStore('ntfyTopic',            '');
export const ntfyToken            = createSettingStore('ntfyToken',            '');
