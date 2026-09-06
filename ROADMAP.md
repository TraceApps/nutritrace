# Roadmap

Ideas and planned enhancements. Grouped by area. No commitment to order or timeline.
Items marked ~~strikethrough~~ have been implemented.

---

## From README (moved 2026-07-27)

**Coming soon:**
- **Cross-domain Dashboard.** Configurable widgets that correlate nutrition, activity, sleep, and body stats (e.g. sleep duration vs weight trend).
- **PWA passkeys.** WebAuthn-based passwordless sign-in on the browser side, matching the biometric flow already live on Android.

**Future:**
- **iOS app.** Pending hardware and Apple Developer account access.

---

## Wellness: Reporting & Insights

### ~~Phase 1: Trends tab~~ *(done, sparklines on each metric card)*

### ~~Phase 2: Derived insights~~ *(done)*
- ~~Sleep debt, rolling 7/14/30-day deficit~~
- ~~Chronotype, early bird / night owl from average sleep midpoint~~
- ~~Daily Readiness score, HRV + RHR + sleep + activity penalty~~
- ~~Stress Management score, smoothed HRV + RHR + sleep~~
- ~~Sleep start/end stored as `sleep_start_min` / `sleep_end_min`~~

### Phase 3: Dashboard / cross-domain correlation
A dedicated **Dashboard** page that correlates data across all domains (nutrition + activity + sleep + body stats).

- Widget grid, user-configurable
- Example widgets:
  - Sleep duration vs weight trend overlay
  - Steps vs net calories (burned – eaten)
  - "Best week" pattern summary
  - Today at a glance (streak tracker)

---

## Wellness: Additional Integrations

### ~~Garmin Connect~~ *(done: experimental, OAuth 1.0a)*
### ~~Withings~~ *(done: body comp, ECG, vascular age, metabolic age, EDA, segmental)*

### ~~Fitbit GPS / Activity Routes~~ *(done: TCX parsed via location OAuth scope, route map on workout detail)*

### ~~Google Health Connect (Android)~~ *(done: v0.35, see Phase 2 entry below)*

### Apple Health (iOS)
- Requires a native iOS wrapper (WebKit `WKWebView` + Swift bridge)
- Or: export-based import (Apple Health XML export → parse + ingest)

### Gadgetbridge (direct integration): likely deferred
- Gadgetbridge is the Android FOSS app that talks to a long list of
  fitness trackers (Mi Band, Amazfit, Pebble, Bangle.js, Casio, older
  Fitbits, Huawei, Sony, etc.) without manufacturer accounts. Big match
  for NutriTrace's self-hosted ethos.
- **Already works via Health Connect today.** Gadgetbridge can write
  steps, heart rate, sleep, weight, and several other metrics to Health
  Connect; NutriTrace's existing Health Connect integration picks them
  up with zero code change. This is the recommended path and covers the
  "does it work with my Mi Band" case for the vast majority of askers.
  Document it in README + DEPLOY as the supported route.
- **Direct integration would buy access to data Health Connect doesn't
  carry** (full SpO2 history, device-specific metrics, raw activity
  segments). Three implementation options, all Android-only:
  - Intent broadcast listener, register a receiver for Gadgetbridge's
    broadcasts, write to wellness_data. ~3-5 days. Sparse data fidelity
    (broadcasts fire on events, not on backfill).
  - Shared SQLite read of Gadgetbridge's local DB, requires the
    user enabling shared storage + ongoing schema-version chasing as
    Gadgetbridge evolves. ~1-2 weeks plus maintenance tax.
  - OpenTracks-style intent contract, cleanest but requires
    Gadgetbridge to expose a stable surface they haven't committed to.
- **Hold unless multiple users specifically ask** for data the HC path
  can't deliver. The route-through-HC story is good enough that direct
  integration is hard to justify on cost / value.

---

## Android App (Capacitor)

### ~~Phase 1: Native shell + offline mode~~ *(done)*
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

### Phase 2: Sync & platform integrations
- ~~**Differential sync**: only push/pull changed records since last sync (timestamp-based), instead of full merge on every connect~~
- ~~**Offline cache in server mode**: mirror server data in local SQLite so the app works when server is down; sync diff when back online~~
- ~~**Health Connect integration**~~ *(done, released in v0.35; in production)*
- **Background sync**: periodic background task (via @capacitor/background-runner or WorkManager bridge) to sync diary/foods/wellness with server when connected
- ~~**Local full backup (ZIP)**: create full backup on device (JSZip) including images, for phone-to-phone transfer without a server~~ *(done, v0.35.2-beta)*
- **iOS app**: Capacitor already supports iOS; need HealthKit integration + App Store setup

### Phase 3: Distribution
- **Obtainium**: list NutriTrace as an Obtainium-discoverable app so users can auto-track new GitHub Releases without checking manually. Requires the GitHub Releases page to consistently attach a signed APK with a stable filename pattern.
- **IzzyOnDroid F-Droid repo**: lower bar than F-Droid main (no reproducible builds required). Path to broader F-Droid eventually.
- **F-Droid main repo**: requires reproducible builds. Larger lift; defer until 1.0+ has had a few public releases.
- **Play Store**: gated on 1.0 GA. Needs developer account, listing assets (icon, screenshots, description), privacy policy URL, content rating, target SDK compliance.

---

## ~~Shared Food Database~~ *(done: Food Sharing, experimental)*
- ~~Visibility: private / group / specific users~~
- ~~Copy-on-use model for shared items~~
- ~~Bulk share from Settings~~
- ~~"From Others" source filter in Foods~~

---

## Diary Enhancements

### ~~Calorie budget bar in diary header~~ *(done: bottom bar with progress strip)*

