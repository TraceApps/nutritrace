# NutriTrace

**Trace Every Bite** — A self-hosted personal nutrition tracker built for privacy and full data ownership.

NutriTrace runs entirely in a single Docker container on your own hardware. No accounts on external services, no data leaving your network, no subscriptions.

---

## Features

### Diary
- Daily food diary with configurable meals (Breakfast, Lunch, Dinner, Snacks, or fully custom)
- Quick-add foods, meals, and recipes with portion scaling
- Nutrition bar with macro summary and per-meal breakdowns
- Body stats tracking (weight, measurements, and more) with customizable fields
- Water intake tracking with configurable containers and daily goal
- Long-press (mobile) or right-click (desktop) for edit/move/delete actions

### Foods & Meals
- Personal food database with photos, barcodes, categories, and custom labels
- Barcode scanner (camera) for quick food lookup via Open Food Facts
- Meal and recipe builder with drag-to-reorder ingredients
- Proportional nutrition scaling when editing serving size
- Import foods from Open Food Facts, USDA FoodData Central, or Mealie (recipe manager)

### Statistics
- Charts for any tracked nutrient or body stat over time
- Bar and line chart modes; average, trend, and goal overlay lines
- Configurable date ranges

### Goals
- Calorie and nutrient goals with template support
- Wizard calculates TDEE (Mifflin-St Jeor) and water goal from body stats and activity level

### Settings & Customization
- Light / dark / system theme
- Custom accent color (presets or full hex color picker)
- Configurable navigation style (bottom bar, sidebar, or both)
- Custom nutriment visibility and display order
- Custom body stat fields and display order
- Date and time format options (US / ISO / EU / Natural)
- Unit system: weight, height, length, distance

### Multi-User Support
- Optional user management — runs perfectly as a single-user app with no login required
- Admin can invite additional users via email or shareable link
- All data is scoped per user
- Configurable session timeout

### AI Assistant (FitBot)
- Optional AI chat assistant for nutrition questions and logging help
- Supports Claude (Anthropic), OpenAI, and OpenRouter
- Bring your own API key

### Backup & Restore
- Full backup: ZIP archive of all database tables + uploaded images, stored on the server
- Download backups to your device or restore from a previously saved backup
- Upload and restore from a backup file taken on another instance
- Portable JSON export/import (foods, meals, diary, settings — no images)
- Local Full Backup (Android local-only mode): self-contained `.zip` with embedded image files for phone-to-phone transfer without a server
- CSV diary export
- Import from Waistline (Android nutrition app)

---

## Smart Log — voice + AI food logging

Smart Log is an experimental feature that lets you log food by **pressing and holding the FitBot button** on any page and saying what you ate. The AI parses your sentence and matches each item against your saved foods, meals, recipes, or yesterday's diary.

### Setup
1. Settings → AI Assistant → enable **FitBot AI** and configure a provider key (Claude, OpenAI, or Gemini).
2. In the same section, enable the **Smart Log** toggle (Experimental).
3. Grant microphone permission the first time you use it.

### How to use it
- **Press and hold** the FitBot floating button (any page) for ~½ second.
- The robot face morphs to a microphone, the FAB turns red, you'll hear a short beep and feel a haptic buzz.
- **Speak** what you ate.
- **Release** the button to commit. Slide your finger off the FAB before releasing to **cancel**.
- The Smart Log review modal opens with the parsed items already matched. Edit quantities, swap matches, change meal slots, then tap **Add to Diary**.

### What Smart Log can match

| Source | What it matches | Example phrases |
|---|---|---|
| **Foods** (default) | Single foods from your library, then Open Food Facts | "2 eggs", "a slice of toast", "Greek yogurt" |
| **Saved Meals** | Multi-ingredient meals you've built in MealEditor | "my **chicken caesar salad meal**", "the **pasta carbonara meal**", "for lunch I had my **morning bowl meal**" |
| **Saved Recipes** | Recipes you've saved (with `is_recipe: 1`) | "my **chicken stir fry recipe**", "made the **pasta carbonara recipe**", "from my **lasagna recipe**" |
| **Yesterday's diary** | Copy items from yesterday's matching meal slot | "**same as yesterday for lunch**", "**yesterday's breakfast**", "**repeat yesterday's dinner**", "**what I had for breakfast yesterday**" |

