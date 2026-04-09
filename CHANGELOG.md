# Changelog

All notable changes to NutriTrace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.38.2-beta] — 2026-04-08

### Smart Log — water logging
- Smart Log can now log water intake. Say "drank a glass of water", "500ml of water", or use a container name from your configured water containers (e.g. "had my protein shaker").
- Parser recognizes `kind: 'water'` items. `_matchWater` resolves the amount to ml using: (1) exact/fuzzy match against user's configured container names + volumes, (2) explicit ml/oz/L amounts, (3) generic container defaults (glass=240ml, bottle=500ml, mug=350ml, etc.).
- Water items skip the diary food entry flow entirely — `saveItems` calls `addWaterLog` in the diary store, same as tapping the water button manually.
- New `addWaterLog(amountMl, date)` exported from `src/stores/diary.js`.
- Modal shows a blue **Water** badge; meal slot picker and quantity field are hidden for water rows. An editable ml input lets the user correct the amount before confirming.
- Container names are injected into the AI parser prompt verbatim (same pattern as meal slot names) so custom names like "Protein Shaker", "Nalgene", "Thermos" resolve correctly.

---

## [0.38.1-beta] — 2026-04-08

### Added
- **Water log editing** — tap any water log entry to edit the amount inline. Input opens in place with the current value pre-filled in your display unit (ml/oz/L/G). Press Enter or tap ✓ to save, Escape or ✕ to cancel. Delete button still works as before (stopPropagation prevents accidental edit trigger).

---

## [0.38.0-beta] — 2026-04-08

### Security
- **CSRF protection** — synchronizer token pattern. A random 16-byte hex token is embedded in the JWT at issue time. The server verifies the `X-CSRF-Token` request header against the decoded token on all state-changing requests (POST/PUT/PATCH/DELETE). Bearer token requests (native app) are exempt — they're inherently CSRF-safe. Single-user mode and legacy tokens (issued before this version) are also exempt for a seamless migration window. New sessions are fully protected.
- Token added to JWT in `server/middleware/auth.js` (`signToken`); returned from `/api/auth/me`; verified in new `server/middleware/csrf.js`.
- `X-CSRF-Token` added to CORS `Access-Control-Allow-Headers`.
- Client injects header in `_NtApiHttp._fetch` (covers all NtApi calls), `Settings._fetchOpts` (backup/restore/full-backup), `aiChat.callAIProxy`, `notifications` push-test calls, and `mealieApi` proxy calls.

### Docs
- **README: Environment variables** — added `RECOVERY_TOKEN`, `LOG_LEVEL`, `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_ENABLED` to the env vars reference table.
- **README: Wellness Integrations** — step-by-step Fitbit and Withings OAuth app registration with exact callback URL format; Garmin note about partnership requirement.

---

## [0.37.0-beta] — 2026-04-08

### Smart Log v3.2 — meals, recipes, yesterday
Smart Log can now match against three new record types in addition to individual foods:

- **Saved meals** — say *"my X meal"*, *"the X meal"*, or *"for lunch I had my morning bowl meal"* and the AI tags the item as kind=meal. Smart Log searches `getMeals()`, picks the best name match, and **expands the meal into individual diary entries** when added (same as the Foods page meal-add flow). Each ingredient becomes its own diary item.
- **Saved recipes** — same as meals but uses `getRecipes()` (the `is_recipe=1` subset). Trigger words: *"my X recipe"*, *"made the X recipe"*, *"from my X recipe"*. Same expansion behavior.
- **Yesterday's diary** — say *"same as yesterday for lunch"*, *"yesterday's breakfast"*, or *"repeat yesterday's dinner"*. The AI tags it as kind=yesterday with the meal slot name. Smart Log fetches yesterday's diary, filters items in that slot, and copies them to today as new entries.

#### How the dispatch works
- Parser prompt now extracts a `kind` field per item: `food` (default), `meal`, `recipe`, or `yesterday`
- `matchItem` is now a router that dispatches to `_matchFood` (existing), `_matchMeal`, or `_matchYesterday`
- `_matchMeal(parsedItem, isRecipe)` searches meals or recipes by name with token + fuzzy substring fallback
- `_matchYesterday(parsedItem)` resolves the slot name to an index, fetches yesterday's diary, returns a synthetic meal-like record with `_yesterdaySlot` and `_yesterdayDate` metadata
- `saveItems` detects expansion-type matches (meal/recipe/yesterday with `food.items[]`) and writes each sub-item as its own diary entry instead of one combined entry

#### Modal updates
- New badge colors in SmartLogModal: **Meal** (purple), **Recipe** (pink), **Yesterday** (green) alongside the existing **Local** and **OFF**
- Expansion-type rows show "Expands to N items" + a "Show items" details disclosure listing each ingredient
- Quantity field is hidden for expansion-type rows since the meal already has its own portions baked in

### Documentation
- **New "Smart Log" section in README** with the full feature description, all four matchable source types, trigger words, meal slot detection rules, what it can/can't do, privacy story, and cost. ~80 lines of user-facing docs replacing the inline help block.
- **Settings help text trimmed** to a brief quick-start + the three main trigger words + a link to the README section. Used to be ~30 lines, now ~10.

### Fixed
- **Recording pillbox text centering** — the floating "● Listening… release to log" pill above the FitBot button when recording was off-center because the inline-style positioning shifted by `-60px` (a fixed offset that didn't account for the pill's actual width). Now uses `transform: translateX(-50%)` (or `translateX(50%)` for the default `right:50px` anchor) so the pill always centers on the FAB regardless of text length. Padding bumped to 8/16, font-size to 13, line-height to 1.2 to prevent descender clipping.
- **Cancel-state pill color** — the cancel-preview text used inline `color:#fca5a5` which fought the parent `color:#fff`. Now applied via `.cancel` class on the pill itself with a matching border color tint.

---

## [0.36.3-beta] — 2026-04-08

