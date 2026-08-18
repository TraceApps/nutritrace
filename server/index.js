import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import proxyRoutes  from './routes/proxy.js';
import authRoutes   from './routes/auth.js';
import dataRoutes   from './routes/data.js';
import foodsRoutes  from './routes/foods.js';
import mealsRoutes  from './routes/meals.js';
import diaryRoutes  from './routes/diary.js';
import activityRoutes from './routes/activity.js';
import exercisesRoutes from './routes/exercises.js';
import uploadRoutes from './routes/upload.js';
import mealieRoutes    from './routes/mealie.js';
import settingsRoutes  from './routes/settings.js';
import appConfigRoutes  from './routes/app-config.js';
import aiRoutes         from './routes/ai.js';
import fullBackupRoutes from './routes/full-backup.js';
import fitbitRoutes       from './routes/fitbit.js';
import googleHealthRoutes from './routes/google-health.js';
import withingsRoutes     from './routes/withings.js';
import garminRoutes       from './routes/garmin.js';
import syncRoutes       from './routes/sync.js';
import oidcRoutes       from './routes/oidc.js';
import oidcAdminRoutes  from './routes/oidc-admin.js';
import apiTokensRoutes  from './routes/api-tokens.js';
import apiV1Routes      from './routes/api/v1/index.js';
import nutritionImportRoutes from './routes/nutrition-import.js';
import offLocalRoutes from './routes/off-local.js';
import updatesRoutes  from './routes/updates.js';
import { logger }   from './logger.js';
import { authenticate, userMgmtActive } from './middleware/auth.js';
import { csrfProtect } from './middleware/csrf.js';
import { makeRateLimiter } from './middleware/rate-limit.js';
import { seedSmtpFromEnv } from './email.js';
import { seedAiFromEnv } from './ai.js';
import { seedOidcFromEnv } from './lib/oidc-env.js';

// Initialise DB (runs schema)
import db from './db.js';

// Seed config from env vars if provided (env vars take priority over UI)
seedSmtpFromEnv();
seedAiFromEnv();
seedOidcFromEnv();

const app  = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Reverse-proxy / subpath support ───────────────────────────────────────
// BASE_URL lets users mount NutriTrace at a path other than root, e.g. for
// `https://example.com/nutritrace/` set BASE_URL=/nutritrace. Empty string
// (default) keeps current root-mounted behavior — no migration needed for
// existing installs.
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
if (BASE_URL && !BASE_URL.startsWith('/')) {
  console.error(`[server] BASE_URL must start with '/' — got: ${BASE_URL}`);
  process.exit(1);
}
// Everything route-related goes on this router; mounted at BASE_URL or '/'.
// Using a sub-router keeps `req.path` in middleware (e.g. csrf.js skip lists)
// relative to the mount point so existing path checks keep working.
const router = express.Router();

// Per-route JSON limits for endpoints that legitimately handle large payloads
// (full data export/import, full-history sync push). Registered BEFORE the
// global parser so they win — by the time the global parser runs, req.body
// is already populated and it short-circuits.
router.use('/api/data/import', express.json({ limit: '25mb' }));
router.use('/api/sync/push',   express.json({ limit: '25mb' }));
// Trace AI chat carries base64'd meal photos (phone camera shots inflate to
// ~3-7 MB after base64), so its body needs more headroom than the global cap.
router.use('/api/ai/chat',     express.json({ limit: '12mb' }));
// Diary is an accumulating store — every PUT replays the full day's items,
// each carrying the source food's nutrition object (~2 KB with full vitamins)
// plus name / brand / barcode / category / now also nutrition_basis +
// alt_units + density_g_ml (issues #69 + #70). 50+ items in a day on a
// heavy logger or someone with photo URLs easily clears 1 MB. Bumped to
// 5 MB after a user hit PayloadTooLargeError on 2026-06-10.
router.use('/api/diary',       express.json({ limit: '5mb' }));
// Global cap: 1 MB. Prevents a single authed user from filling memory with
// repeated large requests. Anything above belongs on a per-route opt-in.
router.use(express.json({ limit: '1mb' }));
router.use(cookieParser());

