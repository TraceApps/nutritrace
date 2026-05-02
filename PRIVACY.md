# Privacy Policy — NutriTrace

**Last updated:** April 26, 2026

## Overview

NutriTrace is a self-hosted nutrition and wellness tracker. Your data is stored on **your own server** — not on our servers, not in the cloud, and not shared with third parties.

## Data Collection

### What NutriTrace stores on YOUR server:
- Food diary entries, meals, recipes (including free-text notes on foods, meals, and per-day diary notes)
- Nutrition goals and body stats
- Water intake logs
- Wellness data from connected devices (Fitbit, Garmin, Withings, Health Connect)
- Workout activity logs and GPS route data
- AI chat history (if Trace is enabled)
- User account information (username, email, avatar)
- App settings and preferences

### What NutriTrace does NOT collect:
- We do not operate any central server that receives your data
- We do not collect analytics, telemetry, or usage statistics
- We do not serve advertisements
- We do not sell, share, or transmit your data to third parties
- We do not use tracking cookies or fingerprinting

## Third-Party Services

NutriTrace connects to the following external services **only when you explicitly enable them**:

- **Open Food Facts** — Food product lookups by barcode or name. Subject to [OFF privacy policy](https://world.openfoodfacts.org/privacy).
- **USDA FoodData Central** — Food nutrition lookups. Subject to [USDA privacy policy](https://www.usda.gov/privacy-policy).
- **Fitbit (Google)** — Wellness data sync via OAuth. Subject to [Fitbit privacy policy](https://www.fitbit.com/legal/privacy-policy).
- **Withings** — Body composition data via OAuth. Subject to [Withings privacy policy](https://www.withings.com/privacy).
- **Garmin** — Activity data via OAuth. Subject to [Garmin privacy policy](https://www.garmin.com/privacy).
- **Health Connect (Android)** — On-device health data. Data stays on your device.
- **AI Providers (Claude/OpenAI/Gemini)** — If the AI Assistant (Trace) is enabled, your conversation and relevant health context is sent to the AI provider you choose. Subject to their respective privacy policies. Your API key is stored on your server, not ours.
- **Push notification services (Gotify/ntfy/Apprise)** — If configured, notification content is sent to your self-hosted push server.

## Data Retention

Your data is retained on your server until you delete it. You can:
- Delete individual diary entries, foods, meals, or recipes at any time
- Export all your data via JSON export or full backup (ZIP)
- Delete your account and all associated data
- Wipe the database entirely

## Android App

The NutriTrace Android app stores data locally on your device in a SQLite database within the app's private data directory. When connected to a server, data syncs bidirectionally. The app requests the following permissions:
- **Camera** — Food photos, barcode scanning, Trace image attachments
- **Internet** — Server sync, food database lookups, AI chat
- **Notifications** — Meal reminders, hydration reminders, goal celebrations
- **Health Connect** — Read steps, sleep, heart rate, weight, exercise (optional)

### Local data at rest

NutriTrace does not add its own SQLite-level encryption (e.g. SQLCipher) on top of the database. Instead, it relies on Android's built-in file-based encryption (FBE), which has been the default on every Android device since Android 7 (2016). FBE encrypts the app's private data directory using a key derived from your device PIN, password, or biometric — meaning a locked phone is already encrypted at rest, and the contents of the database are inaccessible to anyone without your unlock credential. This matches the approach used by other self-hosted lifestyle apps (Immich, Joplin, Obsidian, AnkiDroid).

This means: an attacker with physical access to your *locked* device cannot read your data. An attacker with physical access to your *unlocked* device can read it — but they could also simply open the app. If your threat model includes nation-state-level adversaries with extended access to your unlocked device, no nutrition tracker (and few apps in any category) will protect you, and you should be using a hardened device profile separate from this app.

The local database is the same database used by all your data: diary entries, foods, meals, settings, wellness data, AI chat history. Full backups (ZIP exports) are also unencrypted by default — keep them in trusted storage if you back up off-device.

## Children's Privacy

NutriTrace is not directed at children under 13. We do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be noted in the changelog.

## Contact

For privacy questions, open an issue at [github.com/traceapps/nutritrace](https://github.com/traceapps/nutritrace).