### Smart Log v3.1 — recording polish
- **Red FAB during recording** — the FitBot button now turns red (universal recording color) when hold-to-record activates. Stronger heartbeat ring pulse uses red instead of accent color so it's unambiguous. Reverts to the normal accent gradient when recording stops.
- **Audio beeps on start/end** via Web Audio API — short 80ms tone at 1000Hz when recording starts, lower 600Hz tone on commit, lowest 350Hz tone on cancel. Generated in-browser, no asset files. Gated by the existing `barcodeBeep` setting (users who muted barcode scans probably don't want voice beeps either).
- **Hold threshold 400ms → 700ms** — old 400ms threshold was too close to the natural "hold to drag" intent. 700ms is far enough above the 6px drag threshold that drag-then-release reliably wins, while still feeling deliberate. The haptic buzz at threshold is the "go" signal so the user knows recording started.
- **Slide-off-to-cancel** — finger > 100px from FAB center while recording → cancel preview activates: FAB greys out, recording hint changes to "✕ Release to cancel", light haptic confirms threshold crossed. Releasing in cancel state aborts the recording instead of committing. Same gesture pattern as iOS voice memos and WhatsApp voice messages.
- **Recording hint tooltip** — small floating pill above the FAB during recording. Shows "● Listening… release to log" in normal state, "✕ Release to cancel" in cancel-preview state. Backdrop-blurred dark pill, follows the FAB if user has dragged it.

### Build infra
- **Dockerfile fix** (committed yesterday) — `scripts/postinstall.cjs` is now copied before `npm install` so the postinstall hook can find it during CI builds.

---

## [0.36.2-beta] — 2026-04-07

### Smart Log v3 — hold-to-record on the FitBot button
- **Removed the dedicated mic FAB**. Smart Log voice is now triggered by **press-and-hold on the FitBot floating button** instead. Single global entry point that works on every page.
- **400ms hold threshold** — tap = open chat (existing behavior), hold past 400ms = enter recording mode. Drag still works (movement before threshold cancels the hold timer and resumes drag).
- **Visual morph** — robot face fades out, microphone icon fades in, and a stronger heartbeat ring pulse surrounds the FAB. The FAB scales up 8% during recording for clear feedback.
- **Haptic feedback** via `@capacitor/haptics`: medium impact when recording starts (crossing the 400ms threshold), light impact on release. Tactile confirmation without needing to look at the screen.
- **Native Android voice** via the existing `@capacitor-community/speech-recognition` plugin (uses the OS speech recognizer through an Android intent — no Web Speech API quirks). PWA still uses Web Speech API.
- **Auto-jump to review phase** — the AI parses + matches the transcript before the modal opens, so the user goes directly from "release the button" to "review and confirm" with no input/parsing screen in between. New `openMode="preParsed"` mode in the Smart Log modal.
- **Globally available** — the modal is mounted from inside `AIFitBot.svelte` so the gesture works on every page (Statistics, Foods, Wellness, etc.), not just Diary. Diary's local Smart Log state was removed entirely.
- **Renamed `QuickLogModal.svelte` → `SmartLogModal.svelte`** to match the user-facing name (setting key `quickLogEnabled` is unchanged for backwards compat).
- **Settings help text** — when Smart Log is enabled in Settings → AI Assistant, an expanded help section appears below the toggle explaining the hold gesture, drag-vs-hold disambiguation, custom meal name support, and the privacy story (audio stays on-device; transcript goes to user's configured AI provider; food matching is local-first).

### Build infra
- **Added `@capacitor/haptics` dependency** for tactile feedback on the hold gesture. Graceful fallback to no haptic if unavailable.

---

## [0.36.1-beta] — 2026-04-07

### Quick Log → Smart Log v2 (rebranded + native voice + custom meal support)
- **Renamed Quick Log → Smart Log** in Settings UI label and modal title. The setting key (`quickLogEnabled`) is unchanged so existing user preferences carry over.
- **Native voice input on Android** via `@capacitor-community/speech-recognition` plugin (uses Android's system speech recognizer through OS-level intent — no Google cloud dependency, no Web Speech API quirks). Requests RECORD_AUDIO permission on first use. Works offline if the user has on-device recognition available.
- **Floating mic FAB on the Diary page** — replaces the per-meal sparkle button. Single 56px circle bottom-right (above the FitBot FAB), tap to open Smart Log in voice mode and start listening immediately.
- **AI parses the target meal slot from natural language** — say "for breakfast I had 2 eggs and toast" and the AI returns both the items AND the meal slot. The parser prompt now includes the user's actual configured meal names verbatim, so custom meal slots like "Pre-workout", "Snack 1/2/3", or renamed defaults ("Morning Bowl") all work.
- **Robust meal slot resolution** in `quick-log.js`: exact case-insensitive match → shortest substring match → canonical-word fuzzy fallback (breakfast/lunch/dinner/snack with prefix-priority for numbered duplicates).
- **Auto-submit on voice input** — when the native plugin returns a transcript, Smart Log immediately parses without requiring a separate tap.
- **Clear listening state** — pulsing mic button + "Listening… speak now" banner during voice capture.

### Build infra
- **Postinstall script extracted to `scripts/postinstall.cjs`** — replaces the inline `node -e` one-liner. Patches both `@devmaxime/capacitor-health-connect` (Health Connect SDK version + proguard) and `@capacitor-community/speech-recognition` (proguard) in-place after `npm install`. Adding more plugin patches is now a 5-line addition instead of an unreadable one-liner.
- **AndroidManifest** — added `RECORD_AUDIO` permission and the standard `<queries>` entry filter for `android.speech.RecognitionService` so the OS exposes the speech recognizer to the app.

---

## [0.36.0-beta] — 2026-04-07

### Added
- **Quick Log (experimental)** — natural-language food entry powered by FitBot's AI provider. Type or speak something like "2 eggs and toast" and the AI parses it into structured items, then a deterministic pipeline matches each item against your local food database (frequency-ranked by usage in your diary), falls back to Open Food Facts, then to "not found" so the confirmation modal can flag it. Mic button uses the Web Speech API where available. Confirmation modal lets you swap matches, edit quantities, change meal slots, and remove items before tapping Add.
  - New module `src/lib/quick-log.js` (parseInput → matchItems → saveItems pipeline)
  - New component `src/components/diary/QuickLogModal.svelte` (bottom-sheet on mobile, centered card on desktop, input/parsing/review/saving phases)
  - New `quickLogEnabled` setting in Settings → AI Assistant, gated behind `aiEnabled`
  - Sparkle icon button (`auto_awesome`) appears next to each meal's `+` button on the Diary page when both AI and Quick Log are enabled
  - Works in PWA, native + server, and native local-only modes — same paths as FitBot
- **Donation links** — README has a Support section with GitHub Sponsors and Ko-fi badge placeholders. Settings → About now has a "Support development" row with the same buttons.
- **`.github/FUNDING.yml`** — GitHub will display a "Sponsor" button on the repo once the placeholders are replaced with real account handles.

### Fixed
- **README license inconsistency** — said MIT but actual `LICENSE` file is AGPL-3.0. README now correctly says AGPL-3.0 with a note that the Android app is distributed separately on the Play Store.

---

## [0.35.2-beta] — 2026-04-07

### Added
- **Local Full Backup (.zip)** — new `src/lib/local-backup.js` module produces a self-contained ZIP archive with all foods, meals, recipes, diary, wellness data, workouts, settings, AND embedded image binaries. Designed for true phone-to-phone transfer without needing a server. Restore extracts the ZIP, writes images back to Capacitor Filesystem on native (or re-encodes as data: URLs on PWA), then upserts everything into the local database. Manifest version 1, DEFLATE compressed level 6, JSZip 3.10.1 dependency added. Settings → Data → Local Backup.
- **`bulkSet({...})` settings helper** — single-API-call bulk write for onboarding flows. Wizard's `_saveIntegrations`, `_saveNotifications`, `finish`, and `skip` functions now batch their writes (~15 keys) into one PUT `/api/settings/bulk` request instead of firing 15 separate debounced pushes. New server endpoint `PUT /api/settings/bulk` accepts `{ settings: { key: value, ... } }`, runs the upserts in a single transaction, applies the same `isServerOnlyKey` security filter as the per-key endpoint.
- **`USER_PREFS` and `DEVICE_PREFS` exported** from `src/stores/settings.js` so other modules (local-backup) can introspect which settings should be included in portable exports vs left local.

### Cleanup
- **Defunct `notifGotifyEnabled` setting cleanup migration** — server's `db.js` now runs an idempotent startup cleanup that drops orphan rows for keys that no longer have any code reading them. Currently just `notifGotifyEnabled` (replaced by `notifPushService` dropdown in v0.32.0). Easy to extend with future deprecations via the `DEFUNCT_KEYS` array.

---

## [0.35.1-beta] — 2026-04-07

### Header layout polish
- **Hamburger floats over the banner** — reclaim ~62px of vertical space on every page. The 62px gap above the banner was wasted real estate (especially on mobile, where it ate ~27% of the viewport along with the safe-area inset). Hamburger button restyled as a translucent backdrop-blur dark pill (rgba(0,0,0,0.35), 10px blur, 160% saturate, white text+border) so it reads cleanly over both banner imagery AND plain page background.
- **Removed double safe-top padding** that caused a black bar above the banner on initial render — `.page-shell` no longer applies `padding-top` because its child `.page-header` already accounts for safe-area-top. Editor pages (FoodEditor, MealEditor) get the inset restored via a new `.page-shell.editor-page` selector since they use `.editor-header` instead.
- **Banner header thickness +20px** (`padding-bottom: 52 → 72px`) for more breathing room. All sticky sub-bars (Diary date, Wellness date+tabs, Foods sticky, Settings search) updated +48 to compensate for the additional `--hamburger-row` height.
- **Uniform H1 alignment** — all 6 page headers (Diary, Foods, Goals, Statistics, Wellness, Settings) now share a single `.page-header h1` rule in `base.css` (28px / 800 / 1.1 / -0.02em letter-spacing / forced 40px height). Removed the redundant per-page overrides in Diary.svelte and Wellness.svelte that previously caused a ~9px vertical offset.
- **Title sits below the hamburger in its own row** — added `--hamburger-row` CSS variable (48px = 40px hamburger + 8px gap) to `.page-header` top padding when the hamburger is visible. Title's left edge aligns with the hamburger button's left edge (viewport x=12) for a clean vertical line.

### Sidebar drawer
- **Heavier dark frosted-glass scrim** behind the slide-in sidebar — 55% black + 28px blur + 180% saturate (was using generic `--overlay`/`--backdrop-blur` tokens). Page content behind the sidebar reads as quiet background texture so the nav items pop.
- **Mobile hamburger access restored** — the previous viewport gate I added inadvertently hid the hamburger entirely on small phones. Now only `sidebarPinned` (the persistent/desktop-style mode) is gated to ≥768px. The drawer-style hamburger + slide-in overlay is always available whenever `navStyle` includes 'sidebar'. Tablets and desktop still get the option to pin it open.

---

## [0.35.0-beta] — 2026-04-07

### Security
- **Server-only setting keys filtered from client responses** — OAuth app credentials (`withings_client_secret`, `fitbit_client_secret`, etc.) were being returned by `GET /api/settings` and the differential sync pull endpoint. Added shared module `server/lib/server-only-keys.js` with explicit allowlist + regex pattern fallback (`_client_secret$`, `_consumer_secret$`, `_redirect_uri$`, `_client_id$`, `_api_secret$`). Filter applied at every read/write boundary: GET/PUT `/api/settings`, GET/POST `/api/sync` settings filter, server-side rejection on PUT with 403.

### Settings sync overhaul (root-cause fix for the missing-mealNames bug)
- **Split `SERVER_SETTINGS` into `USER_PREFS` and `DEVICE_PREFS`** in `src/stores/settings.js`. USER_PREFS travel across devices (nutrition, units, integrations, notifications, behavioral prefs). DEVICE_PREFS stay local: `appearance`, `navStyle`, `sidebarPersistent`, `disableAnimations`, `barcodeFlashlight` — these depend on form factor / device hardware and shouldn't be forced to match across phone + desktop.
- **`loadServerSettings()` now mirrors all server settings into native SQLite** `user_settings` on Android, marking them `synced` so the differential sync engine doesn't re-push. Background workers (ReminderWorker, HealthConnectSyncWorker) now read fresh values. Phone went from 60 → 86 settings after the first cold-start with this fix.
- **Global `wl:setting` listener** in `src/stores/settings.js` catches direct `DB.setSetting()` writes (16+ legacy bypass call sites) and triggers `scheduleSave` + native SQLite mirror for `USER_PREFS` keys. Fixes the entire bypass class without touching individual call sites.
- **`DB.setSetting` short-circuits** if value is unchanged — prevents listener floods on mount and avoids double-firing the server push.

### Added
- **Sidebar viewport gate** — sidebar nav style is force-hidden on screens < 768px (small phones in any orientation) regardless of user preference. Tablets, foldables, and desktop keep the option. The setting itself is preserved across rotations/resizes. Settings UI now also uses the width gate instead of `!isNative` so the persistent-sidebar toggle appears on tablet/foldable native installs.
- **Per-device sync range tiers** in Settings → Wellness — replaces single `SYNC_RANGE_OPTIONS` with Recommended (1d/1w/1m/3m for all devices) + Advanced ⚠ tier per device: Fitbit 6m/1y, Garmin 6m only, Withings 6m/1y. Custom day input clamped per device (Garmin 180, Fitbit/Withings 365). Each device gets a one-line warning under Advanced explaining why longer ranges may fail or be slow.

### FitBot redesign
- **Animated robot face SVG** (FitBotFace.svelte) replaces the `smart_toy` Material icon in all 5 places FitBot is shown (FAB, header, welcome screen, message avatar, typing indicator). Pure-CSS animations: blinking eyes, eye-darting, pulsing antenna, twinkling cheek lights, breathing mouth.
- **FAB visual upgrade** — glassmorphism (backdrop-filter blur+saturate, white border, inner radial highlight, depth shadows), theme-aware animated gradient (shifts between `--accent` and `--accent-2`, never hardcoded colors), concentric heartbeat ring pulse using `--accent-dim` (replaces vertical bobbing).
- **Responsive panel layout** — replaces right-side slide-in with: bottom sheet on mobile (88vh, drag handle, dimmed backdrop) / floating card on desktop (420×640, no backdrop, anchored to FAB position). Card pops up next to wherever the user dragged the FAB (4-quadrant logic clamped to viewport).

### Fixed
- **Meal reminder labels** — both ReminderWorker.java and server scheduler had a bug where missing/short `mealNames` fell back to hardcoded defaults `['Breakfast','Lunch','Dinner','Snacks']` and would fire wrong labels like "Time to log your Dinner!" at 1pm. Now: if mealNames is missing or shorter than `notifMealTimes`, unmatched indices show generic "Time to log your meal!" instead of impersonating a wrong slot.
- **BarcodeScanner double-submit** — `onCode()` checked `detected` flag at the top but never set it, so rapid camera detections (multiple frames or two engines firing for the same barcode) could both dispatch scan events. `doManual()` had no guard at all. Both now set `detected=true` on entry; continuous mode resets after 1.5s cooldown.
- **Workout list "max" → "peak" HR** — compact workout list said "94 avg · 154 max bpm" while the expanded detail card said "Peak HR" for the same value. Now consistent.

---

## [0.34.0-beta] — 2026-04-06

### Added
- **Native Android background reminders via WorkManager** — new Kotlin/Java native worker (`ReminderWorker.java`) runs every 15 min (Android floor) to check SQLite directly and fire meal/water/weigh-in notifications only when warranted. Skips reminders for meals already logged in today's diary, water goals already met, etc. Works even when the app is closed/killed without depending on the JS layer.
- **Native Health Connect background sync via WorkManager** — new Kotlin `HealthConnectSyncWorker` (CoroutineWorker) reads the androidx Health Connect SDK directly (no JS plugin bridge needed) and writes results into the local SQLite `wellness_data` table under `source='health_connect'`. Reads 13 metric types: steps, distance, total/active calories, avg HR, resting HR, weight, body fat, SpO2, respiratory rate, sleep session with stages, floors, hydration. Runs every hour when the user has Health Connect enabled.
- **WorkerScheduler.java** — centralized worker enqueue/cancel logic. HC sync worker is only enqueued when `healthConnectEnabled = true` in user_settings; toggling off calls `cancelUniqueWork` so the OS doesn't run anything for HC at all (zero battery cost when disabled). Re-evaluation triggers from MainActivity onCreate (app open) and from ReminderWorker every 15 min so Settings toggles take effect within 15 min without a reopen.
- **Kotlin support added to Android project** — `kotlin-gradle-plugin:2.0.21` + `kotlinx-coroutines-android:1.8.1`, enabling native suspend/coroutine code for the HC SDK (~3x less boilerplate vs Java).
- **`_USE_NATIVE_WORKER` kill switch** in `src/lib/notifications.js` — when `true` (default), the JS-side `LocalNotifications` scheduling for water/meal/weigh-in early-returns after cancelling any pending OS notifications, making WorkManager the sole source of local reminders. JS code preserved for fallback testing.

### Battery-conscious worker design
- `NetworkType.NOT_REQUIRED` — never wakes the radio
- `setRequiresBatteryNotLow(true)` — skips when battery < 15%
- Read-only SQLite where possible; HC writes use WAL-friendly transactions
- Single ReminderWorker handles all reminder types (3x fewer wake-ups vs separate workers)
- `ExistingPeriodicWorkPolicy.KEEP` — survives app restarts without re-enqueueing
- Permission gate: HC worker bails immediately if no HC permissions granted
- No exact alarms, no wake locks, no foreground service
- Each invocation: ~50ms SQLite read + (optionally) ~50ms HC reads + ~20ms write

### Fixed
- **Fitbit workout Peak HR was always 220** — `heartRateZones[].max` is the zone boundary (Peak zone always tops at 220), not actual HR. Now fetches per-minute intraday HR data from `/1/user/-/activities/heart/date/.../1d/1min/time/.../...` for each activity's time window and stores the actual highest recorded heart rate. Label renamed to "Peak HR".
- **Peak HR timezone bug** — initial intraday fix used `toTimeString()` which converts to server timezone, fetching the wrong HR window (often resting hours). Now parses HH:mm directly from the activity's ISO startTime to preserve the user's local time.
- **Goal celebration repeats across app reloads** — `_celebratedToday` Set was in-memory only and reset on every reload, causing repeat celebrations for goals already hit earlier in the day. Now persisted to localStorage with date key. Affects all goals: water, calories, protein, carbs, fat, steps, sleep, etc.
- **Stress score formula display string** — debug/info text said `0.60×... + 0.40×...` but actual code uses `0.50/0.50` smoothing since v0.30.0. Display now matches the math.

### Changed
- **Fitbit score calibration data collection** — `reference_fitbit_scores.md` now tracks readiness/stress formula output alongside actuals (not just sleep). User pastes `[readiness]` and `[stress]` console JSON blocks daily; all components, baselines, inputs are logged for retroactive refit.

---

## [0.33.0-beta] — 2026-04-05

### Added
- **Health Connect → Statistics integration** — all wellness metrics (steps, active min, sleep, resting HR, HRV, SpO2) and body metrics (weight, body fat, muscle mass) from Health Connect now feed into Statistics charts on native, alongside Fitbit/Garmin/Withings sources
- **Health Connect Visible Metrics filter** — Settings → Wellness → Health Connect now has chip toggles for 25 metrics (steps, distance, sleep stages, HR, weight, body fat, SpO2, BMR, etc.) matching Fitbit/Garmin/Withings sections
- **Statistics respects visible metrics filter** — hidden wellness metrics (per `wellnessMetrics` setting) no longer appear in the Statistics dropdown, consistent with Wellness page behavior
- **Workout Peak HR from intraday API** — Fitbit workout sync now fetches actual peak heart rate from the per-minute intraday HR endpoint for each activity's time window, instead of using the heart rate zone ceiling
- **Health Connect string-record parsing** — plugin returns BodyFat, BloodPressure, and SpO2 as Kotlin `toString()` strings; added regex parsers for each
- **Health Connect Weight string fallback** — defensive parser for Weight records in case the plugin returns a string instead of an object

### Fixed
- **Repeat goal celebration notifications** — `_celebratedToday` Set was in-memory only and reset on every app reload, causing repeat celebrations for goals already hit earlier in the day. Now persisted to localStorage with date key. Affects all goals: water, calories, protein, carbs, fat, steps, sleep, etc.
- **Workout "Max HR" always 220** — was reading `heartRateZones[].max` (the zone boundary, not actual HR; Peak zone always tops at 220). Now uses real intraday HR data; label renamed to "Peak HR"
- **Peak HR timezone bug** — initial intraday fix used `toTimeString()` which converts to server timezone, fetching the wrong HR window. Now parses HH:mm directly from the activity's ISO startTime to preserve local time
- **Meal reminder sent even after meal logged** — scheduler diary query now falls back to `user_id IS NULL` rows for users with diary entries created before user management was enabled; explicit `Number()` conversion on meal index comparison
- **Scheduler `reminderMin is not defined`** — leftover undefined variable from the 30-min delay revert
- **Statistics: Health Connect data ignored** — Statistics page only queried Fitbit/Garmin/Withings server endpoints; now also reads `health_connect` source from local SQLite on native
- **Body weight/body fat charts ignored Health Connect** — `isBodyDevice` only checked `withingsEnabled`; now also checks `healthConnectEnabled` and falls back to HC data when no Withings reading is available

### Changed
- **Wellness `toggleMetric` covers HC metric IDs** — includes `active_calories`, `avg_heart_rate`, `blood_pressure_systolic/diastolic`, `body_temperature`, `sleep_awake_min`, `water_ml` so the visibility toggle properly tracks them
- **Scheduler logging elevated to info** — meal reminder check now logs at info level so push notification debugging is visible without enabling debug mode

---

## [0.32.0-beta] — 2026-04-03

### Added
- **Bidirectional settings sync** — settings changes on Android now sync to server via differential sync engine; server setting changes (from PWA) pull down to Android and update stores in real-time
- **Wellness offline cache** — Wellness page reads from local SQLite on Android, showing synced Fitbit/Garmin/Withings/Health Connect data even when offline
- **Local wellness data for sparklines, readiness, and stress** — all range-based data loads (sparklines, sleep insights, readiness, stress) use local SQLite on native instead of server API
- **Workout history with GPS route maps** — Fitbit activity log sync via `activities/list` endpoint; TCX GPS parsing for route data; Leaflet/OpenStreetMap route display with HR-colored polyline segments; workout detail modal with map, duration, distance, calories, HR, and steps
- **`workoutsEnabled` setting toggle** — Settings → Wellness → Fitbit; enables/disables workout log sync and display
- **Comma formatting on large numbers** — `toLocaleString()` applied to calories, steps, and other large numbers across Diary, Foods, Wellness, and Statistics
- **Fitbit OAuth `location` scope** — added to authorize request for GPS/TCX route access
- **FitBot AI tool use** — FitBot now fetches real data on demand via function calling instead of hallucinating from context; tools: `get_wellness_data`, `get_body_composition`, `get_diary`, `get_workouts`, `get_goals`; supports Claude, OpenAI, and Gemini; queries any date range; tool execution loop up to 5 rounds
- **FitBot image attachments** — attach images to FitBot messages; camera on native (via `@capacitor/camera`), file picker always available on PWA, camera option shown on PWA if webcam is detected
- **Mobile OAuth via system browser** — Fitbit, Garmin, and Withings OAuth on Android now opens the system browser via `@capacitor/browser` with callback via `nutritrace://` deep link (AndroidManifest intent filter for `nutritrace://callback`)
- **PWA settings poll** — PWA polls server for setting changes every 30 seconds and on tab focus (`visibilitychange`) for near-real-time sync
- **Diary scroll position save/restore** — diary saves and restores exact scroll position when adding food (page-transition is a fixed scroll container)
- **Notification system** — 10 notification types (water reminders, meal reminders, weigh-in, goal celebrations, calorie goal, step goal progress, wellness alerts, workout summaries, weekly summary, sync failures); delivery via device notifications + push service
- **Push service support** — dropdown: Apprise, Gotify, ntfy; each with own config; native uses CapacitorHttp (no CORS), PWA proxies through server; test button for all services
- **Scheduled wellness sync** — new sync mode alongside Auto and Manual; server-side scheduler runs every 15 minutes; frequency options: every 6h, every 12h, daily, weekly
- **Server-side scheduler** — push reminders (water, meal, weigh-in) via configured push service for PWA users; weekly summary on Sundays; scheduled wellness sync trigger
- **Repeating local notifications** — water, meal, weigh-in reminders use `every: 'day'` for infinite repeat; re-scheduled on every app open
- **Eye icon on all password/token fields** — OFF password, SMTP password, new user password, admin password, Gotify token, ntfy token all have visibility toggle
- **Local mode audit** — Fitbit/Garmin/Withings show disabled state with explanation in native local mode; Health Connect promoted as local alternative; Gotify works in local mode via CapacitorHttp; FitBot reads from local SQLite

### Fixed
- **Health Connect section spacing** — uniform `padding-top:16px` matching Fitbit, Garmin, and Withings sections
- **Wellness "No Device Connected" on offline** — no longer shows connection prompt when cached wellness data is available
- **Debug logging cleanup** — removed verbose push food details and raw JSON result logging from sync engine
- **Statistics history rows missing comma formatting** — large numbers (calories, steps) in history rows now formatted with `toLocaleString()`
- **Settings Wellness cards missing scoped styles** — `.section-body`, `.settings-card`, `.setting-row` styles now scoped inside SettingsWellness.svelte, matching uniform card appearance in Connected Services
- **"Save &amp; Connect" HTML entity** — raw `&amp;` entity no longer displays as literal text in button labels
- **Settings Wellness connection status loading slow** — Fitbit/Withings/Garmin status API calls now run in parallel; connection status auto-loads on component mount instead of waiting for section expand
- **Workouts table in full backup** — workouts table now included in full backup dump and restore
- **Settings sync feedback loop** — `_suppressSync` flag prevents feedback loop when loading server settings into stores; 10-second recently-changed protection window prevents server pull from overwriting local changes; settings written to SQLite immediately on `.set()` (not debounced)
- **Statistics units showing "kcal" for all metrics** — replaced broken `getMetricUnit()` function calls with reactive `$: _metricUnit` variable
- **`_DB` reference error crashing settings sync** — `_DB` used before definition in `Statistics.svelte` and `Settings.svelte`; fixed declaration order
- **Gradle 9.3 proguard compatibility** — `proguard-android.txt` → `proguard-android-optimize.txt`

### Changed
- **Readiness and stress score formulas recalibrated** — 10-day dataset used to tune coefficients; MAE improved from 2.5→1.4 (readiness) and 2.5→1.6 (stress); see `reference_fitbit_scores.md` for formula versions and calibration log

---

## [0.29.0-beta] — 2026-04-01

### Added
- **Phase 2: Differential sync infrastructure** — push/pull endpoints with timestamp tracking; only changed records sync instead of full merge
- **Phase 2: Offline cache layer** — `NtApiCached` tries server first, falls back to local SQLite when offline
- **Phase 2: Image caching for offline mode** — downloads server images to device storage for offline access
- **Sync status bar** — progress phases (pushing/pulling/caching images) with visual feedback
- **Connection badge on hamburger menu** — green dot when connected to server, red when offline
- **Three-way merge dialog on server connect** — upload/download/merge options when reconnecting
- **Sync on app startup and resume** — automatic differential sync when app launches or returns from background
- **Local fonts for Android** — Material Symbols + Inter bundled in app, identical to CDN versions
- **Android back button navigation** — navigates back within app history, double-tap to exit
- **Wellness page: generic "No Device Connected" messaging on mobile** — no API setup prompts on Android

### Fixed
- **Fitbit score calibration** — readiness HRV neutral set to 62, penalty 400 (uses 30-day baseline)
- **Score locking** — readiness/stress snapshot on first sync of the day; recalculate button for manual tuning
- **Wellness date calculations** — use local timezone instead of UTC
- **Profile page** — missing `resolveAssetUrl` import broke profile loading
- **Images survive server disconnect** — `loadImageMap` awaited, `NtApiNative` uses `resolveAssetUrl`
- **Sync bar portalled to body** — stays fixed at top, doesn't scroll with page content
- **Server: soft deletes on all tables** — `updated_at` tracking for differential sync
- **Server: /uploads served before auth middleware** — Android WebView can load images without token
- **Server: ALTER TABLE migration** — uses constant defaults (SQLite limitation workaround)
- **Source chip clicks** — reactive loop breaking OFF/USDA selection fixed
- **Settings search bar** — sticky below header
- **Foods search bar** — uniform style with barcode icon inside pill
- **Wellness tab bar** — sticky below date bar
- **Wellness pill position** — uses DOM measurement for pixel-perfect alignment on mobile

---

## [0.28.0-beta] — 2026-03-31

### Added
- **Android app via Capacitor 8 (Phase 1 complete)** — full native Android build wrapping the Svelte PWA
  - Offline-first with local SQLite database (`@capacitor-community/sqlite`)
  - NativeSetup wizard: "Use Locally" (pure offline) or "Connect to Server" (enter URL + authenticate)
  - Server connection with Bearer token auth and data merge dialog (push local data, choose settings winner)
  - Native barcode scanner via Google ML Kit (`@capacitor-mlkit/barcode-scanning`)
  - Native camera for food, meal, and avatar photos (`@capacitor/camera`)
  - OFF/USDA food search via `CapacitorHttp` (CORS bypass in WebView)
  - All images resolve to server URL in connected mode
  - All API calls include auth token in native server mode
  - Service worker disabled inside Capacitor (prevents offline.html redirect)
  - App icon at all Android `mipmap` densities
  - Wizard: measurement system step (metric/imperial) with appropriate defaults
  - Password visibility toggle on connect forms
  - Settings hidden in local mode: User Management, Email, Food Sharing, persistent sidebar
  - Full backup works in server-connected mode
- **Server CORS** — allows `Authorization` header and all origins for native app support
- **Server auth** — `authenticate` middleware accepts Bearer token in `Authorization` header (in addition to cookie)
- **Login response** — JWT token now included in response body (for native app token storage)

### Fixed
- **OFF/USDA source chip clicks** — reactive loop was breaking chip navigation for both PWA and Android; fixed reactive dependency chain
- **`_extFetch` recursive call** — infinite loop on PWA caused by self-referencing fetch wrapper; corrected call target
- **Page banners default to on** — banners now enabled by default on fresh installs
- **Long-press menu for external results** — OFF/USDA search results now show "Save to My Foods" instead of Edit/Delete in the long-press action sheet

---

## [0.25.0-beta] — 2026-03-30

### Added
- **Food & meal sharing** — multi-user groups can now share foods, meals, and recipes between members; admin enables sharing via Settings → Sharing; each item can be set to Private / Everyone / Specific People; shared items appear in a "Group Catalogue" tab in Foods; adding a shared item to diary auto-copies it to your own catalogue first (copy-on-use model; originals remain unaffected); `_shared_by` badge shows contributor attribution
- **FoodEditor/MealEditor sharing section** — new Sharing card at bottom of food and meal/recipe editors; shows visibility selector (Private / Everyone / Specific) and user-picker chips when Specific is selected; only visible when multi-user is active and item is owned by the current user
- **Settings → Sharing section** — admin toggle to enable/disable food sharing instance-wide; per-user default visibility preference
- **Tab favicon** — browser tab and bookmark now show the NutriTrace logo (SVG preferred, PNG fallback)
- **Edit credentials button** — Fitbit, Withings, and Garmin connection cards now show a pencil icon button when configured but not connected, allowing API credentials to be updated without needing to disable the integration entirely

### Fixed
- **OAuth credential change** — after disconnecting Fitbit/Withings/Garmin, credentials were read-only (only "Connect" button visible); now shows an edit button to modify Client ID, Secret, and Redirect URI before reconnecting

---

## [0.24.0-beta] — 2026-03-30

### Added
- **Card tooltips** — Sleep Debt, Chronotype, Daily Readiness, and Stress Management cards now have hover tooltips explaining what each metric measures and noting that they always reflect current/rolling data, not the specific date selected in the date picker

### Changed
- **Heart tab metric order** — reordered to match Fitbit's Vitals section: Resting HR → SpO2 → Respiratory Rate → HRV → Skin Temp Variation → Cardio Fitness
- **Skin Temp Variation moved to Heart tab** — was incorrectly grouped under Sleep; moved to Heart where it belongs
- **Skin Temp Variation displayed in °F** — stored as °C from Fitbit API, converted to °F for display (variation × 9/5, no offset since it's a delta)

### Fixed
- **Daily Readiness / Stress Management score inflation** — today's HRV was included in the baseline mean (circular: a low-HRV day pulled the baseline down, making the ratio look better). Fixed by using history-only values for baseline calculation; today is counted only for the minimum-data threshold check. Scores now match Fitbit's (readiness ±1, stress converging)
- **Fitbit `temperature` scope added** — skin temp variation was always returning null because the `/temp/skin` endpoint requires the `temperature` OAuth scope which was not being requested; users need to re-authorize Fitbit to grant this scope
- **Withings `user.cardiovascular` scope removed** — added in previous version but Withings requires explicit developer approval for this scope; caused "scope not allowed" errors on reconnect for standard developer apps
- **OAuth state persisted to DB** — all three integrations (Fitbit PKCE, Withings state, Garmin request tokens) now store OAuth state in a new `oauth_state` table instead of in-memory Maps; server restarts during the auth redirect window no longer cause "invalid state" or "token expired" errors

---

## [0.23.0-beta] — 2026-03-30

### Added
- **Daily Readiness Score** — new card on the Wellness Heart tab; calculates a 1–100 score from 30 days of personal HRV, RHR, sleep, and activity history; asymmetric HRV model (below-baseline penalised 2.75× harder than above); HRV×RHR interaction penalty fires when both signals are bad simultaneously; shows Optimal/Good/Fair/Low/Poor label with colour coding; 4-column driver breakdown (HRV · RHR · Sleep · Penalties); calibrating state shown when fewer than 7 days of HRV history exist; constants reverse-engineered from 6 actual ground-truth data points (avg error ±1.2 pts, max 2 pts)

### Changed
- **AI chat renamed AIBuddy → AIFitBot** — component file renamed to `AIFitBot.svelte`; no user-facing name change (assistant name is still configurable)
- **AI assistant data access expanded** — system prompt and context now include Garmin data (steps, activity, sleep, HR, HRV, SpO2, body battery, stress, max HR), full Fitbit metrics (AZM, floors, distance, sleep score, SpO2, respiratory rate, VO2 Max, skin temp), full Withings metrics (bone mass, body water, visceral fat, vascular age, metabolic age), water intake, and a note when no wellness data is available; welcome screen updated with a "Sleep & recovery" quick chip
- **AI message timestamps** — messages from today show time only (e.g. "3:45 PM"); messages from previous days show date prefix in the user's preferred format (e.g. "03/29 · 3:45 PM")
- **Settings search bar** — changed `top` from `56px` to `0` so the bar snaps directly to the top when the banner scrolls away, eliminating the crawl-through-banner effect

### Fixed
- **Wellness goals first-load** — wellness goal progress bars were blank on first visit to the Goals page because `fitbitEnabled`/`garminEnabled` stores hadn't resolved yet when `onMount` ran; moved fetch to a reactive statement that fires as soon as either store becomes true

---

## [0.22.0-beta] — 2026-03-29

### Added
- **Sleep Debt card** — Sleep tab now shows cumulative sleep debt over last 7 or 14 nights (configurable with range chips); calculated as sum of `max(0, goal − actual)` per night
- **Chronotype card** — classifies sleep type (Early Bird / Morning Type / Intermediate / Evening Type / Night Owl) from average sleep midpoint across the selected range; requires ≥5 nights of timing data; shows "Building profile…" with count when insufficient data; includes emoji + plain-language description matching Fitbit's style
- **Sleep start/end extraction (Fitbit)** — `sleep_start_min` and `sleep_end_min` now parsed from Fitbit `startTime`/`endTime` fields and stored in wellness_data (minutes past midnight)
- **Sleep start/end extraction (Garmin)** — `sleep_start_min` and `sleep_end_min` derived from `startTimeInSeconds + startTimeOffsetInSeconds` (local epoch → UTC hours/minutes); `sleep_end_min` computed from start + `durationInSeconds`
- **7-day sparklines on metric cards** — each Movement / Sleep / Heart metric card now displays a small inline SVG sparkline showing the last 7 days of that metric; loaded in background, does not block current-day display
- **Statistics — wellness metrics** — Statistics page now includes a Wellness section (when Fitbit/Garmin/Withings are enabled) with Steps, Active Minutes, Sleep, Resting HR, HRV, SpO2, and Muscle Mass; supports all date ranges including a 365-day window for the 'all' range
- **Statistics — device-first body composition** — when Withings is connected, weight and body fat pull from Withings device data first and fall back to diary manual entries; no source toggle needed; applied automatically
- **Hover tooltips on wellness metric cards** — each metric card has a `title` attribute with a plain-language explanation of what the metric measures and why it matters

### Changed
- **Trends tab removed** — the Wellness Trends tab has been replaced by inline sparklines on each metric card; reduces duplication with Statistics and keeps the view focused
- **Sleep stage legend redesigned** — proportional flex row below the bar; each segment's label and value are centered under its corresponding bar segment; segments narrower than 3% are hidden to avoid overflow
- **Wellness goals — today's progress** — Wellness goals now show the actual today total and a progress bar (same as nutrient/body stat goals); fetches today's Fitbit + Garmin data on Goals load
- **Statistics body composition** — device-first merge replaces the manual Diary/Device source toggle; cleaner UX, no extra UI state

### Fixed
- **Reactive double-load for sleep insights** — split the reactive block into two: one marks `_insightsLoaded = false` when deps change, the other calls `loadSleepInsights()` only when stale; eliminates the race condition that caused duplicate fetches

---

## [0.21.0-beta] — 2026-03-29

### Added
- **Withings segmental lean + muscle mass** — correct positional type mapping for types 173 (lean mass) and 175 (muscle mass); five readings per measurement group are assigned to torso, left leg, left arm, right leg, right arm in order; removed incorrect prior type mappings
- **Withings additional body metrics** — extracellular water (type 168), intracellular water (type 169), visceral fat index (type 170), metabolic age (type 227); displayed on Body tab and togglable in Settings
- **Fitbit Cardio Fitness (VO2 Max)** — fixed endpoint (removed erroneous `/1d` suffix); range response (e.g. "39-43") stored as midpoint; label renamed to "Cardio Fitness" throughout to match Fitbit's own terminology
- **Fitbit skin temperature variation** — synced from `/temp/skin` endpoint (Pixel Watch 4 and compatible devices); shown on Sleep tab
- **Garmin max heart rate** — extracted from dailies `maxHeartRate` field; shown on Heart tab
- **Sleep score estimation (Fitbit)** — sleep score endpoint not available in public API; estimated from duration, deep+REM%, SpO2, and HRV; calibrated to within ±1 pt on 3 actual days; Garmin device score takes priority when both sources are present
- **Settings toggles** — added for all new metrics: skin temp variation (Fitbit), max HR (Garmin), extracellular water, intracellular water, visceral fat index, metabolic age (Withings)

### Changed
- **Segmental Analysis** — removed the % toggle (values were misleading); replaced with an explanatory note; "Fat" column renamed to "Lean" to correctly reflect what the data represents (lean mass, not fat mass)
- **Sleep stage legend** — values now display in h/m format (e.g. "1h 13m") instead of raw minutes; applied to both the legend and bar tooltips
- **displayData merge** — Garmin sleep score takes priority over Fitbit estimated score; all other metrics still prefer Fitbit when both are present

### Fixed
- **Withings OAuth scope** — removed `user.cardiovascular` from default scope (caused re-auth failures); ECG requires re-auth only when explicitly needed
- **Wellness Trends unit conversion** — muscle mass and weight charts now correctly convert to lbs on the y-axis and in tooltips when the app unit is set to lb

---

## [0.20.0-beta] — 2026-03-29

### Added
- **Metric visibility toggles** — Settings → Wellness now includes a "Visible Metrics" card with chip toggles for every wellness metric, grouped by section (Movement, Sleep, Heart, Garmin, Body, Body Scan, Segmental); hidden metrics are excluded from Wellness display and future reports; data is always synced regardless of visibility; defaults to all visible with a "Reset to defaults" button
- **Expanded Withings metrics** — now captures heart pulse during weigh-in (meastype 11), segmental fat mass per limb (right arm, left arm, torso, right leg, left leg); displays in a new Segmental Analysis table (muscle + fat per limb) on the Body tab
- **Withings ECG** — syncs ECG recordings from `/v2/heart` endpoint after each measurement sync; stores `ecg_heart_rate` (latest reading) and `ecg_afib` (Normal / Detected per day); requires re-authorization to grant `user.cardiovascular` scope
- **Fixed Withings type-174 duplicate bug** — `visceral_fat` was being silently overwritten by a second `174` mapping; corrected to a single `visceral_fat` entry
- **Expanded Garmin metrics** — now extracts moderate/vigorous intensity minutes from dailies; respiration rate and sleep score from sleep response (already fetched)
- **Fitbit Active Zone Minutes** — synced from `/activities/active-zone-minutes` endpoint using the existing `activity` scope
- **Fitbit VO2 Max** — synced from `/cardioscore` endpoint; requires re-authorization to grant `cardio_fitness` scope
- **New metric cards** in Wellness — Active Zone Min, Moderate Intensity, Vigorous Intensity (Movement tab); Sleep Score (Sleep tab); VO2 Max (Heart tab); Heart Pulse, ECG Heart Rate, AFib Detection (Body Scan Scores); ECG & AFib chip on Withings connect screen

### Changed
- Visibility filtering extended to Body, Body Scan Scores, Garmin-specific, and Segmental sections (previously only applied to Movement/Sleep/Heart)
- **Labs section removed** from Settings — it had been reduced to a redirect note; credentials are fully managed per-integration in Settings → Wellness

---

## [0.19.0-beta] — 2026-03-29

### Added
- **Garmin integration (Experimental)** — OAuth 1.0a flow via Garmin Health API; syncs steps, distance, active minutes, calories, floors, sleep stages, resting HR, HRV, SpO2, Body Battery, and Stress score; requires a Garmin Health API partnership (not a free developer program)
- **GarminIcon** — triangle brand mark SVG component (`currentColor`) matching the Garmin logo
- **Garmin sync button** — appears in the fixed topbar alongside Fitbit/Withings when connected; shows GarminIcon at rest, spinning sync icon while active
- **Garmin card in Settings → Wellness** — with purple "Experimental" badge, enable toggle, sync range chips + custom input, and inline credential setup form (Consumer Key/Secret/Redirect URI)
- **Garmin-specific metrics in Heart tab** — Body Battery (peak/low) and Avg Stress shown in a dedicated Garmin card
- **Merged activity display** — Fitbit data takes priority; Garmin fills in when Fitbit has no value for a metric (movement, sleep, heart tabs)

### Fixed
- **Nerve Activity (EDA) display** — Withings Body Scan nerve measurement (meastype 226) is raw electrodermal activity in µS, not a 0–100 score; unit corrected from `/100` → `µS` and label updated to "Nerve Activity" to accurately reflect what the API returns

---

## [0.18.0-beta] — 2026-03-29

### Added
- **Per-user Fitbit & Withings credentials** — each user registers their own developer OAuth app; credentials stored in user_settings (multi-user) or app_config (single-user), no admin required
- **Inline credential setup in Settings → Wellness** — when a tracker is enabled but not yet configured, the credential form appears inline with step-by-step instructions; no separate Labs section needed
- **Last synced timestamp** — `/status` routes now return `lastSyncedAt`; Settings → Wellness shows "Last synced X minutes ago" next to each connected device
- **DEPLOY.md** — full self-hosting guide: Docker Compose setup, all env vars, first-run walkthrough, Fitbit & Withings OAuth app registration steps with required scopes and redirect URI format

### Changed
- Settings → Labs now shows a brief note directing users to Settings → Wellness for credential setup
- Redirect URI suggestion auto-filled from `window.location.origin` (matches actual deployment URL instead of placeholder)

---

## [0.17.0-alpha] — 2026-03-29

### Added
- **Wellness settings section** — dedicated "Wellness" section in Settings (between AI Assistant and Labs) for all user-facing wellness controls: Activity Tracking toggle, Sync Mode selector, and per-integration cards (Fitbit + Withings) each with an enable toggle, sync range (chips + custom input), and a 4-state connection UI (loading / connected+disconnect / configured+connect / admin-required)

### Changed
- Settings → Labs now contains only admin API credentials (Fitbit Client ID/Secret, Withings Client ID/Secret); all operational controls moved to the new Wellness section
- Non-admin users see an info card in Labs noting that credentials are managed by an admin

---

## [0.16.0-alpha] — 2026-03-29

### Added
- **Sliding pill tabs** — `Tabs.svelte` now uses an animated sliding pill indicator (same transition as BottomNav) on Foods (Foods/Meals/Recipes), MealEditor picker, and anywhere else the `<Tabs>` component is used
- **Wellness tab bar pill** — Wellness Movement/Sleep/Heart/Body/Trends tab bar gets the same sliding pill treatment
- **Wellness sync buttons in topbar** — Fitbit and Withings sync buttons are now fixed to the top-right corner (same row and height as the hamburger menu), portalled to `document.body` so they stay on screen while scrolling; each shows its brand logo at rest and a spinning sync icon while active
- **FitbitIcon + WithingsIcon** — monochrome SVG brand mark components (`currentColor`) for use anywhere in the app
- **Disconnect in Settings** — Fitbit and Withings each show a "Connected device" row (with account ID) and a Disconnect button inside Settings → Labs; connection status fetched when Labs section opens
- **Custom sync range** — Fitbit and Withings sync range now support any number of days via an inline number input alongside the preset chips; input highlights accent when a custom value is active
- **Multi-select in MealEditor ingredient picker** — checkbox-based multi-select across all three tabs (Foods, Meals, Recipes); selecting multiple items opens a stacked per-item portion sheet before batch-adding; single tap still opens the single-item flow

### Changed
- Wellness sync bars removed from content area — sync is now always accessible from the fixed topbar buttons regardless of active tab
- Wellness disconnect moved from topbar to Settings → Labs (more appropriate home for device management)
- Settings Appearance: Celebrate goals, Page banners, Loop banner animations descriptions now render below the label (block `<div>`) instead of inline (`<span>`), consistent with Persistent sidebar

### Fixed
- Wellness sync buttons now stay visible while scrolling (portal + position:fixed, unaffected by Svelte fade transition stacking context)

---

## [0.15.0-alpha] — 2026-03-28

### Added
- **AI wellness context** — AI Buddy now includes today's Fitbit and Withings data (steps, active minutes, sleep, HR, HRV, weight, body fat, etc.) in its system prompt so it can speak to your full health picture
- **Wellness goal celebrations** — metric cards pulse with the same `goal-pulse` animation as Diary when a tracked metric (steps, active minutes, sleep duration) crosses its goal for the day; respects the "Celebrate goals" and "Disable animations" settings

### Changed
- Wellness tab bar now uses `flex: 1 0 auto` so tabs are equally spaced on wide screens and horizontally scrollable on mobile without shrinking

### Fixed
- Wellness tab bar buttons were all left-aligned on desktop after the scroll fix; restored equal distribution while preserving scrollability on small screens

---

## [0.14.0-alpha] — 2026-03-28

### Added
- **WellnessBanner** — animated SVG banner for the Wellness page header: shoe-print trail walking left→right with sequential stamp animation, floating Zzz's looping upward beside a crescent moon, and twinkling stars; dual radial glow gradients (warm left / cool right); full `no-anim` / `no-loop` class support and `prefers-reduced-motion` media query
- **Fitbit sync range** — Settings → Labs: chip selector for how far back the manual Sync button fetches (1 day / 1 week / 1 month / 3 months / 1 year); auto-sync always covers today only; server supports `{ from, to }` range with 250ms throttle and 429 rate-limit detection

### Changed
- Sidebar version string updated to v0.14.0-alpha
- Wellness tab restored to Statistics' slot in BottomNav; Statistics restored alongside it; Wellness only appears when the `wellnessEnabled` setting is on; Wellness inserts after Foods (where Water used to be)
- Foods/Meals/Recipes multi-select: searching no longer clears selection; only switching tabs resets it

### Fixed
- Water card banner title position corrected from `padding-bottom: 52px` to `16px`
- Wellness title: removed inline icon from h1 to match all other page headers
- Fitbit OAuth redirect: callback redirected to `/?fitbit=connected#/wellness` (real query string) instead of `/#/wellness?connected=1` (inside hash fragment) — the latter caused svelte-spa-router to fall through to `* → Diary`
- Fitbit OAuth callback URL: the correct redirect URI to register in the Fitbit developer portal and in Settings → Labs is `https://your-domain.com/api/wellness/fitbit/callback`

---

## [0.13.0-alpha] — 2026-03-28

### Added
- **Wellness section** — new nav entry (replaces the Stats slot in BottomNav; sits between Foods and Goals in Sidebar) with dedicated `/wellness` route; powered by Fitbit integration with full OAuth 2.0 PKCE flow
- **Fitbit integration** — connects to Fitbit API to sync: Steps, Distance, Floors Climbed, Active Minutes, Calories Burned (Movement tab); Sleep Duration, Efficiency, Deep/Light/REM/Wake stages with visual stage breakdown bar (Sleep tab); Resting Heart Rate, HRV (RMSSD), SpO2, Respiratory Rate (Heart tab)
- **Wellness DB tables** — `wellness_data` (source-keyed per-metric storage for future Garmin/Withings/Google Health support) and `fitbit_tokens` (per-user OAuth tokens) added to SQLite schema
- **Settings → Labs section** — new "Experimental" section with Activity Tracking toggle, auto/manual sync mode selector, and Fitbit API credential fields (Client ID, Client Secret, Redirect URI with auto-suggested value + copy button); credential fields shown to admins only in multi-user mode
- **Fitbit OAuth server routes** — `GET /api/wellness/fitbit/authorize` (PKCE redirect), `GET /api/wellness/fitbit/callback` (token exchange), `POST /api/wellness/fitbit/sync` (fetch all metrics), `GET /api/wellness/fitbit/data` (read stored data), `DELETE /api/wellness/fitbit/disconnect`
- **Wellness goals** — Steps, Active Minutes, and Sleep Duration goal fields in Goals page when Wellness is enabled (both "Your Goals" and "All Fields" tabs)
- **Date navigation on Wellness** — browse historical data by day (same UX as Diary); auto-sync on open with 15-minute cooldown when sync mode is set to auto

### Changed
- BottomNav: Stats tab replaced by Wellness (`monitor_heart` icon); Stats remains accessible via Sidebar and Settings start-page
- BottomNav Stats tab replaced by Wellness (`monitor_heart` icon); Stats remains accessible via Sidebar

---

## [0.12.0-alpha] — 2026-03-28

### Added
- **Water card in Diary** — the `water_drop` topbar button now opens a full-featured sheet: animated SVG bottle (fill, wave, overflow drip effects), amount/goal stats, progress bar, quick-add container grid with custom-amount input, and a deletable per-entry log; works for any diary date (not just today)
- **Water card banner** — WaterBanner (waves, drops, bubbles) rendered as a 110px strip at the top of the sheet, matching the visual style of all other page banners; "Water" title overlaid at bottom-left in gradient text, consistent with every other page header
- **Water card empty state** — faded water drop icon + "No water logged yet today" message shown when no water has been logged, matching the standalone Water page
- **First-run integrations step** — new wizard step between activity and summary; cards for Open Food Facts, USDA FoodData Central, Mealie, and AI Buddy; each individually skippable; AI card auto-hidden if configured via env vars; all saved values written to `user_settings` (included in backup)
- **PWA offline fallback** — `public/offline.html` served by the service worker when the server is unreachable during a cold open; branded "Can't reach your server / Try again" page instead of a browser error
- **Server-error banners** — Diary and Foods show a subtle inline "Could not reach server — retry" banner when the initial data load fails; Foods suppresses the "no items" empty state during an error

### Changed
- Water page removed — standalone `/water` route, nav entry (bottom nav, sidebar), and Settings start-page option all removed; all functionality lives in the Diary water card
- `alert()` calls replaced with `showError()` toasts in FoodEditor (camera denied, OFF upload failures)

### Fixed
- Water card banner title position matches page-header banner proportions (`padding-bottom: 52px`, title at bottom-left)
- Quick-add container buttons centered in the sheet (flex-wrap with `justify-content: center`)

---

## [0.11.0-alpha] — 2026-03-28

### Added
- **Diary multi-delete** — long-press any diary item → action sheet → "Select multiple" to enter select mode; circles appear on each item, header shows count with cancel and trash; batch removes all selected in one write
- **Multi-select when adding food** — in pick mode (Diary → Foods), circle button on each row toggles selection independently of the row tap; header confirms selection count with a check button; stacked portion sheet for multiple items when prompt-quantity is on
- **OFF upload verification** — after contributing to Open Food Facts, app waits 3 seconds then does a follow-up barcode lookup to confirm the product is live; shows "Confirmed" or "Submitted — may take a few minutes" with a direct link to the product page
- **OFF duplicate check** — before uploading to Open Food Facts, checks if the barcode already exists; warns the user that uploading will update an existing community entry, with option to cancel or continue
- **Hover tooltips** — every icon-only button across the app now shows a description on hover (native `title` attribute); covers all navigation, action, editor, and utility buttons
- **Branded email templates** — invite and password reset emails redesigned with NutriTrace logo, "Trace Every Bite" tagline, mint accent stripe, and CTA button; automatically switches between dark and light layouts based on the recipient's OS preference (`prefers-color-scheme`); copyright footer

### Changed
- Thumbnails increased from 40–44 px → 52 px across Foods, Diary, and MealEditor for improved readability
- "Share to OFF" button now shows "Submitted!" on success (previously "Contributed!")

### Fixed
- `contributeToOFF` was accidentally defined inside `_USDA_NUTRIENT_MAP` object instead of `API`, causing "is not a function" error on every OFF upload attempt
- UTC vs. local timezone mismatch in Goals page (today's totals were fetching the wrong diary date for US timezones); same fix applied to Foods yesterday's meals lookup

---

## [0.10.0-alpha] — 2026-03-22

### Added
- **Animated page banners** — optional decorative banners on all main routes (Diary, Foods, Water, Goals, Statistics, Settings); can be disabled in Appearance settings; Foods banner features a typewriter "Today's Menu" animation with floating food silhouettes (fork, apple, carrot, spoon)
- **Full-screen ingredient picker in MealEditor** — tabbed overlay (Foods / Meals / Recipes) with search; replaces the previous inline search
- **Water goal moved to Goals page** — consolidated alongside nutrition and body stat goals; removed from Settings
- **Env-var config locking** — SMTP and other server settings can be set via environment variables in `docker-compose.yml`; locked fields are disabled in the Settings UI
- **Sign-out button** — added to sidebar footer in multi-user mode
- **Per-meal icons in action sheet** — "Move to meal" sheet shows the correct meal icon for each slot
- **Scroll position preservation** — Foods page restores scroll position after adding a food to diary and navigating back
- **Backup improvements** — upload & restore from a local ZIP file; mobile-optimized backup table layout

### Changed
- Settings page restructured and reworded throughout; all sections have descriptions
- Goals page: "Your Goals" tab now categorized (Body Stats / Nutrients / Water)
- Diary header layout: date navigation above the title, action icons fixed top-right (same level as hamburger)
- Service worker no longer precaches `index.html` — eliminates stale UI after deploys
- Camera constraints simplified — no longer requests a specific resolution, fixing narrow viewfinder on portrait phones

### Fixed
- Recipe nutrition not preserved when added to diary
- Recipe nutrition not scaling correctly when portion size changes in editor
- Waistline recipe nutrition not scaled to portion size on import
- Diary edit sheet not rescaling nutrition when serving size is changed
- FoodsBanner silhouettes collapsing on desktop (percentage height had no resolved parent)
- Scroll restoration using incorrect method on some browsers
- Broken ingredient images from stale Waistline image paths
- Banner scaling distorting on wide/desktop screens
- Goals page reactive statements not updating when totals changed
- PWA manifest corrected so app installs standalone instead of as browser shortcut
- HTTP caching disabled on all API calls — prevents stale data after import or restore

---

## [0.9.0-alpha] — 2026-03-10

### Added
- **Goal templates** — save and apply named sets of nutrition/macro goals
- **Settings search** — filter all settings by keyword
- **Drag-to-reorder** — meal names, visible nutrients, and body stats order all drag-reorderable in Settings
- **Photo URL input** — add a photo to any food, meal, or recipe via a direct URL
- **Waistline Android import** — import foods, diary entries, meals, recipes, and images from a Waistline backup
- **GitHub Actions CI** — pushes to `main` automatically build and publish `ghcr.io/traceapps/nutritrace:latest`
- **Proportional nutrition scaling** — lock icon in FoodEditor scales all nutrients proportionally when serving size changes; real-time preview as you type

### Changed
- Food, meal, and recipe list cards redesigned — shows calories per default portion
- Trans fat, polyunsaturated fat, and monounsaturated fat set to hidden by default
- Sodium visible by default; salt hidden by default (US Nutrition Facts convention)
- Settings: drag-to-reorder nutrients and body stats order

### Fixed
- Meal/recipe nutrition totals showing 0 kcal in list view
- Proportional scaling math and snapshot logic
- Category import and add/remove bugs in FoodEditor
- Waistline import: base64 images uploaded to server, ingredient references resolved, image URLs corrected

---

## [0.8.0-alpha] — 2026-03-01

### Added
- **SQLite backend** — all data migrated from IndexedDB to a server-side SQLite database via Express API
- **Docker support** — single multi-stage container (Svelte build + Express server); `docker compose up -d`
- **Optional user management** — JWT authentication, user profiles, admin/user roles, invite system (email or copyable link)
- **Password reset** — forgot password flow via email with time-limited token
- **Full server-side backup** — creates a ZIP of all data + uploaded images; download, restore, or delete from Settings
- **Server-side settings sync** — settings tied to account; persist across devices and survive container rebuilds
- **Mealie integration** — browse and import recipes from a self-hosted Mealie instance (proxied server-side)
- **AI Buddy** — floating chat panel with multi-provider AI support (OpenAI, Anthropic, etc.) for nutrition questions
- **Water tracking** — log water intake by container type; progress shown in diary and statistics
- **USDA FoodData Central** — search the USDA database directly from the Foods page
- **Open Food Facts contribution** — share locally-created foods back to the OFF database
- **Session timeout** — configurable (never / 8h / 1d / 7d / 30d / 90d / 1y); admin-only setting
- **Appearance settings** — theme (light/dark/system), accent color, nav style, animation toggle
- **Barcode scanner** — scan barcodes to look up foods via Open Food Facts
- **Camera photo capture** — take or crop photos for foods and meals directly in the editor
- **Statistics page** — charts for calories, macros, weight, and other tracked values over time; bar and line modes
- **README** — setup and configuration guide

### Changed
- Renamed from Waistline Web to **NutriTrace** — new logo, name, and Docker image
- Serving size editable directly in the add-to-diary prompt and diary edit sheet

### Fixed
- OFF search switched from deprecated CGI endpoint to working search API
- Proxy added for OFF and USDA requests to avoid CORS errors
- Nutrition calculation: values correctly treated as per-serving, not per-100g

---

## [0.1.0-alpha] — 2026-02-15

Initial release — Svelte 4 PWA forked from Waistline Web concept.

### Added
- Diary with meal groups, daily macro summary, and calorie progress bar
- Foods database — add, edit, and delete custom foods
- Meals and recipes — group foods into reusable meals; recipes scale by portion
- Goals — set calorie and macro targets with progress indicators
- Settings — units, date/time format, display preferences, meal name customization
- Open Food Facts integration — search and import foods by name or barcode
- IndexedDB local storage — all data stored on-device, no account required
