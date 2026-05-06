import { writable, get } from 'svelte/store';
import { DB } from '../lib/db.js';

// Verbose settings sync logs gated on dev OR opt-in verbose mode
// (Settings → Diagnostics → Verbose diagnostic logging).
const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('nt:verboseLogging') === '1') console.log(...a); } catch {} };

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
  'energyUnit','mealNames','goals','goalTemplates','calorieGoalMode','calorieGoalFactor',
  'visibleNutriments','nutrimentsOrder','customNutriments',
  'bodyStatsOrder','hiddenBodyStats','foodCategories',
  'diaryShowNutritionBar','diaryTotalsMode',
  'diaryShowBrands','diaryShowTimestamps','diaryShowThumbnails',
  'diaryShowAllNutrients','diaryShowNutritionUnits','diaryShowMacroSummary',
  'diaryPromptQuantity','diaryShowPortionSize','diaryShowNotes',
  'diaryShowActivity','manualActivityPolicy','activityAutoEstimate','calorieAdjustFromActivity',
  'foodsShowCategories','foodsShowLabels','foodsShowNotes','foodsShowThumbnails',
  'foodsShowYesterdayMeals','foodsYesterdayCollapsed','foodsSavedCollapsed','foodsSort','mealsSort','recipesSort',
  'barcodeBeep','cropPhotos',
  'offEnabled','offSearchLanguage','offSearchCountry','offUploadCountry',
  'weightUnit','heightUnit','lengthUnit','distUnit','tempUnit',
  'waterGoalMl','waterUnit','waterContainers','waterShowInStats','waterShowInDiary',
  'dateFormat','timeFormat','timezone',
  'statsChartType','statsYZero','statsAvgLine','statsGoalLine','statsTrendLine','statsIncludeToday','statsShowEmptyDays',
  // User profile (collected by Wizard, used for goal calculation; sync so multi-device
  // users see the same body profile)
  'gender','dob','height_cm','weight_kg','target_weight','activity','tdee',
  // Native local-mode profile fields (no auth → no users table; these stand in for
  // the server's full_name / nickname / avatar_url). In USER_PREFS so they're
  // captured by the local full-backup ZIP. In server mode they're unused.
  'localUserName','localUserNickname','localUserAvatar',
  'aiEnabled','aiProvider','aiApiKey','aiModel','aiBaseUrl','aiAssistantName','quickLogEnabled','aiGoalInsights',
  'usdaEnabled','usdaApiKey','offUsername','offPassword',
  'mealieEnabled','mealieBaseUrl','mealieApiToken',
  'wellnessEnabled','fitbitEnabled','healthConnectEnabled','wellnessMetrics','workoutsEnabled',
  'wellnessSyncRange',
  'fitbitSyncMode','fitbitSyncInterval','fitbitSyncWindowStart','fitbitSyncWindowEnd',
  'withingsEnabled','withingsSyncRange',
  'withingsSyncMode','withingsSyncInterval','withingsSyncWindowStart','withingsSyncWindowEnd',
  'garminEnabled','garminSyncRange',
  'garminSyncMode','garminSyncInterval','garminSyncWindowStart','garminSyncWindowEnd',
  'healthConnectSyncMode','healthConnectSyncInterval','healthConnectSyncWindowStart','healthConnectSyncWindowEnd',
  'defaultFoodVisibility',
  // Notifications
  'notifLocalEnabled','notifPushService',
  'notifWaterReminders','notifWaterInterval','notifMealReminders','notifMealTimes',
  'notifGoalCelebrations','notifStepGoal',
  'notifWeighIn','notifWeighInTime',
  'notifBedtime','notifBedtimeTime','notifBedtimeWindDown','notifBedtimeWindDownMin','notifBedtimeSmart',
  'notifWeeklySummary','weeklySummaryDay','weeklySummaryTime',
  'notifWellnessAlerts','notifWorkoutSummary','notifSyncFailures',
  'appriseUrl','appriseTag','gotifyUrl','gotifyToken','ntfyUrl','ntfyTopic','ntfyToken',
  // UI behavior prefs that should match across devices
  'accentColor','startPage','goalCelebrations','pageBanners','language',
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

import { isNative, getServerUrl, getAuthToken, apiUrl } from '../lib/platform.js';

function _settingsUrl() {
  return apiUrl('/api/settings');
}

