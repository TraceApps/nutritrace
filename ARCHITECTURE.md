# Architecture

Orientation for new contributors. Covers the shape of the codebase,
the design decisions worth knowing before touching things, and the
house conventions that aren't obvious from reading the source.

## Stack

- **Frontend:** Svelte 5 in compatibility mode (`runes: false`, so components
  keep Svelte 4 syntax), svelte-spa-router v4 (hash routing), Vite 6
- **Server:** Node + Express, better-sqlite3
- **Mobile:** PWA + Capacitor 8 (Android)
- **Deploy:** `docker compose up -d`, serves on port 3001

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
notes + brand; one day, or up to 31 a call), `get_workouts`, `get_goals`,
`get_diary_averages`, `get_meals` (saved Meals/Recipes library, 50 a
page). Execution loop runs up to 12 rounds, then one last request with
the tools off answers from what was found. System prompt instructs the AI to always use
tools to fetch real data rather than relying on context. See
`src/lib/aiChat.js`.

### Coaching

A coach and a client are a row in `coach_clients` (pending, active,
declined, ended; one active row per client). Every route under
`/api/coaching/clients/:clientId` goes through one guard
(`requireCoachOf`, `server/lib/coaching.js`): an active pairing between
this coach and this client, and the Coach role (or admin). The privacy
test reads those routes from the source, so a new one can't be missed.

Recommendations (`coach_recommendations`: targets, day plans, meals,
recipes) carry a copy of what they recommend in `payload`; only the
client's answer changes anything. Targets are applied on the client's
device (their goals are their settings), saving the old ones as a
template first for Undo. A day plan is logged through `addDiaryItem`, so
logged items are ordinary diary items marked `source:
coach:plan:<id>:<meal>.<n>`; a meal or recipe sent with Send to Client is
copied into the client's catalog by the server at Accept. The shared
rules live in `src/lib/coach-targets.js` and `src/lib/coach-plans.js`,
which the server's Docker image copies.

Messages (`coach_messages`) carry a uuid made on the device, so a
message sent offline goes once. Photos live under `uploads/coaching`,
served only to the two people. Coaching state rides on `/api/auth/me`
and a fingerprint header on the settings refresh, so people not in
coaching make no extra request and run no timer. Android keeps messages
and recommendations in its own tables and syncs them with
`/api/sync/pull?coaching=1` and `/api/sync/push`.

Trace's coaching tools (`src/lib/coach-trace.js`) are offered only to
people in coaching: a coach's Trace reads a client's summary and catalog
and prepares drafts the coach opens and sends; a client's Trace reads
their recommendations. None reads the conversation.

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

### Browser offline mode

`src/lib/offline-api.js` sits in front of every API call in the
browser. Online it calls the server and keeps what comes back in an
IndexedDB mirror; unreachable, it answers the diary, your foods,
meals, recipes, activity, settings, goals, fasts and profile from the
mirror and queues writes in an outbox. Back online, queued days and
food, meal, activity and fast edits go up through `/api/sync/push`, so
the server merges browser edits exactly as it merges the phone's. It deliberately avoids the Background Sync API
(Safari lacks it, and iPhone is why this exists); the page flushes on
a backoff and on the `online` event, and a Web Lock keeps two tabs
from sending at once. The merge rules are pure functions in
`src/lib/offline-edits.js` so they test without a browser.

The service worker precaches the built app. Page loads go to the server first
and fall back to the precached `index.html` offline, after 3 seconds, or on a
5xx from a proxy, and nothing is stored from them, so a reload after a deploy
gets the new app and a sign-in proxy can show its page
(`src/lib/pwa-navigation.js`, notetrace#37). The API and uploads opened as a
page always go to the server and are never kept (`NetworkOnly`), so an export
or a backup can't outlive the session; `public/sw-retired-caches.js` deletes the
old `pages-cache` that held them.

A server that takes the connection and never answers fails no request, so
each request with an offline answer gets a deadline for the server's first
answer (a long body still downloads at its own pace)
(`src/lib/request-deadline.js`, the same file in the four Trace apps): the
sign-in check at startup with an account kept here (3 s), a read (4 s: the
copy answers, or it says it needs a connection, as with none; 10 s for the
reads the app names heavy, whole lists and stats, for a small server with a
big account). One that runs out counts as no connection (`err.offline`),
and the server counts as quiet for 20 s: reads wait 1.5 s, and changes go
into the outbox without being sent, unless one sent before is still waiting
(`queueUnsent`), so the older one can't land last over it. A change that is sent (and the outbox's
replay) has no deadline, as before: one cut off might have landed, and sent
again it could be made twice. Any answer from the server ends that
early, and a read that runs out while quiet doesn't start it again, so a
server slower than 1.5 s is asked at full length when it ends. Reads the app
names slow wait as long as they take: food databases, wellness
providers, Trace, coaching, the adaptive TDEE, exports and backups
(`offlineDeadlineMs()` in `offline-api.js`).


