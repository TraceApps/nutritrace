# NutriTrace — Future Implementations

Ideas and planned enhancements. Grouped by area. No commitment to order or timeline.
Items marked ~~strikethrough~~ have been implemented.

---

## Wellness — Reporting & Insights

### ~~Phase 1 — Trends tab~~ *(done — sparklines on each metric card)*

### ~~Phase 2 — Derived insights~~ *(done)*
- ~~Sleep debt — rolling 7/14/30-day deficit~~
- ~~Chronotype — early bird / night owl from average sleep midpoint~~
- ~~Daily Readiness score — HRV + RHR + sleep + activity penalty~~
- ~~Stress Management score — smoothed HRV + RHR + sleep~~
- ~~Sleep start/end stored as `sleep_start_min` / `sleep_end_min`~~

### Phase 3 — Dashboard / cross-domain correlation
A dedicated **Dashboard** page that correlates data across all domains (nutrition + activity + sleep + body stats).

- Widget grid — user-configurable
- Example widgets:
  - Sleep duration vs weight trend overlay
  - Steps vs net calories (burned – eaten)
  - "Best week" pattern summary
  - Today at a glance (streak tracker)

---

## Wellness — Additional Integrations

### ~~Garmin Connect~~ *(done — experimental, OAuth 1.0a)*
### ~~Withings~~ *(done — body comp, ECG, vascular age, metabolic age, EDA, segmental)*

### ~~Fitbit GPS / Activity Routes~~ *(done — TCX parsed via location OAuth scope, route map on workout detail)*

### ~~Google Health Connect (Android)~~ *(done — v0.35, see Phase 2 entry below)*

### Apple Health (iOS)
- Requires a native iOS wrapper (WebKit `WKWebView` + Swift bridge)
- Or: export-based import (Apple Health XML export → parse + ingest)

---

## Android App (Capacitor)

### ~~Phase 1 — Native shell + offline mode~~ *(done)*
- ~~Capacitor 8 wrapping Svelte PWA~~
- ~~Local SQLite via @capacitor-community/sqlite~~
- ~~NativeSetup wizard (Use Locally / Connect to Server)~~
- ~~Native barcode scanner (@capacitor-mlkit/barcode-scanning)~~
- ~~Native camera for food/meal/avatar photos~~
- ~~CapacitorHttp for OFF/USDA search (CORS bypass)~~
- ~~Platform detection (isNative, apiUrl, getServerUrl, getNativeMode)~~
- ~~Server connection with merge dialog~~
- ~~Service worker disabled in Capacitor~~
- ~~App icon at all mipmap densities~~

### Phase 2 — Sync & platform integrations
- ~~**Differential sync** — only push/pull changed records since last sync (timestamp-based), instead of full merge on every connect~~
- ~~**Offline cache in server mode** — mirror server data in local SQLite so the app works when server is down; sync diff when back online~~
- ~~**Health Connect integration**~~ *(done — shipped in v0.35; in production)*
- **Background sync** — periodic background task (via @capacitor/background-runner or WorkManager bridge) to sync diary/foods/wellness with server when connected
- ~~**Local full backup (ZIP)** — create full backup on device (JSZip) including images, for phone-to-phone transfer without a server~~ *(done — v0.35.2-beta)*
- **iOS app** — Capacitor already supports iOS; need HealthKit integration + App Store setup

### Phase 3 — Distribution
- **Obtainium** — list NutriTrace as an Obtainium-discoverable app so users can auto-track new GitHub Releases without checking manually. Requires the GitHub Releases page to consistently attach a signed APK with a stable filename pattern.
- **IzzyOnDroid F-Droid repo** — lower bar than F-Droid main (no reproducible builds required). Path to broader F-Droid eventually.
- **F-Droid main repo** — requires reproducible builds. Larger lift; defer until 1.0+ has had a few public releases.
- **Play Store** — gated on 1.0 GA. Needs developer account, listing assets (icon, screenshots, description), privacy policy URL, content rating, target SDK compliance.

---

## ~~Shared Food Database~~ *(done — Food Sharing, experimental)*
- ~~Visibility: private / group / specific users~~
- ~~Copy-on-use model for shared items~~
- ~~Bulk share from Settings~~
- ~~"From Others" source filter in Foods~~

---

## Diary Enhancements

### ~~Calorie budget bar in diary header~~ *(done — bottom bar with progress strip)*

### ~~Meal-level macro summary~~ *(done — per-meal P/C/F bar + text)*

### ~~Quick-log (voice / text)~~ *(done — Smart Log v3, hold Trace button; water logging added v0.38.2-beta)*

