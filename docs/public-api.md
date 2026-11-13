# Public REST API

General-purpose REST routes under `/api/v1`, for your own scripts and
automations that want plain JSON over HTTP, rather than the [Model
Context Protocol](https://traceapps.github.io/docs/nutritrace/mcp/)
NutriTrace also speaks. Off by default. Pull-based, if you want to be
notified the instant something happens instead of polling, see
[outgoing webhooks](webhooks.md).

This is distinct from the [Federation API](federation.md): federation
(`/api/v1/foods`, `/api/v1/workouts`, `/api/v1/activity`,
`/api/v1/body-measurements`) is a stable wire contract for sister
TraceApps and is always on. The routes on this page
(`/api/v1/diary`, `/api/v1/goals`, `/api/v1/meals`, `/api/v1/steps`,
`/api/v1/body-composition`, `/api/v1/profile`) are for a user's own personal automation and are
gated behind the flags below.

## Enabling it

Set these in your server environment (see `DEPLOY.md`):

```
PUBLIC_API_ENABLED=1        # turns on the read routes below
PUBLIC_API_WRITE_ENABLED=1  # optional, turns on the write routes too
```

## Authentication

Same personal access tokens as MCP and federation: create one in
Settings, API Tokens (multi-user mode only, a token needs a real
account to own it). Send it as a bearer token:

```
Authorization: Bearer nt_pat_...
```

A token's `mcp:read`/`mcp:write` scopes govern both MCP tools and these
routes the same way: a token with `mcp:read` can read via either
interface, `mcp:write` unlocks the write routes on either interface
too. There is no separate REST-only scope to create.

## Rate limiting

Each token is limited to 60 requests per minute by default
(`API_RATE_LIMIT_PER_MIN` to change it). Responses carry
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; a
`429` response also carries `Retry-After`.

## Errors

A bad request (a malformed date, a date that doesn't exist such as
`2026-02-31`, a reversed date range, a meal id with no match) returns `400`
with `{"error": "..."}`. A missing or invalid token returns `401`; a
token lacking the required scope returns `403`.

## Endpoints

### Read (require `mcp:read`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/diary/:date` | One day's logged food items. `date` defaults to today. Also the day's completion marks, see [Day completion](#day-completion). |
| GET | `/api/v1/diary/:date/totals` | Summed nutrition (calories, macros, any micronutrients present) plus total water for that day. |
| GET | `/api/v1/goals` | The user's current macro/micronutrient/water goal targets. A goal with `sharedGoal: false` has one target per weekday in `days`, starting on Sunday, and its `max`/`min` is the week's highest; `goals_by_weekday` gives those by named day and `today.targets` gives today's targets in the user's time zone. Add `?date=YYYY-MM-DD` for the targets in effect on one day, or `?start=YYYY-MM-DD&end=YYYY-MM-DD` for an inclusive range, see [Goal history](#goal-history). |
| GET | `/api/v1/meals/search?query=&limit=&include_recipes=` | Search the saved meals catalog by name, or list all when `query` is omitted. Recipes excluded by default. |
| GET | `/api/v1/meals/recent?limit=&include_recipes=&start=&end=` | Most-recently-used saved meals. Optional inclusive `YYYY-MM-DD` `start`/`end` filter by the date each meal was last used; either can be left out. |
| GET | `/api/v1/meals/:id` | One saved meal's full contents, including every item. |
| GET | `/api/v1/steps?start=&end=&source=` | Persisted daily step observations from wellness data, one row per source. Inclusive `YYYY-MM-DD` bounds; a supplied bound leaves the other side open, both omitted means the last 90 days. `source` filters to one provider. Sources are never merged and missing days are not zeros. |
| GET | `/api/v1/body-composition?start=&end=&source=` | Persisted body-composition observations from `wellness_data`. Inclusive `YYYY-MM-DD` bounds; a supplied bound leaves the other side open, both omitted means the last 90 days. `source` is an optional exact filter. Metrics are grouped by `date` + `source`; observations from different sources remain separate, and missing observations are omitted rather than synthesized. |
| GET | `/api/v1/profile` | The user's gender and date of birth as set on the Profile page or during onboarding. Either field is `null` when unset. |

### Write (require `mcp:write` and `PUBLIC_API_WRITE_ENABLED=1`)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/v1/diary/:date/food` | `{food_id, meal?, quantity?, portion?, unit?, notes?}` | Appends a food from the user's catalog to a diary day. `food_id` comes from the foods federation endpoint or the app's own search. |
| POST | `/api/v1/diary/:date/water` | `{amount_ml, time?}` | Appends a water log entry. |
| POST | `/api/v1/diary/:date/meal` | `{meal_id, meal?}` | Expands a saved meal's items into a diary day. |
| PUT | `/api/v1/diary/:date/body-stat` | `{stats: {weight?, body_fat?, waist?, ...}}` | Merges the given values into that day's body stats. |

Not yet exposed here: editing or deleting a diary entry, or creating a
new catalog food. Those stay MCP-only for now (`edit_diary_entry`,
`delete_diary_entry`, `create_food` in the MCP setup guide), since each
requires `MCP_DESTROY_ENABLED` plus the `mcp:destroy` scope plus
`confirm: true` on the MCP side, and this surface has not needed that
capability yet.

Also not duplicated here: food search and recent-foods. The existing
federation route `GET /api/v1/foods?q=` (scope `read:foods`) already
covers searching the foods catalog; mint a token with `read:foods` and
use that endpoint instead of a second, overlapping route.

## Goal history

`GET /api/v1/goals` with no query parameters returns the current goals,
unchanged. For a report on past intake, ask for the target that was in
effect then instead of applying today's settings to an old diary day:

```
GET /api/v1/goals?date=2026-09-23
GET /api/v1/goals?start=2026-09-21&end=2026-09-27
```

Dates are **the account's calendar dates**: the day in the `timezone` the
account set, so one edit resolves to the same day on every device. With no
`timezone` set yet (the app records one on first launch), a dated request
uses UTC, the same fixed fallback the app uses, so the phone and the server
still name one day; the response without a date is unchanged. A snapshot is
effective from its `effective_from` date (inclusive) until the day before
the next snapshot.

Several changes on one calendar day collapse to that day's final complete
configuration. Each setting in it is decided by when that setting was last
changed (in milliseconds), the same way two devices' settings merge, so
changing the water goal on one device does not roll back a newer calorie
goal set by another on the same day. A late change to an earlier day
carries forward to the days that inherited that setting, up to the first
day that set it itself later. A reset clears the settings at the moment it
was made: a later edit brings a setting back, an earlier one does not. A
goal template is stored as one change, so its food and water goals never
appear apart.

Each day in a historical response holds the stored configuration (`goals`,
`water_goal_ml`, `calorie_goal_mode`, `calorie_goal_factor` and the activity
flags) plus:

| Field | Meaning |
|---|---|
| `known` | `false` for a date before the first recorded snapshot. The response then also has `reason: "before_first_recorded_snapshot"` and `history_available_from`, and no targets. |
| `effective_from` | The date the snapshot in effect that day was recorded. |
| `resolved_goals` | Every goal's value for that day: weekday goals resolved, percent macros converted to grams, `calories` the day's effective target. |
| `calorie_target_kcal` | The calorie target for the day, after the activity adjustment. |
| `calorie_base_target_kcal` | The calorie target before the activity adjustment. Percent macros follow this one, as in the Diary. |
| `calorie_basis` | Where the number came from: `fixed`, `dynamic` (with `calories_out`, its date and source) or `adaptive` (with `tdee` and `days_available`), or that it fell back to the fixed goal. |
| `activity_adjustment_kcal` | Calories added for that day's logged or wearable activity, when the profile turns that on. `0` otherwise. |
| `weekday_order`, `goals_by_weekday`, `targets` | The weekday goals by named day, and that date's goal-derived calorie and macro targets (calories before an activity adjustment, macros in grams), as in the current response. |
| `history_complete` | On a range only: whether every day of it is known. |

Resolution uses NutriTrace's own rules, not a copy of them: per-weekday
goals, percent macros, Dynamic and Adaptive calorie modes, and the activity
policy, read from that day's settings and from the wearable, diary and
weight observations available up to that date. Use these resolved values
rather than reimplementing the formulas.

History starts when this feature is installed, or when an account is
restored from a backup made before it (the restore day becomes the first
snapshot, in the account's own time zone). NutriTrace does not invent older
history from today's settings.

A range may span at most 366 days; a malformed date, a date that doesn't
exist or a reversed range returns `400`.

## Day completion

`GET /api/v1/diary/:date` reports the marks made with Show Day Completion
(Settings > Diary) next to the existing `date`, `items` and `count`. Reading
them needs only `mcp:read`; they are set in the app, not through this API.

| Field | Meaning |
|---|---|
| `completion_enabled` | The diary's Show Day Completion setting as saved on the server: `true` (on), `false` (turned off), or `null` when the server has no saved value. `null` is common after starting in single-user mode, where settings stay in the browser, and when the setting was never changed. Treat `null` as unknown, not as off. It is the day-level setting: the per-meal checks have no setting of their own and appear whenever it is on, but `true` does not mean the user marks individual meals. Use `completed_meals` for that. |
| `completed_at` | When the day was marked complete, in UTC (`YYYY-MM-DD HH:MM:SS`), or `null` while the day is open. Marking an already closed day again keeps the first time; reopening and closing it again gives a new one. Reopening the day sets it back to `null`; editing a closed day does not. |
| `completed_meals` | Meal slot indexes marked complete (the same numbers as each item's `meal`), sorted. `[]` when none. |

A day can be marked complete on any date, including past ones and days with
no food logged (for example a fast). A non-null `completed_at` is the mark
itself, even if the user later turns the setting off. With
`completion_enabled: true`, a `null` `completed_at` means the day is open;
with `false`, it means the day is not being tracked; with `null`, it is
unknown which. Servers older than this change leave all three fields out;
treat a missing field as unknown, never as open or complete.

```json
{ "date": "2026-09-12", "items": [], "count": 0,
  "completion_enabled": true, "completed_at": "2026-09-12 21:04:11", "completed_meals": [0, 2] }
```

## Examples

```bash
# Today's logged food
curl -H "Authorization: Bearer nt_pat_..." \
  https://your-nutritrace.example.com/api/v1/diary/2026-09-12

# Log a food
curl -X POST -H "Authorization: Bearer nt_pat_..." -H "Content-Type: application/json" \
  -d '{"food_id": 42, "quantity": 1}' \
  https://your-nutritrace.example.com/api/v1/diary/2026-09-12/food

# Today's goal targets
curl -H "Authorization: Bearer nt_pat_..." \
  https://your-nutritrace.example.com/api/v1/goals

# Step observations for a date range, one row per source
curl -H "Authorization: Bearer nt_pat_..." \
  "https://your-nutritrace.example.com/api/v1/steps?start=2026-09-01&end=2026-09-07"

# Body-composition observations for a date range, separated by source
curl -H "Authorization: Bearer nt_pat_..." \
  "https://your-nutritrace.example.com/api/v1/body-composition?start=2026-09-01&end=2026-09-07"

# Profile facts (gender, date of birth)
curl -H "Authorization: Bearer nt_pat_..." \
  https://your-nutritrace.example.com/api/v1/profile
```