### ~~Meal-level macro summary~~ *(done: per-meal P/C/F bar + text)*

### ~~Quick-log (voice / text)~~ *(done: Smart Log v3, hold Trace button; water logging added v0.38.2-beta)*

### ~~Dynamic Calorie Goal~~ *(done: v0.38.3-beta, Experimental)*
- ~~Fixed (current, default) vs Dynamic (device calories_out × factor)~~
- ~~Gate behind connected Fitbit/Garmin/Health Connect, hidden if no device~~
- ~~Factor: 0.80 (lose) / 1.00 (maintain) / 1.20 (gain)~~
- ~~Uses yesterday's final burn, falls back to fixed goal if no data~~
- ~~Touchpoints: diary bar (dynamic pill), goals page (badge + annotation)~~
- ~~Statistics goal line integration~~ *(done, v0.39.11, labeled "Base Goal" when dynamic mode is on)*

### ~~Adaptive TDEE~~ *(RELEASED 2026-05-10, Experimental)*
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

### ~~Intermittent Fasting tracker: v1~~ *(RELEASED 2026-05-10, opt-in)*
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
- FastingInsights.svelte at the bottom of Statistics, 4 stat tiles
  (avg / longest / current streak / longest streak) + 14-day mini-chart
  rendered with pure CSS bars (no Chart.js dep). Renders only when
  fastingEnabled is on.
- AI Trace gains get_fasting_history(days) tool, callable as
  "what's my fasting streak?" etc.
- Settings keys (USER_PREFS): fastingEnabled, fastingDefaultHours,
  fastingNotifyOnGoal.

### ~~Intermittent Fasting: v1.1 polish~~ *(RELEASED 2026-05-10)*
- **Edit start time on active fast**: tap 'Started 8:32 PM' on the
  active widget; datetime-local picker calls PATCH /api/fasts/:id.
  Guarded against future times and >7 days ago.
- **Last-fast hint on idle state**: 'Last fast: 14.3h · ended 2h ago'
  under the title when at least one fast is in history and no fast
  is active.
- **Saved custom goal presets (max 3)**: name + bookmark-add inside
  the Custom mode; saved presets appear as inline chips alongside the
  built-in 14:10/16:8/18:6/20:4/OMAD chips. Long-press to remove.
  USER_PREFS adds fastingCustomPresets.
- **History with delete**: FastingInsights gets an expandable
  'Show Recent Fasts' list (last 20 completed fasts); per-row × button
  with confirm dialog removes via DELETE /api/fasts/:id (soft-delete).
- **Recurring schedule**: auto-starts a fast at a chosen time on
  selected days of week. Both client (FastingWidget mount +
  visibilitychange) and server scheduler (15-min tick) check
  independently; deconflicted via fastingScheduleLastFired (YYYY-MM-DD)
  + active-fast 409. 4-hour grace window so a late app-open doesn't
  backdate a missed early-morning schedule. USER_PREFS adds
  fastingScheduleEnabled, fastingScheduleTime, fastingScheduleDays,
  fastingScheduleGoal, fastingScheduleLastFired.

### Intermittent Fasting: deferred (possible future polish)
- **Food-window enforcement**: block or warn when the user logs food
  during an active fast. Currently the app stays neutral (the fast
  keeps running, food still logs). Opt-in toggle would be the safe
  shape so it doesn't paternalize. Plus a 'last meal in your eating
  window' awareness so the warning is contextual.
- **Goal-reached celebration polish**: currently the widget flips
  to green + a notification fires. Could add: a one-shot toast
  ('You hit your 16h goal, keep going or end?'), a haptic buzz on
  native via @capacitor/haptics, an optional sound chime. Same
  channel/styling as the existing goal-celebration confetti for
  nutrient goals, extending celebrateGoal() to cover fasting is the
  minimal change.
- **Auto-detect fasting from diary gaps**: infer a fast from the
  natural gap between yesterday's last logged meal and today's first.
  Clever but unreliable for users who skip breakfast vs. truly fast.
  Defer until / unless we have a way to distinguish 'forgot to log'
  from 'fasted'.
- **Day-of-week-specific goals**: different goal hours per weekday
  (e.g. 16:8 weekdays, 20:4 Sundays). Custom presets + manual start
  cover this today; automating it would interact awkwardly with the
  single recurring-schedule design, likely needs a per-day mini
  scheduler grid in Settings.
- **Multiple concurrent schedules**: eat-stop-eat (24h fast 2x/week)
  vs. daily 16:8 vs. occasional extended fasts. Current model is one
  recurring schedule. Could grow into 'fast templates' with multiple
  schedules pointing at named templates.
- **Live tile / lock-screen widget**: Android live-update widget
  showing elapsed time without opening the app. Capacitor doesn't
  expose AppWidget directly; would need a custom plugin.

### Saved Activities library
- Save commonly-logged activities (e.g. "Morning hike, 60 min, 300 kcal") as reusable templates
- Picker UI on the Activity sheet to choose a template, optionally edit before saving to diary
- Interim partial-coverage already released: name autocomplete from past entries (`<datalist>`) + Trace AI calorie estimation from name + duration
- Defer until multiple users specifically ask for the full library, autocomplete may already cover most of the value
- Originally requested by tellis82 in #12

### Meal Planning for multi-user households (deferred, trigger to build: 2+ user requests)

Lets one user pre-fill meals into another user's diary. Natural fit for
households where one person plans / preps for the family. Overlaps with
the coach-prescribes-meals pattern LiftTrace already echoes via
`coach_prescriptions`, so the family bones for this concept exist.

Two tiers, cut Tier 1 first if any of this happens at all:

