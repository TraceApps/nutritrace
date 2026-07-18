# Architecture

Orientation for new contributors. Covers the shape of the codebase,
the design decisions worth knowing before touching things, and the
house conventions that aren't obvious from reading the source.

## Stack

- **Frontend:** Svelte 4, svelte-spa-router v4 (hash routing), Vite
- **Server:** Node + Express, better-sqlite3
- **Mobile:** PWA + Capacitor 8 (Android)
- **Deploy:** `docker compose up -d`, serves on port 3000

## Layout

The important reads:

- `src/App.svelte`, root, `{#key $location}` destroys/recreates routes on nav
- `src/lib/api.js` (via `src/lib/apiFetch.js` interceptor), routes API calls between HTTP and native SQLite per platform
- `src/lib/db.js`, IndexedDB abstraction for PWA
- `src/lib/db-native.js`, on-device SQLite for Android local mode
- `src/lib/sync.js`, differential push/pull orchestrator for Android server mode
- `src/lib/aiChat.js`, multi-provider AI (Claude/OpenAI/Gemini) with tool-use loop
- `src/stores/diary.js`, `currentDate`, `currentEntry`, `diaryTotals`, mutations
- `src/stores/settings.js`, all settings as `createSettingStore` instances
- `src/routes/Diary.svelte`, main diary
- `src/routes/Foods.svelte`, food picker with source filters (Local / OFF / USDA / Mealie / From Others)
- `src/routes/Statistics.svelte`, charts page
- `src/routes/Wellness.svelte`, all wellness UI (metrics, sparklines, insights)
- `src/routes/Settings.svelte`, thin orchestrator, sections split into `src/components/settings/*.svelte`
- `server/routes/`, Express handlers, one file per entity

Everything else is discoverable with `grep` and `ls`.

## Key Design Decisions

Things you'd want to know before rewriting them.

### Routing re-mounts on nav

`{#key $location}` in App.svelte forces route components to
destroy/recreate on every nav so `onMount` fires fresh each time.
Intentional. Reordering or removing this breaks skeleton loaders and
the diary's `loadEntry(today)` on-mount pattern.

### `addDiaryItem` reads from DB, not `currentEntry`

Never relies on the in-memory `currentEntry` being current. Always
reads the latest state from the DB, mutates, writes back. Prevents
race conditions when the user is fast-switching dates.

### Settings auto-save with anti-feedback guards

Most settings save reactively via `$: set(key, value)`. Meal names
save on blur. The `_suppressSync` flag in the settings store prevents
a feedback loop when loading server settings back into Svelte stores.
A 10-second recently-changed protection window prevents server pull
from overwriting local changes. Settings write to SQLite immediately
(not debounced) on `.set()`. PWA polls server every 30s and on
`visibilitychange` for real-time sync.

### Wellness scores are client-calculated

Fitbit doesn't expose sleep score via its API, so it's estimated
server-side. Readiness and stress are calculated client-side from
30-day HRV and RHR baselines. Rebuild logic lives with the sparkline
components so the calculation is next to the display.

### Fitbit OAuth scopes

`activity heartrate sleep oxygen_saturation respiratory_rate cardio_fitness temperature profile location`.
`location` is required for TCX / GPS route data on workout logs.
Do not drop scopes when refactoring, users would silently lose
workout maps.

### AI Assistant tool use

The assistant (default name "Trace") uses function calling across all
providers (Claude, OpenAI, Gemini). Seven tools: `get_wellness_data`,
`get_body_composition`, `get_diary` (items + day notes + per-item
notes + brand), `get_workouts`, `get_goals`, `get_diary_averages`,
`get_meals` (saved Meals/Recipes library, cap 50). Execution loop
runs up to 5 rounds. System prompt instructs the AI to always use
tools to fetch real data rather than relying on context. See
`src/lib/aiChat.js`.

### Notifications: two delivery channels

Device notifications (`src/lib/notifications.js`) using Capacitor
local notifications on native or Web Notification API on PWA. Push
service channel (Apprise / Gotify / ntfy, one at a time). Device
reminders use `every: 'day'` for infinite repeat and re-schedule on
app open. Server scheduler (`server/lib/scheduler.js`) runs every 15
min, handles push reminders for PWA users, scheduled wellness sync,
and weekly summaries. Push delivery via `server/lib/push-notify.js`.
Goal celebrations cover every goal type (calories, protein, carbs,
fat, water, steps, sleep). Each goal fires at most once per day via
a `_celebratedToday` Set.

### Fuzzy food search

Local food/meal/recipe search uses edit-distance matching (tolerance
1 for words of at least 4 chars) after exact substring and
word-by-word checks. Implemented in `Foods.svelte` via `_fuzzyMatch()`
and `_editDist()` helpers. External source search (OFF / USDA)
unchanged.

### Bundle code-splitting