The trigger words **"meal"**, **"recipe"**, and **"yesterday"** are how you tell the AI which kind of record to look for. Without those keywords, Smart Log defaults to searching individual foods.

### Meal slot detection
You can mention the meal in your sentence and Smart Log will route the items there automatically:

- *"for breakfast I had..."* → Breakfast
- *"snacking on..."* → first Snacks slot
- *"for my pre-workout..."* → matches a custom slot named Pre-workout
- *"snack 2 was a banana"* → Snack 2 (exact slot match)

Smart Log uses your **actual configured meal slot names** (visible in the AI prompt), so custom slots like "Snack 1 / 2 / 3", "Brunch", or "Late Night" all work. It also handles renamed defaults — if you renamed "Breakfast" to "Morning Bowl", saying "for breakfast" still routes there via fuzzy matching.

### What Smart Log does NOT do (yet)
- It does **not** log water intake — say it via the diary water section instead
- It does **not** log body stats (weight, measurements, etc.)
- It does **not** support multi-day patterns ("yesterday and today" — yesterday only works for the prior calendar day)
- It does **not** modify or delete existing diary entries — only adds new ones
- It does **not** know about diary entries older than yesterday

### Privacy
- **Audio is recognized on-device.** Android uses the system speech recognizer; the PWA uses your browser's Web Speech API. The audio itself never leaves your device.
- **The text transcript** is sent to your configured AI provider (Claude/OpenAI/Gemini) for parsing. This is the only network call to a third-party service.
- **Food matching is local-first.** Your saved foods, meals, recipes, and diary are searched on your own server first. Open Food Facts is only queried as a fallback for foods not in your library.
- **Nothing is sent to NutriTrace servers.** There are no NutriTrace servers — this is self-hosted.

### Cost
Smart Log uses a tightly-constrained prompt (~150 tokens in, ~50 out) so it's cheap. On GPT-4o mini or Claude Haiku, logging six meals a day for a year costs roughly **\$0.10 USD**. Gemini's free tier covers it entirely.

### Tips
- Mention the meal *and* the food in one sentence: "for breakfast I had 2 eggs and toast" → fewer modal corrections.
- Use the words **"meal"** and **"recipe"** explicitly when you want one of those records — otherwise the AI will look for individual foods first.
- The first time Smart Log fires on Android, you'll see a permission prompt for the microphone. Grant it.
- If voice recognition picks up the wrong words, just type into the text input on the modal (after the parser opens) — same matching pipeline runs.

---

## Self-Hosting with Docker

### Quick Start

1. Download the `docker-compose.yml` from this repo, or copy it directly:

```yaml
services:
  nutritrace:
    image: ghcr.io/traceapps/nutritrace:latest
    container_name: nutritrace
    ports:
      - "3000:3001"
    volumes:
      - ${DATA_DB_PATH}:/data/db
      - ${DATA_UPLOADS_PATH}:/data/uploads
    environment:
      - DB_PATH=/data/db/nutritrace.db
      - UPLOADS_PATH=/data/uploads
      - JWT_SECRET=${JWT_SECRET}
      - SMTP_HOST=${SMTP_HOST:-}
      - SMTP_PORT=${SMTP_PORT:-587}
      - SMTP_SECURE=${SMTP_SECURE:-false}
      - SMTP_USER=${SMTP_USER:-}
      - SMTP_PASS=${SMTP_PASS:-}
      - SMTP_FROM=${SMTP_FROM:-}
    restart: unless-stopped
```

No changes to this file are needed — everything is driven by `.env`. If you want to pin to a specific version, change `latest` to a release tag.

2. Copy `.env.example` to `.env` and fill in your paths:

```env
DATA_DB_PATH=/your/host/path/db
DATA_UPLOADS_PATH=/your/host/path/uploads
JWT_SECRET=your-long-random-secret

# Optional — SMTP for password reset emails and user invites
# If omitted, invites fall back to a copyable link instead of email
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=you@example.com
# SMTP_PASS=your-password
# SMTP_FROM=NutriTrace <noreply@example.com>
```

Generate a JWT secret:
```bash
openssl rand -base64 48
```

3. Start the container:

```bash
docker compose up -d
```

4. Open `http://localhost:3000` in your browser.

