# NutriTrace — Project Reference

**App name**: NutriTrace
**Version**: See `src/lib/version.js` (centralized) — currently v0.39.35-beta
**Location**: `/home/papa/Documents/claude_code/nutritrace/`
**GitHub**: `git@github.com:traceapps/nutritrace-dev.git` (private monorepo)
**Stack**: Svelte 4, svelte-spa-router v4 (hash routing), Vite, SQLite (server), PWA
**Docker**: `docker compose up -d` → serves on port 3000

## Architecture

- **`src/main.js`** — Entry point. Calls `DB.init()` BEFORE mounting App.
- **`src/App.svelte`** — Root. `{#key $location}` destroys/recreates routes on nav. Checks `setupComplete` → wizard redirect.
- **`src/routes/Diary.svelte`** — Main diary. onMount calls `loadEntry(today)`.
- **`src/routes/Foods.svelte`** — Food picker with source filters (Local/OFF/USDA/Mealie/From Others).
- **`src/routes/Statistics.svelte`** — Charts page. `_loadVer` guard prevents stale loads.
- **`src/routes/Wellness.svelte`** — All wellness UI: metrics, sparklines, insights (readiness, stress, sleep debt, chronotype).
- **`src/routes/Settings.svelte`** (~1700 lines after split) — All settings. Large sections extracted to sub-components.
- **`src/components/settings/SettingsWellness.svelte`** — Fitbit/Withings/Garmin config, metric visibility.
- **`src/components/settings/SettingsTrace.svelte`** — AI Assistant settings (provider, model, API key, Smart Log, Goal Insights). Receives `envLocks` prop.
- **`src/components/ai/Trace.svelte`** — AI assistant chat panel + FAB (formerly `AIFitBot.svelte` until v0.39.35). Hold-to-record voice → Smart Log.
- **`src/components/ai/TraceFace.svelte`** — animated robot face SVG used everywhere the assistant is shown (formerly `FitBotFace.svelte`). Identical to LiftTrace's `TraceFace.svelte` for TraceApps brand cohesion.
- **`src/components/settings/SettingsNotifications.svelte`** — Device notifications, push service (Apprise/Gotify/ntfy), all reminders and alerts.
- **`src/components/settings/SettingsUserManagement.svelte`** — Profile, user list, invite, session, disable user mgmt, sign out. Exposes `loadData()`.
- **`src/components/settings/SettingsBackup.svelte`** — Full backup, JSON export/import, CSV export, danger zone. Exposes `loadFullBackups()` and `loadLocalBackups()`.
- **`src/stores/diary.js`** — `currentDate`, `currentEntry`, `diaryTotals`. `loadEntry`, `addDiaryItem`, etc.
- **`src/stores/settings.js`** — All settings as `createSettingStore` instances backed by localStorage + server sync.
- **`src/lib/db.js`** — IndexedDB abstraction.
- **`src/lib/version.js`** — Centralized `APP_VERSION` constant.
- **`server/lib/sharing.js`** — Shared `sharingEnabled()` and `canRead()` for foods/meals.

## Key Design Decisions