// CORS — allow cross-origin requests from the Android app and same-origin.
// Capacitor WebView origins we accept:
//   https://localhost                — legacy default before the hostname flip
//   http://localhost                 — legacy http scheme
//   https://app.nutritrace.local     — current app identity (see
//                                      capacitor.config.ts for why)
// Same-host origins are always allowed (PWA served from this instance).
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    const isCapacitor = origin === 'https://localhost'
      || origin === 'http://localhost'
      || origin === 'https://app.nutritrace.local';
    const isSameHost = host && origin.includes(host);
    if (isCapacitor || isSameHost) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
  }
  next();
});

// Serve uploaded images BEFORE auth — images are public (needed for Android WebView
// which can't send Authorization headers on <img src> requests)
const uploadsPath = process.env.UPLOADS_PATH || './uploads';
router.use('/uploads', express.static(uploadsPath, {
  setHeaders(res) { res.set('Cache-Control', 'public, max-age=3600'); }
}));

// Proxy also before auth — used by Android WebView to load external images
// (DuckDuckGo, Walmart, etc. block direct WebView requests)
router.use('/api/proxy', proxyRoutes);

router.use(authenticate);   // attach req.user on every request
router.use(csrfProtect);   // CSRF protection for cookie-based sessions

// ── Request logging ────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms   = Date.now() - start;
    const lvl  = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[lvl](`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Prevent browser/proxy caching of all API responses
router.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Setup enforcement — block data APIs until the first user account is created.
// Only /api/auth/* is allowed so the client can check status + register the admin.
// In intentional single-user mode (admin explicitly disabled user management
// via DELETE /api/auth/management or POST /api/auth/recover), there are no
// users by design and data APIs should be open. The single_user_mode flag in
// app_config distinguishes this from a true fresh install. Issue #34
// part 2 — rc.30's fix only addressed the wizard redirect; this gate was
// still returning 503 on every data call.
router.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next(); // allow auth routes (status, register, login)
  if (userMgmtActive()) return next();             // users exist — normal operation
  const singleUser = db.prepare(`SELECT value FROM app_config WHERE key = 'single_user_mode'`).get()?.value === '1';
  if (singleUser) return next();                   // intentional single-user mode — let data APIs through
  res.status(503).json({ error: 'Setup required', setup_required: true });
});

// API routes
// OIDC public routes mount BEFORE authRoutes so /api/auth/oidc/* never falls
// into authRoutes' 404 path. Both are exempt from the setup-required gate
// above (it allows anything under /auth) so OIDC can bootstrap a fresh
// install.
router.use('/api/auth/oidc', oidcRoutes);
router.use('/api/auth',   authRoutes);
// OIDC admin (provider CRUD) — gated by requireAuth + requireAdmin inside
// the router; setup-required gate blocks it until a user exists, which is
// the right ordering (no admin UI before the first user).
router.use('/api/admin/oidc', oidcAdminRoutes);
// Federation API token management (the Settings UI, not the federation
// clients themselves). Admin-only.
router.use('/api/admin/api-tokens', apiTokensRoutes);
// Federation API itself — Bearer-token auth, scope-gated. Mounted at
// /api/v1 so the version is part of the contract URL. See
// docs/federation.md for the wire format.
router.use('/api/v1', apiV1Routes);
// proxy already registered before auth (line 64)
router.use('/api/data',   dataRoutes);
router.use('/api/foods',  foodsRoutes);
router.use('/api/meals',  mealsRoutes);
router.use('/api/diary',  diaryRoutes);
router.use('/api/activity', activityRoutes);
router.use('/api/fasts',    fastsRoutes);
router.use('/api/exercises', exercisesRoutes);
router.use('/api/nutrition-import', nutritionImportRoutes);
router.use('/api/upload', uploadRoutes);
router.use('/api/mealie',     mealieRoutes);
router.use('/api/settings',  settingsRoutes);
router.use('/api/app-config',  appConfigRoutes);
router.use('/api/off-local',   offLocalRoutes);
router.use('/api/updates',     updatesRoutes);
router.use('/api/ai',          aiRoutes);
router.use('/api/full-backup',        fullBackupRoutes);
// Per-IP rate limit on OAuth callbacks — these run unauthenticated and trigger
// expensive token-exchange round-trips with the OAuth provider.
const oauthCallbackLimit = makeRateLimiter({ max: 10, windowMs: 60_000, label: 'oauth-callback' });
router.use([
  '/api/wellness/fitbit/callback',
  '/api/wellness/google-health/callback',
  '/api/wellness/withings/callback',
  '/api/wellness/garmin/callback',
], oauthCallbackLimit);
router.use('/api/wellness/fitbit',        fitbitRoutes);
router.use('/api/wellness/google-health', googleHealthRoutes);
router.use('/api/wellness/withings',      withingsRoutes);
router.use('/api/wellness/garmin',        garminRoutes);

// Cross-source latest wellness metric lookup. Returns the most recent
// row for a given metric_type across all sources (Fitbit / Withings /
// Garmin / Health Connect / etc.), which is what the Activity sheet's
// MET auto-estimate needs to grab the freshest weight_kg regardless of
// which scale wrote it (#99). Returns { date, value, source } or null.
router.get('/api/wellness/latest', (req, res) => {
  const userId = req.user?.id;
  const metric = String(req.query.metric || '').trim();
  if (!metric) return res.status(400).json({ error: 'metric query param required' });
  const row = userId
    ? db.prepare(
        `SELECT date, value, source FROM wellness_data
         WHERE user_id = ? AND metric_type = ? AND value > 0
         ORDER BY date DESC LIMIT 1`
      ).get(userId, metric)
    : db.prepare(
        `SELECT date, value, source FROM wellness_data
         WHERE user_id IS NULL AND metric_type = ? AND value > 0
         ORDER BY date DESC LIMIT 1`
      ).get(metric);
  res.json(row || null);
});

// Cross-source calories_out lookup — for Dynamic Calorie Goal
// Returns yesterday's merged TDEE from fitbit/garmin/health_connect/lifttrace
router.get('/api/wellness/calories-out', (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { date } = req.query;
  // date param = the diary date; we want the day before
  const base = date ? new Date(date + 'T12:00:00Z') : new Date();
  base.setUTCDate(base.getUTCDate() - 1);
  const yesterday = base.toISOString().slice(0, 10);
  // Wearables provide true daily TDEE (BMR + activity). LiftTrace is a
  // per-workout slice that only covers the workout's incremental burn,
  // so it's the LOWEST priority — it fills in when no wearable has data
  // for the date. The lifttraceOverlapFill setting (default ON) lets
  // users flip that: when OFF, LT wins over wearables (use this if your
  // wearable misses lifting sessions and you trust LT's estimate more).
  const overlapFill = _readBoolSetting(userId, 'lifttraceOverlapFill', true);
  const PRIORITY = overlapFill
    ? ['garmin', 'health_connect', 'fitbit', 'lifttrace']
    : ['lifttrace', 'garmin', 'health_connect', 'fitbit'];
  const rows = db.prepare(
    `SELECT source, value FROM wellness_data
     WHERE user_id=? AND date=? AND metric_type='calories_out'`
  ).all(userId, yesterday);
  let result = null;
  for (const src of PRIORITY) {
    const row = rows.find(r => r.source === src);
    if (row) { result = { calories_out: row.value, source: src, date: yesterday }; break; }
  }
  res.json(result || { calories_out: null, source: null, date: yesterday });
});

function _readBoolSetting(userId, key, defaultValue) {
  const row = db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ?`).get(userId, key);
  if (!row || row.value == null) return defaultValue;
  try {
    const v = JSON.parse(row.value);
    return typeof v === 'boolean' ? v : defaultValue;
  } catch { return defaultValue; }
}
router.use('/api/sync',             syncRoutes);