On first launch, a setup wizard walks you through enabling user management and creating your admin account. If you skip user management, the app runs in single-user mode with no login required.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATA_DB_PATH` | Yes | — | Host path for the SQLite database directory |
| `DATA_UPLOADS_PATH` | Yes | — | Host path for uploaded images and backups |
| `JWT_SECRET` | If using users | — | Secret key for signing auth tokens. Use a long random string. |
| `RECOVERY_TOKEN` | No | — | Passphrase required to disable user management from the login page (lockout recovery). Without this the recovery endpoint is disabled. |
| `LOG_LEVEL` | No | `info` | Log verbosity: `error` \| `warn` \| `info` \| `debug`. Use `debug` for detailed Fitbit/Withings sync output. |
| `SMTP_HOST` | No | — | SMTP server hostname (for password reset & invites) |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_SECURE` | No | `false` | `true` for SSL (port 465), `false` for STARTTLS |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `SMTP_FROM` | No | — | From address, e.g. `NutriTrace <noreply@example.com>` |
| `AI_PROVIDER` | No | — | Lock FitBot to a specific provider for all users: `claude` \| `openai` \| `gemini` |
| `AI_API_KEY` | No | — | Shared AI API key. Key is server-side only — never sent to the browser. |
| `AI_MODEL` | No | provider default | Override the AI model (e.g. `claude-haiku-4-5-20251001`) |
| `AI_ENABLED` | No | — | Set to `true` to auto-enable FitBot for all users |

SMTP and AI settings can also be configured in the Settings UI. Environment variables take priority over UI values and lock those fields for all users.

---

## Data Persistence

Two host directories must be bind-mounted:

- **Database** (`DATA_DB_PATH`) — SQLite file. Survives container restarts and redeployments.
- **Uploads** (`DATA_UPLOADS_PATH`) — Food/meal photos and server-side backups (stored in `uploads/backups/`). Survives container restarts and redeployments.

Nothing else needs to persist — the container is stateless beyond these two volumes.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

The database schema migrates automatically on startup.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Svelte 4, svelte-spa-router, Vite, PWA (service worker) |
| Backend | Node.js, Express, better-sqlite3 |
| Auth | JWT (httpOnly cookie), bcryptjs |
| Container | Docker, multi-stage Dockerfile |
| CI/CD | GitHub Actions → GitHub Container Registry |

---

## Wellness Integrations

NutriTrace can sync data from Fitbit, Withings, and Garmin. Each requires registering a free OAuth application with the respective service and entering the credentials in **Settings → Wellness**.

### Fitbit
1. Go to [dev.fitbit.com](https://dev.fitbit.com) → **Register an App**
2. Application type: **Personal**
3. OAuth 2.0 Application Type: **Personal**
4. Callback URL: `https://your-nutritrace-domain.com/api/wellness/fitbit/callback`
5. Copy the **Client ID** and **Client Secret** into Settings → Wellness → Fitbit

### Withings
1. Go to [developer.withings.com](https://developer.withings.com) → create a developer account → **New Application**
2. Callback URL: `https://your-nutritrace-domain.com/api/wellness/withings/callback`
3. Copy **Client ID** and **Client Secret** into Settings → Wellness → Withings

### Garmin
Garmin Health API requires a partnership approval (not a free developer program). If you have access, set the callback URL to `https://your-nutritrace-domain.com/api/wellness/garmin/callback`.

> **Note:** The callback URLs must use your public domain (not `localhost`). Both Fitbit and Withings require HTTPS.

---

## API Integrations

All external API calls are proxied server-side — no keys are exposed to the browser.

- **[Open Food Facts](https://world.openfoodfacts.org/)** — free barcode/food search (no key required)
- **[USDA FoodData Central](https://fdc.nal.usda.gov/)** — US food database (free API key required)
- **[Mealie](https://mealie.io/)** — self-hosted recipe manager integration

---

## Support

NutriTrace is free to self-host and always will be. If it's been useful to you and you'd like to support continued development:

[![GitHub Sponsors](https://img.shields.io/badge/GitHub_Sponsors-❤-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/traceapps)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy_me_a_coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/thebigjoe1)

Or just star the repo — that helps with discoverability and costs nothing.

## License

[AGPL-3.0](LICENSE) — server and PWA. The Android app is distributed separately as a paid release on the Play Store.