- **`{#key $location}`** in App.svelte: destroys/recreates route on every nav. `onMount` fires fresh.
- **`addDiaryItem` reads from DB**: never relies on `currentEntry` being current.
- **Settings auto-save**: most save reactively via `$: set(key, value)`. Meal names save on blur.
- **Wellness scores**: sleep score estimated server-side (Fitbit API doesn't expose it). Readiness and stress calculated client-side from 30-day HRV/RHR baselines.
- **Fitbit OAuth scopes**: `activity heartrate sleep oxygen_saturation respiratory_rate cardio_fitness temperature profile location` — `location` is required for TCX/GPS route data on workout logs.
- **AI Assistant tool use**: the assistant (default name "Trace") uses function calling (tool use) across all providers (Claude, OpenAI, Gemini). Seven tools: `get_wellness_data`, `get_body_composition`, `get_diary` (items + day notes + per-item notes + brand), `get_workouts`, `get_goals`, `get_diary_averages`, `get_meals` (saved Meals/Recipes library with optional name filter, cap 50). Execution loop runs up to 5 rounds. System prompt instructs AI to always use tools to fetch real data rather than relying on context. See `src/lib/aiChat.js`.
- **Settings sync feedback loop**: `_suppressSync` flag in the settings store prevents a feedback loop when loading server settings back into Svelte stores. A 10-second recently-changed protection window prevents server pull from overwriting local changes. Settings are written to SQLite immediately (not debounced) on `.set()`. PWA polls server every 30s and on `visibilitychange` for real-time sync.
- **Notifications architecture** (v0.32.0-beta): two delivery channels — device notifications (`src/lib/notifications.js`) using Capacitor local notifications on native or Web Notification API on PWA, and a push service channel (Apprise/Gotify/ntfy — one at a time). Device reminders use `every: 'day'` for infinite repeat and are re-scheduled on app open. Server scheduler (`server/lib/scheduler.js`) runs every 15 min: handles push reminders for PWA users, scheduled wellness sync, and weekly summaries. Push delivery is handled by `server/lib/push-notify.js` (renamed from `gotify.js`; now supports Apprise, Gotify, and ntfy). Native calls the push service directly via `CapacitorHttp`; PWA proxies through server `/api/notify`. Goal celebrations cover ALL goal types (calories, protein, carbs, fat, water, steps, sleep, etc.); each goal fires at most once per day via a `_celebratedToday` Set. No custom notification channel is needed — the default Capacitor channel works on all tested Android versions.
- **Fuzzy food search**: local food/meal/recipe search uses edit-distance matching (tolerance 1 for words ≥4 chars) after exact substring and word-by-word checks. Implemented in `Foods.svelte` via `_fuzzyMatch()` and `_editDist()` helpers. External source search (OFF/USDA) unchanged.
- **Bundle code splitting**: `vite.config.js` `manualChunks` splits chart.js → `charts`, jszip → `jszip`, emoji-picker-element → `emoji` into separate async chunks loaded on demand.
- **diary.notes**: `TEXT DEFAULT NULL` column on diary table. Editable day-level notes card at bottom of diary (toggleable via `diaryShowNotes` setting). Covered by full backup, JSON import, and differential sync. `saveDiaryNote()` in `src/stores/diary.js`.
- **Meal actions (⋮ menu)**: copy items to another meal, move items, copy meal to a different date, save as meal, clear all items. Accessed via ⋮ button on each meal header in Diary. State managed in `Diary.svelte` via `openMealActionSheet()`. Helpers in `src/stores/diary.js`: `copyMealItems`, `moveMealItems`, `clearMealItems`, `copyMealToDate`.
- **Statistics goal line**: labeled "Base Goal" instead of "Goal" when metric is `calories` and `calorieGoalMode === 'dynamic'`, to clarify the fixed reference vs. adaptive daily goal.

## Svelte Reactivity Rules

- **Functions in templates**: Svelte only tracks dependencies that appear DIRECTLY in template expressions. Pass reactive values as explicit function parameters — don't close over them.
- **`$:` reactive statements**: fire on mount AND on change. Don't add redundant `onMount` calls.
- **Async race guards**: capture the key before await, check it still matches after.

## Environment Variables

See `.env.example` for full list. Key ones:
- `JWT_SECRET` — required for production (warns at startup if not set)
- `RECOVERY_TOKEN` — required for lockout recovery
- `LOG_LEVEL` — error | warn | info (default) | debug
- `SMTP_*` — optional, locks Settings UI fields when set
- `AI_*` — optional, locks AI Assistant settings when set

## Password Requirements

8+ characters with uppercase, lowercase, number, and special character. Validated server-side in `server/routes/auth.js` and client-side in Wizard + Profile.

## Android App (Capacitor 8)

### Architecture
The Android app is a Capacitor 8 shell wrapping the same Svelte PWA. It runs offline-first with a local SQLite database, and can optionally connect to a NutriTrace server for sync.

- **Platform layer** (`src/lib/platform.js`): `isNative` detects Capacitor environment; `apiUrl()` returns empty string (local mode) or server URL (connected mode); `getServerUrl()` and `getNativeMode()` read from Capacitor Preferences.
- **Native API** (`src/lib/api-native.js`): `NtApiNative` class provides the same CRUD interface as the server API but backed by local SQLite. Used when `isNative && mode === 'local'`.
- **Native DB** (`src/lib/db-native.js`): SQLite schema and queries via `@capacitor-community/sqlite`. Mirrors server tables (foods, meals, diary, user_settings, workouts). Key helpers: `dbGetWellnessGrouped`, `dbGetWellnessByDate`, settings sync queue helpers (read/write 'pending' rows).
- **NativeSetup wizard**: shown on first launch. Offers "Use Locally" (pure offline) or "Connect to Server" (enter URL, authenticate, merge dialog for existing local data).
- **Merge on connect**: when connecting to a server with existing local data, a dialog lets the user push local foods/meals/diary to the server and choose which settings win (local or server).
- **Barcode scanning**: `@capacitor-mlkit/barcode-scanning` with Google Code Scanner fallback. Replaces the web QuaggaJS scanner on native.
- **Camera**: `@capacitor/camera` for food photos, meal photos, and avatar. Falls back to file input on web.
- **HTTP**: `CapacitorHttp.get()` for OFF/USDA API calls — bypasses CORS restrictions that block `fetch()` inside the WebView.
- **API routing**: every `fetch('/api/...')` call in the codebase uses `apiUrl()` to prefix the server URL when in connected mode. In local mode, these calls go to `NtApiNative` instead.
- **Service worker**: disabled when running inside Capacitor (`src/registerSW.js` checks `isNative`) to prevent the offline.html redirect from intercepting WebView navigation.
- **Settings in local mode**: 
  - Server-only features hidden: User Management, Email/SMTP, Food Sharing, persistent sidebar, flashlight toggle, Full Backup
  - Fitbit/Garmin/Withings toggles show disabled state with explanation message pointing to Health Connect as the recommended alternative (OAuth requires server for token exchange)
  - Health Connect is the recommended path for local-only users (works without a server, reads directly from Android Health Connect API)
  - Gotify works in local mode via `CapacitorHttp` (no server proxy needed, bypasses CORS)
- **Auth** (`src/stores/auth.js`): on native server mode, `loadAuthState()` returns cached user from localStorage immediately; `_fetchAuthFromServer()` runs in the background. No blocking server calls on startup.
- **Settings sync**: on Android, setting changes write to local SQLite `user_settings` (queued as 'pending'), attempt a direct PUT to server, and fall back to the differential sync engine. Server settings are pulled on sync and applied via `wl:setting` custom events.
- **Workout sync**: workouts are included in the differential sync pull. The local `workouts` table mirrors the server schema; GPS data is cached in `gps_data` after first view for offline access.
- **Wellness offline cache**: `Wellness.svelte` reads from local SQLite on native (all sources: fitbit, garmin, withings, health_connect). Listens for `nt:sync-complete` and reloads; manual source syncs trigger a differential pull before reload.
- **Mobile OAuth** (`src/lib/oauth-native.js`): Fitbit, Garmin, and Withings OAuth flows on Android open the system browser via `@capacitor/browser` instead of an in-app WebView. Callback is handled via the `nutritrace://` deep link scheme. AndroidManifest declares an intent filter for `nutritrace://callback`.
- **Mobile OIDC SSO** (server-mode only): same `@capacitor/browser` pattern as wellness OAuth. `Login.svelte#startOidc()` opens `apiUrl('/api/auth/oidc/login/<id>?mobile=1&return=…')`. Server callback redirects to `nutritrace://oidc-callback/?token=<jwt>` (note the slash — Chrome Custom Tabs needs it to dispatch the OS intent reliably). `App.svelte#appUrlOpen` listener intercepts, calls `setAuthToken(token)`, refreshes auth, navigates home. Native standalone mode hides SSO buttons (no server). AndroidManifest has a second `<data>` element for `nutritrace://oidc-callback`.
- **Permissions**: `POST_NOTIFICATIONS` and `SCHEDULE_EXACT_ALARM` are declared in AndroidManifest for local notification support.
- **LocalNotifications import**: must be a static import (`import { LocalNotifications } from '@capacitor/local-notifications'`). Dynamic import causes a `.then() is not a function` error on Android — do not change this to dynamic.

### Build & Run
```bash
# Prerequisites (env vars in ~/.bashrc):
#   JAVA_HOME, ANDROID_HOME, CAPACITOR_ANDROID_STUDIO_PATH

# Build the Svelte app for production
npm run android          # or: npm run build

# Sync web assets + plugins to the Android project
npx cap sync android

# Run on a connected device or emulator
npx cap run android --target <device-id>

# Open in Android Studio (for signing, debugging, etc.)
npx cap open android
```