`vite.config.js` `manualChunks` splits `chart.js` into `charts`,
`jszip` into `jszip`, and `emoji-picker-element` into `emoji` as
separate async chunks loaded on demand. Keeps initial bundle lean.

### Statistics goal-line label

Labeled "Base Goal" instead of "Goal" when the metric is `calories`
and `calorieGoalMode === 'dynamic'`, to clarify the fixed reference
vs. adaptive daily goal.

### Password requirements

8+ characters with uppercase, lowercase, number, and special
character. Validated server-side in `server/routes/auth.js` and
client-side in Wizard, Profile, and the invite-accept flow.

## Android Local Mode

NutriTrace on Android runs **standalone (offline-only)** or
**server-connected** at the user's choice. First-launch wizard
picks the mode; Settings, then Mode, changes it later.

- **Mode toggle:** stored in Capacitor Preferences
- **Native API:** `src/lib/api-native.js` implements every server
  CRUD endpoint against local SQLite
- **Native DB:** `src/lib/db-native.js` mirrors server tables (foods,
  meals, diary, user_settings, workouts). Settings sync-queue helpers
  read/write 'pending' rows for eventual push
- **Merge on connect:** when connecting to a server with existing
  local data, a dialog lets the user push local foods / meals / diary
  to the server and choose which settings win (local or server)
- **Barcode scanning:** `@capacitor-mlkit/barcode-scanning` with
  Google Code Scanner fallback. Replaces the web QuaggaJS scanner on
  native
- **HTTP:** `CapacitorHttp.get()` for OFF / USDA API calls to bypass
  CORS restrictions that block `fetch()` inside the WebView
- **API routing:** every `fetch('/api/...')` call uses `apiUrl()` to
  prefix the server URL when in connected mode. In local mode, calls
  go to `NtApiNative` instead
- **Service worker disabled in Capacitor:** `src/registerSW.js`
  checks `isNative` and no-ops to prevent the offline.html redirect
  from intercepting WebView navigation
- **Settings gating in local mode:**
  - Server-only features hidden: User Management, Email / SMTP, Food
    Sharing, persistent sidebar, flashlight toggle, Full Backup
  - Fitbit / Garmin / Withings toggles show a disabled state (OAuth
    requires server for token exchange), with a pointer to Health
    Connect as the recommended alternative
  - Health Connect is the recommended path for local-only users
  - Gotify works in local mode via `CapacitorHttp` (no server proxy
    needed, bypasses CORS)
- **Mobile OAuth** (`src/lib/oauth-native.js`): Fitbit, Garmin, and
  Withings flows on Android open the system browser via
  `@capacitor/browser` instead of an in-app WebView. Callback via the
  `nutritrace://` deep link scheme
- **Mobile OIDC SSO** (server mode only): same
  `@capacitor/browser` pattern. `Login.svelte#startOidc()` opens the
  server callback which redirects to `nutritrace://oidc-callback/?token=<jwt>`
  (note the trailing slash, Chrome Custom Tabs needs it to dispatch
  the OS intent reliably)

## Svelte Reactivity Rules

- **Functions in templates:** Svelte only tracks dependencies that
  appear DIRECTLY in template expressions. Pass reactive values as
  explicit function parameters. Don't close over them.
- **`$:` reactive statements:** fire on mount AND on change. Don't
  add redundant `onMount` calls.
- **Async race guards:** capture the key before await, check it still
  matches after.

## Environment Variables

See `.env.example` for the full list. Key ones:

- `JWT_SECRET`, required for production (warns at startup if not set)
- `RECOVERY_TOKEN`, required for lockout recovery
- `LOG_LEVEL`, error / warn / info (default) / debug
- `SMTP_*`, optional, locks Settings UI fields when set
- `AI_*`, optional, locks AI Assistant settings when set

## Conventions

- **Cookie / storage prefix:** `wl_u<id>_<key>` (legacy from
  waistline; intentional)
- **Auth cookie:** `nutritrace_token`
- **Deep-link scheme:** `nutritrace://`
- **Android app id:** `com.nutritrace.app`
- **Comments:** state the non-obvious constraint or say nothing.
  Skip comments that restate the next line

## Build & Release

```bash
npm run dev                    # local dev server
npm run build                  # PWA build to dist/
npm run android:build          # vite build + cap sync android
npm run android:run            # build, sync, and install on connected device
npx cap open android           # open Android Studio for signing and debug
```

`android/keystore.properties` (gitignored) configures release
signing. Debug and release builds sign with the shared TraceApps
keystore so swapping between them doesn't trigger Android's
signature-mismatch reinstall (which wipes the local SQLite DB).

## Related Docs

- [`ROADMAP.md`](ROADMAP.md), what's planned, what's released
- [`CHANGELOG.md`](CHANGELOG.md), per-release notes
- [`CONTRIBUTING.md`](CONTRIBUTING.md), how to open a PR
- [`DEPLOY.md`](DEPLOY.md), full deployment guide