function _authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    // Native server-connected mode: Bearer auth (cookies don't persist across
    // WebView reloads). Bearer requests are inherently CSRF-safe.
    const token = getAuthToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  } else if (!isNative) {
    // PWA cookie-based session: needs CSRF token on state-changing requests
    // when the server has user management active. The token is populated by
    // auth.js after /api/auth/me, and absent for unauthenticated / single-user
    // mode (in which case the server's CSRF middleware also skips the check).
    const csrf = localStorage.getItem('nt:csrf');
    if (csrf) h['X-CSRF-Token'] = csrf;
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
      _dlog(`[settings] pushing ${key}=${JSON.stringify(value)} to ${url}`);
      const res = await fetch(url, {
        method: 'PUT',
        credentials: 'include',
        headers: _authHeaders(),
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      _dlog(`[settings] pushed ${key} to server OK`);
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
    _dlog(`[settings] bulk pushing ${userPrefEntries.length} keys`);
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: _authHeaders(),
      body: JSON.stringify({ settings: bulkObj }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    _dlog(`[settings] bulk pushed ${userPrefEntries.length} keys OK`);
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

    // Write all to localStorage (PWA + native JS layer). Pass force=true so
    // the wl:setting event fires even when localStorage values match: this
    // is the post-logout-then-relogin case where in-memory stores were
    // re-initialized with defaults but the per-user-scoped localStorage
    // entries survived the logout. Without the forced dispatch, subscribed
    // components (Trace FAB, Wellness section, theme application, etc.)
    // never get woken up to re-read the now-correct values.
    //
    // CRITICAL: skip DEVICE_PREFS keys. These are local-only (form-factor or
    // hardware specific) and should never be overwritten by server values.
    // Stale rows can exist from before the device-pref filter was added on
    // the write path — without this filter every settings poll would
    // overwrite a phone's `sidebarPersistent: true` with the desktop's
    // `false`, and the persistent-sidebar toggle would silently turn off.
    for (const [key, value] of Object.entries(serverSettings)) {
      if (DEVICE_PREFS.has(key)) continue;
      DB.setSetting(key, value, true);
    }

    // Native: also mirror into the native SQLite user_settings table so the
    // WorkManager / background workers have access to fresh values. Mark as
    // 'synced' so the differential sync doesn't try to re-push them.
    // Same DEVICE_PREFS skip as the localStorage loop above.
    if (isNative) {
      try {
        const { dbUpsertSetting, dbMarkSettingsSynced } = await import('../lib/db-native.js');
        const keys = [];
        for (const [key, value] of Object.entries(serverSettings)) {
          if (DEVICE_PREFS.has(key)) continue;
          await dbUpsertSetting(key, value);
          keys.push(key);
        }
        if (keys.length) await dbMarkSettingsSynced(keys);
      } catch (e) {
        console.warn('[settings] native SQLite mirror failed:', e.message);
      }
    }

    _suppressSync = false;

    // After settings are written to localStorage, force-apply the theme
    // settings directly to the DOM. The reactive `$: applyAccentColor(…)`
    // in App.svelte only fires when Svelte sees the store value change —
    // if the in-memory store value matches what the server returned, the
    // reactive skips, leaving the document still styled with whatever was
    // applied previously (or defaults, on the post-login first-paint).
    // Calling apply* here guarantees the document picks up the right
    // values whether or not Svelte's reactive system fires.
    try {
      if (typeof window !== 'undefined') {
        const accent = DB.getSetting('accentColor', 'mint');
        const appearanceVal = DB.getSetting('appearance', 'system');
        applyAccentColor(accent);
        applyAppearance(appearanceVal);
      }
    } catch {}
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
      const next = DB.getSetting(key, defaultValue);
      const prev = get(store);
      // Only update if the value actually changed. Without this guard,
      // the 30s settings poll (loadServerSettings dispatches force=true
      // on every key) would re-set every store with identical values,
      // firing all subscribers, which makes reactive blocks like
      // `$: meals = $mealNames` re-evaluate and any in:transition'd
      // children flash on every poll.
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        store.set(next);
      }
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
export const language          = createSettingStore('language',          'en');
export const energyUnit        = createSettingStore('energyUnit',       'kcal');
export const mealNames         = createSettingStore('mealNames',        ['Breakfast','Lunch','Dinner','Snacks']);
export const goals             = createSettingStore('goals',            {});
export const goalTemplates     = createSettingStore('goalTemplates',    []);
export const calorieGoalMode   = createSettingStore('calorieGoalMode',   'fixed');  // 'fixed' | 'dynamic'
export const calorieGoalFactor = createSettingStore('calorieGoalFactor', 1.0);      // 0.80 | 1.00 | 1.20
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
export const diaryShowNotes         = createSettingStore('diaryShowNotes',          true);
// Activity logging (issue #3 — opt-in calorie-burn entry that offsets daily goal)
export const diaryShowActivity      = createSettingStore('diaryShowActivity',        false);
export const manualActivityPolicy   = createSettingStore('manualActivityPolicy',     'wearable_wins'); // 'wearable_wins' | 'manual_wins' | 'additive'
export const activityAutoEstimate   = createSettingStore('activityAutoEstimate',     false);
export const calorieAdjustFromActivity = createSettingStore('calorieAdjustFromActivity', false);

export const foodsShowCategories    = createSettingStore('foodsShowCategories',    true);
export const foodsShowLabels        = createSettingStore('foodsShowLabels',        true);
export const foodsShowNotes         = createSettingStore('foodsShowNotes',         true);
export const foodsShowThumbnails    = createSettingStore('foodsShowThumbnails',    true);
export const foodsShowYesterdayMeals= createSettingStore('foodsShowYesterdayMeals',true);
// Foods → Meals tab: per-section collapse state (only takes effect when both Yesterday and Saved
// sections are visible — i.e. yesterday has items + user is in pick mode). Default expanded.
export const foodsYesterdayCollapsed= createSettingStore('foodsYesterdayCollapsed',false);
export const foodsSavedCollapsed    = createSettingStore('foodsSavedCollapsed',    false);
// Sort order is per-tab so users can pick e.g. Recently Used for Foods (where
// they speed-log) and Alphabetical for Recipes (where they browse a curated
// library). Each defaults to 'alpha' to preserve the original behaviour.
export const foodsSort              = createSettingStore('foodsSort',              'alpha');
export const mealsSort              = createSettingStore('mealsSort',              'alpha');
export const recipesSort            = createSettingStore('recipesSort',            'alpha');

export const barcodeBeep            = createSettingStore('barcodeBeep',            false);
export const barcodeFlashlight      = createSettingStore('barcodeFlashlight',      false);
export const cropPhotos             = createSettingStore('cropPhotos',             false);
// OFF search is enabled by default — it's the public crowd-sourced food
// database and the primary search source. Users who don't want their queries
// hitting OFF servers (privacy / offline-first) can disable it.
export const offEnabled             = createSettingStore('offEnabled',             true);
export const offSearchLanguage      = createSettingStore('offSearchLanguage',      'en');
export const offSearchCountry       = createSettingStore('offSearchCountry',       'World');
export const offUploadCountry       = createSettingStore('offUploadCountry',       'Auto');

export const accentColor = createSettingStore('accentColor', 'mint');

/** Apply accent color — supports named presets and custom hex (#rrggbb) */
// Track what's currently applied so periodic re-applies (every 30s settings
// poll, on tab visibilitychange, after login) don't unnecessarily mutate the
// DOM and cause a visible flash. Only the first call OR a real change does
// the work.
let _lastAppliedAccent = null;
export function applyAccentColor(value) {
  if (value === _lastAppliedAccent) {
    accentColor.set(value);
    return;
  }
  _lastAppliedAccent = value;
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
let _lastAppliedAppearance = null;
export function applyAppearance(value) {
  if (value === _lastAppliedAppearance) {
    appearance.set(value);
    return;
  }
  _lastAppliedAppearance = value;
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
export const statsIncludeToday = createSettingStore('statsIncludeToday', false);
// Show every date in the chart's range, even days with no logged value.
// Default ON: an empty day is more honest than a hidden one — gaps in logging
// are visible and the chart can't accidentally make a sparse week look full.
export const statsShowEmptyDays = createSettingStore('statsShowEmptyDays', true);

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

// Wellness (Activity Tracking)
export const wellnessEnabled    = createSettingStore('wellnessEnabled',    false);
export const fitbitEnabled      = createSettingStore('fitbitEnabled',      false);
export const healthConnectEnabled = createSettingStore('healthConnectEnabled', false);
export const wellnessMetrics    = createSettingStore('wellnessMetrics',    null); // null = all visible
export const workoutsEnabled   = createSettingStore('workoutsEnabled',   false); // show workout history + GPS maps in Movement tab
// Legacy shared sync settings (kept for backward compat — new code uses per-device below)
// wellnessSyncRange remains as the shared "how many days back" setting
// across all wellness sources. Per-source sync mode/interval moved to
// fitbitSync*/withingsSync*/garminSync*/healthConnectSync* in v0.30+.
export const wellnessSyncRange    = createSettingStore('wellnessSyncRange',    7);

// Per-device sync settings:
//   mode: 'auto' | 'scheduled' | 'manual'
//   interval: minutes between syncs (30, 60, 120, 180, 360, 720, 1440)
//   windowStart / windowEnd: 'HH:MM' — active sync window (null = all day)
// null values = fall back to legacy wellnessSync* (migration path for existing users)
export const fitbitSyncMode         = createSettingStore('fitbitSyncMode',         null);
export const fitbitSyncInterval     = createSettingStore('fitbitSyncInterval',     null); // minutes
export const fitbitSyncWindowStart  = createSettingStore('fitbitSyncWindowStart',  null); // 'HH:MM' or null
export const fitbitSyncWindowEnd    = createSettingStore('fitbitSyncWindowEnd',    null);

export const withingsEnabled      = createSettingStore('withingsEnabled',      false);
export const withingsSyncRange    = createSettingStore('withingsSyncRange',    7);
export const withingsSyncMode         = createSettingStore('withingsSyncMode',         null);
export const withingsSyncInterval     = createSettingStore('withingsSyncInterval',     null);
export const withingsSyncWindowStart  = createSettingStore('withingsSyncWindowStart',  null);
export const withingsSyncWindowEnd    = createSettingStore('withingsSyncWindowEnd',    null);

export const garminEnabled   = createSettingStore('garminEnabled',   false);
export const garminSyncRange = createSettingStore('garminSyncRange', 7);
export const garminSyncMode         = createSettingStore('garminSyncMode',         null);
export const garminSyncInterval     = createSettingStore('garminSyncInterval',     null);
export const garminSyncWindowStart  = createSettingStore('garminSyncWindowStart',  null);
export const garminSyncWindowEnd    = createSettingStore('garminSyncWindowEnd',    null);

export const healthConnectSyncMode         = createSettingStore('healthConnectSyncMode',         null);
export const healthConnectSyncInterval     = createSettingStore('healthConnectSyncInterval',     null);
export const healthConnectSyncWindowStart  = createSettingStore('healthConnectSyncWindowStart',  null);
export const healthConnectSyncWindowEnd    = createSettingStore('healthConnectSyncWindowEnd',    null);

// Sharing
export const defaultFoodVisibility = createSettingStore('defaultFoodVisibility', 'private'); // 'private' | 'group' | 'specific'

// AI Assistant (Trace)
export const aiEnabled       = createSettingStore('aiEnabled',       false);
export const aiProvider      = createSettingStore('aiProvider',      'claude');
export const aiApiKey        = createSettingStore('aiApiKey',        '');
export const aiModel         = createSettingStore('aiModel',         '');
// Base URL for the OpenAI-compatible (custom) provider — Ollama, LM Studio,
// LocalAI, vLLM, llama.cpp's server, DeepSeek, Groq, Together AI, Mistral La
// Plateforme, etc. Stored as a setting so users can point at any
// /v1/chat/completions-compatible endpoint without rebuilding the app.
export const aiBaseUrl       = createSettingStore('aiBaseUrl',       '');
export const aiAssistantName = createSettingStore('aiAssistantName', 'Trace');

// One-time migration: existing installs that never customized the assistant
// name end up with 'FitBot' (the old default). Bump those to 'Trace' so the
// rename is visible without manual action. Users who picked their own name
// (anything other than literal 'FitBot') are left alone.
try {
  if (DB.getSetting('aiAssistantName', null) === 'FitBot') {
    DB.setSetting('aiAssistantName', 'Trace');
  }
} catch {}
// Quick Log — natural-language food entry powered by the assistant's AI provider.
// Off by default (experimental). Only usable when aiEnabled is true.
export const quickLogEnabled  = createSettingStore('quickLogEnabled',  false);
export const aiGoalInsights   = createSettingStore('aiGoalInsights',   false);

// Notifications
export const notifLocalEnabled     = createSettingStore('notifLocalEnabled',     true);
export const notifPushService     = createSettingStore('notifPushService',     'none'); // 'none' | 'gotify' | 'ntfy' | 'apprise'
export const notifWaterReminders  = createSettingStore('notifWaterReminders',  false);
export const notifWaterInterval   = createSettingStore('notifWaterInterval',   120); // minutes
export const notifMealReminders   = createSettingStore('notifMealReminders',   false);
export const notifMealTimes       = createSettingStore('notifMealTimes',       ['08:00','12:00','18:00']); // HH:MM
export const notifGoalCelebrations = createSettingStore('notifGoalCelebrations', false);
export const notifStepGoal        = createSettingStore('notifStepGoal',        false);
export const notifWeighIn         = createSettingStore('notifWeighIn',         false);
export const notifWeighInTime     = createSettingStore('notifWeighInTime',     '07:00');
export const notifBedtime         = createSettingStore('notifBedtime',         false);
export const notifBedtimeTime     = createSettingStore('notifBedtimeTime',     '22:30');
export const notifBedtimeWindDown    = createSettingStore('notifBedtimeWindDown',    false);
export const notifBedtimeWindDownMin = createSettingStore('notifBedtimeWindDownMin', 30); // minutes before bedtime
export const notifBedtimeSmart    = createSettingStore('notifBedtimeSmart',    true);  // use last night's sleep to tailor message
export const notifWeeklySummary   = createSettingStore('notifWeeklySummary',   false);
export const weeklySummaryDay     = createSettingStore('weeklySummaryDay',     0);      // 0=Sun … 6=Sat
export const weeklySummaryTime    = createSettingStore('weeklySummaryTime',    '09:00');
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