### ~~Dynamic Calorie Goal~~ *(done — v0.38.3-beta, Experimental)*
- ~~Fixed (current, default) vs Dynamic (device calories_out × factor)~~
- ~~Gate behind connected Fitbit/Garmin/Health Connect — hidden if no device~~
- ~~Factor: 0.80 (lose) / 1.00 (maintain) / 1.20 (gain)~~
- ~~Uses yesterday's final burn, falls back to fixed goal if no data~~
- ~~Touchpoints: diary bar (dynamic pill), goals page (badge + annotation)~~
- ~~Statistics goal line integration~~ *(done — v0.39.11, labeled "Base Goal" when dynamic mode is on)*

### ~~Adaptive TDEE~~ *(SHIPPED 2026-05-10, Experimental)*
- Server lib `server/lib/adaptive-tdee.js` runs the calc on demand from
  `GET /api/goals/adaptive-tdee`. 35-day rolling window, 21-day minimum
  for "ready"; weight series interpolated between known measurements
  (priority: Withings > Fitbit > Garmin > Health Connect, falls back to
  manual `body_stats.weight`); intake is sum of `diary.items` calories.
  Linear-regression slope × 7700 kcal/kg = daily energy balance;
  `tdee = avg_intake − balance`.
- Settings → Goals → Calorie Goal Mode is now a 3-way segmented control:
  Fixed | Dynamic | Adaptive. Goal factor (Lose / Maintain / Gain) applies
  to all three. Adaptive mode is selectable any time but falls back to
  the fixed goal until 21 valid days are collected.
