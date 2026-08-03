# Privacy Policy: NutriTrace

**Last updated:** August 3, 2026

## Overview

NutriTrace is a self-hosted nutrition and wellness tracker. Your data is stored on **your own server**, not on any central server, not in the cloud, and not shared with third parties.

## Data Collection

### What NutriTrace stores on YOUR server:

- Food diary entries, meals, and recipes (including free-text notes on foods, meals, and per-day diary notes)
- Nutrition goals (Fixed, Dynamic, or Adaptive TDEE) and body stats
- Water intake logs
- Wellness data from connected sources (Fitbit via Google Health, Withings, Garmin, Health Connect)
- Trace-computed wellness scores (Sleep, Readiness, Resilience) derived from the raw wellness data
- Workout activity logs (manual entries or wearable-synced) and GPS route data
- Intermittent Fasting session logs (goal presets, start/end timestamps, streak history)
- Custom Units, custom foods, bulk food/recipe imports
- Food, meal, and recipe sharing grants (per-user share tokens)
- API tokens issued to sibling apps (CookTrace, LiftTrace) via the Federation API, with scoped permissions (`read:foods`, `write:workouts`)
- AI chat history (if Trace is enabled)
- User account information (username, hashed password, optional email, optional display name, optional avatar)
- OIDC SSO links (provider, subject claim)
- App settings and preferences (server-side USER_PREFS; device-only DEVICE_PREFS stay in localStorage / on the device and never leave)

### What NutriTrace does NOT collect:

- We do not operate any central server that receives your data
- We do not collect analytics, telemetry, or usage statistics
- We do not serve advertisements
- We do not sell, share, or transmit your data to third parties
- We do not use tracking cookies or fingerprinting

## Third-Party Services

NutriTrace connects to the following external services **only when you explicitly enable them**:

- **Open Food Facts.** Food product lookups by barcode or name. Subject to [OFF privacy policy](https://world.openfoodfacts.org/privacy). See [LICENSES.md](LICENSES.md) for ODbL attribution notes (including the opt-in local mirror obligations for multi-user operators).
- **USDA FoodData Central.** Food nutrition lookups. Subject to [USDA privacy policy](https://www.usda.gov/privacy-policy).
- **Mealie** (per user). Live queries against the user's own Mealie instance for recipe import. User provides URL + API token.
- **Google Health (Fitbit and Google-Health-native sources).** Wellness data sync via Google Cloud OAuth. This is the current path for Fitbit data (Fitbit's own Web API was retired). Subject to [Google Health privacy policy](https://policies.google.com/privacy). OAuth client id + secret are configured via env vars; tokens are AES-encrypted at rest with the deploy's `JWT_SECRET`.
- **Withings.** Body composition data via OAuth. Subject to [Withings privacy policy](https://www.withings.com/privacy).
- **Garmin.** Activity data via OAuth (experimental). Subject to [Garmin privacy policy](https://www.garmin.com/privacy).
- **Health Connect (Android).** On-device health data (steps, sleep, heart rate, weight, exercise). Data stays on the device and is only read when the user explicitly grants Health Connect permission to the NutriTrace Android app.
- **OIDC providers (Authentik, Keycloak, Pocket-ID, Authelia, Google, Auth0, or any OIDC 1.0 provider).** If admins configure SSO, sign-in is delegated to your chosen identity provider. Client secrets are stored encrypted at rest.
- **AI providers (Claude, OpenAI, Gemini, OpenAI-compatible).** If Trace is enabled, your conversation and relevant diary / wellness / goals context is sent to the provider you choose. Subject to their respective privacy policies. Your API key is stored on your server, not ours. The "OpenAI Compatible" provider (Ollama, LM Studio, LocalAI, vLLM, DeepSeek, Groq, and similar) connects directly from the browser to the endpoint you configure; the NutriTrace server never sees those requests in per-user mode.
- **Push notification services (Apprise, Gotify, ntfy).** Optional. If configured, notification content (meal reminders, water reminders, weigh-in reminders, weekly summary, goal celebration, fasting-complete alert, wellness alerts, backup-failed alert) is sent to your self-hosted push server. Only one provider is active at a time.
- **SMTP (email).** Optional. If configured, password reset emails, user invites, weekly summary emails, and food/meal share-notification emails are sent via your SMTP provider. See the [Email / SMTP docs](https://traceapps.github.io/docs/integrations/smtp/) for details.
- **Sibling TraceApps (CookTrace, LiftTrace).** When you (or your operator) issues a Federation API token, the holding app can read food data (`read:foods`) or post workout entries (`write:workouts`) against your NutriTrace instance. Tokens are scoped, revocable, and never leave your NutriTrace server.

## Data Retention

Your data is retained on your server until you delete it. You can:

- Delete individual diary entries, foods, meals, recipes, wellness data, IF sessions, or shares at any time
- Export all your data via JSON export or full backup (ZIP)
- Delete your account and all associated data
- Wipe the database entirely

## Android App

The NutriTrace Android app stores data locally on your device in a SQLite database within the app's private data directory. When connected to a server, data syncs bidirectionally. The app requests the following permissions:

- **Internet.** Server sync, food database lookups, AI chat, in-app updates
- **Camera.** Food photos, Scan Label (AI OCR of nutrition labels), barcode scanning, Trace image attachments
- **Notifications.** Meal reminders, hydration reminders, weigh-in reminders, goal celebrations, fasting-complete alerts, wellness alerts, backup-failed alerts
- **Schedule / use exact alarm.** Precise reminder delivery via native WorkManager even when the app is backgrounded
- **Receive boot completed.** Re-arm scheduled reminders after device reboot
- **Health Connect.** Optional. Read steps, sleep, heart rate, weight, exercise.
- **External storage (Android 12 and below).** Save exported backups to your Downloads folder
- **Foreground service.** Long-running import operations and wellness sync
- **Install packages.** In-app self-updater hands the downloaded APK to the system installer

### Local data at rest

NutriTrace does not add its own SQLite-level encryption (e.g. SQLCipher) on top of the database. Instead, it relies on Android's built-in file-based encryption (FBE), which has been the default on every Android device since Android 7 (2016). FBE encrypts the app's private data directory using a key derived from your device PIN, password, or biometric, meaning a locked phone is already encrypted at rest, and the contents of the database are inaccessible to anyone without your unlock credential. This matches the approach used by other self-hosted lifestyle apps (Immich, Joplin, Obsidian, AnkiDroid).

An attacker with physical access to your *locked* device cannot read your data. An attacker with physical access to your *unlocked* device can read it, but they could also simply open the app. If your threat model includes nation-state-level adversaries with extended access to your unlocked device, no nutrition tracker (and few apps in any category) will protect you, and you should be using a hardened device profile separate from this app.

The local database is the same database used by all your data: diary entries, foods, meals, settings, wellness data, IF sessions, AI chat history. Full backups (ZIP exports) are also unencrypted by default; keep them in trusted storage if you back up off-device. OAuth tokens for wearables (Fitbit/Google-Health, Withings, Garmin) are AES-encrypted at rest with the deploy's `JWT_SECRET`, so cross-deploy backup restores cannot decrypt them (re-linking each wearable from Settings is a one-tap flow).

## Children's Privacy

NutriTrace is not directed at children under 13. We do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be noted in the changelog.

## Contact

For privacy questions, open an issue at [github.com/traceapps/nutritrace](https://github.com/traceapps/nutritrace/issues).
