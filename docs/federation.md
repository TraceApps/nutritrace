# TraceApps Federation API

A read-first, Bearer-authenticated REST API that NutriTrace exposes for
sister apps in the TraceApps ecosystem (CookTrace, LiftTrace, plus any
self-hosted custom integrations) to consume.

This is an **internal cross-app contract**, not a public API for
third-party developers. The wire format is stable across NT releases
within a major version; consumers code against this document, not
against NT's internal database schema.

---

## Versioning

Endpoints live at `/api/v1/`. The `v1` namespace is the contract.
Breaking schema changes require shipping `v2` in parallel; v1 is not
broken without long lead time.

Within v1, additive changes (new fields on existing objects, new
endpoints) are non-breaking and may ship at any time. Consumers must
ignore unknown fields.

---

## Authentication

Bearer token. Tokens are generated per-user in the NutriTrace UI
(Settings → Admin → API Tokens), shown to the user once at creation,
and stored as a SHA-256 hash on the server.

```
Authorization: Bearer nt_pat_<32-byte-base64>
```

A token belongs to exactly one user. Calls made with the token act as
that user, scoped to that user's foods, recipes, and diary entries.
There is no concept of a "service account" or app-level token.

Token format prefix: `nt_pat_` so leaked tokens are recognizable in
logs and credential scanners.

### Scopes

Each token carries a list of scopes. Calls outside a token's scopes
return `403 Forbidden`. Phase 1 is **read-only** and ships only one
scope:

| Scope          | Grants                                          |
|----------------|-------------------------------------------------|
| `read:foods`   | List + read foods owned by the user             |

Future read scopes (`read:meals`, `read:diary`) and any write scopes
will be added alongside the endpoints they unlock; gating tokens on
scopes the server can't actually serve is confusing UI.

### Rate limiting

60 requests / minute per token by default. Configurable via
`API_RATE_LIMIT_PER_MIN` env var. Limit headers returned on every
response:

```
X-RateLimit-Limit:     60
X-RateLimit-Remaining: 47
X-RateLimit-Reset:     1714750000
```

Over-limit responses return `429 Too Many Requests` with a
`Retry-After` header (seconds).

---

## Wire format conventions

- All responses are JSON.
- Timestamps are ISO 8601 UTC strings.
- Numeric nutrition fields are in the units listed in the field name
  (e.g. `calories` is kcal, `proteins` is grams). Consumers map to
  their own unit preferences on the way in.
- `null` is used for "not set." Empty string is reserved for "set to
  empty" (rarely used).
- Unknown fields must be ignored by consumers (forward-compat).
- Identifiers are integers, scoped to the issuing instance. A food
  with `id: 42` on instance A has nothing to do with `id: 42` on
  instance B.

---

## Phase 1 endpoints

### `GET /api/v1/me`

Identity check. Useful for clients to verify the token is valid and
discover which user it belongs to.

```json
{
  "user": {
    "id": 1,
    "username": "alice",
    "full_name": "Alice Example",
    "role": "admin"
  },
  "instance": {
    "url":     "https://nutritrace.example.com",
    "version": "1.0.0-rc.14"
  },
  "scopes": ["read:foods"]
}
```