- Goals page shows a readiness card with progress bar + the learned TDEE,
  trend (kg/week), confidence %, and weight source. "How it works"
  expander documents the math + best-practices ("weigh frequently,
  log consistently, don't switch goals mid-window, weigh at the same
  time of day"). README has a matching `## Adaptive TDEE` section.
- Diary bar + Statistics goal-line use the adaptive value when ready
  (📈 cue). Statistics labels the goal line "Base Goal" when in adaptive
  or dynamic mode, same as before.

### ~~Intermittent Fasting tracker — v1~~ *(SHIPPED 2026-05-10, opt-in)*
- Logged fasts on a new `fasts` table (user_id, start_at, end_at,
  goal_hours, soft-delete). CASCADE on user delete; included in
  differential sync via /api/sync/pull and push.
- Server endpoints under /api/fasts: start, /:id/end, GET list,
  GET /active, PATCH (edit start/goal/notes), DELETE (soft).
- src/stores/fasting.js exposes activeFast / fastHistory / elapsedMs
  stores + startFast/endFast/deleteFast/fastingStats helpers.
- FastingWidget.svelte on the Diary (above meals), opt-in via Settings
  → Diary → 'Show Fasting Tracker'. Three states: idle (14:10 / 16:8 /
  18:6 / 20:4 / OMAD / Custom hours picker), active (elapsed + progress
  bar + target end + End Fast), goal-reached (green styling + optional
  notification via existing notify('fastingNotifyOnGoal', ...) helper).
- FastingInsights.svelte at the bottom of Statistics — 4 stat tiles
  (avg / longest / current streak / longest streak) + 14-day mini-chart
  rendered with pure CSS bars (no Chart.js dep). Renders only when
  fastingEnabled is on.
- AI Trace gains get_fasting_history(days) tool, callable as
  "what's my fasting streak?" etc.
- Settings keys (USER_PREFS): fastingEnabled, fastingDefaultHours,
  fastingNotifyOnGoal.

### ~~Intermittent Fasting — v1.1 polish~~ *(SHIPPED 2026-05-10)*
- **Edit start time on active fast** — tap 'Started 8:32 PM' on the
  active widget; datetime-local picker calls PATCH /api/fasts/:id.
  Guarded against future times and >7 days ago.
- **Last-fast hint on idle state** — 'Last fast: 14.3h · ended 2h ago'
  under the title when at least one fast is in history and no fast
  is active.
- **Saved custom goal presets (max 3)** — name + bookmark-add inside
  the Custom mode; saved presets appear as inline chips alongside the
  built-in 14:10/16:8/18:6/20:4/OMAD chips. Long-press to remove.
  USER_PREFS adds fastingCustomPresets.
- **History with delete** — FastingInsights gets an expandable
  'Show Recent Fasts' list (last 20 completed fasts); per-row × button
  with confirm dialog removes via DELETE /api/fasts/:id (soft-delete).
- **Recurring schedule** — auto-starts a fast at a chosen time on
  selected days of week. Both client (FastingWidget mount +
  visibilitychange) and server scheduler (15-min tick) check
  independently; deconflicted via fastingScheduleLastFired (YYYY-MM-DD)
  + active-fast 409. 4-hour grace window so a late app-open doesn't
  backdate a missed early-morning schedule. USER_PREFS adds
  fastingScheduleEnabled, fastingScheduleTime, fastingScheduleDays,
  fastingScheduleGoal, fastingScheduleLastFired.

### Intermittent Fasting — deferred (possible future polish)
- **Food-window enforcement** — block or warn when the user logs food
  during an active fast. Currently the app stays neutral (the fast
  keeps running, food still logs). Opt-in toggle would be the safe
  shape so it doesn't paternalize. Plus a 'last meal in your eating
  window' awareness so the warning is contextual.
- **Goal-reached celebration polish** — currently the widget flips
  to green + a notification fires. Could add: a one-shot toast
  ('You hit your 16h goal — keep going or end?'), a haptic buzz on
  native via @capacitor/haptics, an optional sound chime. Same
  channel/styling as the existing goal-celebration confetti for
  nutrient goals — extending celebrateGoal() to cover fasting is the
  minimal change.
- **Auto-detect fasting from diary gaps** — infer a fast from the
  natural gap between yesterday's last logged meal and today's first.
  Clever but unreliable for users who skip breakfast vs. truly fast.
  Defer until / unless we have a way to distinguish 'forgot to log'
  from 'fasted'.
- **Day-of-week-specific goals** — different goal hours per weekday
  (e.g. 16:8 weekdays, 20:4 Sundays). Custom presets + manual start
  cover this today; automating it would interact awkwardly with the
  single recurring-schedule design — likely needs a per-day mini
  scheduler grid in Settings.
- **Multiple concurrent schedules** — eat-stop-eat (24h fast 2x/week)
  vs. daily 16:8 vs. occasional extended fasts. Current model is one
  recurring schedule. Could grow into 'fast templates' with multiple
  schedules pointing at named templates.
- **Live tile / lock-screen widget** — Android live-update widget
  showing elapsed time without opening the app. Capacitor doesn't
  expose AppWidget directly; would need a custom plugin.

### Saved Activities library
- Save commonly-logged activities (e.g. "Morning hike, 60 min, 300 kcal") as reusable templates
- Picker UI on the Activity sheet to choose a template, optionally edit before saving to diary
- Interim partial-coverage already shipped: name autocomplete from past entries (`<datalist>`) + Trace AI calorie estimation from name + duration
- Defer until multiple users specifically ask for the full library — autocomplete may already cover most of the value
- Originally requested by tellis82 in #12

---

## Foods / Nutrition

### ~~Fuzzy food search~~ *(done — v0.39.11, `_fuzzyMatch` + `_editDist` in Foods.svelte: exact substring → word-by-word → edit-distance ≤1 for words ≥4 chars; covers local foods, meals, recipes)*

### "Most Used" / "Recently Used" food sort
- Current Foods picker only sorts by Alphabetical or "Recently added" (= when the food row was created in the catalog, not by usage)
- Add `usage_count` and `last_used_at` columns on the `foods` table, increment on each `addDiaryItem`, backfill from existing diary items
- Expose two new options in Settings → Foods → Sort Order: "Most Used" and "Recently Used"
- Particularly valuable for users with large catalogs who repeatedly log the same handful of foods
- Originally requested by tellis82 in #12 (#6)

### Nutrient calculator overlay
- Select two foods → side-by-side comparison panel

### Recipe scaling from servings count
- Input "I want 6 servings" → auto-scale all ingredient quantities

### Nutrition CSV importer (v1 SHIPPED 2026-04-30, dev)
- v1 supports MyFitnessPal, LoseIt, Cronometer, and a generic
  spreadsheet shape. Adapters in `server/lib/nutrition-import/`,
  route at `/api/nutrition-import/{preview,commit}`, UI is
  `SettingsNutritionImport.svelte` mounted under Settings → Backup
  with an EXPERIMENTAL badge. Skip / Merge / Replace per-date
  semantics. Auto-detects locale (US M/D vs EU D/M), CSV
  delimiter (comma vs semicolon), and meal-name aliases; falls
  back to the user's last meal slot for unmatched labels.
- v2 candidates: **MacroFactor** (no published schema — needs real
  user export samples to pin against; ship as "experimental — bring
  your own export" once we have 2-3 samples), **FatSecret** (no
  user-facing CSV; would need OAuth API connector, separate
  feature), **YAZIO** (unverified schema — defer until a user
  sends a sample). Waistline import was deprioritized at user
  request (not a migration audience NT shares).
- Driving issue: community thread 2026-04-29.

### Bulk Food Import — paste JSON / upload CSV (SHIPPED on dev 2026-05-19)

Issue #21 (duplaja). Distinct from the Nutrition CSV importer above —
that one ingests **diary** entries from MFP/Cronometer/etc; this is for
adding **foods** to the user's catalog from a hand-rolled or LLM-
extracted source.

Shipped to dev: single entry point at Settings → Backup → "Bulk Import
Foods" (deliberately not added to the Foods page Add menu — see decision
note below). Source files: src/lib/food-import-template.js (template
generator), src/lib/food-import-parse.js (parser + validator),
src/components/foods/BulkImportModal.svelte (two-tab modal with
preview pane).

**Decision: single Settings-only entry point** (NOT also a Foods-page
Add menu item as originally drafted). Rationale: bulk import is
expected to be a once-or-twice-a-year operation per user; the Foods-
page Add button stays single-tap for the common case. Reversible — if
demand for a Foods-page shortcut shows up in feedback, adding one is a
~10 minute change.