**Tier 1, Push meal to another user's diary**
- One-time action. Pick a meal / recipe from your library, pick a user,
  pick a date and meal slot, send. Lands on the recipient's diary as a
  normal entry with a small "planned by &lt;you&gt;" badge so they see
  it wasn't theirs.
- Recipient can edit / delete just like their own entries; calorie +
  macro counts contribute to their goals the same way.
- New permission grant: "X can plan meals for Y" (per-pair, bidirectional
  opt-in). Pattern off LiftTrace's trainer-client model rather than a
  broad role.
- Server: new `planned_meals` table OR extend diary with a
  `planned_by_user_id` nullable column; POST `/api/diary` accepts a
  `target_user_id`.
- UI: "Send to user…" action in Meal kebab; permission grant in
  Settings → User Management; push notification on receive
  (`notifMealPlanned`, default on, toggleable).
- ~2-3 days of work. Self-contained, no schema migration for existing
  diary entries.

**Tier 2, Meal plan template** (only if Tier 1 lands well)
- 7-day grid: 7 days × 4 meals = 28 slots. Build the plan once, assign
  to users, optionally have it recur weekly.
- Mirrors LiftTrace's `program_assignments` table shape.
- New tables: `meal_plans` (id, name, owner_user_id, rows), `meal_plan_assignments`
  (plan_id, assigned_to_user_id, start_date, recurrence).
- Server: scheduler tick applies due plan entries to recipients' diaries
  the day they're due.
- UI: plan editor calendar grid + assignment manager.
- ~1 week of work. Bigger surface.

**Skipped tiers:**

- Coach / dietitian mode (multi-tenant client management, billing,
  notes per client, etc.) is its own product. Not in NT's scope.

**Open design questions for when this gets built:**

- Permission model granularity: per-pair grant vs broad "planner" role.
  Per-pair is more flexible, broad is simpler. Pattern off LiftTrace.
- Conflict resolution: if recipient logs their own food on a planned
  meal slot, do we merge, replace, or keep both? Default: keep both as
  separate diary items; recipient deletes manually if needed.
- Notification toggle: receiving user should be able to mute
  `notifMealPlanned` if a planner is over-eager.
- Goal interaction: pre-planned meals count toward goals the same way
  as self-logged. No special handling needed.

**Naming decision:**

Settle on **"Meal Planning"** for the user-facing label (generic,
MFP-familiar). Don't narrow to "Family" or "Household" since the
mechanism also serves the coach-pre-plans use case if someone wants
that workflow without us building Tier 3.

Originally proposed 2026-06-01 conversation. No issue filed yet.

---

## Foods / Nutrition

### ~~Fuzzy food search~~ *(done: v0.39.11, `_fuzzyMatch` + `_editDist` in Foods.svelte: exact substring → word-by-word → edit-distance ≤1 for words ≥4 chars; covers local foods, meals, recipes)*

### ~~"Most Used" / "Recently Used" food sort~~ *(done: `usage_count` and `last_used_at` columns on foods/meals, two new sort modes in the Foods picker, Android sync wiring fixed in rc.29. Originally tellis82 #12/#6.)*

### Nutrient calculator overlay
- Select two foods → side-by-side comparison panel

### Recipe scaling from servings count
- Input "I want 6 servings" → auto-scale all ingredient quantities

### ~~Nutrition CSV importer: v1~~ *(RELEASED, MyFitnessPal, LoseIt, Cronometer, generic-spreadsheet adapters)*
- v1 supports MyFitnessPal, LoseIt, Cronometer, and a generic
  spreadsheet shape. Adapters in `server/lib/nutrition-import/`,
  route at `/api/nutrition-import/{preview,commit}`, UI is
  `SettingsNutritionImport.svelte` mounted under Settings → Backup
  with an EXPERIMENTAL badge. Skip / Merge / Replace per-date
  semantics. Auto-detects locale (US M/D vs EU D/M), CSV
  delimiter (comma vs semicolon), and meal-name aliases; falls
  back to the user's last meal slot for unmatched labels.
- v2 candidates: **MacroFactor** (no published schema, needs real
  user export samples to pin against; cut as "experimental, bring
  your own export" once we have 2-3 samples), **FatSecret** (no
  user-facing CSV; would need OAuth API connector, separate
  feature), **YAZIO** (unverified schema, defer until a user
  sends a sample). Waistline import was deprioritized at user
  request (not a migration audience NT shares).
- Driving issue: community thread 2026-04-29.

### ~~Bulk Food Import: paste JSON / upload CSV~~ *(RELEASED to public in rc.28)*

Issue #21 (duplaja). Distinct from the Nutrition CSV importer above ,
that one ingests **diary** entries from MFP/Cronometer/etc; this is for
adding **foods** to the user's catalog from a hand-rolled or LLM-
extracted source.

Released to dev: single entry point at Settings → Backup → "Bulk Import
Foods" (deliberately not added to the Foods page Add menu, see decision
note below). Source files: src/lib/food-import-template.js (template
generator), src/lib/food-import-parse.js (parser + validator),
src/components/foods/BulkImportModal.svelte (two-tab modal with
preview pane).

**Decision: single Settings-only entry point** (NOT also a Foods-page
Add menu item as originally drafted). Rationale: bulk import is
expected to be a once-or-twice-a-year operation per user; the Foods-
page Add button stays single-tap for the common case. Reversible, if
demand for a Foods-page shortcut shows up in feedback, adding one is a
~10 minute change.

**Why it's worth doing.** Users with foods that aren't on Open Food
Facts currently have to type each one into the Food Editor by hand.
With this they can snap a label photo, ask an LLM to extract the
nutrition into the documented schema, paste, and commit. Same flow
unlocks bulk-add for power users (CSV).

**Entry points** (single modal, two front doors):