Always available regardless of token scopes (it's identity, not data).

### `GET /api/v1/foods`

List foods owned by the authenticated user. Supports basic filtering.

Query parameters:

| Param      | Type    | Default | Description                          |
|------------|---------|---------|--------------------------------------|
| `q`        | string  | —       | Substring match on `name` or `brand` |
| `limit`    | int     | 100     | Max results, capped at 500           |
| `offset`   | int     | 0       | Pagination offset                    |
| `category` | string  | —       | Filter by exact category match       |

Response:

```json
{
  "items": [ Food, Food, ... ],
  "total": 1240,
  "limit": 100,
  "offset": 0
}
```

### `GET /api/v1/foods/{id}`

Fetch a single food by its NutriTrace id. Returns `404` if the food
doesn't exist or is not readable by the token's user.

---

## Object: `Food`

```json
{
  "id":       42,
  "name":     "Skyr, plain",
  "brand":    "Siggi's",
  "category": "Dairy",
  "barcode":  "0098463900008",
  "portion":  100.0,
  "unit":     "g",
  "img_url":  "https://nutritrace.example.com/uploads/abc123.jpg",
  "notes":    "1 cup ≈ 245g cooked",
  "nutrition": {
    "calories":      59,
    "fat":           0.2,
    "saturated-fat": 0.1,
    "carbohydrates": 4.0,
    "sugars":        4.0,
    "fiber":         0,
    "proteins":      11.0,
    "sodium":        65,
    "calcium":       150
  },
  "created_at": "2026-04-12T18:32:11.000Z",
  "updated_at": "2026-05-01T09:14:00.000Z"
}
```

Field reference:

| Field         | Type             | Notes                                               |
|---------------|------------------|-----------------------------------------------------|
| `id`          | integer          | Stable within instance. Cross-instance refs MUST include the instance URL. |
| `name`        | string           | Required.                                           |
| `brand`       | string \| null   |                                                     |
| `category`    | string \| null   | Free text, user-defined category.                   |
| `barcode`     | string \| null   | EAN-13 / UPC-A as digit string. Leading zeros preserved. |
| `portion`     | number           | Reference quantity for `nutrition` values. Default 100. |
| `unit`        | string           | Unit for `portion`. Common values: `g`, `ml`, `oz`, `cup`. |
| `img_url`     | string \| null   | Absolute URL. May require auth (use `/uploads/...` proxy with the same Bearer token). |
| `notes`       | string \| null   | User-authored note (e.g. cooked-vs-raw clarifications). |
| `nutrition`   | object           | Keys are nutrient ids. Values are numbers per `portion`. See nutrient list. |
| `created_at`  | ISO 8601 string  |                                                     |
| `updated_at`  | ISO 8601 string  |                                                     |

### Nutrition keys (Phase 1)

The following keys are guaranteed present in `nutrition` if the food
has the data. Unknown keys may appear in future versions; consumers
must ignore them.

| Key                | Unit          |
|--------------------|---------------|
| `calories`         | kcal          |
| `fat`              | g             |
| `saturated-fat`    | g             |
| `trans-fat`        | g             |
| `monounsaturated-fat` | g          |
| `polyunsaturated-fat` | g          |
| `cholesterol`      | mg            |
| `sodium`           | mg            |
| `potassium`        | mg            |
| `carbohydrates`    | g             |
| `fiber`            | g             |
| `sugars`           | g             |
| `added-sugars`     | g             |
| `proteins`         | g             |
| `calcium`          | mg            |
| `iron`             | mg            |
| `magnesium`        | mg            |
| `phosphorus`       | mg            |
| `zinc`             | mg            |
| `caffeine`         | mg            |
| `alcohol`          | g             |
| `vitamin-a`        | µg            |
| `vitamin-c`        | mg            |
| `vitamin-d`        | µg            |
| `vitamin-e`        | mg            |
| `vitamin-k`        | µg            |
| `b1` ... `b12`     | mg / µg       |

---

## Errors

Standard HTTP status codes plus a JSON body:

```json
{ "error": "Token required",        "code": "auth_missing" }
{ "error": "Invalid token",         "code": "auth_invalid" }
{ "error": "Token lacks read:foods","code": "auth_scope" }
{ "error": "Not found",             "code": "not_found" }
{ "error": "Rate limited",          "code": "rate_limited" }
```

Consumers should switch on `code` (stable) rather than parsing
`error` (human-readable, may change).

---

## Phasing

**Phase 1 (current):** read-only. `read:foods` scope, foods endpoints,
token management UI, rate limiting, this document.

**Phase 2 (later):** more read scopes — `read:meals` (recipes),
`read:diary`. Strictly additive; existing tokens keep working.

**Phase 3 (later, with care):** targeted write endpoints for cross-app
flows (e.g. `write:diary` for LiftTrace pushing workouts into the NT
diary as activity entries). Each write endpoint is specific and
audit-logged; no generic "write anything" surface.

**Phase 4:** LiftTrace and CookTrace expose their own `/api/v1/` with
the same conventions, becoming peers to NutriTrace in the federation.

---

## Cross-instance references

Each instance issues its own integer ids. A CookTrace recipe that
references NutriTrace food id `42` should store both the food id and
the issuing instance URL, so the reference resolves correctly even if
the user later runs CookTrace against a different NutriTrace
instance.

Recommended reference shape (defined once here, used by all consumer
apps):

```json
{
  "instance_url": "https://nutritrace.example.com",
  "type":         "food",
  "id":           42
}
```