**Why it's worth doing.** Users with foods that aren't on Open Food
Facts currently have to type each one into the Food Editor by hand.
With this they can snap a label photo, ask an LLM to extract the
nutrition into the documented schema, paste, and commit. Same flow
unlocks bulk-add for power users (CSV).

**Entry points** (single modal, two front doors):

1. **Foods page → Add menu → "Bulk Import (JSON/CSV)"** — primary,
   discoverable where users go to add foods.
2. **Settings → Backup → "Bulk Import Foods"** — secondary, for users
   who think of imports as a Settings thing.

**Modal layout:**

- Two tabs: **JSON** and **CSV**.
- Each tab has a **"Download Template"** link at the top.
- JSON tab: textarea (paste) plus a file-upload alternative.
- CSV tab: file upload (typing CSV by hand is no one's idea of fun).
- **Preview pane** below: parsed foods (name + calories + portion)
  rendered before commit, with row-level errors flagged.
- Submit only enables when everything parses.

**Template generation — CRITICAL DESIGN POINT:**

The template MUST be generated programmatically from the
`NUTRIMENTS` constant in `src/lib/nutrition.js` (the existing source
of truth for the app's nutrient catalog). DO NOT hard-code the
template — a future addition to NUTRIMENTS would silently leave the
template stale and the imported foods would lose those nutrients.

Implementation sketch:

```js
// src/lib/food-import-template.js
import { NUTRIMENTS } from './nutrition.js';
export function buildJsonTemplate() {
  const nutrition = Object.fromEntries(NUTRIMENTS.map(n => [n.id, 0]));
  nutrition.calories = 200; // example values for the demo row
  return {
    foods: [{
      name: 'Example Food', brand: 'Brand Name', barcode: '',
      portion: 100, unit: 'g', category: '',
      nutrition,
    }],
  };
}
export function buildCsvTemplate() {
  const headers = ['name','brand','barcode','portion','unit','category',
                   ...NUTRIMENTS.map(n => n.id)];
  const example = ['Example Food','Brand','',100,'g','',
                   ...NUTRIMENTS.map(n => n.id === 'calories' ? 200 : '')];
  return headers.join(',') + '\n' + example.join(',') + '\n';
}
```

**Schema (documented in the template + a /docs page):**

- Required: `name`, `nutrition.calories`
- Defaults: `portion=100`, `unit='g'`, other nutrients = 0 / null
- Per-row error messages so a bad row doesn't tank the whole import
- Dedup-by-barcode: if a row has a barcode that already exists for
  the user, mark as a skip (consistent with rc.21 rapid-scan dedup)

**Server side:** reuse the existing POST `/api/data/import` which
already accepts `foodList`. Optionally add a thin POST `/api/foods/bulk`
that returns inserted ids for the preview-pane round trip.

**Validation pass:**
1. Parse (JSON.parse or csv split with proper quote handling).
2. For each row: check `name` non-empty, `calories` numeric.
3. Coerce all nutrient values to Number (or 0 if blank).
4. Build summary: N rows valid, M rows skipped (duplicate barcode), K rows errored.
5. Render in preview pane. User clicks Commit → POST.

**Out of scope for v1:** image attachment per-row (would need URLs or
embedded base64), recipes/meals (foods only), edit-after-preview
(commit-as-shown).

**Driving:** Issue #21. Reporter has a userscript that already extracts
nutrition labels into JSON via an LLM; this would let them paste the
output directly.

### Local Open Food Facts data dump for offline barcode / name lookups (low priority, watch for demand)

Issue #22 (duplaja). Possible-but-not-planned. Would let self-hosters
in air-gapped or strict-egress environments do barcode + food-name
lookups against a locally-stored OFF dump instead of hitting the live
API. Same path would also keep barcode scanning useful during OFF
outages.

**Why this isn't in the near-term queue:**

- OFF bulk data is ~2-3 GB compressed, 10-15 GB raw. Serving it fast
  for barcode + name lookups means a real piece of infra (SQLite
  with FTS5 import, or embedded DuckDB to query the parquet directly).
- Nightly refresh logic — the dump changes daily; would need a
  cron-driven re-import to stay current, plus disk space for two
  copies during the swap.
- Today's OFF integration already proxies through the server, so the
  browser never talks to OFF directly. The "no outside API calls"
  concern is partially addressed at the network shape level.
- Audience is narrow: most self-hosters have internet egress; OFF
  outages are rare and short.
- The Bulk Food Import feature (queued above) covers "I want full
  control over my catalog without touching OFF" for users who curate
  their own foods, which is the more common shape of this request.

**If demand grows (3+ users asking), starting point:**

1. Admin setting in Settings → Connected Services → Open Food Facts:
   "Local OFF dump path" (filesystem path to a parquet or pre-imported
   SQLite file).
2. Import script (or in-process via worker) that reads the parquet
   subset (just the columns we use: code, product_name, brands,
   nutriments, image URLs) and writes to a dedicated `off_local`
   SQLite database with FTS5 on product_name + brands.
3. Lookup flow: check `off_local` first; fall back to live API if the
   barcode isn't found AND the admin allows it.
4. Refresh mechanism: nightly cron OR a manual "Refresh OFF dump"
   button in admin Settings.
5. Bundle a Python script for stripping the dump to just the columns
   we use (the reporter suggested this).

---

## Goals

### Rolling weekly / monthly goals
- Option to track goals over a week or month period, not just daily
- Useful for intermittent fasting or flexible dieting approaches

### ~~AI-suggested goal adjustment~~ *(done — v0.38.4-beta, Goal Insights toggle in Settings → AI Assistant)*

---

## Statistics

### Body composition chart
- Weight / body fat % / muscle mass plotted together (Withings data available)

### ~~Weekly summary email~~ *(done — v0.38.5-beta, configurable day/time, push + email)*

---

## AI Assistant (Trace)

### Food photo logging via Trace chat — auto-pipe to Smart Log
- *Image attachments to Trace chat already shipped* — users can attach a meal photo and Claude/GPT-4o vision identifies foods + estimates portions in plain text reply.
- **Still pending:** intercept a vision response that looks like a food list, pipe it into the Smart Log matcher, and open the Smart Log review modal for confirmation before adding to diary. Reuses existing Smart Log infra; no new UI needed beyond what Trace chat already supports.

### Local / self-hosted LLM support (post-1.0, high priority)
Add a generic **OpenAI-compatible** provider option in `src/lib/aiChat.js` that accepts a custom base URL + model name (no API key required). Covers Ollama, LocalAI, LM Studio, vLLM, llama.cpp's server, and anything else exposing the OpenAI `/v1/chat/completions` schema in one shot — don't hardcode "Ollama" specifically.

Why it matters: closes the privacy story. PRIVACY.md currently has to say "your conversation goes to Claude/OpenAI/Gemini." With a local LLM enabled, *nothing leaves the user's network*. The self-hosted-nutrition-tracker audience overlaps heavily with the homelab/self-hosted-LLM crowd, so this reads as a feature, not a hassle.

Implementation notes / caveats to document:
- **Tool-use reliability varies by model.** The existing AI Assistant uses tool calls heavily (`get_diary`, `get_wellness_data`, etc.). Llama 3.1+ and Mistral handle them reasonably; smaller / older models silently break tool calls.
- Either gate Goal Insights + Smart Log behind a "model supports tools?" capability detection that falls back to text-only, OR document which local models we've verified and warn in Settings.
- Vision (food-photo logging) requires a multimodal local model — even more model-dependent. Keep image attachments hidden for local provider unless model is known multimodal.
- Set expectations honestly in the Settings UI: "Local models trade convenience for privacy — quality and tool reliability vary by model."

When this ships, update PRIVACY.md "Third-Party Services" entry for AI Providers to note the local-LLM option ("if configured, your conversation never leaves your network").

---

## UI / UX Polish

### ~~Empty-state polish~~ *(done — contextual empty states across Diary, Foods, Goals, Wellness, MealEditor, Settings; Foods + Statistics empty-state messages added v0.39.11)*

### Error visibility / sync status
- Sync errors (failed server push, offline, conflict) are silent — no user-visible feedback
- Add a subtle status indicator (pill or icon near the top) that shows last sync time and surfaces errors with a tap-to-retry action
- Especially useful on Android where background sync can fail quietly

### Accessibility
- ActionSheet: add `role="dialog"` and focus trap
- Form inputs: explicit `<label>` associations throughout
- MealEditor name field: `<div>` → `<label>` element

### Diary loading indicator
- Subtle spinner or opacity change on date navigation when network is slow

### ~~Water log editing~~ *(done — v0.38.1-beta)*

---

## Internationalization (i18n)

Currently English-only. UI strings are hardcoded throughout the Svelte components, so translation contributions are not yet possible. Asked about by Lemmy users early in the launch window, so worth landing reasonably soon.

Implementation sketch:
- Add `svelte-i18n` (de-facto choice for Svelte 4) and a `src/i18n/` directory with one JSON file per locale (`en.json`, `fr.json`, etc.).
- Extract all hardcoded strings to keys. Largest surface areas: `Diary.svelte`, `Foods.svelte`, `Wellness.svelte`, `Settings.svelte` (+ split sub-components), `MealEditor.svelte`, `FoodEditor.svelte`, ActionSheets, error toasts.
- Locale picker in Settings → Appearance, persisted via `createSettingStore` like theme. Default to browser locale on first load with English fallback.
- Date / number formatting via `Intl.DateTimeFormat` and `Intl.NumberFormat` (already platform-native, no extra deps). Audit existing date strings for hardcoded `en-US` style.
- Pluralization via svelte-i18n message format (ICU-style).
- Server-side strings (email subjects, push notification bodies, AI system prompts) stay English for now, or take a separate pass once the client side is stable.

Translation contribution path:
- Self-host **Weblate** alongside the demo instance, or use the free tier on `hosted.weblate.org` for libre projects. Weblate is the standard in the self-hosted scene (Mealie, Immich, Paperless-ngx all use it) and lowers the bar for non-developer translators.
- PR-based fallback: contributors copy `en.json` to `<lang>.json` and submit a PR. Document the workflow in `CONTRIBUTING.md`.
- Seed initial languages from community requests on Lemmy / GitHub issues. Don't pre-translate machine-only — wait for actual native speakers per language to avoid uncanny-valley UX.

Scope explicitly out:
- User-entered data (food names, notes, meal names) stays as-is. NutriTrace doesn't translate user content.
- OFF/USDA food names come from those upstreams in their own languages already.

Likely v1.1 or v1.2 feature. Doing this *before* v1.0 risks delaying launch and locking the string set before the surface settles.

---

## Code / Performance

### ~~Settings.svelte split~~ *(done — v0.39.11, 5 sub-components: SettingsWellness, SettingsTrace, SettingsNotifications, SettingsUserManagement, SettingsBackup. Settings.svelte dropped to ~1700 lines as a thin orchestrator)*

### ~~Statistics dynamic goal line~~ *(done — v0.39.11, see Diary Enhancements → Dynamic Calorie Goal entry above)*

### ~~Bundle code splitting~~ *(done — v0.39.11, `manualChunks` in vite.config.js splits chart.js, jszip, emoji-picker-element into separate async chunks loaded on demand)*

---

## Infrastructure

### ~~Reverse proxy / subpath support~~ *(done — `BASE_URL` env var, see DEPLOY.md → Reverse Proxy with Subpath)*
- Native subpath support via `BASE_URL=/your-prefix`. Server mounts everything under the prefix, client reads it from `__NT_CONFIG__` injected at HTML serve time, all asset/API URLs prefix at runtime.
- Requested in #3 (tellis82). Verified locally end-to-end in both root and subpath modes (image upload, settings persistence, OAuth flow ready, service worker scope, PWA install).
- Default `BASE_URL=''` keeps existing root-mounted deployments unchanged — no migration for current users.
- Caveat: changing `BASE_URL` after data exists leaves stale image URLs in old diary item snapshots (the snapshotted `imgUrl` carries the prefix from when it was logged). Documentation in DEPLOY.md notes this as "pick at install time and don't change."

### Multi-instance sync (optional cloud relay)
- For users running NutriTrace on multiple devices without a central server
- Lightweight CouchDB-style sync (or manual export/import trigger)

### API key scoping
- Per-integration API key management (read-only, write, admin)
- Useful for third-party dashboards or Home Assistant integrations

### Metrics / observability
- Optional Prometheus endpoint (`/api/metrics`): request count, DB query times, sync success/fail
- Admin-only; opt-in via env var

### Dependency major-version upgrades

Tracked separately because each one is its own migration project, not a
batch. Policy is: only bump on CVE, EOL of current major, or concrete
benefit worth the cost (see memory `feedback_nutritrace_dep_bumps.md`).
Survey done 2026-05-20 audit.

**Strong candidates** — SHIPPED 2026-05-20:

- **Svelte 4 → 5** + **Vite 5 → 6** + **plugin-svelte 3 → 5** +
  **vite-plugin-pwa 0.19 → 1.0**. Compat-mode migration (legacy `$:`,
  stores, `on:click`, `<slot>` still work). Main bundle 1565 KB → 1211
  KB (~22% smaller). `svelte.config.js` pins `compilerOptions.runes:
  false` and `compilerOptions.compatibility.componentApi: 4` so Svelte
  5 keeps treating the codebase as Svelte 4 — without those, `$:`
  reactives in App.svelte get auto-promoted to `$effect()` and throw
  `effect_orphan` during component construction, which surfaces as the
  misleading "Database Error" fallback in `main.js`. `svelte-spa-router`
  held on 4.0.2 (v5 forces runes mode everywhere). Vite kept on 6
  rather than 7/8 — smallest step plugin-svelte 5 accepts. Per-component
  runes opt-in via `<svelte:options runes />` when a file is ready.
- **Express 4 → 5**. Native async/await error handling, updated
  path-to-regexp v8. One wildcard route in `server/index.js` rewritten
  from `router.get('*')` to `router.get('/{*splat}')` (v8 rejects
  unnamed wildcards). No `req.params[0]` rewrites needed.
- **bcryptjs 2 → 3**. Drop-in — only `hashSync` / `compareSync` were
  used, both unchanged in 3.x. Existing 2.x hashes verify cleanly
  under 3.x (same algorithm, same on-disk format).

**Borderline** — only if there's an itch:

- **openid-client 5 → 6**. Complete rewrite, cleaner API, more
  spec-compliant. Current code works fine. Defer unless we're
  iterating on OIDC.

**Skip** unless something changes:

- **better-sqlite3 9 → 12** — Node-compat bumps, no NT-specific gain.
- **multer 1.4.5-lts.1 → 2** — LTS still gets sec patches; v2 has
  breaking error/metadata shape changes for marginal gain.

Audit cadence: see memory `project_nutritrace_dep_audit.md` (monthly
`npm audit` + targeted bumps).

### ~~OIDC / SSO support (Authentik, Keycloak, Authelia, etc.)~~ *(SHIPPED in v1.0.0-rc.9)*
Settings → User Management → OIDC providers. Multi-provider, admin-managed (not env-only), client secrets encrypted at rest, auto-link verified-email + auto-register-new-users split toggles, admin role mapping via group claims, runtime password-login disable for OIDC-only instances. Provider preset picker covers Authentik / Keycloak / Pocket ID / Authelia / Auth0 / Google / Custom. Profile → Linked accounts to attach SSO to an existing password account.

### ~~Security hardening~~ *(done)*
- ~~Rate limiting on auth endpoints (10/15min)~~
- ~~CORS middleware with allowed origins + Authorization header~~
- ~~Password complexity (8+ chars, uppercase/lowercase/number/special)~~
- ~~JWT_SECRET startup warning~~
- ~~CSRF protection — synchronizer token in JWT; enforced on cookie-based sessions; Bearer token requests exempt~~

---

## Authentication — Biometric re-auth

### ~~Android biometric sign-in~~ *(SHIPPED 2026-05-10)*
- Plugin: @aparajita/capacitor-biometric-auth (static import required —
  dynamic import silently fails to register the native bridge on Android,
  same gotcha as @capacitor/local-notifications).
- `src/lib/biometric.js` wraps isAvailable / getStatus / authenticate /
  saveTokenForBiometric / readSavedToken / clearSavedToken. Token stored
  in WebView localStorage (already encrypted at rest by Android FBE
  since Android 7 — same threat model as the local SQLite cache).
- DEVICE_PREFS adds `biometricLoginEnabled` (per-device, never synced).
- Profile → Security shows a 'Sign In with Biometric' row in Android
  server-mode. Row hidden entirely on devices without biometric hardware;
  shown-but-disabled-with-hint when hardware exists but no fingerprint
  is enrolled in Android Settings. Toggling on triggers an immediate
  biometric verify + stashes the current JWT.
- Login.svelte adds a 'Sign In with Biometric' button below the password
  sign-in when a saved token exists. Tap → OS prompt → restore JWT →
  loadAuthState → push('/').
- Logout (auth.js#logout) wipes the saved token so an explicit sign-out
  can't be bypassed by biometric.

### PWA WebAuthn / Passkeys — still deferred
PWA-side biometric would use WebAuthn / Passkeys via the Credential
Management API. Requires server-side passkey registration / auth
endpoints (RP ID, challenge, attestation verification). Higher long-term
value since passkeys are phishing-resistant and survive password
rotation, but a much bigger lift than the Android plugin path.
Defer until there's enough PWA demand to justify the server-side infra.

---

## Engagement / Achievements (maybe-never)

A small, restrained set of cross-domain badges (Diary + Wellness) that
reinforce real behavior milestones, not trivia. Idea-stage only — may
not ever ship if it ends up feeling gamified or out of character for
the self-hosted/serious audience.

If we did ship it:
- 8–12 badges total, not 50. Resist the urge to add "logged your first
  food!" trivial ones.
- Opt-in via Settings toggle (likely default off). The app should feel
  adult/clean for users who don't want gamification.
- Surface in Profile as a "Trophies" panel — slow-burn record, not
  another in-the-moment popup. Goal Celebrations already cover the
  dopamine-hit moment; achievements would be the cumulative log.
- Candidate milestones (cross-domain, real-behavior):
  - Diary: 7/30/90/365-day logging streak, first 1000 unique foods
    logged, 30 days hitting protein goal, 30 days under TDEE
  - Wellness: 7 consecutive nights ≥80 sleep score, 30 days with HRV
    data, 7-day readiness ≥80 streak, first month with body stats
- Data model: single `achievements_unlocked` table with
  `(user_id, badge_id, unlocked_at)`. Server computes on goal-tick or
  daily wellness sync; cheap to evaluate and persist.

Tradeoff: gamification creep is the real risk. Too many badges or
too-easy unlocks turn the app into a kids' game. Self-hosted nutrition
trackers tend toward austere — most users would rather see a sparkline
than a trophy. Defer until after the v1.0 surface settles and we have
real user feedback on what (if anything) they ask for here.

---

## Post-1.0 follow-ups

- **Nutrition card filter behavior** — the per-meal totals popup and the day Nutrition Summary both respect the `diaryShowAllNutrients` toggle (default 9 nutrients vs all). Decide: should the per-meal popup ALWAYS show all available nutrients (since user opted in by tapping the macro bar) regardless of the toggle, or stay consistent with the day summary? Three options: (a) leave as-is, (b) always show all in the popup, (c) add an in-popup expand toggle. Defer the call until we have user feedback on what they reach for.

---

## Pre-1.0 Public Release — TODO

Items to land before flipping `traceapps/nutritrace` public and submitting to Play Store:

- ~~**Android network security lockdown**~~ *(done 2026-05-02)* — `android/app/src/main/res/xml/network_security_config.xml` is now strict (`cleartextTrafficPermitted="false"` + system + user CA trust). Debug-signed APKs get a permissive resource overlay at `android/app/src/debug/res/xml/` that re-enables cleartext for `http://192.168.x.x` LAN dev. `explainConnectError()` in `src/lib/platform.js` translates the cleartext-blocked failure into a friendly "this build only allows HTTPS" message pointing at DEPLOY.md. Documented in three places: README "Coming soon" Android line, new DEPLOY.md "Connecting from Android" section (covers Let's Encrypt, Cloudflare/Tailscale tunnels, self-signed CA install on device, and the build-it-yourself escape hatch), and the in-app error toast.
- ~~**Native SQLite encryption (revisit)**~~ *(decided 2026-05-02 — won't ship, position is "rely on Android FBE")* — SQLCipher integration via `@capacitor-community/sqlite` v8 was rolled back in v0.39.23 due to flaky `setEncryptionSecret` secure-store semantics that locked users out of their own data. After surveying comparable apps (Immich, Joplin, Obsidian, AnkiDroid, Mealie, Tandoor, Wger — none encrypt their local SQLite either), decided NutriTrace's threat model doesn't justify the operational risk. Android's file-based encryption (default since Android 7) already encrypts the app data directory using a key tied to the device PIN/biometric — a locked phone is encrypted at rest. PRIVACY.md "Local data at rest" section documents the position explicitly and corrects the previous misleading "encrypted SQLite database" claim.
- **Public demo instance** — host `demo.nutritrace.app` on the existing Oracle Cloud Always Free machine. Pattern (standard for self-hosted demos — Mealie, Penpot, Vikunja all do this): single shared instance, signup disabled, pre-seeded with a realistic sample week of foods/meals/diary/wellness, cron resets the DB every 6–24h. Implementation: `DEMO_MODE=1` env flag that (a) blocks signup, (b) auto-signs in as the demo user, (c) returns 503 from AI/SMTP/upload routes (don't burn API keys, don't email random addresses), (d) renders a sticky banner "DEMO — data resets daily, don't enter real info". Add `server/scripts/seed-demo.js` to wipe + reseed; cron via systemd timer on the Oracle box. Demo URL is the single biggest conversion lever for awesome-selfhosted submission and r/selfhosted launch posts — defer to just before launch so the demo shows the v1.0 surface, not a beta.
- **Sync to public repo** — run `nutritrace-dev-sync.sh` to land latest beta in `traceapps/nutritrace`.
- ~~**Pre-flight scrub**~~ *(done 2026-04-26 — full audit ran in v0.39.35-beta cycle: zero personal email/name leaks, `.env` properly gitignored, no hardcoded URLs/IPs in shipping files, all OAuth credentials user-configurable, sync script handles `thebigjoe1` → `traceapps` rewrites, Ko-fi handle migrated to `traceapps`)*
- **Discovery push** (post-flip) — submit to awesome-selfhosted, post to r/selfhosted with screenshots/demo link, submit to selfh.st newsletter, then Show HN a few weeks later once Reddit traffic stabilizes. AlternativeTo + Umbrel/CasaOS app store listings as secondary follow-ups. Prerequisites: demo instance live, 4–5 screenshots in README, v1.0.0 tag (curated lists shy away from beta).

---

## Repo Split — Public Server / Private Android

Current structure:
- `traceapps/nutritrace-dev` (private) — full monorepo with `android/`, used for development.
- `traceapps/nutritrace` (private, will go public at v1.0) — synced from `nutritrace-dev` minus `android/` via `nutritrace-dev-sync.sh`.
- `traceapps/nutritrace-android` (private) — standalone mirror of the Android shell.

Pre-flight before flipping `traceapps/nutritrace` public:
- Scrub for personal URLs, secrets, `.env` artifacts
- Scrub for personal references in comments
- Confirm AGPL-3.0 license file is present
- Run `nutritrace-dev-sync.sh` once more to land latest beta in the public repo

Sync model going forward: develop in `nutritrace-dev` as today, then ship release snapshots to `traceapps/nutritrace`. Each public release is a clean snapshot, not a daily commit log — CHANGELOG carries the version history.

---

*Last updated: 2026-04-28 (added: Internationalization section — svelte-i18n + Weblate path, prompted by Lemmy translation request; marked done: Reverse proxy / subpath support via BASE_URL env var, prompted by tellis82 issue #3 and verified locally end-to-end)*
