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
| `TOKEN_ENC_KEY` | No | derived from `JWT_SECRET` | At-rest encryption key (AES-GCM, HKDF) for OIDC client secrets and wearable OAuth tokens. By default we derive a key from `JWT_SECRET`, which means rotating `JWT_SECRET` invalidates every stored secret too. Set `TOKEN_ENC_KEY` explicitly if you want to rotate session tokens without forcing users to re-authorize their wearables and re-enter OIDC client secrets. Use a long random string (e.g. `openssl rand -base64 48`). |
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

## Local Open Food Facts mirror

Self-hosters on air-gapped networks, in strict-egress environments, or just wanting resilience when the OFF API is down can point NutriTrace at a local OFF DuckDB mirror. Barcode and food-name lookups try the mirror first; on a miss they fall back to the public OFF API unless you opt into full air-gap mode.

### Setup

1. Uncomment the OFF mirror volume mount in `docker-compose.yml`. **Bind-mount a parent directory, not the file itself** — Docker auto-creates missing single-file bind-mount sources as directories on the host, which then surfaces inside the container as a directory at the mount point and breaks atomic-swap refresh with `EISDIR` (issue #22 followup):
   ```yaml
   - ${OFF_LOCAL_DB_HOST_PATH:-./off-mirror}:/data/off-mirror
   ```
   The mount is read-write so NutriTrace can perform in-place refresh via atomic swap. Earlier docs suggested `:ro`; if you previously set that, change it to writable so scheduled and manual refreshes work.

2. Set the env vars in `.env`:
   ```bash
   OFF_LOCAL_DB_HOST_PATH=/path/on/host/off-mirror        # parent directory on host
   OFF_LOCAL_DB=/data/off-mirror/off.parquet              # in-container path to the file
   # Optional — pin the download URL (defaults to the maintained Hugging Face Parquet dump).
   # OFF_LOCAL_URL=https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet?download=true
   # Optional — full air-gap mode (never call api.openfoodfacts.org)
   # OFF_LOCAL_ONLY=1
   ```

   Note on file formats: since rc.39, NutriTrace defaults to the OFF Parquet dump on Hugging Face (~7-8 GB) because OFF retired their pre-built native DuckDB snapshot. The lookup code transparently opens the Parquet via DuckDB's `read_parquet()` so per-barcode queries are still fast (DuckDB row-group prunes). If you still have a legacy `.duckdb` file at `OFF_LOCAL_DB`, that path is auto-detected by file extension and continues to work unchanged.

3. `docker compose up -d` to recreate the container.

4. **NutriTrace handles the initial download automatically.** On startup, if `OFF_LOCAL_DB` is set and the file is missing, it pulls the full snapshot (~7-8 GB) from `OFF_LOCAL_URL` in the background. Lookups during the initial pull fall through to the public OFF API (or, in air-gap mode, return "not found") until the download completes. Watch the container logs for `[off-local] refresh complete` to confirm readiness, or open Settings → Connected Services → Open Food Facts; the banner shows live download progress.

### Refreshing the mirror

The mirror refreshes itself on a schedule. Open Settings → Connected Services → Open Food Facts (admin only) and pick **Auto-Refresh**: `Off`, `Daily`, `Weekly` (default), or `Monthly`. Refreshes are full re-downloads (OFF does not publish a delta feed), so weekly is a sensible balance for most installs.

You can also click **Refresh Now** in the same panel to force an immediate refresh, regardless of the schedule. Downloads stream to `<path>.new`, validate the DuckDB opens cleanly, then atomically swap into place. A failed mid-flight download never corrupts the running mirror — the previous snapshot keeps serving until the next attempt succeeds.

**No container restart is needed.** The server closes its read-only connection during the swap and reopens against the new file in milliseconds.

Prefer the command line? You can still drop a fresh file in place manually:

```bash
wget 'https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet?download=true' -O /path/on/host/off-mirror/off.parquet.new
mv /path/on/host/off-mirror/off.parquet.new /path/on/host/off-mirror/off.parquet
# Optional — trigger reopen without waiting for the next lookup:
docker compose restart
```

### Fallback behavior

- **`OFF_LOCAL_DB` set, `OFF_LOCAL_ONLY` unset** (default): try local first. The public OFF API is consulted in three cases:
  1. The mirror file is unavailable (initial download in progress, query error, schema mismatch).
  2. The mirror returns a clean "not found" for a barcode lookup. Auto-heals false negatives from a stale mirror without you noticing.
  3. A name search against the mirror returns zero hits.
  Products that ARE in the mirror return instantly from local without a network round-trip.
- **`OFF_LOCAL_DB` set, `OFF_LOCAL_ONLY=1`**: true air-gap mode. The mirror is treated as authoritative; the public OFF API is never contacted for reads. Misses return "product not found". OFF account uploads (contributions) are also refused client-side in this mode, with a clear toast, so an air-gapped admin's users can't accidentally leak data outbound by hitting the upload button.
- **`OFF_LOCAL_DB` unset**: original behavior; always hit the public OFF API.

### Notes for Android users

The native Android client normally calls `api.openfoodfacts.org` directly (bypassing the server proxy) to avoid CORS issues in the WebView. When the server reports that a local OFF mirror is configured (via `/api/app-config/env-locks`), the Android client switches to routing OFF lookups through the server proxy automatically, so the mirror gets used end-to-end. **Server-connected Android: works as expected.** Standalone Android (no server configured) has no proxy to route through, so the mirror doesn't apply — those users keep hitting the public OFF API directly.

### Backups

The mirror file is **deliberately excluded from NutriTrace's full-backup ZIPs**. It's a ~4 GB reproducible snapshot of public OFF data; bundling it would balloon backups for no real benefit. Backups continue to contain only your SQLite database (foods, meals, diary, settings, etc.) and your uploaded photos. Your chosen Auto-Refresh interval is preserved (it's a tiny `app_config` row), so after restoring on a fresh install the schedule comes back automatically; the next refresh cycle (or a manual Refresh Now) re-populates the mirror file itself.

If you want a mirror snapshot in your own off-site storage, copy the `off.parquet` (or legacy `off.duckdb`) host file directly with whatever tool you already use (rsync, restic, borg, etc.) — separate from NutriTrace's backup flow.

### Caveats

- Only the public OFF read endpoints are proxied (barcode lookup `/api/v0/product/<code>.json` and name search `https://search.openfoodfacts.org/search`). Product **contributions** (write-back) go to the public OFF API directly when air-gap mode is off; in air-gap mode (`OFF_LOCAL_ONLY=1`) the upload button is disabled. You cannot contribute to a local mirror file itself; the mirror is read-only and updates only via refresh.
- The mirror's search is a `LIKE` substring match against `product_name` + `brands`, ranked by whether the term appears at the start of the name. It's not a full-text index, so fuzzy and multi-word matching is less generous than the public OFF search. For air-gap use cases this is usually acceptable; for parity with the public search you'd need to build FTS5 indexes after download (out of scope for v1).
- DuckDB's schema isn't versioned; if OFF rotates field names in their dump, lookups may return empty `nutriments` until the local DB layer is updated. Watch the server logs for `[off-local]` warnings.

---

## Cloudflare Tunnel (optional)

If you use Cloudflare Tunnel for external access, no special NutriTrace configuration is needed. Just set your OAuth redirect URIs to the tunnel's public URL (e.g. `https://nutritrace.example.com/api/wellness/fitbit/callback`).

**Free-tier upload limit**: Cloudflare's free plan caps proxied request bodies at **100 MB**. Normal use (auth, sync, food images) is well under this, but a full-backup *restore* upload can exceed it on accounts with many photos. Either run the restore from your local network (bypassing the tunnel), upgrade to a paid plan, or split the backup. Browsing and creating backups is fine — only restore-upload is affected.

---

## Reverse Proxy with Subpath

To run NutriTrace behind a reverse proxy at a subpath (e.g. `https://example.com/nutritrace/`), set the `BASE_URL` environment variable to the path prefix:

```yaml
environment:
  - BASE_URL=/nutritrace
```

The path must start with `/` and must NOT have a trailing slash. Empty (the default) keeps the app at root, identical to the previous behavior — no change for existing deployments.

With `BASE_URL` set, the app's assets, API routes, service worker, and image URLs all live under that prefix. Your reverse proxy should pass requests through *without* stripping the path:

### Caddy

```caddyfile
example.com {
  handle /nutritrace/* {
    reverse_proxy localhost:3000
  }
}
```

(Note: `handle`, not `handle_path`, since we want the prefix preserved.)

### nginx

```nginx
location /nutritrace/ {
  proxy_pass http://localhost:3000/nutritrace/;  # trailing slash on both sides
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Traefik (docker-compose labels)

```yaml
labels:
  - "traefik.http.routers.nutritrace.rule=PathPrefix(`/nutritrace`)"
  # No StripPrefix middleware — pass the full path through.
```

### OAuth callback URLs at a subpath

When you connect Fitbit / Withings / Garmin OAuth, register the callback URL with the dev portal **including the prefix**, for example `https://example.com/nutritrace/api/wellness/fitbit/callback`. Enter the same URL in the in-app Settings → Wellness configuration. The provider redirects back through your reverse proxy to the prefixed path, the app handles it, and the OAuth flow completes.

### Service worker and PWA install

The PWA service worker registers correctly under the subpath. Installing the PWA from a subpath uses the prefixed URL as `start_url`. Both work, but the in-app browser experience is the primary supported case for subpath deployments.

### Native Android app

If you connect the Android app to a server running at a subpath, enter the full URL including the prefix when prompted by the setup wizard (e.g. `https://example.com/nutritrace`). All subsequent API calls preserve the path.

---

## Connecting from Android

The Android app ships with a strict network security policy on **release-signed APKs** (the ones distributed via Play Store / GitHub Releases): only HTTPS traffic is allowed to a user's NutriTrace server, to protect auth tokens on open WiFi. Debug-signed APKs (built locally) are unrestricted and can use plain HTTP.

This only affects **server mode** — local-only Android users never hit this.

Four supported paths for server-mode Android users:

### Path 1 — Real domain + Let's Encrypt (recommended)

Point a real domain at your server (`nutritrace.yourdomain.com`) and terminate TLS with a publicly-trusted cert via Caddy, Traefik, nginx + certbot, etc. The DNS-01 challenge works fine even when your server is on an internal IP — no port forwarding needed. Enter `https://nutritrace.yourdomain.com` in the app and you're done.

### Path 2 — Cloudflare Tunnel / Tailscale Funnel / Tailscale mesh

These hand out publicly-trusted certs automatically, no domain or cert management on your end. Enter the tunnel URL (`https://nutritrace.yourtunnel.example.com`) in the app. See the Cloudflare Tunnel section above for the free-tier upload caveat.

### Path 3 — Self-signed cert + install your CA on Android

If you generate your own root CA and use it to sign certs for `nutritrace.home.arpa` (or whatever internal domain you use), the strict APK won't trust it out of the box — but you can install your CA on the device once and the app will accept any cert your CA signed.

1. Export your CA's certificate as a `.crt` or `.pem` file
2. On your phone: Settings → Security & Privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate
3. Browse to the file and install. Android will warn that anyone with this CA can monitor your traffic — that's expected, you're explicitly trusting your own CA
4. Open NutriTrace and connect to `https://nutritrace.home.arpa`

This survives app updates. You only need to repeat it if you regenerate the CA or factory-reset the device.

### Path 4 — Plain HTTP (build the APK yourself)

If you really don't want HTTPS at all (LAN-only, fully isolated network, willing to accept the risk), the source includes a permissive debug build profile. Clone the repo and run:

```bash
npm run build && cd android && ./gradlew assembleDebug
```

The APK at `android/app/build/outputs/apk/debug/app-debug.apk` allows cleartext (`http://`) connections. Sideload it instead of the release APK.

This is also the fallback if you hit any cert issues with paths 1–3 — the debug build connects to anything.

### What you'll see in the app

If a release-built app tries to connect to an `http://` URL, the connection fails and the in-app error explicitly mentions the HTTPS requirement and points back to this section.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

Data is in bind-mounted volumes and persists across updates.

---

## Docker Secrets

The container supports Docker/Swarm-style `*_FILE` environment variables. For any server environment variable, you can provide a mounted file path instead of the raw value:

- `JWT_SECRET_FILE=/run/secrets/nutritrace_jwt_secret`
- `RECOVERY_TOKEN_FILE=/run/secrets/nutritrace_recovery_token`
- `SMTP_PASS_FILE=/run/secrets/nutritrace_smtp_pass`
- `AI_API_KEY_FILE=/run/secrets/nutritrace_ai_api_key`

Rules:

- Set either `NAME` or `NAME_FILE`, not both.
- If `NAME_FILE` is set, the container reads that file at startup and exports `NAME` before Node starts.
- If the file is missing or unreadable, the container exits immediately with a startup error.

Example Compose snippet:

```yaml
services:
  nutritrace:
    image: ghcr.io/traceapps/nutritrace:latest
    environment:
      DB_PATH: /data/db/nutritrace.db
      UPLOADS_PATH: /data/uploads
      JWT_SECRET_FILE: /run/secrets/nutritrace_jwt_secret
      SMTP_PASS_FILE: /run/secrets/nutritrace_smtp_pass
    secrets:
      - nutritrace_jwt_secret
      - nutritrace_smtp_pass

secrets:
  nutritrace_jwt_secret:
    file: ./secrets/jwt_secret.txt
  nutritrace_smtp_pass:
    file: ./secrets/smtp_pass.txt
```

This works for any environment variable the server reads directly, including `TOKEN_ENC_KEY`, `SMTP_USER`, `AI_API_KEY`, and similar values.

---

## Backup & Restore

Full backups (database + uploaded images) can be created and restored from Settings → Backup & Restore. Backups are ZIP files that include all user data and can be used to migrate between servers.