// Adaptive TDEE — compute on demand from 35-day intake + weight trend.
router.get('/api/goals/adaptive-tdee', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { computeAdaptiveTdee } = await import('./lib/adaptive-tdee.js');
    const result = computeAdaptiveTdee(userId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve Svelte frontend (production build) — anything except index.html.
// Content-hashed assets (in /assets/) are safe to cache forever — new deploy =
// new filename. The index.html itself goes through the SPA fallback below so
// it can be templated with __NT_CONFIG__.
router.use(express.static(path.join(__dirname, 'dist'), {
  index: false,                  // skip index.html — handled by templated fallback
  setHeaders(res, filePath) {
    if (filePath.includes('/assets/')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// Read the built index.html once at startup and inject __NT_CONFIG__ so the
// client knows its base path at runtime. Empty BASE_URL → empty basePath →
// behaviorally identical to a deploy without this feature.
const _indexHtmlPath = path.join(__dirname, 'dist', 'index.html');
let _indexHtmlTemplated = '';
try {
  const raw = fs.readFileSync(_indexHtmlPath, 'utf8');
  _indexHtmlTemplated = raw.replace(
    '</head>',
    `<script>window.__NT_CONFIG__ = { basePath: ${JSON.stringify(BASE_URL)} };</script></head>`
  );
} catch (e) {
  logger.warn(`[server] could not pre-template dist/index.html: ${e.message}`);
}

// SPA fallback — serves the templated index.html for any route under BASE_URL.
// Express 5 / path-to-regexp v8 requires named wildcards: '*' alone is rejected,
// '/{*splat}' is the catch-all form.
router.get('/{*splat}', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  if (_indexHtmlTemplated) {
    res.set('Content-Type', 'text/html').send(_indexHtmlTemplated);
  } else {
    res.sendFile(_indexHtmlPath);
  }
});

// Mount the router at BASE_URL (or root if unset).
app.use(BASE_URL || '/', router);

// ── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  logger.error(`${req.method} ${req.path} — ${err.stack || err.message}`);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Process-level safety nets ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.stack || err.message);
  process.exit(1);
});

app.listen(PORT, () => {
  logger.info(`NutriTrace running on port ${PORT}`);

  // Start the notification + sync scheduler
  import('./lib/scheduler.js').then(({ startScheduler }) => startScheduler()).catch(e => {
    logger.warn(`[scheduler] failed to start: ${e.message}`);
  });

  // Local OFF mirror: kick initial download if file is missing, then start
  // the periodic refresh tick. Both no-op when OFF_LOCAL_DB is unset.
  import('./lib/off-local.js').then(({ primeFromStartup }) => primeFromStartup()).catch(e => {
    logger.warn(`[off-local] prime failed: ${e.message}`);
  });
  import('./lib/off-local-scheduler.js').then(({ startOffLocalScheduler }) => startOffLocalScheduler()).catch(e => {
    logger.warn(`[off-local-scheduler] failed to start: ${e.message}`);
  });

  // (Boot-time image migration removed deliberately. Earlier versions ran a
  // localizeImage pass over every food/meal row with an http(s) img_url on
  // every server start, but isExternalUrl() matched the server's OWN host
  // too, so the loop kept re-downloading the same files from itself,
  // assigning fresh filenames and orphaning every diary snapshot that still
  // pointed at the previous name. The proper fix is upstream: strip full
  // server URLs back to relative /uploads/ paths at write time in
  // _stripResolvedImgUrl + _stripCachedPaths so they never enter the
  // foods/meals table in the first place. Don't reintroduce this loop.)
});
