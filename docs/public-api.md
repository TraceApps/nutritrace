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
`/api/v1/profile`) are for a user's own personal automation and are
gated behind the flags below.

## Enabling it

Set these in your server environment (see `DEPLOY.md`):

```
PUBLIC_API_ENABLED=1        # turns on the read routes below
PUBLIC_API_WRITE_ENABLED=1  # optional, turns on the write routes too
```

## Authentication

Same personal access tokens as MCP and federation: create one in
Settings, API Tokens (admin, multi-user mode only, a token needs a real
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
| GET | `/api/v1/diary/:date` | One day's logged food items. `date` defaults to today. |
| GET | `/api/v1/diary/:date/totals` | Summed nutrition (calories, macros, any micronutrients present) plus total water for that day. |
| GET | `/api/v1/goals` | The user's current macro/micronutrient/water goal targets. |
| GET | `/api/v1/meals/search?query=&limit=&include_recipes=` | Search the saved meals catalog by name, or list all when `query` is omitted. Recipes excluded by default. |
| GET | `/api/v1/meals/recent?limit=&include_recipes=&start=&end=` | Most-recently-used saved meals. Optional inclusive `YYYY-MM-DD` `start`/`end` filter by the date each meal was last used; either can be left out. |
| GET | `/api/v1/meals/:id` | One saved meal's full contents, including every item. |
| GET | `/api/v1/steps?start=&end=&source=` | Persisted daily step observations from wellness data, one row per source. Inclusive `YYYY-MM-DD` bounds; a supplied bound leaves the other side open, both omitted means the last 90 days. `source` filters to one provider. Sources are never merged and missing days are not zeros. |
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

# Profile facts (gender, date of birth)
curl -H "Authorization: Bearer nt_pat_..." \
  https://your-nutritrace.example.com/api/v1/profile
```
