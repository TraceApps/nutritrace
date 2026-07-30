<h1 align="center">NutriTrace</h1>

<p align="center"><b>Trace Every Bite</b></p>

<p align="center">A self-hosted personal nutrition tracker.<br/>
No accounts, no telemetry, no cloud sync unless you opt in.</p>

<p align="center">
  <img src="public/icons/logo-transparent.png" alt="NutriTrace" width="180" />
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <a href="https://github.com/traceapps/nutritrace/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/traceapps/nutritrace?label=release&color=blue"></a>
  <a href="https://github.com/traceapps/nutritrace/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/traceapps/nutritrace/total?label=downloads&color=blue"></a>
  <a href="https://traceapps.github.io/docs/nutritrace/"><img alt="Documentation" src="https://img.shields.io/badge/docs-traceapps.github.io-4A90E2?logo=readthedocs&logoColor=white"></a>
  <a href="https://github.com/traceapps/nutritrace/pkgs/container/nutritrace"><img alt="Docker image" src="https://img.shields.io/badge/docker-ghcr.io%2Ftraceapps%2Fnutritrace-2496ED?logo=docker&logoColor=white"></a>
  <a href="https://github.com/traceapps/nutritrace/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/traceapps/nutritrace?style=flat"></a>
</p>

**Jump to:** [What it is](#what-nutritrace-is) · [Features](#features) · [Install](#install) · [Env vars](#env-vars) · [Docs](https://traceapps.github.io/docs/nutritrace/)

---

## What NutriTrace is

NutriTrace runs as a single Docker container on your own hardware, with a PWA for the browser and a native Android app for your phone. No accounts on external services, no data leaving your network, no subscriptions.

## Principles

- **Self-hosting is and will remain free.** The server, PWA, and source code will never be paywalled.
- **No trackers, no analytics, no telemetry.** NutriTrace doesn't phone home; your usage is invisible to anyone but you.
- **Your data stays on your hardware.** No central server, no cloud sync that can read it; nothing leaves your network unless you opt into a third-party integration (OFF, USDA, Fitbit, etc.).
- **Open source under AGPL-3.0.** Every line that touches your data is readable.

![NutriTrace diary view: a full day of food logging with macro bar, per-meal breakdowns, and water tracking](docs/screenshots/01-diary.png)

## Features

- **Diary + meal logging.** Configurable meal slots, per-meal ⋮ menu, Split Recipe, IF tracker widget. [Full guide](https://traceapps.github.io/docs/nutritrace/diary/).
- **Foods, meals, recipes.** Personal database, source filter chips, OFF + USDA quality signals (v1.0.3), Scan Label AI OCR. [Full guide](https://traceapps.github.io/docs/nutritrace/foods/).
- **Goals + Adaptive TDEE.** Fixed/Dynamic/Adaptive modes, 7,700 kcal/kg regression math. [Full guide](https://traceapps.github.io/docs/nutritrace/goals/).
- **Wellness integrations (4).** Fitbit (via Google Health), Withings, Garmin, Health Connect, plus Trace-computed Sleep/Readiness/Resilience scores. [Full guide](https://traceapps.github.io/docs/nutritrace/wellness/).
- **Activity + Intermittent Fasting.** Manual workouts + IF widget with presets and streaks. [Full guide](https://traceapps.github.io/docs/nutritrace/activity-if/).
- **Open Food Facts.** Cloud + local Parquet mirror for air-gap. [Full guide](https://traceapps.github.io/docs/nutritrace/off/).
- **USDA + Mealie.** Free API key USDA lookups + Mealie recipe import. [Full guide](https://traceapps.github.io/docs/nutritrace/usda-mealie/).
- **Trace AI.** Reads your diary, meals, wellness, fasting streaks, and Adaptive TDEE state; can log a food, propose one from a photo (you confirm), or add an activity entry, all conversationally. 16 tools total. Smart Log voice/text, propose_food photo flow. [Full guide](https://traceapps.github.io/docs/nutritrace/trace/).
- **Federation API.** `/api/v1/*` scoped Bearer tokens for CT + LT + external clients. [Full guide](https://traceapps.github.io/docs/nutritrace/federation-api/).
- **Migrations.** MyFitnessPal (with nomad64 scraper), Lose It, Cronometer, Waistline. [Full guide](https://traceapps.github.io/docs/nutritrace/migrate-mfp/).
- **Multi-user + OIDC SSO.** Authentik/Keycloak/Pocket ID/Authelia/Google/Auth0. [Full guide](https://traceapps.github.io/docs/auth/oidc/).
- **Native Android app.** Offline mode or server-sync, WorkManager native reminders. [Full guide](https://traceapps.github.io/docs/mobile/install/).

## Apps

- **Web (PWA).** Runs in any modern browser; add to home screen for full-screen use.
- **Android.** Native Capacitor build; works standalone or connected to your NutriTrace server. Signed APK on the [Releases page](https://github.com/traceapps/nutritrace/releases/latest).
- **iOS.** Not currently available (requires Mac + Apple Developer account; see [Support](#support)).

## Install

Minimum viable `docker-compose.yml`:

```yaml
services:
  nutritrace:
    image: ghcr.io/traceapps/nutritrace:latest
    container_name: nutritrace
    ports:
      - "3000:3001"
    volumes:
      - ./data/db:/data/db
      - ./data/uploads:/data/uploads
    environment:
      - DB_PATH=/data/db/nutritrace.db
      - UPLOADS_PATH=/data/uploads
      - JWT_SECRET=change-me-to-a-long-random-string
      # OIDC_ISSUER=https://auth.example.com  # optional single-provider SSO
    restart: unless-stopped
```

Generate a JWT secret:

```bash
openssl rand -base64 48
```

Start it:

```bash
docker compose up -d
```

Open `http://localhost:3000` and the first-run wizard will walk you through user management and creating your admin account. Skipping user management runs the app in single-user mode.

Full compose recipes with SMTP, Docker secrets (`*_FILE`), reverse-proxy examples, and multi-provider OIDC at [docs/getting-started/compose/](https://traceapps.github.io/docs/getting-started/compose/). Tag policy (`:latest`, `:1`, `:1.0`, `:1.0.0`, `:dev`, legacy `:1.0.0-rc.N`) in [DEPLOY.md](DEPLOY.md).

Pre-release testers can grab the rolling `dev-latest` APK; occasional milestone builds also get numbered `-dev.N` pre-releases. See [DEPLOY.md](DEPLOY.md) for details.

## Env vars

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | If using users |  | Signing key for auth tokens. Long random string. |
| `DB_PATH` | Yes | `/data/db/nutritrace.db` | SQLite database file inside the container. |
| `UPLOADS_PATH` | Yes | `/data/uploads` | Upload directory inside the container. |
| `PORT` | No | `3001` | Container-side port the server listens on. |
| `BASE_URL` | No |  | Subpath prefix when mounted behind a reverse proxy (e.g. `/nt`). |
| `LOG_LEVEL` | No | `info` | `error` \| `warn` \| `info` \| `debug` \| `trace`. |
| `TRACE_BODY_MAX_BYTES` | No | `32768` | Maximum serialized request-body bytes logged at `trace` level. |
| `INSECURE_COOKIES` | If on plain HTTP | unset | `1` drops the `Secure` cookie flag; needed only on plain-HTTP LAN. See [docs/getting-started/lan-http/](https://traceapps.github.io/docs/getting-started/lan-http/). |
| `MAX_SESSION_HOURS` | No | `720` | Auth cookie lifetime. |
| `RECOVERY_TOKEN` | No |  | Passphrase to disable user management from the login page (lockout recovery). |
| `OFF_LOCAL_DB` | No |  | Path to an Open Food Facts Parquet snapshot (or legacy DuckDB file) for an air-gap mirror. |
| `USDA_API_KEY` | No |  | Optional server-side USDA FoodData Central key (users can also enter their own in Settings). |
| `MEALIE_URL` | No |  | Base URL of a Mealie instance for recipe import. |
| `MEALIE_API_KEY` | No |  | Mealie API key. |
| `AI_PROVIDER` | No |  | Lock Trace to a provider: `claude` \| `openai` \| `gemini` \| `oai-compat`. |
| `OIDC_ISSUER` | No |  | Enable a single OIDC provider by setting `OIDC_ISSUER` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET`. Numbered form (`OIDC_PROVIDER_2_*`) for multi-provider. |
| `SMTP_HOST` | No |  | SMTP server for password reset & invites; also `SMTP_PORT` (587), `SMTP_SECURE` (false), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. |

Full list (Docker secrets `*_FILE` variants, air-gap `OFF_LOCAL_ONLY`, per-provider AI knobs, all `OIDC_*` options) at [docs/self-hosting/env-vars/](https://traceapps.github.io/docs/self-hosting/env-vars/). SMTP and AI can also be set in the Settings UI; env vars take priority and lock those fields.

### Request logging

Request logs include the method, path, response status, duration, and the observed body size for `POST`, `PUT`, and `PATCH` requests. Oversized JSON requests return HTTP 413 with `size_bytes` and `limit_bytes` fields to make the configured limit visible.

Set `LOG_LEVEL=trace` to also log parsed JSON request bodies. Credential-like fields are redacted, inline `data:` URLs are replaced with their byte size, query strings are omitted, and bodies are truncated to `TRACE_BODY_MAX_BYTES`. Request bodies can still contain private application data such as diary notes, so use trace logging only while diagnosing a problem.

### Image storage maintenance

On normal container startup, NutriTrace moves legacy inline food, meal, recipe, and diary images from SQLite into `UPLOADS_PATH`. It runs `VACUUM` before accepting requests only when that maintenance run actually localized database rows; an already-clean database is not exclusively locked and rewritten on every restart. The run has info-level start/finish summaries; set `LOG_LEVEL=debug` to also log each affected row, item ID, image size, and resulting upload path.

Food and meal saves, sync pushes, imports, copies, and full-backup restores all localize inline images before writing SQLite. If an inline image cannot be decoded, validated, or written, the operation fails instead of storing the data URL in the database.

Soft-deleted foods and meals retain their image references, and maintenance localizes those images as well. Maintenance does not delete upload files; image garbage collection should only remove files after accounting for active records, tombstones, and diary/recipe snapshot references.

The bundled Compose file also provides an optional daily maintenance sidecar. It waits 24 hours with up to one hour of random jitter between runs, uses a shared database lease so it cannot overlap the startup process, and only vacuums after localizing rows:

```bash
docker compose --profile image-maintenance up -d
```

The sidecar mounts the same database and uploads directories as the main service. Keep both mounts identical if adapting the example.

## Data persistence

Two host directories bind-mount:

- **Database** (`DB_PATH`). SQLite file.
- **Uploads** (`UPLOADS_PATH`). Food/meal photos and server-side backups (`uploads/backups/`).

Nothing else needs to persist; the container is stateless beyond these two volumes.

## Updating

```bash
docker compose pull
docker compose up -d
```

The database schema migrates automatically on startup.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Svelte 5 (compat mode), svelte-spa-router, Vite 6, PWA (service worker) |
| Mobile | Capacitor 8 (Android), `@capacitor-community/sqlite`, ML Kit barcode, Health Connect |
| Backend | Node.js, Express 5, better-sqlite3, optional DuckDB for the local OFF mirror |
| Auth | JWT (httpOnly cookie), bcryptjs, OpenID Connect 1.0 (PKCE + state + nonce) |

## Trace family

Part of the **TraceApps** family. Sister apps: [CookTrace](https://github.com/traceapps/cooktrace) for recipes and pantry, [LiftTrace](https://github.com/traceapps/lifttrace) for weightlifting. Full docs for all three at [traceapps.github.io/docs](https://traceapps.github.io/docs/).

## Roadmap, changelog, contributing, license

- See [ROADMAP.md](ROADMAP.md) for what's next.
- [CHANGELOG.md](CHANGELOG.md) tracks per-release changes.
- Contributions welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for translations (single JSON file per locale), coding conventions, and the volunteer thread.
- Licensed under [AGPL-3.0](LICENSE), entire codebase including the Android app source.

## Support

NutriTrace is free to self-host and always will be. It's built and maintained by one person; donations help cover real costs like an Apple Developer account and Mac/iPhone hardware to enable an iOS port, plus ongoing infrastructure. Starring the repo helps with discoverability and costs nothing.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy_me_a_coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/traceapps)

## Credits

NutriTrace was inspired by two self-hosted nutrition trackers:

- **[Waistline](https://github.com/davidhealey/waistline)** by David Healey. A privacy-focused Android nutrition diary that proved a great open-source nutrition tracker is possible.
- **[SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness)** by CodeWithCJ. A self-hosted fitness and nutrition tracker that influenced the wellness integrations and goal-tracking approach.

## Disclaimer

NutriTrace is not medical, health, or nutrition-professional software. It does not provide medical advice, diagnosis, treatment, or personalized nutrition prescriptions. Food entries, calorie and macro tracking, Trace AI suggestions, Smart Log parsing, Scan Label output, Goal Insights, Adaptive TDEE recommendations, wellness scores, and any analytical output are for informational and self-tracking purposes only.

Nutrition decisions can interact with medical conditions (diabetes, eating disorders, food allergies, pregnancy, breastfeeding, pediatric needs, kidney or liver disease, metabolic disorders) in ways this app cannot assess. Consult a qualified healthcare professional, registered dietitian, or licensed nutritionist before starting a new eating plan, calorie target, or making significant dietary changes.

Trace AI answers can be incorrect or incomplete; treat them as a starting point, not a substitute for human judgment or professional advice. Food nutrition data from Open Food Facts is community-curated and may contain inaccuracies. **Use at your own risk.**
