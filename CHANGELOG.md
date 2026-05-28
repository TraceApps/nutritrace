# Changelog

All notable changes to NutriTrace are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [1.0.0-rc.41] - 2026-05-28

### Fixed

- **Settings: long labels next to dropdowns rendered vertically.** Some
  rows like Water → Display Unit were squeezing the label down to a
  single-character column and stacking it letter by letter. Capped the
  small-dropdown width so labels render normally again.
- **OFF local mirror: scanning a UPC-A barcode no longer makes a
  pointless call to the public OFF API.** Scans now use the same
  canonical 13-digit format Open Food Facts stores its codes in, so the
  local mirror hits on the first lookup instead of after a roundtrip.
  (Issue #22 followup, reported by duplaja)

---

## [1.0.0-rc.40] — 2026-05-28

### Fixed

- **Diary: meal kcal footer truncated meals over 1000 kcal.** The per-meal
  subtotal at the bottom of each diary card was dropping digits after the
  thousands comma, so a 1,234 kcal lunch displayed as "1 kcal".
  (Issue #51, reported by LoveHonorGirth)
- **OFF local mirror: barcode scans threw a JS error on the client.** The
  Parquet schema adapter assumed `product_name` lists were always real
  Arrays, but the DuckDB Node API can return list-like iterables that
  broke the assumption and leaked through as a non-string field, crashing
  the client's `.trim()` call. Now coerces to a real Array up front and
  guarantees a string output in both schema branches.
  (Issue #22 followup, reported by duplaja)

### Changed

- **OFF local mirror Docker example now uses a parent-directory bind
  mount** (`./off-mirror:/data/off-mirror` with
  `OFF_LOCAL_DB=/data/off-mirror/off.parquet`) across `docker-compose.yml`,
  `DEPLOY.md`, and `.env.example`. The previous single-file bind-mount
  example tripped Docker's auto-create-as-directory behavior on a fresh
  host path, which then broke the atomic-swap refresh with `EISDIR`.
  Existing setups that already work are unaffected. (Issue #22 followup)

### Added

- **Per-query debug logs for the OFF local mirror.** With
  `LOG_LEVEL=debug`, every barcode and name-search lookup now prints
  whether it was served from the local mirror or fell through to the
  remote OFF API, with hit counts for searches.
- **Loading indicator for barcode scan lookups.** Slow Open Food Facts
  lookups (cold local-mirror queries, overloaded remote API, sluggish
  networks) used to leave the user staring at the Foods tab between
  camera close and editor open with no feedback. A centered "Looking
  up barcode" card now appears if the lookup hasn't returned within
  400ms; fast lookups still flash nothing. Library hits remain instant
  with no indicator.
- **Body Water % as a body stat.** New manual-entry field on the body
  stats sheet, alongside Body Fat %. Withings already auto-syncs this
  via type 77 (and continues to), so connected users see it without
  typing; non-Withings users can now log the number their smart scale
  displays. Available as a metric on Goals, Statistics, and the
  Settings visibility toggle list, with the same hide-by-default
  behavior as other optional body stats. (Issue #52, requested by
  LoveHonorGirth)

---

## [1.0.0-rc.39] — 2026-05-27

### Added

- **OIDC RP-initiated logout (PWA + Android).** Signing out now also ends the
  session at your identity provider, so the next sign-in isn't silently
  completed by a still-alive IdP session. Requires registering two Post Logout
  Redirect URIs at your IdP (HTTPS root for PWA, `nutritrace://oidc-callback`
  for Android). Thanks to @jimmielightner. (Issue #48, PR #49)
- **Edit any Quick Calories entry.** Tap a Quick Calories row in the diary to
  change the kcal, name, or any of the three optional macros.

### Changed

- **OFF local mirror now uses the Hugging Face Parquet snapshot** since OFF
  retired the previous DuckDB source. Existing setups keep working without
  renaming; format is auto-detected. (Issue #22 followup)
- **Quick Calories diary row uses your custom name** when a meal has just one
  Quick Calories entry. Multi-entry meals still collapse to "Quick Calories × N".
- **Diary edit sheet macro pills get the four-color treatment** (yellow / purple
  / green / orange) to match the Quick Calories card and Foods quantity sheet.
- **Number-input spinner arrows removed app-wide** across food, meal, recipe,
  and diary edits.

### Fixed

- **Docker image now actually loads DuckDB.** Base swapped from Alpine to
  Debian-slim so the OFF mirror feature works end to end. Image grows ~30 MB.
  (Reported by duplaja)
- **Goals: body-stat fallback now appears on the initial "Your Goals" tab**
  instead of only after switching tabs. (Issue #46 followup from duplaja)
- **Quick Calories: macro input width grows with the typed value** so the "g"
  stays flush against the digits regardless of length.

---

## [1.0.0-rc.38] — 2026-05-25

### Added

- **Gradient page banners.** New Settings → Appearance → Page Banners dropdown (Animated / Gradient / Off). Gradient is a compact, accent-tinted header with a glassy backdrop: middle ground between the tall illustrated banners and the bare compact header. New installs default to Gradient; existing users keep whatever they had. Header action buttons (water, stats, kebab, etc.) get a frosted-pill treatment in Gradient mode so they stay readable against the accent backdrop.
- **Quick Calories** (Issue #42). Bolt button on each meal section opens a fast-entry sheet for logging just calories without food or portion data, Fitbit-style. Honors your energy unit (kcal / kJ). Optional protein / carbs / fat fields under the kcal input for MFP-style "log the macros from the label" use. Settings → Diary toggles to show/hide the button and choose Summed or Separate display when you have multiple Quick Calorie entries in one meal. Trace AI can also log entries via voice or chat ("log 240 kcal for lunch with 20g protein").
- **Logging streak in Trace.** Ask "what's my food logging streak" and Trace answers from the actual diary: consecutive days walking back from today (or yesterday if today isn't logged yet) until the first gap. Counts any diary engagement (food, water, body stats, notes), matching the typical user mental model of "I tracked today."

### Changed

- **Statistics: days with food but 0 g of a nutrient now count as 0-day entries** instead of being silently dropped (Issue #45). Affects average, min, max, days-logged tally, chart, and history list. Avoiding added sugars on a day you otherwise logged food now shows as a 0 bar, not a blank, and your "days logged" matches across nutrients.
- **Goals: weight, body fat, and measurements fall back to the most recent reading within the last 30 days** when today has no entry (Issue #46). A subtle "as of May 18" subtext under the value tells you the number isn't from today. Encourages weekly weighers without forcing daily re-entry. Nutrient and water goals are unchanged; those reset daily by design.
- **AI assistant: nutrition-history queries no longer capped at 90 days** (Issue #44). The `get_diary_averages` window now goes back up to 10 years, and the tool does a single bulk fetch instead of one HTTP call per requested day, dramatically faster for long-history users (e.g. multi-year MyFitnessPal imports).

### Fixed

- **AI assistant streak hallucinations.** Mini-class models would invent streak numbers instead of calling the streak tool. Your streak is now pre-computed into Trace's context block on every chat round, so the answer is right in front of the model and doesn't depend on it picking the right tool.

---

## [1.0.0-rc.37] — 2026-05-24

### Added

- **Local Open Food Facts mirror** (self-hoster opt-in, env-gated). Point NutriTrace at a local DuckDB copy of OFF and barcode + name lookups hit it first for instant, network-free responses. Stale-mirror false negatives auto-heal by falling through to the public OFF API on a miss, so a week-old mirror still feels live. True air-gap mode (`OFF_LOCAL_ONLY=1`) blocks all remote traffic, including OFF account uploads. See `DEPLOY.md` → Local Open Food Facts mirror for the full setup. (Issue #22)
- **In-app refresh control for the OFF mirror.** Settings → Connected Services → Open Food Facts (admin only) shows mirror size, last refresh, and an Auto-Refresh schedule (Off / Daily / Weekly / Monthly, default Weekly). A Refresh Now button kicks an immediate full download with live progress in the banner. Initial download happens automatically on first boot when the env var is set; no manual `wget` required. Refreshes use atomic swap, so no container restart is needed and a failed mid-flight download never corrupts the running mirror.
- **Connection status banner for push notifications**, matching the pattern used by USDA / Mealie / AI / Wellness integrations. Top-of-card pill shows the configured provider; a Send Test button posts a test notification through whichever delivery method is active.

### Changed

- **Sleep score tuning.** Very short nights (under 5 hours) no longer balloon the deep+REM percentage above realistic ceilings (35% under 5h, 40% under 6h), bringing calculated scores closer to Fitbit's own.
- **About → Disclaimer strengthened.** Spells out the medical conditions NutriTrace is not designed for (diabetes, eating disorders, allergies, pregnancy, breastfeeding, pediatric needs, kidney/liver disease, metabolic disorders), and underscores that Trace AI answers and Open Food Facts data can be incorrect.

### Fixed

- **Bulk-imported foods now sync immediately to Android.** After a successful bulk import on server-connected Android, the app triggers a full sync so the foods appear in the foods tab without waiting 30-60 seconds for the periodic sync. (Issue #39 followup)

---

## [1.0.0-rc.36] — 2026-05-23

### Fixed

- **Bulk-imported foods didn't show up on Android.** The server wasn't stamping `updated_at` on new rows, so the Android differential sync skipped them. PWA was unaffected. Includes a migration that recovers rows already imported. (Issue #39)
- **AI Assistant chat panel could stop opening** after a tool-use round. Duplicate message keys broke the panel render until history was cleared. Keys are now position-stable and the server drops back-to-back identical history inserts. (Issue #40)

### Added

- **Scan Label**. On the Add/Edit Food screen, take a photo of a nutrition label and the AI Assistant fills in the values. Requires AI Assistant to be configured.

### Changed

- **Custom nutriment order is reflected in the food and meal editors.** Reordering nutrients in Settings now changes their display order everywhere.
- **Vitamin D, Calcium, Iron, and Potassium are visible by default** on new installs, matching the FDA's mandatory Nutrition Facts label fields.

### Fixed

- **kcal/kJ inconsistencies when energy unit was set to kJ.** Food editor, diary footer, meal totals, statistics charts, goals, weekly summary email, and push notifications all respect the chosen unit now. Internal storage stays kcal; only the display converts. (Issue #38)
- **Single-user mode: only the first food item added each day was visible** in the UI. A SQLite quirk meant NULL user_id rows never collided on upsert, so each save inserted a new row instead of updating. A one-time migration on first boot recovers items already in the database. (Issue #37)
- **AI features failed on Android when configured via server env vars.** Smart Log voice (Trace hold-to-record), Scan Label, the chat panel, and Goal Insights all routed through a code path that didn't send the auth token Android needs, so calls returned 401 even though the env-lock was set correctly. The voice path also threw "AI provider not configured" before it ever reached the proxy. Both gaps are closed. (Issue #36 followup)

---

## [1.0.0-rc.34] — 2026-05-22

### Fixed

- **Trace AI chat showed "API key required" when AI was configured via env vars but no per-user key was set.** The chat panel's setup gate was checking the per-user key only and didn't know about env-locked configuration. Users who only set `AI_API_KEY` in env (never opened Settings to configure a per-user key) couldn't get past the setup screen even though the proxy was correctly handling auth on the server side. (Issue #36)

---

## [1.0.0-rc.33] — 2026-05-22

### Fixed

- **Trace AI chat said "API key required" even with `AI_API_KEY` set in env.** The chat path was using a separate code path from Settings → Test, which is why the test button said "Connected" but the actual chat refused to send. (Issue #36)

---

## [1.0.0-rc.32] — 2026-05-22

### Fixed

- **Barcode scanner stuck after a scan**. The camera could get stuck re-opening until Android refused.
- **AI Assistant env vars**. Setting `AI_ENABLED=true` in compose now actually enables the assistant (was locking the toggle OFF). Removing AI_* env vars and restarting now properly unlocks the UI. (Issue #36)

### Changed

- **Barcode that doesn't match Open Food Facts** now opens the food editor with the barcode pre-filled so you can enter it and contribute back.
- **Share to OFF** is now smart: the button flips to "View on OFF" for products already on Open Food Facts, opening the wiki page where edits actually take effect.
- **Open Food Facts contribution** now sends nutrition correctly when your portion isn't 100g, and uploads your product image. Both were broken silently before.

---

## [1.0.0-rc.31] — 2026-05-22

### Fixed

- **Data APIs in single-user mode**. After disabling user management, the diary, foods, meals, and app-config endpoints were returning 503 "Setup required" on every call. The rc.30 fix patched the wizard redirect, but a separate server-side setup gate was still blocking data APIs. Both gates now respect the same single-user-mode flag. (Issue #34)

---

## [1.0.0-rc.30] — 2026-05-22

### Changed

- **Framework upgrades**. Svelte 4 → 5, Vite 5 → 6, Express 4 → 5, bcryptjs 2 → 3, plus the supporting Vite plugin bumps. Compat mode keeps the existing component code working without rewrites. The main app bundle drops about 22% (1.57 MB → 1.21 MB) and the underlying Svelte 4 SSR security advisories no longer apply.

### Fixed

- **Disabling user management was sending you back to the setup wizard** on every reload. The server now remembers that user management was intentionally disabled and lets you back to the diary. (Issue #34)
- **Import Nutrition History action row could visually overlap** the Skip / Merge / Replace radios when re-importing a file with duplicate dates. (Issue #33)
- **Wellness scores now refresh** when today's sleep data finishes syncing after the morning snapshot ran, so the readiness number reflects the latest sleep input rather than getting stuck on the first incomplete value.

### UI polish

- The live nutrition preview pills on the Add to Diary sheet now match the diary's macro color scheme (calories yellow, protein purple, carbs green, fat orange).

---

## [1.0.0-rc.29] — 2026-05-21

### Fixed

- **Food no longer duplicates on the server when saving several new foods back-to-back on Android (server-connected mode).** A race between the immediate save POST and the background sync push could insert a second copy of the previous food. Saves now go through a single sync path. PWA and native-local users were not affected. (Issue #32)
- **"Most Used" and "Recently Used" food sort orders now work on Android.** The sync engine was dropping usage counters when pulling foods and meals from the server, so the local sort keys never reflected real usage. Counters from the server (including favorites) now flow into the local mirror correctly. PWA was unaffected. Existing counters catch up the next time each food or meal is edited; a fresh sign-out / sign-in also forces a full re-pull.

---

## [1.0.0-rc.28] — 2026-05-20

### Added

- **Bulk Food Import** in Settings → Import & Export. Paste a JSON snippet or upload a CSV to add many foods at once. Download a template right from the modal. The template is built from the live nutrient catalog, so any future nutrient will appear in it automatically. Useful for users who want to paste an LLM-extracted nutrition label or sweep in a hand-rolled spreadsheet. (Issue #21)
- **Live nutrition preview** on the Add to Diary sheet. Calories plus protein, carbs, and fat update as you change serving size, unit, or number of servings. (Issue #30)
- **Mass-aware unit conversion** when scaling nutrition. Changing the unit on a food (g, mg, kg, oz, lb, ml, l, tsp, tbsp, fl oz, cup) now actually converts the nutrition values. Previously the unit was just a label and the math ignored it. The full list of which units convert is documented in the project README. (Issue #29)
- **Custom Units**. Add your own units (e.g. "shot", "scoop", "stick") in Settings → Custom Units. They appear under a Custom group in every unit picker. Custom units do not get mass conversion since they have no fixed gram weight; they scale by portion count only. The Settings card explains this on the spot.
- **Day rollover**. If you leave NutriTrace open overnight and reopen it the next morning, the diary now auto-advances to the new today. Same for tabs that stay open across midnight.
- **Connection status banners** across every integration. AI Assistant, Mealie, USDA, SMTP, Fitbit, Garmin, Withings, and Health Connect each show a consistent banner with current status and a one-tap Test / Sync / Disconnect button.
- **Sync Now** button on the Settings cards for Withings, Garmin, and Health Connect. Previously only Fitbit had one in Settings.

### Changed

- **AI Assistant Google Gemini models updated.** Added Gemini 2.5 Flash (new default for the Gemini provider, free-tier eligible) and Gemini 2.5 Flash Lite. Removed the older Gemini 2.0 Flash (Google deprecated it Feb 18, 2026, shutting down June 1, 2026) and the legacy Gemini 1.5 Flash fallback (Google already shut it down). If you had one of the retired models selected, you're auto-migrated to Gemini 2.5 Flash. (Issue #27)
- **Food Editor proportional scaling default is now context-aware.** Editing an existing food opens with proportional scaling ON (so changing serving size preserves density). Adding a new food from scratch opens with it OFF (so typing label values one-by-one doesn't silently cross-scale). You can flip it either way with the link icon next to the unit field. (Issue #28)
- **Settings reorganized.** The previous "Import from another app" section was merged into a new "Import & Export" section that houses every flow that moves food data in or out: JSON backup import/export, Bulk Food Import, MFP/Cronometer/LoseIt diary importer, and Diary-as-CSV export.
- **Settings auto-save by default.** Most settings now save automatically when you change them, instead of needing a Save button click. Includes the AI Assistant key + Base URL, Mealie URL + token, USDA key, all SMTP fields, session duration, and other text/dropdown settings. The wellness Connect buttons (Fitbit, Garmin, Withings) still need an explicit click since they trigger an OAuth flow.
- **Unit picker is uniform across the app.** Food editor, meal editor, recipe yield, Add to Diary, diary edit, and multi-portion sheets all use the same grouped picker with categories (Mass Metric/US, Volume Metric/US, Count). Free-text input is no longer accepted in the picker; add your own units in Settings → Custom Units if you need something off the catalog.
- **Compact page header** when banners are disabled. If you have page banners turned off in Settings → Appearance, the title now sits beside the menu button instead of below it, freeing roughly 40 pixels of vertical space on every page. (Parity with LiftTrace's compact header.)
- **Barcode scanner switched to a fully on-device path on Android.** No longer requires Google Play Services to scan a barcode. Same scanning engine and accuracy as before. Works on degoogled Android ROMs (GrapheneOS, /e/, CalyxOS). The PWA scanner is unchanged. (Issue #31)

### Fixed

- **Diary item edit sheet** now scales nutrition correctly when you change the unit. The live macro pills above Save reflect the change in real time.
- **Water log sheet's close button** stays visible when the content scrolls.
- **Title-case slips** across various dropdown options, dialog labels, and button text.
- **Dark-mode black text** on the new Settings → Import & Export rows.

### Security

- **nodemailer updated** to 8.0.7 (was 8.0.3). Patches two open SMTP command-injection advisories (envelope.size parameter, CRLF in transport name). Only affects servers configured with outbound SMTP for invites and password resets.

---

## [1.0.0-rc.27] — 2026-05-18

### Fixes

- **MyFitnessPal import now handles the current export from Reports → Export.** The export at myfitnesspal.com/reports/export is aggregated per meal per day (no Food column), and the importer was rejecting it as unrecognized. Importing now creates one diary entry per meal per day with brand "MyFitnessPal" and the meal's macro + mineral totals preserved. Individual foods can't be reconstructed because they aren't in the export. The older per-food Premium ZIP shape is still supported when present.
- **MyFitnessPal import error now shows the actual columns it saw.** Any future MFP-import failure includes the header row in the error message so it's possible to tell at a glance whether MyFitnessPal has changed the export format again.

---

## [1.0.0-rc.26] — 2026-05-17

### Fixes

- **Wellness page now populates on first load for Health Connect users.** Previously the data only appeared after navigating to a different day and back. Health Connect now counts as a connected source when deciding whether to fetch on page load.
- **Mealie connection Test button.** The Test button was always reporting "Failed" because the request was missing the CSRF token. The actual Mealie integration was unaffected (recipe search from Foods worked correctly), but the misleading Failed indicator made it look like the integration was broken. Test now matches the runtime path.
- Foods page no longer logs a "Function called outside component initialization" error to the console on load.

---

## [1.0.0-rc.25] — 2026-05-16

### Fixes

- **Health Connect updates throughout the day now reach the server.** When Health Connect re-read a metric (e.g. step count went from 500 to 1,382 as the day progressed), the local row updated but stayed marked as already-synced, so the next push to the server skipped it. The server kept the early value and the web showed a stale snapshot. Now any value change re-queues the row for push.

---

## [1.0.0-rc.24] — 2026-05-16

### Fixes

- **Health Connect data now populates the web Wellness page tiles, sparklines, sleep insights, and the readiness card.** Final piece of the Health Connect pipeline (after rc.22 and rc.23). The web's data endpoint now returns Health Connect rows alongside Fitbit rows, and the sparkline / sleep insight / readiness fetches now fire for Health Connect users (not just Fitbit users), so the synced metrics fully populate the Wellness page.

---

## [1.0.0-rc.23] — 2026-05-16

### Fixes

- **Health Connect data now renders on the web Wellness page.** Companion fix to rc.22. The server stores Health Connect entries synced from Android, and the web app now recognizes Health Connect as an active integration so the data shows up in the Activity / Sleep / Heart / Body tabs (managed from your Android app's Settings → Wellness).

---

## [1.0.0-rc.22] — 2026-05-16

### Fixes

- **Health Connect data now flows to the web app.** Health Connect entries synced from the Android app push up to the server during differential sync, so the same data renders in the web Wellness page and on any other connected device. Existing Health Connect history on a device backfills automatically on the first sync after this update.

---

## [1.0.0-rc.21] — 2026-05-15

### New Features

- **Recipe yields.** Recipes can now declare how many servings they make. Set "Yields" in the recipe editor and adding one serving to the diary uses per-serving weight + nutrition. Existing recipes keep their old behavior until you set a yields value.
- **Per-serving Open Food Facts import.** New option in Settings → Connected Services → Open Food Facts → Import Portion As. When set to Per Serving, barcode scans and OFF searches prefill the food with per-serving values whenever the product has serving data on OFF.
- **Intermittent Fasting tracker.** Track fasts from a Diary widget: default goal, last-fast hint, named custom-hour presets, history with delete, and a recurring schedule that auto-starts a fast on chosen days at a chosen time. Tap the start time on an active fast to edit it inline.
- **Android biometric sign-in.** Fingerprint and face unlock for the Android app in server-connected mode. Toggle in Profile.
- **Adaptive TDEE.** Calorie Goals can learn your true daily energy expenditure from a rolling 35-day window of weight and diary trend, instead of the static Harris-Benedict estimate.

### Improvements

- Settings forms use sliding-pill segmented controls. Goals section renamed to Calorie Goals.
- Sharing rework: per-category sharing form, source filter on Meals/Recipes, and read-only editors when viewing someone else's shared food.
- User management: invite by email, revoke pending invites, block invites to existing accounts. Optional zxcvbn-backed password strength policy.
- Wizard summary clarifies the TDEE label and shows the goal-factor math.
- Android local-only mode reaches feature parity with server mode for Adaptive TDEE and the Fasting tracker.
- AI Assistant (Trace) gains two new tools: `get_adaptive_tdee` and `get_activity_log`.
- `INSECURE_COOKIES` env var is now documented in `.env.example` and the README env-vars table. Required for self-hosters on plain HTTP without TLS in front.

### Fixes

- Wrong food images in the diary (cross-pollination across foods that share an Open Food Facts basename). Diary images are now live-resolved from the current foods and meals tables on every read, routed by recipe vs food, and disambiguated by brand.
- Duplicate food rows when scanning the same barcode in rapid succession.
- Invite "stuck on Creating…" when the email field was invalid.
- Password policy now persists when saved.
- Revoke invite no longer surfaces a fake "Failed to fetch" message.
- Session config loads correctly on Android by sending auth headers on the initial GET.

---

## [1.0.0-rc.17] — 2026-05-04

### Food Sources
- **Open Food Facts** now has its own enable/disable toggle in Settings → Food Sources, defaulting on. Privacy-conscious users can opt out of OFF queries; the source picker on the Foods page hides OFF when disabled.
- OFF moved above USDA in the Food Sources section to reflect that it's the primary search source.
- USDA description now links directly to the free API key signup at `fdc.nal.usda.gov`.
- The OFF account section clarifies that an account is only required to upload edits — searching works without one — and links to the OFF account signup.

### Wizard
- Integrations step gets the same signup links on the OFF and USDA cards, and the OFF subtitle now describes it as a search source rather than just an upload destination.
- Integration summary at the bottom of the step no longer mis-labels cards as "Skipped" when you simply hadn't filled in credentials yet. Only cards you explicitly clicked "Skip this" on count as skipped now.

### Persistent sidebar (tablet / desktop)
- Fixed a layout bug where pinning the sidebar caused page banners and the right edge of content to clip. Affected Diary, Foods, Wellness, Statistics, Goals, and Settings.
- Fixed a gap between the page header and sticky sub-bars (Foods filter, Diary date picker, Settings search, Wellness date + tab bars) when the sidebar was pinned.
- Fixed the persistent-sidebar toggle silently flipping itself off after about 30 seconds. Cause: form-factor preferences were being overwritten by stale server values on every settings sync.
- Persistent-sidebar toggle is now correctly hidden on phones (768px viewport required) and reacts to live tablet rotation between portrait and landscape.

---

## [1.0.0-rc.16] — 2026-05-04

### Fixed
- **Fresh Docker installs failed at startup with `SqliteError: no such column: email`** in rc.14 and rc.15. A schema-rebuild migration ran before the `email` column was added, so its `INSERT … SELECT email FROM users` couldn't find the column on a brand-new database. Existing installs were unaffected. Reported by @Skilly2, confirmed by @cearum — thanks both.

---

## [1.0.0-rc.15] — 2026-05-04

### Energy units (kJ vs kcal)
- The energy-unit setting is now respected throughout the UI. Previously it was honored for goals and storage, but Diary food rows, the daily summary, the macro ring, the Foods picker, Meal editor, Smart Log, Wizard summary, the Wellness "Calories Burned" tile, the Withings BMR tile, and the Nutrition Import preview all rendered "kcal" regardless of the setting. Reported by an Australian user on Lemmy. Internal storage stays in kcal, only the display layer flips.
- The AI assistant (Trace) now speaks in your chosen energy unit when summarizing workouts and basal metabolic rate, instead of always saying "kcal".
- Statistics now defaults its energy metric to **Kilojoules** when your energy unit is kJ, instead of always defaulting to Calories.

### Wizard
- Now auto-detects your device locale on first run. If your locale is `en-AU` or `en-NZ`, kilojoules are pre-selected; everywhere else still defaults to kcal. You can still toggle either way manually.

---

## [1.0.0-rc.14] — 2026-05-03 — Android app available

### Android app
- NutriTrace is now available as a native Android app, alongside the existing PWA. Download the signed APK directly from the GitHub Releases page.
- **Standalone or connected** — use it pure-offline with everything stored on the device, or connect it to a NutriTrace server for sync.
- **Wellness via deep links** — Fitbit, Garmin, and Withings OAuth flows open the system browser and return to the app via `nutritrace://`.
- **Health Connect** — read steps, sleep, heart rate, body weight, and more from any Health Connect-compatible source. No external account required.
- **Native barcode scanning** via Google's ML Kit, with a Code Scanner fallback.
- **Native notifications** — water reminders, meal reminders, weigh-in prompts, and goal celebrations all schedule through Android's notification system, including in deep doze.
- **OIDC SSO on Android** — Authentik / Keycloak / Pocket ID / etc. open in Chrome Custom Tabs and return via deep link. Same SSO setup as the PWA.

Issues and feedback welcome on GitHub.

### Settings
- **New layout** — Settings now groups sections by frequency-of-use rather than by accident. Goals leads Data & Tracking (was hidden behind setup-and-forget customizations). Notifications moves into the App group. Admins get a dedicated **Admin** group containing Users, Authentication, and Email (SMTP), shown only when relevant. About is the standalone footer.
- **"User Management" → "Users"** since the section is admin-gated and the longer label was redundant.
- **"Delete my account"** is no longer duplicated under Backup & Restore — Profile → Danger zone is the single source.
- **Page banners**, **Show yesterday's meals**, and **Goal pulse animation** descriptions tightened for clarity.

### Wizard
- Target weight now defaults to your current weight instead of a hardcoded "lose 10" placeholder. Tap Next to maintain; nudge it up or down if you're trying to gain or lose.

### About + docs
- Settings → About now shows a platform tag (Android / PWA) next to the version, useful at a glance and for bug reports.
- README Roadmap and Experimental features list updated to reflect what's actually shipping vs still in flight.

### Nutrition Import (Cronometer + Spreadsheet)
- Fixed a bug where imported items had calories multiplied by their gram weight (a 750g entry showed `722,903 kcal` instead of `964 kcal`). Cronometer and Spreadsheet adapters were treating the parsed gram count as a serving multiplier; now each row imports as one diary item with totals already in nutrition. The "NaNg" portion display had the same root cause and is also fixed.
- Visual separation between the duplicate-day radio options and the Cancel / Import buttons in the import preview.

---

## [1.0.0-rc.13] — 2026-05-03

### Authentication (OIDC SSO)
- Configure providers entirely from `.env` or `docker-compose.yml`. Single-provider shorthand uses `OIDC_*`; multi-provider uses `OIDC_PROVIDER_<N>_*`. Anything you define this way shows up in the Settings UI with a lock badge and is read-only there, so the source of truth stays in your config.
- OIDC moved out of User Management into its own top-level Settings section called **Authentication**. README walkthrough rewritten to call out the prerequisite (User Management must be on) up front.

### Settings
- **My Profile** is now a hero card at the very top of Settings, showing your avatar, display name, and an admin pill when applicable. Tap to edit.
- **Log Out** lives inside Profile, next to your name and avatar.
- Profile editing now works in single-user mode (was previously unreachable — the page bounced back).
- Switching between single-user and multi-user no longer loses your wizard-configured settings or profile data.

### AI Assistant
- Trace now has always-available access to your profile: name, nickname, age, gender, height, weight, target weight, activity level. Ask "what's my name" or "how old am I" and you get an answer without a tool round-trip.

---

## [1.0.0-rc.12] — 2026-05-02

### AI Assistant
- New "OpenAI Compatible" provider — point at Ollama, LM Studio, DeepSeek, Groq, or any `/v1/chat/completions` endpoint. Local endpoints don't need an API key.
- Trace greets you by name when you've set one in your Profile.

### Diary
- Portable JSON export now has a self-describing header (version, counts) and restores Activity entries on import.

### Profile
- Polish on linked accounts, security card, and danger zone — content fits properly at any viewport size.

### Diagnostics
- Exported logs lead with a version + platform header so recipients know what they're looking at.

### Fixed
- Nutrition Import "Invalid CSRF token" on Preview — the upload was missing its auth header. Reported by the community.

---

## [1.0.0-rc.11] — 2026-05-02

### Wellness
- Daily Readiness and Stress Management cards now show interpretive copy under the score — a lead sentence based on the band + a driver line that calls out which sub-component (HRV / RHR / Sleep) is dragging things down, with one concrete action.

### Diary
- Diary lines lead with the *actual amount eaten* as the primary number; fractional quantities show an explicit multiplier ("× 1.5") so the math is unambiguous.

### Barcode scanning
- Scans check your existing library first instead of always re-fetching from OFF / USDA.
- Inline scan icon inside the barcode input on FoodEditor — scan without leaving the editor.
- Duplicate-barcode warning when the barcode is already used by another food.
- Leading-zero normalization so scans match library entries that were typed manually.

### Profile + User Management
- Linked-accounts row no longer clips on narrow viewports.
- Manual-add user form restructured — password input no longer squished, role uses a proper chevron-styled select, manual-add and invite read as alternatives separated by a divider.
- Smaller polish to the Security card and Danger Zone delete button.

### Fixed
- Settings → Backup & Restore no longer freezes the page in Android local-only mode.

---

## [1.0.0-rc.10] — 2026-05-01 — Fix stuck "Could not reach server" banner after login

### Fixed
- **Diary banner persistence** — when the app was opened while not authenticated, the diary's pre-login fetch returned 401 and stamped a synthetic empty-day placeholder into the local cache. After signing in, the diary's cache-skip logic saw the placeholder and skipped the fetch — leaving the "Could not reach server" banner up forever even though authenticated requests were now succeeding. Three small fixes: the failed-load placeholder is gone (cache reads as "no entry" so the next mount re-fetches), the diary onMount additionally re-fetches whenever the previous load errored, and a successful login now re-pulls server settings + clears any lingering diary error flag so the next view is clean.

  Same root cause was making **settings appear reverted to defaults** after login (the initial `loadServerSettings()` failed at 401 pre-login and was never retried). Fixed by the same login-transition hook.

  Reported in a community issue against rc.13; same bug existed in rc.9.

---

## [1.0.0-rc.9] — 2026-05-01

### Single Sign-On (OIDC)
- Sign in with your existing identity provider — Authentik, Keycloak, Pocket ID, Authelia, Auth0, Google, or any OIDC 1.0 provider. Settings → User Management → OIDC providers, with a guided picker that pre-fills sensible defaults per IdP.
- Auto-link verified-email accounts on first sign-in (default ON) and an opt-in auto-register-new-users toggle for blanket onboarding.
- Admin role mapping via group claims, runtime password-login disable for OIDC-only instances, and Profile → Linked accounts to attach SSO to an existing password account.
- Client secrets encrypted at rest. Discovery cached, PKCE + state + nonce validated on every callback.

### Import from another app *(experimental)*
- Bring past days into NutriTrace from **MyFitnessPal**, **Lose It!**, **Cronometer**, or a generic spreadsheet. Settings → Import from another app.
- Preview shows day count, date range, and any unmapped meal labels before commit. Per-date conflict policy: skip, merge, or replace.

### Settings reorganization
- Cleaner group structure with renamed sections (Integrations / Food Sources) so labels don't collide.
- Long labels no longer push toggles or icons off-screen on narrower viewports.

### User Management polish
- Inline role change on the user list (with a last-admin guard that refuses to demote the only admin).
- Admin row action to reset another user's password.
- "Delete my account" Danger zone on the Profile page.
- Invite-by-email is now the primary "Add user" path; direct-add stays as a quieter secondary option for environments without SMTP.
- Profile shortcut redesigned with a gradient avatar + role pill.

### Reliability + security
- Sign-out actually signs you out — previously the server cookie wasn't cleared, leaving you in a half-state.
- Theme no longer flashes to defaults every 30 seconds when settings poll.
- Diary doesn't briefly flash meal cards on every tab switch.
- Database migration hardened against a foreign-key cascade that could wipe per-user data on upgrade. Existing deploys are unaffected going forward.
- Sync engine repopulates server-side rows that go missing, instead of silently dropping the change.
- Photo uploads downscale before saving, so phone photos no longer silently fail to save when they exceed the server's payload limit.
- Forgot-password endpoint timing-padded so response time can no longer be used to enumerate registered emails.
- JWT rotates on password change, so old sessions on other devices stop working.
- Stress score recalibrated against accumulated calibration data.

### For self-hosters
- Backups now include OIDC providers and per-user links. `client_secret` is encrypted in the dump; restoring to a host with a different `JWT_SECRET` (and no `TOKEN_ENC_KEY` override) requires re-entering secrets.
- New env var `TOKEN_ENC_KEY` for independent rotation of at-rest encryption keys.

---

## [1.0.0-rc.8] — 2026-04-30 — Manual activity logging (issue #3)

Adds an opt-in **Activity** section to the Diary so you can log
exercise calories without a wearable. Closes [#3](https://github.com/TraceApps/nutritrace/issues/3).

### Added
- **Activity section on the Diary.** Turn it on in Settings → Diary
  → "Show activity section" (off by default). Each entry takes a
  name plus calories burned, with optional duration and distance.
  Multiple entries per day, edit or delete via long-press. Sits
  below your meals and visually mirrors them — green segmented bar
  showing each entry's share of the day's burn, total at the bottom.
- **Optional earn-back toggle.** Settings → Diary → "Adjust calorie
  goal from activity" (off by default). When on, today's burn raises
  your calorie remaining for the day. The expanded Remaining panel
  shows the math — *"Goal 2,000 + Activity 540 = 2,540 kcal"* — so
  it's clear what bumped the number. Macro targets (protein / carbs /
  fat) stay anchored to your base goal regardless.
- **Wearable + manual coexistence policy.** When you have both a
  wearable integration and manual entries on the same day, a Settings
  radio decides how they combine: *Wearable wins* (default — manual
  entries display but don't move the goal math), *Manual wins*
  (replaces the wearable's burn for the day), or *Add together*
  (with a double-count warning). The policy section only appears when
  the earn-back toggle is on.
- **Trace can log activity for you.** New `add_activity_entry`
  tool — say *"I hiked 10 miles, about 1000 calories"* in chat or
  hold-to-record on the FAB and Trace logs it directly. If you don't
  supply a number, Trace can estimate one from your body profile —
  gated by a separate "Estimate activity calories" toggle in Settings
  → AI Assistant, which only enables when your weight, height, date
  of birth, and sex are all set.
- **Wellness hint on the Activity header.** When any wearable
  integration is enabled, a subtle line under "Activity" reminds you
  that synced device workouts (Garmin runs, Fitbit rides, etc.) live
  on the Wellness page — Activity is for what you log manually.
- **Negative remaining values.** Goal totals in Remaining mode now
  show how far you are *over* a target (e.g. `−20 g Fat` instead of
  `0 g`) for calories, protein, carbs, fat, sodium, sugars, fiber,
  and other tracked nutrients. Water still clamps at zero.

### Storage & backups
- New `activity_log` table covered by Full Backup ZIP, JSON
  export, and the Clear Data path.

---

## [1.0.0-rc.6] — 2026-04-28 — i18n scaffolding, subpath support, wizard cleanup

### Added
- **Internationalization (i18n) scaffolding.** `svelte-i18n` wired up with a JSON-per-locale model under `src/i18n/`. New "Language" picker in Settings → Regional & Units that drives the active locale reactively. ~210 source strings extracted across navigation, page titles, full auth flow (Login / ForgotPassword / ResetPassword / AcceptInvite / Profile), the wizard, primary actions in Diary / Foods / Goals / FoodEditor / MealEditor, common toasts/buttons, and the Trace AI assistant FAB. New `npm run i18n:check` script reports per-locale coverage. Translation contributor guide added to `CONTRIBUTING.md → Translations` (covers adding a new language, conventions, and the "use regulatory nutrient terms not literal translations" gotcha for nutrition labels). Server-side strings (email subjects, push bodies, AI system prompts) intentionally out of scope for now.
- **Reverse-proxy / subpath support via `BASE_URL` env var.** Lets users mount NutriTrace at `/your-prefix/` for reverse-proxy deployments without URL rewriting. Server mounts all middleware + routes inside an Express sub-router at the prefix; the client reads the basePath from `window.__NT_CONFIG__` (injected at HTML serve time). `apiUrl()` and `resolveAssetUrl()` in `src/lib/platform.js` are the single point where the prefix gets applied. Vite `base: './'` so generated asset URLs are relative; PWA manifest `start_url` and `scope` are `'./'` so PWA install works at any subpath. Default empty `BASE_URL` is identical to pre-feature behavior — existing deployments don't migrate. New "Reverse Proxy with Subpath" section in `DEPLOY.md` with Caddy / nginx / Traefik configs and OAuth callback guidance. Closes the feature request from issue #3 (tellis82).
- **Shared `DatePicker` + `DateInput` components.** New `src/components/ui/DatePicker.svelte` extracted from inline calendar duplicates in Diary and Wellness — month/year nav, year/month grid pickers, day grid, locale-aware. `src/components/ui/DateInput.svelte` wraps DatePicker with a masked text input + calendar trigger button for form-style date entry (Profile birthday, Wizard dob step). Manual entry is now masked: only digits accepted, separators auto-inserted in the user's chosen format (ISO / US / EU), capped at 8 digits.

### Changed
- **Wizard cleanup pass.** Removed duplicate birthday + gender fields from the Create Account form — the dedicated `dob` and `gender` wizard steps already capture both. Eliminates the previous mismatch where the auth form offered M/F/Non-binary/Prefer-not but the BMR-bound dedicated step only accepts M/F. Variant-logic comment added in source explaining the three usermgmt-step variants (native local skip / PWA force-create / PWA toggle). Top-bar Skip button now routes through the same confirmation modal as the welcome screen's "I'll do this later" link instead of bailing immediately. Per-integration "Skip" buttons relabeled to "Skip this" so they're visually distinct from the wizard-level skip. AI provider card renamed from "AI Buddy" (legacy waistline-ai-buddy naming) to "AI Assistant" with description mentioning Trace.

### Fixed
- **Subpath-mode bypass paths.** Several modules constructed API URLs locally instead of going through `apiUrl()`: `src/stores/auth.js` had a duplicate `_apiUrl` helper, `src/lib/api.js` used `_resolveBaseUrl()`, `src/lib/api-cached.js` had `_base()`, `src/lib/sync.js` had `_baseUrl()`, `src/stores/settings.js` had `_settingsUrl()`, and Wizard / AcceptInvite / ResetPassword had raw `fetch('/api/...')` calls. All consolidated through `platform.apiUrl()` so the BASE_URL prefix gets applied uniformly. Prevents the 404 wave seen during the first subpath test.
- **Static image references at subpath.** `<img src="/icons/logo.png">` and similar absolute paths 404'd when running at a subpath. Touched components: Sidebar (visible on every page), Login / ForgotPassword / ResetPassword / AcceptInvite / NativeSetup / Settings → About panel, plus `src/lib/notifications.js` Web Notification icon. All routed through `resolveAssetUrl()` which prefixes `/uploads/`, `/api/`, `/icons/`, `/fonts/` paths with the basePath in PWA mode.
- **CSRF rejected settings PUTs.** Fresh JWTs (issued post-CSRF-feature) require an `X-CSRF-Token` header on state-changing requests, but `settings.js` and Wizard's `_putConfig` never sent one. Added the header in both. Existing daily-use installs were shielded by old JWTs lacking the csrf field; this fix lands defensively before any logout-then-login could trigger the bug.
- **Login flow now refreshes CSRF on sign-in.** Login.svelte previously called `currentUser.set(data.user)` and `loadServerSettings()` immediately, but the new JWT's csrf field never made it into localStorage until the next page reload — so the post-login wave of reactive settings saves all 403'd. Now awaits `loadAuthState()` (which fetches `/api/auth/me` and stores csrf) before settings load.

### Notes
- Reverse-proxy / subpath support marked done in `FUTURE.md` Infrastructure section. New "Internationalization (i18n)" entry added to `FUTURE.md` between UI/UX Polish and Code/Performance.
- Three volunteer translators raised hands for French (Lemmy), Dutch (Reddit), and German (Lemmy) on launch threads; outreach pending until translation tracking issue is opened on the public repo.
- Caveat: `BASE_URL` should be picked at install time. Changing it against existing data leaves stale image URLs in old diary item snapshots since the snapshotted `imgUrl` was stored with the prefix from when it was logged. Documented in `DEPLOY.md`.

---

## [1.0.0-rc.5] — 2026-04-28 — Post-launch fixes + Docker secrets

### Added
- **Sodium ↔ salt auto-derivation across the food editor and imports.** The food editor auto-fills the missing field via the regulatory factor (sodium_mg = salt_g × 400) when only one is entered, and shows a calculator icon next to the derived field so the value's origin stays visible. The same derivation runs at the data-source layer for OFF, USDA, and Mealie imports — products that ship only one of (sodium, salt) come in with both populated and the `_derived` flag set. A one-time idempotent backfill at server startup fills the missing field on existing foods + meals, and an equivalent backfill runs at native-SQLite init on Android so phones with cached pre-derivation rows self-heal too.
- **Docker / Swarm secret file support.** New `server/docker-entrypoint.sh` reads any `*_FILE` env var at container startup, loads the referenced file, and exports the value as the corresponding env var before Node starts. Covers `JWT_SECRET_FILE`, `RECOVERY_TOKEN_FILE`, `SMTP_PASS_FILE`, `AI_API_KEY_FILE`, and any other server env var. Errors loudly if both `NAME` and `NAME_FILE` are set or if the file is unreadable. Documented in `DEPLOY.md` with a working compose snippet. Thanks to @clifmo for the contribution (#2).

### Fixed
- **Disconnect from server now fully clears cached auth state.** Disconnecting was leaving `wl:userId`, `nt:cachedUser`, `nt:cachedUserMgmt`, and `nt:csrf` behind in localStorage, so the app continued to think the user was signed in (showing only Logout instead of Connect/Login). `disconnectServer` now wipes the cached auth keys and resets the `currentUser` and `userMgmtActive` stores.
- **Logout actually invalidates the server session.** The previous logout flow only cleared client state, leaving the JWT cookie valid; the next page load would silently re-authenticate. Logout now calls `auth.js logout()` which posts `/api/auth/logout` to invalidate the session server-side. `_refreshAuthFromServer` also treats a 401 from `/api/auth/me` as logged-out (clearing local state) instead of "server error, keep cached", so the Login route appears as expected.
- **Settings restore after re-login.** After a logout + re-login on the same device, settings like Trace FAB visibility and the Wellness section toggle weren't reapplying even though the server returned them. Per-user-scoped localStorage keys (`wl_u<id>_<key>`) survive logout, so `DB.setSetting` was early-exiting on unchanged JSON values and never dispatching the `wl:setting` event the stores listen for. Added a `force=true` flag to `setSetting` and routed `loadServerSettings` through it after re-login.

### Notes
- New `Internationalization (i18n)` section in `FUTURE.md` covering svelte-i18n + Weblate as the planned translation contribution path. Tracked as v1.1 / v1.2 work.

---

## [1.0.0-rc.4] — 2026-04-27 — Diary image freshening + migration UX

### Fixed
- **Stale diary images now self-heal.** Diary items snapshot every food field at log time, including `imgUrl`. If a food got an image AFTER a diary entry was logged with that food, the snapshot stayed empty forever (spread captured the empty value, snapshot semantics protected history). Cosmetic fields like images shouldn't be frozen the same way as name/macros, so a live-lookup pass now fills empty `imgUrl` from the foods table at read time. Applied at three layers so all surfaces inherit it: `GET /api/diary/*` (PWA users), `/api/sync/pull` (Android sync), and `dbGetDiaryDate` / `dbGetAllDiary` in `db-native.js` (Android local-SQLite reads). Wrapped in try/catch so a query error never breaks the calling endpoint. New shared helper at `server/lib/diary-helpers.js` to keep server code DRY.

### Changed
- **Connect-to-server migration flow now shows counts and surfaces errors.** When connecting from standalone mode with existing local data, the merge dialog now displays per-table counts (foods, meals, recipes, diary days, settings) so the user knows what's about to move. The upload pass collects per-table success counts and per-row errors instead of silently `.catch(() => {})`-ing them; a summary screen after the upload shows what landed and the first 5 error messages if anything failed. Progress bar replaces the vague spinner during upload. New `src/lib/migrate.js` shared helper. (Mirrors a recent LiftTrace improvement.)

### Notes
- New `Infrastructure → OIDC / SSO support` entry in `FUTURE.md` covering Authentik / Keycloak / Authelia / Pocket-ID integration as a tracked post-1.0 enhancement.

---

## [1.0.0-rc.3] — 2026-04-27 — Calibration export window includes today

### Fixed
- **Calibration export was dropping today's row.** The 30-day window in `_generateCalibExport()` ran from `today-30` to `today-1`, silently excluding today even though today's seeded `*_actual` scores are typically what the user just paste-confirmed via the dev console snippet. The data was being fetched (the API call's `to=` param uses today) but never iterated during day-row construction. Window shifted to `today-29` → `today` inclusive — same 30-day length, ends today instead of yesterday.

---

## [1.0.0-rc.2] — 2026-04-27 — Sleep Debt reads the actual sleep goal

### Fixed
- **Sleep Debt card on Wellness page hardcoded 8h** when the user's sleep goal was stored under `.max` (the default — "Minimum goal" toggle off in the goal editor). Code only checked `.min`, fell back to 480 minutes. Fix: use the same `max ?? min ?? default` fallback chain used elsewhere in the codebase (Goals.svelte, calorie targets, etc.). Users with custom sleep goals now see debt computed against their actual target.

---

## [1.0.0-rc.1] — 2026-04-26 — First public release candidate

After many months of development as the v0.x-beta series, NutriTrace is going public for wider testing. This release candidate is a snapshot of the v0.39.x line that has been running stably in single-user and multi-user setups, with all major feature work complete. The full beta history is preserved below.

### What's in v1.0.0-rc.1

Aggregate feature surface (everything below is shipped):

- **Diary** — configurable meals, multi-ingredient meals + recipes, body stats, water tracking, day-level free-text notes, per-meal ⋮ menu (copy / move / save-as-meal / clear / copy-to-date), long-press item actions
- **Foods & Meals** — personal food database with photos, barcodes, categories; barcode scanner; meal/recipe builder; OFF + USDA + Mealie import; fuzzy search
- **Statistics** — charts for any tracked metric, average / trend / goal overlays, dynamic-goal "Base Goal" line
- **Goals** — calorie + nutrient goals with templates, Wizard TDEE calculation, optional Dynamic Calorie Goal (Experimental)
- **AI Assistant (Trace)** — Claude / OpenAI / Gemini, tool use across all providers (real diary + meals + wellness + workouts + goals queries), Smart Log voice food entry (hold-to-record), Goal Insights (Experimental)
- **Wellness Integrations** — Fitbit, Withings, Garmin, Health Connect (Android). Computed Trace Sleep / Readiness / Stress scores prioritizing day-to-day consistency
- **Notifications** — device notifications + push services (Apprise / Gotify / ntfy), water / meal / weigh-in / bedtime / wellness alerts / weekly summary
- **Backup & Restore** — full ZIP backup, JSON export/import, CSV diary export, Waistline import
- **Multi-user + sharing** — optional account system, food sharing with private / group / specific visibility
- **Self-hosted** — single Docker container, AGPL-3.0, no telemetry, no cloud sync, all data on your hardware
- **PWA** — works offline-first in any modern browser, installable to home screen on Android

### Distribution

- Source: [github.com/traceapps/nutritrace](https://github.com/traceapps/nutritrace) (AGPL-3.0)
- Docker image: `ghcr.io/traceapps/nutritrace:1.0.0-rc.1` and `:latest`

### Known limitations (post-1.0 work — see FUTURE.md)

- **Native Android app** — in development and testing, public release planned during the v1.x cycle. Android users can install the PWA via Chrome's "Add to Home Screen" today.
- **Public demo instance** — coming post-1.0 on existing infrastructure
- **Local / self-hosted LLM support** — high-priority post-1.0 (Ollama, LocalAI, LM Studio, vLLM via OpenAI-compatible adapter)
- **iOS** — pending hardware + Apple Developer account access

### Reporting bugs

`Settings → Diagnostics → View logs` → Copy / Share → attach to a [GitHub issue](https://github.com/traceapps/nutritrace/issues). Templates provided for bugs, feature requests, and wellness integration test reports.

---

## [0.39.36-beta] — 2026-04-26 — Trace FAB self-heals off-screen positions

### Fixed
- **Trace FAB invisible on desktop PWA after viewport changes.** The FAB position is persisted in `localStorage` (`wl:aiFabPos`), but clamping was only applied during a drag — never on load or window resize. A position dragged on a wider monitor (or saved at a different viewport size) could end up off-screen on a smaller one, with no way to recover short of clearing localStorage. Mobile devices weren't affected because they have separate localStorage origins. Fix: added `_clampFabPos()` helper that clamps to current viewport bounds; runs on mount (writes back the corrected value) and inside `_updatePanelPos` on every resize. LiftTrace already had this guard — NutriTrace was the lone outlier.



### Added
- **Collapsible "Yesterday's Meals" + "Saved Meals" sections** in Foods → Meals tab. Each section header is now a clickable row with a chevron; collapse state persists per-section (`foodsYesterdayCollapsed`, `foodsSavedCollapsed`, both default expanded). The new "Saved Meals" header only renders when "Yesterday's Meals" is also visible — acts as a divider between the two parallel sections rather than a redundant label on a single tab. Search behavior unchanged: typing hides both headers and results take over; user-set collapse state preserved across search clears.

### Fixed
- **Yesterday-meal info-sheet thumbnails missing on Android.** The `<img>` tag passed `it.imgUrl` raw, so external food images (Open Food Facts, USDA, Mealie) were blocked by the WebView. Wrapped with `resolveAssetUrl()` so external URLs route through `/api/proxy` in native server mode (matches Diary's existing pattern). Also fixed the load-error fallback: a broken image now swaps to the placeholder glyph instead of leaving a blank slot. PWA was unaffected — same-origin browser fetch wasn't blocked.
- **Long-press selecting surrounding text.** Diary items and Foods rows opened the action sheet but also visually selected nearby words. Added `user-select: none`, `-webkit-user-select: none`, `-webkit-touch-callout: none` to `.diary-item` and `.food-item-btn` so the long-press gesture only triggers the menu — no text selection, no copy/paste callout.

### Changed
- **Component + symbol rename completes the FitBot → Trace work** from v0.39.34. User-facing strings were already done; this bump aligns the internals so the codebase reads consistently and matches LiftTrace's `Trace.svelte` / `TraceFace.svelte` / `SettingsTrace.svelte` layout. No behavior change.
  - Files: `AIFitBot.svelte` → `Trace.svelte`, `FitBotFace.svelte` → `TraceFace.svelte`, `SettingsAI.svelte` → `SettingsTrace.svelte` (renamed via `git mv`, history preserved).
  - Symbols + tags: `<AIFitBot />` → `<Trace />`, `<FitBotFace />` → `<TraceFace />`, `<SettingsAI />` → `<SettingsTrace />`.
  - CSS class `.fitbot-face` → `.trace-face`. Global `window.__fitbotHoldRec` → `__traceHoldRec`. Console tags `[fitbot-hold]` → `[trace-hold]`. Settings search keyword `'fitbot'` → `'trace'`.
  - Migration code at `App.svelte` and `stores/settings.js` still references the literal `'FitBot'` — required so existing installs detect the legacy name and bump it to `'Trace'`.
- **LiftTrace label parity** (cross-app cohesion, applied in LiftTrace v0.10.0-beta.3): both apps now share the exact same AI Assistant section UX — section label "AI Assistant", toggle "Enable AI Assistant", description "Adds a floating chat button to all pages". The brand name "Trace" appears only as the default value of the user-customizable assistant-name field, so renaming the assistant doesn't leave stale labels around the rest of the UI.

---

## [0.39.34-beta] — 2026-04-26 — AI Assistant rename + Wizard skip + diagnostic logs Share

### Changed
- **AI Assistant default name "FitBot" → "Trace"** — ties to the broader brand (TraceApps + NutriTrace + "Trace Every Bite") and drops the dated "[X]Bot" pattern. Existing users on the literal default ("FitBot") get auto-migrated to "Trace" in `App.svelte`. Users who picked their own custom name keep it. The setting label is "Assistant name" — change to anything you like in Settings → AI Assistant.
- **Wizard "I'll do this later" skip link** added to the welcome step. Confirmation modal explains "calorie targets won't be calculated automatically" and that Settings can finish setup any time. Link is hidden when forced account creation is required (multi-user mode setup).
- **Bedtime reminder sub-controls now slide in/out** when toggled — was abrupt show/hide. Wrapped the `_notifBedtime` and `_notifBedtimeWindDown` conditional bodies in `transition:slide` divs.
- **Diagnostic logs viewer adds a Share button** next to Copy/Clear (borrowed from LiftTrace). On native uses `@capacitor/share` to open the Android share sheet (Gmail, Files, Drive, etc.); on PWA uses Web Share API; falls back to clipboard. Lets users send logs straight from the app to their email or a GitHub issue without manual paste-juggling.

### Notes
- All user-facing "FitBot" strings in source + docs are now "Trace" or "AI Assistant" depending on context. Internal symbol rename followed in v0.39.35-beta.

---

## [0.39.33-beta] — 2026-04-26 — Settings audit cleanup (round 2)

### Removed (legacy)
- **Legacy shared `wellnessSync*` keys** — `wellnessSyncMode`, `wellnessSyncSchedule`, `wellnessSyncTime` were the original sync-config trio before per-source settings landed in v0.30. They've been kept around as fallback seeds for the per-source values; with no public installs predating per-source, they're now safe to remove. Per-source defaults are now standalone (`'auto'` mode, daily interval). `wellnessSyncRange` stays — it's still the active shared range setting.
- Server scheduler's `wellnessSyncMode` fallback path also removed.

### Changed
- **Wizard now uses the shared `<Toggle>` component** for all on/off switches (user-management opt-in step + 5 notification step toggles). Removed the bespoke `.fake-toggle` and the on/off-pill styled buttons. One toggle visual across the whole app.

---

## [0.39.32-beta] — 2026-04-26 — Settings audit cleanup

### Fixed
- **Wizard-collected user profile fields now sync across devices** — `gender`, `dob`, `height_cm`, `weight_kg`, `target_weight`, `activity`, and `tdee` were being written to localStorage but weren't in `USER_PREFS`, so multi-device users lost their profile after the wizard. Added to USER_PREFS.
- **`barcodeFlashlight` toggle visibility was inverted** — was hidden on native (where it's actually useful) and shown on PWA (where there's no flashlight). Flipped.
- **Goals section disabled-state message** pointed to "Connected Services" — wellness trackers actually live in **Wellness**. Fixed.

### Added
- **Statistics → Include today in trends setting** (`statsIncludeToday`, default off) — persisted version of the inline checkbox already on the Statistics page. The inline checkbox now updates this setting directly, so per-session and persistent choices share state.
- **Diary toggle descriptions** — every toggle in Settings → Diary now has a one-line description explaining what it controls. Same for Foods.
- **Search keywords** for Help Improve section + "reset / defaults / clear settings" added to Backup so users can find the existing Danger Zone reset.

### Changed
- **"Celebrate goals" → "Goal pulse animation"** — was easily confused with the Notifications "Goal Celebrations" toggle (different feature). Description clarifies the distinction.

### Removed (dead code)
- `notifCalorieGoal`, `withingsDataPriority`, `loopBannerAnimations` — settings that existed in the store but had zero read sites anywhere in the codebase.
- `goalsShowCalories`, `goalsShowWeight` local lets in Settings.svelte that were read but never rendered.
- `diaryTotalsMode` import in Settings.svelte (still used in Diary.svelte; just not exposed in Settings UI).

---

## [0.39.31-beta] — 2026-04-26 — In-app diagnostic logs

### Added
- **In-app log capture** — `src/lib/log-capture.js` wraps `console.{log,info,warn,error,debug}` into a 500-line in-memory ring buffer, captured from app boot. Includes uncaught errors and unhandled promise rejections automatically.
- **Settings → Help Improve NutriTrace → View diagnostic logs** — opens a sheet with the buffer contents, plus Copy and Clear buttons. User pastes into a GitHub issue when filing a bug. Nothing leaves the device automatically.
- **Verbose diagnostic logging toggle** in the same Settings section — turns ON the high-detail `_dlog` calls in `sync.js`, `notifications.js`, `health-connect.js`, and the settings store (these were dev-build-only before). Off by default. Ideal flow: turn on → reproduce the bug → View logs → Copy → file issue → turn off.

### Changed
- The dev-only `_dlog` helpers across the client now also activate when `localStorage.nt:verboseLogging === '1'` in production builds. Same gating, just adds an opt-in path.

---

## [0.39.30-beta] — 2026-04-26

### Added
- **Statistics: today excluded from cumulative-metric trends by default** — calories, protein/carbs/fat, water, steps, active minutes, and other accumulating metrics no longer include today's partial-day value in the chart or summary stats. A small "Include today (partial day)" checkbox above the chart lets users opt back in. Point-in-time metrics (sleep score, weight, HRV, RHR, SpO2, body composition) are unaffected and always include today. Eliminates the "today looks like a dip" distortion that affected average/trend lines.
- **Yesterday's meal info sheet now shows item thumbnails** — each food item gets its image (with placeholder icon if none), matching the visual pattern used elsewhere in the app.

### Changed
- **Yesterday's meals card layout** — info icon moved before the add button so the primary action (add) sits at the rightmost position per Material Design convention. Generic "restaurant" icon replaced with `mealIcon()` so each meal type (Breakfast, Lunch, Dinner, Snacks, custom names) gets its own glyph.

---

## [0.39.29-beta] — 2026-04-26 — Pre-RC1 polish

### Added
- **Yesterday's meal info button** in the Foods picker — tap the (i) icon next to a yesterday's-meal card to open a sheet listing every item in that meal (name, brand, quantity, kcal each). The "Add this meal" button at the bottom is the same action as the main row tap.
- **Calibration data export** in Settings → Help Improve NutriTrace — generates an anonymized JSON of the last 30 days of Fitbit/Garmin readings (no user ID, no exact dates — just day-of-week and offset). User reviews the JSON before sharing in GitHub Discussions to help tune the score formulas.
- **GitHub issue templates** — `bug_report.md`, `feature_request.md`, and `integration_test_report.md` (the last specifically for community-tested wearables/scales/Health Connect setups). Each includes log location guidance and a redaction reminder.
- **README** — new "Principles", "Roadmap", "Help us test", and "Troubleshooting" sections. Sets the values story up front, names the testing gaps honestly, and gives contributors a clear on-ramp.

### Deferred to FUTURE.md
- Per-meal totals popup nutrient filter — should it always show all nutrients (vs respecting the day-summary's `diaryShowAllNutrients` toggle)? Defer the call until we have user feedback on what they reach for.

---

## [0.39.28-beta] — 2026-04-26 — Weigh-in reminder false-positive fix

### Fixed
- **Device-side weigh-in reminder no longer fires when weight is already logged** — the WorkManager periodic check runs every 15 min and was firing on early ticks within the reminder window before today's Withings/HC sync brought the weight into the local cache. Once the weight arrived, later ticks correctly identified it but the original notification stayed in the tray. Three-part fix in `ReminderWorker.java`:
  1. **Self-heal**: when a tick finds the weight, cancel any previously-posted notification with the same ID. The notification disappears from the tray once data syncs.
  2. **Once-per-day dedup**: track "fired today" in SharedPreferences. Prevents the multi-fire-then-Android-mute pattern.
  3. **Staleness gate**: if `sync_meta.last_sync_at` is older than 1 hour on a server-connected device, defer to the server scheduler's push reminder instead of firing locally on stale data. Local-only devices (no `last_sync_at` row) are unaffected.

---

## [0.39.27-beta] — 2026-04-26

### Changed
- **Meal header kcal hidden when macro footer is on** — the macro summary footer at the bottom of each meal already shows kcal at the end of `... · N kcal`, so showing it in the header too was redundant. Now it only appears in the header when `diaryShowMacroSummary` is off (in which case the header is the only place to see the meal total).

---

## [0.39.26-beta] — 2026-04-26

### Changed
- **Per-meal totals popup tap target** — moved from the kcal text on the meal header to the **macro footer at the bottom of each meal** (the P/C/F bar + percentages). That's the real "summary at a glance" element, so making it the tap target for the detailed breakdown is the natural fit.

---

## [0.39.25-beta] — 2026-04-26

### Added
- **Per-meal nutrition totals popup** — tap the kcal text on any meal header in Diary to open a bottom sheet with the full nutrient breakdown for that meal: 4 macro pills (Protein/Carbs/Fat/kcal) + every visible nutriment with a value, plus item count. Mirrors the day-level Nutrition Summary but scoped to one meal. Respects the user's "Show all nutrients" toggle.

---

## [0.39.24-beta] — 2026-04-25 — Bulletproof DB-open recovery

### Fixed
- v0.39.23 cleanup of leftover encryption state was conditional on localStorage markers — but on at least one device the markers were absent while the DB file was still encrypted from a prior install, so the cleanup didn't run and the open failed with SQLITE_NOTADB.
- New behavior: try-then-wipe-then-retry pattern. Always attempt to open first. If it fails (any reason), unconditionally wipe the DB file (via plugin's `deleteDatabase` AND a Filesystem fallback, in case the plugin call silently no-ops on an encrypted file it can't open) and try again. Server-connected devices re-sync from the server; clean unencrypted DBs from v0.39.19 or earlier are unaffected because the first open succeeds.

---

## [0.39.23-beta] — 2026-04-25 — Roll back native SQLite encryption

### Changed
- **Reverted SQLCipher encryption from v0.39.20** — `@capacitor-community/sqlite` v8's secret-store semantics are unreliable in practice. The error sequence we hit:
  1. v0.39.20: `setEncryptionSecret` called every launch → "file is not a database (26)" on second launch (passphrase rebinding bug)
  2. v0.39.22: switched to `isSecretStored` gating → "setEncryptionSecret: state for nutritrace_localSQLdb not correct" (plugin requires no connections, but state tracking is fragile)
- Modern Android encrypts the entire app data directory at the OS level (file-based encryption, default since Android 7), so the local SQLite is not in cleartext on a locked device anyway. SQLCipher was a defense-in-depth layer; losing it doesn't materially change the threat model for normal users.
- New behavior in `db-native.js`: one-shot cleanup on first launch — clears the encrypted DB file, secure-store secret, and `nt:db_*` localStorage markers from any prior v0.39.20–22 install. Then opens unencrypted as before. Server-connected devices re-sync from the server (your phone will see a brief empty state then everything flows back).
- `capacitor.config.ts`: `iosIsEncryption`/`androidIsEncryption` back to `false`.
- FUTURE.md updated: native SQLite encryption deferred to v1.1, with a note to investigate alternatives (Android Keystore + per-row JS encryption, different plugin, or simply rely on Android's OS-level FBE).

### What this means for you
- Your phone will run the cleanup on first launch (delete the broken encrypted DB), then re-sync from the server. No data loss because the server is the source of truth for everything.
- If you were on v0.39.19 or earlier and never installed v0.39.20–22, this is just a normal update with no migration.

---

## [0.39.22-beta] — 2026-04-25 — Encryption open auto-recovery

### Fixed
- **SQLCipher decrypt failure auto-recovery** — v0.39.20 called `setEncryptionSecret` on every launch. The plugin's secure-store semantics in @capacitor-community/sqlite v8 don't reliably re-bind the passphrase to existing encrypted files when called twice; some devices got "file is not a database (26)" on the second launch.
- New behavior:
  1. Use `isSecretStored()` to check if the plugin secure store already has a passphrase. Only call `setEncryptionSecret` on first setup. Eliminates the re-binding bug.
  2. If the encrypted open still fails (e.g., the secret in the secure store and localStorage have drifted on an older install), auto-recover on **server-connected** devices: clear secret + DB, re-derive a fresh passphrase, recreate the DB, let server sync repopulate. **Local-only** devices fail loudly with a recovery message instead of wiping data.
- New `_emergencyResetDb()` helper for the recovery path; calls `clearEncryptionSecret()` + `deleteDatabase()` + clears localStorage markers.

---

## [0.39.21-beta] — 2026-04-25 — Final audit cleanup

### Security
- **Push-test SSRF fixed** — `/api/settings/push-test` (gotify branch) was accepting `body.url` and `body.token` and proxying to whatever the caller supplied, then falling back to saved settings. The client never sends those body fields anyway, so removing them eliminates an authed-user SSRF without changing any user-visible behavior. ntfy and Apprise paths already only used saved settings.
- **AI chat payload caps** — `/api/ai/chat` now rejects `messages.length > 60` and `messages + systemPrompt > 200 KB`. Bounds the worst case for a misbehaving client (or compromised account) burning the admin's AI budget.
- **Backup file extension guard** — `/api/full-backup/:name/{download,delete}` now require the requested filename to end in `.zip`. Without this, an admin could request any file that happened to live in `BACKUPS_DIR` (which is under `UPLOADS_DIR` by default).

This brings the audit punch list to **complete** except for two intentionally-deferred items already in FUTURE.md (Android cleartext lockdown — right before Play Store; dep major bumps `better-sqlite3 9→11` + `multer 1→2` — v1.1 with full regression testing).

---

## [0.39.20-beta] — 2026-04-25 — Capacitor SQLite encryption (SQLCipher)

### Security
- **Native SQLite is now encrypted at rest** — `androidIsEncryption: true` (and iOS) flips on SQLCipher in the Capacitor build. Per-device passphrase is generated on first launch (32 random bytes via `crypto.getRandomValues`) and stored in localStorage. Defense-in-depth on top of Android's existing file-based app-data encryption.

### Migration (automatic, two paths)
- **Server-connected devices** (your Pixel falls here): on first launch after the update, `db-native.js` detects the unencrypted DB, deletes it, creates a fresh encrypted DB, and the next sync repopulates from the server. **Zero data loss** because the local DB is just a cache of authoritative server data. You may briefly see an empty diary while the first sync completes.
- **Local-only devices**: migration is **deferred**, not silent — wiping local SQLite without a server safety net would lose data. The DB stays unencrypted; a `nt:db_encryption_pending=1` flag is set in localStorage. Users explicitly trigger the upgrade after exporting a Local Full Backup. UI for that lives in the next release (already exported the helpers `runLocalEncryptionUpgrade()` + `isEncryptionPending()` from `db-native.js`).

### What this protects against
- Lost/stolen rooted device (where Android's OS-level encryption can be bypassed)
- File-system-level backups that include the DB file
- Future zero-day exploits against Android's data-directory encryption

### What this does NOT change
- The encryption secret lives in localStorage in the same app data directory as the DB. An attacker who can read one can read the other. This is a defense-in-depth layer, not an air-gap. Android Keystore-backed key would require a custom plugin.

### Notes for self-hosters / developers
- If you uninstall + reinstall the app, the localStorage secret is wiped along with everything else — the encrypted DB file becomes unrecoverable. Same outcome as `Clear Storage` in Android Settings. Re-install pulls from the server (server-connected mode) or starts fresh (local-only).

---

## [0.39.19-beta] — 2026-04-25 — Upload magic-byte validation

### Security
- **`/api/upload` now magic-byte validates** — was trusting the client-supplied `Content-Type`. After multer writes the file, the first bytes are inspected against known image signatures (JPEG, PNG, WebP, GIF, HEIC/HEIF, AVIF, BMP). Files that don't match are deleted from disk and the request is rejected with 400. SVG is intentionally NOT supported (script-execution risk; food/avatar uploads never need it).
- New module: `server/lib/image-magic.js` — pure-stdlib magic-byte detector with both file-path and in-memory-buffer entry points.

---

## [0.39.18-beta] — 2026-04-25 — Docker image org rename

### Changed
- **Docker image canonical path is now `ghcr.io/traceapps/nutritrace`** — `docker-compose.yml`, `README.md`, and `DEPLOY.md` all reference the new path.
- **CI publishes Docker image** to `ghcr.io/traceapps/nutritrace` on push to `main`.
- **FUTURE.md repo-split notes updated** to reflect actual current structure (`traceapps/nutritrace-dev` private monorepo, `traceapps/nutritrace` public-on-1.0).

---

## [0.39.17-beta] — 2026-04-25 — Pre-1.0 security hardening (Phase 2)

### Security
- **OAuth tokens encrypted at rest** — Fitbit, Withings, and Garmin access/refresh tokens are now encrypted with AES-256-GCM using a key derived (HKDF-SHA256) from `JWT_SECRET` (override with `TOKEN_ENC_KEY`). A leaked database file or backup no longer hands out long-lived wearable-API credentials. New module: `server/lib/token-crypto.js`. Migration is **lazy**: existing plaintext tokens continue to work and are re-written encrypted on the next refresh cycle. Rotating `JWT_SECRET` invalidates both sessions and stored OAuth tokens — users will have to reconnect their wearables; document this if you ever rotate.
- **Mealie proxy SSRF fixed** — `/api/mealie/proxy` now requires `baseUrl` to match the user's saved `mealieBaseUrl` setting (multi-user). An authed user can no longer use the server as an open proxy to probe internal hosts or cloud-metadata endpoints. Single-user mode unchanged (no auth boundary to defend in that mode).
- **Image-localizer SSRF fixed** — `POST /api/foods` and `/api/meals` (which run `localizeImage`) now refuse URLs whose hostname resolves to private/loopback/link-local IP ranges (10.x, 127.x, 172.16-31.x, 192.168.x, 169.254.x including cloud metadata, IPv6 ULA + loopback). Non-http(s) protocols also rejected.
- **Auth cookie secure-by-default** — `secure: true` is the new default (was tied to `NODE_ENV=production` which most self-hosters never set). Set `INSECURE_COOKIES=1` to opt out for plain-HTTP LAN deploys (logged as a warning at startup).
- **Body parser tightened** — global JSON limit lowered from 50 MB to 1 MB. The two endpoints that legitimately handle large payloads (`/api/data/import`, `/api/sync/push`) get per-route 25 MB limits. Caps memory abuse from a single authed user.
- **Backup upload limit reduced** — 2 GB → 512 MB by default (override with `BACKUP_UPLOAD_MAX_MB`). Bounds disk-fill abuse from repeated half-finished uploads.
- **Session duration capped at 1 year** — previously `session_hours = 0` meant 100 years. Override with `MAX_SESSION_HOURS` env var if you really want longer.

### Notes for self-hosters
- **HTTPS is now expected by default.** If your server is on plain HTTP (LAN, dev), set `INSECURE_COOKIES=1` in your `.env` or auth cookies will be rejected by the browser.
- **OAuth tokens migrate transparently** on next sync — no admin action required.
- **`JWT_SECRET` is now load-bearing for OAuth too.** If you ever rotate it, users must reconnect Fitbit/Withings/Garmin. Set a separate `TOKEN_ENC_KEY` if you want independent rotation.

---

## [0.39.16-beta] — 2026-04-25 — Pre-1.0 security & polish (Phase 1)

### Security
- **CSRF exemption narrowed** — was skipping ALL `/api/wellness/*` POSTs (sync, recalculate, seed-scores, disconnect). Now only OAuth `/callback` paths are exempt; everything else requires the X-CSRF-Token header for cookie sessions.
- **JWT_SECRET refuse-to-start in production** — server now exits with a clear error if `NODE_ENV=production` and `JWT_SECRET` isn't set, instead of silently using the dev default.
- **Per-username brute-force throttle** — login + recover + forgot-password add a per-username bucket (5/15min) on top of the existing per-IP bucket (10/15min). NAT users behind one IP no longer share an account-lockout pool.
- **Recovery token now uses constant-time compare** — was vulnerable to timing-attack guessing.
- **`/api/auth/users/list` gated behind sharing_enabled** — was exposing every account's display name + username to every authenticated user. Now returns `[]` unless food/meal sharing is on.
- **`/api/auth/forgot-password` is constant-time + always returns 200** — was leaking SMTP-not-configured state and email existence via timing.
- **CSRF token rotated on password change** — old sessions on other devices stop working after a password change.
- **bcrypt cost factor bumped 10 → 12** — current best practice. Existing hashes remain valid (bcrypt verifies regardless of cost).
- **Image proxy hostname allowlist** — replaced `.includes()` with strict suffix match. `i.imgur.com.evil.tld` no longer slips through. Also rejects non-http(s) protocols.
- **Backup restore zip-slip + zip-bomb defense** — image extraction now rejects `..`, absolute paths, and any path that resolves outside `UPLOADS_DIR`. Hard cap of 10,000 entries and 5 GB total uncompressed.
- **Celebration key validation** — `/api/settings/claim-celebration` now requires keys match `/^[a-z_][a-z0-9_-]{0,39}$/`. Stops a misbehaving client spamming arbitrary keys into `app_config`.
- **Rate limits added** — new `server/middleware/rate-limit.js` token-bucket limiter applied to: `/api/ai/chat` (30/min/user), `/api/upload` (60/min/user), `/api/proxy` (60/min/IP), and `/api/wellness/*/callback` (10/min/IP).

### Changed
- **Console log noise cut** — `src/lib/sync.js`, `src/lib/notifications.js`, `src/lib/health-connect.js`, `src/stores/settings.js` — verbose `console.log` calls now gated on `import.meta.env.DEV`. Wellness readiness/stress debug calibration logs untouched (intentional).

### Performance
- **Barcode scanner libs lazy-loaded** — zxing + html5-qrcode + quagga2 (~870 KB combined) were loaded on every page; now loaded on first scanner open and cached for subsequent opens. Removes ~870 KB from PWA cold-start payload.
- **Logo file size** — `public/icons/logo.png` was 1,147 KB rendered at 32-56px in 6 places; replaced with the existing 47 KB icon-192. Saves ~1.1 MB on cold load.

### Repo
- **CONTRIBUTING.md added** — short guide for issues + PRs.
- **`.dockerignore` excludes `android/`, `*.apk`, `*.aab`, `*.keystore`** — speeds Docker build context.
- **FUTURE.md** — Health Connect moved from "needs testing" to done.

### Notes for self-hosters
- After this version, set `JWT_SECRET` in your `.env` (generate with `openssl rand -base64 48`) — the server will refuse to start in production without it.
- The new `RECOVERY_TOKEN`, `JWT_SECRET`, and CSRF behaviors are documented in DEPLOY.md.

---

## [0.39.15-beta] — 2026-04-25

### Fixed
- **Calibration seeds no longer overwritten by Fitbit sync** — `/api/wellness/fitbit/seed-scores` now writes to dedicated `*_actual` metric_types (`sleep_score_actual`, `readiness_score_actual`, `stress_score_actual`) instead of overwriting the calculated `*_score` values. Previously every Fitbit sync recomputed `sleep_score` from raw inputs and silently blew away seeded actuals — the stress chain has been using stale calculated values for weeks.
- **Wellness UI prefers actuals when present** — sleep/readiness/stress display, the readiness card, the stress card, and the stress 30-day history chain all now prefer `*_actual` over `*_score`. When no actual is seeded, behavior is unchanged (live calc).
- **Self-retiring design** — once formulas are dialed in and seeding stops, `*_actual` rows naturally roll off the 30-day stress window and the system transitions to using calc only. No flag flip, no migration step.

---

## [0.39.14-beta] — 2026-04-24

### Fixed
- **Weigh-in reminder now fires correctly** — server scheduler's `wellness_data` skip query was using strict `user_id = ?` (missing the NULL-fallback that the diary query uses). If the user was multi-user but their wellness_data rows had NULL user_id (older installs, or synced-from-Fitbit/Withings rows), the skip check missed the weight and fired the reminder anyway.
- **Water reminder multi-user fallback** — water goal skip check now also falls back to NULL user_id rows (matches meal + weigh-in pattern).
- **Weigh-in logging** (server + Android) — both checks now log what they found: `skipping weigh-in for user=X — diary.body_stats.weight=Y` or `firing weigh-in — no weight found`. Makes future diagnosis immediate instead of silent.

---

## [0.39.13-beta] — 2026-04-21

### Changed
- **Empty meal slots are now tappable** — when a meal has no items, the "Tap to add food" row itself opens the food picker. Previously the row was passive and users had to hunt for the + button. Label updated from "Tap + to add food" to "Tap to add food"; the + button still works as before.

---

## [0.39.12-beta] — 2026-04-21

### Added
- **Stress Management driver chips** — the Stress card in Wellness → Heart now shows the three contributing factors (HRV / Resting HR / Sleep) with color-coded values, matching the pattern used by Daily Readiness. Easier to see why stress is where it is on any given day.

### Removed
- **Readiness "Locked at sync" debug strip + refresh button** — was a dev/calibration tool used while tuning formulas. Regular users never needed it. The `/api/wellness/fitbit/recalculate` endpoint remains for DevTools use during future tuning.

---

## [0.39.11-beta] — 2026-04-19

### Added
- **Fuzzy food search** — local food/meal/recipe search now handles typos and partial matches (e.g. "chiken" finds "Chicken Breast"). Uses word-by-word matching first, then edit-distance tolerance for queries ≥ 4 chars. External source search (OFF/USDA) unchanged. No toggle — degrades silently to exact match when fuzzy adds nothing.
- **Search empty state in Foods** — when a local search returns no results, shows "No matches for '…'" with a hint to try Open Food Facts/USDA. Previously the list was silently empty.
- **Statistics empty state context** — "No data" message on the chart now includes a contextual hint: nutrition metrics suggest logging food, wellness metrics suggest connecting a tracker, body stats suggest a different date range.
- **Statistics dynamic goal line label** — when Dynamic Calorie Goal is active, the calorie goal line on the Statistics chart is now labeled "Base Goal" instead of "Goal" to clarify that the actual daily goal varies.

### Changed
- **Bundle code splitting** — chart.js, jszip, and emoji-picker-element are now split into separate async chunks. Cuts initial JS parse time on first load; chunks are loaded on demand.

### Fixed
- Settings split (background task — SettingsNotifications, SettingsBackup, SettingsUserManagement, SettingsAI sub-components)

---

## [0.39.10-beta] — 2026-04-19

### Fixed
- **Foods tab switch scroll position (take 2)** — previous fix (0.39.9) reset scroll in a reactive block, which ran AFTER Svelte painted the new tab at the old offset, causing a visible jump. Now the reset is wired to the Tabs `change` event so it fires synchronously on click (before the bind propagates) with a `requestAnimationFrame` follow-up. Result: the new tab renders starting at top with no perceptible jump.

---

## [0.39.9-beta] — 2026-04-19

### Removed
- **Foods picker "Recently Added" section** — removed (was added in 0.39.7). Didn't feel useful in practice.

### Fixed
- **Foods/Meals/Recipes tab switch** — when a tab was scrolled down and you switched to another, the new tab started at the same scroll offset instead of at the top. Now jumps to top on switch (no animation).

---

## [0.39.8-beta] — 2026-04-19

### Added
- **Notes shown in quick-add card** — when a food, recipe, or item with saved notes (e.g. "1 serving = 150g cooked") is added via the portion/quantity prompt, its notes appear above the inputs. Auto-hidden when empty — no setting needed. Same treatment in the multi-add portion sheet.
- **FitBot — new `get_meals` tool** — lets the assistant look up the user's saved Meals and Recipes (with items, totals, and notes). Supports an optional name filter so queries like "what's in my 'Usual breakfast'" work reliably.

### Changed
- **FitBot `get_diary` now returns day notes + per-item notes + brand** — so when the user asks "why did I eat badly yesterday?" the assistant can read their own context back to them.
- **Full backup + JSON import** now round-trip the new `diary.notes` column. Previous backups (without notes) still restore fine.

### Fixed
- Client-side local-backup flow always included notes via `NtApi.getAllDiary()`; the matching server import paths were missing `notes` in their INSERT statements — restoring a backup with notes used to silently drop them. Fixed in both `/api/data/import` and `/api/full-backup/restore`.

---

## [0.39.7-beta] — 2026-04-19

### Added
- **Recently Added foods** — when picking food for a meal (Foods tab, empty search), a "Recently Added" section appears above results showing the 10 most recent unique items you've logged. One tap adds it to the target meal.
- **Save meal to library** — new action in the meal `⋮` sheet: "Save as meal…" — converts a diary meal into a reusable Meal entry with a name you choose.
- **Day notes** — per-day free-text notes on the diary (e.g. "felt bloated after lunch"). Collapsible card at the bottom of the diary; a small pencil indicator appears next to the date when a note exists. Toggleable in Settings → Diary display → "Show daily notes" (default on). Notes sync across devices like the rest of diary data.

### Changed
- Diary table gains a `notes` column (auto-migration on server + native Android).

---

## [0.39.6-beta] — 2026-04-19

### Added
- **Meal-level actions** — new `⋮` button on each meal header opens an action sheet:
  - **Copy items to…** — duplicate all items from one meal into another on the same day.
  - **Move items to…** — transfer all items from one meal to another on the same day.
  - **Copy meal to another date…** — pick a date + target meal; items are appended there (source day unchanged).
  - **Clear all items** — with confirm dialog, removes every item in the meal for the current day.
  - Empty meals open to a single "Add food" shortcut so the entry point is always consistent.

---

## [0.39.5-beta] — 2026-04-19

### Added
- **Password strength indicator** — real-time weak/fair/strong bar on AcceptInvite, ResetPassword, Profile change-password, and Wizard admin account forms. Shared `src/lib/validation.js` mirrors LiftTrace.
- **Wizard integration step summary** — shows which services (Open Food Facts, USDA, Mealie, FitBot AI) are configured vs skipped.
- **MealEditor inline Add Ingredient button** — always visible at the bottom of the ingredient list with running totals (kcal · N items).
- **Foods source filter reset toast** — subtle info toast when switching tabs silently resets the source back to Local.
- **Foods pick-mode confirm label** — button now reads "Add N" (was just a checkmark) so users know exactly how many items they're adding.
- **Statistics quick-select chips** — Last 7d / 30d / 90d / This month / Last month / YTD on the custom date range.
- **Goal editor section hierarchy** — sheet now grouped into Display / Goal Behavior / Target sections with hint subtitles under each toggle explaining what it does.

### Changed
- `showInfo()` toast helper added to `src/stores/toast.js` for subtle info messages.

---

## [0.39.4-beta] — 2026-04-19

### Changed
- **Sleep score formula tuned** (19-day calibration) — reduced quality bonus ceiling (8→6) and HRV component ceiling (15→12, null default 10→8). Targets the "great night" overshoot pattern where the formula was giving 95-100 for nights Fitbit scored 81-89. Sleep MAE 2.16→1.74, max gap 11→9. Indirectly improves stress accuracy since sleep is 60% of the stress formula.

---

## [0.39.3-beta] — 2026-04-18

### Added
- **Bedtime reminder** — new notification type for sleep. Evening nudge at user-set time (default 22:30) with optional wind-down pre-reminder (15/30/45/60/90 min before). Smart message toggle adjusts the text based on last night's sleep vs goal (e.g., "You slept 5h last night — prioritize an earlier bedtime"). Fires on server scheduler (push) and native Android worker (local).

### Fixed
- **Weigh-in reminder skips if already weighed in** — previously fired at the scheduled time regardless. Now checks both `diary.body_stats.weight` (manual entry) and `wellness_data` with `metric_type='weight_kg'` (Withings, Health Connect sync). Fixed on both server scheduler and native Android worker.

---

## [0.39.2-beta] — 2026-04-17

### Changed
- **Sleep stages mobile layout** — on narrow screens (under 500px), sleep stage breakdown now renders as a vertical list (colored dot + label + duration + %) instead of floating labels that overlap when segments are small. Tablet/desktop (≥500px) layout unchanged — stacked bar with midpoint-positioned labels. Responsive across phones, foldables (closed/open), and phone landscape.

---

## [0.39.1-beta] — 2026-04-16

### Added
- **Scheduled syncs now include workouts** — Fitbit workout activity logs sync alongside metrics on every scheduled cycle (when workoutsEnabled is true).
- **Full sync range** — all scheduled device syncs (Fitbit, Garmin, Withings) now sync the user's full configured sync range, not just today.
- **Health Connect goal checks** — HC manual sync triggers step + wellness goal celebrations. Works in local mode (no server needed).
- **GPS Retry button** — "No GPS data available" placeholder now includes a Retry button.
- **Device-agnostic goal alerts** — step goal and wellness alerts fire once from merged data across ALL sources after all device syncs complete.

### Fixed
- **Fitbit logId precision** — logIds exceeding JavaScript's MAX_SAFE_INTEGER were silently rounded by JSON.parse, causing GPS/TCX fetches to fail with wrong IDs. Now extracted as strings from raw JSON before parsing.
- **GPS flag protection** — `has_gps` can only go 0→1 on re-sync (MAX), never downgrade. Prevents scheduled re-syncs from hiding GPS data when Fitbit API inconsistently returns hasGps:false.
- **Workout deduplication** — cleans up duplicate workout entries created by logId precision fix (keeps entry with GPS data or newer one).
- **Step goal notification spam** — three independent paths were firing step notifications with different dedup keys. Unified all paths to use `_celeb_` prefix with matching key names. Steps removed from generic `checkGoals()` to prevent double-fire.
- **Unified notification dedup** — server push-notify.js and client notifications.js now share the same dedup keys in app_config via `/api/settings/claim-celebration` endpoint. All goal types covered: steps, calories, water, wellness alerts, workouts, sync failures. Works cross-device.

---

## [0.39.0-beta] — 2026-04-12

### Added
- **Self-service account deletion** — users can delete their own account and all associated data from Settings → Data & Privacy → Danger Zone. Cascades all foods, meals, diary, settings, wellness data, chat history. Prevents the last admin from deleting themselves.
- **Per-device sync scheduling** — each connected service (Fitbit, Garmin, Withings, Health Connect) now has independent sync controls: mode (auto/scheduled/manual), interval (30min to daily), and active window. Daily interval shows a "Sync At" time picker; sub-daily shows start/end active window. Falls back to legacy shared settings for existing users.
- **Diary item Replace action** — long-press a diary item → Replace opens the food picker in the same meal slot. Picks a new food, deletes the old one. Context menu reordered: Edit, Replace, Move to meal, Select multiple, Delete.
- **Mandatory account creation on PWA** — server blocks all data APIs (503) when no users exist. First visit forces account creation via the wizard. Android local mode unchanged.

### Changed
- **Email templates polished** — added greeting lines, hidden preheader text for inbox previews, unified accent green (#00C47A), section headers via helper, stat row units dimmed, unsubscribe moved to footer slot. Optimized email logo from 1.1MB to 19KB (120x120 retina).
- **Wellness tab renamed** — "Movement" → "Activity" (matches Fitbit, Garmin, Apple Health conventions).
- **Recipe portion sheet unified** — now uses the shared Sheet component matching the diary food picker layout (side-by-side serving size + unit, total amount summary bar).
- **Notifications badge removed** — "Experimental" label removed from Notifications section header.
- **Time format respected everywhere** — TimePicker, water logs, workout times, FitBot chat timestamps all honor the 12h/24h setting. TimePicker shows 24h grid (00-23) when configured.
- **Readiness/stress formulas tuned** (6-day calibration) — readiness: HRV concave power curve (pow 0.7, gain 80), weights 0.75/0.05/0.12+4, MAE 7.3→4.5. Stress: sleep weight 0.60, HRV gain 40, smoothing 0.40/0.60, MAE 6.0→3.17.

### Fixed
- **PWA stale cache** — replaced NavigateFallback with NetworkFirst for navigation. Deploys are picked up on next page load; no more manual cache clears.
- **FitBot false unread dot** — persisted seen count in localStorage so component remounts don't show phantom notifications.
- **Recipe portion sheet backdrop** — clicking outside no longer cancels ingredient input; only the X button dismisses.
- **Scheduler dedup persistent** — all notification timestamps stored in app_config DB (survives container restarts). Weekly summary dedup check moved after day/hour gate so timestamp only burns on actual send.
- **Sync timeout** — POST/PUT/DELETE pass-through uses 30s timeout (was 3s, causing Fitbit/Garmin/Withings sync failures on Android).

---

## [0.38.9-beta] — 2026-04-11

### Fixed
- **Smart Log: food swap now recalculates portion size** — switching to an alternate food match was keeping the original food's serving size in grams. Now recalculates based on the new food's base portion, so nutrition values display and save correctly.
- **Android: instant local data loading when server is down** — Foods page was blocking on a `getSharingStatus()` server call before loading local data. Moved server calls to non-blocking background. Goals page had the same issue with dynamic calorie goal fetch. Both pages now render cached data instantly.
- **Android: image map loaded before app renders** — moved `loadImageMap()` from App.svelte `onMount` (runs after first render) to main.js boot sequence (runs before App mounts). Diary food images now display on first paint instead of after a delay.
- **Faster server-down detection** — reduced all network timeouts from 5-8s to 3s. `checkOnline()` now short-circuits for 15s after a failed check, so repeated sync cycles don't stack timeouts.
- **Settings search: added missing keywords** — Smart Log, Voice, Quick Log, Goal Insights now searchable in AI section. Weekly Summary, Email Summary added to Notifications. Health Connect added to Wellness.

---

## [0.38.8-beta] — 2026-04-10

### Fixed
- **Android: app now works correctly when server is unreachable but phone has internet** — previously the background auth refresh could clear the cached user on server error (e.g., 502 from Cloudflare tunnel), causing the app to show a login screen and preventing cached data from loading. The native auth refresh now never clears `currentUser`; it only updates on a valid server response.
- **API pass-through timeout** — `NtApiCached` pass-through methods (`get`, `post`, `put`, `del`) now use an 8-second timeout so they fail fast instead of hanging when the server is unreachable.

---

## [0.38.7-beta] — 2026-04-09

### Added
- **Cross-device chat sync** — FitBot chat history is now part of the differential sync pull. Messages sent from one device show up on another on the next sync cycle (30s on native, visibilitychange on PWA). No more refresh-to-see.
  - Server: `/api/sync/pull` now returns `chat_history` rows newer than `since`.
  - Client sync engine dispatches `nt:chat-updated` after pulling new rows.
  - `AIFitBot` listens for `nt:chat-updated`, `nt:sync-complete`, and `visibilitychange` — merging new messages in place (deduped by role+content+time) and surfacing an unread dot if the panel is closed.

### Changed
- **Sync bar trimmed to errors only** — removed "Syncing…", "Synced", and "Offline — changes saved locally" states. The bar now only appears when there's a real sync error worth the user's attention. Removes the every-30s flash that added visual noise without actionable information.
- **Connection badge — offline-only** — the cloud badge on the menu button no longer shows a green "online" state. It only surfaces when offline (red `cloud_off`). Follows the "errors are interesting, success is boring" principle; matches conventions used by Gmail, Slack, etc.

---

## [0.38.6-beta] — 2026-04-09

### Changed
- **Settings UX polish** — Goals section is now always visible; when no device is connected, the Dynamic Calorie Goal toggle is shown in a disabled state with an explanation ("Connect a device in Connected Services to enable"). Previously the entire Goals section was hidden.
- **Toggle component** — now accepts a `disabled` prop; disabled toggles are visually dimmed and non-interactive.
- **Notifications descriptions clarified** — "Device Notifications" now reads "Alerts delivered directly to this device — native on Android, browser pop-ups on desktop/PWA"; "Push Service" now reads "Server-relayed alerts via Apprise, Gotify, or ntfy — useful for PWA users or Home Assistant".
- **Smart Log setting description** — shortened to one line; expanded "Quick start" hint trimmed to trigger words only (removed duplicate how-to text).
- **Goal Insights description** — shortened from two sentences to one.

### Removed
- `isAndroid`, `isIos` exports from `platform.js` — were never imported anywhere in the codebase.
- `isServerConnected()` export from `platform.js` — was never called anywhere in the codebase.
- `setImageMap` from the import statement in `sync.js` — was imported but never used in that file.

---

## [0.38.5-beta] — 2026-04-09

### Added
- **Weekly Summary Email** — optional digest delivered by both push notification and email (if SMTP is configured). Covers: avg daily calories vs goal, goal hit rate, avg protein/carbs/fat, avg water, avg steps, avg calories burned, avg sleep, avg resting HR, avg readiness/stress scores, and weight change for the week.
- **User-configurable delivery day and time** — choose any day of the week and exact time in Settings → Notifications → Weekly Summary. Previously hardcoded to Sunday 9am.
- Settings: `weeklySummaryDay` (0=Sun…6=Sat, default Sun) and `weeklySummaryTime` (HH:MM, default 09:00).

---

## [0.38.4-beta] — 2026-04-09

### Added
- **FitBot Goal Insights** (Experimental) — new `get_diary_averages` tool gives FitBot access to your average daily intake over any period (calories, protein, carbs, fat, water), logging consistency %, and weight trend. When **Goal Insights** is enabled in Settings → AI Assistant, FitBot proactively compares your actual averages against your goals and offers evidence-based adjustments when patterns are consistent (>10% gap, 2+ weeks). Always asks before suggesting changes.
- **Health Connect in FitBot context** — today's Health Connect data (steps, calories, sleep, HR, HRV, weight) now included in FitBot's daily summary alongside Fitbit/Garmin/Withings.
- **FitBot tool descriptions improved** — each tool now explicitly states what data it provides and when to use it, reducing hallucination on borderline queries.

---

## [0.38.3-beta] — 2026-04-09

### Added
- **Dynamic Calorie Goal** (Experimental) — adjusts your daily calorie goal based on yesterday's calories burned from a connected device (Fitbit, Garmin, or Health Connect). Enable in **Settings → Goals**.
  - Three goal factors: Lose (−20%), Maintain (×1.0), Gain (+20%) applied to yesterday's TDEE.
  - Falls back to your fixed calorie goal if no device data is available for the prior day.
  - Diary bottom bar shows a "⚡ Dynamic · X kcal goal" pill when active.
  - Goals page shows a "⚡ Dynamic" badge on the calories row and the effective goal with "based on X burned" annotation.
  - New server endpoint `/api/wellness/calories-out` merges calories_out across all sources (priority: Garmin > Health Connect > Fitbit).
  - Settings section hidden unless at least one device (Fitbit, Garmin, Health Connect) is connected.

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
- **GitHub Actions CI** — pushes to `main` automatically build and publish to GitHub Container Registry
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