### Two edits of one row: the newer edit of each field

When the same row is changed in two places (the phone offline, the web, a
second phone), the server keeps the newer edit of each field, not of the
whole row (`server/lib/field-sync.js`, the same file in `src/lib` and in
every Trace app that uses it, pinned by `scripts/field-sync.test.js`). Each
synced row keeps when each field last changed (`field_times`, server only,
never sent to an app): triggers stamp every write that changes a field
(`db.js`), unless the write stamps its own (a merged edit, at the time it
was made). The fields and the groups that stay together, such as a food's
nutrients with its serving, are in `server/lib/sync-fields.js` (copied to
`src/lib`). A day's measurements are fields of their own
(`body_stats.<key>`, `server/lib/body-stats-merge.js`); its items and water
merge by uuid and its note by its own time, as before.

- `POST /api/sync/push`: a row is an edit made at its `updated_at` (on the
  server's clock, `lib/sync-clock.js`), changing the fields it lists in
  `changed_fields`, or every field it sends when it lists none (apps before
  this). `field_edits` gives each field's own edit time, so a field changed
  before a later change of another keeps its time. A day lists the
  measurements it changed in `body_stats_changed` (times in
  `body_stats_edits`).
  A delete made before a later edit doesn't win, an edit made before a
  delete doesn't bring the row back, and one made after does. When what
  stays isn't what was sent, the answer carries the row (`row`) and its
  pull cursor moves. A setting's value is one field: an older change no
  longer replaces a newer one.
- `PUT /api/foods/:id`, `/api/meals/:id`, `/api/activity/:id` and
  `PUT /api/diary/:date` take `changed_fields` (and `body_stats_changed`):
  the save changes only those, so a form opened before an edit made
  elsewhere doesn't put it back (`lib/rest-merge.js`). Without them they
  write what they're sent, as before.
  Foods, meals and recipes deleted elsewhere: a save is made now, so it
  follows the rule a push of the same change follows (`editRevives`). One
  that changes something brings the row back (`deleted_at` cleared, stamped
  in `field_times`) with what it changed; one that changes nothing, or
  comes in the second of the delete, is answered 410 `{ gone: true }` and
  the delete stays, as LiftTrace answers a save made before a delete
  (`deletedSave`, `lib/rest-merge.js`). Activities and fasts answer 404 for
  a deleted row, as before.
- The Android app keeps the server's copy of each row as `server_base`
  (`src/lib/sync-base.js`, set by each pull, each push that lands, and
  before the first edit of a row from before) and when each field was
  changed here (`edit_times`), and sends what changed since, each with its
  time. A row edited before the update (no copy kept) goes up whole; edited
  again after it, each field goes with its own time (`_rest` in
  `edit_times`: the earlier edit's). A save sent straight to the server
  online sends only what that save changed. A pull leaves a row changed
  here and not sent yet as it is (activity and fasts too); it goes with
  the next push. So does a pulled delete of such a row, when the change
  was made after the delete (`editRevives`, as the push is judged; a
  deleted row in the pull says when the delete was made, `delete_time`,
  which for one made offline on another phone is before it arrived): the
  push brings it back. A change made before the delete, or in the same
  second, goes with it, and a day by its `deleted_at` the same way. Items
  and water deleted elsewhere stay deleted (`diary_tombstones`), as the
  server keeps them.
- A link the phone fills in (a recipe ingredient's or a diary item's food,
  once that food has a server id: `dbLinkDiaryItems`) is bookkeeping, not
  an edit, so it is never stamped as one made now (`src/lib/relink-stamp.js`).
  The row keeps the time it had, a millisecond on and in the same second
  (the millisecond only so a push in flight, which `dbMarkSynced` matches by
  `updated_at`, doesn't mark the link as sent), and for a recipe the items'
  own edit time in `edit_times`. A time from a pull is sent as `+00:00`
  (the server's clock, which it takes as it is; sent bare it would be
  shifted by the phone's clock error). The server counts an edit from
  before its row existed as made when it arrives, and the phone's own time
  for a recipe it made is from before that: so a recipe a push made takes
  that push's `server_time` as its `updated_at` once it is marked sent
  (`dbStampMade`, what a pull would give it), and one linked in that same
  push is linked at that time at the earliest. A row sent again with the
  same `client_key` that was deleted meanwhile is answered with the deleted
  row (`row`, as when an older edit loses to a delete), so the phone drops it
  instead of taking it for one it just made. So a link loses to every delete
  and every newer edit its row's last edit lost to, and ties go to the
  delete. When a link loses to a newer edit of the items made elsewhere,
  the server sends that copy back and the phone takes it, then fills the
  links it made into it again (`dbApplyServerWinner`), at that copy's own
  time: the next push lands them on the edit, once, and nothing is sent
  after. A day's link takes the
  day's time the same way; the server still brings back a deleted day
  whatever pushes to it (`POST /api/sync/push`, diary), so a day deleted
  elsewhere after the phone's last sync can still come back with a link.
  Known edge: a recipe with a rename waiting and no time of its own for its
  items (they were sent, the link was not) is linked at the rename's time,
  so a web edit of the items made between the two is written over.
- `POST /api/foods/:id/copy` and `/api/meals/:id/copy` (Save a Copy) skip
  deleted rows: a copy the person deleted isn't the copy they already made,
  so copying again makes a new one, and an item its owner deleted answers
  404 (after the check who may read it, so a deleted private one is still
  403 for anyone else, and after the copy already made, so asking again
  finds it). The Android app copies its own row of that number only when
  the server can't be reached, never when the server answered.
  `GET /api/foods/:id` and `/api/meals/:id` still answer a deleted row (with
  its `deleted_at`): a logged recipe is split by reading its recipe, deleted
  or not.
- A food or meal saved with a source (`source_app`, `source_external_id`: a
  recipe pulled from CookTrace, a coach's food) holds its place in the
  unique index `(user_id, source_app, source_external_id)` only while it
  isn't deleted. A deleted one lets go of its source when the same source
  comes in again (`POST /api/foods`, `/api/meals`, a push, a coach's
  recommendation, a restore), and the new one is made; a live one is
  updated in place, as before.
- The browser sends what an offline edit changed (against the row it
  showed), each field with the time of the queued edit that changed it,
  and an online save sends what changed against the copy it holds, unless
  the form was opened on another copy (a different `changed_at`). The diary
  says which measurements a save changed. An edit queued by the app before
  it said what changed, queued with ones after, makes the row go whole, but
  each field keeps the time of the edit that last changed it; a day goes
  as the measurements its saves hold or say (`body_stats_changed`), so one
  added elsewhere since stays (the phone's `_rest` day too).
- A write that moves a row's `updated_at` without changing a field (logging
  a food bumps how often it was used) isn't an edit: a row from before the
  times starts them from the write before (`fs_<table>_base` in `db.js`).
  A full backup restores `field_times`, the diary tombstones (dropping one
  that names an item or water entry its restored day holds, or the next
  save's merge would take it away again), and every column but the pull's
  cursors: foods, meals, activities and fasts get `changed_at` now from the
  insert, and diary days, settings, wearable workouts and coach messages
  and recommendations get `updated_at` now, so every device pulls them
  again. Foods, meals, days, activities, fasts and coach messages a device
  may hold that the backup doesn't are kept as deleted (a message without
  its text or photo; the delete stamped now in `field_times`), only for the
  same accounts and pairings (`keepGone` in `server/routes/full-backup.js`).
  Wearable workouts and readings it removed get a `sync_deletions` record
  from the restore's own delete, and records from before the restore that
  devices may not have pulled yet are kept (the accounts' delete would take
  them).

### Android account protection

One phone can sign in to more than one account or server, and the
local SQLite copy is tagged with the account it belongs to
(`src/lib/local-account.js`). Signing in as someone else clears the
copy, and unsynced changes from the previous account are never pushed
under the new one (the app asks first). Every change of account bumps
an account generation, and a sync started before it writes nothing
after it. Each switch and sign-out also forgets NutriTrace's own
cookies (`nt_token`, `nt_oidc_logout`) so the server can't answer as
the previous account, while a sign-in gate's cookies in front of the
server stay. `src/lib/user-state.js` resets the in-memory stores
(day on show, activities, fasts, settings, editor state) before
anything is shown.

### Fold framework

`src/lib/fold-core.js` is pure and tested: size classes and fold
reports turned into `{ posture, start, end }`. `src/lib/fold.js` reads
the fold from the Android `FoldPlugin` (Jetpack WindowManager) or the
browser's Viewport Segments API and sets `fold-book`, `fold-tabletop`
or `fold-flat` plus `--fold-start` / `--fold-end` on `<html>`.
`src/styles/fold.css` moves only surfaces that can't be scrolled out
of the way (dialogs, sheets, menus, Trace) off the crease; a diary,
chart or photo may cross it. Wide layouts gate on `html.wide-content`
(720px of content beside the sidebar), not on the viewport width.

### Only the app's own addresses get CORS

`server/lib/cors.js` (identical in all four Trace apps) decides which pages
on another address may call the API with the person's sign-in. Allowed: the
Android app's WebView (`https://app.nutritrace.local`, and
`https://localhost` from versions before it) and the address in
`PUBLIC_URL`, each compared whole: scheme, host and port. Anything else gets
no CORS headers. The web app calls its own address, which needs none;
the API, MCP and calls from other servers send no Origin.

### Changes from another site are refused

`server/lib/cross-site.js` (identical in all four Trace apps) runs before
every route: a request that changes something (any method but GET, HEAD and
OPTIONS) passes only when the browser's `Sec-Fetch-Site` is `same-origin` or
`none`, or its `Origin` is one CORS allows (above) or exactly the request's
own address (from `X-Forwarded-Proto` and `X-Forwarded-Host`, or Host), or
it carries neither header (MCP, the API, scripts, the other Trace apps'
servers). Browsers always send `Origin` on these methods (`null` from a
sandboxed frame or a page that sends no referrer), and a page can't change
it, so a page on any other address, on the same site or not, can't send a
form, a no-cors fetch or an upload that changes anything, with or without
the sign-in cookie. Anything else gets a 403 (`code: "cross_site"`) and one
warning in the log per address. Behind a proxy that passes neither the
public `Host` nor `X-Forwarded-Host`, writes need `PUBLIC_URL` over plain
http (no browser sends `Sec-Fetch-Site` there) and, over https, from older
browsers without it (such as Safari before 16.4). It can't tell apart apps
that share one origin (two apps under subpaths of the same host), and a DNS
rebinding page counts as the app's own address.

The CSRF token (`server/middleware/csrf.js`) still guards signed-in
sessions; this also covers a server without accounts, which has no sign-in
for a token to protect.

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
  `@capacitor/browser` pattern. Any installed app can register for
  `nutritrace://`, so the deep link never carries the session token.
  Before opening the sign-in page the app makes a random secret and
  sends only its SHA-256 as `app_challenge`
  (`src/lib/oidc-app-handoff.js`). The server callback
  (`server/routes/oidc.js`) redirects to
  `nutritrace://oidc-callback/?code=<code>` with a single-use code, and
  the app swaps code plus secret for the token at
  `POST /api/auth/oidc/handoff`. An app that caught the link has the
  code but not the secret. Builds too old to send `app_challenge` still
  get the token in the link. Keep the trailing slash: Chrome Custom
  Tabs needs it to dispatch the OS intent reliably

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
- `LOG_LEVEL`, error / warn / info (default) / debug / trace
- `TRACE_REQUEST_BODIES`, separately opts sensitive request content into trace logs
- `TRACE_REQUEST_PATHS` and `TRACE_BODY_MAX_BYTES`, limit traced routes and output size (`none` disables body tracing)
- Request diagnostics count bytes before parsing and capture selected, bounded request bodies after access checks; `X-Request-ID` correlates client and server logs
- `SMTP_*`, optional, locks Settings UI fields when set
- `AI_*`, optional, locks AI Assistant settings when set
- `PUBLIC_URL`, the address emailed links (reset, invite, sharing)
  use; unset, an address an admin has used, never request headers
- `ALLOW_PRIVATE_IMAGE_URLS`, lets every account, not only an admin,
  download photo links from the server's own network
- `UPDATE_CHECK=off`, turns the server's GitHub release checks off
  whatever the in-app setting says

## Conventions

- **Cookie / storage prefix:** `wl_u<id>_<key>` (legacy from
  waistline; intentional)
- **Auth cookie:** `nt_token`
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