1. **Foods page → Add menu → "Bulk Import (JSON/CSV)"**: primary,
   discoverable where users go to add foods.
2. **Settings → Backup → "Bulk Import Foods"**: secondary, for users
   who think of imports as a Settings thing.

**Modal layout:**

- Two tabs: **JSON** and **CSV**.
- Each tab has a **"Download Template"** link at the top.
- JSON tab: textarea (paste) plus a file-upload alternative.
- CSV tab: file upload (typing CSV by hand is no one's idea of fun).
- **Preview pane** below: parsed foods (name + calories + portion)
  rendered before commit, with row-level errors flagged.
- Submit only enables when everything parses.

**Template generation, CRITICAL DESIGN POINT:**

The template MUST be generated programmatically from the
`NUTRIMENTS` constant in `src/lib/nutrition.js` (the existing source
of truth for the app's nutrient catalog). DO NOT hard-code the
template, a future addition to NUTRIMENTS would silently leave the
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

### ~~Local Open Food Facts data dump for offline barcode / name lookups~~ *(RELEASED: `server/lib/off-local.js` + `off-local-scheduler.js` run a local mirror with barcode + product-name lookups. Nightly refresh scheduled server-side. What's still open: none, item's original ask is fully covered.)*

Issue #22 (duplaja). Possible-but-not-planned. Would let self-hosters
in air-gapped or strict-egress environments do barcode + food-name
lookups against a locally-stored OFF dump instead of hitting the live
API. Same path would also keep barcode scanning useful during OFF
outages.

**Why this isn't in the near-term queue:**

- OFF bulk data is ~2-3 GB compressed, 10-15 GB raw. Serving it fast
  for barcode + name lookups means a real piece of infra (SQLite
  with FTS5 import, or embedded DuckDB to query the parquet directly).
- Nightly refresh logic, the dump changes daily; would need a
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

### ~~AI-suggested goal adjustment~~ *(done: v0.38.4-beta, Goal Insights toggle in Settings → AI Assistant)*

---

## Statistics

### Body composition chart
- Weight / body fat % / muscle mass plotted together (Withings data available)

### ~~Weekly summary email~~ *(done: v0.38.5-beta, configurable day/time, push + email)*

---

## AI Assistant (Trace)

### Food photo logging via Trace chat: auto-pipe to Smart Log
- *Image attachments to Trace chat already released*, users can attach a meal photo and Claude/GPT-4o vision identifies foods + estimates portions in plain text reply.
- **Still pending:** intercept a vision response that looks like a food list, pipe it into the Smart Log matcher, and open the Smart Log review modal for confirmation before adding to diary. Reuses existing Smart Log infra; no new UI needed beyond what Trace chat already supports.

### ~~Local / self-hosted LLM support~~ *(done: generic `oai-compat` provider in `src/lib/aiChat.js` accepting any OpenAI-compatible base URL, no API key required; covers Ollama, LocalAI, LM Studio, vLLM, llama.cpp. Megathread/README list this. Tool-use caveats stand: smaller local models silently break Goal Insights + Smart Log; documenting verified models is a follow-up.)*

---

## UI / UX Polish

### Shared NutritionFactsBox card: phased rollout
TraceApps brand cohesion: CookTrace already uses an FDA-style "Nutrition
Facts" card for pantry items (view layout) with a tap-Edit toggle that
swaps the card for an input-box form (edit layout). The pattern is
universally readable (mirrors physical packaging) and gives the
TraceApps family a recognizable shared component. Plan to roll it into
NutriTrace in phases so no single change carries too much blast radius.

**~~Phase 1, Photo log confirmation card~~** *(RELEASED rc.42, `NutritionFactsBox.svelte` in `src/components/ui/`, `propose_quick_calories` tool in `aiChat.js`, review card renders in Trace chat with Discard / Edit / Add to Diary)*
- Port CookTrace's `NutritionFactsBox.svelte` into NT as
  `src/components/ui/NutritionFactsBox.svelte`. Maintain visual parity
  with CookTrace; treat divergence as a bug.
- Add a new AI tool `propose_quick_calories` that returns a structured
  estimate (name, serving, kcal, macros) instead of writing to the
  diary. Used when the user attaches a meal image to Trace OR explicitly
  asks "log this, but review first."
- Trace.svelte renders the card inline in the chat thread when the
  tool fires, with three actions: Discard / Edit / Add to Diary.
  - Discard removes the card from the thread.
  - Edit flips to the input-box form variant (CookTrace pattern).
  - Add to Diary calls `log_quick_calories` with the (possibly edited)
    values, then collapses to a small "Logged X kcal to <meal>" row.
- System prompt rule: when a meal photo is attached, use
  `propose_quick_calories` instead of `log_quick_calories`. Never
  auto-write from a photo.

**~~Phase 2, Existing food detail view~~** *(RELEASED, `src/components/ui/FoodDetailSheet.svelte` renders the read-only card from the Foods list info-icon entry point; tap-to-log muscle memory preserved)*
- Add a read-only food-detail-view that renders the same card for any
  saved food. Reached via an info-icon entry point in the food list
  (not via direct tap, which stays the existing tap-to-log shortcut so
  the everyday flow stays fast).
- "Edit" button on the card flips to the existing FoodEditor form.
  "Add to Diary" routes to the existing quantity prompt.
- Inflexible default: tap on a food in the library still opens the
  quantity prompt as today. Don't break the muscle memory.

**Phase 3+, Meals / Recipes / Diary edit sheet** *(further out)*
- Roll out the same card pattern to Meals view, Recipes view, and the
  diary-item edit sheet (currently four-color macro pills). One surface
  per release, no big-bang.
- Stop at any phase if user response is mixed. The pattern is
  self-contained per surface.

**Why phased, not all at once**
- NT's everyday "tap food → log it" flow is fast and central; inserting
  a card view in the middle of it would slow the most-common interaction
  for marginal value beyond Phase 1.
- Each new surface is a real test-surface expansion; rolling one at a
  time keeps regressions traceable.
- CookTrace was built around the card from day one; NT users learned
  "tap = edit" since launch and switching them in one release is a
  jarring change. Phased rollout lets the new pattern land in a
  contained context (Phase 1's photo-log card) before becoming the
  default elsewhere.

### ~~Empty-state polish~~ *(done: contextual empty states across Diary, Foods, Goals, Wellness, MealEditor, Settings; Foods + Statistics empty-state messages added v0.39.11)*

### ~~Error visibility / sync status~~ *(done: offline `cloud_off` badge in the top-bar surfaces server-unreachable state; toast-on-retry for failed pushes)*

### Accessibility
- ActionSheet: add `role="dialog"` and focus trap
- Form inputs: explicit `<label>` associations throughout
- MealEditor name field: `<div>` → `<label>` element

### Diary loading indicator
- Subtle spinner or opacity change on date navigation when network is slow

### ~~Water log editing~~ *(done: v0.38.1-beta)*

---

## Internationalization (i18n)

Infrastructure landed: `svelte-i18n@4` in deps, `src/i18n/` with `en.json` + `fr.json` + `index.js`, ~210+ keys extracted. Locale picker under Settings → Regional & Units (bound to the `language` store). French translation contributed by @antoinech2 in rc.49 (PR #72). What's still pending: continued string extraction sweep as the UI surface grows (re-audit each release per `feedback_i18n_check.md`), Weblate hosted translation flow, and additional locales (Dutch + German volunteers noted in rc.6 but not yet landed).

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
- Seed initial languages from community requests on Lemmy / GitHub issues. Don't pre-translate machine-only, wait for actual native speakers per language to avoid uncanny-valley UX.

Scope explicitly out:
- User-entered data (food names, notes, meal names) stays as-is. NutriTrace doesn't translate user content.
- OFF/USDA food names come from those upstreams in their own languages already.

Likely v1.1 or v1.2 feature. Doing this *before* v1.0 risks delaying launch and locking the string set before the surface settles.

---

## Code / Performance

### ~~Settings.svelte split~~ *(done: v0.39.11, 5 sub-components: SettingsWellness, SettingsTrace, SettingsNotifications, SettingsUserManagement, SettingsBackup. Settings.svelte dropped to ~1700 lines as a thin orchestrator)*

### ~~Statistics dynamic goal line~~ *(done: v0.39.11, see Diary Enhancements → Dynamic Calorie Goal entry above)*

### ~~Bundle code splitting~~ *(done: v0.39.11, `manualChunks` in vite.config.js splits chart.js, jszip, emoji-picker-element into separate async chunks loaded on demand)*

---

## Infrastructure

### ~~Reverse proxy / subpath support~~ *(done: `BASE_URL` env var, see DEPLOY.md → Reverse Proxy with Subpath)*
- Native subpath support via `BASE_URL=/your-prefix`. Server mounts everything under the prefix, client reads it from `__NT_CONFIG__` injected at HTML serve time, all asset/API URLs prefix at runtime.
- Requested in #3 (tellis82). Verified locally end-to-end in both root and subpath modes (image upload, settings persistence, OAuth flow ready, service worker scope, PWA install).
- Default `BASE_URL=''` keeps existing root-mounted deployments unchanged, no migration for current users.
- Caveat: changing `BASE_URL` after data exists leaves stale image URLs in old diary item snapshots (the snapshotted `imgUrl` carries the prefix from when it was logged). Documentation in DEPLOY.md notes this as "pick at install time and don't change."

### Multi-instance sync (optional cloud relay)
- For users running NutriTrace on multiple devices without a central server
- Lightweight CouchDB-style sync (or manual export/import trigger)

### API key scoping
- **Phase 1 RELEASED**: federation API at `/api/v1/*`, `nt_pat_*` token format, SHA-256 hashed at rest. `SettingsApiTokens.svelte` for management, `server/lib/api-tokens.js` + `server/middleware/bearer-auth.js` for issuance + validation. See `docs/federation.md`.
- **Registered scopes today:** `read:foods` (CT federation), `write:workouts` (LT federation), `write:body-measurements`, `mcp:read` / `mcp:write` / `mcp:destroy` (MCP server, v1.2.0-dev01). Each scope was added alongside the routes that consume it, matching the "add scopes when the endpoint lands" policy.
- **Still deferred:** `read:meals`, `read:diary`, `admin:*`. Gated on the endpoints they'd unlock; add when a real consumer needs them.
- Useful for third-party dashboards or Home Assistant integrations.

### Metrics / observability
- Optional Prometheus endpoint (`/api/metrics`): request count, DB query times, sync success/fail
- Admin-only; opt-in via env var

### Dependency major-version upgrades

Tracked separately because each one is its own migration project, not a
batch. Policy is: only bump on CVE, EOL of current major, or concrete
benefit worth the cost (see memory `feedback_nutritrace_dep_bumps.md`).
Survey done 2026-05-20 audit.

**~~Strong candidates~~**: RELEASED 2026-05-20:

- ~~**Svelte 4 → 5** + **Vite 5 → 6** + **plugin-svelte 3 → 5** + **vite-plugin-pwa 0.19 → 1.0**~~ *(done, compat-mode migration, `svelte.config.js` pins `runes: false` + `compatibility.componentApi: 4`; bundle 1565 KB → 1211 KB. `svelte-spa-router` held on 4.0.2.)*
- ~~**Express 4 → 5**~~ *(done, path-to-regexp v8, one wildcard route rewritten to `/{*splat}`.)*
- ~~**bcryptjs 2 → 3**~~ *(done, drop-in; existing 2.x hashes verify cleanly under 3.x.)*
- ~~**multer 1.4.5-lts.1 → 2.2.0**~~ *(RELEASED rc.53, forced by three high-severity DoS CVEs on the LTS line. 2.x kept the middleware API. Retires the previous "OK to stay on LTS" rule.)*
- ~~**nodemailer 8 → 9.0.3**~~ *(RELEASED rc.53, five CVEs on the 8.x line including TLS OAuth cert validation + CRLF header injection.)*
- ~~**vite 6.4.1 → 6.4.3**~~ *(RELEASED rc.53, patches `server.fs.deny` bypass on Windows.)*

**Borderline**: only if there's an itch:

- **openid-client 5 → 6**. Complete rewrite, cleaner API, more spec-compliant. Current code works fine. Defer unless we're iterating on OIDC.

**Skip** unless something changes:

- **better-sqlite3 9 → 12**: Node-compat bumps, no NT-specific gain.

Audit cadence: see memory `project_nutritrace_dep_audit.md` (monthly `npm audit` + targeted bumps).

### ~~OIDC / SSO support (Authentik, Keycloak, Authelia, etc.)~~ *(RELEASED in v1.0.0-rc.9)*
Settings → User Management → OIDC providers. Multi-provider, admin-managed (not env-only), client secrets encrypted at rest, auto-link verified-email + auto-register-new-users split toggles, admin role mapping via group claims, runtime password-login disable for OIDC-only instances. Provider preset picker covers Authentik / Keycloak / Pocket ID / Authelia / Auth0 / Google / Custom. Profile → Linked accounts to attach SSO to an existing password account.

### ~~Security hardening~~ *(done)*
- ~~Rate limiting on auth endpoints (10/15min)~~
- ~~CORS middleware with allowed origins + Authorization header~~
- ~~Password complexity (8+ chars, uppercase/lowercase/number/special)~~
- ~~JWT_SECRET startup warning~~
- ~~CSRF protection, synchronizer token in JWT; enforced on cookie-based sessions; Bearer token requests exempt~~

---

## Authentication: Biometric re-auth

### ~~Android biometric sign-in~~ *(RELEASED 2026-05-10)*
- Plugin: @aparajita/capacitor-biometric-auth (static import required ,
  dynamic import silently fails to register the native bridge on Android,
  same gotcha as @capacitor/local-notifications).
- `src/lib/biometric.js` wraps isAvailable / getStatus / authenticate /
  saveTokenForBiometric / readSavedToken / clearSavedToken. Token stored
  in WebView localStorage (already encrypted at rest by Android FBE
  since Android 7, same threat model as the local SQLite cache).
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

### PWA WebAuthn / Passkeys: still deferred
PWA-side biometric would use WebAuthn / Passkeys via the Credential
Management API. Requires server-side passkey registration / auth
endpoints (RP ID, challenge, attestation verification). Higher long-term
value since passkeys are phishing-resistant and survive password
rotation, but a much bigger lift than the Android plugin path.
Defer until there's enough PWA demand to justify the server-side infra.

### Swap JWT sessions for opaque server-side session tokens (possible future)

Current auth: JWT in an httpOnly + SameSite=lax + Secure cookie, with a
CSRF token embedded in the JWT payload and verified via `X-CSRF-Token`
header on mutating requests. Bearer path for native Android. Password
change rotates the JWT.

Proposed: a `sessions` table (id, user_id, csrf_token, created_at,
last_seen_at, expires_at, user_agent, ip_addr) keyed by a 32-byte
random session id. The cookie transports the opaque id instead of a
signed JWT; the middleware does one indexed SELECT per request.

**Why bother** (none of these are urgent, none are CVEs):
- Real per-session revocation instead of the current "rotate the JWT
  on password change" all-or-nothing behavior.
- Unlocks a Settings → Sessions UI listing every active session with
  a revoke button. Useful for lost / stolen phones without forcing a
  password change.
- Preempts the recurring "JWT for auth is a security nightmare" Lemmy
  drive-by critique (2026-07-05 sample thread on programming.dev).
  Self-hosters read release notes / SECURITY.md; a "opaque session
  cookies, per-session revocable, standard cookie hygiene" story is
  much easier to sell than a paragraph explaining CSRF-embedded-in-JWT.
- Drops the `jsonwebtoken` dep entirely, one fewer supply-chain
  surface. `JWT_SECRET` env var becomes unused.
- Aligns with what most self-hosted apps in the wider ecosystem do
  (Nextcloud, Bookstack, Discourse, Paperless-ngx, Tandoor, Wger,
  Gitea/Forgejo, Vaultwarden). Note: Mealie + Immich use JWT similar
  to NT today, neither pattern is wrong; the sessions pattern is
  just the more security-conservative default.

**Non-goals:**
- Federation API tokens (`nt_pat_*`) are already opaque + SHA-256
  hashed; those stay as-is.
- Wearable OAuth tokens (Fitbit / Garmin / Withings / Google Health)
  stay in their respective token tables, unaffected.

**Migration path** (grace-period design, no forced-logout on upgrade):
- Add sessions table + a small `session-store.js` helper.
- Rewrite `middleware/auth.js` to try the sessions table first; fall
  back to `jwt.verify()` for one release so existing 30-day cookies
  keep working until they naturally expire OR the user re-logs in
  (which mints a session).
- Password change swaps its "rotate JWT" step for `DELETE FROM
  sessions WHERE user_id = ?`.
- OIDC callback issues a session instead of a JWT (deep-link URL
  shape unchanged; mobile treats the token opaquely already, no
  client change needed).
- CSRF token moves from the JWT payload to the `csrf_token` column;
  the `X-CSRF-Token` header contract stays identical downstream.
- New scheduler entry: `DELETE FROM sessions WHERE expires_at <
  datetime('now')` every 15 min.
- Backup: `sessions` table excluded from `dumpDatabase()` (ephemeral,
  restoring stale rows onto a fresh install makes no sense).
- After the grace release: drop the JWT verify path + the
  `jsonwebtoken` dep.

**Estimated scope:** ~4-6 hours focused work + testing. Touches
`server/middleware/auth.js`, `server/routes/auth.js` (login / logout /
password-change), `server/middleware/csrf.js`, `server/db.js` (new
table migration), `server/routes/oidc.js` (callback flow), and the
scheduler.

**Verified non-breaking checks already done** (2026-07-05):
- No client-side JWT decode anywhere (`grep -r jwt.decode|jwtDecode
  src/` returns zero hits), Android + PWA treat the token opaquely.
- Only one `jwt.sign()` call in the whole server (`middleware/auth.js`);
  no background jobs sign tokens.
- `req.user` shape (`id`, `username`, `role`, `csrf`) can be preserved
  by the new middleware so downstream route handlers don't change.

**Not urgent.** Nothing's actually vulnerable today. Land before v1.0
GA so the SECURITY.md story is clean for the awesome-selfhosted
submission + r/selfhosted launch window.

---

## TraceApps Cross-App Federation: friction reduction

Prompted by NT#88 (tedtramonte, 2026-07-06): self-hoster running NT + CT
for a family via OIDC objected to the per-user API-token dance for CT →
NT federation. Full audit lives in the conversation on 2026-07-09; the
short version below.

**Two phases, do them independently if at all:**

### Phase 1: MVP: kill the token-provisioning friction (~2-3 hours)

Closes ~90% of the real pain without any new auth model.

1. **Drop `requireAdmin` from `/api/admin/api-tokens`**
   ([`server/routes/api-tokens.js:18`](server/routes/api-tokens.js#L18) →
   `router.use(requireAuth)`). Consider renaming mount to
   `/api/tokens`. Family users mint their own tokens for their own
   data. Fixes the current admin-bottleneck bug where non-admin users
   literally cannot self-serve.

2. **QR-bootstrap in `SettingsApiTokens.svelte` create-flow.** After
   the raw `nt_pat_*` token appears, also render a QR encoding
   `nt-federate://<origin>?token=<raw>`. In CT's
   `SettingsFederation.svelte`, add a "Scan from NutriTrace" button
   that pops the mlkit scanner (already a CT dep) and pre-fills URL +
   token. LT gets the same button on its `SettingsFederation.svelte`.
   Register the deep-link handler in each Capacitor scheme.

Result: family user opens NT on phone → Settings → API Tokens → New
→ point phone at NT screen from CT's scanner → Save. ~4 taps, ~60
seconds, zero admin involvement, no long opaque string to copy.

### Phase 2: full cross-app SSO bridge (~8-15 hours)

Only build if a second user requests it after Phase 1 ships. Reporter
NT#88 has zero comments as of 2026-07-09 so demand signal is weak.

- Match users across apps by `(oidc_provider.issuer_url, oidc_sub)`
  instead of the local FK id. Every app already stores both.
- Server-to-server trust: admin configures CT with NT URL + a signing
  secret in env or admin settings, once. When user X calls CT, CT
  signs the outgoing request with `(user_x_oidc_sub, signing_secret)`.
  NT trusts CT's signature, looks up user by `(issuer, sub)`, scopes
  the response to that user's data.
- Zero per-user token generation. Data still scoped per-user via the
  OIDC sub. Symmetric, same pattern works CT ↔ NT ↔ LT triangle.
- Bundles neatly with the opaque-session-token migration above (both
  are auth-layer changes; can share design context).

### Companion: symmetric NT → CT federation

CT → NT federation is now bi-directional: CT can pull NT foods into
its pantry (long-standing) AND push completed recipes into NT's meals
catalog (added via the `write:recipes` scope + `POST /api/v1/recipes`
endpoint; see [Federation API](https://traceapps.github.io/docs/nutritrace/federation-api/#post-apiv1recipes)).
NT → CT (pull from CT) still doesn't exist. Not what NT#88 was asking
for but the natural next step once federation-auth is easy:

- CT exposes `/api/v1/recipes` + `/api/v1/log-cooked` mirroring NT's
  federation surface
- NT writes a CookTrace adapter for its Foods search source
  (`_ctEnabled` gate + `CtApi` in `src/lib/`, matching the existing
  `_mealieEnabled` + `Mealie` pattern in `Foods.svelte`)
- ~2 days work on top of Phase 2

**Assessment**: worth doing Phase 1 as tech-debt cleanup regardless
of NT#88's demand, the admin-only token creation is a real UX gap
that will bite the next self-hoster. Phase 2 waits for demand.

---

## Engagement / Achievements (maybe-never)

A small, restrained set of cross-domain badges (Diary + Wellness) that
reinforce real behavior milestones, not trivia. Idea-stage only, may
not ever cut if it ends up feeling gamified or out of character for
the self-hosted/serious audience.

If we did cut it:
- 8–12 badges total, not 50. Resist the urge to add "logged your first
  food!" trivial ones.
- Opt-in via Settings toggle (likely default off). The app should feel
  adult/clean for users who don't want gamification.
- Surface in Profile as a "Trophies" panel, slow-burn record, not
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
trackers tend toward austere, most users would rather see a sparkline
than a trophy. Defer until after the v1.0 surface settles and we have
real user feedback on what (if anything) they ask for here.

---

## Post-1.0 follow-ups

- **Nutrition card filter behavior**: the per-meal totals popup and the day Nutrition Summary both respect the `diaryShowAllNutrients` toggle (default 9 nutrients vs all). Decide: should the per-meal popup ALWAYS show all available nutrients (since user opted in by tapping the macro bar) regardless of the toggle, or stay consistent with the day summary? Three options: (a) leave as-is, (b) always show all in the popup, (c) add an in-popup expand toggle. Defer the call until we have user feedback on what they reach for.

---

## Pre-1.0 Public Release: TODO

Items to land before flipping `traceapps/nutritrace` public and submitting to Play Store:

- ~~**Android network security lockdown**~~ *(done 2026-05-02)*, `android/app/src/main/res/xml/network_security_config.xml` is now strict (`cleartextTrafficPermitted="false"` + system + user CA trust). Debug-signed APKs get a permissive resource overlay at `android/app/src/debug/res/xml/` that re-enables cleartext for `http://192.168.x.x` LAN dev. `explainConnectError()` in `src/lib/platform.js` translates the cleartext-blocked failure into a friendly "this build only allows HTTPS" message pointing at DEPLOY.md. Documented in three places: README "Coming soon" Android line, new DEPLOY.md "Connecting from Android" section (covers Let's Encrypt, Cloudflare/Tailscale tunnels, self-signed CA install on device, and the build-it-yourself escape hatch), and the in-app error toast.
- ~~**Native SQLite encryption (revisit)**~~ *(decided 2026-05-02, won't release, position is "rely on Android FBE")*, SQLCipher integration via `@capacitor-community/sqlite` v8 was rolled back in v0.39.23 due to flaky `setEncryptionSecret` secure-store semantics that locked users out of their own data. After surveying comparable apps (Immich, Joplin, Obsidian, AnkiDroid, Mealie, Tandoor, Wger, none encrypt their local SQLite either), decided NutriTrace's threat model doesn't justify the operational risk. Android's file-based encryption (default since Android 7) already encrypts the app data directory using a key tied to the device PIN/biometric, a locked phone is encrypted at rest. PRIVACY.md "Local data at rest" section documents the position explicitly and corrects the previous misleading "encrypted SQLite database" claim.
- **Public demo instance**: host `demo.nutritrace.app` on the existing Oracle Cloud Always Free machine. Pattern (standard for self-hosted demos, Mealie, Penpot, Vikunja all do this): single shared instance, signup disabled, pre-seeded with a realistic sample week of foods/meals/diary/wellness, cron resets the DB every 6–24h. Implementation: `DEMO_MODE=1` env flag that (a) blocks signup, (b) auto-signs in as the demo user, (c) returns 503 from AI/SMTP/upload routes (don't burn API keys, don't email random addresses), (d) renders a sticky banner "DEMO, data resets daily, don't enter real info". Add `server/scripts/seed-demo.js` to wipe + reseed; cron via systemd timer on the Oracle box. Demo URL is the single biggest conversion lever for awesome-selfhosted submission and r/selfhosted launch posts, defer to just before launch so the demo shows the v1.0 surface, not a beta.
- ~~**Sync to public repo**~~ *(done, routine release flow: dev → public via `nutritrace-dev-sync.sh` on Linux or the PowerShell-port equivalent. Public repo at `TraceApps/nutritrace` has been live since the rc.1 flip.)*
- ~~**Pre-flight scrub**~~ *(done 2026-04-26, full audit ran in v0.39.35-beta cycle: zero personal email/name leaks, `.env` properly gitignored, no hardcoded URLs/IPs in releasing files, all OAuth credentials user-configurable, sync script handles `thebigjoe1` → `traceapps` rewrites, Ko-fi handle migrated to `traceapps`)*
- **Discovery push** (post-flip), submit to awesome-selfhosted, post to r/selfhosted with screenshots/demo link, submit to selfh.st newsletter, then Show HN a few weeks later once Reddit traffic stabilizes. AlternativeTo + Umbrel/CasaOS app store listings as secondary follow-ups. Prerequisites: demo instance live, 4–5 screenshots in README, v1.0.0 tag (curated lists shy away from beta).

---

## ~~Repo Split: Public Server / Private Android~~ *(done, public flipped 2026-04-26)*

Current structure (post-flip):
- `traceapps/nutritrace-dev` (private), full monorepo with `android/`, used for development. CLAUDE.md and FUTURE.md live here only.
- `traceapps/nutritrace` (PUBLIC since rc.1), synced from `nutritrace-dev` via the sync script. Each public release is a clean snapshot commit (`chore: sync from nutritrace-dev (vX.Y.Z)`), not a daily commit log, CHANGELOG carries the version history.
- `traceapps/nutritrace-android` (private), standalone mirror of the Android shell.

CLAUDE.md was removed from public in rc.36; FUTURE.md is now dev-only too (this file). The sync script already excludes both, re-confirm if you ever modify the sync flow.

---

*Last updated: 2026-07-05, staleness audit pass. Marked done: Nutrition CSV importer v1 header, NutritionFactsBox Phases 1 + 2 (rc.42), Error visibility / sync status (offline `cloud_off` badge), Local OFF data dump (`server/lib/off-local.js` mirror released), dep bumps block (Svelte 5 / Vite 6 / plugin-svelte 5 / Express 5 / bcryptjs 3 all done 2026-05-20; multer 2.2.0 + nodemailer 9.0.3 + vite 6.4.3 done rc.53 as CVE-driven bumps, retired the "multer LTS OK to stay on" rule). Updated: Internationalization (French translation now landed rc.49, locale picker live).*
