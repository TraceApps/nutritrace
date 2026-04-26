# NutriTrace — Deployment Guide

## Quick Start

```bash
# Clone and start
git clone git@github.com:traceapps/nutritrace.git
cd nutritrace
cp .env.example .env          # edit as needed
docker compose up -d
```

The app will be available at `http://localhost:3000`.

---

## docker-compose.yml

A minimal working setup:

```yaml
services:
  nutritrace:
    image: ghcr.io/traceapps/nutritrace:latest
    ports:
      - "3000:3001"
    volumes:
      - ./data/db:/data/db
      - ./data/uploads:/data/uploads
    environment:
      DB_PATH: /data/db/nutritrace.db
      UPLOADS_PATH: /data/uploads
      JWT_SECRET: change-me-to-a-long-random-string
    restart: unless-stopped
```

### With all optional features enabled

```yaml
services:
  nutritrace:
    image: ghcr.io/traceapps/nutritrace:latest
    ports:
      - "3000:3001"
    volumes:
      - ./data/db:/data/db
      - ./data/uploads:/data/uploads
    environment:
      # Required
      DB_PATH: /data/db/nutritrace.db
      UPLOADS_PATH: /data/uploads
      JWT_SECRET: change-me-to-a-long-random-string

      # Optional: SMTP for password reset / invite emails
      SMTP_HOST: smtp.example.com
      SMTP_PORT: 587
      SMTP_SECURE: "false"      # true for port 465
      SMTP_USER: user@example.com
      SMTP_PASS: yourpassword
      SMTP_FROM: '"NutriTrace" <noreply@example.com>'

      # Optional: session duration override (hours; 0 = never expires)
      # SESSION_HOURS: 720

      # Optional: backups directory (default: inside uploads volume)
      # BACKUPS_PATH: /data/backups
    restart: unless-stopped
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_PATH` | Yes | `./nutritrace.db` | Path to SQLite database file |
| `UPLOADS_PATH` | Yes | `./uploads` | Path for uploaded food/meal images |
| `JWT_SECRET` | Yes (prod) | `dev-secret` | Secret for signing JWT auth tokens — **change this**. Server refuses to start in production with the dev default. |
| `PORT` | No | `3001` | Internal Express port (map to host in docker-compose) |
| `LOG_LEVEL` | No | `info` | `error` \| `warn` \| `info` \| `debug`. Use `debug` for verbose wellness sync output (Fitbit, Withings, Garmin, Health Connect). |
| `RECOVERY_TOKEN` | No | — | Lockout-recovery token. Required to use the "Disable user management" recovery option on the login page. Without this, the recovery endpoint is disabled for safety. |
| `MAX_SESSION_HOURS` | No | `8760` (1 year) | Cap on JWT + cookie lifetime. The per-user setting in app_config can be lower than this but cannot exceed it. |
| `INSECURE_COOKIES` | No | `0` | Set `1` only for non-HTTPS deployments. Default uses `secure: true` cookies (HTTPS-only). |
| `BACKUPS_PATH` | No | Inside uploads dir | Where full ZIP backups are stored |
| `SMTP_HOST` | No | — | SMTP server hostname |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_SECURE` | No | `false` | `true` for TLS (port 465), `false` for STARTTLS |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `SMTP_FROM` | No | — | From address, e.g. `"NutriTrace" <noreply@example.com>` |
| `AI_PROVIDER` | No | — | `claude` \| `openai` \| `gemini`. If set, AI calls are proxied server-side and the provider/model/key fields are locked in Settings for all users. |
| `AI_API_KEY` | No | — | API key for the chosen provider. Server-only, never reaches the browser. |
| `AI_MODEL` | No | provider default | Optional model override (e.g. `claude-haiku-4-5-20251001`). |
| `AI_ENABLED` | No | — | If `true`, auto-enables the AI Assistant for all users. |

> **Note:** SMTP and AI settings can also be configured in **Settings → Email** / **Settings → AI Assistant** (admin only). Environment variables take priority over the UI and lock the corresponding fields when set.

---

## First Run

1. **Open the app** — you'll be prompted with a setup wizard on first visit.
2. **Create your account** — the first account created is automatically admin.
3. **Single-user mode** — if you never create a second user account, the app runs without authentication (no login required). Add users in Settings → User Management to enable multi-user mode.

---

## Connecting Fitbit or Withings

Each user connects their own fitness tracker using their own developer API credentials. No admin setup required.

### Fitbit

1. Go to [dev.fitbit.com](https://dev.fitbit.com) and sign in with your Fitbit account.
2. Click **Register an App**.
3. Fill in the form:
   - **Application Type**: Personal
   - **Redirect URL**: `https://your-domain.com/api/wellness/fitbit/callback`
   - Other fields: any values are fine
4. Copy your **Client ID** and **Client Secret**.
5. In NutriTrace → Settings → Wellness → Fitbit, paste the credentials and save.
6. Click **Connect** — you'll be redirected to Fitbit to authorize, then back to the Wellness page.

**Required OAuth scopes** (automatically requested): `activity`, `heartrate`, `sleep`, `oxygen_saturation`, `respiratory_rate`, `cardio_fitness`, `temperature`, `profile`, `location` (the last one is needed for TCX/GPS route data on workout logs)

### Withings

1. Go to [developer.withings.com](https://developer.withings.com) and sign in.
2. Create a new application.
3. Set the **Callback URL** to: `https://your-domain.com/api/wellness/withings/callback`
4. Copy your **Client ID** and **Client Secret**.
5. In NutriTrace → Settings → Wellness → Withings, paste the credentials and save.
6. Click **Connect** to authorize.

**Required scopes**: `user.info`, `user.metrics`, `user.activity`

---

## Cloudflare Tunnel (optional)

If you use Cloudflare Tunnel for external access, no special NutriTrace configuration is needed. Just set your OAuth redirect URIs to the tunnel's public URL (e.g. `https://nutritrace.example.com/api/wellness/fitbit/callback`).

---

## Updating

```bash
docker compose pull
docker compose up -d
```

Data is in bind-mounted volumes and persists across updates.

---

## Backup & Restore

Full backups (database + uploaded images) can be created and restored from Settings → Backup & Restore. Backups are ZIP files that include all user data and can be used to migrate between servers.
